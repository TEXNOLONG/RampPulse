use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::ops::{Deref, DerefMut};
use std::sync::{Arc, Condvar, Mutex};

use crate::{
    hash_password, hash_session_token, now_rfc3339, random_session_token, verify_password,
    PBKDF2_ITERATIONS, SESSION_TTL_SECONDS,
};

#[derive(Clone)]
pub struct AccountStore(Arc<ConnectionPool>);

struct ConnectionPool {
    idle: Mutex<Vec<Connection>>,
    available: Condvar,
}

struct PooledConnection {
    pool: Arc<ConnectionPool>,
    connection: Option<Connection>,
}

impl Deref for PooledConnection {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        self.connection
            .as_ref()
            .expect("pooled sqlite connection is present")
    }
}

impl DerefMut for PooledConnection {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.connection
            .as_mut()
            .expect("pooled sqlite connection is present")
    }
}

impl Drop for PooledConnection {
    fn drop(&mut self) {
        let Some(connection) = self.connection.take() else {
            return;
        };
        if let Ok(mut idle) = self.pool.idle.lock() {
            idle.push(connection);
            self.pool.available.notify_one();
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct PublicUser {
    pub id: i64,
    pub email: String,
    pub username: String,
    pub bio: String,
    pub avatar_color: String,
    pub name: String,
    pub role: String,
    pub status: String,
    pub qual: Option<String>,
    pub types: Vec<String>,
    pub base: Option<String>,
    pub tech_id: Option<i64>,
    pub on_shift: bool,
    pub created_at: String,
    pub approved_at: Option<String>,
}

pub struct NewEngineer {
    pub email: String,
    pub username: String,
    pub name: String,
    pub password: String,
    pub qual: String,
    pub types: Vec<String>,
    pub base: String,
}

pub enum AuthFailure {
    InvalidCredentials,
    Pending,
    Closed,
    Storage,
}

pub enum ShiftFailure {
    ActiveRequest,
    NotEngineer,
    Storage,
}

impl AccountStore {
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let count = if path == ":memory:" {
            1
        } else {
            std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(2)
                .clamp(2, 6)
        };
        let mut connections = Vec::with_capacity(count);
        for _ in 0..count {
            let connection = Connection::open(path)?;
            connection.pragma_update(None, "foreign_keys", "ON")?;
            connection.busy_timeout(std::time::Duration::from_secs(5))?;
            connection.pragma_update(None, "journal_mode", "WAL")?;
            connections.push(connection);
        }
        let store = Self(Arc::new(ConnectionPool {
            idle: Mutex::new(connections),
            available: Condvar::new(),
        }));
        store.migrate()?;
        Ok(store)
    }

    fn connection(&self) -> rusqlite::Result<PooledConnection> {
        let mut idle = self
            .0
            .idle
            .lock()
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        loop {
            if let Some(connection) = idle.pop() {
                return Ok(PooledConnection {
                    pool: self.0.clone(),
                    connection: Some(connection),
                });
            }
            idle = self
                .0
                .available
                .wait(idle)
                .map_err(|_| rusqlite::Error::InvalidQuery)?;
        }
    }

    fn migrate(&self) -> rusqlite::Result<()> {
        let mut connection = self.connection()?;
        // Releases before the Rust service stored each request as one JSON blob in
        // requests(id, data). Keep that table intact under a legacy name, then
        // import its rows after creating the normalized Rust schema below.
        let request_columns = {
            let mut statement = connection.prepare("PRAGMA table_info(requests)")?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<std::collections::HashSet<_>>>()?;
            columns
        };
        let legacy_requests = if !request_columns.is_empty() && !request_columns.contains("status")
        {
            let mut suffix = 0_u32;
            let table = loop {
                let candidate = if suffix == 0 {
                    "legacy_requests".to_owned()
                } else {
                    format!("legacy_requests_{suffix}")
                };
                let exists: bool = connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [&candidate],
                    |row| row.get(0),
                )?;
                if !exists {
                    break candidate;
                }
                suffix += 1;
            };
            connection.execute_batch(&format!("ALTER TABLE requests RENAME TO {table};"))?;
            Some(table)
        } else {
            None
        };
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                name TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('dispatcher','engineer')),
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected')),
                qual TEXT,
                types TEXT NOT NULL DEFAULT '[]',
                base TEXT,
                tech_id INTEGER UNIQUE,
                speed REAL NOT NULL DEFAULT 4.0,
                created_at TEXT NOT NULL,
                approved_at TEXT,
                last_login_at TEXT,
                on_shift INTEGER NOT NULL DEFAULT 0,
                username TEXT NOT NULL DEFAULT '',
                bio TEXT NOT NULL DEFAULT '',
                avatar_color TEXT NOT NULL DEFAULT '#667085'
            );
            CREATE INDEX IF NOT EXISTS idx_users_status_role ON users(status, role);
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                expires_at REAL NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
            CREATE TABLE IF NOT EXISTS rust_sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_rust_sessions_user ON rust_sessions(user_id);
            CREATE TABLE IF NOT EXISTS registrations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                reviewed_at TEXT,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stand TEXT NOT NULL,
                description TEXT NOT NULL,
                qual TEXT NOT NULL,
                extra TEXT NOT NULL DEFAULT '',
                priority TEXT NOT NULL DEFAULT 'normal',
                tech_id INTEGER,
                tech_name TEXT NOT NULL DEFAULT 'Автоподбор',
                status TEXT NOT NULL DEFAULT 'waiting',
                created_at TEXT NOT NULL,
                arrived_at TEXT,
                started_at TEXT,
                resolved_at TEXT,
                version INTEGER NOT NULL DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS idx_requests_status_tech ON requests(status, tech_id);
            CREATE TABLE IF NOT EXISTS technician_positions (
                tech_id INTEGER PRIMARY KEY,
                x REAL NOT NULL,
                y REAL NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat_rooms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL CHECK(kind IN ('shift','direct')),
                name TEXT NOT NULL DEFAULT '',
                user_a INTEGER,
                user_b INTEGER,
                created_at TEXT NOT NULL,
                CHECK ((kind='shift' AND user_a IS NULL AND user_b IS NULL) OR
                       (kind='direct' AND user_a IS NOT NULL AND user_b IS NOT NULL AND user_a < user_b)),
                FOREIGN KEY(user_a) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(user_b) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_direct_pair ON chat_rooms(user_a,user_b) WHERE kind='direct';
            CREATE TABLE IF NOT EXISTS chat_attachments (
                id TEXT PRIMARY KEY,
                room_id INTEGER NOT NULL,
                uploader_id INTEGER NOT NULL,
                file_name TEXT NOT NULL,
                media_type TEXT NOT NULL,
                byte_size INTEGER NOT NULL CHECK(byte_size > 0 AND byte_size <= 15728640),
                storage_name TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                FOREIGN KEY(room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE,
                FOREIGN KEY(uploader_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_chat_attachments_room ON chat_attachments(room_id,created_at);
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id INTEGER NOT NULL,
                sender_id INTEGER NOT NULL,
                message_kind TEXT NOT NULL CHECK(message_kind IN ('text','sticker','file','voice')),
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                attachment_id TEXT,
                duration_sec INTEGER,
                CHECK ((message_kind IN ('file','voice') AND attachment_id IS NOT NULL) OR
                       (message_kind IN ('text','sticker') AND attachment_id IS NULL)),
                FOREIGN KEY(room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE,
                FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(attachment_id) REFERENCES chat_attachments(id)
            );
            CREATE INDEX IF NOT EXISTS idx_chat_messages_room_id ON chat_messages(room_id,id);
            CREATE TABLE IF NOT EXISTS chat_reads (
                room_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                last_read_message_id INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(room_id,user_id),
                FOREIGN KEY(room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            INSERT INTO chat_rooms(kind,name,created_at)
                SELECT 'shift','Общий канал смены',strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE NOT EXISTS (SELECT 1 FROM chat_rooms WHERE kind='shift');"
        )?;
        if let Some(table) = legacy_requests {
            let legacy_rows = {
                let mut statement =
                    connection.prepare(&format!("SELECT id,data FROM {table} ORDER BY id"))?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            for (id, raw) in legacy_rows {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
                    continue;
                };
                let text = |key: &str, fallback: &str| {
                    value
                        .get(key)
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or(fallback)
                        .to_owned()
                };
                let status = match text("status", "waiting").as_str() {
                    "waiting" | "enroute" | "arrived" | "working" | "done" | "cancelled" => {
                        text("status", "waiting")
                    }
                    _ => "waiting".to_owned(),
                };
                let priority = match text("priority", "normal").as_str() {
                    "low" | "normal" | "high" | "critical" | "emergency" => {
                        text("priority", "normal")
                    }
                    _ => "normal".to_owned(),
                };
                let tech_id = value.get("tech_id").and_then(serde_json::Value::as_i64);
                let tech_name = if let Some(tech_id) = tech_id {
                    connection
                        .query_row(
                            "SELECT name FROM users WHERE tech_id=?1 LIMIT 1",
                            [tech_id],
                            |row| row.get::<_, String>(0),
                        )
                        .unwrap_or_else(|_| format!("Инженер #{tech_id}"))
                } else {
                    "Автоподбор".to_owned()
                };
                let created_at = now_rfc3339();
                let arrived_at = value
                    .get("arrived_sim")
                    .filter(|v| !v.is_null())
                    .map(|_| created_at.clone());
                let started_at = (status == "working").then(|| created_at.clone());
                let resolved_at =
                    matches!(status.as_str(), "done" | "cancelled").then(|| created_at.clone());
                connection.execute(
                    "INSERT OR IGNORE INTO requests
                     (id,stand,description,qual,extra,priority,tech_id,tech_name,status,created_at,arrived_at,started_at,resolved_at)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                    params![
                        id,
                        text("stand", ""),
                        text("description", "Старая заявка RampPulse"),
                        text("qual", "auto"),
                        text("extra", ""),
                        priority,
                        tech_id,
                        tech_name,
                        status,
                        created_at,
                        arrived_at,
                        started_at,
                        resolved_at
                    ],
                )?;
            }
        }
        let mut message_columns = std::collections::HashSet::new();
        {
            let mut statement = connection.prepare("PRAGMA table_info(chat_messages)")?;
            for name in statement.query_map([], |row| row.get::<_, String>(1))? {
                message_columns.insert(name?);
            }
        }
        if !message_columns.contains("attachment_id") {
            connection.pragma_update(None, "foreign_keys", "OFF")?;
            let migration = (|| {
                let tx = connection.transaction()?;
                tx.execute_batch(
                    "CREATE TABLE chat_messages_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    room_id INTEGER NOT NULL,
                    sender_id INTEGER NOT NULL,
                    message_kind TEXT NOT NULL CHECK(message_kind IN ('text','sticker','file','voice')),
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    attachment_id TEXT,
                    duration_sec INTEGER,
                    CHECK ((message_kind IN ('file','voice') AND attachment_id IS NOT NULL) OR
                           (message_kind IN ('text','sticker') AND attachment_id IS NULL)),
                    FOREIGN KEY(room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE,
                    FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY(attachment_id) REFERENCES chat_attachments(id)
                 );
                 INSERT INTO chat_messages_new(id,room_id,sender_id,message_kind,content,created_at)
                    SELECT id,room_id,sender_id,message_kind,content,created_at FROM chat_messages;
                 DROP TABLE chat_messages;
                 ALTER TABLE chat_messages_new RENAME TO chat_messages;
                 CREATE INDEX idx_chat_messages_room_id ON chat_messages(room_id,id);"
                )?;
                tx.commit()
            })();
            let foreign_keys = connection.pragma_update(None, "foreign_keys", "ON");
            migration?;
            foreign_keys?;
        }
        let mut columns = std::collections::HashSet::new();
        {
            let mut statement = connection.prepare("PRAGMA table_info(users)")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
            for name in rows {
                columns.insert(name?);
            }
        }
        for (name, definition) in [
            ("on_shift", "INTEGER NOT NULL DEFAULT 0"),
            ("username", "TEXT NOT NULL DEFAULT ''"),
            ("bio", "TEXT NOT NULL DEFAULT ''"),
            ("avatar_color", "TEXT NOT NULL DEFAULT '#667085'"),
            ("speed", "REAL NOT NULL DEFAULT 4.0"),
            ("approved_at", "TEXT"),
            ("last_login_at", "TEXT"),
            ("types", "TEXT NOT NULL DEFAULT '[]'"),
            ("base", "TEXT"),
            ("tech_id", "INTEGER"),
        ] {
            if !columns.contains(name) {
                connection.execute_batch(&format!(
                    "ALTER TABLE users ADD COLUMN {name} {definition};"
                ))?;
            }
        }
        connection.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_users_status_role ON users(status, role);
             CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE) WHERE username <> '';"
        )?;
        Ok(())
    }

    pub fn seed_demo(&self) -> rusqlite::Result<()> {
        let mut connection = self.connection()?;
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM users WHERE role='dispatcher'",
            [],
            |row| row.get(0),
        )?;
        if count > 0 {
            return Ok(());
        }
        let mut salt = [0_u8; 16];
        rand::fill(&mut salt);
        let dispatcher_hash = hash_password("Dispatcher2026!", &salt, PBKDF2_ITERATIONS);
        let now = now_rfc3339();
        let tx = connection.transaction()?;
        tx.execute("INSERT INTO users(email,username,password_hash,name,role,status,created_at,approved_at,on_shift) VALUES(?1,'orlov',?2,'Орлов А. В.','dispatcher','active',?3,?3,1)", params!["dispatcher@oto.ru", dispatcher_hash, now])?;
        let mut engineer_salt = [0_u8; 16];
        rand::fill(&mut engineer_salt);
        let engineer_hash = hash_password("Engineer2026!", &engineer_salt, PBKDF2_ITERATIONS);
        tx.execute("INSERT INTO users(email,username,password_hash,name,role,status,qual,types,base,tech_id,on_shift,created_at,approved_at) VALUES(?1,'ivanov_to',?2,'Иванов И. И.','engineer','active','Планер','[\"A320\",\"B737\"]','BASE1',1,1,?3,?3)", params!["tech1@oto.ru", engineer_hash, now])?;
        tx.commit()
    }

    pub fn authenticate_and_create_session(
        &self,
        email: &str,
        password: &str,
    ) -> Result<(PublicUser, String), AuthFailure> {
        let (user, encoded): (PublicUser, String) = {
            let connection = self.connection().map_err(|_| AuthFailure::Storage)?;
            let mut statement = connection.prepare("SELECT id,email,username,bio,avatar_color,name,role,status,qual,types,base,tech_id,on_shift,created_at,approved_at,password_hash FROM users WHERE email=?1 COLLATE NOCASE OR (username<>'' AND username=?1 COLLATE NOCASE) LIMIT 1")
                .map_err(|_| AuthFailure::Storage)?;
            statement
                .query_row([email], |row| {
                    let types_json: String = row.get(9)?;
                    let types = serde_json::from_str(&types_json).unwrap_or_default();
                    Ok((
                        PublicUser {
                            id: row.get(0)?,
                            email: row.get(1)?,
                            username: row.get(2)?,
                            bio: row.get(3)?,
                            avatar_color: row.get(4)?,
                            name: row.get(5)?,
                            role: row.get(6)?,
                            status: row.get(7)?,
                            qual: row.get(8)?,
                            types,
                            base: row.get(10)?,
                            tech_id: row.get(11)?,
                            on_shift: row.get::<_, i64>(12)? != 0,
                            created_at: row.get(13)?,
                            approved_at: row.get(14)?,
                        },
                        row.get(15)?,
                    ))
                })
                .optional()
                .map_err(|_| AuthFailure::Storage)?
                .ok_or(AuthFailure::InvalidCredentials)?
        };
        if !verify_password(password, &encoded) {
            return Err(AuthFailure::InvalidCredentials);
        }
        match user.status.as_str() {
            "pending" => return Err(AuthFailure::Pending),
            "active" => {}
            _ => return Err(AuthFailure::Closed),
        }

        let token = random_session_token();
        let token_hash = hash_session_token(&token);
        let now = now_rfc3339();
        let expires = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| AuthFailure::Storage)?
            .as_secs() as i64
            + SESSION_TTL_SECONDS;
        let connection = self.connection().map_err(|_| AuthFailure::Storage)?;
        connection
            .execute(
                "DELETE FROM rust_sessions WHERE expires_at < strftime('%s','now')",
                [],
            )
            .map_err(|_| AuthFailure::Storage)?;
        connection
            .execute(
                "INSERT INTO rust_sessions(token_hash,user_id,created_at,expires_at) VALUES(?1,?2,?3,?4)",
                params![token_hash, user.id, now, expires],
            )
            .map_err(|_| AuthFailure::Storage)?;
        connection
            .execute(
                "UPDATE users SET last_login_at=?1 WHERE id=?2",
                params![now, user.id],
            )
            .map_err(|_| AuthFailure::Storage)?;
        Ok((user, token))
    }

    pub fn user_for_token(&self, token: &str) -> rusqlite::Result<PublicUser> {
        let connection = self.connection()?;
        let token_hash = hash_session_token(token);
        connection.query_row(
            "SELECT u.id,u.email,u.username,u.bio,u.avatar_color,u.name,u.role,u.status,u.qual,u.types,u.base,u.tech_id,u.on_shift,u.created_at,u.approved_at
             FROM users u JOIN sessions s ON s.user_id=u.id
             WHERE s.token=?2 AND s.expires_at > strftime('%s','now') AND u.status='active'
             UNION ALL
             SELECT u.id,u.email,u.username,u.bio,u.avatar_color,u.name,u.role,u.status,u.qual,u.types,u.base,u.tech_id,u.on_shift,u.created_at,u.approved_at
             FROM users u JOIN rust_sessions s ON s.user_id=u.id
             WHERE s.token_hash=?1 AND s.expires_at > strftime('%s','now') AND u.status='active'
             LIMIT 1",
            rusqlite::params![token_hash, token],
            |row| {
                let types_json: String = row.get(9)?;
                let types = serde_json::from_str(&types_json).unwrap_or_default();
                Ok(PublicUser { id:row.get(0)?,email:row.get(1)?,username:row.get(2)?,bio:row.get(3)?,avatar_color:row.get(4)?,name:row.get(5)?,role:row.get(6)?,status:row.get(7)?,qual:row.get(8)?,types,base:row.get(10)?,tech_id:row.get(11)?,on_shift:row.get::<_,i64>(12)? != 0,created_at:row.get(13)?,approved_at:row.get(14)? })
            }
        )
    }

    pub fn delete_session(&self, token: &str) -> rusqlite::Result<()> {
        let connection = self.connection()?;
        connection.execute(
            "DELETE FROM rust_sessions WHERE token_hash=?1",
            [hash_session_token(token)],
        )?;
        connection.execute("DELETE FROM sessions WHERE token=?1", [token])?;
        Ok(())
    }

    /// Updates the editable profile fields. Returns `Ok(None)` when the username is taken.
    pub fn update_profile(
        &self,
        user_id: i64,
        name: &str,
        username: &str,
        bio: &str,
        avatar_color: &str,
    ) -> rusqlite::Result<Option<PublicUser>> {
        let connection = self.connection()?;
        let taken: Option<i64> = connection
            .query_row(
                "SELECT id FROM users WHERE username=?1 COLLATE NOCASE AND id<>?2 AND username<>''",
                params![username, user_id],
                |row| row.get(0),
            )
            .optional()?;
        if taken.is_some() {
            return Ok(None);
        }
        connection.execute(
            "UPDATE users SET name=?1,username=?2,bio=?3,avatar_color=?4 WHERE id=?5",
            params![name, username, bio, avatar_color, user_id],
        )?;
        drop(connection);
        self.user_by_id(user_id).map(Some)
    }

    /// Verifies the current password and stores a new one. `Ok(false)` = wrong password.
    pub fn change_password(&self, user_id: i64, current: &str, new: &str) -> rusqlite::Result<bool> {
        let connection = self.connection()?;
        let encoded: String = connection.query_row(
            "SELECT password_hash FROM users WHERE id=?1",
            [user_id],
            |row| row.get(0),
        )?;
        if !verify_password(current, &encoded) {
            return Ok(false);
        }
        let mut salt = [0_u8; 16];
        rand::fill(&mut salt);
        let hash = hash_password(new, &salt, PBKDF2_ITERATIONS);
        connection.execute(
            "UPDATE users SET password_hash=?1 WHERE id=?2",
            params![hash, user_id],
        )?;
        Ok(true)
    }

    /// Ends every session of the user except the one identified by `keep_token`.
    pub fn delete_other_sessions(&self, user_id: i64, keep_token: &str) -> rusqlite::Result<usize> {
        let connection = self.connection()?;
        let removed = connection.execute(
            "DELETE FROM rust_sessions WHERE user_id=?1 AND token_hash<>?2",
            params![user_id, hash_session_token(keep_token)],
        )?;
        connection.execute(
            "DELETE FROM sessions WHERE user_id=?1 AND token<>?2",
            params![user_id, keep_token],
        )?;
        Ok(removed)
    }

    pub fn session_count(&self, user_id: i64) -> rusqlite::Result<i64> {
        let connection = self.connection()?;
        connection.query_row(
            "SELECT COUNT(*) FROM rust_sessions WHERE user_id=?1 AND expires_at > strftime('%s','now')",
            [user_id],
            |row| row.get(0),
        )
    }

    pub fn register_engineer(&self, new: NewEngineer) -> rusqlite::Result<PublicUser> {
        let mut salt = [0_u8; 16];
        rand::fill(&mut salt);
        let password_hash = hash_password(&new.password, &salt, PBKDF2_ITERATIONS);
        let types = serde_json::to_string(&new.types).unwrap_or_else(|_| "[]".into());
        let now = now_rfc3339();
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        tx.execute("INSERT INTO users(email,username,password_hash,name,role,status,qual,types,base,on_shift,created_at) VALUES(?1,?2,?3,?4,'engineer','pending',?5,?6,?7,0,?8)", params![new.email,new.username,password_hash,new.name,new.qual,types,new.base,now])?;
        let user_id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO registrations(user_id,status,created_at) VALUES(?1,'pending',?2)",
            params![user_id, now],
        )?;
        tx.commit()?;
        drop(connection);
        self.user_by_id(user_id)
    }

    fn user_by_id(&self, id: i64) -> rusqlite::Result<PublicUser> {
        let connection = self.connection()?;
        connection.query_row("SELECT id,email,username,bio,avatar_color,name,role,status,qual,types,base,tech_id,on_shift,created_at,approved_at FROM users WHERE id=?1",[id],|row| {
            let types_json:String=row.get(9)?; let types=serde_json::from_str(&types_json).unwrap_or_default();
            Ok(PublicUser{id:row.get(0)?,email:row.get(1)?,username:row.get(2)?,bio:row.get(3)?,avatar_color:row.get(4)?,name:row.get(5)?,role:row.get(6)?,status:row.get(7)?,qual:row.get(8)?,types,base:row.get(10)?,tech_id:row.get(11)?,on_shift:row.get::<_,i64>(12)? != 0,created_at:row.get(13)?,approved_at:row.get(14)?})
        })
    }

    pub fn pending_engineers(&self) -> rusqlite::Result<Vec<PublicUser>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id,email,username,bio,avatar_color,name,role,status,qual,types,base,tech_id,on_shift,created_at,approved_at
             FROM users WHERE role='engineer' AND status='pending' ORDER BY id"
        )?;
        let rows = statement.query_map([], |row| {
            let types_json: String = row.get(9)?;
            let types = serde_json::from_str(&types_json).unwrap_or_default();
            Ok(PublicUser {
                id: row.get(0)?,
                email: row.get(1)?,
                username: row.get(2)?,
                bio: row.get(3)?,
                avatar_color: row.get(4)?,
                name: row.get(5)?,
                role: row.get(6)?,
                status: row.get(7)?,
                qual: row.get(8)?,
                types,
                base: row.get(10)?,
                tech_id: row.get(11)?,
                on_shift: row.get::<_, i64>(12)? != 0,
                created_at: row.get(13)?,
                approved_at: row.get(14)?,
            })
        })?;
        rows.collect()
    }

    pub fn active_engineers(&self) -> rusqlite::Result<Vec<PublicUser>> {
        let connection = self.connection()?;
        let mut statement=connection.prepare(
            "SELECT id,email,username,bio,avatar_color,name,role,status,qual,types,base,tech_id,on_shift,created_at,approved_at
             FROM users WHERE role='engineer' AND status='active' ORDER BY tech_id"
        )?;
        let rows = statement.query_map([], |row| {
            let types_json: String = row.get(9)?;
            Ok(PublicUser {
                id: row.get(0)?,
                email: row.get(1)?,
                username: row.get(2)?,
                bio: row.get(3)?,
                avatar_color: row.get(4)?,
                name: row.get(5)?,
                role: row.get(6)?,
                status: row.get(7)?,
                qual: row.get(8)?,
                types: serde_json::from_str(&types_json).unwrap_or_default(),
                base: row.get(10)?,
                tech_id: row.get(11)?,
                on_shift: row.get::<_, i64>(12)? != 0,
                created_at: row.get(13)?,
                approved_at: row.get(14)?,
            })
        })?;
        rows.collect()
    }

    pub fn approve_engineer(&self, user_id: i64) -> rusqlite::Result<PublicUser> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        let status: String = tx.query_row(
            "SELECT status FROM users WHERE id=?1 AND role='engineer'",
            [user_id],
            |row| row.get(0),
        )?;
        if status != "pending" {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let tech_id: i64 =
            tx.query_row("SELECT COALESCE(MAX(tech_id),0)+1 FROM users", [], |row| {
                row.get(0)
            })?;
        let now = now_rfc3339();
        tx.execute(
            "UPDATE users SET status='active',tech_id=?1,on_shift=0,approved_at=?2 WHERE id=?3",
            params![tech_id, now, user_id],
        )?;
        tx.execute(
            "UPDATE registrations SET status='approved',reviewed_at=?1 WHERE user_id=?2",
            params![now, user_id],
        )?;
        tx.commit()?;
        drop(connection);
        self.user_by_id(user_id)
    }

    pub fn reject_engineer(&self, user_id: i64) -> rusqlite::Result<()> {
        let connection = self.connection()?;
        let now = now_rfc3339();
        let changed = connection.execute("UPDATE users SET status='rejected' WHERE id=?1 AND role='engineer' AND status='pending'", [user_id])?;
        if changed == 0 {
            return Err(rusqlite::Error::InvalidQuery);
        }
        connection.execute(
            "UPDATE registrations SET status='rejected',reviewed_at=?1 WHERE user_id=?2",
            params![now, user_id],
        )?;
        Ok(())
    }

    pub fn create_request(
        &self,
        new: NewRequest,
        ranked_technicians: &[(i64, f64)],
    ) -> rusqlite::Result<RequestRecord> {
        let now = now_rfc3339();
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        // Route ranking comes from the shared Rust airport graph. This transaction still makes
        // the final availability check authoritative so two simultaneous requests cannot claim
        // the same engineer.
        let mut statement = tx.prepare(
            "SELECT u.tech_id,u.name FROM users u
             WHERE u.role='engineer' AND u.status='active' AND u.on_shift=1 AND u.tech_id IS NOT NULL
               AND (?1='auto' OR u.qual=?1)
               AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.tech_id=u.tech_id
                 AND r.status NOT IN ('done','cancelled'))
             ORDER BY u.tech_id",
        )?;
        let eligible = statement
            .query_map([&new.qual], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        let eta_by_technician: std::collections::HashMap<i64, f64> =
            ranked_technicians.iter().copied().collect();
        let emergency = matches!(new.priority.as_str(), "critical" | "emergency");
        let assigned = ranked_technicians
            .iter()
            .filter(|(_, eta)| emergency || *eta <= 900.0)
            .find_map(|(tech_id, _)| {
                eligible
                    .iter()
                    .find(|(eligible_id, _)| eligible_id == tech_id)
                    .cloned()
            });
        let assigned = assigned.filter(|(id, _)| eta_by_technician.contains_key(id));
        let (tech_id, tech_name, status) = match assigned {
            Some((id, name)) => (Some(id), name, "enroute"),
            None => (None, "Автоподбор".to_owned(), "waiting"),
        };
        tx.execute(
            "INSERT INTO requests(stand,description,qual,extra,priority,tech_id,tech_name,status,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![new.stand,new.description,new.qual,new.extra,new.priority,tech_id,tech_name,status,now],
        )?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        drop(connection);
        self.request_by_id(id)
    }

    pub fn requests_for(&self, user: &PublicUser) -> rusqlite::Result<Vec<RequestRecord>> {
        let connection = self.connection()?;
        if user.role == "engineer" {
            let mut statement=connection.prepare(
                "SELECT r.id,r.stand,r.description,r.qual,r.extra,r.priority,r.tech_id,r.tech_name,r.status,
                 r.created_at,r.arrived_at,r.started_at,r.resolved_at,r.version
                 FROM requests r WHERE r.tech_id=?1 OR r.status='waiting' ORDER BY r.id DESC"
            )?;
            let rows = statement.query_map([user.tech_id.unwrap_or(user.id)], read_request)?;
            return rows.collect();
        }
        let mut statement=connection.prepare(
            "SELECT r.id,r.stand,r.description,r.qual,r.extra,r.priority,r.tech_id,r.tech_name,r.status,
             r.created_at,r.arrived_at,r.started_at,r.resolved_at,r.version FROM requests r ORDER BY r.id DESC"
        )?;
        let rows = statement.query_map([], read_request)?;
        rows.collect()
    }

    pub fn engineer_user_id(&self, tech_id: i64) -> rusqlite::Result<Option<i64>> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id FROM users WHERE role='engineer' AND tech_id=?1 AND status='active'",
                [tech_id],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn technician_positions(&self) -> rusqlite::Result<Vec<(i64, f64, f64)>> {
        let connection = self.connection()?;
        let mut statement =
            connection.prepare("SELECT tech_id,x,y FROM technician_positions ORDER BY tech_id")?;
        let positions = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect();
        positions
    }

    pub fn save_technician_positions(&self, positions: &[(i64, f64, f64)]) -> rusqlite::Result<()> {
        if positions.is_empty() {
            return Ok(());
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        let now = now_rfc3339();
        for (tech_id, x, y) in positions {
            if !x.is_finite() || !y.is_finite() {
                return Err(rusqlite::Error::InvalidQuery);
            }
            tx.execute(
                "INSERT INTO technician_positions(tech_id,x,y,updated_at) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(tech_id) DO UPDATE SET x=excluded.x,y=excluded.y,updated_at=excluded.updated_at",
                params![tech_id, x, y, now],
            )?;
        }
        tx.commit()
    }

    pub fn update_engineer_tech_profile(
        &self,
        tech_id: i64,
        qual: &str,
        types: &[String],
    ) -> rusqlite::Result<Option<PublicUser>> {
        let connection = self.connection()?;
        let encoded = serde_json::to_string(types).unwrap_or_else(|_| "[]".into());
        let changed=connection.execute("UPDATE users SET qual=?1,types=?2 WHERE role='engineer' AND status='active' AND tech_id=?3",params![qual.trim(),encoded,tech_id])?;
        drop(connection);
        if changed == 0 {
            Ok(None)
        } else {
            let user_id = self
                .engineer_user_id(tech_id)?
                .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
            self.user_by_id(user_id).map(Some)
        }
    }

    pub fn can_call(&self, user_id: i64, peer_id: i64) -> rusqlite::Result<bool> {
        let connection = self.connection()?;
        let roles: Option<(String, String)> = connection
            .query_row(
                "SELECT a.role,b.role FROM users a JOIN users b ON b.id=?2
             WHERE a.id=?1 AND a.status='active' AND b.status='active'",
                params![user_id, peer_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        Ok(
            matches!(roles,Some((a,b)) if matches!((a.as_str(),b.as_str()),("dispatcher","engineer")|("engineer","dispatcher"))),
        )
    }

    pub fn direct_room(&self, user_id: i64, peer_id: i64) -> rusqlite::Result<ChatRoom> {
        if user_id == peer_id {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let (user_a, user_b) = if user_id < peer_id {
            (user_id, peer_id)
        } else {
            (peer_id, user_id)
        };
        let connection = self.connection()?;
        let pair: (String, String) = connection.query_row(
            "SELECT a.role,b.role FROM users a JOIN users b WHERE a.id=?1 AND b.id=?2
             AND a.status='active' AND b.status='active'",
            params![user_id, peer_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if pair.0 == pair.1
            || !matches!(
                (pair.0.as_str(), pair.1.as_str()),
                ("dispatcher", "engineer") | ("engineer", "dispatcher")
            )
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let now = now_rfc3339();
        connection.execute("INSERT OR IGNORE INTO chat_rooms(kind,user_a,user_b,created_at) VALUES('direct',?1,?2,?3)",params![user_a,user_b,now])?;
        let id: i64 = connection.query_row(
            "SELECT id FROM chat_rooms WHERE kind='direct' AND user_a=?1 AND user_b=?2",
            params![user_a, user_b],
            |row| row.get(0),
        )?;
        let peer_name: String =
            connection.query_row("SELECT name FROM users WHERE id=?1", [peer_id], |row| {
                row.get(0)
            })?;
        Ok(ChatRoom {
            id,
            kind: "direct".into(),
            name: peer_name.clone(),
            peer_name: Some(peer_name),
            peer_id: Some(peer_id),
            unread: 0,
        })
    }

    pub fn chat_rooms(&self, user: &PublicUser) -> rusqlite::Result<Vec<ChatRoom>> {
        let connection = self.connection()?;
        let mut rooms = Vec::new();
        let shift=connection.query_row(
            "SELECT r.id,r.name,COALESCE((SELECT COUNT(*) FROM chat_messages m
              WHERE m.room_id=r.id AND m.id>COALESCE(cr.last_read_message_id,0) AND m.sender_id<>?1),0)
             FROM chat_rooms r LEFT JOIN chat_reads cr ON cr.room_id=r.id AND cr.user_id=?1
             WHERE r.kind='shift' ORDER BY r.id LIMIT 1",
            [user.id],|row|Ok(ChatRoom{id:row.get(0)?,kind:"shift".into(),name:row.get(1)?,peer_name:Some(row.get(1)?),peer_id:None,unread:row.get(2)?})
        )?;
        rooms.push(shift);
        let mut statement=connection.prepare(
            "SELECT r.id,CASE WHEN r.user_a=?1 THEN r.user_b ELSE r.user_a END,
               p.name,COALESCE((SELECT COUNT(*) FROM chat_messages m
                 WHERE m.room_id=r.id AND m.id>COALESCE(cr.last_read_message_id,0) AND m.sender_id<>?1),0)
             FROM chat_rooms r JOIN users p ON p.id=CASE WHEN r.user_a=?1 THEN r.user_b ELSE r.user_a END
             LEFT JOIN chat_reads cr ON cr.room_id=r.id AND cr.user_id=?1
             WHERE r.kind='direct' AND (r.user_a=?1 OR r.user_b=?1) ORDER BY r.id DESC"
        )?;
        let direct = statement.query_map([user.id], |row| {
            Ok(ChatRoom {
                id: row.get(0)?,
                kind: "direct".into(),
                peer_id: Some(row.get(1)?),
                name: row.get(2)?,
                peer_name: Some(row.get(2)?),
                unread: row.get(3)?,
            })
        })?;
        rooms.extend(direct.collect::<rusqlite::Result<Vec<_>>>()?);
        Ok(rooms)
    }

    pub fn chat_contacts(&self, user: &PublicUser) -> rusqlite::Result<Vec<ChatContact>> {
        let connection = self.connection()?;
        let opposite = if user.role == "dispatcher" {
            "engineer"
        } else {
            "dispatcher"
        };
        let mut statement=connection.prepare("SELECT id,name,username,qual,on_shift,avatar_color,bio FROM users WHERE role=?1 AND status='active' ORDER BY on_shift DESC,name COLLATE NOCASE")?;
        let rows = statement.query_map([opposite], |row| {
            Ok(ChatContact {
                id: row.get(0)?,
                name: row.get(1)?,
                username: row.get(2)?,
                qual: row.get(3)?,
                on_shift: row.get::<_, i64>(4)? != 0,
                avatar_color: row.get(5)?,
                bio: row.get(6)?,
                online: false,
            })
        })?;
        rows.collect()
    }

    pub fn chat_messages(
        &self,
        room_id: i64,
        user: &PublicUser,
        limit: i64,
    ) -> rusqlite::Result<Vec<ChatMessage>> {
        let connection = self.connection()?;
        ensure_room_access(&connection, room_id, user.id)?;
        let mut statement=connection.prepare(
            "SELECT m.id,m.room_id,m.sender_id,u.name,m.message_kind,m.content,m.created_at,
               EXISTS(SELECT 1 FROM chat_reads cr WHERE cr.room_id=m.room_id AND cr.user_id<>m.sender_id AND cr.last_read_message_id>=m.id),
               a.id,a.file_name,a.media_type,m.duration_sec
             FROM chat_messages m JOIN users u ON u.id=m.sender_id
             LEFT JOIN chat_attachments a ON a.id=m.attachment_id
             WHERE m.room_id=?1 ORDER BY m.id DESC LIMIT ?2"
        )?;
        let rows = statement.query_map(params![room_id, limit.clamp(1, 100)], |row| {
            let attachment_id: Option<String> = row.get(8)?;
            Ok(ChatMessage {
                id: row.get(0)?,
                room_id: row.get(1)?,
                sender_id: row.get(2)?,
                sender_name: row.get(3)?,
                room_kind: room_kind_for(&connection, room_id)?,
                kind: row.get(4)?,
                body: if row.get::<_, String>(4)? == "text" {
                    row.get(5)?
                } else {
                    String::new()
                },
                sticker: if row.get::<_, String>(4)? == "sticker" {
                    Some(row.get(5)?)
                } else {
                    None
                },
                content: row.get(5)?,
                created_at: row.get(6)?,
                read: row.get::<_, i64>(7)? != 0,
                media_url: attachment_id.map(|id| format!("/api/chat/attachments/{id}")),
                media_name: row.get(9)?,
                media_type: row.get(10)?,
                duration: row.get(11)?,
            })
        })?;
        let mut messages = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        messages.reverse();
        Ok(messages)
    }

    pub fn send_chat_message(
        &self,
        room_id: i64,
        user: &PublicUser,
        kind: &str,
        content: &str,
        attachment_id: Option<&str>,
        duration: Option<i64>,
    ) -> rusqlite::Result<(ChatMessage, Vec<i64>)> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        ensure_room_access(&tx, room_id, user.id)?;
        let room_kind = room_kind_for(&tx, room_id)?;
        let attachment = match kind {
            "file" | "voice" => {
                let id = attachment_id.ok_or(rusqlite::Error::InvalidQuery)?;
                let metadata: (String, String) = tx.query_row(
                    "SELECT file_name,media_type FROM chat_attachments WHERE id=?1 AND room_id=?2 AND uploader_id=?3",
                    params![id, room_id, user.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                if kind == "voice" && !metadata.1.starts_with("audio/") {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                if kind == "voice" && !duration.is_some_and(|seconds| (1..=600).contains(&seconds))
                {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                if kind == "file" && duration.is_some() {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                Some((id.to_owned(), metadata.0, metadata.1))
            }
            "text" | "sticker" if attachment_id.is_none() && duration.is_none() => None,
            _ => return Err(rusqlite::Error::InvalidQuery),
        };
        if !matches!(kind, "text" | "sticker" | "file" | "voice") {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let now = now_rfc3339();
        let stored_content = attachment
            .as_ref()
            .map(|item| item.1.as_str())
            .unwrap_or(content);
        tx.execute(
            "INSERT INTO chat_messages(room_id,sender_id,message_kind,content,created_at,attachment_id,duration_sec)
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![room_id, user.id, kind, stored_content, now, attachment.as_ref().map(|item| item.0.as_str()), duration],
        )?;
        let id = tx.last_insert_rowid();
        let recipients = room_recipients(&tx, room_id, user.id)?;
        tx.commit()?;
        drop(connection);
        let message = ChatMessage {
            id,
            room_id,
            sender_id: user.id,
            sender_name: user.name.clone(),
            room_kind,
            kind: kind.into(),
            body: if kind == "text" {
                content.into()
            } else {
                String::new()
            },
            sticker: if kind == "sticker" {
                Some(content.into())
            } else {
                None
            },
            content: content.into(),
            created_at: now,
            read: false,
            media_url: attachment
                .as_ref()
                .map(|item| format!("/api/chat/attachments/{}", item.0)),
            media_type: attachment.as_ref().map(|item| item.2.clone()),
            media_name: attachment.as_ref().map(|item| item.1.clone()),
            duration,
        };
        Ok((message, recipients))
    }

    pub fn mark_chat_read(
        &self,
        room_id: i64,
        user_id: i64,
        message_id: i64,
    ) -> rusqlite::Result<()> {
        let connection = self.connection()?;
        ensure_room_access(&connection, room_id, user_id)?;
        let latest: Option<i64> = connection.query_row(
            "SELECT MAX(id) FROM chat_messages WHERE room_id=?1",
            [room_id],
            |row| row.get(0),
        )?;
        if message_id < 0 || message_id > latest.unwrap_or(0) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let now = now_rfc3339();
        connection.execute("INSERT INTO chat_reads(room_id,user_id,last_read_message_id,updated_at) VALUES(?1,?2,?3,?4)
           ON CONFLICT(room_id,user_id) DO UPDATE SET last_read_message_id=MAX(last_read_message_id,excluded.last_read_message_id),updated_at=excluded.updated_at",params![room_id,user_id,message_id,now])?;
        Ok(())
    }

    pub fn chat_recipients(&self, room_id: i64, user_id: i64) -> rusqlite::Result<Vec<i64>> {
        let connection = self.connection()?;
        ensure_room_access(&connection, room_id, user_id)?;
        room_recipients(&connection, room_id, user_id)
    }

    pub fn create_chat_attachment(
        &self,
        id: &str,
        room_id: i64,
        user_id: i64,
        file_name: &str,
        media_type: &str,
        byte_size: i64,
        storage_name: &str,
    ) -> rusqlite::Result<()> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        ensure_room_access(&tx, room_id, user_id)?;
        let created_at = now_rfc3339();
        tx.execute(
            "INSERT INTO chat_attachments(id,room_id,uploader_id,file_name,media_type,byte_size,storage_name,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![id, room_id, user_id, file_name, media_type, byte_size, storage_name, created_at],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn chat_room_access(&self, room_id: i64, user_id: i64) -> rusqlite::Result<()> {
        let connection = self.connection()?;
        ensure_room_access(&connection, room_id, user_id)
    }

    pub fn delete_unlinked_chat_attachment(&self, id: &str) -> rusqlite::Result<()> {
        let connection = self.connection()?;
        connection.execute(
            "DELETE FROM chat_attachments WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM chat_messages WHERE attachment_id=?1)",
            [id],
        )?;
        Ok(())
    }

    pub fn chat_attachment_for_user(
        &self,
        id: &str,
        user_id: i64,
    ) -> rusqlite::Result<ChatAttachment> {
        let connection = self.connection()?;
        connection.query_row(
            "SELECT a.file_name,a.media_type,a.storage_name
             FROM chat_attachments a JOIN chat_rooms r ON r.id=a.room_id
             JOIN users u ON u.id=?2 AND u.status='active'
             WHERE a.id=?1 AND (r.kind='shift' OR r.user_a=?2 OR r.user_b=?2)",
            params![id, user_id],
            |row| {
                Ok(ChatAttachment {
                    file_name: row.get(0)?,
                    media_type: row.get(1)?,
                    storage_name: row.get(2)?,
                })
            },
        )
    }

    pub fn transition_request(
        &self,
        id: i64,
        next: &str,
        user: &PublicUser,
    ) -> rusqlite::Result<RequestRecord> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        let current = query_request(&tx, id)?;
        if user.role != "dispatcher" && (user.tech_id.is_none() || current.tech_id != user.tech_id)
        {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        let valid = match (current.status.as_str(), next) {
            ("waiting", "enroute" | "cancelled") => true,
            ("enroute", "arrived" | "cancelled") => true,
            ("arrived", "working" | "cancelled") => true,
            ("working", "done" | "cancelled") => true,
            _ => false,
        };
        if !valid {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if user.role == "engineer" && !matches!(next, "enroute" | "arrived" | "working" | "done") {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let now = now_rfc3339();
        let (arrived, started, resolved) = match next {
            "arrived" => (Some(now.as_str()), None, None),
            "working" => (None, Some(now.as_str()), None),
            "done" => (None, None, Some(now.as_str())),
            _ => (None, None, None),
        };
        tx.execute(
            "UPDATE requests SET status=?1,arrived_at=COALESCE(?2,arrived_at),
             started_at=COALESCE(?3,started_at),resolved_at=COALESCE(?4,resolved_at),version=version+1 WHERE id=?5",
            params![next,arrived,started,resolved,id],
        )?;
        tx.commit()?;
        drop(connection);
        self.request_by_id(id)
    }

    pub fn set_shift(&self, user_id: i64, on_shift: bool) -> Result<PublicUser, ShiftFailure> {
        let mut connection = self.connection().map_err(|_| ShiftFailure::Storage)?;
        let tx = connection
            .transaction()
            .map_err(|_| ShiftFailure::Storage)?;
        let tech_id: Option<i64> = tx
            .query_row(
                "SELECT tech_id FROM users WHERE id=?1 AND role='engineer' AND status='active'",
                [user_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| ShiftFailure::Storage)?
            .ok_or(ShiftFailure::NotEngineer)?;
        if !on_shift {
            let active: i64 = tx.query_row(
                "SELECT COUNT(*) FROM requests WHERE tech_id=?1 AND status NOT IN ('done','cancelled')",
                [tech_id],
                |row| row.get(0),
            ).map_err(|_| ShiftFailure::Storage)?;
            if active > 0 {
                return Err(ShiftFailure::ActiveRequest);
            }
        }
        tx.execute(
            "UPDATE users SET on_shift=?1 WHERE id=?2",
            params![i64::from(on_shift), user_id],
        )
        .map_err(|_| ShiftFailure::Storage)?;
        tx.commit().map_err(|_| ShiftFailure::Storage)?;
        drop(connection);
        self.user_by_id(user_id).map_err(|_| ShiftFailure::Storage)
    }

    fn request_by_id(&self, id: i64) -> rusqlite::Result<RequestRecord> {
        let connection = self.connection()?;
        connection.query_row(
            "SELECT id,stand,description,qual,extra,priority,tech_id,tech_name,status,created_at,arrived_at,started_at,resolved_at,version FROM requests WHERE id=?1",
            [id], read_request,
        )
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct RequestRecord {
    pub id: i64,
    pub stand: String,
    pub description: String,
    pub qual: String,
    pub extra: String,
    pub priority: String,
    pub tech_id: Option<i64>,
    pub tech_name: String,
    pub status: String,
    pub status_ru: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arrived_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
    pub version: i64,
}

pub struct NewRequest {
    pub stand: String,
    pub description: String,
    pub qual: String,
    pub extra: String,
    pub priority: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatRoom {
    pub id: i64,
    pub kind: String,
    pub name: String,
    pub peer_name: Option<String>,
    pub peer_id: Option<i64>,
    pub unread: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatContact {
    pub id: i64,
    pub name: String,
    pub username: String,
    pub qual: Option<String>,
    pub on_shift: bool,
    pub avatar_color: String,
    pub bio: String,
    pub online: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatMessage {
    pub id: i64,
    pub room_id: i64,
    pub sender_id: i64,
    pub sender_name: String,
    pub room_kind: String,
    pub kind: String,
    pub body: String,
    pub sticker: Option<String>,
    pub content: String,
    pub created_at: String,
    pub read: bool,
    pub media_url: Option<String>,
    pub media_type: Option<String>,
    pub media_name: Option<String>,
    pub duration: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct ChatAttachment {
    pub file_name: String,
    pub media_type: String,
    pub storage_name: String,
}

fn room_kind_for(connection: &rusqlite::Connection, room_id: i64) -> rusqlite::Result<String> {
    connection.query_row(
        "SELECT kind FROM chat_rooms WHERE id=?1",
        [room_id],
        |row| row.get(0),
    )
}

fn ensure_room_access(
    connection: &rusqlite::Connection,
    room_id: i64,
    user_id: i64,
) -> rusqlite::Result<()> {
    let allowed: i64 = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM chat_rooms r JOIN users u ON u.id=?2 AND u.status='active'
           WHERE r.id=?1 AND (r.kind='shift' OR r.user_a=?2 OR r.user_b=?2))",
        params![room_id, user_id],
        |row| row.get(0),
    )?;
    if allowed == 1 {
        Ok(())
    } else {
        Err(rusqlite::Error::QueryReturnedNoRows)
    }
}

fn room_recipients(
    connection: &rusqlite::Connection,
    room_id: i64,
    sender_id: i64,
) -> rusqlite::Result<Vec<i64>> {
    let (kind, user_a, user_b): (String, Option<i64>, Option<i64>) = connection.query_row(
        "SELECT kind,user_a,user_b FROM chat_rooms WHERE id=?1",
        [room_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if kind == "shift" {
        let mut statement =
            connection.prepare("SELECT id FROM users WHERE status='active' AND id<>?1")?;
        let ids = statement.query_map([sender_id], |row| row.get(0))?;
        ids.collect()
    } else {
        Ok([user_a, user_b]
            .into_iter()
            .flatten()
            .filter(|id| *id != sender_id)
            .collect())
    }
}

fn read_request(row: &rusqlite::Row<'_>) -> rusqlite::Result<RequestRecord> {
    let status: String = row.get(8)?;
    Ok(RequestRecord {
        id: row.get(0)?,
        stand: row.get(1)?,
        description: row.get(2)?,
        qual: row.get(3)?,
        extra: row.get(4)?,
        priority: row.get(5)?,
        tech_id: row.get(6)?,
        tech_name: row.get(7)?,
        status_ru: request_status_ru(&status).into(),
        status,
        created_at: row.get(9)?,
        arrived_at: row.get(10)?,
        started_at: row.get(11)?,
        resolved_at: row.get(12)?,
        version: row.get(13)?,
    })
}

fn request_status_ru(status: &str) -> &'static str {
    match status {
        "waiting" => "Ожидает назначения",
        "assigned" => "Назначена",
        "enroute" => "В пути",
        "arrived" => "На месте",
        "working" => "В работе",
        "done" => "Выполнено",
        "cancelled" => "Отменена",
        _ => "Неизвестный статус",
    }
}

fn query_request(connection: &rusqlite::Connection, id: i64) -> rusqlite::Result<RequestRecord> {
    connection.query_row(
        "SELECT id,stand,description,qual,extra,priority,tech_id,tech_name,status,created_at,arrived_at,started_at,resolved_at,version FROM requests WHERE id=?1",
        [id], read_request,
    )
}
