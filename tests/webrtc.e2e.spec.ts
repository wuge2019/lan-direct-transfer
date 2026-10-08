/**
 * 真实 WebRTC 端到端测试（Node + libdatachannel）
 *
 * 这个测试的价值：验证「本项目自己拼出来的 SDP」是否真的能被一个真实 WebRTC
 * 协议栈接受并完成握手 —— 这是纯前端方案里最容易出错、也最难自测的一环
 * （sdp-codec 的往返测试只能证明自洽，不能证明合法）。
 *
 * 如果本机没有可用的 node-datachannel 原生二进制，本文件会自动跳过，不影响其它测试。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Peer, type PeerOptions } from '../src/lib/peer'
import { TransferManager } from '../src/lib/transfer'
import { memorySink } from '../src/lib/sinks'
import { pack, unpack } from '../src/lib/sdp-codec'
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

async function waitFor(check: () => boolean, timeout: number, label: string): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`等待超时：${label}`)
}

interface Endpoint {
  peer: Peer
  logs: string[]
}

const opened: Peer[] = []

afterEach(() => {
  while (opened.length) {
    try {
      opened.pop()?.close('')
    } catch {
      /* 忽略 */
    }
  }
})

function makeEndpoint(
  name: string,
  handlers: { file?: (msg: CtrlMsg) => void; binary?: (buf: ArrayBuffer) => void }
): Endpoint {
  const logs: string[] = []
  const options: PeerOptions = {
    getIceServers: () => [],
    getName: () => name,
    log: (message: string, level?: LogLevel) => logs.push(`[${level || 'info'}] ${message}`),
    onStatus: () => {},
    onOpen: () => {},
    onClosed: () => {},
    onSys: () => {},
    onChat: () => {},
    onPeerName: () => {},
    onRtt: () => {},
    onPath: () => {},
    onFileMsg: (msg) => handlers.file?.(msg),
    onBinary: (buf) => handlers.binary?.(buf)
  }
  const peer = new Peer(options)
  opened.push(peer)
  return { peer, logs }
}

describe.skipIf(!available)('真实 WebRTC 端到端（libdatachannel）', () => {
  it('用本项目生成的信令码完成真实握手，并真实传完一个 1.5MB 文件', async () => {
    const handlersA: { file?: (m: CtrlMsg) => void; binary?: (b: ArrayBuffer) => void } = {}
    const handlersB: { file?: (m: CtrlMsg) => void; binary?: (b: ArrayBuffer) => void } = {}

    const A = makeEndpoint('A端', handlersA)
    const B = makeEndpoint('B端', handlersB)

    // 1) 真实握手：邀请码 -> 应答码 -> 应用应答码
    const inviteCode = await A.peer.createInvite()
    expect(inviteCode.startsWith('P2P1-')).toBe(true)

    const answerCode = await B.peer.createAnswer(inviteCode)
    expect(answerCode.startsWith('P2P1-')).toBe(true)

    await A.peer.applyAnswer(answerCode)
    await waitFor(() => A.peer.connected && B.peer.connected, 30000, '双端通道就绪')

    expect(A.peer.dataChannel?.readyState).toBe('open')
    expect(B.peer.dataChannel?.readyState).toBe('open')

    // 2) 真实传输：1.5MB（约 96 个 16KB 分片，会跨越 64 片信用窗口）
    let managerA: TransferManager
    let managerB: TransferManager
    managerA = new TransferManager({
      sendCtrl: (msg) => A.peer.send(msg),
      getChannel: () => A.peer.dataChannel,
      onUpdate: () => {},
      log: (m) => A.logs.push(m)
    })
    managerB = new TransferManager({
      sendCtrl: (msg) => B.peer.send(msg),
      getChannel: () => B.peer.dataChannel,
      onUpdate: () => {},
      onIncomingOffer: (rec) => managerB.accept(rec.id, memorySink(rec)),
      log: (m) => B.logs.push(m)
    })
    handlersA.file = (msg) => managerA.handleCtrl(msg)
    handlersA.binary = (buf) => managerA.handleBinary(buf)
    handlersB.file = (msg) => managerB.handleCtrl(msg)
    handlersB.binary = (buf) => managerB.handleBinary(buf)

    const size = Math.floor(1.5 * 1024 * 1024)
    const data = new Uint8Array(size)
    for (let i = 0; i < size; i++) data[i] = (i * 13 + 5) & 0xff
    const file = new File([data], 'real.bin', { type: 'application/octet-stream' })

    const [out] = managerA.enqueue([file])
    await waitFor(() => out.state === 'done' || out.state === 'failed', 60000, '文件传输结束')

    const incoming = managerB.getRecord(out.id)
    expect(out.state, `发送端状态=${out.state} 错误=${out.error}\nA日志:\n${A.logs.join('\n')}`).toBe('done')
    expect(incoming?.state).toBe('done')
    expect(incoming?.received).toBe(size)
    expect(crc32Hex(incoming!.crc)).toBe(crc32Hex(crc32(data)))

    // 3) 真实聊天消息（走 ctrl 通道）：能正常发送即说明控制通道可双向工作
    expect(A.peer.send({ t: 'chat', text: '真实通道上的问候', ts: Date.now() })).toBe(true)
    await new Promise((r) => setTimeout(r, 200))
  }, 90000)

  it('负向对照：篡改 DTLS 指纹后握手不会建立（证明上面的测试不是空跑）', async () => {
    const A = makeEndpoint('A端', {})
    const B = makeEndpoint('B端', {})

    const inviteCode = await A.peer.createInvite()
    const answerCode = await B.peer.createAnswer(inviteCode)

    // 把应答码里的 DTLS 指纹改掉：真实协议栈必须因此拒绝建立加密通道
    const tampered = unpack(answerCode)
    tampered.f = 'AA:BB:CC:' + tampered.f.split(':').slice(3).join(':')
    const badCode = pack(tampered)
    expect(badCode).not.toBe(answerCode)

    try {
      await A.peer.applyAnswer(badCode)
    } catch {
      // 有些实现会在 setRemoteDescription 阶段就直接报错，这也是符合预期的
    }

    const start = Date.now()
    while (Date.now() - start < 6000) {
      if (A.peer.connected && B.peer.connected) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(A.peer.connected && B.peer.connected).toBe(false)
  }, 40000)
})
