package main

// websocket_test.go —— WebSocket 协议层测试（握手 / 分片 / 大帧 / 掩码 / 控制帧）

import (
	"encoding/binary"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestServer(t *testing.T, serverName string, dir string) (*httptest.Server, *hub) {
	t.Helper()
	instance := newHub(serverName, true)
	cfg := config{name: serverName, dir: dir, port: 8080, host: "127.0.0.1"}
	server := httptest.NewServer(buildMux(cfg, instance))
	t.Cleanup(func() {
		instance.Stop()
		server.Close()
	})
	return server, instance
}

func TestHandshakeAcceptedForSameOrigin(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())
	host := strings.TrimPrefix(server.URL, "http://")

	client, status := dialWS(t, server.URL, "http://"+host)
	if client == nil {
		t.Fatalf("同源握手应该成功，实际: %s", status)
	}
	welcome := client.waitForType("welcome")
	if welcome["protocol"] != float64(protocolVersion) {
		t.Fatalf("协议版本错误: %v", welcome["protocol"])
	}
	if welcome["serverName"] != "测试房" {
		t.Fatalf("房间名错误: %v", welcome["serverName"])
	}
}

func TestHandshakeRejectedForForeignOrigin(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())
	client, status := dialWS(t, server.URL, "http://evil.example.com")
	if client != nil {
		t.Fatal("陌生 Origin 应该被拒绝")
	}
	if !strings.Contains(status, "403") {
		t.Fatalf("期望 403，实际: %s", status)
	}
}

// 单文件版（file:// 打开）的 Origin 是字符串 "null"，必须放行，
// 否则「单文件版 + 设置里填服务地址」这条用法会失效。
func TestHandshakeAllowedForNullOrigin(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())
	client, status := dialWS(t, server.URL, "null")
	if client == nil {
		t.Fatalf("Origin: null 应该被允许，实际: %s", status)
	}
	client.waitForType("welcome")
}

func TestHandshakeRejectedWithoutUpgradeHeaders(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())

	// 用普通 HTTP 请求访问 /ws，应得到 400 而不是升级成功
	resp, err := httpGet(server.URL + "/ws")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	if resp != 400 && resp != 426 {
		t.Fatalf("期望 400/426，实际: %d", resp)
	}
}

func TestLargePayloadRoundTrip(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())
	a := dialWSOrFail(t, server.URL)
	b := dialWSOrFail(t, server.URL)

	a.hello("peer-a", "甲")
	b.hello("peer-b", "乙")
	a.waitForWhere(func(m map[string]any) bool {
		peers, ok := m["peers"].([]any)
		return m["t"] == "roster" && ok && len(peers) == 2
	}, "两人名单")

	a.sendJSON(t, map[string]any{"t": "request", "to": "peer-b"})
	b.waitForType("request")
	b.sendJSON(t, map[string]any{"t": "response", "to": "peer-a", "accept": true})
	a.waitForType("response")

	// 60KB 的信令（会走 16 位长度扩展与 64 位长度扩展两条路径）
	payload := strings.Repeat("P2P1-", 12000)
	a.sendJSON(t, map[string]any{"t": "signal", "to": "peer-b", "payload": payload})
	signal := b.waitForType("signal")
	if signal["payload"] != payload {
		t.Fatalf("大帧内容不一致：期望 %d 字节，实际 %v", len(payload), len(signal["payload"].(string)))
	}
}

func TestFragmentedTextMessageIsReassembled(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())
	client := dialWSOrFail(t, server.URL)
	client.waitForType("welcome")

	// 把一个 hello 拆成两个帧（首帧不带 FIN，第二帧为 continuation）
	full := []byte(`{"t":"hello","peerId":"frag-peer","name":"分片测试"}`)
	first := full[:10]
	second := full[10:]

	if err := client.writeFragment(opText, first, false); err != nil {
		t.Fatalf("写入首帧失败: %v", err)
	}
	if err := client.writeFragment(opContinuation, second, true); err != nil {
		t.Fatalf("写入续帧失败: %v", err)
	}

	helloOK := client.waitForType("hello-ok")
	if helloOK["peerId"] != "frag-peer" {
		t.Fatalf("分片重组后的注册失败: %v", helloOK)
	}
}

func TestUnmaskedClientFrameIsRejected(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())
	client := dialWSOrFail(t, server.URL)
	client.waitForType("welcome")

	// 手工构造一个「未加掩码」的文本帧（RFC 6455 规定客户端必须掩码）
	payload := []byte(`{"t":"hello","peerId":"x","name":"y"}`)
	frame := []byte{0x81, byte(len(payload))}
	frame = append(frame, payload...)
	if err := client.writeRaw(frame); err != nil {
		t.Fatalf("写入失败: %v", err)
	}

	code := client.waitClosed()
	if code != 1002 {
		t.Fatalf("期望以 1002 关闭，实际: %d", code)
	}
}

func TestOversizedFrameIsRejected(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())
	client := dialWSOrFail(t, server.URL)
	client.waitForType("welcome")

	// 声明一个远超上限（1MB）的长度：服务端应在读取头之后就拒绝
	header := []byte{0x81, 0x80 | 127}
	var ext [8]byte
	binary.BigEndian.PutUint64(ext[:], uint64(defaultMaxPayload)+1)
	header = append(header, ext[:]...)
	header = append(header, 0x01, 0x02, 0x03, 0x04) // 掩码键
	if err := client.writeRaw(header); err != nil {
		t.Fatalf("写入失败: %v", err)
	}

	code := client.waitClosed()
	if code != 1009 {
		t.Fatalf("期望以 1009 关闭，实际: %d", code)
	}
}

func TestServerRespondsToPing(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())
	client := dialWSOrFail(t, server.URL)
	client.waitForType("welcome")

	if err := client.writeFrame(opPing, []byte("hi")); err != nil {
		t.Fatalf("发送 ping 失败: %v", err)
	}
	client.waitForType("__pong")
}
