package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow cross-origin / desktop client / browser
	},
}

type Hub struct {
	mu         sync.RWMutex
	clients    map[*websocket.Conn]*PublicUser
	voiceRooms map[string]map[*websocket.Conn]bool
}

var hub = &Hub{
	clients:    make(map[*websocket.Conn]*PublicUser),
	voiceRooms: make(map[string]map[*websocket.Conn]bool),
}

func (h *Hub) AddClient(conn *websocket.Conn, u *PublicUser) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[conn] = u
}

func (h *Hub) RemoveClient(conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, conn)

	// Clean up voice rooms if present
	for roomID, conns := range h.voiceRooms {
		if conns[conn] {
			delete(conns, conn)
			if len(conns) == 0 {
				delete(h.voiceRooms, roomID)
			}
		}
	}
}

func (h *Hub) UpdateUser(user *PublicUser) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for conn, u := range h.clients {
		if u != nil && u.ID == user.ID {
			h.clients[conn] = user
		}
	}
}

func (h *Hub) JoinVoice(roomID string, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.voiceRooms[roomID]; !ok {
		h.voiceRooms[roomID] = make(map[*websocket.Conn]bool)
	}
	h.voiceRooms[roomID][conn] = true
}

func (h *Hub) LeaveVoice(roomID string, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if conns, ok := h.voiceRooms[roomID]; ok {
		delete(conns, conn)
		if len(conns) == 0 {
			delete(h.voiceRooms, roomID)
		}
	}
}

// BroadcastState sends live radar snapshots according to user role (dispatcher vs engineer)
func (h *Hub) BroadcastState(eng *Engine, auth *AuthStore) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if len(h.clients) == 0 {
		return
	}

	techCache := make(map[string][]byte)
	var dispData []byte

	for conn, u := range h.clients {
		var payload []byte
		if u != nil && u.Role == "engineer" {
			techKey := fmt.Sprintf("%v", u.TechID)
			if cached, ok := techCache[techKey]; ok {
				payload = cached
			} else {
				engSnap := eng.EngineerSnapshot(u.TechID)
				engSnap["account"] = u
				engSnap["airport_name"] = eng.AirportName
				b, _ := json.Marshal(engSnap)
				techCache[techKey] = b
				payload = b
			}
		} else {
			if dispData == nil {
				dispSnap := eng.Snapshot()
				dispSnap["airport_name"] = eng.AirportName
				if auth != nil {
					regs, _ := auth.ListPendingEngineers()
					dispSnap["registrations"] = regs
				}
				if u != nil {
					dispSnap["me"] = u
				}
				dispData, _ = json.Marshal(dispSnap)
			}
			payload = dispData
		}

		go func(c *websocket.Conn, p []byte) {
			_ = c.WriteMessage(websocket.TextMessage, p)
		}(conn, payload)
	}
}

// RelayChatMessage forwards chat messages matching Python's {"type": "chat-message", "payload": ..., "room_kind": ...}
func (h *Hub) RelayChatMessage(msg map[string]interface{}, roomKind string, recipientID *int64) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	event := map[string]interface{}{
		"type":      "chat-message",
		"payload":   msg,
		"room_kind": roomKind,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return
	}

	for conn, u := range h.clients {
		if roomKind == "direct" {
			if recipientID != nil && u != nil && u.ID == *recipientID {
				go func(c *websocket.Conn) {
					_ = c.WriteMessage(websocket.TextMessage, payload)
				}(conn)
			}
		} else {
			// Public or shift broadcast
			go func(c *websocket.Conn) {
				_ = c.WriteMessage(websocket.TextMessage, payload)
			}(conn)
		}
	}
}

// RelayReadReceipt forwards read receipt event {"type": "chat-read", "payload": ...}
func (h *Hub) RelayReadReceipt(targetUserID int64, relayKey, readerName string) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	event := map[string]interface{}{
		"type": "chat-read",
		"payload": map[string]interface{}{
			"relay_key":   relayKey,
			"reader_name": readerName,
		},
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return
	}

	for conn, u := range h.clients {
		if u != nil && u.ID == targetUserID {
			go func(c *websocket.Conn) {
				_ = c.WriteMessage(websocket.TextMessage, payload)
			}(conn)
		}
	}
}

// RelayCallSignal forwards {"type": "call-signal", "payload": ...}
func (h *Hub) RelayCallSignal(targetUserID int64, signal map[string]interface{}) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	event := map[string]interface{}{
		"type":    "call-signal",
		"payload": signal,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return
	}

	for conn, u := range h.clients {
		if u != nil && u.ID == targetUserID {
			go func(c *websocket.Conn) {
				_ = c.WriteMessage(websocket.TextMessage, payload)
			}(conn)
		}
	}
}

// BroadcastVoiceRaw sends binary audio bytes or JSON signaling to peers in voice room
func (h *Hub) BroadcastVoiceRaw(roomID string, sender *websocket.Conn, msgType int, data []byte) {
	h.mu.RLock()
	conns := make([]*websocket.Conn, 0)
	if m, ok := h.voiceRooms[roomID]; ok {
		for c := range m {
			if c != sender {
				conns = append(conns, c)
			}
		}
	}
	h.mu.RUnlock()

	for _, c := range conns {
		go func(conn *websocket.Conn) {
			_ = conn.WriteMessage(msgType, data)
		}(c)
	}
}

// HandleWebSocket handles `/ws` state and chat connection
func HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[WS] Upgrade error: %v", err)
		return
	}
	defer conn.Close()

	u := GetUserFromRequest(r)
	if u == nil {
		_ = conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(4401, "Unauthorized"),
			time.Now().Add(time.Second),
		)
		return
	}

	hub.AddClient(conn, u)
	defer hub.RemoveClient(conn)

	// Send initial state snapshot immediately
	var initSnap map[string]interface{}
	if u.Role == "engineer" {
		initSnap = engine.EngineerSnapshot(u.TechID)
		initSnap["account"] = u
	} else {
		initSnap = engine.Snapshot()
		initSnap["me"] = u
		regs, _ := authStore.ListPendingEngineers()
		initSnap["registrations"] = regs
	}
	initSnap["airport_name"] = engine.AirportName

	if b, err := json.Marshal(initSnap); err == nil {
		_ = conn.WriteMessage(websocket.TextMessage, b)
	}

	// Keep alive & message pump
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			break
		}
	}
}

// HandleVoiceWebSocket handles `/ws/voice/{call_id}` walkie-talkie audio streaming
func HandleVoiceWebSocket(w http.ResponseWriter, r *http.Request) {
	u := GetUserFromRequest(r)
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[Voice WS] Upgrade error: %v", err)
		return
	}
	defer conn.Close()

	if u == nil {
		_ = conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(4401, "Unauthorized"),
			time.Now().Add(time.Second),
		)
		return
	}

	callID := r.URL.Path[len("/ws/voice/"):]
	if callID == "" {
		_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(4000, "call_id missing"))
		return
	}

	hub.JoinVoice(callID, conn)
	defer hub.LeaveVoice(callID, conn)

	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		hub.BroadcastVoiceRaw(callID, conn, msgType, data)
	}
}
