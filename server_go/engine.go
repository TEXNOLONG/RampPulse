package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"sync"
	"time"
)

type Aircraft struct {
	ID                 int            `json:"id"`
	Flight             string         `json:"flight"`
	Stand              string         `json:"stand"`
	Model              string         `json:"model"`
	Status             string         `json:"status"`
	StatusRU           string         `json:"status_ru"`
	TurnaroundProgress float64        `json:"turnaround_progress"`
	X                  float64        `json:"x"`
	Y                  float64        `json:"y"`
	Heading            float64        `json:"heading"`
	Route              [][]float64    `json:"route"`
	EtaLeft            *float64       `json:"eta_left"`
	ParkedLeft         *float64       `json:"parked_left"`
	Brief              map[string]any `json:"brief,omitempty"`
	Services           []any          `json:"services"`
	ServicesProgress   int            `json:"services_progress"`
	SchedArrSim        *float64       `json:"sched_arr_sim,omitempty"`
	ActualArrSim       *float64       `json:"actual_arr_sim,omitempty"`
	SchedDepSim        *float64       `json:"sched_dep_sim,omitempty"`
	ActualDepSim       *float64       `json:"actual_dep_sim,omitempty"`
	DelayArrSec        *float64       `json:"delay_arr_sec,omitempty"`
}

type Tech struct {
	ID        int         `json:"id"`
	Name      string      `json:"name"`
	Qual      string      `json:"qual"`
	Speed     float64     `json:"speed"`
	Types     []string    `json:"types"`
	OnShift   bool        `json:"on_shift"`
	Status    string      `json:"status"`
	RequestID *int        `json:"request_id"`
	Base      string      `json:"base"`
	X         float64     `json:"x"`
	Y         float64     `json:"y"`
	Route     [][]float64 `json:"route"`
	VehicleID *int        `json:"vehicle_id"`
}

type MRequest struct {
	ID          int    `json:"id"`
	Stand       string `json:"stand"`
	Description string `json:"description"`
	Qual        string `json:"qual"`
	Extra       string `json:"extra"`
	Priority    string `json:"priority"`
	TechID      *int   `json:"tech_id"`
	TechName    string `json:"tech_name"`
	Status      string `json:"status"`
	CreatedAt   string `json:"created_at"`
	ArrivedAt   string `json:"arrived_at,omitempty"`
	StartedAt   string `json:"started_at,omitempty"`
	ResolvedAt  string `json:"resolved_at,omitempty"`
}

type NodePoint struct {
	X float64
	Y float64
}

type Engine struct {
	lock          sync.RWMutex
	AirportJSON   map[string]any
	AirportName   string
	Bases         []string
	Stands        []string
	NodeCoords    map[string]NodePoint
	StandNodes    map[string]string
	StandHeadings map[string]float64
	BaseNodes     map[string]string
	BlockedEdges  map[string]bool
	Aircraft      []*Aircraft
	Techs         []*Tech
	Requests      map[int]*MRequest
	nextReqID     int
	nextAcID      int
	simSpeed      float64
	simRunning    bool
	simTime       float64
	events        []map[string]any
	onBroadcast   func(*Engine)
}

func NewEngine(airportPath string, techsPath string) (*Engine, error) {
	e := &Engine{
		AirportJSON:   make(map[string]any),
		NodeCoords:    make(map[string]NodePoint),
		StandNodes:    make(map[string]string),
		StandHeadings: make(map[string]float64),
		BaseNodes:     make(map[string]string),
		BlockedEdges:  make(map[string]bool),
		Requests:      make(map[int]*MRequest),
		nextReqID:     101,
		nextAcID:      1,
		simSpeed:      10.0,
		simRunning:    true,
	}

	// Read airport schema
	if data, err := os.ReadFile(airportPath); err == nil {
		_ = json.Unmarshal(data, &e.AirportJSON)
	}
	if name, ok := e.AirportJSON["name"].(string); ok && name != "" {
		e.AirportName = name
	} else {
		e.AirportName = "Демо-аэропорт (условная схема по мотивам Внуково)"
	}

	// Parse nodes
	if nodesList, ok := e.AirportJSON["nodes"].([]any); ok {
		for _, item := range nodesList {
			if nm, ok := item.(map[string]any); ok {
				id, _ := nm["id"].(string)
				var x, y float64
				if xv, ok := nm["x"].(float64); ok {
					x = xv
				}
				if yv, ok := nm["y"].(float64); ok {
					y = yv
				}
				if id != "" {
					e.NodeCoords[id] = NodePoint{X: x, Y: y}
				}
			}
		}
	}

	// Parse stands
	if standsList, ok := e.AirportJSON["stands"].([]any); ok {
		for _, s := range standsList {
			if sMap, ok := s.(map[string]any); ok {
				id, _ := sMap["id"].(string)
				node, _ := sMap["node"].(string)
				head, _ := sMap["heading"].(float64)
				if id != "" {
					e.Stands = append(e.Stands, id)
					e.StandNodes[id] = node
					e.StandHeadings[id] = head
				}
			} else if sStr, ok := s.(string); ok && sStr != "" {
				e.Stands = append(e.Stands, sStr)
			}
		}
	}
	if len(e.Stands) == 0 {
		for i := 1; i <= 20; i++ {
			e.Stands = append(e.Stands, fmt.Sprintf("ВС-%02d", i))
		}
	}

	// Parse bases
	if basesList, ok := e.AirportJSON["bases"].([]any); ok {
		for _, b := range basesList {
			if bMap, ok := b.(map[string]any); ok {
				id, _ := bMap["id"].(string)
				node, _ := bMap["node"].(string)
				if id != "" {
					e.Bases = append(e.Bases, id)
					e.BaseNodes[id] = node
				}
			} else if bStr, ok := b.(string); ok && bStr != "" {
				e.Bases = append(e.Bases, bStr)
			}
		}
	}
	if len(e.Bases) == 0 {
		e.Bases = []string{"BASE1", "BASE2", "BASE3"}
	}

	// Read technicians
	type techCfg struct {
		Name  string   `json:"name"`
		Qual  string   `json:"qual"`
		Speed float64  `json:"speed"`
		Types []string `json:"types"`
		Base  string   `json:"base"`
	}
	var tList []techCfg
	if data, err := os.ReadFile(techsPath); err == nil {
		_ = json.Unmarshal(data, &tList)
	}
	if len(tList) == 0 {
		tList = []techCfg{
			{Name: "Иванов П. С.", Qual: "Планер", Speed: 4.0, Types: []string{"A320", "B737"}, Base: "BASE1"},
			{Name: "Сидоров В. А.", Qual: "Двигатель", Speed: 4.0, Types: []string{"A320", "SSJ-100"}, Base: "BASE2"},
			{Name: "Кузнецов Д. М.", Qual: "Авионика", Speed: 4.0, Types: []string{"B737", "SSJ-100"}, Base: "BASE1"},
		}
	}

	for i, tc := range tList {
		posX := 350.0 + float64(i*60)
		posY := 1060.0
		if bNode, ok := e.BaseNodes[tc.Base]; ok {
			if pt, ok := e.NodeCoords[bNode]; ok {
				posX = pt.X
				posY = pt.Y
			}
		}

		e.Techs = append(e.Techs, &Tech{
			ID:      i + 1,
			Name:    tc.Name,
			Qual:    tc.Qual,
			Speed:   tc.Speed,
			Types:   tc.Types,
			OnShift: true,
			Status:  "free",
			Base:    tc.Base,
			X:       posX,
			Y:       posY,
			Route:   [][]float64{},
		})
	}

	// Spawn initial aircraft parked at stands
	spawnCount := 4
	if len(e.Stands) < spawnCount {
		spawnCount = len(e.Stands)
	}
	for i := 0; i < spawnCount; i++ {
		e.spawnInitialAircraft(e.Stands[i])
	}

	return e, nil
}

func (e *Engine) spawnInitialAircraft(stand string) *Aircraft {
	models := []string{"A320", "B737", "SSJ-100", "A321", "B777"}
	flightNum := 1000 + rand.Intn(9000)
	model := models[rand.Intn(len(models))]

	posX := 500.0 + float64(e.nextAcID*120)
	posY := 600.0
	heading := 180.0
	if sNode, ok := e.StandNodes[stand]; ok {
		if pt, ok := e.NodeCoords[sNode]; ok {
			posX = pt.X
			posY = pt.Y
		}
	}
	if h, ok := e.StandHeadings[stand]; ok && h != 0 {
		heading = h
	}

	cities := []struct{ iata, name string }{
		{"LED", "Пулково (Санкт-Петербург)"},
		{"AER", "Сочи"},
		{"OVB", "Толмачёво (Новосибирск)"},
		{"KZN", "Казань"},
		{"SVX", "Кольцово (Екатеринбург)"},
		{"IKT", "Иркутск"},
	}
	orig := cities[rand.Intn(len(cities))]

	schedSim := e.simTime - float64(1800+rand.Intn(3600))
	actualSim := schedSim + float64(rand.Intn(300))

	ac := &Aircraft{
		ID:                 e.nextAcID,
		Flight:             fmt.Sprintf("SU%d", flightNum),
		Stand:              stand,
		Model:              model,
		Status:             "parked",
		StatusRU:           "На стоянке",
		TurnaroundProgress: 100,
		X:                  posX,
		Y:                  posY,
		Heading:            heading,
		Route:              [][]float64{},
		Services:           []any{},
		ServicesProgress:   100,
		SchedArrSim:        &schedSim,
		ActualArrSim:       &actualSim,
		Brief: map[string]any{
			"airline":      "Аэрофлот",
			"registration": fmt.Sprintf("RA-%05d", 73000+rand.Intn(999)),
			"origin":       map[string]any{"iata": orig.iata, "name": orig.name},
			"destination":  map[string]any{"iata": "VKO", "name": e.AirportName},
			"gate":         fmt.Sprintf("%d", 1+rand.Intn(18)),
		},
	}
	e.nextAcID++
	e.Aircraft = append(e.Aircraft, ac)
	return ac
}

func (e *Engine) Start(broadcastFn func(*Engine)) {
	e.onBroadcast = broadcastFn
	go func() {
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			e.Tick(0.2)
		}
	}()
}

func (e *Engine) Tick(dt float64) {
	e.lock.Lock()
	defer e.lock.Unlock()

	if !e.simRunning {
		return
	}

	effDt := dt * e.simSpeed
	e.simTime += effDt

	changed := false
	for _, ac := range e.Aircraft {
		if ac.Status == "servicing" {
			ac.TurnaroundProgress += effDt * 0.25
			if ac.TurnaroundProgress >= 100 {
				ac.TurnaroundProgress = 100
				ac.Status = "parked"
				ac.StatusRU = "Готов к вылету"
				changed = true
			}
		}
	}

	if changed && e.onBroadcast != nil {
		go e.onBroadcast(e)
	}
}

func (e *Engine) CreateRequest(stand, desc, qual, extra, prio string) (*MRequest, error) {
	e.lock.Lock()
	defer e.lock.Unlock()

	req := &MRequest{
		ID:          e.nextReqID,
		Stand:       stand,
		Description: desc,
		Qual:        qual,
		Extra:       extra,
		Priority:    prio,
		Status:      "waiting",
		TechName:    "Автоподбор",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	e.nextReqID++

	// Auto-assign free technician
	for _, t := range e.Techs {
		if t.OnShift && t.Status == "free" && (qual == "auto" || t.Qual == qual) {
			t.Status = "busy"
			t.RequestID = &req.ID
			req.TechID = &t.ID
			req.TechName = t.Name
			req.Status = "enroute"
			break
		}
	}

	e.Requests[req.ID] = req
	e.logEvent(fmt.Sprintf("Создана заявка #%d на стоянку %s: %s", req.ID, stand, desc), req.ID, "info")

	if e.onBroadcast != nil {
		go e.onBroadcast(e)
	}
	return req, nil
}

func (e *Engine) MarkArrived(reqID int, note string) error {
	e.lock.Lock()
	defer e.lock.Unlock()

	req, ok := e.Requests[reqID]
	if !ok {
		return errors.New("Заявка не найдена")
	}
	req.Status = "arrived"
	req.ArrivedAt = time.Now().UTC().Format(time.RFC3339)
	e.logEvent(fmt.Sprintf("Инженер прибыл к борту по заявке #%d (%s) %s", reqID, req.Stand, note), reqID, "info")

	if e.onBroadcast != nil {
		go e.onBroadcast(e)
	}
	return nil
}

func (e *Engine) StartWork(reqID int) error {
	e.lock.Lock()
	defer e.lock.Unlock()

	req, ok := e.Requests[reqID]
	if !ok {
		return errors.New("Заявка не найдена")
	}
	req.Status = "working"
	req.StartedAt = time.Now().UTC().Format(time.RFC3339)
	e.logEvent(fmt.Sprintf("Начаты работы по устранению дефекта по заявке #%d", reqID), reqID, "info")

	if e.onBroadcast != nil {
		go e.onBroadcast(e)
	}
	return nil
}

func (e *Engine) Resolve(reqID int) error {
	e.lock.Lock()
	defer e.lock.Unlock()

	req, ok := e.Requests[reqID]
	if !ok {
		return errors.New("Заявка не найдена")
	}
	req.Status = "done"
	req.ResolvedAt = time.Now().UTC().Format(time.RFC3339)

	if req.TechID != nil {
		for _, t := range e.Techs {
			if t.ID == *req.TechID {
				t.Status = "free"
				t.RequestID = nil
			}
		}
	}

	e.logEvent(fmt.Sprintf("Дефект успешно устранён по заявке #%d", reqID), reqID, "info")

	if e.onBroadcast != nil {
		go e.onBroadcast(e)
	}
	return nil
}

func (e *Engine) Cancel(reqID int) error {
	e.lock.Lock()
	defer e.lock.Unlock()

	req, ok := e.Requests[reqID]
	if !ok {
		return errors.New("Заявка не найдена")
	}
	req.Status = "cancelled"

	if req.TechID != nil {
		for _, t := range e.Techs {
			if t.ID == *req.TechID {
				t.Status = "free"
				t.RequestID = nil
			}
		}
	}

	e.logEvent(fmt.Sprintf("Заявка #%d отменена диспетчером", reqID), reqID, "warn")

	if e.onBroadcast != nil {
		go e.onBroadcast(e)
	}
	return nil
}

func (e *Engine) SpawnAircraftManual() *Aircraft {
	e.lock.Lock()
	defer e.lock.Unlock()

	occupied := make(map[string]bool)
	for _, ac := range e.Aircraft {
		occupied[ac.Stand] = true
	}
	freeStand := ""
	for _, s := range e.Stands {
		if !occupied[s] {
			freeStand = s
			break
		}
	}
	if freeStand == "" {
		freeStand = fmt.Sprintf("ВС-%02d", len(e.Aircraft)+1)
	}

	ac := e.spawnInitialAircraft(freeStand)
	e.logEvent(fmt.Sprintf("Прибыл борт %s (%s) на стоянку %s", ac.Flight, ac.Model, ac.Stand), 0, "info")

	if e.onBroadcast != nil {
		go e.onBroadcast(e)
	}
	return ac
}

func (e *Engine) ForceDepart(aid int) {
	e.lock.Lock()
	defer e.lock.Unlock()

	idx := -1
	for i, ac := range e.Aircraft {
		if ac.ID == aid {
			idx = i
			break
		}
	}
	if idx == -1 {
		return
	}

	departed := e.Aircraft[idx]
	e.Aircraft = append(e.Aircraft[:idx], e.Aircraft[idx+1:]...)
	e.logEvent(fmt.Sprintf("Борт %s отправлен в рейс со стоянки %s", departed.Flight, departed.Stand), 0, "info")

	if e.onBroadcast != nil {
		go e.onBroadcast(e)
	}
}

func (e *Engine) SetSpeed(speed int) {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.simSpeed = float64(speed)
	if e.onBroadcast != nil {
		go e.onBroadcast(e)
	}
}

func (e *Engine) SetRunning(running bool) {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.simRunning = running
	if e.onBroadcast != nil {
		go e.onBroadcast(e)
	}
}

func (e *Engine) SetEdgeBlocked(edgeID string, blocked bool) {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.BlockedEdges[edgeID] = blocked
	if e.onBroadcast != nil {
		go e.onBroadcast(e)
	}
}

func (e *Engine) MoveTech(techID int, x, y float64) (*Tech, error) {
	e.lock.Lock()
	defer e.lock.Unlock()
	for _, t := range e.Techs {
		if t.ID == techID {
			t.X = x
			t.Y = y
			if e.onBroadcast != nil {
				go e.onBroadcast(e)
			}
			return t, nil
		}
	}
	return nil, errors.New("Специалист не найден")
}

func (e *Engine) UpdateTechProfile(techID int, qual string, types []string) (*Tech, error) {
	e.lock.Lock()
	defer e.lock.Unlock()
	for _, t := range e.Techs {
		if t.ID == techID {
			t.Qual = qual
			t.Types = types
			if e.onBroadcast != nil {
				go e.onBroadcast(e)
			}
			return t, nil
		}
	}
	return nil, errors.New("Специалист не найден")
}

func (e *Engine) Reset() {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.Requests = make(map[int]*MRequest)
	e.events = nil
	for _, t := range e.Techs {
		t.Status = "free"
		t.RequestID = nil
	}
	if e.onBroadcast != nil {
		go e.onBroadcast(e)
	}
}

func (e *Engine) SetTechOnShift(techID *int64, onShift bool) {
	if techID == nil {
		return
	}
	tid := int(*techID)
	e.lock.Lock()
	defer e.lock.Unlock()
	for _, t := range e.Techs {
		if t.ID == tid {
			t.OnShift = onShift
			break
		}
	}
	if e.onBroadcast != nil {
		go e.onBroadcast(e)
	}
}

func (e *Engine) AddEngineerTech(u *PublicUser) {
	if u == nil || u.TechID == nil {
		return
	}
	e.lock.Lock()
	defer e.lock.Unlock()

	tid := int(*u.TechID)
	for _, t := range e.Techs {
		if t.ID == tid {
			t.Name = u.Name
			t.Qual = u.Qual
			t.Types = u.Types
			t.OnShift = u.OnShift
			return
		}
	}

	posX := 400.0
	posY := 1060.0
	if bNode, ok := e.BaseNodes[u.Base]; ok {
		if pt, ok := e.NodeCoords[bNode]; ok {
			posX = pt.X
			posY = pt.Y
		}
	}

	e.Techs = append(e.Techs, &Tech{
		ID:      tid,
		Name:    u.Name,
		Qual:    u.Qual,
		Speed:   4.0,
		Types:   u.Types,
		OnShift: u.OnShift,
		Status:  "free",
		Base:    u.Base,
		X:       posX,
		Y:       posY,
		Route:   [][]float64{},
	})
	if e.onBroadcast != nil {
		go e.onBroadcast(e)
	}
}

func (e *Engine) Log(text string, reqID *int, kind string) {
	e.lock.Lock()
	defer e.lock.Unlock()
	rid := 0
	if reqID != nil {
		rid = *reqID
	}
	e.logEvent(text, rid, kind)
	if e.onBroadcast != nil {
		go e.onBroadcast(e)
	}
}

func (e *Engine) logEvent(text string, reqID int, kind string) {
	e.events = append(e.events, map[string]any{
		"ts":         time.Now().UTC().Format("15:04:05"),
		"text":       text,
		"request_id": reqID,
		"kind":       kind,
	})
	if len(e.events) > 50 {
		e.events = e.events[len(e.events)-50:]
	}
}

func (e *Engine) Snapshot() map[string]any {
	e.lock.RLock()
	defer e.lock.RUnlock()

	reqMap := make(map[string]*MRequest)
	activeList := make([]*MRequest, 0)
	historyList := make([]*MRequest, 0)
	for k, v := range e.Requests {
		reqMap[fmt.Sprintf("%d", k)] = v
		if v.Status != "done" && v.Status != "cancelled" {
			activeList = append(activeList, v)
		} else {
			historyList = append(historyList, v)
		}
	}

	blockedList := make([]string, 0)
	for edgeID, b := range e.BlockedEdges {
		if b {
			blockedList = append(blockedList, edgeID)
		}
	}

	totalTechs := len(e.Techs)
	freeTechs := 0
	for _, t := range e.Techs {
		if t.Status == "free" && t.OnShift {
			freeTechs++
		}
	}

	parkedAc := 0
	inboundAc := 0
	departingAc := 0
	for _, a := range e.Aircraft {
		switch a.Status {
		case "parked":
			parkedAc++
		case "inbound":
			inboundAc++
		case "departing":
			departingAc++
		default:
			parkedAc++
		}
	}

	stats := map[string]any{
		"techs_total":        totalTechs,
		"techs_free":         freeTechs,
		"active":             len(activeList),
		"waiting":            0,
		"done":               len(historyList),
		"avg_response":       nil,
		"norm_pct":           100,
		"aircraft_total":     len(e.Aircraft),
		"aircraft_parked":    parkedAc,
		"aircraft_inbound":   inboundAc,
		"aircraft_departing": departingAc,
		"gse_total":          0,
		"gse_busy":           0,
	}

	gseTypes := map[string]any{
		"fuel":       map[string]any{"label": "Топливозаправщик", "color": "#E5A93C", "short": "ТЗП", "lane": 1},
		"catering":   map[string]any{"label": "Кейтеринг", "color": "#7699C2", "short": "КТР", "lane": 2},
		"baggage":    map[string]any{"label": "Багажный тягач", "color": "#A391C2", "short": "БАГ", "lane": 1},
		"cleaning":   map[string]any{"label": "Клининг", "color": "#67A985", "short": "КЛН", "lane": 2},
		"tow":        map[string]any{"label": "Буксировщик", "color": "#D99A42", "short": "ТЯГ", "lane": 0},
		"deicing":    map[string]any{"label": "Противообледенитель", "color": "#58B5C2", "short": "ПОЖ", "lane": 0},
		"ground_pwr": map[string]any{"label": "УКП (питание)", "color": "#C476A8", "short": "УКП", "lane": 1},
	}

	return map[string]any{
		"sim_time":      e.simTime,
		"sim_speed":     e.simSpeed,
		"sim_running":   e.simRunning,
		"norm":          900,
		"aircraft":      e.Aircraft,
		"techs":         e.Techs,
		"vehicles":      []any{},
		"gse":           []any{},
		"vehicle_speed": 10.0,
		"gse_types":     gseTypes,
		"requests":      reqMap,
		"active":        activeList,
		"history":       historyList,
		"blocked":       blockedList,
		"events":        e.events,
		"stats":         stats,
		"airport_name":  e.AirportName,
		"llm": map[string]any{
			"mode":  "builtin",
			"model": "встроенный",
		},
	}
}

func (e *Engine) EngineerSnapshot(techID *int64) map[string]any {
	e.lock.RLock()
	defer e.lock.RUnlock()

	reqMap := make(map[string]*MRequest)
	activeList := make([]*MRequest, 0)
	var myReq *MRequest
	tid := 0
	if techID != nil {
		tid = int(*techID)
	}

	var myTech *Tech
	for _, t := range e.Techs {
		if t.ID == tid {
			myTech = t
			break
		}
	}

	for k, v := range e.Requests {
		if v.TechID != nil && *v.TechID == tid {
			reqMap[fmt.Sprintf("%d", k)] = v
			if v.Status != "done" && v.Status != "cancelled" {
				activeList = append(activeList, v)
			}
			if v.Status == "assigned" || v.Status == "enroute" || v.Status == "arrived" || v.Status == "working" {
				myReq = v
			}
		}
	}

	snap := e.Snapshot()
	snap["requests"] = reqMap
	snap["active"] = activeList
	snap["my_request"] = myReq
	if myTech != nil {
		snap["me"] = myTech
	}
	return snap
}
