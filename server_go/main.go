package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var (
	rootPath    string
	dbPath      string
	uploadPath  string
	dbConn      *sql.DB
	authStore   *AuthStore
	chatArchive *ChatArchive
	engine      *Engine
)

func main() {
	log.Println("🚀 Starting RampPulse Go Server...")

	// Determine base directory
	exePath, err := os.Executable()
	if err == nil {
		rootPath = filepath.Dir(exePath)
	}
	if _, err := os.Stat(filepath.Join(rootPath, "data", "airport_demo.json")); err != nil {
		cwd, _ := os.Getwd()
		rootPath = cwd
		if _, err := os.Stat(filepath.Join(rootPath, "data", "airport_demo.json")); err != nil {
			parent := filepath.Dir(cwd)
			if _, err := os.Stat(filepath.Join(parent, "data", "airport_demo.json")); err == nil {
				rootPath = parent
			}
		}
	}
	log.Printf("[Server] Root directory: %s", rootPath)

	dbPath = os.Getenv("DB_FILE")
	if dbPath == "" {
		dbPath = filepath.Join(rootPath, "dispatch.db")
	}

	uploadPath = filepath.Join(rootPath, "uploads")
	_ = os.MkdirAll(uploadPath, 0755)

	// Open SQLite DB
	dbConn, err = sql.Open("sqlite", dbPath)
	if err != nil {
		log.Fatalf("Failed to open sqlite: %v", err)
	}
	defer dbConn.Close()

	// Initialize Auth & Chat Archive
	authStore, err = NewAuthStore(dbConn)
	if err != nil {
		log.Fatalf("Failed to initialize AuthStore: %v", err)
	}

	chatArchive, err = NewChatArchive(dbConn)
	if err != nil {
		log.Fatalf("Failed to initialize ChatArchive: %v", err)
	}

	// Seed demo accounts
	authStore.SeedDemo()

	// Load airport data and initialize Engine
	airportFile := filepath.Join(rootPath, "data", "airport_demo.json")
	techsFile := filepath.Join(rootPath, "data", "technicians.json")

	engine, err = NewEngine(airportFile, techsFile)
	if err != nil {
		log.Fatalf("Failed to initialize Engine: %v", err)
	}

	// Register active engineers from auth in engine
	activeEngs := authStore.ListActiveEngineers()
	for _, ae := range activeEngs {
		engine.AddEngineerTech(&ae)
		engine.SetTechOnShift(ae.TechID, ae.OnShift)
	}

	// Start simulation loop with WebSocket broadcaster
	engine.Start(func(eng *Engine) {
		hub.BroadcastState(eng, authStore)
	})

	// Setup Router
	mux := http.NewServeMux()

	// Static & Pages
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /api/meta", handleMeta)

	// Auth Endpoints
	mux.HandleFunc("POST /api/auth/login", handleLogin)
	mux.HandleFunc("GET /api/auth/me", handleGetMe)
	mux.HandleFunc("POST /api/auth/register", handleRegister)
	mux.HandleFunc("POST /api/auth/logout", handleLogout)

	// Profile & User Search
	mux.HandleFunc("POST /api/profile/update", handleProfileUpdate)
	mux.HandleFunc("GET /api/users/search", handleUserSearch)

	// Airport & State
	mux.HandleFunc("GET /api/airport", handleAirport)
	mux.HandleFunc("GET /api/state", handleState)

	// Chat & Calling
	mux.HandleFunc("GET /api/chat/contacts", handleChatContacts)
	mux.HandleFunc("GET /api/chat/history", handleChatHistory)
	mux.HandleFunc("POST /api/chat/relay", handleChatRelay)
	mux.HandleFunc("POST /api/chat/relay-read", handleChatRelayRead)
	mux.HandleFunc("GET /api/chat/search", handleChatSearch)
	mux.HandleFunc("POST /api/chat/upload", handleChatUpload)
	mux.HandleFunc("POST /api/calls/relay", handleCallRelay)

	// Dispatcher Endpoints
	mux.HandleFunc("POST /api/requests", handleCreateRequest)
	mux.HandleFunc("POST /api/requests/{id}/arrive", handleDispatcherArrive)
	mux.HandleFunc("POST /api/requests/{id}/start", handleDispatcherStart)
	mux.HandleFunc("POST /api/requests/{id}/resolve", handleDispatcherResolve)
	mux.HandleFunc("POST /api/requests/{id}/cancel", handleDispatcherCancel)
	mux.HandleFunc("POST /api/edges/{id}/block", handleBlockEdge)
	mux.HandleFunc("POST /api/sim", handleSim)
	mux.HandleFunc("POST /api/techs/{id}/position", handleMoveTech)
	mux.HandleFunc("POST /api/techs/{id}/profile", handleUpdateTechProfile)
	mux.HandleFunc("POST /api/reset", handleReset)
	mux.HandleFunc("POST /api/aircraft/spawn", handleSpawnAircraft)
	mux.HandleFunc("POST /api/aircraft/{id}/depart", handleDepartAircraft)
	mux.HandleFunc("POST /api/registrations/{id}/approve", handleApproveRegistration)
	mux.HandleFunc("POST /api/registrations/{id}/reject", handleRejectRegistration)

	// Engineer Endpoints
	mux.HandleFunc("POST /api/engineer/requests/{id}/arrive", handleEngineerArrive)
	mux.HandleFunc("POST /api/engineer/requests/{id}/start", handleEngineerStart)
	mux.HandleFunc("POST /api/engineer/requests/{id}/resolve", handleEngineerResolve)
	mux.HandleFunc("POST /api/engineer/shift/start", handleEngineerShiftStart)
	mux.HandleFunc("POST /api/engineer/shift/end", handleEngineerShiftEnd)

	// WebSockets
	mux.HandleFunc("/ws", HandleWebSocket)
	mux.HandleFunc("/ws/voice/", HandleVoiceWebSocket)

	// Web UI HTML pages
	mux.HandleFunc("GET /{$}", handleIndexPage)
	mux.HandleFunc("GET /engineer", handleEngineerPage)
	mux.HandleFunc("GET /login", handleLoginPage)
	mux.HandleFunc("GET /register", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/login?mode=register", http.StatusSeeOther)
	})

	// Static Assets
	frontendDir := filepath.Join(rootPath, "frontend")
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir(frontendDir))))
	mux.Handle("/uploads/", http.StripPrefix("/uploads/", http.FileServer(http.Dir(uploadPath))))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	log.Printf("[Server] RampPulse Go listening on http://0.0.0.0:%s", port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}

// --- Helpers ---

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]interface{}{"detail": msg})
}

func GetUserFromRequest(r *http.Request) *PublicUser {
	cookie, err := r.Cookie("oto_session")
	token := ""
	if err == nil {
		token = cookie.Value
	}
	if token == "" {
		authHdr := r.Header.Get("Authorization")
		if strings.HasPrefix(authHdr, "Bearer ") {
			token = strings.TrimSpace(authHdr[7:])
		}
	}
	if token == "" {
		token = r.URL.Query().Get("token")
	}
	if token == "" {
		return nil
	}
	u, _ := authStore.UserForToken(token)
	return u
}

func RequireUser(w http.ResponseWriter, r *http.Request) *PublicUser {
	u := GetUserFromRequest(r)
	if u == nil {
		writeError(w, http.StatusUnauthorized, "Требуется вход в систему")
		return nil
	}
	return u
}

func RequireDispatcher(w http.ResponseWriter, r *http.Request) *PublicUser {
	u := RequireUser(w, r)
	if u == nil {
		return nil
	}
	if u.Role != "dispatcher" {
		writeError(w, http.StatusForbidden, "Действие доступно только диспетчеру")
		return nil
	}
	return u
}

func RequireEngineer(w http.ResponseWriter, r *http.Request) *PublicUser {
	u := RequireUser(w, r)
	if u == nil {
		return nil
	}
	if u.Role != "engineer" {
		writeError(w, http.StatusForbidden, "Действие доступно только инженеру")
		return nil
	}
	return u
}

// --- Handlers ---

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":      true,
		"airport": engine.AirportName,
	})
}

func handleMeta(w http.ResponseWriter, r *http.Request) {
	bases := make([]map[string]string, 0)
	for _, b := range engine.Bases {
		bases = append(bases, map[string]string{"id": b, "name": b})
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"airport": map[string]interface{}{
			"name":   engine.AirportName,
			"source": "SVO / Шереметьево",
		},
		"quals": []string{"Планер", "Двигатель", "Авионика"},
		"types": []string{"A320", "A330", "A350", "B737", "B777", "B787", "SSJ-100", "MC-21"},
		"bases": bases,
		"demo": map[string]interface{}{
			"enabled":             true,
			"dispatcher_email":    "dispatcher@oto.ru",
			"dispatcher_password": DemoDispatcherPassword,
			"engineer_email":      "tech1@oto.ru",
			"engineer_password":   DemoEngineerPassword,
		},
	})
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Некорректный запрос")
		return
	}

	user, err := authStore.Authenticate(body.Email, body.Password)
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "Неверный email или пароль") {
			status = http.StatusUnauthorized
		} else if strings.Contains(err.Error(), "ещё не подтверждена") || strings.Contains(err.Error(), "закрыт") {
			status = http.StatusForbidden
		}
		writeError(w, status, err.Error())
		return
	}

	token, err := authStore.CreateSession(user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Ошибка создания сессии")
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "oto_session",
		Value:    token,
		Path:     "/",
		MaxAge:   86400 * 30,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})

	redirect := "/"
	if user.Role == "engineer" {
		redirect = "/engineer"
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"user":     user,
		"token":    token,
		"redirect": redirect,
	})
}

func handleGetMe(w http.ResponseWriter, r *http.Request) {
	u := RequireUser(w, r)
	if u == nil {
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"user": u})
}

func handleRegister(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name     string   `json:"name"`
		Email    string   `json:"email"`
		Password string   `json:"password"`
		Qual     string   `json:"qual"`
		Types    []string `json:"types"`
		Base     string   `json:"base"`
		Username string   `json:"username"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Некорректный запрос")
		return
	}

	user, err := authStore.RegisterEngineer(body.Name, body.Email, body.Password, body.Qual, body.Types, body.Base, body.Username)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "pending",
		"user":    user,
		"message": "Заявка отправлена. Диспетчер подтвердит допуск к смене.",
	})
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("oto_session"); err == nil {
		authStore.DeleteSession(c.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "oto_session",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
	})
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func handleProfileUpdate(w http.ResponseWriter, r *http.Request) {
	u := RequireUser(w, r)
	if u == nil {
		return
	}

	var body struct {
		Username    *string `json:"username"`
		Name        *string `json:"name"`
		Bio         *string `json:"bio"`
		AvatarColor *string `json:"avatar_color"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Некорректный запрос")
		return
	}

	updated, err := authStore.UpdateProfile(u.ID, body.Username, body.Name, body.Bio, body.AvatarColor)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	hub.UpdateUser(updated)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "user": updated})
}

func handleUserSearch(w http.ResponseWriter, r *http.Request) {
	if RequireUser(w, r) == nil {
		return
	}
	q := r.URL.Query().Get("q")
	users, _ := authStore.SearchUsers(q)
	writeJSON(w, http.StatusOK, map[string]interface{}{"users": users})
}

func handleAirport(w http.ResponseWriter, r *http.Request) {
	if RequireUser(w, r) == nil {
		return
	}
	writeJSON(w, http.StatusOK, engine.AirportJSON)
}

func handleState(w http.ResponseWriter, r *http.Request) {
	u := RequireUser(w, r)
	if u == nil {
		return
	}

	if u.Role == "engineer" {
		snap := engine.EngineerSnapshot(u.TechID)
		snap["account"] = u
		snap["airport_name"] = engine.AirportName
		writeJSON(w, http.StatusOK, snap)
	} else {
		snap := engine.Snapshot()
		snap["me"] = u
		snap["user"] = u
		regs, _ := authStore.ListPendingEngineers()
		snap["registrations"] = regs
		snap["airport_name"] = engine.AirportName
		writeJSON(w, http.StatusOK, snap)
	}
}

func handleChatContacts(w http.ResponseWriter, r *http.Request) {
	u := RequireUser(w, r)
	if u == nil {
		return
	}

	all := append(authStore.ListActiveDispatchers(), authStore.ListActiveEngineers()...)
	contacts := make([]map[string]interface{}, 0)
	for _, c := range all {
		if c.ID != u.ID {
			contacts = append(contacts, map[string]interface{}{
				"id":           c.ID,
				"username":     c.Username,
				"name":         c.Name,
				"role":         c.Role,
				"qual":         c.Qual,
				"on_shift":     c.OnShift,
				"avatar_color": c.AvatarColor,
				"bio":          c.Bio,
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"contacts": contacts})
}

func handleChatHistory(w http.ResponseWriter, r *http.Request) {
	u := RequireUser(w, r)
	if u == nil {
		return
	}

	roomKind := r.URL.Query().Get("room_kind")
	var peerID *int64
	if pidStr := r.URL.Query().Get("peer_id"); pidStr != "" {
		if pid, err := strconv.ParseInt(pidStr, 10, 64); err == nil {
			peerID = &pid
		}
	}

	if roomKind == "direct" && peerID == nil {
		writeError(w, http.StatusBadRequest, "Не указан собеседник")
		return
	}

	msgs, _ := chatArchive.History(roomKind, u.ID, peerID, 100)
	if msgs == nil {
		msgs = []ChatMessage{}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"messages": msgs})
}

func handleChatRelay(w http.ResponseWriter, r *http.Request) {
	u := RequireUser(w, r)
	if u == nil {
		return
	}

	var body struct {
		Message     map[string]interface{} `json:"message"`
		RoomKind    string                 `json:"room_kind"`
		RecipientID *int64                 `json:"recipient_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Некорректный запрос")
		return
	}

	relayKey, _ := body.Message["relay_key"].(string)
	text, _ := body.Message["body"].(string)
	sticker, _ := body.Message["sticker"].(string)
	mediaURL, _ := body.Message["media_url"].(string)
	mediaType, _ := body.Message["media_type"].(string)
	mediaName, _ := body.Message["media_name"].(string)
	var duration *int
	if d, ok := body.Message["duration"].(float64); ok {
		di := int(d)
		duration = &di
	}

	if relayKey == "" || (text == "" && sticker == "" && mediaURL == "") {
		writeError(w, http.StatusBadRequest, "Пустое сообщение")
		return
	}

	var stPtr, mURLPtr, mTypePtr, mNamePtr *string
	if sticker != "" {
		stPtr = &sticker
	}
	if mediaURL != "" {
		mURLPtr = &mediaURL
	}
	if mediaType != "" {
		mTypePtr = &mediaType
	}
	if mediaName != "" {
		mNamePtr = &mediaName
	}

	msgObj := &ChatMessage{
		RelayKey:       relayKey,
		RoomKind:       body.RoomKind,
		SenderID:       u.ID,
		SenderName:     u.Name,
		SenderUsername: u.Username,
		RecipientID:    body.RecipientID,
		Body:           text,
		Sticker:        stPtr,
		MediaURL:       mURLPtr,
		MediaType:      mTypePtr,
		MediaName:      mNamePtr,
		Duration:       duration,
	}

	archived, err := chatArchive.Save(msgObj)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Ошибка сохранения сообщения")
		return
	}

	msgMap := map[string]interface{}{
		"id":              archived.ID,
		"relay_key":       archived.RelayKey,
		"room_kind":       archived.RoomKind,
		"sender_id":       archived.SenderID,
		"sender_name":     archived.SenderName,
		"sender_username": archived.SenderUsername,
		"recipient_id":    archived.RecipientID,
		"body":            archived.Body,
		"sticker":         archived.Sticker,
		"media_url":       archived.MediaURL,
		"media_type":      archived.MediaType,
		"media_name":      archived.MediaName,
		"duration":        archived.Duration,
		"created_at":      archived.CreatedAt,
		"from_user_id":    u.ID,
	}

	hub.RelayChatMessage(msgMap, body.RoomKind, body.RecipientID)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func handleChatRelayRead(w http.ResponseWriter, r *http.Request) {
	u := RequireUser(w, r)
	if u == nil {
		return
	}

	var body struct {
		RelayKey string `json:"relay_key"`
		SenderID int64  `json:"sender_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Некорректный запрос")
		return
	}

	_ = chatArchive.MarkRead(body.RelayKey, u.ID, body.SenderID)
	hub.RelayReadReceipt(body.SenderID, body.RelayKey, u.Name)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func handleChatSearch(w http.ResponseWriter, r *http.Request) {
	u := RequireUser(w, r)
	if u == nil {
		return
	}

	q := r.URL.Query().Get("q")
	roomKind := r.URL.Query().Get("room_kind")
	var peerID *int64
	if pidStr := r.URL.Query().Get("peer_id"); pidStr != "" {
		if pid, err := strconv.ParseInt(pidStr, 10, 64); err == nil {
			peerID = &pid
		}
	}

	var rkPtr *string
	if roomKind != "" {
		rkPtr = &roomKind
	}
	msgs, _ := chatArchive.Search(q, u.ID, rkPtr, peerID, 50)
	if msgs == nil {
		msgs = []ChatMessage{}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"messages": msgs})
}

func handleChatUpload(w http.ResponseWriter, r *http.Request) {
	if RequireUser(w, r) == nil {
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "Файл не передан")
		return
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(header.Filename))
	safeName := fmt.Sprintf("%d_%s%s", time.Now().UnixMilli(), RandHex(4), ext)
	dstPath := filepath.Join(uploadPath, safeName)

	dst, err := os.Create(dstPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Ошибка сохранения файла")
		return
	}
	defer dst.Close()

	size, err := io.Copy(dst, file)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Ошибка записи файла")
		return
	}

	mediaType := "file"
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg":
		mediaType = "image"
	case ".wav", ".mp3", ".ogg", ".webm", ".m4a", ".aac":
		mediaType = "audio_voice"
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"url":        "/uploads/" + safeName,
		"media_type": mediaType,
		"media_name": header.Filename,
		"size":       size,
	})
}

func handleCallRelay(w http.ResponseWriter, r *http.Request) {
	u := RequireUser(w, r)
	if u == nil {
		return
	}

	var body struct {
		Signal      map[string]interface{} `json:"signal"`
		RecipientID int64                  `json:"recipient_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Некорректный запрос")
		return
	}

	body.Signal["from_user_id"] = u.ID
	body.Signal["from_name"] = u.Name
	body.Signal["from_role"] = u.Role

	hub.RelayCallSignal(body.RecipientID, body.Signal)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

// --- Dispatcher Handlers ---

func handleCreateRequest(w http.ResponseWriter, r *http.Request) {
	if RequireDispatcher(w, r) == nil {
		return
	}

	var body struct {
		Stand       string `json:"stand"`
		Description string `json:"description"`
		Qual        string `json:"qual"`
		Extra       string `json:"extra"`
		Priority    string `json:"priority"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Некорректный запрос")
		return
	}

	req, err := engine.CreateRequest(body.Stand, body.Description, body.Qual, body.Extra, body.Priority)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"id":     req.ID,
		"status": req.Status,
	})
}

func handleDispatcherArrive(w http.ResponseWriter, r *http.Request) {
	if RequireDispatcher(w, r) == nil {
		return
	}
	rid, _ := strconv.Atoi(r.PathValue("id"))
	if err := engine.MarkArrived(rid, ""); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func handleDispatcherStart(w http.ResponseWriter, r *http.Request) {
	if RequireDispatcher(w, r) == nil {
		return
	}
	rid, _ := strconv.Atoi(r.PathValue("id"))
	if err := engine.StartWork(rid); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func handleDispatcherResolve(w http.ResponseWriter, r *http.Request) {
	if RequireDispatcher(w, r) == nil {
		return
	}
	rid, _ := strconv.Atoi(r.PathValue("id"))
	if err := engine.Resolve(rid); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func handleDispatcherCancel(w http.ResponseWriter, r *http.Request) {
	if RequireDispatcher(w, r) == nil {
		return
	}
	rid, _ := strconv.Atoi(r.PathValue("id"))
	if err := engine.Cancel(rid); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func handleBlockEdge(w http.ResponseWriter, r *http.Request) {
	if RequireDispatcher(w, r) == nil {
		return
	}
	edgeID := r.PathValue("id")
	var body struct {
		Blocked bool `json:"blocked"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	engine.SetEdgeBlocked(edgeID, body.Blocked)
	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func handleSim(w http.ResponseWriter, r *http.Request) {
	if RequireDispatcher(w, r) == nil {
		return
	}
	var body struct {
		Speed   *int  `json:"speed"`
		Running *bool `json:"running"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Speed != nil {
		engine.SetSpeed(*body.Speed)
	}
	if body.Running != nil {
		engine.SetRunning(*body.Running)
	}
	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func handleMoveTech(w http.ResponseWriter, r *http.Request) {
	if RequireDispatcher(w, r) == nil {
		return
	}
	techID, _ := strconv.Atoi(r.PathValue("id"))
	var body struct {
		X float64 `json:"x"`
		Y float64 `json:"y"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	tech, err := engine.MoveTech(techID, body.X, body.Y)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"id": tech.ID,
		"x":  tech.X,
		"y":  tech.Y,
	})
}

func handleUpdateTechProfile(w http.ResponseWriter, r *http.Request) {
	if RequireDispatcher(w, r) == nil {
		return
	}
	techID, _ := strconv.Atoi(r.PathValue("id"))
	var body struct {
		Qual  string   `json:"qual"`
		Types []string `json:"types"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	tech, err := engine.UpdateTechProfile(techID, body.Qual, body.Types)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"id":    tech.ID,
		"qual":  tech.Qual,
		"types": tech.Types,
	})
}

func handleReset(w http.ResponseWriter, r *http.Request) {
	if RequireDispatcher(w, r) == nil {
		return
	}
	engine.Reset()
	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func handleSpawnAircraft(w http.ResponseWriter, r *http.Request) {
	if RequireDispatcher(w, r) == nil {
		return
	}
	ac := engine.SpawnAircraftManual()
	hub.BroadcastState(engine, authStore)
	if ac != nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"id": ac.ID, "flight": ac.Flight})
	} else {
		writeJSON(w, http.StatusOK, map[string]interface{}{"id": nil, "flight": nil})
	}
}

func handleDepartAircraft(w http.ResponseWriter, r *http.Request) {
	if RequireDispatcher(w, r) == nil {
		return
	}
	aid, _ := strconv.Atoi(r.PathValue("id"))
	engine.ForceDepart(aid)
	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func handleApproveRegistration(w http.ResponseWriter, r *http.Request) {
	if RequireDispatcher(w, r) == nil {
		return
	}
	uid, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	user, err := authStore.ApproveEngineer(uid)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	engine.AddEngineerTech(user)
	engine.Log(fmt.Sprintf("Допуск подтверждён: %s (%s, %s)", user.Name, user.Qual, user.Base), nil, "info")
	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "user": user})
}

func handleRejectRegistration(w http.ResponseWriter, r *http.Request) {
	if RequireDispatcher(w, r) == nil {
		return
	}
	uid, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	user, err := authStore.RejectEngineer(uid)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	engine.Log(fmt.Sprintf("Заявка на регистрацию отклонена: %s", user.Name), nil, "warn")
	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "user": user})
}

// --- Engineer Handlers ---

func handleEngineerArrive(w http.ResponseWriter, r *http.Request) {
	u := RequireEngineer(w, r)
	if u == nil {
		return
	}
	rid, _ := strconv.Atoi(r.PathValue("id"))
	req := engine.Requests[rid]
	if req == nil || u.TechID == nil || req.TechID == nil || *req.TechID != int(*u.TechID) {
		writeError(w, http.StatusNotFound, "Заявка не назначена вам")
		return
	}
	if err := engine.MarkArrived(rid, "инженером"); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func handleEngineerStart(w http.ResponseWriter, r *http.Request) {
	u := RequireEngineer(w, r)
	if u == nil {
		return
	}
	rid, _ := strconv.Atoi(r.PathValue("id"))
	req := engine.Requests[rid]
	if req == nil || u.TechID == nil || req.TechID == nil || *req.TechID != int(*u.TechID) {
		writeError(w, http.StatusNotFound, "Заявка не назначена вам")
		return
	}
	if err := engine.StartWork(rid); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func handleEngineerResolve(w http.ResponseWriter, r *http.Request) {
	u := RequireEngineer(w, r)
	if u == nil {
		return
	}
	rid, _ := strconv.Atoi(r.PathValue("id"))
	req := engine.Requests[rid]
	if req == nil || u.TechID == nil || req.TechID == nil || *req.TechID != int(*u.TechID) {
		writeError(w, http.StatusNotFound, "Заявка не назначена вам")
		return
	}
	if err := engine.Resolve(rid); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func handleEngineerShiftStart(w http.ResponseWriter, r *http.Request) {
	u := RequireEngineer(w, r)
	if u == nil {
		return
	}
	account, err := authStore.SetEngineerShift(u.ID, true)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	engine.SetTechOnShift(account.TechID, true)
	hub.UpdateUser(account)
	engine.Log(fmt.Sprintf("%s вышел на смену", account.Name), nil, "info")
	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "account": account})
}

func handleEngineerShiftEnd(w http.ResponseWriter, r *http.Request) {
	u := RequireEngineer(w, r)
	if u == nil {
		return
	}
	if u.TechID != nil {
		tid := int(*u.TechID)
		for _, req := range engine.Requests {
			if req.TechID != nil && *req.TechID == tid && (req.Status == "assigned" || req.Status == "enroute" || req.Status == "arrived" || req.Status == "working") {
				writeError(w, http.StatusConflict, fmt.Sprintf("Нельзя завершить смену: заявка #%d ещё не выполнена. Сначала завершите заявку.", req.ID))
				return
			}
		}
	}
	engine.SetTechOnShift(u.TechID, false)
	account, err := authStore.SetEngineerShift(u.ID, false)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hub.UpdateUser(account)
	engine.Log(fmt.Sprintf("%s завершил смену", account.Name), nil, "info")
	hub.BroadcastState(engine, authStore)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "account": account})
}

// --- Page Handlers ---

func handleIndexPage(w http.ResponseWriter, r *http.Request) {
	u := GetUserFromRequest(r)
	if u == nil {
		http.Redirect(w, r, "/login?next=/", http.StatusSeeOther)
		return
	}
	if u.Role != "dispatcher" {
		http.Redirect(w, r, "/engineer", http.StatusSeeOther)
		return
	}
	http.ServeFile(w, r, filepath.Join(rootPath, "frontend", "index.html"))
}

func handleEngineerPage(w http.ResponseWriter, r *http.Request) {
	u := GetUserFromRequest(r)
	if u == nil {
		http.Redirect(w, r, "/login?next=/engineer", http.StatusSeeOther)
		return
	}
	if u.Role != "engineer" {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	http.ServeFile(w, r, filepath.Join(rootPath, "frontend", "engineer.html"))
}

func handleLoginPage(w http.ResponseWriter, r *http.Request) {
	u := GetUserFromRequest(r)
	if u != nil {
		if u.Role == "dispatcher" {
			http.Redirect(w, r, "/", http.StatusSeeOther)
		} else {
			http.Redirect(w, r, "/engineer", http.StatusSeeOther)
		}
		return
	}
	http.ServeFile(w, r, filepath.Join(rootPath, "frontend", "auth.html"))
}
