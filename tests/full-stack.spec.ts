/**
 * 全链路端到端测试（Node 版后端）：发现服务 → 点选用户 → 对方同意 → 真实 WebRTC 握手 → 真实传文件
 *
 * Go 版后端的同款用例见 tests/go-server.spec.ts —— 两个实现跑的是同一套断言。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createLanServer } from '../server/index.mjs'
import { TestAgent, sleep, waitUntil, webRTCAvailable } from './helpers/agent'
import { crc32, crc32Hex } from '../src/lib/crc32'

const servers: Array<{ close: () => Promise<void> }> = []
const agents: TestAgent[] = []

afterEach(async () => {
  while (agents.length) agents.pop()?.close()
  while (servers.length) {
    const server = servers.pop()
    if (server) await server.close()
  }
})

describe.skipIf(!webRTCAvailable)('全链路：发现服务 + 真实 WebRTC（Node 后端）', () => {
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

    jia.discovery.request(yi.discovery.peerId)
    await waitUntil(() => yi.incomingRequests.length === 1, 10000, '乙收到连接请求')
    expect(yi.incomingRequests[0].name).toBe('甲')

    await waitUntil(() => jia.p2pConnected && yi.p2pConnected, 30000, '双向直连建立')
    expect(jia.peer.dataChannel?.readyState).toBe('open')
    expect(yi.peer.dataChannel?.readyState).toBe('open')

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
