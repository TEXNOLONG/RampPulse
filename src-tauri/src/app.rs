use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(not(target_os = "android"))]
use livekit::prelude::{
    LocalAudioTrack, LocalTrack, PlatformAudio, Room, RoomOptions, TrackSource,
};
#[cfg(not(target_os = "android"))]
use livekit::options::TrackPublishOptions;
#[cfg(not(target_os = "android"))]
use std::ffi::{CStr, CString};
#[cfg(not(target_os = "android"))]
use std::os::raw::{c_char, c_int, c_void};
use std::{
    fs,
    io::Write,
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    utils::config::Color,
    webview::{PermissionKind, PermissionResponse},
    Emitter, Manager, State, Url, WebviewUrl, WebviewWindowBuilder,
};

struct Backend(Mutex<Option<Child>>);
struct ServiceRuntime {
    port: u16,
    data_dir: PathBuf,
    remote_base: Option<String>,
}
struct DesktopLaunchState(AtomicBool);
#[cfg(not(target_os = "android"))]
struct NativeCallState(Mutex<Option<NativeCallSession>>);
#[cfg(not(target_os = "android"))]
struct NativeCallSession {
    room: Room,
    microphone: LocalAudioTrack,
    _audio: PlatformAudio,
}
struct AirportFile(PathBuf);
struct DiagnosticLog(PathBuf);
#[cfg(not(target_os = "android"))]
struct ChatDatabase(PathBuf);

#[cfg(not(target_os = "android"))]
#[repr(C)]
struct Sqlite3 {
    _private: [u8; 0],
}
#[cfg(not(target_os = "android"))]
type SqlCallback =
    unsafe extern "C" fn(*mut c_void, c_int, *mut *mut c_char, *mut *mut c_char) -> c_int;

#[cfg(not(target_os = "android"))]
#[link(name = "sqlite3", kind = "static")]
extern "C" {
    fn sqlite3_open(filename: *const c_char, db: *mut *mut Sqlite3) -> c_int;
    fn sqlite3_close(db: *mut Sqlite3) -> c_int;
    fn sqlite3_exec(
        db: *mut Sqlite3,
        sql: *const c_char,
        callback: Option<SqlCallback>,
        arg: *mut c_void,
        error: *mut *mut c_char,
    ) -> c_int;
    fn sqlite3_errmsg(db: *mut Sqlite3) -> *const c_char;
    fn sqlite3_free(pointer: *mut c_void);
}

#[cfg(not(target_os = "android"))]
struct SqlConnection(*mut Sqlite3);
#[cfg(not(target_os = "android"))]
impl Drop for SqlConnection {
    fn drop(&mut self) {
        unsafe {
            sqlite3_close(self.0);
        }
    }
}

#[cfg(not(target_os = "android"))]
fn sql_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(not(target_os = "android"))]
unsafe extern "C" fn collect_sql_row(
    context: *mut c_void,
    count: c_int,
    values: *mut *mut c_char,
    names: *mut *mut c_char,
) -> c_int {
    let rows = &mut *(context as *mut Vec<Value>);
    let mut row = serde_json::Map::new();
    for index in 0..count {
        let name = CStr::from_ptr(*names.add(index as usize))
            .to_string_lossy()
            .into_owned();
        let pointer = *values.add(index as usize);
        let value = if pointer.is_null() {
            Value::Null
        } else {
            let text = CStr::from_ptr(pointer).to_string_lossy().into_owned();
            text.parse::<i64>()
                .map(Value::from)
                .or_else(|_| text.parse::<f64>().map(Value::from))
                .unwrap_or(Value::String(text))
        };
        row.insert(name, value);
    }
    rows.push(Value::Object(row));
    0
}

#[cfg(not(target_os = "android"))]
impl ChatDatabase {
    fn connect(&self) -> Result<SqlConnection, String> {
        if let Some(parent) = self.0.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let path = CString::new(self.0.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
        let mut db = std::ptr::null_mut();
        let code = unsafe { sqlite3_open(path.as_ptr(), &mut db) };
        if code != 0 {
            return Err(if db.is_null() {
                format!("SQLite error {code}")
            } else {
                unsafe {
                    CStr::from_ptr(sqlite3_errmsg(db))
                        .to_string_lossy()
                        .into_owned()
                }
            });
        }
        let connection = SqlConnection(db);
        self.exec(&connection, "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS chat_rooms(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, name TEXT NOT NULL, dm_key TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS chat_members(room_id INTEGER NOT NULL, user_id INTEGER NOT NULL, display_name TEXT NOT NULL, PRIMARY KEY(room_id,user_id), FOREIGN KEY(room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, sender_id INTEGER NOT NULL, sender_name TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', sticker TEXT, relay_key TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE);
            CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id,id DESC);
            CREATE TABLE IF NOT EXISTS chat_reads(message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(message_id,user_id));")?;
        Ok(connection)
    }
    fn exec(&self, connection: &SqlConnection, sql: &str) -> Result<(), String> {
        let sql = CString::new(sql).map_err(|e| e.to_string())?;
        let mut error = std::ptr::null_mut();
        let code = unsafe {
            sqlite3_exec(
                connection.0,
                sql.as_ptr(),
                None,
                std::ptr::null_mut(),
                &mut error,
            )
        };
        if code == 0 {
            return Ok(());
        }
        let message = if error.is_null() {
            unsafe {
                CStr::from_ptr(sqlite3_errmsg(connection.0))
                    .to_string_lossy()
                    .into_owned()
            }
        } else {
            unsafe {
                let value = CStr::from_ptr(error).to_string_lossy().into_owned();
                sqlite3_free(error as *mut c_void);
                value
            }
        };
        Err(message)
    }
    fn query(&self, connection: &SqlConnection, sql: &str) -> Result<Vec<Value>, String> {
        let sql = CString::new(sql).map_err(|e| e.to_string())?;
        let mut rows = Vec::<Value>::new();
        let mut error = std::ptr::null_mut();
        let code = unsafe {
            sqlite3_exec(
                connection.0,
                sql.as_ptr(),
                Some(collect_sql_row),
                &mut rows as *mut _ as *mut c_void,
                &mut error,
            )
        };
        if code == 0 {
            return Ok(rows);
        }
        let message = if error.is_null() {
            unsafe {
                CStr::from_ptr(sqlite3_errmsg(connection.0))
                    .to_string_lossy()
                    .into_owned()
            }
        } else {
            unsafe {
                let value = CStr::from_ptr(error).to_string_lossy().into_owned();
                sqlite3_free(error as *mut c_void);
                value
            }
        };
        Err(message)
    }
}

#[cfg(not(target_os = "android"))]
fn ensure_room_member(
    db: &ChatDatabase,
    connection: &SqlConnection,
    room_id: i64,
    user_id: i64,
) -> Result<(), String> {
    let rows = db.query(connection, &format!("SELECT 1 AS ok FROM chat_members WHERE room_id={room_id} AND user_id={user_id} LIMIT 1"))?;
    if rows.is_empty() {
        Err("Нет доступа к этому чату".into())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn chat_initialize(
    user_id: i64,
    user_name: String,
    database: State<'_, ChatDatabase>,
) -> Result<Vec<Value>, String> {
    let connection = database.connect()?;
    database.exec(&connection, "INSERT OR IGNORE INTO chat_rooms(id,kind,name,created_at) VALUES(1,'shift','Общий канал смены',CURRENT_TIMESTAMP)")?;
    database.exec(&connection, &format!("INSERT INTO chat_members(room_id,user_id,display_name) VALUES(1,{user_id},{}) ON CONFLICT(room_id,user_id) DO UPDATE SET display_name=excluded.display_name", sql_quote(&user_name)))?;
    database.query(&connection, &format!("SELECT r.id,r.kind,r.name,COALESCE((SELECT cm.display_name FROM chat_members cm WHERE cm.room_id=r.id AND cm.user_id!={user_id} LIMIT 1),r.name) AS peer_name,(SELECT cm.user_id FROM chat_members cm WHERE cm.room_id=r.id AND cm.user_id!={user_id} LIMIT 1) AS peer_id,(SELECT COUNT(*) FROM messages m WHERE m.room_id=r.id AND m.sender_id!={user_id} AND NOT EXISTS(SELECT 1 FROM chat_reads cr WHERE cr.message_id=m.id AND cr.user_id={user_id})) AS unread FROM chat_rooms r JOIN chat_members mine ON mine.room_id=r.id WHERE mine.user_id={user_id} ORDER BY r.id=1 DESC,r.id DESC"))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn chat_create_dm(
    user_id: i64,
    peer_id: i64,
    user_name: String,
    peer_name: String,
    database: State<'_, ChatDatabase>,
) -> Result<Value, String> {
    if user_id == peer_id {
        return Err("Нельзя открыть личный чат с собой".into());
    }
    let connection = database.connect()?;
    let (a, b) = if user_id < peer_id {
        (user_id, peer_id)
    } else {
        (peer_id, user_id)
    };
    let key = format!("{a}:{b}");
    database.exec(
        &connection,
        &format!(
            "INSERT OR IGNORE INTO chat_rooms(kind,name,dm_key) VALUES('direct','Личный чат',{})",
            sql_quote(&key)
        ),
    )?;
    let room = database
        .query(
            &connection,
            &format!("SELECT id FROM chat_rooms WHERE dm_key={}", sql_quote(&key)),
        )?
        .into_iter()
        .next()
        .ok_or("Не удалось создать чат")?;
    let room_id = room["id"].as_i64().ok_or("Некорректный ID комнаты")?;
    database.exec(&connection, &format!("INSERT INTO chat_members(room_id,user_id,display_name) VALUES({room_id},{user_id},{}) ON CONFLICT(room_id,user_id) DO UPDATE SET display_name=excluded.display_name; INSERT INTO chat_members(room_id,user_id,display_name) VALUES({room_id},{peer_id},{}) ON CONFLICT(room_id,user_id) DO UPDATE SET display_name=excluded.display_name", sql_quote(&user_name), sql_quote(&peer_name)))?;
    Ok(
        json!({"id":room_id,"kind":"direct","name":peer_name,"peer_id":peer_id,"peer_name":peer_name}),
    )
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn chat_load_messages(
    room_id: i64,
    user_id: i64,
    database: State<'_, ChatDatabase>,
) -> Result<Vec<Value>, String> {
    let connection = database.connect()?;
    ensure_room_member(&database, &connection, room_id, user_id)?;
    database.query(&connection, &format!("SELECT m.id,m.room_id,m.sender_id,m.sender_name,m.body,m.sticker,m.created_at,EXISTS(SELECT 1 FROM chat_reads r WHERE r.message_id=m.id AND r.user_id={user_id}) AS read FROM messages m WHERE m.room_id={room_id} ORDER BY m.id DESC LIMIT 100"))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn chat_send_message(
    room_id: i64,
    user_id: i64,
    sender_name: String,
    body: String,
    sticker: Option<String>,
    relay_key: String,
    app: tauri::AppHandle,
    database: State<'_, ChatDatabase>,
) -> Result<Value, String> {
    let body = body.trim();
    if body.chars().count() > 2000 {
        return Err("Сообщение не должно превышать 2000 символов".into());
    }
    let sticker = sticker.unwrap_or_default();
    if body.is_empty() && sticker.is_empty() {
        return Err("Введите сообщение или выберите стикер".into());
    }
    if sticker.len() > 48 {
        return Err("Недопустимый стикер".into());
    }
    let connection = database.connect()?;
    ensure_room_member(&database, &connection, room_id, user_id)?;
    database.exec(&connection, &format!("INSERT INTO messages(room_id,sender_id,sender_name,body,sticker,relay_key) VALUES({room_id},{user_id},{},{},{},{})", sql_quote(&sender_name), sql_quote(body), if sticker.is_empty() {"NULL".to_string()} else {sql_quote(&sticker)}, sql_quote(&relay_key)))?;
    let message = database.query(&connection, &format!("SELECT id,room_id,sender_id,sender_name,body,sticker,created_at,0 AS read,relay_key,(SELECT kind FROM chat_rooms WHERE id=messages.room_id) AS room_kind FROM messages WHERE relay_key={}", sql_quote(&relay_key)))?.into_iter().next().ok_or("Не удалось сохранить сообщение")?;
    app.emit("chat-message", message.clone())
        .map_err(|e| e.to_string())?;
    Ok(message)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn chat_receive_message(
    room_id: i64,
    user_id: i64,
    sender_id: i64,
    sender_name: String,
    body: String,
    sticker: Option<String>,
    relay_key: String,
    notify: Option<bool>,
    app: tauri::AppHandle,
    database: State<'_, ChatDatabase>,
) -> Result<Value, String> {
    let connection = database.connect()?;
    ensure_room_member(&database, &connection, room_id, user_id)?;
    let sticker = sticker.unwrap_or_default();
    database.exec(&connection, &format!("INSERT OR IGNORE INTO messages(room_id,sender_id,sender_name,body,sticker,relay_key) VALUES({room_id},{sender_id},{},{},{},{})", sql_quote(&sender_name), sql_quote(&body), if sticker.is_empty() {"NULL".to_string()} else {sql_quote(&sticker)}, sql_quote(&relay_key)))?;
    let message = database.query(&connection, &format!("SELECT id,room_id,sender_id,sender_name,body,sticker,created_at,0 AS read,relay_key,(SELECT kind FROM chat_rooms WHERE id=messages.room_id) AS room_kind FROM messages WHERE relay_key={}", sql_quote(&relay_key)))?.into_iter().next().ok_or("Не удалось принять сообщение")?;
    if notify.unwrap_or(true) {
        app.emit("chat-message", message.clone())
            .map_err(|e| e.to_string())?;
    }
    Ok(message)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn chat_mark_read(
    room_id: i64,
    user_id: i64,
    database: State<'_, ChatDatabase>,
) -> Result<(), String> {
    let connection = database.connect()?;
    ensure_room_member(&database, &connection, room_id, user_id)?;
    database.exec(&connection, &format!("INSERT OR IGNORE INTO chat_reads(message_id,user_id) SELECT id,{user_id} FROM messages WHERE room_id={room_id} AND sender_id!={user_id}"))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn chat_mark_sent_read(
    relay_key: String,
    user_id: i64,
    database: State<'_, ChatDatabase>,
) -> Result<(), String> {
    let connection = database.connect()?;
    let message = database
        .query(
            &connection,
            &format!(
                "SELECT id FROM messages WHERE relay_key={} AND sender_id={user_id}",
                sql_quote(&relay_key)
            ),
        )?
        .into_iter()
        .next()
        .ok_or("Сообщение не найдено")?;
    let message_id = message["id"].as_i64().ok_or("Некорректный ID сообщения")?;
    database.exec(
        &connection,
        &format!(
            "INSERT OR IGNORE INTO chat_reads(message_id,user_id) VALUES({message_id},{user_id})"
        ),
    )
}

#[tauri::command]
fn call_emit_signal(signal: Value, app: tauri::AppHandle) -> Result<(), String> {
    app.emit("call-signal", signal).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn native_call_connect(
    url: String,
    token: String,
    state: State<'_, NativeCallState>,
) -> Result<(), String> {
    let audio = PlatformAudio::new()
        .map_err(|error| format!("Не удалось открыть аудиоустройства: {error}"))?;
    let (room, mut events) = Room::connect(&url, &token, RoomOptions::default())
        .await
        .map_err(|error| format!("Не удалось подключиться к голосовой комнате: {error}"))?;
    // LiveKit's room event receiver must stay alive for the whole session.
    // Keep draining it in the background so WebKit is not involved in media
    // and the native room lifecycle remains active until the room closes.
    tauri::async_runtime::spawn(async move {
        while events.recv().await.is_some() {}
    });
    let microphone = LocalAudioTrack::create_audio_track("microphone", audio.rtc_source());
    if let Err(error) = room
        .local_participant()
        .publish_track(
            LocalTrack::Audio(microphone.clone()),
            TrackPublishOptions {
                source: TrackSource::Microphone,
                ..Default::default()
            },
        )
        .await
    {
        let _ = room.close().await;
        return Err(format!("Не удалось включить микрофон: {error}"));
    }

    let previous = state
        .0
        .lock()
        .map_err(|_| "Состояние звонка повреждено".to_owned())?
        .replace(NativeCallSession {
            room,
            microphone,
            _audio: audio,
        });
    if let Some(previous) = previous {
        let _ = previous.room.close().await;
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn native_call_disconnect(state: State<'_, NativeCallState>) -> Result<(), String> {
    let session = state
        .0
        .lock()
        .map_err(|_| "Состояние звонка повреждено".to_owned())?
        .take();
    if let Some(session) = session {
        session
            .room
            .close()
            .await
            .map_err(|error| format!("Не удалось завершить звонок: {error}"))?;
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn native_call_set_muted(muted: bool, state: State<'_, NativeCallState>) -> Result<(), String> {
    let guard = state
        .0
        .lock()
        .map_err(|_| "Состояние звонка повреждено".to_owned())?;
    let session = guard
        .as_ref()
        .ok_or_else(|| "Голосовая комната не подключена".to_owned())?;
    if muted {
        session.microphone.mute();
    } else {
        session.microphone.unmute();
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    startup_view: String,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            startup_view: "2d".into(),
        }
    }
}

#[tauri::command]
fn get_preferences(app: tauri::AppHandle) -> Result<Preferences, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("preferences.json");
    let contents = fs::read_to_string(path).unwrap_or_default();
    let mut preferences: Preferences = serde_json::from_str(&contents).unwrap_or_default();
    if preferences.startup_view != "2d" && preferences.startup_view != "3d" {
        preferences.startup_view = "2d".into();
    }
    Ok(preferences)
}

#[tauri::command]
fn set_startup_view(app: tauri::AppHandle, startup_view: String) -> Result<(), String> {
    if startup_view != "2d" && startup_view != "3d" {
        return Err("Недопустимый режим карты".into());
    }
    let directory = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join("preferences.json");
    fs::write(
        path,
        serde_json::to_vec_pretty(&Preferences { startup_view }).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_airport_data(
    _file: State<'_, AirportFile>,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    let contents = include_str!("../../data/airport_sheremetyevo.json").to_owned();
    #[cfg(not(target_os = "android"))]
    let contents = fs::read_to_string(&_file.0)
        .map_err(|e| format!("Не удалось прочитать карту аэропорта: {e}"))?;
    let mut airport: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Повреждён файл карты аэропорта: {e}"))?;
    let nodes = airport["nodes"]
        .as_array()
        .ok_or("В схеме аэропорта отсутствуют узлы")?;
    let coordinates: std::collections::HashMap<String, (f64, f64)> = nodes
        .iter()
        .filter_map(|node| {
            Some((
                node["id"].as_str()?.to_owned(),
                (node["x"].as_f64()?, node["y"].as_f64()?),
            ))
        })
        .collect();
    let edges = airport["edges"]
        .as_array_mut()
        .ok_or("В схеме аэропорта отсутствуют дорожки")?;
    for edge in edges {
        let a = edge["a"].as_str().and_then(|id| coordinates.get(id));
        let b = edge["b"].as_str().and_then(|id| coordinates.get(id));
        let length = edge["length"]
            .as_f64()
            .or_else(|| a.zip(b).map(|(a, b)| (a.0 - b.0).hypot(a.1 - b.1)));
        if let Some(length) = length {
            edge["length"] = serde_json::json!((length * 10.0).round() / 10.0);
        }
        if edge.get("blocked").is_none() {
            edge["blocked"] = serde_json::Value::Bool(false);
        }
    }
    Ok(airport)
}

fn project_root(app: &tauri::App) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        if root.join("data/airport_sheremetyevo.json").is_file()
            && root.join("frontend/index.html").is_file()
        {
            return Ok(root.canonicalize().unwrap_or(root));
        }
    }

    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    for candidate in [resources.clone(), resources.join("ramppulse")] {
        if candidate.join("data/airport_sheremetyevo.json").is_file()
            && candidate.join("frontend/index.html").is_file()
        {
            return Ok(candidate);
        }
    }
    Err(format!(
        "RampPulse resources are missing from {}",
        resources.display()
    ))
}

fn free_port(preferred: Option<u16>) -> Result<u16, String> {
    if let Some(port) = preferred {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .map_err(|e| format!("Could not reserve a local port: {e}"))
}

fn configured_server_url() -> Option<String> {
    let url = option_env!("RAMPULSE_SERVER_URL")?
        .trim()
        .trim_end_matches('/')
        .to_string();
    if url.starts_with("https://") && url.len() > "https://".len() {
        Some(url)
    } else {
        None
    }
}

fn is_trusted_app_origin(url: &Url, remote_origin: Option<&str>) -> bool {
    let local_app = url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"));
    let tauri_app = matches!(url.as_str(), "http://tauri.localhost/" | "https://tauri.localhost/" | "tauri://localhost/")
        || matches!(url.host_str(), Some("tauri.localhost"))
            && matches!(url.scheme(), "http" | "https");
    let trusted_remote = remote_origin
        .is_some_and(|origin| url.origin().ascii_serialization() == origin);
    local_app || tauri_app || trusted_remote
}

fn spawn_backend(root: &Path, db_path: &Path, port: u16) -> Result<Child, String> {
    let binary_name = if cfg!(windows) {
        "ramppulse-server.exe"
    } else {
        "ramppulse-server"
    };
    let binary = [
        root.join("server").join(binary_name),
        root.join("src-tauri/resources/server").join(binary_name),
    ]
    .into_iter()
    .find(|path| path.is_file())
    .ok_or_else(|| format!("В сборку RampPulse не вложен Rust-сервис ({binary_name})"))?;
    let airport_file = root.join("data").join("airport_sheremetyevo.json");
    // Dev checkout serves the React build from web/dist; installed bundles ship it as `frontend/`.
    let frontend_dir = if root.join("web/dist/index.html").is_file() {
        root.join("web/dist")
    } else {
        root.join("frontend")
    };
    let attachments_dir = db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("chat-attachments");
    let service_log = db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("service.log");
    std::fs::create_dir_all(&attachments_dir)
        .map_err(|e| format!("Не удалось подготовить хранилище чата: {e}"))?;
    let log_file = fs::File::create(&service_log).map_err(|e| {
        format!(
            "Не удалось открыть журнал сервиса {}: {e}",
            service_log.display()
        )
    })?;
    let mut command = Command::new(binary);
    let child = command
        .current_dir(root)
        .env("HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("AIRPORT_FILE", airport_file)
        .env("FRONTEND_DIR", frontend_dir)
        .env("DB_FILE", db_path)
        .env("CHAT_STORAGE_DIR", attachments_dir)
        .env("DEMO_MODE", "1")
        .env("COOKIE_SECURE", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log_file))
        .spawn()
        .map_err(|e| format!("Не удалось запустить Rust-сервис RampPulse: {e}"))?;
    Ok(child)
}

fn wait_for_backend(port: u16, data_dir: &Path) -> Result<(), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    let service_log = data_dir.join("service.log");
    let detail = fs::read_to_string(&service_log).ok().and_then(|contents| {
        contents
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .map(str::to_owned)
    });
    let message = match detail {
        Some(detail) => format!(
            "Сервис не запустился: {detail}. Журнал: {}",
            service_log.display()
        ),
        None => format!(
            "Сервис не ответил за 30 секунд. Журнал: {}",
            service_log.display()
        ),
    };
    Err(message)
}

#[tauri::command]
fn consume_desktop_startup(state: State<'_, DesktopLaunchState>) -> bool {
    state.0.swap(false, Ordering::SeqCst)
}

fn append_diagnostic(path: &Path, message: &str) -> Result<(), String> {
    if fs::metadata(path).map(|metadata| metadata.len() > 512 * 1024).unwrap_or(false) {
        fs::write(path, "RampPulse diagnostic log rotated\n").map_err(|error| error.to_string())?;
    }
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let clean: String = message
        .chars()
        .filter(|character| !character.is_control() || *character == '\t')
        .take(1600)
        .collect();
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{timestamp} {clean}").map_err(|error| error.to_string())
}

#[tauri::command]
fn write_client_diagnostic(message: String, log: State<'_, DiagnosticLog>) -> Result<(), String> {
    append_diagnostic(&log.0, &message)
}

#[tauri::command]
fn read_client_diagnostics(log: State<'_, DiagnosticLog>) -> Result<String, String> {
    fs::read_to_string(&log.0).map_err(|error| error.to_string())
}

#[tauri::command]
fn realtime_protocol_version() -> u16 {
    ramppulse_core::REALTIME_PROTOCOL_VERSION
}

/// Integer scale of the focused monitor on Hyprland (`hyprctl monitors -j`).
#[cfg(target_os = "linux")]
fn detect_monitor_scale() -> Option<String> {
    let output = std::process::Command::new("hyprctl")
        .args(["monitors", "-j"])
        .output()
        .ok()?;
    let monitors: Value = serde_json::from_slice(&output.stdout).ok()?;
    let list = monitors.as_array()?;
    let monitor = list
        .iter()
        .find(|m| m.get("focused").and_then(Value::as_bool) == Some(true))
        .or_else(|| list.first())?;
    let scale = monitor.get("scale")?.as_f64()?;
    Some(((scale.round() as i64).max(1)).to_string())
}

pub fn run() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        // Prefer XWayland for this WebKitGTK app on Wayland desktops. Some
        // WebKitGTK/Wayland combinations fail during page load with GDK
        // protocol errors. Keep an app-specific override for troubleshooting.
        let backend = std::env::var("AIRPORT_CRM_GDK_BACKEND").unwrap_or_else(|_| "x11".into());
        if backend == "x11" {
            // Desktop environments such as Omarchy export a global GDK_SCALE (e.g. 2)
            // that XWayland clients inherit even on a 1x monitor, which renders the
            // whole UI at double size. Derive the scale from the real monitor instead.
            let scale = std::env::var("RAMPPULSE_SCALE")
                .ok()
                .or_else(detect_monitor_scale)
                .unwrap_or_else(|| "1".into());
            std::env::set_var("GDK_SCALE", scale);
            std::env::remove_var("GDK_DPI_SCALE");
        }
        std::env::set_var("GDK_BACKEND", backend);
    }
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DMABUF_RENDERER_FORCE_SHM").is_none() {
        // Avoid broken GBM imports on some WebKitGTK/GPU combinations while
        // keeping WebKit's shared-memory renderer transport enabled.
        std::env::set_var("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1");
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_preferences,
            set_startup_view,
            consume_desktop_startup,
            realtime_protocol_version,
            load_airport_data,
            write_client_diagnostic,
            read_client_diagnostics,
            #[cfg(not(target_os = "android"))]
            chat_initialize,
            #[cfg(not(target_os = "android"))]
            chat_create_dm,
            #[cfg(not(target_os = "android"))]
            chat_load_messages,
            #[cfg(not(target_os = "android"))]
            chat_send_message,
            #[cfg(not(target_os = "android"))]
            chat_receive_message,
            #[cfg(not(target_os = "android"))]
            chat_mark_read,
            #[cfg(not(target_os = "android"))]
            chat_mark_sent_read,
            call_emit_signal,
            #[cfg(not(target_os = "android"))]
            native_call_connect,
            #[cfg(not(target_os = "android"))]
            native_call_disconnect,
            #[cfg(not(target_os = "android"))]
            native_call_set_muted,
            #[cfg(not(target_os = "android"))]
            open_secondary_session
        ])
        .setup(|app| {
            #[cfg(target_os = "android")]
            let root = PathBuf::new();
            #[cfg(all(not(target_os = "android"), not(feature = "client-only")))]
            let root = project_root(app).map_err(std::io::Error::other)?;
            #[cfg(any(target_os = "android", feature = "client-only"))]
            let root = PathBuf::new();
            app.manage(AirportFile(
                root.join("data").join("airport_sheremetyevo.json"),
            ));
            let data_dir = app.path().app_data_dir().map_err(std::io::Error::other)?;
            std::fs::create_dir_all(&data_dir)?;
            let diagnostic_path = data_dir.join("diagnostics.log");
            app.manage(DiagnosticLog(diagnostic_path.clone()));
            let _ = append_diagnostic(&diagnostic_path, "application setup started");
            let db_path = data_dir.join("dispatch.db");
            #[cfg(not(target_os = "android"))]
            app.manage(NativeCallState(Mutex::new(None)));
            #[cfg(all(not(target_os = "android"), not(feature = "client-only")))]
            {
                let chat_database = ChatDatabase(data_dir.join("chat.sqlite"));
                chat_database.connect().map_err(std::io::Error::other)?;
                app.manage(chat_database);
            }
            let remote_base = configured_server_url();
            let trusted_remote_origin = remote_base
                .as_deref()
                .and_then(|base| Url::parse(base).ok())
                .map(|url| url.origin().ascii_serialization());
            let port_file = data_dir.join("service-port");
            let port = if remote_base.is_some() {
                0
            } else {
                let previous_port = std::fs::read_to_string(&port_file)
                    .ok()
                    .and_then(|value| value.trim().parse::<u16>().ok());
                let port = free_port(previous_port).map_err(std::io::Error::other)?;
                std::fs::write(port_file, port.to_string())?;
                port
            };
            app.manage(Backend(Mutex::new(None)));
            app.manage(ServiceRuntime {
                port,
                data_dir: data_dir.clone(),
                remote_base: remote_base.clone(),
            });
            app.manage(DesktopLaunchState(AtomicBool::new(true)));
            let profile = data_dir
                .join("webview-profiles")
                .join("main");
            std::fs::create_dir_all(&profile)?;
            let splash_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or_else(|| std::io::Error::other("Окно запуска не задано в tauri.conf.json"))?;
            let window = WebviewWindowBuilder::from_config(app, splash_config)
                .map_err(std::io::Error::other)?
                .on_permission_request(move |webview, kind| {
                    let trusted = webview.url().ok().is_some_and(|url| {
                        is_trusted_app_origin(&url, trusted_remote_origin.as_deref())
                    });
                    match kind {
                        PermissionKind::Geolocation if trusted => PermissionResponse::Default,
                        PermissionKind::Geolocation => PermissionResponse::Deny,
                        PermissionKind::Microphone if trusted => PermissionResponse::Allow,
                        PermissionKind::Microphone => PermissionResponse::Deny,
                        _ => PermissionResponse::Default,
                    }
                })
                .data_directory(profile)
                .build()?;
            let actual_url = window.url().map(|url| url.to_string()).unwrap_or_else(|_| "unknown".into());
            let _ = append_diagnostic(&diagnostic_path, &format!("main window created url={actual_url}"));

            #[cfg(feature = "client-only")]
            {
                let _ = append_diagnostic(&diagnostic_path, "client-only build: skipping local backend startup");
                // Client-only releases must always leave the native splash and load the UI.
                // Some existing installations may retain the base config's splash URL.
                if actual_url.ends_with("/splash.html") || actual_url.ends_with("splash.html") {
                    let ui_url = Url::parse("http://tauri.localhost/index.html")
                        .map_err(std::io::Error::other)?;
                    window.navigate(ui_url).map_err(std::io::Error::other)?;
                    let _ = append_diagnostic(&diagnostic_path, "client-only splash detected; navigating to application UI");
                }
                let _ = window.set_resizable(true);
                return Ok(());
            }

            if let Some(remote_base) = remote_base {
                // Android's initial WebView URL is set to the VPS by the generated
                // platform config. Navigating again from the setup hook can race
                // with the initial splash page and leave the native splash visible.
                #[cfg(not(target_os = "android"))]
                {
                    let url = format!("{remote_base}/login");
                    let url = url.parse().map_err(|e| {
                        std::io::Error::other(format!("Некорректный URL сервера: {e}"))
                    })?;
                    window.navigate(url).map_err(std::io::Error::other)?;
                }
                #[cfg(target_os = "android")]
                let _ = remote_base;
                let _ = window.set_resizable(true);
                #[cfg(not(target_os = "android"))]
                let _ = window.set_fullscreen(true);
                return Ok(());
            }

            let app_handle = app.handle().clone();
            thread::spawn(move || {
                if app_handle.webview_windows().is_empty() {
                    return;
                }
                let _ = app_handle.emit("service-status", json!({"stage": 1}));
                let child = match spawn_backend(&root, &db_path, port) {
                    Ok(child) => child,
                    Err(error) => {
                        let _ = app_handle.emit("service-error", json!({"message": error}));
                        return;
                    }
                };
                let _ = app_handle.emit("service-status", json!({"stage": 2}));
                if let Err(error) =
                    wait_for_backend(port, db_path.parent().unwrap_or_else(|| Path::new(".")))
                {
                    let mut child = child;
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = app_handle.emit("service-error", json!({"message": error}));
                    return;
                }
                if app_handle.webview_windows().is_empty() {
                    let mut child = child;
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
                if let Some(backend) = app_handle.try_state::<Backend>() {
                    if let Ok(mut stored) = backend.0.lock() {
                        *stored = Some(child);
                    }
                }
                let _ = app_handle.emit("service-status", json!({"stage": 3}));
                if let Some(window) = app_handle.get_webview_window("main") {
                    let url = format!("http://127.0.0.1:{port}/");
                    if let Ok(url) = url.parse() {
                        let _ = window.navigate(url);
                    }
                    let _ = window.set_resizable(true);
                    #[cfg(not(target_os = "android"))]
                    let _ = window.set_fullscreen(true);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Keep the shared service alive while another role window is open.
                let has_other_window = window
                    .app_handle()
                    .webview_windows()
                    .keys()
                    .any(|label| label != window.label());
                if has_other_window {
                    return;
                }
                if let Some(backend) = window.app_handle().try_state::<Backend>() {
                    if let Ok(mut child) = backend.0.lock() {
                        if let Some(mut child) = child.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run RampPulse desktop application");
}

#[tauri::command]
#[cfg(not(target_os = "android"))]
fn open_secondary_session(
    app: tauri::AppHandle,
    runtime: State<'_, ServiceRuntime>,
) -> Result<(), String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let label = format!("session-{stamp}");
    let profile = runtime.data_dir.join("webview-profiles").join(&label);
    fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let url = if let Some(base) = &runtime.remote_base {
        format!("{base}/login")
    } else {
        format!("http://127.0.0.1:{}/login", runtime.port)
    };
    let trusted_remote_origin = runtime
        .remote_base
        .as_deref()
        .and_then(|base| Url::parse(base).ok())
        .map(|url| url.origin().ascii_serialization());
    WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::External(
            url.parse()
                .map_err(|e| format!("Invalid service URL: {e}"))?,
        ),
    )
    .title("RampPulse · Новая сессия")
    .inner_size(1240.0, 820.0)
    .min_inner_size(1000.0, 680.0)
    .decorations(false)
    .background_color(Color(10, 14, 23, 255))
    .resizable(true)
    .maximized(true)
    .on_permission_request(move |webview, kind| {
        let trusted = webview.url().ok().is_some_and(|url| {
            is_trusted_app_origin(&url, trusted_remote_origin.as_deref())
        });
        match kind {
            PermissionKind::Geolocation if trusted => PermissionResponse::Default,
            PermissionKind::Geolocation => PermissionResponse::Deny,
            PermissionKind::Microphone if trusted => PermissionResponse::Allow,
            PermissionKind::Microphone => PermissionResponse::Deny,
            _ => PermissionResponse::Default,
        }
    })
    .data_directory(profile)
    .build()
    .map(|_| ())
    .map_err(|e| format!("Не удалось открыть новую сессию: {e}"))
}
