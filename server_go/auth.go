package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	SessionCookieName = "oto_session"
	SessionTTLSec     = 7 * 24 * 3600
	PBKDF2Iterations  = 210000

	DemoDispatcherPassword = "Dispatcher2026!"
	DemoEngineerPassword   = "Engineer2026!"
)

var (
	emailRe    = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
	usernameRe = regexp.MustCompile(`^[a-zA-Z0-9_]{3,30}$`)
)

type PublicUser struct {
	ID          int64    `json:"id"`
	Username    string   `json:"username"`
	Bio         string   `json:"bio"`
	AvatarColor string   `json:"avatar_color"`
	Email       string   `json:"email"`
	Name        string   `json:"name"`
	Role        string   `json:"role"`
	Status      string   `json:"status"`
	Qual        string   `json:"qual"`
	Types       []string `json:"types"`
	Base        string   `json:"base"`
	TechID      *int64   `json:"tech_id"`
	CreatedAt   string   `json:"created_at"`
	ApprovedAt  *string  `json:"approved_at"`
	OnShift     bool     `json:"on_shift"`
}

type AuthStore struct {
	db   *sql.DB
	lock sync.RWMutex
}

func NewAuthStore(db *sql.DB) (*AuthStore, error) {
	s := &AuthStore{db: db}
	if err := s.initSchema(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *AuthStore) initSchema() error {
	s.lock.Lock()
	defer s.lock.Unlock()

	schema := `
	CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		email TEXT NOT NULL UNIQUE COLLATE NOCASE,
		password_hash TEXT NOT NULL,
		name TEXT NOT NULL,
		role TEXT NOT NULL CHECK (role IN ('dispatcher', 'engineer')),
		status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected')),
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
	`
	if _, err := s.db.Exec(schema); err != nil {
		return err
	}

	// Миграции колонок
	cols := make(map[string]bool)
	rows, err := s.db.Query("PRAGMA table_info(users)")
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var cid int
			var name, ctype string
			var notnull, pk int
			var dflt *string
			if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err == nil {
				cols[name] = true
			}
		}
	}

	if !cols["on_shift"] {
		s.db.Exec("ALTER TABLE users ADD COLUMN on_shift INTEGER NOT NULL DEFAULT 1")
	}
	if !cols["username"] {
		s.db.Exec("ALTER TABLE users ADD COLUMN username TEXT")
	}
	if !cols["bio"] {
		s.db.Exec("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''")
	}
	if !cols["avatar_color"] {
		s.db.Exec("ALTER TABLE users ADD COLUMN avatar_color TEXT DEFAULT ''")
	}

	// Заполнение юзернеймов по умолчанию
	uRows, err := s.db.Query("SELECT id, email, role, name, username FROM users")
	if err == nil {
		type uFix struct {
			id       int64
			email    string
			role     string
			username sql.NullString
		}
		var toFix []uFix
		for uRows.Next() {
			var u uFix
			var nm string
			if err := uRows.Scan(&u.id, &u.email, &u.role, &nm, &u.username); err == nil {
				if !u.username.Valid || strings.TrimSpace(u.username.String) == "" {
					toFix = append(toFix, u)
				}
			}
		}
		uRows.Close()

		for _, item := range toFix {
			baseName := strings.Split(item.email, "@")[0]
			if item.role == "dispatcher" && strings.Contains(baseName, "dispatcher") {
				baseName = "orlov"
			}
			reg := regexp.MustCompile(`[^a-zA-Z0-9_]`)
			cleanUname := reg.ReplaceAllString(baseName, "_")
			if len(cleanUname) > 30 {
				cleanUname = cleanUname[:30]
			}
			if len(cleanUname) < 3 {
				cleanUname = fmt.Sprintf("user_%d", item.id)
			}

			candidate := cleanUname
			suffix := 1
			for {
				var count int
				s.db.QueryRow("SELECT COUNT(1) FROM users WHERE username = ? AND id != ?", candidate, item.id).Scan(&count)
				if count == 0 {
					break
				}
				prefix := cleanUname
				if len(prefix) > 25 {
					prefix = prefix[:25]
				}
				candidate = fmt.Sprintf("%s_%d", prefix, suffix)
				suffix++
			}
			s.db.Exec("UPDATE users SET username = ? WHERE id = ?", candidate, item.id)
		}
	}

	s.db.Exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL")
	return nil
}

// PBKDF2 HMAC-SHA256 совместимый с Python
func pbkdf2SHA256(password, salt []byte, iterations int) []byte {
	saltInt := make([]byte, len(salt)+4)
	copy(saltInt, salt)
	saltInt[len(salt)+3] = 1

	mac := hmac.New(sha256.New, password)
	mac.Write(saltInt)
	u := mac.Sum(nil)

	result := make([]byte, len(u))
	copy(result, u)

	for i := 1; i < iterations; i++ {
		mac.Reset()
		mac.Write(u)
		u = mac.Sum(nil)
		for j := range result {
			result[j] ^= u[j]
		}
	}
	return result
}

func HashPassword(password string) (string, error) {
	if len(password) < 8 {
		return "", errors.New("Пароль должен быть не короче 8 символов")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	digest := pbkdf2SHA256([]byte(password), salt, PBKDF2Iterations)
	saltB64 := base64.URLEncoding.EncodeToString(salt)
	digestB64 := base64.URLEncoding.EncodeToString(digest)
	return fmt.Sprintf("pbkdf2_sha256$%d$%s$%s", PBKDF2Iterations, saltB64, digestB64), nil
}

func VerifyPassword(password, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2_sha256" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil {
		return false
	}
	salt, err := base64.URLEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	expected, err := base64.URLEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	actual := pbkdf2SHA256([]byte(password), salt, iter)
	return subtle.ConstantTimeCompare(actual, expected) == 1
}

func (s *AuthStore) parseUserRow(row *sql.Row) (*PublicUser, error) {
	var (
		id                                                    int64
		email, passwordHash, name, role, status               string
		qual, typesJSON, base                                 sql.NullString
		techID                                                sql.NullInt64
		speed                                                 float64
		createdAt                                             string
		approvedAt, lastLoginAt, username, bio, avatarColor   sql.NullString
		onShift                                               sql.NullInt64
	)

	err := row.Scan(
		&id, &email, &passwordHash, &name, &role, &status,
		&qual, &typesJSON, &base, &techID, &speed, &createdAt,
		&approvedAt, &lastLoginAt, &onShift, &username, &bio, &avatarColor,
	)
	if err != nil {
		return nil, err
	}

	var types []string
	if typesJSON.Valid && typesJSON.String != "" {
		_ = json.Unmarshal([]byte(typesJSON.String), &types)
	}
	if types == nil {
		types = []string{}
	}

	uname := fmt.Sprintf("user%d", id)
	if username.Valid && strings.TrimSpace(username.String) != "" {
		uname = strings.ToLower(strings.TrimSpace(username.String))
	}

	userBio := "Сотрудник дежурной смены RampPulse SVO"
	if bio.Valid && strings.TrimSpace(bio.String) != "" {
		userBio = strings.TrimSpace(bio.String)
	}

	userColor := "#2563EB"
	if avatarColor.Valid && strings.TrimSpace(avatarColor.String) != "" {
		userColor = strings.TrimSpace(avatarColor.String)
	}

	var appAt *string
	if approvedAt.Valid {
		v := approvedAt.String
		appAt = &v
	}

	var tID *int64
	if techID.Valid {
		v := techID.Int64
		tID = &v
	}

	onShiftBool := true
	if onShift.Valid {
		onShiftBool = onShift.Int64 != 0
	}

	return &PublicUser{
		ID:          id,
		Username:    uname,
		Bio:         userBio,
		AvatarColor: userColor,
		Email:       email,
		Name:        name,
		Role:        role,
		Status:      status,
		Qual:        qual.String,
		Types:       types,
		Base:        base.String,
		TechID:      tID,
		CreatedAt:   createdAt,
		ApprovedAt:  appAt,
		OnShift:     onShiftBool,
	}, nil
}

func (s *AuthStore) GetUser(userID int64) (*PublicUser, error) {
	s.lock.RLock()
	defer s.lock.RUnlock()
	row := s.db.QueryRow("SELECT id, email, password_hash, name, role, status, qual, types, base, tech_id, speed, created_at, approved_at, last_login_at, on_shift, username, bio, avatar_color FROM users WHERE id = ?", userID)
	return s.parseUserRow(row)
}

func (s *AuthStore) GetUserByEmail(email string) (*PublicUser, string, error) {
	s.lock.RLock()
	defer s.lock.RUnlock()
	var (
		id                                                    int64
		userEmail, passwordHash, name, role, status           string
		qual, typesJSON, base                                 sql.NullString
		techID                                                sql.NullInt64
		speed                                                 float64
		createdAt                                             string
		approvedAt, lastLoginAt, username, bio, avatarColor   sql.NullString
		onShift                                               sql.NullInt64
	)
	row := s.db.QueryRow("SELECT id, email, password_hash, name, role, status, qual, types, base, tech_id, speed, created_at, approved_at, last_login_at, on_shift, username, bio, avatar_color FROM users WHERE email = ? COLLATE NOCASE", strings.TrimSpace(strings.ToLower(email)))
	err := row.Scan(
		&id, &userEmail, &passwordHash, &name, &role, &status,
		&qual, &typesJSON, &base, &techID, &speed, &createdAt,
		&approvedAt, &lastLoginAt, &onShift, &username, &bio, &avatarColor,
	)
	if err != nil {
		return nil, "", err
	}

	var types []string
	if typesJSON.Valid && typesJSON.String != "" {
		_ = json.Unmarshal([]byte(typesJSON.String), &types)
	}
	if types == nil {
		types = []string{}
	}

	uname := fmt.Sprintf("user%d", id)
	if username.Valid && strings.TrimSpace(username.String) != "" {
		uname = strings.ToLower(strings.TrimSpace(username.String))
	}
	userBio := "Сотрудник дежурной смены RampPulse SVO"
	if bio.Valid && strings.TrimSpace(bio.String) != "" {
		userBio = strings.TrimSpace(bio.String)
	}
	userColor := "#2563EB"
	if avatarColor.Valid && strings.TrimSpace(avatarColor.String) != "" {
		userColor = strings.TrimSpace(avatarColor.String)
	}
	var appAt *string
	if approvedAt.Valid {
		v := approvedAt.String
		appAt = &v
	}
	var tID *int64
	if techID.Valid {
		v := techID.Int64
		tID = &v
	}
	onShiftBool := true
	if onShift.Valid {
		onShiftBool = onShift.Int64 != 0
	}

	pu := &PublicUser{
		ID:          id,
		Username:    uname,
		Bio:         userBio,
		AvatarColor: userColor,
		Email:       userEmail,
		Name:        name,
		Role:        role,
		Status:      status,
		Qual:        qual.String,
		Types:       types,
		Base:        base.String,
		TechID:      tID,
		CreatedAt:   createdAt,
		ApprovedAt:  appAt,
		OnShift:     onShiftBool,
	}
	return pu, passwordHash, nil
}

func (s *AuthStore) Authenticate(email, password string) (*PublicUser, error) {
	u, storedHash, err := s.GetUserByEmail(email)
	if err != nil || !VerifyPassword(password, storedHash) {
		return nil, errors.New("Неверный email или пароль")
	}
	if u.Status == "pending" {
		return nil, errors.New("Заявка на регистрацию ещё не подтверждена диспетчером")
	}
	if u.Status != "active" {
		return nil, errors.New("Доступ к аккаунту закрыт. Обратитесь к диспетчеру")
	}

	nowISO := time.Now().UTC().Format(time.RFC3339)
	s.db.Exec("UPDATE users SET last_login_at = ? WHERE id = ?", nowISO, u.ID)
	return u, nil
}

func (s *AuthStore) CreateSession(userID int64) (string, error) {
	tokenBytes := make([]byte, 27)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", err
	}
	token := base64.URLEncoding.EncodeToString(tokenBytes)
	now := float64(time.Now().Unix())
	nowISO := time.Now().UTC().Format(time.RFC3339)

	s.lock.Lock()
	defer s.lock.Unlock()

	s.db.Exec("DELETE FROM sessions WHERE expires_at < ?", now)
	_, err := s.db.Exec("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", token, userID, nowISO, now+SessionTTLSec)
	return token, err
}

func (s *AuthStore) UserForToken(token string) (*PublicUser, error) {
	if strings.TrimSpace(token) == "" {
		return nil, errors.New("empty token")
	}
	s.lock.RLock()
	defer s.lock.RUnlock()

	var userID int64
	err := s.db.QueryRow("SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?", token, float64(time.Now().Unix())).Scan(&userID)
	if err != nil {
		return nil, err
	}
	return s.GetUser(userID)
}

func (s *AuthStore) DeleteSession(token string) {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.db.Exec("DELETE FROM sessions WHERE token = ?", token)
}

func (s *AuthStore) UpdateProfile(userID int64, username, name, bio, avatarColor *string) (*PublicUser, error) {
	s.lock.Lock()
	defer s.lock.Unlock()

	var updates []string
	var params []any

	if username != nil {
		uname := strings.TrimSpace(strings.ToLower(*username))
		uname = strings.TrimPrefix(uname, "@")
		if !usernameRe.MatchString(uname) {
			return nil, errors.New("Юзернейм должен содержать от 3 до 30 латинских букв, цифр или подчёркиваний")
		}
		var count int
		s.db.QueryRow("SELECT COUNT(1) FROM users WHERE username = ? AND id != ?", uname, userID).Scan(&count)
		if count > 0 {
			return nil, fmt.Errorf("Юзернейм @%s уже занят другим сотрудником", uname)
		}
		updates = append(updates, "username = ?")
		params = append(params, uname)
	}

	if name != nil {
		clName := strings.TrimSpace(*name)
		if len(clName) < 2 || len(clName) > 120 {
			return nil, errors.New("Имя должно содержать от 2 до 120 символов")
		}
		updates = append(updates, "name = ?")
		params = append(params, clName)
	}

	if bio != nil {
		b := strings.TrimSpace(*bio)
		if len(b) > 200 {
			b = b[:200]
		}
		updates = append(updates, "bio = ?")
		params = append(params, b)
	}

	if avatarColor != nil {
		c := strings.TrimSpace(*avatarColor)
		if len(c) > 30 {
			c = c[:30]
		}
		updates = append(updates, "avatar_color = ?")
		params = append(params, c)
	}

	if len(updates) > 0 {
		params = append(params, userID)
		query := fmt.Sprintf("UPDATE users SET %s WHERE id = ?", strings.Join(updates, ", "))
		if _, err := s.db.Exec(query, params...); err != nil {
			return nil, err
		}
	}

	return s.GetUser(userID)
}

func (s *AuthStore) SearchUsers(q string) ([]PublicUser, error) {
	s.lock.RLock()
	defer s.lock.RUnlock()

	term := "%" + strings.TrimSpace(strings.ToLower(q)) + "%"
	rows, err := s.db.Query(`
		SELECT id, email, password_hash, name, role, status, qual, types, base, tech_id, speed, created_at, approved_at, last_login_at, on_shift, username, bio, avatar_color 
		FROM users 
		WHERE status = 'active' AND (
			LOWER(username) LIKE ? OR
			LOWER(name) LIKE ? OR
			LOWER(email) LIKE ? OR
			LOWER(COALESCE(qual, '')) LIKE ?
		)
		ORDER BY (CASE WHEN role = 'dispatcher' THEN 0 ELSE 1 END), name`, term, term, term, term)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []PublicUser
	for rows.Next() {
		// scan row directly
		u, err := s.parseUserRowScan(rows)
		if err == nil {
			list = append(list, *u)
		}
	}
	return list, nil
}

func (s *AuthStore) parseUserRowScan(rows *sql.Rows) (*PublicUser, error) {
	var (
		id                                                    int64
		email, passwordHash, name, role, status               string
		qual, typesJSON, base                                 sql.NullString
		techID                                                sql.NullInt64
		speed                                                 float64
		createdAt                                             string
		approvedAt, lastLoginAt, username, bio, avatarColor   sql.NullString
		onShift                                               sql.NullInt64
	)
	err := rows.Scan(
		&id, &email, &passwordHash, &name, &role, &status,
		&qual, &typesJSON, &base, &techID, &speed, &createdAt,
		&approvedAt, &lastLoginAt, &onShift, &username, &bio, &avatarColor,
	)
	if err != nil {
		return nil, err
	}
	var types []string
	if typesJSON.Valid && typesJSON.String != "" {
		_ = json.Unmarshal([]byte(typesJSON.String), &types)
	}
	if types == nil {
		types = []string{}
	}
	uname := fmt.Sprintf("user%d", id)
	if username.Valid && strings.TrimSpace(username.String) != "" {
		uname = strings.ToLower(strings.TrimSpace(username.String))
	}
	userBio := "Сотрудник дежурной смены RampPulse SVO"
	if bio.Valid && strings.TrimSpace(bio.String) != "" {
		userBio = strings.TrimSpace(bio.String)
	}
	userColor := "#2563EB"
	if avatarColor.Valid && strings.TrimSpace(avatarColor.String) != "" {
		userColor = strings.TrimSpace(avatarColor.String)
	}
	var appAt *string
	if approvedAt.Valid {
		v := approvedAt.String
		appAt = &v
	}
	var tID *int64
	if techID.Valid {
		v := techID.Int64
		tID = &v
	}
	onShiftBool := true
	if onShift.Valid {
		onShiftBool = onShift.Int64 != 0
	}
	return &PublicUser{
		ID:          id,
		Username:    uname,
		Bio:         userBio,
		AvatarColor: userColor,
		Email:       email,
		Name:        name,
		Role:        role,
		Status:      status,
		Qual:        qual.String,
		Types:       types,
		Base:        base.String,
		TechID:      tID,
		CreatedAt:   createdAt,
		ApprovedAt:  appAt,
		OnShift:     onShiftBool,
	}, nil
}

func (s *AuthStore) ListActiveUsers() ([]PublicUser, error) {
	s.lock.RLock()
	defer s.lock.RUnlock()
	rows, err := s.db.Query(`
		SELECT id, email, password_hash, name, role, status, qual, types, base, tech_id, speed, created_at, approved_at, last_login_at, on_shift, username, bio, avatar_color 
		FROM users WHERE status = 'active' ORDER BY (CASE WHEN role = 'dispatcher' THEN 0 ELSE 1 END), id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []PublicUser
	for rows.Next() {
		u, err := s.parseUserRowScan(rows)
		if err == nil {
			list = append(list, *u)
		}
	}
	return list, nil
}

func (s *AuthStore) ListPendingEngineers() ([]PublicUser, error) {
	s.lock.RLock()
	defer s.lock.RUnlock()
	rows, err := s.db.Query(`
		SELECT id, email, password_hash, name, role, status, qual, types, base, tech_id, speed, created_at, approved_at, last_login_at, on_shift, username, bio, avatar_color 
		FROM users WHERE role = 'engineer' AND status = 'pending' ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []PublicUser
	for rows.Next() {
		u, err := s.parseUserRowScan(rows)
		if err == nil {
			list = append(list, *u)
		}
	}
	return list, nil
}

func (s *AuthStore) SetEngineerShift(userID int64, onShift bool) (*PublicUser, error) {
	s.lock.Lock()
	defer s.lock.Unlock()

	shiftVal := 0
	if onShift {
		shiftVal = 1
	}
	res, err := s.db.Exec("UPDATE users SET on_shift = ? WHERE id = ? AND status = 'active'", shiftVal, userID)
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, errors.New("Пользователь не найден")
	}
	return s.GetUser(userID)
}

func (s *AuthStore) ApproveEngineer(userID int64) (*PublicUser, error) {
	s.lock.Lock()
	defer s.lock.Unlock()

	var maxTechID sql.NullInt64
	s.db.QueryRow("SELECT MAX(tech_id) FROM users").Scan(&maxTechID)
	nextTechID := maxTechID.Int64 + 1
	if nextTechID < 10 {
		nextTechID = 10
	}

	nowISO := time.Now().UTC().Format(time.RFC3339)
	res, err := s.db.Exec("UPDATE users SET status = 'active', tech_id = ?, on_shift = 0, approved_at = ? WHERE id = ? AND status = 'pending'", nextTechID, nowISO, userID)
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, errors.New("Заявка не найдена или уже обработана")
	}
	return s.GetUser(userID)
}

func (s *AuthStore) RejectEngineer(userID int64) (*PublicUser, error) {
	s.lock.Lock()
	defer s.lock.Unlock()
	res, err := s.db.Exec("UPDATE users SET status = 'rejected' WHERE id = ? AND status = 'pending'", userID)
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, errors.New("Заявка не найдена или уже обработана")
	}
	return s.GetUser(userID)
}

func (s *AuthStore) RegisterEngineer(name, email, password, qual string, types []string, base, username string) (*PublicUser, error) {
	name = strings.TrimSpace(name)
	email = strings.TrimSpace(strings.ToLower(email))
	if len(name) < 2 {
		return nil, errors.New("Укажите имя и фамилию")
	}
	if !emailRe.MatchString(email) {
		return nil, errors.New("Проверьте адрес электронной почты")
	}
	if len(types) == 0 {
		return nil, errors.New("Выберите хотя бы один тип воздушного судна")
	}
	uname := strings.TrimSpace(strings.ToLower(username))
	uname = strings.TrimPrefix(uname, "@")
	if uname == "" {
		uname = strings.Split(email, "@")[0]
	}
	reg := regexp.MustCompile(`[^a-zA-Z0-9_]`)
	uname = reg.ReplaceAllString(uname, "_")
	if len(uname) < 3 {
		uname = fmt.Sprintf("tech_%d", time.Now().Unix()%10000)
	}
	if !usernameRe.MatchString(uname) {
		return nil, errors.New("Юзернейм должен содержать от 3 до 30 латинских букв, цифр или подчёркиваний")
	}

	passHash, err := HashPassword(password)
	if err != nil {
		return nil, err
	}

	typesJSON, _ := json.Marshal(types)
	nowISO := time.Now().UTC().Format(time.RFC3339)

	s.lock.Lock()
	defer s.lock.Unlock()

	var count int
	s.db.QueryRow("SELECT COUNT(1) FROM users WHERE email = ?", email).Scan(&count)
	if count > 0 {
		return nil, errors.New("Аккаунт с таким email уже существует")
	}
	s.db.QueryRow("SELECT COUNT(1) FROM users WHERE username = ?", uname).Scan(&count)
	if count > 0 {
		return nil, fmt.Errorf("Юзернейм @%s уже занят", uname)
	}

	res, err := s.db.Exec(`
		INSERT INTO users (email, username, password_hash, name, role, status, qual, types, base, on_shift, created_at)
		VALUES (?, ?, ?, ?, 'engineer', 'pending', ?, ?, ?, 0, ?)`, email, uname, passHash, name, qual, string(typesJSON), base, nowISO)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetUser(id)
}

func (s *AuthStore) SeedDemo() {
	s.lock.Lock()
	defer s.lock.Unlock()

	var count int
	s.db.QueryRow("SELECT COUNT(1) FROM users WHERE role = 'dispatcher'").Scan(&count)
	if count == 0 {
		pHash, _ := HashPassword(DemoDispatcherPassword)
		nowISO := time.Now().UTC().Format(time.RFC3339)
		s.db.Exec(`INSERT INTO users (email, username, password_hash, name, role, status, created_at, approved_at, on_shift)
			VALUES ('dispatcher@oto.ru', 'orlov', ?, 'Орлов А. В.', 'dispatcher', 'active', ?, ?, 1)`, pHash, nowISO, nowISO)
	}

	s.db.QueryRow("SELECT COUNT(1) FROM users WHERE role = 'engineer' AND status = 'active'").Scan(&count)
	if count == 0 {
		pHash, _ := HashPassword(DemoEngineerPassword)
		nowISO := time.Now().UTC().Format(time.RFC3339)
		s.db.Exec(`INSERT INTO users (email, username, password_hash, name, role, status, qual, types, base, tech_id, on_shift, created_at, approved_at)
			VALUES ('tech1@oto.ru', 'ivanov_to', ?, 'Иванов И. И.', 'engineer', 'active', 'Планер', '["A320","B737"]', 'BASE1', 1, 1, ?, ?)`, pHash, nowISO, nowISO)
	}
}

func (s *AuthStore) ListActiveDispatchers() []PublicUser {
	s.lock.RLock()
	defer s.lock.RUnlock()
	rows, err := s.db.Query(`
		SELECT id, email, password_hash, name, role, status, qual, types, base, tech_id, speed, created_at, approved_at, last_login_at, on_shift, username, bio, avatar_color 
		FROM users WHERE role = 'dispatcher' AND status = 'active' ORDER BY name`)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var list []PublicUser
	for rows.Next() {
		u, err := s.parseUserRowScan(rows)
		if err == nil {
			list = append(list, *u)
		}
	}
	return list
}

func (s *AuthStore) ListActiveEngineers() []PublicUser {
	s.lock.RLock()
	defer s.lock.RUnlock()
	rows, err := s.db.Query(`
		SELECT id, email, password_hash, name, role, status, qual, types, base, tech_id, speed, created_at, approved_at, last_login_at, on_shift, username, bio, avatar_color 
		FROM users WHERE role = 'engineer' AND status = 'active' ORDER BY name`)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var list []PublicUser
	for rows.Next() {
		u, err := s.parseUserRowScan(rows)
		if err == nil {
			list = append(list, *u)
		}
	}
	return list
}

func RandHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

