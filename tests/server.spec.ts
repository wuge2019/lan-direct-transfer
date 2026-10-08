/**
 * 发现/信令服务测试
 *
 * 服务端是自己手写的极简 WebSocket 实现，所以这里用 Node 内置的
 * WebSocket 客户端（undici）做真实握手与真实帧收发，覆盖：
 *   握手 → 注册 → 在线名单 → 连接请求 → 同意/拒绝 → 信令转发 → 离线清理
 */
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createLanServer } from '../server/index.mjs'

interface ServerInstance {
  port: number
  peers: () => Array<{ peerId: string; name: string; busy: boolean }>
  close: () => Promise<void>
  options: { name: string }
}

const running: ServerInstance[] = []

async function startServer(): Promise<ServerInstance> {
  const instance = (await createLanServer({
    port: 0,
    host: '127.0.0.1',
    name: '测试房间',
    quiet: true
  })) as unknown as ServerInstance
  running.push(instance)
  return instance
}

afterEach(async () => {
  while (running.length) {
    const instance = running.pop()
    if (instance) await instance.close()
  }
})

/** 极简测试客户端：把收到的消息排队，waitFor 会「消费」消息，便于按顺序等待 */
class TestClient {
  /** 全量历史，供 lastOf / countOf 断言 */
  readonly messages: Array<Record<string, unknown>> = []
  private readonly queue: Array<Record<string, unknown>> = []
  private readonly waiters: Array<{
    match: (m: Record<string, unknown>) => boolean
    resolve: (m: Record<string, unknown>) => void
    timer: ReturnType<typeof setTimeout>
  }> = []
  private readonly socket: WebSocket

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>
      this.messages.push(message)
      const index = this.waiters.findIndex((w) => w.match(message))
      if (index >= 0) {
        const waiter = this.waiters.splice(index, 1)[0]
        clearTimeout(waiter.timer)
        waiter.resolve(message)
      } else {
        this.queue.push(message)
      }
    })
  }

  static open(port: number): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      const client = new TestClient(socket)
      const timer = setTimeout(() => reject(new Error('连接超时')), 5000)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(client)
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('连接失败'))
      })
    })
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message))
  }

  /** 等待满足条件的下一条消息（已到达的会被消费掉） */
  waitForWhere(
    match: (m: Record<string, unknown>) => boolean,
    timeout = 3000,
    description = '消息'
  ): Promise<Record<string, unknown>> {
    const index = this.queue.findIndex(match)
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0])
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve: (message: Record<string, unknown>) => resolve(message),
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter)
          if (i >= 0) this.waiters.splice(i, 1)
          reject(new Error(`等待 ${description} 超时`))
        }, timeout)
      }
      this.waiters.push(waiter)
    })
  }

  waitFor(type: string, timeout = 3000): Promise<Record<string, unknown>> {
    return this.waitForWhere((m) => m.t === type, timeout, type)
  }

  waitForError(code: string, timeout = 3000): Promise<Record<string, unknown>> {
    return this.waitForWhere((m) => m.t === 'error' && m.code === code, timeout, `error:${code}`)
  }

  /** 取最后一次收到的某类型消息 */
  lastOf(type: string): Record<string, unknown> | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].t === type) return this.messages[i]
    }
    return undefined
  }

  countOf(type: string): number {
    return this.messages.filter((m) => m.t === type).length
  }

  close(): void {
    try {
      this.socket.close()
    } catch {
      /* 忽略 */
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function pair(a: TestClient, b: TestClient, idA = 'peer-a', idB = 'peer-b'): Promise<void> {
  a.send({ t: 'hello', peerId: idA, name: '小明' })
  b.send({ t: 'hello', peerId: idB, name: '小红' })
  await a.waitFor('roster')
  await b.waitFor('roster')
}

describe('发现/信令服务', () => {
  it('连接后先收到 welcome，包含协议版本与房间名', async () => {
    const server = await startServer()
    const client = await TestClient.open(server.port)
    const welcome = await client.waitFor('welcome')
    expect(welcome.protocol).toBe(1)
    expect(welcome.serverName).toBe('测试房间')
    client.close()
  })

  it('两人注册后互相出现在在线名单里', async () => {
    const server = await startServer()
    const a = await TestClient.open(server.port)
    const b = await TestClient.open(server.port)
    await pair(a, b)

    const roster = b.lastOf('roster') as { peers: Array<{ peerId: string; name: string }> }
    const ids = roster.peers.map((p) => p.peerId).sort()
    expect(ids).toEqual(['peer-a', 'peer-b'])
    expect(roster.peers.find((p) => p.peerId === 'peer-a')?.name).toBe('小明')
    a.close()
    b.close()
  })

  it('改名会广播给所有人', async () => {
    const server = await startServer()
    const a = await TestClient.open(server.port)
    const b = await TestClient.open(server.port)
    await pair(a, b)

    const before = b.countOf('roster')
    a.send({ t: 'rename', name: '小明二号' })
    await sleep(120)
    expect(b.countOf('roster')).toBeGreaterThan(before)
    const roster = b.lastOf('roster') as { peers: Array<{ peerId: string; name: string }> }
    expect(roster.peers.find((p) => p.peerId === 'peer-a')?.name).toBe('小明二号')
    a.close()
    b.close()
  })

  it('连接请求会送达对方，同意后双方进入 busy 并可互相转发信令', async () => {
    const server = await startServer()
    const a = await TestClient.open(server.port)
    const b = await TestClient.open(server.port)
    await pair(a, b)

    a.send({ t: 'request', to: 'peer-b' })
    const request = await b.waitFor('request')
    expect(request.from).toBe('peer-a')
    expect(request.name).toBe('小明')

    b.send({ t: 'response', to: 'peer-a', accept: true })
    const response = await a.waitFor('response')
    expect(response.accept).toBe(true)

    const roster = server.peers()
    expect(roster.every((p) => p.busy)).toBe(true)

    // 信令双向转发
    a.send({ t: 'signal', to: 'peer-b', payload: 'P2P1-offer-code' })
    const signal = await b.waitFor('signal')
    expect(signal.from).toBe('peer-a')
    expect(signal.payload).toBe('P2P1-offer-code')

    b.send({ t: 'signal', to: 'peer-a', payload: 'P2P1-answer-code' })
    const back = await a.waitFor('signal')
    expect(back.payload).toBe('P2P1-answer-code')

    a.close()
    b.close()
  })

  it('拒绝请求会通知发起方，且双方保持空闲', async () => {
    const server = await startServer()
    const a = await TestClient.open(server.port)
    const b = await TestClient.open(server.port)
    await pair(a, b)

    a.send({ t: 'request', to: 'peer-b' })
    await b.waitFor('request')
    b.send({ t: 'response', to: 'peer-a', accept: false, reason: '现在不方便' })

    const response = await a.waitFor('response')
    expect(response.accept).toBe(false)
    expect(response.reason).toBe('现在不方便')
    expect(server.peers().every((p) => !p.busy)).toBe(true)
    a.close()
    b.close()
  })

  it('未配对的第三方不能转发信令', async () => {
    const server = await startServer()
    const a = await TestClient.open(server.port)
    const b = await TestClient.open(server.port)
    const c = await TestClient.open(server.port)
    await pair(a, b)
    c.send({ t: 'hello', peerId: 'peer-c', name: '路人' })
    await c.waitFor('roster')

    c.send({ t: 'signal', to: 'peer-a', payload: 'x' })
    const error = await c.waitFor('error')
    expect(error.code).toBe('not-paired')
    expect(a.countOf('signal')).toBe(0)
    a.close()
    b.close()
    c.close()
  })

  it('有人正在连接时，第三方请求会被拒绝', async () => {
    const server = await startServer()
    const a = await TestClient.open(server.port)
    const b = await TestClient.open(server.port)
    const c = await TestClient.open(server.port)
    await pair(a, b)
    c.send({ t: 'hello', peerId: 'peer-c', name: '路人' })
    await c.waitFor('roster')

    a.send({ t: 'request', to: 'peer-b' })
    await b.waitFor('request')
    b.send({ t: 'response', to: 'peer-a', accept: true })
    await a.waitFor('response')

    c.send({ t: 'request', to: 'peer-b' })
    const response = await c.waitFor('response')
    expect(response.accept).toBe(false)
    a.close()
    b.close()
    c.close()
  })

  it('对端离线后，另一方收到 session-end 且名单更新', async () => {
    const server = await startServer()
    const a = await TestClient.open(server.port)
    const b = await TestClient.open(server.port)
    await pair(a, b)

    a.send({ t: 'request', to: 'peer-b' })
    await b.waitFor('request')
    b.send({ t: 'response', to: 'peer-a', accept: true })
    await a.waitFor('response')

    const before = b.countOf('session-end')
    a.close()
    const ended = await b.waitFor('session-end')
    expect(b.countOf('session-end')).toBeGreaterThan(before)
    expect(ended.peerId).toBe('peer-a')

    await sleep(150)
    expect(server.peers().map((p) => p.peerId)).toEqual(['peer-b'])
    b.close()
  })

  it('非法消息会返回可读错误，不会断开服务', async () => {
    const server = await startServer()
    const a = await TestClient.open(server.port)
    a.send({ t: 'unknown-thing' })
    expect((await a.waitForError('not-registered')).code).toBe('not-registered')

    a.send({ t: 'hello', peerId: 'peer-a', name: '小明' })
    await a.waitFor('hello-ok')
    a.send({ t: 'nonsense' })
    expect((await a.waitForError('unknown-type')).code).toBe('unknown-type')
    a.close()
  })

  it('非 JSON 文本帧被拒绝但连接仍可用', async () => {
    const server = await startServer()
    const a = await TestClient.open(server.port)
    // 直接塞一个非 JSON 字符串
    ;(a as unknown as { socket: WebSocket }).socket.send('这不是 JSON')
    const error = await a.waitFor('error')
    expect(error.code).toBe('bad-json')

    a.send({ t: 'hello', peerId: 'peer-a', name: '小明' })
    expect((await a.waitFor('hello-ok')).peerId).toBe('peer-a')
    a.close()
  })

  it('peerId 非法时拒绝注册', async () => {
    const server = await startServer()
    const a = await TestClient.open(server.port)
    a.send({ t: 'hello', peerId: '带空格的 id', name: 'x' })
    const error = await a.waitFor('error')
    expect(error.code).toBe('bad-peer-id')
    a.close()
  })
})

describe('HTTP 接口', () => {
  it('/api/info 返回服务信息且允许跨域读取', async () => {
    const server = await startServer()
    const response = await fetch(`http://127.0.0.1:${server.port}/api/info`)
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    const info = (await response.json()) as Record<string, unknown>
    expect(info.app).toBe('lan-direct-transfer')
    expect(info.protocol).toBe(1)
    expect(info.serverName).toBe('测试房间')
  })

  it('未知 /api 路径返回 404', async () => {
    const server = await startServer()
    const response = await fetch(`http://127.0.0.1:${server.port}/api/nope`)
    expect(response.status).toBe(404)
  })

  it('根路径返回页面（未构建时给出提示页）', async () => {
    const server = await startServer()
    const response = await fetch(`http://127.0.0.1:${server.port}/`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toMatch(/局域网直连|还没有构建前端产物/)
  })

  it('阻止目录穿越读取静态目录外的文件', async () => {
    const server = await startServer()
    const response = await fetch(`http://127.0.0.1:${server.port}/%2e%2e%2f%2e%2e%2fpackage.json`)
    const text = await response.text()
    // 越界请求会被 SPA 兜底成首页，绝不能返回 package.json 的内容
    expect(text).not.toContain('"devDependencies"')
    expect(text).not.toContain('@vitejs/plugin-vue')
    expect(response.headers.get('content-type')).toContain('text/html')
  })
})

describe('WebSocket 握手防护', () => {
  it('来自陌生 Origin 的握手被拒绝（403）', async () => {
    const server = await startServer()
    const raw = await rawHandshake(server.port, 'http://evil.example.com')
    expect(raw).toContain('403')
  })

  it('同源 Origin 的握手被接受（101）', async () => {
    const server = await startServer()
    const raw = await rawHandshake(server.port, `http://127.0.0.1:${server.port}`)
    expect(raw).toContain('101')
  })

  it('单文件版（Origin: null）的握手被接受，便于静态页面连本服务', async () => {
    const server = await startServer()
    const raw = await rawHandshake(server.port, 'null')
    expect(raw).toContain('101')
  })
})

/** 手工发一次 WebSocket 握手，返回响应头文本 */
function rawHandshake(port: number, origin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        'GET /ws HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          `Origin: ${origin}\r\n\r\n`
      )
    })
    let data = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('握手超时'))
    }, 4000)
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8')
      if (data.includes('\r\n\r\n')) {
        clearTimeout(timer)
        socket.destroy()
        resolve(data)
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
