package main

// hub_test.go —— 发现/信令协议测试（对着真实 TCP + 真实 WebSocket 握手跑）

import (
	"testing"
	"time"
)

func rosterNames(t *testing.T, client *wsTestClient, want int) []string {
	t.Helper()
	message := client.waitForWhere(func(m map[string]any) bool {
		peers, ok := m["peers"].([]any)
		return m["t"] == "roster" && ok && len(peers) == want
	}, "名单人数")
	peers := message["peers"].([]any)
	names := make([]string, 0, len(peers))
	for _, item := range peers {
		entry := item.(map[string]any)
		names = append(names, entry["name"].(string))
	}
	return names
}

func TestRosterAfterHello(t *testing.T) {
	server, instance := newTestServer(t, "测试房", t.TempDir())
	a := dialWSOrFail(t, server.URL)
	b := dialWSOrFail(t, server.URL)

	a.hello("peer-a", "小明")
	b.hello("peer-b", "小红")

	names := rosterNames(t, a, 2)
	found := map[string]bool{}
	for _, name := range names {
		found[name] = true
	}
	if !found["小明"] || !found["小红"] {
		t.Fatalf("名单内容不对: %v", names)
	}
	if instance.PeerCount() != 2 {
		t.Fatalf("在线人数应为 2，实际 %d", instance.PeerCount())
	}
}

func TestRenameBroadcast(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())
	a := dialWSOrFail(t, server.URL)
	b := dialWSOrFail(t, server.URL)
	a.hello("peer-a", "小明")
	b.hello("peer-b", "小红")
	rosterNames(t, b, 2)

	a.sendJSON(t, map[string]any{"t": "rename", "name": "小明二号"})
	names := rosterNames(t, b, 2)
	found := false
	for _, name := range names {
		if name == "小明二号" {
			found = true
		}
	}
	if !found {
		t.Fatalf("改名没有广播出去: %v", names)
	}
}

func TestRequestAcceptThenSignalBothWays(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())
	a := dialWSOrFail(t, server.URL)
	b := dialWSOrFail(t, server.URL)
	a.hello("peer-a", "小明")
	b.hello("peer-b", "小红")
	rosterNames(t, a, 2)

	a.sendJSON(t, map[string]any{"t": "request", "to": "peer-b"})
	request := b.waitForType("request")
	if request["from"] != "peer-a" || request["name"] != "小明" {
		t.Fatalf("连接请求内容不对: %v", request)
	}

	b.sendJSON(t, map[string]any{"t": "response", "to": "peer-a", "accept": true})
	response := a.waitForType("response")
	if response["accept"] != true {
		t.Fatalf("应答应为同意: %v", response)
	}

	// 双方进入忙碌状态
	message := a.waitForWhere(func(m map[string]any) bool {
		peers, ok := m["peers"].([]any)
		if m["t"] != "roster" || !ok || len(peers) != 2 {
			return false
		}
		for _, item := range peers {
			if item.(map[string]any)["busy"] != true {
				return false
			}
		}
		return true
	}, "双方忙碌")
	if message == nil {
		t.Fatal("没有收到忙碌名单")
	}

	// 信令双向转发
	a.sendJSON(t, map[string]any{"t": "signal", "to": "peer-b", "payload": "P2P1-offer"})
	if got := b.waitForType("signal"); got["payload"] != "P2P1-offer" {
		t.Fatalf("A->B 信令错误: %v", got)
	}
	b.sendJSON(t, map[string]any{"t": "signal", "to": "peer-a", "payload": "P2P1-answer"})
	if got := a.waitForType("signal"); got["payload"] != "P2P1-answer" {
		t.Fatalf("B->A 信令错误: %v", got)
	}
}

func TestRejectNotifiesRequesterWithReason(t *testing.T) {
	server, instance := newTestServer(t, "测试房", t.TempDir())
	a := dialWSOrFail(t, server.URL)
	b := dialWSOrFail(t, server.URL)
	a.hello("peer-a", "小明")
	b.hello("peer-b", "小红")
	rosterNames(t, a, 2)

	a.sendJSON(t, map[string]any{"t": "request", "to": "peer-b"})
	b.waitForType("request")
	b.sendJSON(t, map[string]any{"t": "response", "to": "peer-a", "accept": false, "reason": "现在不方便"})

	response := a.waitForType("response")
	if response["accept"] != false {
		t.Fatalf("应为拒绝: %v", response)
	}
	if response["reason"] != "现在不方便" {
		t.Fatalf("拒绝原因不对: %v", response["reason"])
	}

	// 拒绝后双方都应回到空闲
	time.Sleep(50 * time.Millisecond)
	for _, entry := range instance.RosterSnapshot() {
		if entry.Busy {
			t.Fatalf("拒绝后不应处于忙碌: %+v", entry)
		}
	}
}

func TestUnpairedThirdPartyCannotSignal(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())
	a := dialWSOrFail(t, server.URL)
	b := dialWSOrFail(t, server.URL)
	c := dialWSOrFail(t, server.URL)
	a.hello("peer-a", "小明")
	b.hello("peer-b", "小红")
	c.hello("peer-c", "路人")
	rosterNames(t, c, 3)

	c.sendJSON(t, map[string]any{"t": "signal", "to": "peer-a", "payload": "偷偷发"})
	c.waitForError("not-paired")

	time.Sleep(100 * time.Millisecond)
	if a.countOf("signal") != 0 {
		t.Fatalf("未配对者的信令不应被转发，A 却收到了: %d 条", a.countOf("signal"))
	}
}

func TestBusyTargetRejectsNewRequest(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())
	a := dialWSOrFail(t, server.URL)
	b := dialWSOrFail(t, server.URL)
	c := dialWSOrFail(t, server.URL)
	a.hello("peer-a", "小明")
	b.hello("peer-b", "小红")
	c.hello("peer-c", "路人")
	rosterNames(t, c, 3)

	a.sendJSON(t, map[string]any{"t": "request", "to": "peer-b"})
	b.waitForType("request")
	b.sendJSON(t, map[string]any{"t": "response", "to": "peer-a", "accept": true})
	a.waitForType("response")

	c.sendJSON(t, map[string]any{"t": "request", "to": "peer-b"})
	response := c.waitForType("response")
	if response["accept"] != false {
		t.Fatalf("目标忙碌时应拒绝: %v", response)
	}
}

func TestOfflineEndsSession(t *testing.T) {
	server, instance := newTestServer(t, "测试房", t.TempDir())
	a := dialWSOrFail(t, server.URL)
	b := dialWSOrFail(t, server.URL)
	a.hello("peer-a", "小明")
	b.hello("peer-b", "小红")
	rosterNames(t, b, 2)

	a.sendJSON(t, map[string]any{"t": "request", "to": "peer-b"})
	b.waitForType("request")
	b.sendJSON(t, map[string]any{"t": "response", "to": "peer-a", "accept": true})
	a.waitForType("response")

	a.Close()

	ended := b.waitForType("session-end")
	if ended["peerId"] != "peer-a" || ended["reason"] != "offline" {
		t.Fatalf("会话结束通知不对: %v", ended)
	}
	b.waitForWhere(func(m map[string]any) bool {
		peers, ok := m["peers"].([]any)
		return m["t"] == "roster" && ok && len(peers) == 1
	}, "离线后的名单")
	if instance.PeerCount() != 1 {
		t.Fatalf("离线后在线人数应为 1，实际 %d", instance.PeerCount())
	}
}

func TestByeEndsSessionWithoutDisconnect(t *testing.T) {
	server, instance := newTestServer(t, "测试房", t.TempDir())
	a := dialWSOrFail(t, server.URL)
	b := dialWSOrFail(t, server.URL)
	a.hello("peer-a", "小明")
	b.hello("peer-b", "小红")
	rosterNames(t, b, 2)

	a.sendJSON(t, map[string]any{"t": "request", "to": "peer-b"})
	b.waitForType("request")
	b.sendJSON(t, map[string]any{"t": "response", "to": "peer-a", "accept": true})
	a.waitForType("response")

	a.sendJSON(t, map[string]any{"t": "bye", "to": "peer-b"})
	ended := b.waitForType("session-end")
	if ended["reason"] != "bye" {
		t.Fatalf("bye 的会话结束原因不对: %v", ended)
	}
	if instance.PeerCount() != 2 {
		t.Fatalf("bye 之后两人应仍在线，实际 %d", instance.PeerCount())
	}
}

func TestInvalidMessages(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())
	client := dialWSOrFail(t, server.URL)
	client.waitForType("welcome")

	// 注册前
	client.sendJSON(t, map[string]any{"t": "nonsense"})
	client.waitForError("not-registered")

	// 非法 peerId
	client.sendJSON(t, map[string]any{"t": "hello", "peerId": "带 空格", "name": "x"})
	client.waitForError("bad-peer-id")

	// 正常注册
	client.hello("peer-ok", "小明")

	// 非 JSON
	client.sendText(t, "这不是 JSON")
	client.waitForError("bad-json")

	// 未知类型
	client.sendJSON(t, map[string]any{"t": "nonsense"})
	client.waitForError("unknown-type")
}

func TestDuplicatePeerIDReplacesOldConnection(t *testing.T) {
	server, instance := newTestServer(t, "测试房", t.TempDir())
	first := dialWSOrFail(t, server.URL)
	first.hello("same-id", "旧连接")

	second := dialWSOrFail(t, server.URL)
	second.hello("same-id", "新连接")

	code := first.waitClosed()
	if code != 4000 {
		t.Fatalf("旧连接应被以 4000 关闭，实际: %d", code)
	}
	if instance.PeerCount() != 1 {
		t.Fatalf("同一 id 只应占一个名额，实际 %d", instance.PeerCount())
	}
}

func TestSelfRequestRejected(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())
	client := dialWSOrFail(t, server.URL)
	client.hello("peer-a", "小明")

	client.sendJSON(t, map[string]any{"t": "request", "to": "peer-a"})
	client.waitForError("self")
}

func TestRequestToUnknownPeer(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())
	client := dialWSOrFail(t, server.URL)
	client.hello("peer-a", "小明")

	client.sendJSON(t, map[string]any{"t": "request", "to": "nobody"})
	client.waitForError("not-found")
}
