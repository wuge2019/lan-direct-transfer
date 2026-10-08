/**
 * 交叉实现验证：用「前端真实的客户端」去打「Go 版后端」
 *
 * 这里刻意不复用 Go 自己的测试客户端，而是用：
 *   - src/lib/discovery.ts（浏览器里跑的那份代码）+ undici 的 WebSocket
 *   - node-datachannel（真实 WebRTC 协议栈）
 * 这样能证明 Go 后端与 Node 后端在协议层面可以互相替换。
 *
 * 若本机没有 Go 工具链，整个文件自动跳过。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DiscoveryClient, probeServer, type RemotePeer } from '../src/lib/discovery'
import { TestAgent, sleep, waitUntil, webRTCAvailable } from './helpers/agent'
import { crc32, crc32Hex } from '../src/lib/crc32'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const goSourceDir = path.join(repoRoot, 'server-go')

/** Go 工具链是否可用（不可用则整体跳过） */
let goAvailable = false
try {
  const probe = spawnSync('go', ['version'], { encoding: 'utf8', timeout: 30000 })
  goAvailable = probe.status === 0 && /go version/.test(String(probe.stdout || ''))
} catch {
  goAvailable = false
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

let workDir = ''
let binaryPath = ''
let child: ChildProcess | null = null
let baseUrl = ''
let serverOutput = ''

beforeAll(async () => {
  if (!goAvailable) return

  workDir = await mkdtemp(path.join(tmpdir(), 'lan-go-server-'))
  binaryPath = path.join(workDir, process.platform === 'win32' ? 'lan-server.exe' : 'lan-server')

  const build = spawnSync('go', ['build', '-o', binaryPath, '.'], {
    cwd: goSourceDir,
    encoding: 'utf8',
    timeout: 240000
  })
  if (build.status !== 0) {
    throw new Error(`go build 失败：${build.stderr || build.stdout}`)
  }

  const port = await freePort()
  child = spawn(binaryPath, ['-port', String(port), '-host', '127.0.0.1', '-open=false'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (chunk: Buffer) => {
    serverOutput += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    serverOutput += chunk.toString('utf8')
  })

  baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30000
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/api/info`)
      if (response.ok) break
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) {
      throw new Error(`Go 服务 30 秒内没有就绪。输出：\n${serverOutput}`)
    }
    await sleep(150)
  }
}, 300000)

afterAll(async () => {
  if (child) {
    child.kill()
    await sleep(200)
    if (!child.killed) child.kill('SIGKILL')
    child = null
  }
  if (workDir) {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}, 60000)

/* ---------------- 断言用的辅助 ---------------- */

const clients: DiscoveryClient[] = []
const agents: TestAgent[] = []

function makeClient(name: string): { client: DiscoveryClient; state: Record<string, unknown> } {
  const state: {
    status: string
    roster: RemotePeer[]
    requests: RemotePeer[]
    responses: Array<{ peerId: string; accept: boolean; reason: string }>
    signals: Array<{ peerId: string; payload: string }>
    sessionEnds: Array<{ peerId: string; reason: string }>
    errors: Array<{ code: string; message: string }>
  } = { status: 'idle', roster: [], requests: [], responses: [], signals: [], sessionEnds: [], errors: [] }

  const client = new DiscoveryClient(baseUrl, name, {
    onStatus: (status) => {
      state.status = status
    },
    onRoster: (peers) => {
      state.roster = peers
    },
    onRequest: (from) => {
      state.requests.push(from)
    },
    onResponse: (peerId, accept, reason) => {
      state.responses.push({ peerId, accept, reason })
    },
    onSignal: (peerId, payload) => {
      state.signals.push({ peerId, payload })
    },
    onSessionEnd: (peerId, reason) => {
      state.sessionEnds.push({ peerId, reason })
    },
    onError: (code, message) => {
      state.errors.push({ code, message })
    }
  })
  clients.push(client)
  return { client, state: state as unknown as Record<string, unknown> }
}

afterEach(async () => {
  while (agents.length) agents.pop()?.close()
  while (clients.length) clients.pop()?.close()
  await sleep(50)
})

describe.skipIf(!goAvailable)('Go 后端：接口与静态托管', () => {
  it('/api/info 字段与 Node 版一致，前端探测能识别', async () => {
    const info = await probeServer(baseUrl)
    expect(info).not.toBeNull()
    expect(info?.app).toBe('lan-direct-transfer')
    expect(info?.protocol).toBe(1)
    expect(typeof info?.serverName).toBe('string')

    const raw = (await (await fetch(`${baseUrl}/api/info`)).json()) as Record<string, unknown>
    expect(raw.peers).toBe(0)
    expect(Array.isArray(raw.urls)).toBe(true)
    expect(typeof raw.startedAt).toBe('number')
  })

  it('能把构建好的前端页面托管出来（存在 dist 时）', async () => {
    const indexPath = path.join(repoRoot, 'dist', 'index.html')
    const exists = await stat(indexPath).then(
      () => true,
      () => false
    )
    const response = await fetch(`${baseUrl}/`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    if (exists) {
      expect(html).toContain('局域网直连')
    } else {
      expect(html).toContain('还没有构建前端产物')
    }
  })
})

describe.skipIf(!goAvailable)('Go 后端：真实客户端互通', () => {
  it('名单 / 改名 / 请求 / 同意 / 双向信令', async () => {
    const a = makeClient('小明')
    const b = makeClient('小红')

    a.client.connect()
    b.client.connect()
    await waitUntil(() => a.client.ready && b.client.ready, 15000, '双方连上 Go 服务')

    const stateA = a.state as { roster: RemotePeer[] }
    const stateB = b.state as { roster: RemotePeer[]; requests: RemotePeer[]; signals: Array<{ payload: string }> }
    const stateAExtra = a.state as {
      responses: Array<{ accept: boolean }>
      signals: Array<{ payload: string }>
    }

    await waitUntil(() => stateA.roster.length === 2, 10000, 'A 看到两个人')
    const other = stateA.roster.find((peer) => peer.peerId !== a.client.peerId)
    expect(other?.name).toBe('小红')

    // 改名
    a.client.rename('小明二号')
    await waitUntil(() => stateB.roster.some((peer) => peer.name === '小明二号'), 10000, 'B 看到新名字')

    // 请求 → 同意
    a.client.request(b.client.peerId)
    await waitUntil(() => stateB.requests.length === 1, 10000, 'B 收到请求')
    expect(stateB.requests[0].name).toBe('小明二号')
    b.client.respond(a.client.peerId, true)
    await waitUntil(() => stateAExtra.responses.length === 1, 10000, 'A 收到同意')
    expect(stateAExtra.responses[0].accept).toBe(true)

    // 双向信令
    a.client.sendSignal(b.client.peerId, 'P2P1-offer')
    await waitUntil(() => stateB.signals.length === 1, 10000, 'B 收到信令')
    expect(stateB.signals[0].payload).toBe('P2P1-offer')
    b.client.sendSignal(a.client.peerId, 'P2P1-answer')
    await waitUntil(() => stateAExtra.signals.length === 1, 10000, 'A 收到信令')

    // bye 结束会话
    const stateBExtra = b.state as { sessionEnds: Array<{ reason: string }> }
    a.client.bye(b.client.peerId)
    await waitUntil(() => stateBExtra.sessionEnds.length === 1, 10000, 'B 收到 session-end')
    expect(stateBExtra.sessionEnds[0].reason).toBe('bye')
  }, 60000)

  it('拒绝会带上原因；断线会收到 offline 通知', async () => {
    const a = makeClient('甲')
    const b = makeClient('乙')
    a.client.connect()
    b.client.connect()
    await waitUntil(() => a.client.ready && b.client.ready, 15000, '双方连上')

    const stateA = a.state as {
      roster: RemotePeer[]
      responses: Array<{ accept: boolean; reason: string }>
      sessionEnds: Array<{ reason: string }>
    }
    const stateB = b.state as { requests: RemotePeer[]; roster: RemotePeer[]; sessionEnds: Array<{ reason: string }> }
    await waitUntil(() => stateA.roster.length === 2 && stateB.roster.length === 2, 10000, '名单就绪')

    a.client.request(b.client.peerId)
    await waitUntil(() => stateB.requests.length === 1, 10000, 'B 收到请求')
    b.client.respond(a.client.peerId, false, '现在忙')
    await waitUntil(() => stateA.responses.length === 1, 10000, 'A 收到拒绝')
    expect(stateA.responses[0].accept).toBe(false)
    expect(stateA.responses[0].reason).toBe('现在忙')

    // 服务端有 1.5 秒的请求冷却（防止连点骚扰），这里等一下再发起第二次
    await sleep(1700)
    a.client.request(b.client.peerId)
    await waitUntil(() => stateB.requests.length === 2, 10000, 'B 收到第二次请求')
    b.client.respond(a.client.peerId, true)
    await waitUntil(() => stateA.responses.length === 2, 10000, 'A 收到同意')

    // 让 A 掉线：B 应收到 offline
    a.client.close()
    await waitUntil(() => stateB.sessionEnds.length === 1, 15000, 'B 收到 offline')
    expect(stateB.sessionEnds[0].reason).toBe('offline')
  }, 60000)

  it('未配对的第三方不能转发信令', async () => {
    const a = makeClient('甲')
    const b = makeClient('乙')
    const c = makeClient('路人')
    a.client.connect()
    b.client.connect()
    c.client.connect()
    await waitUntil(() => a.client.ready && b.client.ready && c.client.ready, 15000, '三方连上')
    await waitUntil(() => (c.state as { roster: RemotePeer[] }).roster.length === 3, 10000, '三方名单就绪')

    c.client.sendSignal(a.client.peerId, '偷偷发')
    await waitUntil(() => (c.state as { errors: Array<{ code: string }> }).errors.length > 0, 10000, 'C 收到错误')
    expect((c.state as { errors: Array<{ code: string }> }).errors[0].code).toBe('not-paired')
    await sleep(200)
    expect((a.state as { signals: unknown[] }).signals.length).toBe(0)
  }, 60000)
})

describe.skipIf(!goAvailable || !webRTCAvailable)('Go 后端：全链路（真实 WebRTC 传文件）', () => {
  it('甲点选乙 → 乙同意 → 自动握手 → 真实传完 1.5MB 并校验 CRC', async () => {
    const jia = new TestAgent('甲', baseUrl)
    const yi = new TestAgent('乙', baseUrl)
    agents.push(jia, yi)

    jia.discovery.connect()
    yi.discovery.connect()
    await waitUntil(() => jia.discovery.ready && yi.discovery.ready, 15000, '双方连上 Go 服务')

    jia.discovery.request(yi.discovery.peerId)
    await waitUntil(() => yi.incomingRequests.length === 1, 15000, '乙收到连接请求')
    await waitUntil(() => jia.p2pConnected && yi.p2pConnected, 30000, '双向直连建立')
    expect(jia.peer.dataChannel?.readyState).toBe('open')
    expect(yi.peer.dataChannel?.readyState).toBe('open')

    const size = Math.floor(1.5 * 1024 * 1024)
    const data = new Uint8Array(size)
    for (let i = 0; i < size; i++) data[i] = (i * 5 + 3) & 0xff
    const file = new File([data], 'via-go-backend.bin', { type: 'application/octet-stream' })

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
})
