/**
 * 局域网发现与信令客户端（与框架无关，可单独测试）
 *
 * 与 server/index.mjs 的 WebSocket 协议一一对应：
 *   浏览器 —— hello / rename / request / response / signal / bye ——> 服务
 *   浏览器 <—— welcome / hello-ok / roster / request / response / signal / session-end / error —— 服务
 *
 * 这里只负责「找到人」和「把信令转给对方」，真正的 P2P 连接与文件传输
 * 仍然由 lib/peer.ts 与 lib/transfer.ts 负责。
 */

import type { LogLevel } from './types'
import { uid } from './utils'

export const DISCOVERY_PROTOCOL = 1
const RECONNECT_MIN = 1000
const RECONNECT_MAX = 8000

export interface RemotePeer {
  peerId: string
  name: string
  busy: boolean
}

export interface ServerInfo {
  app: string
  protocol: number
  version: string
  serverName: string
  peers: number
  urls: string[]
}

export type DiscoveryStatus = 'idle' | 'probing' | 'connecting' | 'online' | 'offline' | 'error'

export interface DiscoveryHandlers {
  onStatus?: (status: DiscoveryStatus, detail?: string) => void
  /** 服务端已确认注册，可以正常收发业务消息 */
  onReady?: () => void
  onServer?: (info: ServerInfo) => void
  onRoster?: (peers: RemotePeer[]) => void
  /** 有人请求与你建立连接 */
  onRequest?: (from: RemotePeer) => void
  /** 你发的请求有结果了 */
  onResponse?: (peerId: string, accept: boolean, reason: string) => void
  /** 收到对方的信令（我们复用的是「压缩信令码」字符串） */
  onSignal?: (peerId: string, payload: string) => void
  /** 会话结束（对方断开 / 离线 / 服务端清理） */
  onSessionEnd?: (peerId: string, reason: string) => void
  onError?: (code: string, message: string) => void
  log?: (message: string, level?: LogLevel) => void
}

/** 把 http(s) 基地址换算成 WebSocket 地址 */
export function toWebSocketUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (trimmed.startsWith('https://')) return `${trimmed.replace(/^https:/, 'wss:')}/ws`
  if (trimmed.startsWith('http://')) return `${trimmed.replace(/^http:/, 'ws:')}/ws`
  return `ws://${trimmed}/ws`
}

/** 规范化用户填写的服务地址 */
export function normalizeBaseUrl(input: string): string {
  const value = String(input || '').trim().replace(/\/+$/, '')
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  return `http://${value}`
}

/**
 * 探测某个地址上是否有本项目的发现服务
 * @returns 服务信息；不可用时返回 null
 */
export async function probeServer(baseUrl: string, timeout = 2500): Promise<ServerInfo | null> {
  const base = normalizeBaseUrl(baseUrl)
  if (!base) return null
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null
  try {
    const response = await fetch(`${base}/api/info`, {
      signal: controller ? controller.signal : undefined,
      cache: 'no-store'
    })
    if (!response.ok) return null
    const info = (await response.json()) as ServerInfo
    if (!info || info.app !== 'lan-direct-transfer' || info.protocol !== DISCOVERY_PROTOCOL) return null
    return info
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class DiscoveryClient {
  readonly peerId = uid('u')
  private socket: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = RECONNECT_MIN
  private closedByUser = false
  private currentStatus: DiscoveryStatus = 'idle'
  private name: string
  /** 服务端是否已经处理完 hello（在此之前发的业务消息要排队） */
  private registered = false
  private pendingOut: string[] = []
  private readyNotified = false

  constructor(
    private readonly baseUrl: string,
    name: string,
    private readonly handlers: DiscoveryHandlers = {}
  ) {
    this.name = name
  }

  get status(): DiscoveryStatus {
    return this.currentStatus
  }

  get online(): boolean {
    return Boolean(this.socket) && this.socket?.readyState === 1 /* OPEN */
  }

  /** 通道已打开且服务端已确认注册，可以正常收发业务消息 */
  get ready(): boolean {
    return this.online && this.registered
  }

  private setStatus(status: DiscoveryStatus, detail?: string): void {
    this.currentStatus = status
    this.handlers.onStatus?.(status, detail)
  }

  private wsUrl(): string {
    return toWebSocketUrl(normalizeBaseUrl(this.baseUrl))
  }

  connect(): void {
    if (typeof WebSocket !== 'function') {
      this.setStatus('error', '当前环境不支持 WebSocket')
      return
    }
    this.closedByUser = false
    this.clearReconnect()
    this.setStatus('connecting')
    let socket: WebSocket
    try {
      socket = new WebSocket(this.wsUrl())
    } catch (error) {
      this.setStatus('error', error instanceof Error ? error.message : String(error))
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    socket.onopen = () => {
      this.registered = false
      this.pendingOut = []
      this.markChannelReady()
    }

    socket.onmessage = (event) => {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>
      } catch {
        this.handlers.log?.('收到无法解析的服务端消息', 'warn')
        return
      }
      this.handleMessage(message)
    }

    socket.onclose = () => {
      this.socket = null
      this.registered = false
      this.readyNotified = false
      this.pendingOut = []
      if (this.closedByUser) {
        this.setStatus('idle')
        return
      }
      this.setStatus('offline', '与发现服务的连接已断开，正在重连…')
      this.scheduleReconnect()
    }

    socket.onerror = () => {
      // onclose 会紧随其后，这里不重复处理
      this.handlers.log?.('发现服务连接出错', 'warn')
    }
  }

  /** 主动关闭（不再自动重连） */
  close(): void {
    this.closedByUser = true
    this.clearReconnect()
    try {
      this.socket?.close()
    } catch {
      /* 忽略 */
    }
    this.socket = null
    this.setStatus('idle')
  }

  /** 修改昵称并同步给服务端（在线名单会实时更新） */
  rename(name: string): void {
    this.name = name
    if (this.online) this.send({ t: 'rename', name })
  }

  request(to: string): void {
    this.send({ t: 'request', to })
  }

  respond(to: string, accept: boolean, reason?: string): void {
    this.send({ t: 'response', to, accept, reason: reason || '' })
  }

  sendSignal(to: string, payload: string): void {
    this.send({ t: 'signal', to, payload })
  }

  bye(to: string): void {
    this.send({ t: 'bye', to })
  }

  /**
   * 通道就绪：进入 online 并发送 hello。
   * 触发点是「open 事件」或「收到服务端第一条消息」，取先发生者——
   * 个别环境（例如 jsdom）不会派发 open 事件，只认 open 会一直卡在「连接中」。
   */
  private markChannelReady(): void {
    if (this.readyNotified) return
    this.readyNotified = true
    this.reconnectDelay = RECONNECT_MIN
    this.setStatus('online')
    this.handlers.log?.(`已连上发现服务：${this.wsUrl()}`)
    this.send({ t: 'hello', peerId: this.peerId, name: this.name })
  }

  private send(message: Record<string, unknown>): boolean {
    if (!this.online) {
      this.handlers.log?.('发现服务未连接，消息未发送', 'warn')
      return false
    }
    const text = JSON.stringify(message)
    // 注册完成前先排队：否则 request/signal 可能先于 hello 到达而被服务端丢弃
    if (!this.registered && message.t !== 'hello') {
      this.pendingOut.push(text)
      return true
    }
    return this.write(text)
  }

  private write(text: string): boolean {
    try {
      this.socket?.send(text)
      return true
    } catch (error) {
      this.handlers.log?.(`发送发现服务消息失败：${error instanceof Error ? error.message : error}`, 'error')
      return false
    }
  }

  private flushPending(): void {
    if (!this.pendingOut.length) return
    const queued = this.pendingOut
    this.pendingOut = []
    for (const text of queued) this.write(text)
  }

  private handleMessage(message: Record<string, unknown>): void {
    switch (message.t) {
      case 'welcome':
        this.handlers.onServer?.({
          app: 'lan-direct-transfer',
          protocol: Number(message.protocol) || 0,
          version: String(message.version || ''),
          serverName: String(message.serverName || ''),
          peers: 0,
          urls: []
        })
        // 收到 welcome 说明连接已经就绪（同时兜住不派发 open 事件的环境）
        this.markChannelReady()
        break
      case 'hello-ok':
        this.registered = true
        this.flushPending()
        this.handlers.onReady?.()
        break
      case 'roster':
        this.handlers.onRoster?.(
          ((message.peers as Array<Record<string, unknown>>) || []).map((peer) => ({
            peerId: String(peer.peerId || ''),
            name: String(peer.name || '未命名'),
            busy: Boolean(peer.busy)
          }))
        )
        break
      case 'request':
        this.handlers.onRequest?.({
          peerId: String(message.from || ''),
          name: String(message.name || '对方'),
          busy: false
        })
        break
      case 'response':
        this.handlers.onResponse?.(
          String(message.from || ''),
          Boolean(message.accept),
          String(message.reason || '')
        )
        break
      case 'signal':
        this.handlers.onSignal?.(String(message.from || ''), String(message.payload || ''))
        break
      case 'session-end':
        this.handlers.onSessionEnd?.(String(message.peerId || ''), String(message.reason || ''))
        break
      case 'error':
        this.handlers.onError?.(String(message.code || 'error'), String(message.message || '服务端返回错误'))
        break
      default:
        break
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.closedByUser) this.connect()
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
