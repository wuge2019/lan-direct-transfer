/**
 * 文件分片传输引擎（与框架无关，可单独测试）
 *
 * 设计要点：
 *  1) 顺序传输：一次只传一个文件，接收端无需在数据块里塞头部；
 *  2) 信用流控（credit）：接收端每写完 N 个分片回执一次，发送端信用
 *     耗尽即暂停，避免慢磁盘时数据在接收端内存里堆积；
 *  3) 恒定内存：发送端用 file.slice().arrayBuffer() 逐片读取，
 *     接收端可走 File System Access API 流式写盘；
 *  4) 增量 CRC-32：边传边算，结束时比对，检出传输错误；
 *  5) 控制通道与数据通道是两条独立的 SCTP 流，file-done 可能先于最后
 *     一个分片到达，因此收尾必须等字节数对齐（pendingDone 机制）；
 *  6) 每个二进制分片带 4 字节流号头（见 DATA_HEADER_SIZE）。取消一个传输后，
 *     数据通道里仍可能有在途分片，它们只能靠流号被识别并丢弃；否则这些残留
 *     分片会被算进「下一个」文件，把新文件写坏。
 */

import { crc32Hex, crc32Update } from './crc32'
import { formatBytes, throttle, uid, yieldMacrotask } from './utils'
import type { CtrlMsg, Sink, TransferRecord, TransferState } from './types'

export const CHUNK_SIZE = 16 * 1024
export const WINDOW_CHUNKS = 64
export const CREDIT_BATCH = 16
/** 每个二进制分片前面 4 字节大端流号 */
export const DATA_HEADER_SIZE = 4
const BUFFERED_HIGH = 4 * 1024 * 1024
const ACK_TIMEOUT = 120_000
const CREDIT_WAIT_TIMEOUT = 60_000

/** 全局递增的流号：一次会话内不复用，用于区分不同文件的数据分片 */
let streamCounter = 0

export interface TransferManagerOptions {
  sendCtrl: (msg: CtrlMsg) => boolean | void
  getChannel: () => RTCDataChannel | null
  onUpdate: (rec: TransferRecord) => void
  onIncomingOffer?: (rec: TransferRecord) => void
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void
}

interface CreditWaiter {
  resolve: () => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** 终态：一旦到达就不允许再被别的路径覆盖（避免“已取消”被改写成“失败”等） */
const TERMINAL_STATES: TransferState[] = ['done', 'failed', 'cancelled', 'rejected']

function isTerminal(state: TransferState): boolean {
  return TERMINAL_STATES.includes(state)
}

function baseRecord(dir: 'in' | 'out'): TransferRecord {
  return {
    id: uid('f'),
    streamId: 0,
    dir,
    name: '',
    size: 0,
    mime: 'application/octet-stream',
    lastModified: Date.now(),
    state: dir === 'out' ? 'queued' : 'pending',
    file: null,
    sent: 0,
    received: 0,
    written: 0,
    sink: null,
    savePath: '',
    url: '',
    pendingDone: null,
    finishing: false,
    crc: 0,
    startedAt: 0,
    speed: 0,
    eta: 0,
    error: '',
    cancelRequested: false,
    lastBytes: 0,
    lastTick: 0,
    chain: Promise.resolve(),
    ack: null
  }
}

export class TransferManager {
  private readonly opts: TransferManagerOptions
  private readonly outgoing = new Map<string, TransferRecord>()
  private readonly incoming = new Map<string, TransferRecord>()
  /** 流号 -> 记录，用于把数据通道分片路由到正确的传输 */
  private readonly streams = new Map<number, TransferRecord>()
  private queue: TransferRecord[] = []
  private activeOut: TransferRecord | null = null
  private credits = 0
  private creditWaiters: CreditWaiter[] = []
  private throttledEmit: ((rec: TransferRecord) => void) | null = null

  constructor(options: TransferManagerOptions) {
    this.opts = options
  }

  private log(message: string, level?: 'info' | 'warn' | 'error'): void {
    this.opts.log?.(message, level)
  }

  /* ---------------- 公共 API ---------------- */

  /** 把文件加入发送队列（返回创建的记录，便于测试与 UI 关联） */
  enqueue(files: File[] | FileList): TransferRecord[] {
    const list = Array.prototype.slice.call(files) as File[]
    const created: TransferRecord[] = []
    for (const file of list) {
      const rec = baseRecord('out')
      rec.streamId = ++streamCounter
      rec.name = file.name || '未命名文件'
      rec.size = file.size
      rec.mime = file.type || 'application/octet-stream'
      rec.lastModified = file.lastModified || Date.now()
      rec.file = file
      this.outgoing.set(rec.id, rec)
      this.streams.set(rec.streamId, rec)
      this.queue.push(rec)
      created.push(rec)
      this.emit(rec)
    }
    this.pump()
    return created
  }

  /** 接收端接受文件；sink 由 UI 层创建（选择保存位置需要用户手势） */
  accept(id: string, sink: Sink): boolean {
    const rec = this.incoming.get(id)
    if (!rec || rec.state !== 'pending') return false
    rec.sink = sink
    rec.state = 'receiving'
    rec.startedAt = performance.now()
    rec.lastTick = rec.startedAt
    rec.lastBytes = 0
    this.opts.sendCtrl({ t: 'file-accept', id })
    this.log(`已接受文件：${rec.name}（保存方式 ${sink.kind}）`)
    this.emit(rec)
    return true
  }

  reject(id: string, reason = '对方拒绝接收'): void {
    const rec = this.incoming.get(id)
    if (!rec) return
    rec.state = 'rejected'
    rec.error = reason
    this.opts.sendCtrl({ t: 'file-reject', id })
    this.emit(rec)
  }

  cancel(id: string): void {
    const out = this.outgoing.get(id)
    if (out && ['sending', 'offered', 'queued', 'verifying'].includes(out.state)) {
      out.cancelRequested = true
      this.opts.sendCtrl({ t: 'file-cancel', id })
      if (out.state !== 'sending') this.finishOut(out, 'cancelled', '已取消')
      this.flushCreditWaiters()
      return
    }
    const inc = this.incoming.get(id)
    if (inc && (inc.state === 'receiving' || inc.state === 'pending')) {
      inc.cancelRequested = true
      this.opts.sendCtrl({ t: 'file-cancel', id })
      if (inc.state === 'pending') {
        inc.state = 'cancelled'
        inc.error = '已取消'
        this.emit(inc)
      } else {
        this.closeIncoming(inc, 'cancelled', '已取消')
      }
    }
  }

  /** 处理控制通道上的文件协议消息 */
  handleCtrl(msg: CtrlMsg): void {
    if (!msg || !msg.t) return
    switch (msg.t) {
      case 'file-offer': return this.onOffer(msg)
      case 'file-accept': return this.onAccept(msg)
      case 'file-reject': return this.onReject(msg)
      case 'credit': return this.onCredit(msg)
      case 'file-done': return this.onDone(msg)
      case 'file-ack': return this.onAck(msg)
      case 'file-cancel': return this.onCancel(msg)
      default: return
    }
  }

  /** 收到数据通道上的二进制分片（前 4 字节为流号） */
  handleBinary(arrayBuffer: ArrayBuffer): void {
    if (arrayBuffer.byteLength < DATA_HEADER_SIZE) {
      this.log(`丢弃了一个过短的数据分片（${arrayBuffer.byteLength} 字节）`, 'warn')
      return
    }
    const streamId = new DataView(arrayBuffer).getUint32(0)
    const rec = this.streams.get(streamId)
    const payloadLength = arrayBuffer.byteLength - DATA_HEADER_SIZE

    // 记录不存在、或已经不在接收中，说明是上一个传输的在途分片，
    // 必须丢弃，绝不能算到当前文件头上
    if (!rec || rec.state !== 'receiving') {
      this.log(`丢弃了一个已失效的数据分片（流 ${streamId}，${payloadLength} 字节）`, 'warn')
      return
    }

    const bytes = new Uint8Array(arrayBuffer, DATA_HEADER_SIZE, payloadLength)
    rec.received += bytes.length
    // 超出声明大小说明协议出错，立刻停下来，不要继续往磁盘写
    if (rec.received > rec.size) {
      this.opts.sendCtrl({ t: 'file-cancel', id: rec.id })
      this.closeIncoming(rec, 'failed', `收到超出声明大小的数据：${rec.received} > ${rec.size}`)
      return
    }
    rec.crc = crc32Update(rec.crc, bytes)
    this.queueWrite(rec, bytes)
    this.progress(rec)

    // file-done 可能先于最后的分片到达，等字节数对齐后再收尾
    if (rec.pendingDone && rec.received >= rec.size) {
      const pending = rec.pendingDone
      rec.pendingDone = null
      this.completeIncoming(rec, pending)
    }
  }

  stats(): { sending: number; receiving: number } {
    let sending = 0
    let receiving = 0
    this.outgoing.forEach((r) => { if (r.state === 'sending') sending++ })
    this.incoming.forEach((r) => { if (r.state === 'receiving') receiving++ })
    return { sending, receiving }
  }

  /**
   * 连接断开时中止所有进行中的传输。
   * 注意：这里是「可恢复」的中止，管理器之后仍然可以继续发送新文件
   * （断开重连后不必刷新页面）。
   */
  abortAll(reason = '连接已断开'): void {
    this.outgoing.forEach((rec) => {
      if (['sending', 'offered', 'verifying', 'queued'].includes(rec.state)) {
        rec.cancelRequested = true
        this.finishOut(rec, 'failed', reason)
      }
    })
    this.incoming.forEach((rec) => {
      if (rec.state === 'receiving') this.closeIncoming(rec, 'failed', reason)
    })
    this.queue = []
    this.rejectWaiters(new Error(reason))
  }

  /* ---------------- 发送侧 ---------------- */

  private pump(): void {
    if (this.activeOut) return
    while (this.queue.length && this.queue[0].state !== 'queued') this.queue.shift()
    const rec = this.queue.shift()
    if (!rec) return
    const dc = this.opts.getChannel()
    if (!dc || dc.readyState !== 'open') {
      // 通道不可用时不能只失败队首：剩下的也要置终态，
      // 否则它们会永远停在“排队等待发送…”
      this.finishOut(rec, 'failed', '数据通道未就绪')
      this.failQueue('数据通道未就绪，请重新发送')
      return
    }
    this.activeOut = rec
    rec.state = 'offered'
    this.emit(rec)
    const sent = this.opts.sendCtrl({
      t: 'file-offer',
      id: rec.id,
      sid: rec.streamId,
      name: rec.name,
      size: rec.size,
      mime: rec.mime,
      lastModified: rec.lastModified
    })
    if (sent === false) {
      this.activeOut = null
      this.finishOut(rec, 'failed', '无法发送文件请求（控制通道不可用）')
      this.failQueue('数据通道未就绪，请重新发送')
      return
    }
    this.log(`已发出文件请求：${rec.name}（${formatBytes(rec.size)}）`)
  }

  /** 把剩余排队项全部置为失败（断开、通道不可用等场景） */
  private failQueue(reason: string): void {
    const pending = this.queue
    this.queue = []
    pending.forEach((rec) => {
      if (rec.state === 'queued') {
        rec.cancelRequested = true
        this.finishOut(rec, 'failed', reason)
      }
    })
  }

  private onAccept(msg: CtrlMsg): void {
    const rec = msg.id ? this.outgoing.get(msg.id) : undefined
    if (!rec || rec.state !== 'offered') return
    this.credits = WINDOW_CHUNKS
    void this.sendLoop(rec).catch((e: unknown) => {
      this.finishOut(rec, 'failed', e instanceof Error ? e.message : String(e))
      this.activeOut = null
      this.pump()
    })
  }

  private onReject(msg: CtrlMsg): void {
    const rec = msg.id ? this.outgoing.get(msg.id) : undefined
    if (!rec) return
    this.finishOut(rec, 'rejected', '对方拒绝了该文件')
    this.pump()
  }

  private async sendLoop(rec: TransferRecord): Promise<void> {
    const dc = this.opts.getChannel()
    rec.state = 'sending'
    rec.startedAt = performance.now()
    rec.lastTick = rec.startedAt
    rec.lastBytes = 0
    this.emit(rec)

    try {
      while (rec.sent < rec.size) {
        if (rec.cancelRequested) {
          this.finishOut(rec, 'cancelled', '已取消')
          this.activeOut = null
          this.pump()
          return
        }
        if (!dc || dc.readyState !== 'open') throw new Error('数据通道已关闭')

        if (this.credits <= 0) {
          await this.waitCredit()
          continue
        }
        if (dc.bufferedAmount > BUFFERED_HIGH) {
          await this.waitBufferedLow(dc)
          continue
        }

        const end = Math.min(rec.sent + CHUNK_SIZE, rec.size)
        const buf = await rec.file!.slice(rec.sent, end).arrayBuffer()
        if (rec.cancelRequested) continue
        if (!buf || buf.byteLength === 0) throw new Error('读取文件失败（读到空分片）')

        // 分片头部写入流号，接收端据此判断分片属于哪一次传输
        const framed = new Uint8Array(DATA_HEADER_SIZE + buf.byteLength)
        new DataView(framed.buffer).setUint32(0, rec.streamId)
        framed.set(new Uint8Array(buf), DATA_HEADER_SIZE)

        dc.send(framed.buffer)
        this.credits--
        rec.sent += buf.byteLength
        rec.crc = crc32Update(rec.crc, new Uint8Array(buf))
        this.progress(rec)
        // 定期让出主线程，保证进度条与界面不卡（用宏任务，避免后台标签页节流）
        if ((rec.sent / CHUNK_SIZE) % 32 === 0) await yieldMacrotask()
      }

      if (rec.cancelRequested) {
        this.finishOut(rec, 'cancelled', '已取消')
        this.activeOut = null
        this.pump()
        return
      }

      rec.state = 'verifying'
      this.emit(rec)
      this.opts.sendCtrl({ t: 'file-done', id: rec.id, crc: crc32Hex(rec.crc), size: rec.sent })

      const ack = await this.waitAck(rec, ACK_TIMEOUT)
      if (rec.cancelRequested) this.finishOut(rec, 'cancelled', '已取消')
      else if (ack && ack.ok) this.finishOut(rec, 'done', '')
      else this.finishOut(rec, 'failed', ack?.reason || '对方校验失败')
    } catch (e) {
      // 发送端自己失败时，必须让接收端也停下来，否则对方会永远停在“接收中”、
      // 并且留下半截文件
      this.opts.sendCtrl({ t: 'file-cancel', id: rec.id })
      this.finishOut(rec, rec.cancelRequested ? 'cancelled' : 'failed', e instanceof Error ? e.message : String(e))
    }
    this.activeOut = null
    this.pump()
  }

  private waitCredit(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: CreditWaiter = {
        resolve: () => {
          clearTimeout(waiter.timer)
          resolve()
        },
        reject: (err: Error) => {
          clearTimeout(waiter.timer)
          reject(err)
        },
        timer: setTimeout(() => {
          const i = this.creditWaiters.indexOf(waiter)
          if (i >= 0) this.creditWaiters.splice(i, 1)
          reject(new Error('等待对方接收超时（对方可能已暂停，或磁盘写入卡住）'))
        }, CREDIT_WAIT_TIMEOUT)
      }
      this.creditWaiters.push(waiter)
    })
  }

  /**
   * 唤醒所有等待信用的发送循环。
   * 必须**无条件**唤醒：调用方（取消 / 断开）恰恰发生在 credits 耗尽、
   * 发送循环正卡在 waitCredit 的时候；循环顶部会重新检查状态，虚假唤醒是安全的。
   */
  private flushCreditWaiters(): void {
    if (!this.creditWaiters.length) return
    const waiters = this.creditWaiters
    this.creditWaiters = []
    waiters.forEach((w) => w.resolve())
  }

  /** 让所有等待信用的发送循环立刻报错退出（连接断开时用） */
  private rejectWaiters(err: Error): void {
    if (!this.creditWaiters.length) return
    const waiters = this.creditWaiters
    this.creditWaiters = []
    waiters.forEach((w) => w.reject(err))
  }

  private waitBufferedLow(dc: RTCDataChannel): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        dc.removeEventListener('bufferedamountlow', finish)
        resolve()
      }
      try {
        dc.bufferedAmountLowThreshold = Math.floor(BUFFERED_HIGH / 2)
        dc.addEventListener('bufferedamountlow', finish)
      } catch {
        /* 忽略：个别实现不支持事件，下面有兜底定时器 */
      }
      setTimeout(finish, 3000)
    })
  }

  private waitAck(rec: TransferRecord, timeout: number): Promise<CtrlMsg | null> {
    return new Promise<CtrlMsg | null>((resolve) => {
      const timer = setTimeout(() => {
        rec.ack = null
        resolve(null)
      }, timeout)
      rec.ack = (msg: CtrlMsg) => {
        clearTimeout(timer)
        rec.ack = null
        resolve(msg)
      }
    })
  }

  private onAck(msg: CtrlMsg): void {
    const rec = msg.id ? this.outgoing.get(msg.id) : undefined
    if (rec && rec.ack) rec.ack(msg)
  }

  private onCredit(msg: CtrlMsg): void {
    // 只接受当前发送中记录的信用，并且限制单次与总量，避免异常/恶意对端撑爆窗口
    if (!this.activeOut || msg.id !== this.activeOut.id) return
    const n = Math.max(0, Math.min(Number(msg.n) || 0, WINDOW_CHUNKS))
    this.credits = Math.min(this.credits + n, WINDOW_CHUNKS + CREDIT_BATCH)
    this.flushCreditWaiters()
  }

  private onCancel(msg: CtrlMsg): void {
    const out = msg.id ? this.outgoing.get(msg.id) : undefined
    if (out && ['sending', 'offered', 'verifying', 'queued'].includes(out.state)) {
      out.cancelRequested = true
      if (out.state !== 'sending') this.finishOut(out, 'cancelled', '对方取消了传输')
      this.flushCreditWaiters()
    }
    const inc = msg.id ? this.incoming.get(msg.id) : undefined
    if (inc && (inc.state === 'receiving' || inc.state === 'pending')) {
      inc.cancelRequested = true
      if (inc.state === 'pending') {
        inc.state = 'cancelled'
        inc.error = '对方取消了传输'
        this.emit(inc)
      } else {
        this.closeIncoming(inc, 'cancelled', '对方取消了传输')
      }
    }
  }

  private finishOut(rec: TransferRecord, state: TransferState, error: string): void {
    // 幂等：终态不允许被后来的路径覆盖（例如 abortAll 之后 sendLoop 的 catch
    // 会把「连接已断开」改写成「已取消」）
    if (isTerminal(rec.state)) return
    rec.state = state
    rec.error = error || ''
    rec.speed = 0
    // 如果还在等对方回执，立即结束等待，避免空等超时
    if (rec.ack) rec.ack({ t: 'file-ack', ok: false, reason: error || '已结束' })
    this.emit(rec)
    if (state === 'done') {
      this.log(`文件发送完成：${rec.name}（${formatBytes(rec.size)}，CRC ${crc32Hex(rec.crc)}）`)
    } else if (state !== 'cancelled') {
      this.log(`文件发送结束（${state}）：${rec.name} ${error}`, 'warn')
    }
  }

  /* ---------------- 接收侧 ---------------- */

  private onOffer(msg: CtrlMsg): void {
    const rec = baseRecord('in')
    rec.id = msg.id || rec.id
    rec.streamId = Number(msg.sid) || 0
    rec.name = msg.name || '未命名文件'
    rec.size = Number(msg.size) || 0
    rec.mime = msg.mime || 'application/octet-stream'
    rec.lastModified = msg.lastModified || Date.now()
    this.incoming.set(rec.id, rec)
    if (rec.streamId) this.streams.set(rec.streamId, rec)
    this.emit(rec)
    this.log(`收到文件请求：${rec.name}（${formatBytes(rec.size)}），等待确认`)
    this.opts.onIncomingOffer?.(rec)
  }

  private queueWrite(rec: TransferRecord, chunk: Uint8Array): void {
    rec.chain = rec.chain
      .then(async () => {
        if (rec.cancelRequested || rec.state !== 'receiving' || !rec.sink) return
        await rec.sink.write(chunk)
        rec.written++
        if (rec.written % CREDIT_BATCH === 0 && rec.state === 'receiving') {
          this.opts.sendCtrl({ t: 'credit', id: rec.id, n: CREDIT_BATCH })
        }
      })
      .catch((e: unknown) => {
        if (rec.state === 'receiving') {
          this.opts.sendCtrl({ t: 'file-cancel', id: rec.id })
          this.closeIncoming(rec, 'failed', `写入本地文件失败：${e instanceof Error ? e.message : String(e)}`)
        }
      })
  }

  private onDone(msg: CtrlMsg): void {
    const rec = msg.id ? this.incoming.get(msg.id) : undefined
    if (!rec || rec.state !== 'receiving') return
    if (rec.received < rec.size) {
      rec.pendingDone = msg
      this.log(`收到结束标记，但还有 ${rec.size - rec.received} 字节分片在路上，等待中…`)
      return
    }
    this.completeIncoming(rec, msg)
  }

  /** 收尾：等写入链结束 -> 关闭文件 -> 校验 -> 回执 */
  private completeIncoming(rec: TransferRecord, msg: CtrlMsg): void {
    if (rec.finishing) return
    rec.finishing = true
    rec.chain
      .then(async () => {
        if (rec.state !== 'receiving' || !rec.sink) return
        const okSize = rec.received === rec.size && rec.received === Number(msg.size ?? rec.size)
        const localCrc = crc32Hex(rec.crc)
        const remoteCrc = String(msg.crc || '').toLowerCase()
        const okCrc = localCrc === remoteCrc
        const res = await rec.sink.close()

        // 关闭文件是异步的，期间用户可能点了取消：此时不能把状态改成 done，
        // 更不能自动下载/保存
        if (rec.state !== 'receiving' || rec.cancelRequested) {
          if (res.url) {
            try {
              URL.revokeObjectURL(res.url)
            } catch {
              /* 忽略 */
            }
          }
          return
        }

        rec.url = res.url || ''
        rec.savePath = res.path || rec.name
        if (okSize && okCrc) {
          rec.state = 'done'
          this.log(`文件接收完成：${rec.name}（${formatBytes(rec.received)}，CRC ${localCrc} 校验通过）`)
        } else {
          rec.state = 'failed'
          rec.error = !okSize
            ? `大小不一致：收到 ${rec.received} / 应为 ${rec.size}`
            : `CRC 校验不通过：本地 ${localCrc} ≠ 对方 ${remoteCrc}`
          this.log(`文件接收失败：${rec.name} —— ${rec.error}`, 'error')
        }
        rec.speed = 0
        this.opts.sendCtrl({ t: 'file-ack', id: rec.id, ok: rec.state === 'done', reason: rec.error || '' })
        this.emit(rec)
        this.autoDownload(rec)
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        this.closeIncoming(rec, 'failed', `收尾失败：${message}`)
        this.opts.sendCtrl({ t: 'file-ack', id: rec.id, ok: false, reason: message })
      })
  }

  private closeIncoming(rec: TransferRecord, state: TransferState, error: string): void {
    if (isTerminal(rec.state)) return
    const sink = rec.sink
    rec.state = state
    rec.error = error || ''
    rec.speed = 0
    if (sink) {
      void Promise.resolve(sink.abort()).catch(() => undefined).then(() => this.emit(rec))
    } else {
      this.emit(rec)
    }
    if (state === 'failed') this.log(`文件接收失败：${rec.name} —— ${rec.error}`, 'error')
  }

  /** 内存模式接收完成后自动触发一次下载（UI 里仍保留手动保存入口） */
  private autoDownload(rec: TransferRecord): void {
    if (!rec.url || typeof document === 'undefined') return
    try {
      const a = document.createElement('a')
      a.href = rec.url
      a.download = rec.name
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      setTimeout(() => a.remove(), 1000)
    } catch {
      /* 浏览器可能拦截自动下载，忽略即可 */
    }
  }

  /* ---------------- 进度与事件 ---------------- */

  private progress(rec: TransferRecord): void {
    const now = performance.now()
    const dt = now - (rec.lastTick || now)
    if (dt >= 150) {
      const done = rec.dir === 'out' ? rec.sent : rec.received
      const delta = done - (rec.lastBytes || 0)
      rec.speed = delta / (dt / 1000)
      rec.eta = rec.speed > 0 ? (rec.size - done) / rec.speed : 0
      rec.lastBytes = done
      rec.lastTick = now
      this.emit(rec)
    } else {
      if (!this.throttledEmit) {
        this.throttledEmit = throttle((r: TransferRecord) => this.opts.onUpdate(r), 120)
      }
      this.throttledEmit(rec)
    }
  }

  private emit(rec: TransferRecord): void {
    try {
      this.opts.onUpdate(rec)
    } catch (e) {
      console.error(e)
    }
  }

  /** 当前可用的分片信用额度（诊断/测试用） */
  get pendingCredits(): number {
    return this.credits
  }

  /** 仅供测试：读取内部记录 */
  getRecord(id: string): TransferRecord | undefined {
    return this.outgoing.get(id) || this.incoming.get(id)
  }
}
