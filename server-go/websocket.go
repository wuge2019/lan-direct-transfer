package main

// websocket.go —— 极简 WebSocket 服务端实现（RFC 6455 子集，仅标准库）
//
// 为什么不用 gorilla/websocket 之类的库：
//   本项目希望「下载一个可执行文件就能跑」，不引入任何第三方依赖，
//   这样 go build 完全离线可用，也没有供应链面。
//   这里只需要文本帧、掩码校验、分片重组、ping/pong 与 close，
//   足够支撑局域网发现与信令转发。
//
// 与 server/websocket.mjs 是同一套行为，便于两个实现互相对照。

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const wsAcceptGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const (
	opContinuation byte = 0x0
	opText         byte = 0x1
	opBinary       byte = 0x2
	opClose        byte = 0x8
	opPing         byte = 0x9
	opPong         byte = 0xA
)

// 默认单条消息上限：信令码只有几百字节，1MB 已经非常宽松
const defaultMaxPayload int64 = 1024 * 1024

var (
	errProtocolViolation = errors.New("协议错误")
	errMessageTooLarge   = errors.New("消息过大")
)

// wsConn 是一条已升级完成的 WebSocket 连接。
//
// 写操作由独立的 writer goroutine 负责，业务侧只往队列里投递，
// 这样某个慢客户端不会阻塞整个 hub。
type wsConn struct {
	conn       net.Conn
	reader     *bufio.Reader
	maxPayload int64

	out      chan []byte
	done     chan struct{}
	closeOne sync.Once

	writeMu sync.Mutex // 仅用于 close 帧等直接写
	mu      sync.Mutex
	closed  bool

	aliveMu sync.Mutex
	alive   bool

	// OnText 收到一条完整文本消息时回调（在读取 goroutine 中同步调用）
	OnText func(string)
	// OnClose 连接结束时回调（保证只调用一次）
	OnClose func()
}

// upgrade 把 HTTP 连接升级为 WebSocket。
// verifyOrigin 返回 false 时直接以 403 拒绝。
func upgrade(w http.ResponseWriter, r *http.Request, maxPayload int64, verifyOrigin func(*http.Request) bool) (*wsConn, error) {
	if verifyOrigin != nil && !verifyOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return nil, errors.New("Origin 不被允许")
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		http.Error(w, "expected websocket upgrade", http.StatusBadRequest)
		return nil, errors.New("不是 websocket 升级请求")
	}
	if !hasToken(r.Header.Get("Connection"), "upgrade") {
		http.Error(w, "expected connection upgrade", http.StatusBadRequest)
		return nil, errors.New("缺少 Connection: Upgrade")
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		http.Error(w, "unsupported websocket version", http.StatusBadRequest)
		return nil, errors.New("不支持的 WebSocket 版本")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "missing sec-websocket-key", http.StatusBadRequest)
		return nil, errors.New("缺少 Sec-WebSocket-Key")
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack not supported", http.StatusInternalServerError)
		return nil, errors.New("当前 ResponseWriter 不支持 Hijack")
	}
	rawConn, rw, err := hijacker.Hijack()
	if err != nil {
		return nil, err
	}

	sum := sha1.Sum([]byte(key + wsAcceptGUID))
	accept := base64.StdEncoding.EncodeToString(sum[:])
	response := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
	if _, err := rw.WriteString(response); err != nil {
		rawConn.Close()
		return nil, err
	}
	if err := rw.Flush(); err != nil {
		rawConn.Close()
		return nil, err
	}

	if maxPayload <= 0 {
		maxPayload = defaultMaxPayload
	}
	c := &wsConn{
		conn:       rawConn,
		reader:     rw.Reader,
		maxPayload: maxPayload,
		out:        make(chan []byte, 128),
		done:       make(chan struct{}),
		alive:      true,
	}
	go c.writeLoop()
	go c.readLoop()
	return c, nil
}

func hasToken(header, token string) bool {
	for _, part := range strings.Split(header, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

/* ---------------- 发送 ---------------- */

// Send 投递一条文本消息；队列拥塞时最多等 5 秒，超时则断开该连接。
func (c *wsConn) Send(text string) bool {
	payload := []byte(text)
	select {
	case c.out <- payload:
		return true
	case <-c.done:
		return false
	case <-time.After(5 * time.Second):
		c.Close(1011, "发送超时")
		return false
	}
}

// Ping 发送心跳，用于探测半开连接。
func (c *wsConn) Ping() {
	c.aliveMu.Lock()
	c.alive = false
	c.aliveMu.Unlock()
	_ = c.writeFrame(opPing, nil)
}

// MarkAlive 收到 pong 时调用。
func (c *wsConn) MarkAlive() {
	c.aliveMu.Lock()
	c.alive = true
	c.aliveMu.Unlock()
}

// IsAlive 上次心跳后是否收到过 pong。
func (c *wsConn) IsAlive() bool {
	c.aliveMu.Lock()
	defer c.aliveMu.Unlock()
	return c.alive
}

// Close 发送 close 帧并断开。
func (c *wsConn) Close(code int, reason string) {
	c.mu.Lock()
	already := c.closed
	c.closed = true
	c.mu.Unlock()
	if already {
		return
	}
	payload := make([]byte, 2+len(reason))
	binary.BigEndian.PutUint16(payload[0:2], uint16(code))
	copy(payload[2:], reason)
	c.writeMu.Lock()
	c.writeFrameLocked(opClose, payload)
	c.writeMu.Unlock()
	c.closeOne.Do(func() {
		close(c.done)
		c.conn.Close()
	})
}

func (c *wsConn) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

func (c *wsConn) writeLoop() {
	for {
		select {
		case <-c.done:
			return
		case payload := <-c.out:
			if err := c.writeFrame(opText, payload); err != nil {
				c.Close(1006, "写入失败")
				return
			}
		}
	}
}

func (c *wsConn) writeFrame(opcode byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.writeFrameLocked(opcode, payload)
}

// writeFrameLocked 调用方需持有 writeMu。
func (c *wsConn) writeFrameLocked(opcode byte, payload []byte) error {
	if c.isClosed() && opcode != opClose {
		return errors.New("连接已关闭")
	}
	header := make([]byte, 0, 10)
	header = append(header, 0x80|opcode)
	length := len(payload)
	switch {
	case length < 126:
		header = append(header, byte(length))
	case length < 65536:
		header = append(header, 126, byte(length>>8), byte(length))
	default:
		header = append(header, 127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(length))
		header = append(header, ext[:]...)
	}

	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	buffers := net.Buffers{header}
	if length > 0 {
		buffers = append(buffers, payload)
	}
	_, err := buffers.WriteTo(c.conn)
	return err
}

/* ---------------- 接收 ---------------- */

func (c *wsConn) readLoop() {
	var (
		fragOpcode byte
		fragBuf    []byte
	)
	defer func() {
		c.closeOne.Do(func() {
			close(c.done)
			c.conn.Close()
		})
		if c.OnClose != nil {
			c.OnClose()
		}
	}()

	for {
		fin, opcode, payload, err := c.readFrame()
		if err != nil {
			switch {
			case errors.Is(err, errMessageTooLarge):
				c.Close(1009, "消息过大")
			case errors.Is(err, errProtocolViolation):
				c.Close(1002, "协议错误")
			}
			return
		}

		switch opcode {
		case opContinuation:
			if fragOpcode == 0 {
				c.Close(1002, "没有待续帧")
				return
			}
			fragBuf = append(fragBuf, payload...)
			if int64(len(fragBuf)) > c.maxPayload {
				c.Close(1009, "消息过大")
				return
			}
			if fin {
				c.deliver(fragOpcode, fragBuf)
				fragOpcode, fragBuf = 0, nil
			}
		case opText, opBinary:
			if fragOpcode != 0 {
				c.Close(1002, "分片消息未结束")
				return
			}
			if fin {
				c.deliver(opcode, payload)
			} else {
				fragOpcode, fragBuf = opcode, payload
			}
		case opClose:
			c.Close(1000, "")
			return
		case opPing:
			_ = c.writeFrame(opPong, payload)
		case opPong:
			c.MarkAlive()
		default:
			c.Close(1003, "不支持的操作码")
			return
		}
	}
}

func (c *wsConn) deliver(opcode byte, payload []byte) {
	if opcode != opText {
		return // 本服务只使用文本帧
	}
	if !utf8.Valid(payload) {
		c.Close(1007, "文本帧不是合法 UTF-8")
		return
	}
	if c.OnText != nil {
		c.OnText(string(payload))
	}
}

// readFrame 读取一个完整的帧（自动校验掩码并解掩码）。
func (c *wsConn) readFrame() (fin bool, opcode byte, payload []byte, err error) {
	var header [2]byte
	if _, err = io.ReadFull(c.reader, header[:]); err != nil {
		return
	}
	fin = header[0]&0x80 != 0
	if header[0]&0x70 != 0 {
		return false, 0, nil, errProtocolViolation // 不支持扩展
	}
	opcode = header[0] & 0x0F
	masked := header[1]&0x80 != 0
	length := int64(header[1] & 0x7F)

	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(c.reader, ext[:]); err != nil {
			return
		}
		length = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(c.reader, ext[:]); err != nil {
			return
		}
		value := binary.BigEndian.Uint64(ext[:])
		if value > uint64(c.maxPayload) {
			return false, 0, nil, errMessageTooLarge
		}
		length = int64(value)
	}

	if opcode >= 0x8 && (!fin || length > 125) {
		return false, 0, nil, errProtocolViolation // 控制帧不能分片且不超过 125 字节
	}
	if length > c.maxPayload {
		return false, 0, nil, errMessageTooLarge
	}
	if !masked {
		return false, 0, nil, errProtocolViolation // 客户端发来的帧必须掩码
	}

	var mask [4]byte
	if _, err = io.ReadFull(c.reader, mask[:]); err != nil {
		return
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(c.reader, payload); err != nil {
		return
	}
	for i := range payload {
		payload[i] ^= mask[i&3]
	}
	return fin, opcode, payload, nil
}
