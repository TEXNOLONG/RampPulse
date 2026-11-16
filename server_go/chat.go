package main

import (
	"database/sql"
	"strings"
	"sync"
	"time"
)

type ChatMessage struct {
	ID             int64   `json:"id,omitempty"`
	RelayKey       string  `json:"relay_key"`
	RoomKind       string  `json:"room_kind"`
	SenderID       int64   `json:"sender_id"`
	FromUserID     int64   `json:"from_user_id"`
	SenderName     string  `json:"sender_name"`
	SenderUsername string  `json:"sender_username"`
	RecipientID    *int64  `json:"recipient_id,omitempty"`
	Body           string  `json:"body"`
	Sticker        *string `json:"sticker,omitempty"`
	CreatedAt      string  `json:"created_at"`
	MediaURL       *string `json:"media_url,omitempty"`
	MediaType      *string `json:"media_type,omitempty"`
	MediaName      *string `json:"media_name,omitempty"`
	Duration       *int    `json:"duration,omitempty"`
	Read           int     `json:"read"`
	RoomID         int     `json:"room_id"`
}

type ChatArchive struct {
	db   *sql.DB
	lock sync.RWMutex
}

func NewChatArchive(db *sql.DB) (*ChatArchive, error) {
	c := &ChatArchive{db: db}
	if err := c.initSchema(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *ChatArchive) initSchema() error {
	c.lock.Lock()
	defer c.lock.Unlock()

	schema := `
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
	`
	if _, err := c.db.Exec(schema); err != nil {
		return err
	}

	cols := []string{"media_url", "media_type", "media_name", "duration", "sender_username"}
	for _, col := range cols {
		c.db.Exec("ALTER TABLE chat_archive ADD COLUMN " + col + " TEXT")
	}
	return nil
}

func (c *ChatArchive) Save(msg *ChatMessage) (*ChatMessage, error) {
	c.lock.Lock()
	defer c.lock.Unlock()

	if msg.CreatedAt == "" {
		msg.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	}

	query := `
		INSERT OR IGNORE INTO chat_archive
		(relay_key, room_kind, sender_id, sender_name, recipient_id, body, sticker, media_url, media_type, media_name, duration, sender_username, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	_, err := c.db.Exec(query,
		msg.RelayKey, msg.RoomKind, msg.SenderID, msg.SenderName, msg.RecipientID,
		msg.Body, msg.Sticker, msg.MediaURL, msg.MediaType, msg.MediaName, msg.Duration,
		msg.SenderUsername, msg.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	msg.FromUserID = msg.SenderID
	return msg, nil
}

func (c *ChatArchive) History(roomKind string, userID int64, peerID *int64, limit int) ([]ChatMessage, error) {
	c.lock.RLock()
	defer c.lock.RUnlock()

	if limit <= 0 {
		limit = 100
	}

	var sqlQuery string
	var params []any

	if roomKind == "shift" {
		sqlQuery = `
			SELECT m.rowid, m.relay_key, m.room_kind, m.sender_id, m.sender_name, m.recipient_id, 
			       m.body, m.sticker, m.media_url, m.media_type, m.media_name, m.duration, m.sender_username, m.created_at,
			       CASE WHEN m.sender_id = ? THEN EXISTS(
			           SELECT 1 FROM chat_archive_reads r WHERE r.relay_key = m.relay_key AND r.user_id != m.sender_id
			       ) ELSE EXISTS(
			           SELECT 1 FROM chat_archive_reads r WHERE r.relay_key = m.relay_key AND r.user_id = ?
			       ) END AS is_read
			FROM chat_archive m
			WHERE m.room_kind = 'shift'
			ORDER BY m.rowid DESC LIMIT ?`
		params = []any{userID, userID, limit}
	} else {
		pid := int64(0)
		if peerID != nil {
			pid = *peerID
		}
		sqlQuery = `
			SELECT m.rowid, m.relay_key, m.room_kind, m.sender_id, m.sender_name, m.recipient_id, 
			       m.body, m.sticker, m.media_url, m.media_type, m.media_name, m.duration, m.sender_username, m.created_at,
			       CASE WHEN m.sender_id = ? THEN EXISTS(
			           SELECT 1 FROM chat_archive_reads r WHERE r.relay_key = m.relay_key AND r.user_id != m.sender_id
			       ) ELSE EXISTS(
			           SELECT 1 FROM chat_archive_reads r WHERE r.relay_key = m.relay_key AND r.user_id = ?
			       ) END AS is_read
			FROM chat_archive m
			WHERE m.room_kind = 'direct' AND ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
			ORDER BY m.rowid DESC LIMIT ?`
		params = []any{userID, userID, userID, pid, pid, userID, limit}
	}

	rows, err := c.db.Query(sqlQuery, params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var descList []ChatMessage
	for rows.Next() {
		var (
			rowID                                         int64
			relayKey, rKind, sName, body, createdAt       string
			sID                                           int64
			recID                                         sql.NullInt64
			sticker, mURL, mType, mName, sUname           sql.NullString
			dur                                           sql.NullInt64
			isRead                                        bool
		)

		err := rows.Scan(
			&rowID, &relayKey, &rKind, &sID, &sName, &recID,
			&body, &sticker, &mURL, &mType, &mName, &dur, &sUname, &createdAt,
			&isRead,
		)
		if err != nil {
			continue
		}

		msg := ChatMessage{
			ID:             rowID,
			RelayKey:       relayKey,
			RoomKind:       rKind,
			SenderID:       sID,
			FromUserID:     sID,
			SenderName:     sName,
			Body:           body,
			CreatedAt:      createdAt,
			SenderUsername: sUname.String,
			Read:           0,
			RoomID:         0,
		}
		if isRead {
			msg.Read = 1
		}
		if recID.Valid {
			v := recID.Int64
			msg.RecipientID = &v
		}
		if sticker.Valid {
			v := sticker.String
			msg.Sticker = &v
		}
		if mURL.Valid {
			v := mURL.String
			msg.MediaURL = &v
		}
		if mType.Valid {
			v := mType.String
			msg.MediaType = &v
		}
		if mName.Valid {
			v := mName.String
			msg.MediaName = &v
		}
		if dur.Valid {
			v := int(dur.Int64)
			msg.Duration = &v
		}

		descList = append(descList, msg)
	}

	// Обратный порядок (хронологический)
	ascList := make([]ChatMessage, len(descList))
	for i, j := 0, len(descList)-1; j >= 0; i, j = i+1, j-1 {
		ascList[i] = descList[j]
	}
	return ascList, nil
}

func (c *ChatArchive) MarkRead(relayKey string, userID, senderID int64) bool {
	c.lock.Lock()
	defer c.lock.Unlock()

	nowISO := time.Now().UTC().Format(time.RFC3339)
	res, err := c.db.Exec(`
		INSERT OR IGNORE INTO chat_archive_reads(relay_key, user_id, read_at)
		SELECT relay_key, ?, ? FROM chat_archive
		WHERE relay_key = ? AND sender_id = ? AND sender_id != ?
		  AND (room_kind = 'shift' OR recipient_id = ?)`,
		userID, nowISO, relayKey, senderID, userID, userID,
	)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	return n > 0
}

func (c *ChatArchive) Search(query string, userID int64, roomKind *string, peerID *int64, limit int) ([]ChatMessage, error) {
	c.lock.RLock()
	defer c.lock.RUnlock()

	if limit <= 0 {
		limit = 50
	}

	term := "%" + strings.TrimSpace(strings.ToLower(query)) + "%"
	conditions := []string{
		"(LOWER(body) LIKE ? OR LOWER(COALESCE(media_name, '')) LIKE ? OR LOWER(sender_name) LIKE ? OR LOWER(COALESCE(sender_username, '')) LIKE ?)",
	}
	params := []any{term, term, term, term}

	if roomKind != nil && *roomKind == "shift" {
		conditions = append(conditions, "room_kind = 'shift'")
	} else if roomKind != nil && *roomKind == "direct" {
		if peerID != nil {
			conditions = append(conditions, "room_kind = 'direct' AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))")
			params = append(params, userID, *peerID, *peerID, userID)
		} else {
			conditions = append(conditions, "room_kind = 'direct' AND (sender_id = ? OR recipient_id = ?)")
			params = append(params, userID, userID)
		}
	} else {
		conditions = append(conditions, "(room_kind = 'shift' OR (room_kind = 'direct' AND (sender_id = ? OR recipient_id = ?)))")
		params = append(params, userID, userID)
	}

	params = append(params, limit)
	sqlQuery := `
		SELECT rowid, relay_key, room_kind, sender_id, sender_name, recipient_id, body, sticker, media_url, media_type, media_name, duration, sender_username, created_at 
		FROM chat_archive 
		WHERE ` + strings.Join(conditions, " AND ") + ` 
		ORDER BY rowid DESC LIMIT ?`

	rows, err := c.db.Query(sqlQuery, params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []ChatMessage
	for rows.Next() {
		var (
			rowID                                   int64
			relayKey, rKind, sName, body, createdAt string
			sID                                     int64
			recID                                   sql.NullInt64
			sticker, mURL, mType, mName, sUname     sql.NullString
			dur                                     sql.NullInt64
		)
		err := rows.Scan(
			&rowID, &relayKey, &rKind, &sID, &sName, &recID,
			&body, &sticker, &mURL, &mType, &mName, &dur, &sUname, &createdAt,
		)
		if err != nil {
			continue
		}
		msg := ChatMessage{
			ID:             rowID,
			RelayKey:       relayKey,
			RoomKind:       rKind,
			SenderID:       sID,
			FromUserID:     sID,
			SenderName:     sName,
			Body:           body,
			CreatedAt:      createdAt,
			SenderUsername: sUname.String,
		}
		if recID.Valid {
			v := recID.Int64
			msg.RecipientID = &v
		}
		if sticker.Valid {
			v := sticker.String
			msg.Sticker = &v
		}
		if mURL.Valid {
			v := mURL.String
			msg.MediaURL = &v
		}
		if mType.Valid {
			v := mType.String
			msg.MediaType = &v
		}
		if mName.Valid {
			v := mName.String
			msg.MediaName = &v
		}
		if dur.Valid {
			v := int(dur.Int64)
			msg.Duration = &v
		}
		list = append(list, msg)
	}
	return list, nil
}
