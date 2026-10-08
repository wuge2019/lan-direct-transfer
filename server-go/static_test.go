package main

// static_test.go —— 静态托管、/api/info、SPA 兜底与目录穿越防护

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("写入文件失败: %v", err)
	}
}

func fetch(t *testing.T, url string) (int, http.Header, string) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("请求 %s 失败: %v", url, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读取响应失败: %v", err)
	}
	return resp.StatusCode, resp.Header, string(body)
}

func TestAPIInfo(t *testing.T) {
	dir := t.TempDir()
	server, instance := newTestServer(t, "信息测试房", dir)

	client := dialWSOrFail(t, server.URL)
	client.hello("peer-a", "小明")
	client.waitForWhere(func(m map[string]any) bool {
		peers, ok := m["peers"].([]any)
		return m["t"] == "roster" && ok && len(peers) == 1
	}, "一人名单")

	status, header, body := fetch(t, server.URL+"/api/info")
	if status != 200 {
		t.Fatalf("状态码应为 200，实际 %d", status)
	}
	if header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("缺少跨域头: %v", header.Get("Access-Control-Allow-Origin"))
	}

	var info infoResponse
	if err := json.Unmarshal([]byte(body), &info); err != nil {
		t.Fatalf("解析 JSON 失败: %v (%s)", err, body)
	}
	if info.App != "lan-direct-transfer" || info.Protocol != protocolVersion {
		t.Fatalf("接口字段不对: %+v", info)
	}
	if info.ServerName != "信息测试房" {
		t.Fatalf("房间名不对: %s", info.ServerName)
	}
	if info.Peers != instance.PeerCount() || info.Peers != 1 {
		t.Fatalf("在线人数不对: %d", info.Peers)
	}
}

func TestUnknownAPIRouteReturns404(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())
	status, _, _ := fetch(t, server.URL+"/api/nope")
	if status != 404 {
		t.Fatalf("未知 /api 路径应 404，实际 %d", status)
	}
}

func TestServeIndexHTML(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "index.html"), "<html><body>HELLO-INDEX</body></html>")
	server, _ := newTestServer(t, "测试房", dir)

	status, header, body := fetch(t, server.URL+"/")
	if status != 200 {
		t.Fatalf("状态码应为 200，实际 %d", status)
	}
	if !strings.Contains(body, "HELLO-INDEX") {
		t.Fatalf("首页内容不对: %s", body)
	}
	if !strings.Contains(header.Get("Content-Type"), "text/html") {
		t.Fatalf("Content-Type 不对: %s", header.Get("Content-Type"))
	}
	if header.Get("Cache-Control") != "no-store" {
		t.Fatalf("首页应禁用缓存，实际: %s", header.Get("Cache-Control"))
	}
}

func TestMissingBuildPage(t *testing.T) {
	server, _ := newTestServer(t, "测试房", t.TempDir())
	_, _, body := fetch(t, server.URL+"/")
	if !strings.Contains(body, "还没有构建前端产物") {
		t.Fatalf("没有产物时应给出提示页，实际: %s", body)
	}
}

func TestNestedStaticFileServed(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "index.html"), "<html>INDEX</html>")
	writeFile(t, filepath.Join(dir, "assets", "app.js"), "console.log('hi')")
	server, _ := newTestServer(t, "测试房", dir)

	status, header, body := fetch(t, server.URL+"/assets/app.js")
	if status != 200 || body != "console.log('hi')" {
		t.Fatalf("静态文件读取失败: %d %s", status, body)
	}
	if !strings.Contains(header.Get("Content-Type"), "javascript") {
		t.Fatalf("JS 的 Content-Type 不对: %s", header.Get("Content-Type"))
	}
}

func TestPathTraversalBlocked(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "index.html"), "<html>INDEX</html>")

	// 在静态目录「外面」放一个机密文件，确认读不到
	secretPath := filepath.Join(filepath.Dir(dir), "secret.txt")
	writeFile(t, secretPath, "TOP-SECRET-CONTENT")
	t.Cleanup(func() { _ = os.Remove(secretPath) })

	server, _ := newTestServer(t, "测试房", dir)

	for _, attempt := range []string{
		"/../secret.txt",
		"/%2e%2e/secret.txt",
		"/%2e%2e%2fsecret.txt",
		"/..%2fsecret.txt",
		"/assets/../../secret.txt",
	} {
		_, _, body := fetch(t, server.URL+attempt)
		if strings.Contains(body, "TOP-SECRET-CONTENT") {
			t.Fatalf("目录穿越没有被挡住: %s 返回了目录外的文件", attempt)
		}
	}
}

func TestSPAFallbackForUnknownPath(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "index.html"), "<html>SPA-INDEX</html>")
	server, _ := newTestServer(t, "测试房", dir)

	_, _, body := fetch(t, server.URL+"/some/deep/route")
	if !strings.Contains(body, "SPA-INDEX") {
		t.Fatalf("未知路径应兜底到首页，实际: %s", body)
	}
}
