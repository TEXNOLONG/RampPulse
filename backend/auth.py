"""Учётные записи, регистрация инженеров и сессии.

Пароли хранятся только в виде PBKDF2-SHA256-хеша, сессии — в SQLite.
Для прототипа этого достаточно; для промышленной эксплуатации нужны
PostgreSQL, миграции, аудит и внешний identity provider.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timezone

SESSION_COOKIE = "oto_session"
SESSION_TTL_SEC = 7 * 24 * 3600
PBKDF2_ITERATIONS = 210_000
DEMO_DISPATCHER_PASSWORD = "Dispatcher2026!"
DEMO_ENGINEER_PASSWORD = "Engineer2026!"

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
USERNAME_RE = re.compile(r"^[a-zA-Z0-9_]{3,30}$")


class AuthError(ValueError):
    """Ошибка бизнес-логики аккаунтов, которую можно показать пользователю."""

    def __init__(self, message: str, code: str = "auth_error"):
        super().__init__(message)
        self.code = code


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii")


def _unb64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data.encode("ascii"))


def hash_password(password: str) -> str:
    if len(password) < 8:
        raise AuthError("Пароль должен быть не короче 8 символов", "weak_password")
    if len(password) > 200:
        raise AuthError("Пароль слишком длинный", "weak_password")
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iterations, salt, digest = stored.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        expected = _unb64(digest)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), _unb64(salt), int(iterations))
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _parse_types(value) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value]
    try:
        parsed = json.loads(value or "[]")
        return [str(v) for v in parsed] if isinstance(parsed, list) else []
    except (TypeError, ValueError):
        return []


def public_user(row) -> dict:
    uname = ""
    if "username" in row.keys() and row["username"]:
        uname = str(row["username"]).strip().lower()
    if not uname:
        uname = f"user{row['id']}"
    return {
        "id": row["id"],
        "username": uname,
        "bio": str(row["bio"]).strip() if "bio" in row.keys() and row["bio"] else "Сотрудник дежурной смены RampPulse SVO",
        "avatar_color": str(row["avatar_color"]).strip() if "avatar_color" in row.keys() and row["avatar_color"] else "#2563EB",
        "email": row["email"],
        "name": row["name"],
        "role": row["role"],
        "status": row["status"],
        "qual": row["qual"],
        "types": _parse_types(row["types"]),
        "base": row["base"],
        "tech_id": row["tech_id"],
        "created_at": row["created_at"],
        "approved_at": row["approved_at"],
        "on_shift": bool(row["on_shift"]) if "on_shift" in row.keys() else True,
    }


class AuthStore:
    def __init__(self, path: str, tech_seed_count: int = 0):
        self.path = path
        self.tech_seed_count = max(0, int(tech_seed_count))
        self.lock = threading.RLock()
        self.c = sqlite3.connect(path, check_same_thread=False)
        self.c.row_factory = sqlite3.Row
        self.c.execute("PRAGMA busy_timeout=5000")
        self.c.execute("PRAGMA foreign_keys=ON")
        self._init_schema()

    def _init_schema(self):
        with self.lock, self.c:
            self.c.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    name TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('dispatcher', 'engineer')),
                    status TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'active', 'rejected')),
                    qual TEXT,
                    types TEXT NOT NULL DEFAULT '[]',
                    base TEXT,
                    tech_id INTEGER UNIQUE,
                    speed REAL NOT NULL DEFAULT 4.0,
                    created_at TEXT NOT NULL,
                    approved_at TEXT,
                    last_login_at TEXT
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
                """
            )
            columns = {row["name"] for row in self.c.execute("PRAGMA table_info(users)")}
            if "on_shift" not in columns:
                self.c.execute("ALTER TABLE users ADD COLUMN on_shift INTEGER NOT NULL DEFAULT 1")
            if "username" not in columns:
                self.c.execute("ALTER TABLE users ADD COLUMN username TEXT")
            if "bio" not in columns:
                self.c.execute("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''")
            if "avatar_color" not in columns:
                self.c.execute("ALTER TABLE users ADD COLUMN avatar_color TEXT DEFAULT ''")
            
            # Автоматически заполнить пустые юзернеймы существующим пользователям
            rows = self.c.execute("SELECT id, email, role, name, username FROM users").fetchall()
            for r in rows:
                if not r["username"]:
                    base_name = ""
                    email_prefix = (r["email"] or "").split("@")[0].strip().lower()
                    if r["role"] == "dispatcher":
                        base_name = "orlov" if "dispatcher" in email_prefix else email_prefix
                    else:
                        base_name = email_prefix or f"user{r['id']}"
                    # Очистить от недопустимых символов
                    clean_uname = re.sub(r"[^a-zA-Z0-9_]", "_", base_name)[:30]
                    if len(clean_uname) < 3:
                        clean_uname = f"user_{r['id']}"
                    # Проверить коллизию
                    candidate = clean_uname
                    suffix = 1
                    while self.c.execute("SELECT 1 FROM users WHERE username = ? AND id != ?", (candidate, r["id"])).fetchone():
                        candidate = f"{clean_uname[:25]}_{suffix}"
                        suffix += 1
                    self.c.execute("UPDATE users SET username = ? WHERE id = ?", (candidate, r["id"]))
            self.c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL")

    # ---------- чтение ----------
    def _one(self, sql: str, params=()):
        with self.lock:
            return self.c.execute(sql, params).fetchone()

    def _all(self, sql: str, params=()):
        with self.lock:
            return self.c.execute(sql, params).fetchall()

    def get_user(self, user_id: int) -> dict | None:
        row = self._one("SELECT * FROM users WHERE id = ?", (int(user_id),))
        return public_user(row) if row else None

    def get_user_by_email(self, email: str) -> dict | None:
        row = self._one("SELECT * FROM users WHERE email = ?", (normalize_email(email),))
        return public_user(row) if row else None

    def list_pending_engineers(self) -> list[dict]:
        rows = self._all(
            "SELECT * FROM users WHERE role = 'engineer' AND status = 'pending' ORDER BY created_at, id"
        )
        return [public_user(r) for r in rows]

    def list_active_engineers(self) -> list[dict]:
        rows = self._all(
            "SELECT * FROM users WHERE role = 'engineer' AND status = 'active' ORDER BY tech_id, id"
        )
        return [public_user(r) for r in rows]

    def list_active_dispatchers(self) -> list[dict]:
        rows = self._all("SELECT * FROM users WHERE role = 'dispatcher' AND status = 'active' ORDER BY id")
        return [public_user(r) for r in rows]

    def set_engineer_shift(self, user_id: int, on_shift: bool) -> dict:
        with self.lock, self.c:
            row = self.c.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()
            if not row or row["role"] != "engineer" or row["status"] != "active":
                raise AuthError("Активный аккаунт инженера не найден", "not_found")
            self.c.execute("UPDATE users SET on_shift = ? WHERE id = ?", (int(on_shift), int(user_id)))
            row = self.c.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()
        return public_user(row)

    def has_dispatcher(self) -> bool:
        return self._one("SELECT 1 FROM users WHERE role = 'dispatcher' LIMIT 1") is not None

    def search_users(self, query: str) -> list[dict]:
        q = f"%{(query or '').strip().lower()}%"
        rows = self._all(
            """SELECT * FROM users
               WHERE status = 'active' AND (
                   LOWER(username) LIKE ? OR
                   LOWER(name) LIKE ? OR
                   LOWER(email) LIKE ? OR
                   LOWER(COALESCE(qual, '')) LIKE ?
               )
               ORDER BY (CASE WHEN role = 'dispatcher' THEN 0 ELSE 1 END), name""",
            (q, q, q, q),
        )
        return [public_user(r) for r in rows]

    def update_profile(self, user_id: int, username: str | None = None, name: str | None = None, bio: str | None = None, avatar_color: str | None = None) -> dict:
        with self.lock, self.c:
            row = self.c.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()
            if not row:
                raise AuthError("Пользователь не найден", "not_found")
            
            updates = []
            params = []
            if username is not None:
                uname = username.strip().lower()
                if uname.startswith("@"):
                    uname = uname[1:]
                if not USERNAME_RE.match(uname):
                    raise AuthError("Юзернейм должен содержать от 3 до 30 латинских букв, цифр или подчёркиваний", "invalid_username")
                existing = self.c.execute("SELECT 1 FROM users WHERE username = ? AND id != ?", (uname, int(user_id))).fetchone()
                if existing:
                    raise AuthError(f"Юзернейм @{uname} уже занят другим сотрудником", "username_taken")
                updates.append("username = ?")
                params.append(uname)

            if name is not None:
                cleaned_name = name.strip()
                if len(cleaned_name) < 2 or len(cleaned_name) > 120:
                    raise AuthError("Имя должно содержать от 2 до 120 символов", "invalid_name")
                updates.append("name = ?")
                params.append(cleaned_name)

            if bio is not None:
                updates.append("bio = ?")
                params.append(bio.strip()[:200])

            if avatar_color is not None:
                updates.append("avatar_color = ?")
                params.append(avatar_color.strip()[:30])

            if updates:
                params.append(int(user_id))
                self.c.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", params)
            
            row = self.c.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()
            return public_user(row)

    # ---------- регистрация ----------
    def register_engineer(
        self,
        name: str,
        email: str,
        password: str,
        qual: str,
        types: list[str],
        base: str,
        username: str | None = None,
    ) -> dict:
        name = (name or "").strip()
        email = normalize_email(email)
        if len(name) < 2:
            raise AuthError("Укажите имя и фамилию", "invalid_name")
        if len(name) > 120:
            raise AuthError("Слишком длинное имя", "invalid_name")
        if not EMAIL_RE.match(email):
            raise AuthError("Проверьте адрес электронной почты", "invalid_email")
        if not qual:
            raise AuthError("Выберите квалификацию", "invalid_qual")
        types = [str(t) for t in (types or []) if str(t).strip()]
        if not types:
            raise AuthError("Выберите хотя бы один тип воздушного судна", "invalid_types")
        if not base:
            raise AuthError("Выберите базу", "invalid_base")

        uname = (username or "").strip().lower()
        if uname.startswith("@"):
            uname = uname[1:]
        if not uname:
            uname = re.sub(r"[^a-zA-Z0-9_]", "_", email.split("@")[0])[:30]
        if len(uname) < 3:
            uname = f"tech_{int(time.time()) % 10000}"
        if not USERNAME_RE.match(uname):
            raise AuthError("Юзернейм должен содержать от 3 до 30 латинских букв, цифр или подчёркиваний", "invalid_username")

        password_hash = hash_password(password)
        with self.lock, self.c:
            if self.c.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
                raise AuthError("Аккаунт с таким email уже существует", "email_exists")
            if self.c.execute("SELECT 1 FROM users WHERE username = ?", (uname,)).fetchone():
                raise AuthError(f"Юзернейм @{uname} уже занят", "username_taken")
            cur = self.c.execute(
                """INSERT INTO users
                   (email, username, password_hash, name, role, status, qual, types, base, on_shift, created_at)
                   VALUES (?, ?, ?, ?, 'engineer', 'pending', ?, ?, ?, 0, ?)""",
                (email, uname, password_hash, name, qual, json.dumps(types, ensure_ascii=False), base, _now_iso()),
            )
            row = self.c.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
        return public_user(row)

    def _next_tech_id(self) -> int:
        row = self._one("SELECT COALESCE(MAX(tech_id), 0) AS m FROM users")
        return max(int(row["m"] or 0), self.tech_seed_count) + 1

    def approve_engineer(self, user_id: int) -> dict:
        with self.lock, self.c:
            row = self.c.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()
            if not row:
                raise AuthError("Заявка не найдена", "not_found")
            if row["role"] != "engineer":
                raise AuthError("Это не заявка инженера", "invalid_role")
            if row["status"] == "active":
                return public_user(row)
            if row["status"] != "pending":
                raise AuthError("Заявка уже обработана", "already_processed")
            tech_id = self._next_tech_id()
            self.c.execute(
                "UPDATE users SET status = 'active', tech_id = ?, on_shift = 0, approved_at = ? WHERE id = ?",
                (tech_id, _now_iso(), int(user_id)),
            )
            row = self.c.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()
        return public_user(row)

    def reject_engineer(self, user_id: int) -> dict:
        with self.lock, self.c:
            row = self.c.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()
            if not row:
                raise AuthError("Заявка не найдена", "not_found")
            if row["role"] != "engineer" or row["status"] != "pending":
                raise AuthError("Заявка уже обработана", "already_processed")
            self.c.execute("UPDATE users SET status = 'rejected' WHERE id = ?", (int(user_id),))
            row = self.c.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()
        return public_user(row)

    # ---------- вход и сессии ----------
    def authenticate(self, email: str, password: str) -> dict:
        email = normalize_email(email)
        row = self._one("SELECT * FROM users WHERE email = ?", (email,))
        if not row or not verify_password(password or "", row["password_hash"]):
            raise AuthError("Неверный email или пароль", "invalid_credentials")
        if row["status"] == "pending":
            raise AuthError("Заявка на регистрацию ещё не подтверждена диспетчером", "pending")
        if row["status"] != "active":
            raise AuthError("Доступ к аккаунту закрыт. Обратитесь к диспетчеру", "blocked")
        with self.lock, self.c:
            self.c.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (_now_iso(), row["id"]))
        return public_user(row)

    def create_session(self, user_id: int) -> str:
        token = secrets.token_urlsafe(36)
        now = time.time()
        with self.lock, self.c:
            self.c.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
            self.c.execute(
                "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (token, int(user_id), _now_iso(), now + SESSION_TTL_SEC),
            )
        return token

    def user_for_token(self, token: str | None) -> dict | None:
        if not token:
            return None
        row = self._one(
            """SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
               WHERE s.token = ? AND s.expires_at > ? AND u.status = 'active'""",
            (token, time.time()),
        )
        return public_user(row) if row else None

    def delete_session(self, token: str | None):
        if not token:
            return
        with self.lock, self.c:
            self.c.execute("DELETE FROM sessions WHERE token = ?", (token,))

    # ---------- служебные аккаунты ----------
    def ensure_dispatcher(self, email: str, password: str, name: str = "Диспетчер смены") -> dict:
        """Создаёт первого диспетчера для закрытого контура без демо-режима."""
        email = normalize_email(email)
        if not EMAIL_RE.match(email):
            raise AuthError("Некорректный email диспетчера", "invalid_email")
        name = (name or "Диспетчер смены").strip()
        with self.lock, self.c:
            row = self.c.execute(
                "SELECT * FROM users WHERE role = 'dispatcher' ORDER BY id LIMIT 1"
            ).fetchone()
            if row:
                return public_user(row)
            password_hash = hash_password(password)
            cur = self.c.execute(
                """INSERT INTO users
                   (email, username, password_hash, name, role, status, created_at, approved_at)
                   VALUES (?, 'orlov', ?, ?, 'dispatcher', 'active', ?, ?)""",
                (email, password_hash, name, _now_iso(), _now_iso()),
            )
            row = self.c.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
        return public_user(row)

    # ---------- демонстрационные аккаунты ----------
    def seed_demo(self, technicians: list[dict]):
        """Создаёт диспетчера и аккаунты для демо-состава смены.

        Пароли одинаковые только в демо-режиме. Для реального запуска
        аккаунты создаёт администратор, а DEMO_MODE отключается.
        """
        with self.lock, self.c:
            dispatcher = self.c.execute("SELECT 1 FROM users WHERE role = 'dispatcher' LIMIT 1").fetchone()
            if not dispatcher:
                self.c.execute(
                    """INSERT INTO users
                       (email, username, password_hash, name, role, status, created_at, approved_at)
                       VALUES (?, 'orlov', ?, ?, 'dispatcher', 'active', ?, ?)""",
                    (
                        "dispatcher@oto.ru",
                        hash_password(DEMO_DISPATCHER_PASSWORD),
                        "Орлов А. В.",
                        _now_iso(),
                        _now_iso(),
                    ),
                )

            for i, tech in enumerate(technicians, 1):
                email = f"tech{i}@oto.ru"
                uname = f"tech{i}"
                exists = self.c.execute(
                    "SELECT 1 FROM users WHERE email = ? OR tech_id = ?", (email, i)
                ).fetchone()
                if exists:
                    continue
                self.c.execute(
                    """INSERT INTO users
                       (email, username, password_hash, name, role, status, qual, types, base, tech_id, on_shift,
                        speed, created_at, approved_at)
                       VALUES (?, ?, ?, ?, 'engineer', 'active', ?, ?, ?, ?, 1, ?, ?, ?)""",
                    (
                        email,
                        uname,
                        hash_password(DEMO_ENGINEER_PASSWORD),
                        tech.get("name", f"Инженер {i}"),
                        tech.get("qual"),
                        json.dumps(tech.get("types", []), ensure_ascii=False),
                        tech.get("base"),
                        i,
                        float(tech.get("speed", 4.0)),
                        _now_iso(),
                        _now_iso(),
                    ),
                )
