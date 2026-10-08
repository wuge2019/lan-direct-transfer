# 局域网直连 · 发现与信令服务（Go 实现）

与 `../server/index.mjs`（Node 实现）**功能等价、协议相同**（`protocol = 1`），
前端不需要任何改动即可切换后端。

特点：**只用 Go 标准库**，零第三方依赖 —— `go build` 可完全离线执行，
产物是单个可执行文件，拷到任意一台机器（甚至没装 Node）就能跑。

## 构建与运行

```bash
cd server-go
go build -o lan-server .        # Windows 下产物为 lan-server.exe

./lan-server                    # 默认 0.0.0.0:8080，自动打开浏览器
./lan-server -port 9000 -name "会议室传输房"
./lan-server -dir ../dist       # 指定前端产物目录
./lan-server -open=false        # 不自动打开浏览器
```

启动后终端会打印本机与局域网访问地址，把这个地址（或页面上「邀请他人加入」里的二维码）
发给同事，他们用浏览器打开就能互相看见。

### 全部参数

| 参数 | 说明 |
| --- | --- |
| `-port`, `-p` | 监听端口（默认 8080，被占用时自动往后找） |
| `-host` | 监听地址（默认 `0.0.0.0`，即局域网内可访问） |
| `-name`, `-n` | 房间名称（显示在客户端上） |
| `-dir`, `-d` | 静态资源目录（默认当前目录下的 `dist`） |
| `-open` | 是否自动打开浏览器（默认开启，用 `-open=false` 关闭） |
| `-quiet` | 不打印在线/离线日志 |
| `-allow-origin` | 额外允许的 WebSocket Origin，可重复传入 |
| `-help` | 显示帮助 |

## 它做什么 / 不做什么

- **做**：托管前端页面、维护「谁在线」名单、转发连接请求与建立 WebRTC 直连所需的那一小段信令（约 300~600 字符）
- **不做**：不接触聊天内容与文件数据（那些全部走 WebRTC 点对点直连）、不落盘、无数据库

默认只接受**同源、本机**以及 `Origin: null`（单文件版用 `file://` 打开时的取值）的连接，
其它来源需要显式 `-allow-origin`。

## 测试

```bash
go vet ./...
go test ./...
```

覆盖：握手（101 / 403 / `Origin: null`）、掩码校验、分片重组、大帧（16 位与 64 位长度扩展）、
ping/pong、超长帧拒绝、在线名单、改名广播、请求/同意/拒绝、未配对者无法转发信令、
忙时拒新请求、bye 与掉线清理、重复 peerId 顶号、非法输入容错，
以及静态托管、`/api/info`、SPA 兜底与目录穿越防护。

此外仓库根目录的 `tests/go-server.spec.ts` 会用**前端真实的客户端**
（`src/lib/discovery.ts` + Node 内置 WebSocket）和**真实 WebRTC 协议栈**
（node-datachannel）再打一遍这个 Go 服务，确保两个后端可以互相替换：

```bash
cd ..
pnpm test        # 需要本机有 Go 工具链，否则该文件自动跳过
```
