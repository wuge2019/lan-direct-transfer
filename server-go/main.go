package main

// main.go —— 局域网直连 · 发现与信令服务（Go 实现）
//
// 与 Node 版（server/index.mjs）功能等价、协议相同（protocol = 1），
// 区别只是编译成单个可执行文件、零第三方依赖：
//
//	go build -o lan-server .
//	./lan-server                 # 默认 0.0.0.0:8080
//	./lan-server -port 9000 -name "我的传输房"
//
// 它只做两件事：告诉浏览器「局域网里谁在线」，以及把建立 WebRTC 直连
// 所需的那一小段信令转给对方。聊天内容与文件数据不经过本服务。

import (
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const defaultPort = 8080
const portFallbackAttempts = 10

type config struct {
	port         int
	host         string
	name         string
	dir          string
	openBrowser  bool
	quiet        bool
	allowOrigins stringList
}

// stringList 支持重复传入 --allow-origin
type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(value string) error {
	*s = append(*s, value)
	return nil
}

func main() {
	cfg, showHelp := parseFlags(os.Args[1:])
	if showHelp {
		fmt.Print(helpText)
		return
	}
	if err := run(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "启动失败：%v\n", err)
		os.Exit(1)
	}
}

func parseFlags(args []string) (config, bool) {
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		hostname = "本机"
	}
	cfg := config{
		port:        defaultPort,
		host:        "0.0.0.0",
		name:        hostname + " 的传输房",
		dir:         "dist",
		openBrowser: true,
	}

	fs := flag.NewFlagSet("lan-direct-transfer", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	fs.IntVar(&cfg.port, "port", cfg.port, "监听端口")
	fs.IntVar(&cfg.port, "p", cfg.port, "监听端口（简写）")
	fs.StringVar(&cfg.host, "host", cfg.host, "监听地址")
	fs.StringVar(&cfg.name, "name", cfg.name, "房间名称")
	fs.StringVar(&cfg.name, "n", cfg.name, "房间名称（简写）")
	fs.StringVar(&cfg.dir, "dir", cfg.dir, "静态资源目录")
	fs.StringVar(&cfg.dir, "d", cfg.dir, "静态资源目录（简写）")
	fs.BoolVar(&cfg.openBrowser, "open", cfg.openBrowser, "启动后自动打开浏览器")
	fs.BoolVar(&cfg.quiet, "quiet", false, "不打印在线/离线日志")
	fs.Var(&cfg.allowOrigins, "allow-origin", "额外允许的 WebSocket Origin（可重复）")
	help := fs.Bool("help", false, "显示帮助")

	if err := fs.Parse(args); err != nil {
		return cfg, true
	}
	if *help {
		return cfg, true
	}
	return cfg, false
}

func run(cfg config) error {
	if cfg.port < 0 || cfg.port > 65535 {
		return fmt.Errorf("端口 %d 不合法", cfg.port)
	}
	if abs, err := filepath.Abs(cfg.dir); err == nil {
		cfg.dir = abs
	}

	listener, port, err := listenWithFallback(cfg.host, cfg.port)
	if err != nil {
		return err
	}
	cfg.port = port

	instance := newHub(cfg.name, cfg.quiet)
	instance.StartHeartbeat()

	handler := &http.Server{
		Handler:           buildMux(cfg, instance),
		ReadHeaderTimeout: 10 * time.Second,
	}

	printBanner(cfg)

	go func() {
		if err := handler.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fmt.Fprintf(os.Stderr, "服务异常退出：%v\n", err)
			os.Exit(1)
		}
	}()

	if cfg.openBrowser {
		if openBrowser("http://localhost:" + itoa(cfg.port)) {
			logf(cfg.quiet, "已尝试用默认浏览器打开 http://localhost:%d", cfg.port)
		}
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	<-signals
	fmt.Println("\n正在关闭服务…")
	instance.Stop()
	shutdownCtxDone := make(chan struct{})
	go func() {
		_ = handler.Close()
		close(shutdownCtxDone)
	}()
	select {
	case <-shutdownCtxDone:
	case <-time.After(2 * time.Second):
	}
	return nil
}

func buildMux(cfg config, instance *hub) http.Handler {
	static := &staticHandler{
		dir:        cfg.dir,
		hub:        instance,
		serverName: cfg.name,
		port:       cfg.port,
		startedAt:  time.Now(),
	}
	verifyOrigin := makeOriginVerifier(cfg.allowOrigins)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrade(w, r, defaultMaxPayload, verifyOrigin)
		if err != nil {
			return
		}
		instance.HandleConn(conn)
	})
	mux.Handle("/", static)
	return mux
}

/* ---------------- 监听与地址 ---------------- */

// listenWithFallback 端口被占用时自动往后找（与 Node 版行为一致）。
func listenWithFallback(host string, startPort int) (net.Listener, int, error) {
	var lastErr error
	for i := 0; i < portFallbackAttempts; i++ {
		port := startPort + i
		if startPort == 0 {
			port = 0
		}
		listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
		if err == nil {
			actual := port
			if addr, ok := listener.Addr().(*net.TCPAddr); ok {
				actual = addr.Port
			}
			return listener, actual, nil
		}
		lastErr = err
		if startPort == 0 {
			break
		}
	}
	return nil, 0, fmt.Errorf("无法监听 %s:%d（连续尝试 %d 个端口）：%v", host, startPort, portFallbackAttempts, lastErr)
}

// lanIPv4s 列出本机可用于局域网访问的 IPv4 地址。
func lanIPv4s() []string {
	var result []string
	interfaces, err := net.Interfaces()
	if err != nil {
		return result
	}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipNet.IP.To4()
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			result = append(result, ip.String())
		}
	}
	sort.Strings(result)
	return result
}

// makeOriginVerifier 默认只允许同源与本机 Origin，避免任意网站连上局域网服务。
// 额外说明：单文件版（file:// 打开）的 Origin 是字符串 "null"，这里也放行，
// 否则「单文件版 + 在设置里填服务地址」这条用法会失效。
func makeOriginVerifier(extra []string) func(*http.Request) bool {
	allowed := map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true}
	for _, ip := range lanIPv4s() {
		allowed[ip] = true
	}
	for _, item := range extra {
		if item != "" {
			allowed[item] = true
		}
	}

	return func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" || origin == "null" {
			return true
		}
		parsed, err := url.Parse(origin)
		if err != nil {
			return false
		}
		host := parsed.Hostname()
		if allowed[host] {
			return true
		}
		hostHeader := r.Host
		if index := strings.LastIndex(hostHeader, ":"); index > 0 && !strings.Contains(hostHeader, "]") {
			hostHeader = hostHeader[:index]
		}
		return hostHeader != "" && host == hostHeader
	}
}

/* ---------------- 输出与辅助 ---------------- */

func printBanner(cfg config) {
	fmt.Println()
	fmt.Println("  ┌──────────────────────────────────────────────┐")
	fmt.Println("  │   局域网直连 · 发现与信令服务已启动（Go）    │")
	fmt.Println("  └──────────────────────────────────────────────┘")
	fmt.Println()
	fmt.Printf("  房间名称：%s\n", cfg.name)
	fmt.Printf("  本机访问：http://localhost:%d\n", cfg.port)
	for _, ip := range lanIPv4s() {
		fmt.Printf("  局域网访问：http://%s:%d\n", ip, cfg.port)
	}
	fmt.Println()
	fmt.Println("  把这些局域网地址（或页面上的二维码）发给同事，浏览器打开即可互相看见。")
	fmt.Println("  文件与聊天内容不经过本服务，全部走 WebRTC 点对点直连。")
	fmt.Println("  按 Ctrl+C 停止。")
	fmt.Println()
}

func logf(quiet bool, format string, args ...any) {
	if quiet {
		return
	}
	fmt.Printf("[%s] %s\n", time.Now().Format("15:04:05"), fmt.Sprintf(format, args...))
}

func openBrowser(target string) bool {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", target)
	case "darwin":
		cmd = exec.Command("open", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	if err := cmd.Start(); err != nil {
		return false
	}
	go func() { _ = cmd.Wait() }()
	return true
}

func itoa(value int) string { return strconv.Itoa(value) }

const helpText = `
局域网直连 · 发现与信令服务（Go 实现）

  lan-server [选项]

  -port, -p <端口>      监听端口（默认 8080，被占用时自动往后找）
  -host <地址>          监听地址（默认 0.0.0.0，即局域网内可访问）
  -name, -n <名称>      房间名称（显示在客户端上，默认「<主机名> 的传输房」）
  -dir, -d <目录>       静态资源目录（默认当前目录下的 dist）
  -open                 启动后自动打开浏览器（默认开启；用 -open=false 关闭）
  -quiet                不打印在线/离线日志
  -allow-origin <主机>  额外允许的 WebSocket Origin（默认只允许同源与本机，可重复）
  -help                 显示本帮助
`
