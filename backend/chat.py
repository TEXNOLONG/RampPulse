"""Durable chat archive shared by desktop sessions."""
from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone


class ChatArchive:
    def __init__(self, path: str):
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA busy_timeout=5000")
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.lock = threading.RLock()
        with self.lock, self.connection:
            self.connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS chat_archive (
                    relay_key TEXT PRIMARY KEY,
                    room_kind TEXT NOT NULL CHECK(room_kind IN ('shift','direct')),
                    sender_id INTEGER NOT NULL,
                    sender_name TEXT NOT NULL,
                    recipient_id INTEGER,
                    body TEXT NOT NULL DEFAULT '',
                    sticker TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_chat_archive_shift ON chat_archive(room_kind, created_at);
                CREATE INDEX IF NOT EXISTS idx_chat_archive_direct ON chat_archive(sender_id, recipient_id, created_at);
                CREATE TABLE IF NOT EXISTS chat_archive_reads (
                    relay_key TEXT NOT NULL,
                    user_id INTEGER NOT NULL,
                    read_at TEXT NOT NULL,
                    PRIMARY KEY(relay_key,user_id),
                    FOREIGN KEY(relay_key) REFERENCES chat_archive(relay_key) ON DELETE CASCADE
                );
                """
            )

    def save(self, *, relay_key: str, room_kind: str, sender_id: int, sender_name: str,
             recipient_id: int | None, body: str, sticker: str | None) -> dict:
        created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with self.lock, self.connection:
            self.connection.execute(
                """INSERT OR IGNORE INTO chat_archive
                   (relay_key,room_kind,sender_id,sender_name,recipient_id,body,sticker,created_at)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (relay_key, room_kind, sender_id, sender_name, recipient_id, body, sticker, created_at),
            )
            row = self.connection.execute(
                "SELECT * FROM chat_archive WHERE relay_key=?", (relay_key,)
            ).fetchone()
        return dict(row)

    def history(self, *, room_kind: str, user_id: int, peer_id: int | None, limit: int = 100) -> list[dict]:
        if room_kind == "shift":
            predicate, params = "room_kind='shift'", (user_id, user_id, limit)
        else:
            predicate = "room_kind='direct' AND ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?))"
            params = (user_id, user_id, user_id, peer_id, peer_id, user_id, limit)
        sql = f"""SELECT m.*, CASE WHEN m.sender_id=? THEN EXISTS(
                    SELECT 1 FROM chat_archive_reads r WHERE r.relay_key=m.relay_key AND r.user_id!=m.sender_id
                ) ELSE EXISTS(
                    SELECT 1 FROM chat_archive_reads r WHERE r.relay_key=m.relay_key AND r.user_id=?
                ) END AS read
                FROM chat_archive m WHERE {predicate} ORDER BY m.rowid DESC LIMIT ?"""
        with self.lock:
            rows = self.connection.execute(sql, params).fetchall()
        return [
            {**dict(row), "room_id": 0, "from_user_id": row["sender_id"]}
            for row in reversed(rows)
        ]

    def mark_read(self, relay_key: str, user_id: int, sender_id: int) -> bool:
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with self.lock, self.connection:
            cursor = self.connection.execute(
                """INSERT OR IGNORE INTO chat_archive_reads(relay_key,user_id,read_at)
                   SELECT relay_key,?,? FROM chat_archive
                   WHERE relay_key=? AND sender_id=? AND sender_id!=?
                     AND (room_kind='shift' OR recipient_id=?)""",
                (user_id, now, relay_key, sender_id, user_id, user_id),
            )
        return cursor.rowcount > 0
