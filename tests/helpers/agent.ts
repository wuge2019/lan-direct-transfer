/**
 * 测试共用的「浏览器端」代理
 *
 * 把 Peer（WebRTC）、TransferManager（传输引擎）、DiscoveryClient（发现/信令）
 * 按界面里的编排接起来，供 full-stack 与 go-server 两组端到端测试复用。
 */

import { DiscoveryClient, type RemotePeer } from '../../src/lib/discovery'
import { Peer, type PeerOptions } from '../../src/lib/peer'
import { TransferManager } from '../../src/lib/transfer'
import { memorySink } from '../../src/lib/sinks'
import { unpack } from '../../src/lib/sdp-codec'
import type { CtrlMsg, LogLevel } from '../../src/lib/types'

/* Node 环境补丁：memorySink 结束时会调用 URL.createObjectURL */
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => `blob:mock-${Math.random().toString(36).slice(2)}`
}

/* 真实 WebRTC 协议栈（libdatachannel）。没有原生二进制时自动跳过相关用例。 */
let polyfill: { RTCPeerConnection: unknown } | null = null
try {
  polyfill = (await import('node-datachannel/polyfill')) as unknown as { RTCPeerConnection: unknown }
} catch {
  polyfill = null
}

export const webRTCAvailable = Boolean(polyfill?.RTCPeerConnection)
if (webRTCAvailable) {
  ;(globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = polyfill!.RTCPeerConnection
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitUntil(check: () => boolean, timeout = 20000, label = '条件'): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (check()) return
    await sleep(25)
  }
  throw new Error(`等待超时：${label}`)
}

export class TestAgent {
  readonly peer: Peer
  readonly transfer: TransferManager
  readonly discovery: DiscoveryClient
  readonly logs: string[] = []
  readonly sessions = new Set<string>()
  p2pConnected = false
  incomingRequests: RemotePeer[] = []
  outgoingAccepted: string[] = []
  outgoingRejected: Array<{ peerId: string; reason: string }> = []
  sessionEnds: Array<{ peerId: string; reason: string }> = []

  constructor(name: string, baseUrl: string, autoAcceptRequests = true) {
    const fileHandlers: {
      file?: (msg: CtrlMsg) => void
      binary?: (buf: ArrayBuffer) => void
    } = {}

    const options: PeerOptions = {
      getIceServers: () => [],
      getName: () => name,
      log: (message: string, level?: LogLevel) => this.logs.push(`[${level || 'info'}] ${message}`),
      onStatus: () => {},
      onOpen: () => {
        this.p2pConnected = true
      },
      onClosed: () => {
        this.p2pConnected = false
        this.sessions.clear()
      },
      onSys: (text) => this.logs.push(text),
      onChat: () => {},
      onPeerName: () => {},
      onRtt: () => {},
      onPath: () => {},
      onFileMsg: (msg) => fileHandlers.file?.(msg),
      onBinary: (buf) => fileHandlers.binary?.(buf)
    }
    this.peer = new Peer(options)

    this.transfer = new TransferManager({
      sendCtrl: (msg) => this.peer.send(msg),
      getChannel: () => this.peer.dataChannel,
      onUpdate: () => {},
      onIncomingOffer: (rec) => this.transfer.accept(rec.id, memorySink(rec)),
      log: (message) => this.logs.push(message)
    })

    fileHandlers.file = (msg) => this.transfer.handleCtrl(msg)
    fileHandlers.binary = (buf) => this.transfer.handleBinary(buf)

    this.discovery = new DiscoveryClient(baseUrl, name, {
      onRoster: () => {},
      onRequest: (from) => {
        this.incomingRequests.push(from)
        if (autoAcceptRequests) this.discovery.respond(from.peerId, true)
      },
      onResponse: (peerId, accept, reason) => {
        if (!accept) {
          this.outgoingRejected.push({ peerId, reason })
          return
        }
        this.outgoingAccepted.push(peerId)
        this.sessions.add(peerId)
        void this.startAsRequester(peerId)
      },
      onSignal: (peerId, payload) => {
        void this.handleSignal(peerId, payload)
      },
      onSessionEnd: (peerId, reason) => {
        this.sessions.delete(peerId)
        this.sessionEnds.push({ peerId, reason })
      },
      log: (message) => this.logs.push(message)
    })
  }

  /** 我是发起方：生成邀请码并通过发现服务发给对方 */
  private async startAsRequester(peerId: string): Promise<void> {
    try {
      const code = await this.peer.createInvite()
      this.discovery.sendSignal(peerId, code)
    } catch (error) {
      this.logs.push(`邀请码生成失败：${String(error)}`)
    }
  }

  /** 收到信令：按角色决定生成应答码还是应用应答码 */
  private async handleSignal(peerId: string, payload: string): Promise<void> {
    this.sessions.add(peerId)
    try {
      const info = unpack(payload)
      if (info.r === 'o') {
        const answer = await this.peer.createAnswer(payload)
        this.discovery.sendSignal(peerId, answer)
      } else {
        await this.peer.applyAnswer(payload)
      }
    } catch (error) {
      this.logs.push(`信令处理失败：${String(error)}`)
    }
  }

  close(): void {
    this.discovery.close()
    this.peer.close('')
  }
}
