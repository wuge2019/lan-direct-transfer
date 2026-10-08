package main

// static.go —— 静态资源托管 + /api/info + SPA 兜底 + 目录穿越防护
//
// 与 server/index.mjs 的行为保持一致：接口路径、响应字段、缓存策略都相同，
// 因此前端可以无缝切换到任意一种后端。

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var mimeTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".ico":   "image/x-icon",
	".woff2": "font/woff2",
	".map":   "application/json; charset=utf-8",
	".txt":   "text/plain; charset=utf-8",
}

type infoResponse struct {
	App        string   `json:"app"`
	Protocol   int      `json:"protocol"`
	Version    string   `json:"version"`
	ServerName string   `json:"serverName"`
	Peers      int      `json:"peers"`
	URLs       []string `json:"urls"`
	StartedAt  int64    `json:"startedAt"`
}

type staticHandler struct {
	dir        string
	hub        *hub
	serverName string
	port       int
	startedAt  time.Time
}

func contentTypeFor(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	if value, ok := mimeTypes[ext]; ok {
		return value
	}
	return "application/octet-stream"
}

func (s *staticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestPath := r.URL.Path

	if requestPath == "/api/info" {
		s.serveInfo(w)
		return
	}
	if strings.HasPrefix(requestPath, "/api/") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not-found"})
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	indexPath := filepath.Join(s.dir, "index.html")

	serveIndex := func() {
		content, err := os.ReadFile(indexPath)
		if err != nil {
			content = []byte(missingBuildPage)
		}
		w.Header().Set("Content-Type", mimeTypes[".html"])
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(content)
	}

	// 目录穿越防护：Clean 掉 .. 之后再拼接，并二次确认仍在静态目录内
	cleaned := strings.TrimPrefix(filepath.ToSlash(filepath.Clean("/"+requestPath)), "/")
	target := filepath.Join(s.dir, filepath.FromSlash(cleaned))

	if requestPath == "/" || !isInsideDir(s.dir, target) {
		serveIndex()
		return
	}

	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		serveIndex() // SPA 兜底
		return
	}
	content, err := os.ReadFile(target)
	if err != nil {
		serveIndex()
		return
	}
	w.Header().Set("Content-Type", contentTypeFor(target))
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}

func (s *staticHandler) serveInfo(w http.ResponseWriter) {
	urls := make([]string, 0, 4)
	for _, ip := range lanIPv4s() {
		urls = append(urls, "http://"+ip+":"+itoa(s.port))
	}
	writeJSON(w, http.StatusOK, infoResponse{
		App:        "lan-direct-transfer",
		Protocol:   protocolVersion,
		Version:    appVersion,
		ServerName: s.serverName,
		Peers:      s.hub.PeerCount(),
		URLs:       urls,
		StartedAt:  s.startedAt.UnixMilli(),
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", mimeTypes[".json"])
	w.Header().Set("Cache-Control", "no-store")
	// 允许从别的来源探测本服务（例如静态托管的单文件版页面）
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)
	data, err := json.Marshal(value)
	if err != nil {
		return
	}
	_, _ = w.Write(data)
}

// isInsideDir 判断 target 是否位于 base 之内（防目录穿越）。
func isInsideDir(base, target string) bool {
	absBase, err1 := filepath.Abs(base)
	absTarget, err2 := filepath.Abs(target)
	if err1 != nil || err2 != nil {
		return false
	}
	if absBase == absTarget {
		return true
	}
	return strings.HasPrefix(absTarget, absBase+string(os.PathSeparator))
}

const missingBuildPage = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>还没有构建前端产物</title>
<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#0f1319;color:#e6ecf4;
padding:48px;line-height:1.8}code{background:#1c2430;padding:2px 8px;border-radius:6px;color:#8ecbff}</style>
</head><body><h2>还没有构建前端产物</h2>
<p>请在项目目录执行：</p><p><code>pnpm install</code><br><code>pnpm build</code></p>
<p>然后用 <code>-dir</code> 指向 dist 目录重新启动，或直接在该目录下启动本服务。</p>
</body></html>`
