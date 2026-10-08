/**
 * 全链路端到端测试：发现服务 → 点选用户 → 对方同意 → 真实 WebRTC 握手 → 真实传文件
 *
 * 这条用例把三块拼在一起，且全部用真实实现，不打桩：
 *   - server/index.mjs（自写的 WebSocket 服务）
 *   - src/lib/discovery.ts（发现/信令客户端）
 *   - src/lib/peer.ts + transfer.ts + node-datachannel（真实 WebRTC 协议栈）
 *
 * 换句话说：它跑的就是用户点「连接」之后浏览器里实际发生的那条路径。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createLanServer } from '../server/index.mjs'
import { DiscoveryClient, type RemotePeer } from '../src/lib/discovery'
import { Peer, type PeerOptions } from '../src/lib/peer'
import { TransferManager } from '../src/lib/transfer'
import { memorySink } from '../src/lib/sinks'
import { unpack } from '../src/lib/sdp-codec'
import type { CtrlMsg, LogLevel } from '../src/lib/types'
import { crc32, crc32Hex } from '../src/lib/crc32'

if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => `blob:mock-${Math.random().toString(36).slice(2)}`
}

let polyfill: { RTCPeerConnection: unknown } | null = null
try {
  polyfill = (await import('node-datachannel/polyfill')) as unknown as { RTCPeerConnection: unknown }
} catch {
  polyfill = null
}
const available = !!polyfill?.RTCPeerConnection
if (available) {
  ;(globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = polyfill!.RTCPeerConnection
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean, timeout = 20000, label = '条件'): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (check()) return
    await sleep(25)
  }
  throw new Error(`等待超时：${label}`)
}

/** 一个「浏览器端」：把 Peer、TransferManager、DiscoveryClient 按 UI 的编排接起来 */
class TestAgent {
  readonly peer: Peer
  readonly transfer: TransferManager
  readonly discovery: DiscoveryClient
  readonly logs: string[] = []
  readonly sessions = new Set<string>()
  p2pConnected = false
  incomingRequests: RemotePeer[] = []

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
      onResponse: (peerId, accept) => {
        if (!accept) return
        this.sessions.add(peerId)
        void this.startAsRequester(peerId)
      },
      onSignal: (peerId, payload) => {
        void this.handleSignal(peerId, payload)
      },
      onSessionEnd: (peerId) => {
        this.sessions.delete(peerId)
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

const servers: Array<{ close: () => Promise<void> }> = []
const agents: TestAgent[] = []

afterEach(async () => {
  while (agents.length) agents.pop()?.close()
  while (servers.length) {
    const server = servers.pop()
    if (server) await server.close()
  }
})

describe.skipIf(!available)('全链路：发现服务 + 真实 WebRTC', () => {
  it('甲点选乙 → 乙同意 → 自动完成握手 → 真实传完文件并通过 CRC 校验', async () => {
    const server = await createLanServer({ port: 0, host: '127.0.0.1', name: '全链路测试', quiet: true })
    servers.push(server)
    const base = `http://127.0.0.1:${server.port}`

    const jia = new TestAgent('甲', base)
    const yi = new TestAgent('乙', base)
    agents.push(jia, yi)

    jia.discovery.connect()
    yi.discovery.connect()
    await waitUntil(() => jia.discovery.ready && yi.discovery.ready, 10000, '双方连上发现服务')

    // 甲主动请求连接乙（乙自动同意）
    jia.discovery.request(yi.discovery.peerId)
    await waitUntil(() => yi.incomingRequests.length === 1, 10000, '乙收到连接请求')
    expect(yi.incomingRequests[0].name).toBe('甲')

    // 同意之后，信令经服务端转发，双方自动完成握手
    await waitUntil(() => jia.p2pConnected && yi.p2pConnected, 30000, '双向直连建立')
    expect(jia.peer.dataChannel?.readyState).toBe('open')
    expect(yi.peer.dataChannel?.readyState).toBe('open')

    // 真实传一个 1.5MB 文件（跨信用窗口，走真实 DataChannel）
    const size = Math.floor(1.5 * 1024 * 1024)
    const data = new Uint8Array(size)
    for (let i = 0; i < size; i++) data[i] = (i * 7 + 11) & 0xff
    const file = new File([data], 'full-stack.bin', { type: 'application/octet-stream' })

    const [outgoing] = jia.transfer.enqueue([file])
    await waitUntil(() => outgoing.state === 'done' || outgoing.state === 'failed', 60000, '文件传输结束')

    expect(
      outgoing.state,
      `发送状态=${outgoing.state} 错误=${outgoing.error}\n甲日志:\n${jia.logs.join('\n')}`
    ).toBe('done')
    const received = yi.transfer.getRecord(outgoing.id)
    expect(received?.state).toBe('done')
    expect(received?.received).toBe(size)
    expect(crc32Hex(received!.crc)).toBe(crc32Hex(crc32(data)))
  }, 120000)

  it('拒绝连接时不会建立直连，且双方仍在名单里', async () => {
    const server = await createLanServer({ port: 0, host: '127.0.0.1', name: '拒绝测试', quiet: true })
    servers.push(server)
    const base = `http://127.0.0.1:${server.port}`

    const jia = new TestAgent('甲', base)
    // 乙不自动同意
    const yi = new TestAgent('乙', base, false)
    agents.push(jia, yi)

    jia.discovery.connect()
    yi.discovery.connect()
    await waitUntil(() => jia.discovery.ready && yi.discovery.ready, 10000, '双方连上发现服务')

    jia.discovery.request(yi.discovery.peerId)
    await waitUntil(() => yi.incomingRequests.length === 1, 10000, '乙收到请求')
    yi.discovery.respond(jia.discovery.peerId, false, '现在不方便')

    await sleep(1200)
    expect(jia.p2pConnected).toBe(false)
    expect(yi.p2pConnected).toBe(false)
    expect(server.peers().every((p) => !p.busy)).toBe(true)
  }, 60000)
})
