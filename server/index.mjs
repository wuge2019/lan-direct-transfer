/**
 * 局域网直连 · 发现与信令服务
 *
 * 作用只有一个：让同一个局域网里的浏览器互相「看见」，并把建立 WebRTC 直连
 * 所需的那一小段信令转发给对方。
 *
 *   - 文件与聊天内容**不会**经过本服务：它们走 WebRTC DataChannel 点对点直连
 *   - 不写数据库、不落盘任何内容，进程退出即全部消失
 *   - 零运行时依赖：只用 Node 内置模块 + 自带的极简 WebSocket 实现（websocket.mjs）
 *
 * 用法：
 *   node server/index.mjs                       # 默认 0.0.0.0:8080
 *   node server/index.mjs --port 9000 --name "我的传输房"
 *
 * 协议（JSON 文本帧，protocol = 1）
 *   服务端 -> 客户端: welcome / hello-ok / roster / request / response / signal / session-end / error
 *   客户端 -> 服务端: hello / rename / request / response / signal / bye
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { networkInterfaces, hostname } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { attachWebSocketServer } from './websocket.mjs'

export const PROTOCOL_VERSION = 1
export const APP_VERSION = '1.0.0'

const MAX_NAME_LENGTH = 24
const MAX_PEER_ID_LENGTH = 64
const MAX_SIGNAL_LENGTH = 64 * 1024
const REQUEST_COOLDOWN_MS = 1500

/** 模块所在目录。注意：在浏览器/jsdom 环境下 import.meta.url 不是 file://，这里做兼容 */
function moduleDir() {
  try {
    return fileURLToPath(new URL('.', import.meta.url))
  } catch {
    return process.cwd()
  }
}

const __dirname = moduleDir()
const projectRoot = resolve(__dirname, '..')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}

/* =========================================================
 * 工具
 * ======================================================= */
export function lanAddresses() {
  const result = []
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) result.push(item.address)
    }
  }
  return result
}

function sanitizeName(value) {
  const name = String(value ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, MAX_NAME_LENGTH)
  return name || '匿名用户'
}

function sanitizePeerId(value) {
  const id = String(value ?? '').trim()
  if (!id || id.length > MAX_PEER_ID_LENGTH) return ''
  return /^[\w.:-]+$/.test(id) ? id : ''
}

function missingBuildPage() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>还没有构建前端产物</title>
<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#0f1319;color:#e6ecf4;
padding:48px;line-height:1.8}code{background:#1c2430;padding:2px 8px;border-radius:6px;color:#8ecbff}</style>
</head><body><h2>还没有构建前端产物</h2>
<p>请先在项目目录执行：</p><p><code>pnpm install</code><br><code>pnpm build</code></p>
<p>然后重新启动本服务。</p>
</body></html>`
}

/* =========================================================
 * 服务实例
 * ======================================================= */
/**
 * 创建一个发现/信令服务（不自动监听，便于测试）
 * @param {object} userOptions
 * @returns {Promise<{server: import('node:http').Server, port: number, options: object,
 *   peers: () => Array<{peerId: string, name: string, busy: boolean}>, close: () => Promise<void>}>}
 */
export async function createLanServer(userOptions = {}) {
  const options = {
    port: 8080,
    host: '0.0.0.0',
    name: `${hostname()} 的传输房`,
    dir: join(projectRoot, 'dist'),
    allowOrigins: [],
    quiet: false,
    open: false,
    ...userOptions
  }

  const startedAt = Date.now()
  /** peerId -> 连接状态 */
  const peers = new Map()
  const fileCache = new Map()

  const log = (message) => {
    if (options.quiet) return
    const time = new Date().toTimeString().slice(0, 8)
    console.log(`[${time}] ${message}`)
  }

  const listPeers = () =>
    [...peers.values()].map((peer) => ({
      peerId: peer.peerId,
      name: peer.name,
      busy: Boolean(peer.partnerId)
    }))

  function broadcastRoster() {
    const payload = JSON.stringify({ t: 'roster', peers: listPeers() })
    for (const peer of peers.values()) {
      if (!peer.connection.closed) peer.connection.send(payload)
    }
  }

  function sendTo(peerId, message) {
    const peer = peers.get(peerId)
    if (!peer || peer.connection.closed) return false
    return peer.connection.sendJson(message)
  }

  function sendError(connection, code, message) {
    connection.sendJson({ t: 'error', code, message })
  }

  /** 结束某人的会话，并通知另一方 */
  function endSession(peerId, reason) {
    const peer = peers.get(peerId)
    if (!peer) return
    const partnerId = peer.partnerId
    peer.partnerId = null
    peer.pendingId = null
    if (!partnerId) return
    const partner = peers.get(partnerId)
    if (partner) {
      partner.partnerId = null
      partner.pendingId = null
      sendTo(partnerId, { t: 'session-end', peerId, reason: reason || '' })
    }
  }

  /* ---------------- WebSocket 协议 ---------------- */
  function handleConnection(connection) {
    connection.sendJson({
      t: 'welcome',
      protocol: PROTOCOL_VERSION,
      serverName: options.name,
      version: APP_VERSION
    })

    connection.on('message', (raw) => {
      let message
      try {
        message = JSON.parse(raw)
      } catch {
        return sendError(connection, 'bad-json', '消息不是合法 JSON')
      }
      if (!message || typeof message.t !== 'string') {
        return sendError(connection, 'bad-message', '消息缺少类型字段')
      }

      const self = connection.data
      if (message.t !== 'hello' && (!self || !self.peerId)) {
        return sendError(connection, 'not-registered', '请先发送 hello 注册')
      }

      switch (message.t) {
        case 'hello': {
          const peerId = sanitizePeerId(message.peerId)
          if (!peerId) return sendError(connection, 'bad-peer-id', 'peerId 非法')
          if (peers.has(peerId) && peers.get(peerId).connection !== connection) {
            // 同一身份重复上线：踢掉旧连接，避免名单里出现幽灵用户
            const stale = peers.get(peerId)
            stale.connection.close(4000, '该身份在别处重新连接')
            endSession(peerId, 'replaced')
          }
          const peer = {
            peerId,
            name: sanitizeName(message.name),
            connection,
            partnerId: null,
            pendingId: null,
            lastRequestAt: 0,
            joinedAt: Date.now()
          }
          connection.data = peer
          peers.set(peerId, peer)
          connection.sendJson({ t: 'hello-ok', peerId, serverName: options.name })
          broadcastRoster()
          log(`${peer.name} 上线了（${peerId}），当前在线 ${peers.size} 人`)
          return
        }

        case 'rename': {
          self.name = sanitizeName(message.name)
          broadcastRoster()
          log(`${self.peerId} 改名为「${self.name}」`)
          return
        }

        case 'request': {
          if (self.partnerId) return sendError(connection, 'busy', '你已经在与别人连接中')
          const now = Date.now()
          if (now - self.lastRequestAt < REQUEST_COOLDOWN_MS) {
            return sendError(connection, 'too-fast', '操作太快了，请稍后再试')
          }
          self.lastRequestAt = now

          const targetId = sanitizePeerId(message.to)
          const target = targetId ? peers.get(targetId) : null
          if (!target) return sendError(connection, 'not-found', '对方已离线')
          if (target.peerId === self.peerId) return sendError(connection, 'self', '不能连接自己')
          if (target.partnerId) {
            sendTo(self.peerId, { t: 'response', from: target.peerId, accept: false, reason: '对方正在连接中' })
            return sendError(connection, 'busy', '对方正在连接中')
          }
          if (target.pendingId && target.pendingId !== self.peerId) {
            return sendError(connection, 'busy', '对方正在处理另一个连接请求')
          }

          self.pendingId = target.peerId
          target.pendingId = self.peerId
          sendTo(target.peerId, { t: 'request', from: self.peerId, name: self.name })
          log(`${self.name} 请求连接 ${target.name}`)
          return
        }

        case 'response': {
          const targetId = sanitizePeerId(message.to)
          const target = targetId ? peers.get(targetId) : null
          if (!target) return sendError(connection, 'not-found', '对方已离线')
          if (target.pendingId !== self.peerId) {
            return sendError(connection, 'no-request', '没有来自对方的连接请求')
          }
          target.pendingId = null
          self.pendingId = null

          if (!message.accept) {
            sendTo(target.peerId, {
              t: 'response',
              from: self.peerId,
              accept: false,
              reason: String(message.reason || '对方拒绝了连接').slice(0, 40)
            })
            log(`${self.name} 拒绝了 ${target.name} 的连接请求`)
            broadcastRoster()
            return
          }

          if (self.partnerId || target.partnerId) {
            sendTo(target.peerId, { t: 'response', from: self.peerId, accept: false, reason: '对方正忙' })
            return sendError(connection, 'busy', '有一方已经进入其它连接')
          }

          self.partnerId = target.peerId
          target.partnerId = self.peerId
          sendTo(target.peerId, { t: 'response', from: self.peerId, accept: true })
          broadcastRoster()
          log(`${self.name} 同意了 ${target.name} 的连接，开始交换信令`)
          return
        }

        case 'signal': {
          const targetId = sanitizePeerId(message.to)
          const target = targetId ? peers.get(targetId) : null
          if (!target) return sendError(connection, 'not-found', '对方已离线')
          // 只允许与已配对的对方交换信令
          if (self.partnerId !== target.peerId) {
            return sendError(connection, 'not-paired', '尚未与该用户建立连接')
          }
          const payload = typeof message.payload === 'string' ? message.payload : ''
          if (!payload || payload.length > MAX_SIGNAL_LENGTH) {
            return sendError(connection, 'bad-payload', '信令内容非法或过长')
          }
          sendTo(target.peerId, { t: 'signal', from: self.peerId, payload })
          return
        }

        case 'bye': {
          const targetId = sanitizePeerId(message.to)
          if (self.partnerId && (!targetId || self.partnerId === targetId)) {
            log(`${self.name} 断开了连接`)
            endSession(self.peerId, 'bye')
            broadcastRoster()
          }
          return
        }

        default:
          return sendError(connection, 'unknown-type', `未知消息类型：${message.t}`)
      }
    })

    connection.on('close', () => {
      const peer = connection.data
      if (!peer || !peer.peerId) return
      // 已被同 id 的新连接取代：这里什么都不要做，否则会误伤新连接
      if (peers.get(peer.peerId) !== peer) return
      // 必须先通知对方再删除自己：endSession 需要从 peers 里查到自己
      endSession(peer.peerId, 'offline')
      peers.delete(peer.peerId)
      broadcastRoster()
      log(`${peer.name} 离线了，当前在线 ${peers.size} 人`)
    })
  }

  /* ---------------- 静态资源 ---------------- */
  async function readStatic(filePath) {
    const info = await stat(filePath)
    const cached = fileCache.get(filePath)
    if (cached && cached.mtimeMs === info.mtimeMs) return cached.content
    const content = await readFile(filePath)
    fileCache.set(filePath, { mtimeMs: info.mtimeMs, content })
    return content
  }

  function handleHttp(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = decodeURIComponent(url.pathname)

    if (pathname === '/api/info') {
      res.writeHead(200, {
        'Content-Type': MIME_TYPES['.json'],
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(
        JSON.stringify({
          app: 'lan-direct-transfer',
          protocol: PROTOCOL_VERSION,
          version: APP_VERSION,
          serverName: options.name,
          peers: peers.size,
          urls: lanAddresses().map((address) => `http://${address}:${options.port}`),
          startedAt
        })
      )
      return
    }

    if (pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': MIME_TYPES['.json'] })
      res.end(JSON.stringify({ error: 'not-found' }))
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }

    const indexFile = join(options.dir, 'index.html')
    const serveIndex = () => {
      if (!existsSync(indexFile)) {
        res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] })
        res.end(missingBuildPage())
        return
      }
      readStatic(indexFile)
        .then((content) => {
          res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'], 'Cache-Control': 'no-store' })
          res.end(content)
        })
        .catch(() => res.writeHead(500).end('读取 index.html 失败'))
    }

    // 目录穿越防护：只允许访问静态目录之内
    const relative = normalize(pathname).replace(/^([/\\])+/, '')
    const target = resolve(options.dir, relative)
    const insideDir =
      target === options.dir || target.startsWith(options.dir + (process.platform === 'win32' ? '\\' : '/'))

    if (!insideDir || pathname === '/') {
      serveIndex()
      return
    }

    stat(target)
      .then(async (info) => {
        if (info.isDirectory()) return serveIndex()
        const content = await readStatic(target)
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache'
        })
        res.end(content)
      })
      .catch(() => serveIndex()) // SPA 兜底
  }

  /* ---------------- Origin 校验 ---------------- */
  function makeOriginVerifier() {
    const allowed = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
    for (const address of lanAddresses()) allowed.add(address)
    for (const extra of options.allowOrigins) if (extra) allowed.add(extra)

    return (req) => {
      const origin = req.headers.origin
      // 没有 Origin（curl / 测试客户端）直接放行；
      // 单文件版用 file:// 打开时 Origin 是字符串 "null"，也放行，
      // 否则「单文件版 + 在设置里填服务地址」这条用法会失效。
      if (!origin || origin === 'null') return true
      try {
        const host = new URL(origin).hostname
        if (allowed.has(host)) return true
        const hostHeader = String(req.headers.host || '').split(':')[0]
        return Boolean(hostHeader) && host === hostHeader
      } catch {
        return false
      }
    }
  }

  /* ---------------- 监听 ---------------- */
  const server = createServer(handleHttp)
  const hub = attachWebSocketServer(server, {
    path: '/ws',
    onConnection: handleConnection,
    verifyClient: makeOriginVerifier()
  })

  const port = await listenWithFallback(server, options.host, options.port)
  options.port = port

  return {
    server,
    hub,
    port,
    options,
    peers: listPeers,
    urls: () => lanAddresses().map((address) => `http://${address}:${port}`),
    close: () =>
      new Promise((resolvePromise) => {
        hub.close()
        server.close(() => resolvePromise())
        setTimeout(resolvePromise, 300)
      })
  }
}

async function listenWithFallback(server, host, startPort, attempts = 10) {
  // 端口 0 = 让系统分配（测试用）
  if (startPort === 0) {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(0, host, () => {
        server.removeListener('error', reject)
        resolvePromise()
      })
    })
    return server.address().port
  }

  let port = startPort
  for (let i = 0; i < attempts; i++) {
    try {
      await new Promise((resolvePromise, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          resolvePromise()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })
      return port
    } catch (error) {
      if (error && error.code === 'EADDRINUSE') {
        port += 1
        continue
      }
      throw error
    }
  }
  throw new Error(`端口 ${startPort} 起连续 ${attempts} 个端口都被占用，请用 --port 指定其它端口`)
}

/* =========================================================
 * 命令行入口
 * ======================================================= */
export function parseArgs(argv) {
  const options = {
    port: 8080,
    host: '0.0.0.0',
    name: `${hostname()} 的传输房`,
    dir: join(projectRoot, 'dist'),
    open: true,
    allowOrigins: []
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--port' || arg === '-p') options.port = Number(next()) || options.port
    else if (arg === '--host') options.host = next() || options.host
    else if (arg === '--name' || arg === '-n') options.name = next() || options.name
    else if (arg === '--dir' || arg === '-d') options.dir = resolve(next() || options.dir)
    else if (arg === '--no-open') options.open = false
    else if (arg === '--allow-origin') options.allowOrigins.push(String(next() || ''))
    else if (arg === '--help' || arg === '-h') options.help = true
  }
  return options
}

const HELP = `
局域网直连 · 发现与信令服务

  node server/index.mjs [选项]

  --port, -p <端口>      监听端口（默认 8080，被占用时自动往后找）
  --host <地址>          监听地址（默认 0.0.0.0，即局域网内可访问）
  --name, -n <名称>      房间名称（默认「<主机名> 的传输房」）
  --dir, -d <目录>       静态资源目录（默认项目下的 dist/）
  --no-open              启动后不自动打开浏览器
  --allow-origin <主机>  额外允许的 WebSocket Origin（默认只允许同源与本机访问）
  -h, --help             显示本帮助
`

async function runCli() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }

  const instance = await createLanServer(options)
  const port = instance.port

  console.log('')
  console.log('  ┌──────────────────────────────────────────────┐')
  console.log('  │   局域网直连 · 发现与信令服务已启动          │')
  console.log('  └──────────────────────────────────────────────┘')
  console.log('')
  console.log(`  房间名称：${instance.options.name}`)
  console.log(`  本机访问：http://localhost:${port}`)
  for (const url of instance.urls()) {
    console.log(`  局域网访问：${url}`)
  }
  console.log('')
  console.log('  把这些局域网地址（或页面上的二维码）发给同事，浏览器打开即可互相看见。')
  console.log('  文件与聊天内容不经过本服务，全部走 WebRTC 点对点直连。')
  console.log('  按 Ctrl+C 停止。')
  console.log('')

  if (options.open) {
    const url = `http://localhost:${port}`
    if (openBrowser(url)) console.log(`  已尝试用默认浏览器打开 ${url}`)
  }

  const shutdown = () => {
    console.log('\n正在关闭服务…')
    void instance.close().then(() => process.exit(0))
    setTimeout(() => process.exit(0), 600)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
    return true
  } catch {
    return false
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  runCli().catch((error) => {
    console.error('启动失败：', error?.message || error)
    process.exit(1)
  })
}
