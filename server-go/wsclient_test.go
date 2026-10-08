package main

// wsclient_test.go —— 测试用的最小 WebSocket 客户端
//
// 刻意不复用服务端代码：这样「客户端能否被真实实现接受」是独立验证的。
// 另外 tests/go-server.spec.ts 里还会用 Node 的 undici WebSocket
// 对着同一个 Go 服务再跑一遍，进一步交叉验证。

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const testFrameTimeout = 6 * time.Second

type wsWaiter struct {
	match func(map[string]any) bool
	ch    chan map[string]any
}

type wsTestClient struct {
	t      *testing.T
	conn   net.Conn
	reader *bufio.Reader

	writeMu sync.Mutex
	mu      sync.Mutex
	history []map[string]any
	queue   []map[string]any
	waiters []*wsWaiter
	closed  bool
	code    int
}

// dialWS 完成一次真实握手；返回状态行文本，便于断言 101 / 403。
func dialWS(t *testing.T, serverURL, origin string) (*wsTestClient, string) {
	t.Helper()
	addr := strings.TrimPrefix(serverURL, "http://")

	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("拨号失败: %v", err)
	}

	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		t.Fatalf("生成随机 key 失败: %v", err)
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)

	request := "GET /ws HTTP/1.1\r\n" +
		"Host: " + addr + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n"
	if origin != "" {
		request += "Origin: " + origin + "\r\n"
	}
	request += "\r\n"
	if _, err := conn.Write([]byte(request)); err != nil {
		t.Fatalf("握手请求写入失败: %v", err)
	}

	reader := bufio.NewReader(conn)
	statusLine, err := reader.ReadString('\n')
	if err != nil {
		conn.Close()
		t.Fatalf("读取握手响应失败: %v", err)
	}
	status := strings.TrimSpace(statusLine)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				break
			}
			conn.Close()
			t.Fatalf("读取响应头失败: %v", err)
		}
		if line == "\r\n" || line == "\n" {
			break
		}
	}

	if !strings.Contains(status, "101") {
		conn.Close()
		return nil, status
	}

	client := &wsTestClient{t: t, conn: conn, reader: reader}
	go client.readLoop()
	t.Cleanup(client.Close)
	return client, status
}

func dialWSOrFail(t *testing.T, serverURL string) *wsTestClient {
	t.Helper()
	client, status := dialWS(t, serverURL, "")
	if client == nil {
		t.Fatalf("握手失败: %s", status)
	}
	return client
}

func (c *wsTestClient) websocketURL(server *httptest.Server) string { return server.URL }

func (c *wsTestClient) readLoop() {
	for {
		fin, opcode, payload, err := c.readServerFrame()
		if err != nil {
			c.mu.Lock()
			c.closed = true
			c.mu.Unlock()
			return
		}
		switch opcode {
		case opText, opBinary:
			if !fin {
				continue
			}
			var message map[string]any
			if err := json.Unmarshal(payload, &message); err != nil {
				continue
			}
			c.deliver(message)
		case opPing:
			_ = c.writeFrame(opPong, payload)
		case opPong:
			c.deliver(map[string]any{"t": "__pong"})
		case opClose:
			code := 0
			if len(payload) >= 2 {
				code = int(binary.BigEndian.Uint16(payload[:2]))
			}
			c.mu.Lock()
			c.closed = true
			c.code = code
			c.mu.Unlock()
			return
		}
	}
}

// readServerFrame 读服务端发来的帧（按规范不加掩码，但仍兼容带掩码的情况）。
func (c *wsTestClient) readServerFrame() (bool, byte, []byte, error) {
	var header [2]byte
	if _, err := io.ReadFull(c.reader, header[:]); err != nil {
		return false, 0, nil, err
	}
	fin := header[0]&0x80 != 0
	opcode := header[0] & 0x0F
	masked := header[1]&0x80 != 0
	length := int64(header[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.reader, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.reader, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = int64(binary.BigEndian.Uint64(ext[:]))
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(c.reader, mask[:]); err != nil {
			return false, 0, nil, err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(c.reader, payload); err != nil {
		return false, 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i&3]
		}
	}
	return fin, opcode, payload, nil
}

func (c *wsTestClient) writeFrame(opcode byte, payload []byte) error {
	return c.writeFrameFin(opcode, payload, true)
}

// writeFragment 允许控制 FIN，用于测试分片重组。
func (c *wsTestClient) writeFragment(opcode byte, payload []byte, fin bool) error {
	return c.writeFrameFin(opcode, payload, fin)
}

func (c *wsTestClient) writeFrameFin(opcode byte, payload []byte, fin bool) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.conn == nil {
		return fmt.Errorf("连接已关闭")
	}

	first := opcode
	if fin {
		first |= 0x80
	}
	header := []byte{first}
	length := len(payload)
	switch {
	case length < 126:
		header = append(header, 0x80|byte(length))
	case length < 65536:
		header = append(header, 0x80|126, byte(length>>8), byte(length))
	default:
		header = append(header, 0x80|127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(length))
		header = append(header, ext[:]...)
	}
	mask := [4]byte{0x1f, 0x2e, 0x3d, 0x4c}
	header = append(header, mask[:]...)
	masked := make([]byte, length)
	for i, b := range payload {
		masked[i] = b ^ mask[i&3]
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err := c.conn.Write(append(header, masked...))
	return err
}

// httpGet 发一个普通 GET，返回状态码（用于验证非升级请求的处理）。
func httpGet(rawURL string) (int, error) {
	resp, err := http.Get(rawURL)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
}

// writeRaw 直接写原始字节（用于构造非法帧）
func (c *wsTestClient) writeRaw(data []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err := c.conn.Write(data)
	return err
}

func (c *wsTestClient) sendJSON(t *testing.T, payload map[string]any) {
	t.Helper()
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	if err := c.writeFrame(opText, data); err != nil {
		t.Fatalf("发送失败: %v", err)
	}
}

func (c *wsTestClient) sendText(t *testing.T, text string) {
	t.Helper()
	if err := c.writeFrame(opText, []byte(text)); err != nil {
		t.Fatalf("发送失败: %v", err)
	}
}

func (c *wsTestClient) deliver(message map[string]any) {
	c.mu.Lock()
	c.history = append(c.history, message)
	for i, waiter := range c.waiters {
		if waiter.match(message) {
			c.waiters = append(c.waiters[:i], c.waiters[i+1:]...)
			c.mu.Unlock()
			waiter.ch <- message
			return
		}
	}
	c.queue = append(c.queue, message)
	c.mu.Unlock()
}

func (c *wsTestClient) waitForWhere(match func(map[string]any) bool, label string) map[string]any {
	c.mu.Lock()
	for i, message := range c.queue {
		if match(message) {
			c.queue = append(c.queue[:i], c.queue[i+1:]...)
			c.mu.Unlock()
			return message
		}
	}
	waiter := &wsWaiter{match: match, ch: make(chan map[string]any, 1)}
	c.waiters = append(c.waiters, waiter)
	c.mu.Unlock()

	select {
	case message := <-waiter.ch:
		return message
	case <-time.After(testFrameTimeout):
		c.t.Fatalf("等待 %s 超时；已收到: %s", label, c.historyJSON())
		return nil
	}
}

func (c *wsTestClient) waitForType(messageType string) map[string]any {
	return c.waitForWhere(func(m map[string]any) bool { return m["t"] == messageType }, messageType)
}

func (c *wsTestClient) waitForError(code string) map[string]any {
	return c.waitForWhere(func(m map[string]any) bool {
		return m["t"] == "error" && m["code"] == code
	}, "error:"+code)
}

func (c *wsTestClient) countOf(messageType string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	count := 0
	for _, message := range c.history {
		if message["t"] == messageType {
			count++
		}
	}
	return count
}

func (c *wsTestClient) lastOf(messageType string) map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := len(c.history) - 1; i >= 0; i-- {
		if c.history[i]["t"] == messageType {
			return c.history[i]
		}
	}
	return nil
}

func (c *wsTestClient) historyJSON() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	data, _ := json.Marshal(c.history)
	return string(data)
}

func (c *wsTestClient) waitClosed() int {
	deadline := time.Now().Add(testFrameTimeout)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		closed, code := c.closed, c.code
		c.mu.Unlock()
		if closed {
			return code
		}
		time.Sleep(20 * time.Millisecond)
	}
	c.t.Fatalf("等待连接关闭超时；已收到: %s", c.historyJSON())
	return 0
}

func (c *wsTestClient) Close() {
	if c.conn != nil {
		_ = c.conn.Close()
	}
}

// hello 完成注册并等待 hello-ok
func (c *wsTestClient) hello(id, name string) {
	c.sendJSON(c.t, map[string]any{"t": "hello", "peerId": id, "name": name})
	c.waitForType("hello-ok")
}
