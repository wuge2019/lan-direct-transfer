import { beforeEach, describe, expect, it } from 'vitest'
import { TransferManager, CHUNK_SIZE, WINDOW_CHUNKS, CREDIT_BATCH, DATA_HEADER_SIZE } from '../src/lib/transfer'
import { memorySink } from '../src/lib/sinks'
import type { Sink, TransferRecord } from '../src/lib/types'
import { crc32Hex, crc32 } from '../src/lib/crc32'

/** 按协议给分片加上 4 字节流号头 */
function frame(streamId: number, payload: Uint8Array): ArrayBuffer {
  const buffer = new Uint8Array(DATA_HEADER_SIZE + payload.byteLength)
  new DataView(buffer.buffer).setUint32(0, streamId)
  buffer.set(payload, DATA_HEADER_SIZE)
  return buffer.buffer
}

/* Node 环境补丁：memorySink 结束时会调用 URL.createObjectURL */
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => `blob:mock-${Math.random().toString(36).slice(2)}`
}

/* ---------------- 模拟 DataChannel ---------------- */

interface MockChannel {
  readyState: string
  bufferedAmount: number
  bufferedAmountLowThreshold: number
  peer: MockChannel | null
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null
  send(buf: ArrayBuffer): void
  addEventListener(): void
  removeEventListener(): void
  close(): void
}

function makeChannelPair(): [MockChannel, MockChannel] {
  function endpoint(): MockChannel {
    return {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      peer: null,
      onmessage: null,
      send(buf: ArrayBuffer) {
        const copy = buf.slice(0)
        const target = this.peer
        setTimeout(() => target?.onmessage?.({ data: copy }), 0)
      },
      addEventListener() {},
      removeEventListener() {},
      close() {
        this.readyState = 'closed'
      }
    }
  }
  const a = endpoint()
  const b = endpoint()
  a.peer = b
  b.peer = a
  return [a, b]
}

function makeFile(name: string, size: number): { file: File; data: Uint8Array } {
  const data = new Uint8Array(size)
  for (let i = 0; i < size; i++) data[i] = (i * 17 + 3) & 0xff
  return { file: new File([data], name, { type: 'application/octet-stream' }), data }
}

interface PairOptions {
  rejectIncoming?: boolean
  manualAccept?: boolean
}

function makeManagers(options: PairOptions = {}) {
  const [chA, chB] = makeChannelPair()
  const logs: string[] = []

  // 两端互相引用，先声明带类型再赋值（避免 TS 的循环推断）
  let A: TransferManager
  let B: TransferManager

  A = new TransferManager({
    sendCtrl: (msg) => B.handleCtrl(msg),
    getChannel: () => chA as unknown as RTCDataChannel,
    onUpdate: () => {},
    log: (m) => logs.push(`A: ${m}`)
  })
  B = new TransferManager({
    sendCtrl: (msg) => A.handleCtrl(msg),
    getChannel: () => chB as unknown as RTCDataChannel,
    onUpdate: () => {},
    onIncomingOffer: (rec) => {
      if (options.rejectIncoming) {
        B.reject(rec.id, '测试拒绝')
        return
      }
      if (options.manualAccept) return
      B.accept(rec.id, memorySink(rec))
    },
    log: (m) => logs.push(`B: ${m}`)
  })

  // chX.send(...) 会把数据投递给对端的 onmessage，所以下面分别是 A / B 自己的接收回调
  chA.onmessage = (ev) => A.handleBinary(ev.data)
  chB.onmessage = (ev) => B.handleBinary(ev.data)

  return { A, B, chA, chB, logs }
}

async function waitFor(check: () => boolean, timeout = 20000, label = '条件'): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`等待超时：${label}`)
}

function recordOf(manager: TransferManager, id: string): TransferRecord {
  const rec = manager.getRecord(id)
  if (!rec) throw new Error('未找到传输记录')
  return rec
}

/* ---------------- 测试 ---------------- */

describe('传输引擎：端到端', () => {
  let ctx: ReturnType<typeof makeManagers>

  beforeEach(() => {
    ctx = makeManagers()
  })

  it('单个 2.5MB 文件完整传输（跨越信用窗口）', async () => {
    const { A, B } = ctx
    const { file, data } = makeFile('demo.bin', 2.5 * 1024 * 1024)
    const [out] = A.enqueue([file])
    await waitFor(() => out.state === 'done', 20000, '发送完成')

    const incoming = recordOf(B, out.id)
    expect(incoming.state).toBe('done')
    expect(incoming.received).toBe(file.size)
    expect(crc32Hex(incoming.crc)).toBe(crc32Hex(crc32(data)))
    expect(out.crc).toBe(crc32(data))
  }, 30000)

  it('多个文件按顺序排队传输', async () => {
    const { A, B } = ctx
    const f1 = makeFile('a.txt', 300 * 1024)
    const f2 = makeFile('b.txt', 900 * 1024)
    const outs = A.enqueue([f1.file, f2.file])
    await waitFor(() => outs.every((r) => r.state === 'done'), 20000, '两个文件都完成')
    expect(recordOf(B, outs[0].id).received).toBe(f1.file.size)
    expect(recordOf(B, outs[1].id).received).toBe(f2.file.size)
  }, 30000)

  it('对方拒绝后发送端进入 rejected，且不发送任何数据', async () => {
    ctx = makeManagers({ rejectIncoming: true })
    const { A, B } = ctx
    const { file } = makeFile('no.bin', 64 * 1024)
    const [out] = A.enqueue([file])
    await waitFor(() => out.state === 'rejected', 5000, '被拒绝')
    expect(out.sent).toBe(0)
    expect(recordOf(B, out.id).state).toBe('rejected')
  })

  it('数据损坏时 CRC 校验失败并互相通知', async () => {
    const { A, B } = ctx
    let corrupted = false
    const original = B.handleBinary.bind(B)
    B.handleBinary = (buf: ArrayBuffer) => {
      if (!corrupted && buf.byteLength > DATA_HEADER_SIZE) {
        corrupted = true
        // 破坏负载（不能动前 4 字节的流号，否则分片会被直接丢弃）
        new Uint8Array(buf)[DATA_HEADER_SIZE] ^= 0xff
      }
      original(buf)
    }
    const { file } = makeFile('bad.bin', 256 * 1024)
    const [out] = A.enqueue([file])
    await waitFor(() => out.state === 'failed' || out.state === 'done', 10000, '结束')
    expect(out.state).toBe('failed')
    expect(out.error).toMatch(/CRC|大小/)
    expect(recordOf(B, out.id).state).toBe('failed')
  }, 20000)

  it('发送端取消后，接收端同步结束且未收完', async () => {
    const { A, B } = ctx
    const { file } = makeFile('cancel.bin', 8 * 1024 * 1024)
    const [out] = A.enqueue([file])
    await waitFor(() => out.state === 'sending' && out.sent > 0, 5000, '开始发送')
    A.cancel(out.id)
    await waitFor(() => out.state === 'cancelled', 8000, '发送端已取消')
    await waitFor(() => recordOf(B, out.id).state === 'cancelled', 8000, '接收端已取消')
    expect(recordOf(B, out.id).received).toBeLessThan(file.size)
  }, 30000)

  it('空文件也能正常传输', async () => {
    const { A, B } = ctx
    const { file } = makeFile('empty.txt', 0)
    const [out] = A.enqueue([file])
    await waitFor(() => out.state === 'done', 5000, '空文件完成')
    expect(recordOf(B, out.id).received).toBe(0)
  })

  it('手动接受模式：确认前不发送数据', async () => {
    ctx = makeManagers({ manualAccept: true })
    const { A, B } = ctx
    const { file } = makeFile('wait.bin', 128 * 1024)
    const [out] = A.enqueue([file])
    await waitFor(() => recordOf(B, out.id).state === 'pending', 3000, '进入 pending')
    await new Promise((r) => setTimeout(r, 300))
    expect(out.sent).toBe(0)
    expect(out.state).toBe('offered')
    B.accept(out.id, memorySink(recordOf(B, out.id)))
    await waitFor(() => out.state === 'done', 10000, '接受后完成')
  }, 20000)

  it('file-done 早于最后一个分片到达时仍能正确收尾（控制/数据是两条 SCTP 流）', async () => {
    // 让控制消息插队：数据分片延迟投递，控制消息立即执行
    const [chA, chB] = makeChannelPair()
    let A: TransferManager
    let B: TransferManager
    A = new TransferManager({
      sendCtrl: (msg) => B.handleCtrl(msg),
      getChannel: () => chA as unknown as RTCDataChannel,
      onUpdate: () => {}
    })
    B = new TransferManager({
      sendCtrl: (msg) => A.handleCtrl(msg),
      getChannel: () => chB as unknown as RTCDataChannel,
      onUpdate: () => {},
      onIncomingOffer: (rec) => B.accept(rec.id, memorySink(rec))
    })
    // 接收回调延迟 5ms，模拟数据通道比控制通道慢
    chA.onmessage = (ev) => setTimeout(() => A.handleBinary(ev.data), 0)
    chB.onmessage = (ev) => setTimeout(() => B.handleBinary(ev.data), 5)

    const { file } = makeFile('race.bin', 256 * 1024)
    const [out] = A.enqueue([file])
    await waitFor(() => out.state === 'done', 15000, '乱序场景仍能完成')
    expect(recordOf(B, out.id).received).toBe(file.size)
    expect(recordOf(B, out.id).state).toBe('done')
  }, 25000)

  it('abortAll 之后仍然可以继续发送新文件（断开重连不必刷新页面）', async () => {
    const { A, B, chA, chB } = ctx
    const first = makeFile('first.bin', 4 * 1024 * 1024)
    const [out1] = A.enqueue([first.file])
    await waitFor(() => out1.state === 'sending' && out1.sent > 0, 5000, '第一条开始发送')

    A.abortAll('模拟断开')
    B.abortAll('模拟断开')
    await waitFor(() => out1.state === 'failed', 5000, '第一条被中止')

    // 模拟重连：通道重新打开，继续发送
    chA.readyState = 'open'
    chB.readyState = 'open'
    const second = makeFile('second.bin', 700 * 1024)
    const [out2] = A.enqueue([second.file])
    await waitFor(() => out2.state === 'done', 15000, '重连后仍能发送完成')
    expect(recordOf(B, out2.id).received).toBe(second.file.size)
    expect(recordOf(B, out2.id).state).toBe('done')
  }, 30000)

  it('分片大小不超过 16KB，保证任何浏览器都能收发', () => {
    expect(CHUNK_SIZE).toBeLessThanOrEqual(16 * 1024)
  })
})

/* =========================================================
 * 回归测试：以下缺陷都曾真实出现过，改动传输引擎时务必保持通过
 * ======================================================= */
describe('传输引擎：状态机回归', () => {
  it('信用耗尽（对端慢盘）时接收端取消，发送端必须立刻停下，而不是等 60 秒超时', async () => {
    const [chA, chB] = makeChannelPair()
    let A: TransferManager
    let B: TransferManager
    // 每片落盘 8ms 的“慢盘”：发送端大部分时间都卡在等信用
    const slowSink = (meta: { name: string; mime?: string }): Sink => {
      const inner = memorySink(meta)
      return {
        kind: 'memory',
        write: (chunk: Uint8Array) =>
          new Promise<void>((resolve) => {
            setTimeout(() => void inner.write(chunk).then(resolve), 8)
          }),
        close: () => inner.close(),
        abort: () => inner.abort()
      }
    }
    A = new TransferManager({
      sendCtrl: (msg) => B.handleCtrl(msg),
      getChannel: () => chA as unknown as RTCDataChannel,
      onUpdate: () => {}
    })
    B = new TransferManager({
      sendCtrl: (msg) => A.handleCtrl(msg),
      getChannel: () => chB as unknown as RTCDataChannel,
      onUpdate: () => {},
      onIncomingOffer: (rec) => B.accept(rec.id, slowSink(rec))
    })
    chA.onmessage = (ev) => A.handleBinary(ev.data)
    chB.onmessage = (ev) => B.handleBinary(ev.data)

    const { file } = makeFile('slow.bin', 4 * 1024 * 1024)
    const [out] = A.enqueue([file])
    await waitFor(() => out.state === 'sending' && out.sent >= WINDOW_CHUNKS * CHUNK_SIZE, 8000, '首个信用窗口发完')
    // 让发送端确实停在“等信用”上
    await new Promise((r) => setTimeout(r, 150))

    const started = Date.now()
    B.cancel(out.id)
    await waitFor(() => out.state === 'cancelled', 3000, '发送端立刻结束')
    expect(Date.now() - started).toBeLessThan(3000)
  }, 30000)

  it('数据通道未就绪时，排队中的所有文件都会进入终态（不会永远“排队等待发送…”）', async () => {
    const { A, chA } = makeManagers()
    chA.readyState = 'closed'
    const files = [makeFile('1.bin', 1024), makeFile('2.bin', 1024), makeFile('3.bin', 1024)]
    const outs = A.enqueue(files.map((f) => f.file))
    await waitFor(() => outs.every((o) => o.state === 'failed'), 3000, '全部失败')
    expect(outs.map((o) => o.state)).toEqual(['failed', 'failed', 'failed'])
  })

  it('abortAll 之后，排队中的文件也会进入终态', async () => {
    const { A } = makeManagers()
    const files = [makeFile('big.bin', 4 * 1024 * 1024), makeFile('2.bin', 1024), makeFile('3.bin', 1024)]
    const outs = A.enqueue(files.map((f) => f.file))
    await waitFor(() => outs[0].state === 'sending' && outs[0].sent > 0, 5000, '第一个开始发送')
    A.abortAll('模拟断开')
    await waitFor(() => outs.every((o) => o.state === 'failed'), 3000, '全部进入终态')
  }, 20000)

  it('终态不会被后续路径覆盖（abortAll 之后保持 failed 与原始原因）', async () => {
    const { A } = makeManagers()
    const { file } = makeFile('x.bin', 8 * 1024 * 1024)
    const [out] = A.enqueue([file])
    await waitFor(() => out.state === 'sending' && out.sent > 0, 5000, '开始发送')
    A.abortAll('连接已断开')
    expect(out.state).toBe('failed')
    // 给 sendLoop 的 catch 足够时间跑完：以前它会把状态改写成 cancelled
    await new Promise((r) => setTimeout(r, 400))
    expect(out.state).toBe('failed')
    expect(out.error).toBe('连接已断开')
  }, 20000)

  it('发送端读取失败时会通知接收端停止（不再永远停在“接收中”）', async () => {
    const { A, B } = makeManagers()
    const broken = {
      name: 'broken.bin',
      size: 256 * 1024,
      type: 'application/octet-stream',
      lastModified: Date.now(),
      slice: () => {
        throw new Error('模拟读取失败')
      }
    } as unknown as File

    const [out] = A.enqueue([broken])
    await waitFor(() => out.state === 'failed', 8000, '发送端失败')
    const incoming = recordOf(B, out.id)
    await waitFor(() => incoming.state !== 'receiving' && incoming.state !== 'pending', 5000, '接收端也结束')
    expect(incoming.state).toBe('cancelled')
  }, 20000)

  it('异常的超大 credit 会被限幅，错误 id 的 credit 被忽略', async () => {
    const { A } = makeManagers({ manualAccept: true })
    const { file } = makeFile('credit.bin', 4 * 1024 * 1024)
    const [out] = A.enqueue([file])
    await waitFor(() => out.state === 'offered', 3000, '进入 offered')
    A.handleCtrl({ t: 'file-accept', id: out.id })
    await waitFor(() => out.state === 'sending', 3000, '开始发送')

    A.handleCtrl({ t: 'credit', id: out.id, n: 1e9 })
    expect(A.pendingCredits).toBeLessThanOrEqual(WINDOW_CHUNKS + CREDIT_BATCH)

    const before = A.pendingCredits
    A.handleCtrl({ t: 'credit', id: 'not-this-file', n: 16 })
    expect(A.pendingCredits).toBe(before)
  }, 20000)

  it('收到的数据超过声明大小时立即失败并通知对方', async () => {
    const { A, B } = makeManagers({ manualAccept: true })
    const { file } = makeFile('small.bin', 32 * 1024)
    const [out] = A.enqueue([file])
    await waitFor(() => recordOf(B, out.id).state === 'pending', 3000, '等待确认')
    const incoming = recordOf(B, out.id)
    B.accept(incoming.id, memorySink(incoming))

    // 伪造一个「流号正确但负载超量」的分片
    B.handleBinary(frame(incoming.streamId, new Uint8Array(64 * 1024)))
    await waitFor(() => incoming.state === 'failed', 3000, '超量失败')
    expect(incoming.error).toMatch(/超出声明大小/)
    await waitFor(() => out.state !== 'sending', 5000, '发送端也结束')
    expect(['cancelled', 'failed']).toContain(out.state)
  }, 20000)

  it('取消后立刻发新文件：旧传输的在途分片不会污染新文件', async () => {
    const { A, B } = makeManagers()
    const first = makeFile('first.bin', 4 * 1024 * 1024)
    const [out1] = A.enqueue([first.file])
    await waitFor(() => out1.state === 'sending' && out1.sent > 0, 5000, '第一条开始发送')

    // 接收端取消：此刻数据通道里还有大量在途分片
    B.cancel(out1.id)

    const second = makeFile('second.bin', 300 * 1024)
    const [out2] = A.enqueue([second.file])
    await waitFor(() => out2.state === 'done' || out2.state === 'failed', 15000, '第二条结束')

    expect(out2.state).toBe('done')
    const incoming = recordOf(B, out2.id)
    expect(incoming.received).toBe(second.file.size)
    expect(crc32Hex(incoming.crc)).toBe(crc32Hex(crc32(second.data)))
    expect(incoming.state).toBe('done')
  }, 30000)

  it('没有流号头 / 流号失效的分片会被丢弃，不会算进当前文件', async () => {
    const { A, B } = makeManagers({ manualAccept: true })
    const { file } = makeFile('target.bin', 64 * 1024)
    const [out] = A.enqueue([file])
    await waitFor(() => recordOf(B, out.id).state === 'pending', 3000, '等待确认')
    const incoming = recordOf(B, out.id)
    B.accept(incoming.id, memorySink(incoming))

    B.handleBinary(new ArrayBuffer(2)) // 太短
    B.handleBinary(frame(incoming.streamId + 9999, new Uint8Array(1024))) // 不存在的流
    await new Promise((r) => setTimeout(r, 100))
    expect(incoming.received).toBeLessThanOrEqual(file.size)
    expect(incoming.state).not.toBe('failed')
  }, 20000)
})
