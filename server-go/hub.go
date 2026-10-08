package main

// hub.go —— 局域网发现与信令协议（与 server/index.mjs 保持同一套协议，protocol = 1）
//
// 浏览器侧完全不用区分后端是 Node 还是 Go：
//   客户端 -> 服务端: hello / rename / request / response / signal / bye
//   服务端 -> 客户端: welcome / hello-ok / roster / request / response / signal / session-end / error
//
// 注意：这里只转发「建立 WebRTC 直连所需的一小段短码」，
// 聊天内容与文件数据完全不经过本服务。

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sync"
	"time"
)

const (
	protocolVersion = 1
	appVersion      = "1.0.0"

	maxNameRunes    = 24
	maxPeerIDLength = 64
	maxSignalLength = 64 * 1024
	requestCooldown = 1500 * time.Millisecond
	heartbeatPeriod = 30 * time.Second
)

var peerIDPattern = regexp.MustCompile(`^[\w.:-]+$`)

/* ---------------- 协议消息 ---------------- */

type inMessage struct {
	T       string `json:"t"`
	PeerID  string `json:"peerId"`
	Name    string `json:"name"`
	To      string `json:"to"`
	Accept  *bool  `json:"accept"`
	Reason  string `json:"reason"`
	Payload string `json:"payload"`
}

type rosterEntry struct {
	PeerID string `json:"peerId"`
	Name   string `json:"name"`
	Busy   bool   `json:"busy"`
}

type rosterOut struct {
	T     string        `json:"t"`
	Peers []rosterEntry `json:"peers"`
}

type welcomeOut struct {
	T          string `json:"t"`
	Protocol   int    `json:"protocol"`
	ServerName string `json:"serverName"`
	Version    string `json:"version"`
}

type helloOKOut struct {
	T          string `json:"t"`
	PeerID     string `json:"peerId"`
	ServerName string `json:"serverName"`
}

type errorOut struct {
	T       string `json:"t"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type requestOut struct {
	T    string `json:"t"`
	From string `json:"from"`
	Name string `json:"name"`
}

type responseOut struct {
	T      string `json:"t"`
	From   string `json:"from"`
	Accept bool   `json:"accept"`
	Reason string `json:"reason,omitempty"`
}

type signalOut struct {
	T       string `json:"t"`
	From    string `json:"from"`
	Payload string `json:"payload"`
}

type sessionEndOut struct {
	T      string `json:"t"`
	PeerID string `json:"peerId"`
	Reason string `json:"reason,omitempty"`
}

/* ---------------- 状态 ---------------- */

type peer struct {
	id        string
	name      string
	conn      *wsConn
	partnerID string // 已配对（同意连接）的对端
	pendingID string // 正在互相确认的连接请求
	lastReq   time.Time
	joinedAt  time.Time
}

// outMsg 是「先解锁、再发送」用的出站消息，直接绑定连接，避免重查时的竞态。
type outMsg struct {
	conn *wsConn
	text string
}

type hub struct {
	mu         sync.Mutex
	peers      map[string]*peer
	serverName string
	quiet      bool
	stopCh     chan struct{}
	stopOnce   sync.Once
}

func newHub(serverName string, quiet bool) *hub {
	return &hub{
		peers:      make(map[string]*peer),
		serverName: serverName,
		quiet:      quiet,
		stopCh:     make(chan struct{}),
	}
}

func (h *hub) logf(format string, args ...any) {
	if h.quiet {
		return
	}
	fmt.Printf("[%s] %s\n", time.Now().Format("15:04:05"), fmt.Sprintf(format, args...))
}

func mustJSON(v any) string {
	data, err := json.Marshal(v)
	if err != nil {
		return `{"t":"error","code":"encode-failed","message":"服务端编码失败"}`
	}
	return string(data)
}

func (h *hub) flush(list []outMsg) {
	for _, item := range list {
		item.conn.Send(item.text)
	}
}

func (h *hub) PeerCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.peers)
}

// RosterSnapshot 返回当前在线名单快照（供 /api/info 与测试使用）。
func (h *hub) RosterSnapshot() []rosterEntry {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.rosterLocked().Peers
}

// rosterLocked 生成在线名单（调用方需持有 h.mu）。
func (h *hub) rosterLocked() rosterOut {
	entries := make([]rosterEntry, 0, len(h.peers))
	for _, p := range h.peers {
		entries = append(entries, rosterEntry{PeerID: p.id, Name: p.name, Busy: p.partnerID != ""})
	}
	return rosterOut{T: "roster", Peers: entries}
}

func (h *hub) broadcastLocked(roster rosterOut) []outMsg {
	text := mustJSON(roster)
	list := make([]outMsg, 0, len(h.peers))
	for _, p := range h.peers {
		list = append(list, outMsg{conn: p.conn, text: text})
	}
	return list
}

// endSessionLocked 解除会话并返回需要通知对端的消息（调用方需持有 h.mu）。
func (h *hub) endSessionLocked(id, reason string) []outMsg {
	p := h.peers[id]
	if p == nil {
		return nil
	}
	partnerID := p.partnerID
	p.partnerID = ""
	p.pendingID = ""
	if partnerID == "" {
		return nil
	}
	q := h.peers[partnerID]
	if q == nil {
		return nil
	}
	q.partnerID = ""
	q.pendingID = ""
	return []outMsg{{conn: q.conn, text: mustJSON(sessionEndOut{T: "session-end", PeerID: id, Reason: reason})}}
}

// isCurrent 判断连接是否仍是在线名单里的那个（被同 id 新连接取代后即失效）。
func (h *hub) isCurrent(p *peer) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.peers[p.id] == p
}

/* ---------------- 连接生命周期 ---------------- */

func (h *hub) HandleConn(c *wsConn) {
	var current *peer // 仅在读取 goroutine 中访问

	c.OnText = func(text string) { h.onText(&current, c, text) }
	c.OnClose = func() { h.onClose(&current) }
	c.Send(mustJSON(welcomeOut{
		T:          "welcome",
		Protocol:   protocolVersion,
		ServerName: h.serverName,
		Version:    appVersion,
	}))
}

func (h *hub) onClose(current **peer) {
	p := *current
	if p == nil {
		return
	}
	h.mu.Lock()
	if h.peers[p.id] != p {
		h.mu.Unlock()
		return
	}
	out := h.endSessionLocked(p.id, "offline")
	delete(h.peers, p.id)
	roster := h.rosterLocked()
	list := h.broadcastLocked(roster)
	count := len(h.peers)
	h.mu.Unlock()

	h.flush(out)
	h.flush(list)
	h.logf("%s 离线了，当前在线 %d 人", p.name, count)
}

func (h *hub) onText(current **peer, c *wsConn, raw string) {
	var msg inMessage
	if err := json.Unmarshal([]byte(raw), &msg); err != nil {
		c.Send(mustJSON(errorOut{T: "error", Code: "bad-json", Message: "消息不是合法 JSON"}))
		return
	}
	if msg.T == "" {
		c.Send(mustJSON(errorOut{T: "error", Code: "bad-message", Message: "消息缺少类型字段"}))
		return
	}
	if msg.T == "hello" {
		h.handleHello(current, c, msg)
		return
	}
	p := *current
	if p == nil {
		c.Send(mustJSON(errorOut{T: "error", Code: "not-registered", Message: "请先发送 hello 注册"}))
		return
	}
	if !h.isCurrent(p) {
		return // 已被同 id 的新连接取代，忽略
	}

	switch msg.T {
	case "rename":
		h.handleRename(p, msg)
	case "request":
		h.handleRequest(p, msg)
	case "response":
		h.handleResponse(p, msg)
	case "signal":
		h.handleSignal(p, msg)
	case "bye":
		h.handleBye(p, msg)
	default:
		c.Send(mustJSON(errorOut{T: "error", Code: "unknown-type", Message: "未知消息类型：" + msg.T}))
	}
}

func (h *hub) handleHello(current **peer, c *wsConn, msg inMessage) {
	id := sanitizePeerID(msg.PeerID)
	if id == "" {
		c.Send(mustJSON(errorOut{T: "error", Code: "bad-peer-id", Message: "peerId 非法"}))
		return
	}
	name := sanitizeName(msg.Name)

	var replaced *wsConn
	h.mu.Lock()
	if old, ok := h.peers[id]; ok && old.conn != c {
		replaced = old.conn
		h.endSessionLocked(id, "replaced")
	}
	p := &peer{id: id, name: name, conn: c, joinedAt: time.Now()}
	h.peers[id] = p
	roster := h.rosterLocked()
	list := h.broadcastLocked(roster)
	count := len(h.peers)
	h.mu.Unlock()

	*current = p
	if replaced != nil {
		replaced.Close(4000, "该身份在别处重新连接")
	}
	c.Send(mustJSON(helloOKOut{T: "hello-ok", PeerID: id, ServerName: h.serverName}))
	h.flush(list)
	h.logf("%s 上线了（%s），当前在线 %d 人", name, id, count)
}

func (h *hub) handleRename(p *peer, msg inMessage) {
	name := sanitizeName(msg.Name)
	h.mu.Lock()
	p.name = name
	roster := h.rosterLocked()
	list := h.broadcastLocked(roster)
	h.mu.Unlock()
	h.flush(list)
	h.logf("%s 改名为「%s」", p.id, name)
}

func (h *hub) handleRequest(p *peer, msg inMessage) {
	h.mu.Lock()
	if p.partnerID != "" {
		h.mu.Unlock()
		p.conn.Send(mustJSON(errorOut{T: "error", Code: "busy", Message: "你已经在与别人连接中"}))
		return
	}
	now := time.Now()
	if now.Sub(p.lastReq) < requestCooldown {
		h.mu.Unlock()
		p.conn.Send(mustJSON(errorOut{T: "error", Code: "too-fast", Message: "操作太快了，请稍后再试"}))
		return
	}
	p.lastReq = now

	targetID := sanitizePeerID(msg.To)
	target := h.peers[targetID]
	switch {
	case target == nil:
		h.mu.Unlock()
		p.conn.Send(mustJSON(errorOut{T: "error", Code: "not-found", Message: "对方已离线"}))
		return
	case target.id == p.id:
		h.mu.Unlock()
		p.conn.Send(mustJSON(errorOut{T: "error", Code: "self", Message: "不能连接自己"}))
		return
	case target.partnerID != "":
		reject := outMsg{conn: p.conn, text: mustJSON(responseOut{T: "response", From: target.id, Accept: false, Reason: "对方正在连接中"})}
		h.mu.Unlock()
		h.flush([]outMsg{reject})
		p.conn.Send(mustJSON(errorOut{T: "error", Code: "busy", Message: "对方正在连接中"}))
		return
	case target.pendingID != "" && target.pendingID != p.id:
		h.mu.Unlock()
		p.conn.Send(mustJSON(errorOut{T: "error", Code: "busy", Message: "对方正在处理另一个连接请求"}))
		return
	}

	p.pendingID = target.id
	target.pendingID = p.id
	notice := outMsg{conn: target.conn, text: mustJSON(requestOut{T: "request", From: p.id, Name: p.name})}
	fromName, toName := p.name, target.name
	h.mu.Unlock()

	h.flush([]outMsg{notice})
	h.logf("%s 请求连接 %s", fromName, toName)
}

func (h *hub) handleResponse(p *peer, msg inMessage) {
	targetID := sanitizePeerID(msg.To)

	h.mu.Lock()
	target := h.peers[targetID]
	if target == nil {
		h.mu.Unlock()
		p.conn.Send(mustJSON(errorOut{T: "error", Code: "not-found", Message: "对方已离线"}))
		return
	}
	if target.pendingID != p.id {
		h.mu.Unlock()
		p.conn.Send(mustJSON(errorOut{T: "error", Code: "no-request", Message: "没有来自对方的连接请求"}))
		return
	}
	target.pendingID = ""
	p.pendingID = ""

	accepted := msg.Accept != nil && *msg.Accept
	if !accepted {
		reason := truncateRunes(msg.Reason, 40)
		if reason == "" {
			reason = "对方拒绝了连接"
		}
		out := outMsg{conn: target.conn, text: mustJSON(responseOut{T: "response", From: p.id, Accept: false, Reason: reason})}
		roster := h.rosterLocked()
		list := h.broadcastLocked(roster)
		names := p.name + " 拒绝了 " + target.name
		h.mu.Unlock()
		h.flush(append([]outMsg{out}, list...))
		h.logf("%s 的连接请求", names)
		return
	}

	if p.partnerID != "" || target.partnerID != "" {
		out := outMsg{conn: target.conn, text: mustJSON(responseOut{T: "response", From: p.id, Accept: false, Reason: "对方正忙"})}
		h.mu.Unlock()
		h.flush([]outMsg{out})
		p.conn.Send(mustJSON(errorOut{T: "error", Code: "busy", Message: "有一方已经进入其它连接"}))
		return
	}

	p.partnerID = target.id
	target.partnerID = p.id
	out := outMsg{conn: target.conn, text: mustJSON(responseOut{T: "response", From: p.id, Accept: true})}
	roster := h.rosterLocked()
	list := h.broadcastLocked(roster)
	names := p.name + " 同意了 " + target.name
	h.mu.Unlock()

	h.flush(append([]outMsg{out}, list...))
	h.logf("%s 的连接，开始交换信令", names)
}

func (h *hub) handleSignal(p *peer, msg inMessage) {
	payload := msg.Payload
	if payload == "" || len(payload) > maxSignalLength {
		p.conn.Send(mustJSON(errorOut{T: "error", Code: "bad-payload", Message: "信令内容非法或过长"}))
		return
	}
	targetID := sanitizePeerID(msg.To)

	h.mu.Lock()
	target := h.peers[targetID]
	if target == nil {
		h.mu.Unlock()
		p.conn.Send(mustJSON(errorOut{T: "error", Code: "not-found", Message: "对方已离线"}))
		return
	}
	if p.partnerID != target.id {
		h.mu.Unlock()
		p.conn.Send(mustJSON(errorOut{T: "error", Code: "not-paired", Message: "尚未与该用户建立连接"}))
		return
	}
	out := outMsg{conn: target.conn, text: mustJSON(signalOut{T: "signal", From: p.id, Payload: payload})}
	h.mu.Unlock()
	h.flush([]outMsg{out})
}

func (h *hub) handleBye(p *peer, msg inMessage) {
	targetID := sanitizePeerID(msg.To)
	h.mu.Lock()
	if p.partnerID == "" || (targetID != "" && p.partnerID != targetID) {
		h.mu.Unlock()
		return
	}
	name := p.name
	out := h.endSessionLocked(p.id, "bye")
	roster := h.rosterLocked()
	list := h.broadcastLocked(roster)
	h.mu.Unlock()

	h.flush(out)
	h.flush(list)
	h.logf("%s 断开了连接", name)
}

/* ---------------- 心跳 ---------------- */

func (h *hub) StartHeartbeat() {
	go func() {
		ticker := time.NewTicker(heartbeatPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-h.stopCh:
				return
			case <-ticker.C:
				h.mu.Lock()
				var dead []*wsConn
				var pings []*wsConn
				for id, p := range h.peers {
					if !p.conn.IsAlive() {
						dead = append(dead, p.conn)
						delete(h.peers, id)
						continue
					}
					pings = append(pings, p.conn)
				}
				h.mu.Unlock()
				for _, c := range dead {
					c.Close(1006, "心跳超时")
				}
				for _, c := range pings {
					c.Ping()
				}
			}
		}
	}()
}

func (h *hub) Stop() {
	h.stopOnce.Do(func() { close(h.stopCh) })
	h.mu.Lock()
	conns := make([]*wsConn, 0, len(h.peers))
	for _, p := range h.peers {
		conns = append(conns, p.conn)
	}
	h.peers = make(map[string]*peer)
	h.mu.Unlock()
	for _, c := range conns {
		c.Close(1001, "服务端关闭")
	}
}

/* ---------------- 输入清洗 ---------------- */

func sanitizeName(value string) string {
	cleaned := make([]rune, 0, len(value))
	for _, r := range value {
		if r == '\r' || r == '\n' || r == '\t' {
			r = ' '
		}
		cleaned = append(cleaned, r)
	}
	name := trimSpaceRunes(cleaned)
	if len(name) > maxNameRunes {
		name = name[:maxNameRunes]
	}
	if name == "" {
		return "匿名用户"
	}
	return name
}

func sanitizePeerID(value string) string {
	id := trimSpace(value)
	if id == "" || len(id) > maxPeerIDLength {
		return ""
	}
	if !peerIDPattern.MatchString(id) {
		return ""
	}
	return id
}

func truncateRunes(value string, limit int) string {
	runes := []rune(trimSpace(value))
	if len(runes) > limit {
		runes = runes[:limit]
	}
	return string(runes)
}

func trimSpace(value string) string {
	start, end := 0, len(value)
	for start < end && isSpaceByte(value[start]) {
		start++
	}
	for end > start && isSpaceByte(value[end-1]) {
		end--
	}
	return value[start:end]
}

func isSpaceByte(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r' || b == '\v' || b == '\f'
}

func trimSpaceRunes(value []rune) string {
	start, end := 0, len(value)
	for start < end && isSpaceRune(value[start]) {
		start++
	}
	for end > start && isSpaceRune(value[end-1]) {
		end--
	}
	return string(value[start:end])
}

func isSpaceRune(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\r', '\v', '\f', 0x85, 0xA0:
		return true
	}
	return false
}
