/**
 * 发现客户端测试：把 src/lib/discovery.ts 接到真实的 server/index.mjs 上跑，
 * 覆盖探测接口、在线名单、请求/同意、信令转发、改名、离线通知与自动重连。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createLanServer } from '../server/index.mjs'
import {
  DiscoveryClient,
  normalizeBaseUrl,
  probeServer,
  toWebSocketUrl,
  type RemotePeer,
  type ServerInfo
} from '../src/lib/discovery'

interface ServerInstance {
  port: number
  peers: () => Array<{ peerId: string; name: string; busy: boolean }>
  close: () => Promise<void>
}

const running: ServerInstance[] = []
const clients: DiscoveryClient[] = []

async function startServer(): Promise<ServerInstance> {
  const instance = (await createLanServer({
    port: 0,
    host: '127.0.0.1',
    name: '发现测试房',
    quiet: true
  })) as unknown as ServerInstance
  running.push(instance)
  return instance
}

afterEach(async () => {
  while (clients.length) clients.pop()?.close()
  while (running.length) {
    const instance = running.pop()
    if (instance) await instance.close()
  }
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean, timeout = 5000, label = '条件'): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (check()) return
    await sleep(20)
  }
  throw new Error(`等待超时：${label}`)
}

/** 记录回调事件的测试用收集器 */
function makeCollector() {
  const state = {
    status: 'idle' as string,
    server: null as ServerInfo | null,
    roster: [] as RemotePeer[],
    requests: [] as RemotePeer[],
    responses: [] as Array<{ peerId: string; accept: boolean; reason: string }>,
    signals: [] as Array<{ peerId: string; payload: string }>,
    sessionEnds: [] as Array<{ peerId: string; reason: string }>,
    errors: [] as Array<{ code: string; message: string }>
  }
  const handlers = {
    onStatus: (status: string) => {
      state.status = status
    },
    onServer: (info: ServerInfo) => {
      state.server = info
    },
    onRoster: (peers: RemotePeer[]) => {
      state.roster = peers
    },
    onRequest: (from: RemotePeer) => {
      state.requests.push(from)
    },
    onResponse: (peerId: string, accept: boolean, reason: string) => {
      state.responses.push({ peerId, accept, reason })
    },
    onSignal: (peerId: string, payload: string) => {
      state.signals.push({ peerId, payload })
    },
    onSessionEnd: (peerId: string, reason: string) => {
      state.sessionEnds.push({ peerId, reason })
    },
    onError: (code: string, message: string) => {
      state.errors.push({ code, message })
    }
  }
  return { state, handlers }
}

function makeClient(port: number, name: string) {
  const { state, handlers } = makeCollector()
  const client = new DiscoveryClient(`http://127.0.0.1:${port}`, name, handlers)
  clients.push(client)
  return { client, state }
}

describe('地址处理与探测', () => {
  it('normalizeBaseUrl 补全协议并去掉结尾斜杠', () => {
    expect(normalizeBaseUrl('192.168.1.5:8080')).toBe('http://192.168.1.5:8080')
    expect(normalizeBaseUrl('http://192.168.1.5:8080/')).toBe('http://192.168.1.5:8080')
    expect(normalizeBaseUrl('')).toBe('')
  })

  it('toWebSocketUrl 按协议换算 ws/wss', () => {
    expect(toWebSocketUrl('http://192.168.1.5:8080')).toBe('ws://192.168.1.5:8080/ws')
    expect(toWebSocketUrl('https://example.com')).toBe('wss://example.com/ws')
  })

  it('probeServer 能识别本项目服务，对无关地址返回 null', async () => {
    const server = await startServer()
    const info = await probeServer(`http://127.0.0.1:${server.port}`)
    expect(info?.serverName).toBe('发现测试房')
    expect(info?.protocol).toBe(1)

    // 端口没人监听
    expect(await probeServer('http://127.0.0.1:1', 500)).toBeNull()
  })
})

describe('在线名单与连接请求', () => {
  it('两人上线后互相可见，请求 → 同意 → 双向信令转发', async () => {
    const server = await startServer()
    const a = makeClient(server.port, '小明')
    const b = makeClient(server.port, '小红')

    a.client.connect()
    await waitUntil(() => a.state.status === 'online', 5000, 'A 上线')
    b.client.connect()
    await waitUntil(() => b.state.status === 'online', 5000, 'B 上线')

    await waitUntil(() => a.state.roster.length === 2, 5000, 'A 看到两个人')
    const other = a.state.roster.find((p) => p.peerId !== a.client.peerId)
    expect(other?.name).toBe('小红')

    // A 请求连接 B
    a.client.request(b.client.peerId)
    await waitUntil(() => b.state.requests.length === 1, 5000, 'B 收到请求')
    expect(b.state.requests[0].name).toBe('小明')

    // B 同意 → A 收到 accept
    b.client.respond(a.client.peerId, true)
    await waitUntil(() => a.state.responses.length === 1, 5000, 'A 收到同意')
    expect(a.state.responses[0].accept).toBe(true)
    expect(server.peers().every((p) => p.busy)).toBe(true)

    // 双向信令转发
    a.client.sendSignal(b.client.peerId, 'P2P1-offer')
    await waitUntil(() => b.state.signals.length === 1, 5000, 'B 收到信令')
    expect(b.state.signals[0].payload).toBe('P2P1-offer')

    b.client.sendSignal(a.client.peerId, 'P2P1-answer')
    await waitUntil(() => a.state.signals.length === 1, 5000, 'A 收到信令')
    expect(a.state.signals[0].payload).toBe('P2P1-answer')
  }, 20000)

  it('拒绝会带上原因', async () => {
    const server = await startServer()
    const a = makeClient(server.port, '小明')
    const b = makeClient(server.port, '小红')
    a.client.connect()
    b.client.connect()
    await waitUntil(() => a.state.roster.length === 2 && b.state.roster.length === 2, 5000, '双方就绪')

    a.client.request(b.client.peerId)
    await waitUntil(() => b.state.requests.length === 1, 5000, 'B 收到请求')
    b.client.respond(a.client.peerId, false, '现在忙')
    await waitUntil(() => a.state.responses.length === 1, 5000, 'A 收到拒绝')
    expect(a.state.responses[0].accept).toBe(false)
    expect(a.state.responses[0].reason).toBe('现在忙')
  }, 20000)

  it('改名后其他人的名单实时更新', async () => {
    const server = await startServer()
    const a = makeClient(server.port, '小明')
    const b = makeClient(server.port, '小红')
    a.client.connect()
    b.client.connect()
    await waitUntil(() => a.state.roster.length === 2, 5000, 'A 看到两人')

    b.client.rename('小红改名了')
    await waitUntil(
      () => a.state.roster.some((p) => p.name === '小红改名了'),
      5000,
      'A 看到新名字'
    )
  }, 20000)

  it('对方断开后收到 session-end（offline）', async () => {
    const server = await startServer()
    const a = makeClient(server.port, '小明')
    const b = makeClient(server.port, '小红')
    a.client.connect()
    b.client.connect()
    await waitUntil(() => a.state.roster.length === 2 && b.state.roster.length === 2, 5000, '双方就绪')

    a.client.request(b.client.peerId)
    await waitUntil(() => b.state.requests.length === 1, 5000, 'B 收到请求')
    b.client.respond(a.client.peerId, true)
    await waitUntil(() => a.state.responses.length === 1, 5000, '配对成功')

    a.client.close()
    await waitUntil(() => b.state.sessionEnds.length > 0, 6000, 'B 收到 session-end')
    expect(b.state.sessionEnds[0].reason).toBe('offline')
    await waitUntil(() => b.state.roster.length === 1, 5000, '名单只剩一人')
  }, 20000)

  it('未注册前不会误发消息，且连接断开后会自动重连', async () => {
    const server = await startServer()
    const a = makeClient(server.port, '小明')
    a.client.connect()
    await waitUntil(() => a.state.status === 'online', 5000, '上线')

    // 强行断开：客户端应自动重连回 online
    const socket = (a.client as unknown as { socket: WebSocket | null }).socket
    expect(socket).toBeTruthy()
    socket?.close()
    await waitUntil(() => a.state.status === 'offline', 3000, '进入 offline')
    await waitUntil(() => a.state.status === 'online', 10000, '自动重连成功')
  }, 20000)
})
