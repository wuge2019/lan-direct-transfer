/**
 * WebRTC 连接层：DataChannel 建立、信令码生成/应用、心跳延迟、链路信息
 *
 * 与 Vue 无关，纯 TypeScript；所有状态变化都通过回调通知上层，
 * 便于单独测试与复用。
 *
 * 通道划分：
 *   ctrl —— 控制/文本（聊天、文件元信息、流控回执）
 *   data —— 二进制分片（文件数据本体）
 */

import { compact, describe, expand, pack, unpack, type SignalRole } from './sdp-codec'
import type { CtrlMsg, LogLevel, PeerStatus } from './types'
import { uid } from './utils'

/** ICE 候选收集最长等待时间：host 候选通常 <1s，留足时间给 STUN 反射候选 */
const ICE_GATHER_TIMEOUT = 5000

export interface PeerOptions {
  /** 信令/连接阶段状态变化 */
  onStatus: (status: PeerStatus, detail?: string) => void
  /** 双向连接就绪（两条通道都打开） */
  onOpen: () => void
  /** 连接结束 */
  onClosed: (reason: string) => void
  /** 系统提示文本 */
  onSys: (text: string) => void
  /** 收到对方聊天文本 */
  onChat: (text: string, ts: number) => void
  /** 对方昵称 */
  onPeerName: (name: string) => void
  /** 往返延迟（毫秒） */
  onRtt: (ms: number) => void
  /** 链路描述，如 host↔host @192.168.1.5:50000 */
  onPath: (text: string) => void
  /** 文件协议消息，交给 TransferManager 处理 */
  onFileMsg: (msg: CtrlMsg) => void
  /** 数据通道收到二进制分片 */
  onBinary: (buffer: ArrayBuffer) => void
  log: (message: string, level?: LogLevel) => void
  getIceServers: () => RTCIceServer[]
  getName: () => string
}

/** 部分 TS 版本的内置类型里没有 candidate-pair 的 selected 字段，这里兼容读取 */
function isSelected(pair: RTCIceCandidatePairStats): boolean {
  return Boolean((pair as unknown as { selected?: boolean }).selected)
}

export class Peer {  private pc: RTCPeerConnection | null = null
  private ctrl: RTCDataChannel | null = null
  private data: RTCDataChannel | null = null
  private generation = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private pendingPings = new Map<string, number>()
  private connectedFlag = false

  constructor(private readonly opts: PeerOptions) {}

  get connected(): boolean {
    return this.connectedFlag
  }

  get dataChannel(): RTCDataChannel | null {
    return this.data
  }

  get ctrlChannel(): RTCDataChannel | null {
    return this.ctrl
  }

  /** 发送控制消息；通道未就绪时返回 false */
  send(msg: CtrlMsg): boolean {
    if (!this.ctrl || this.ctrl.readyState !== 'open') return false
    try {
      this.ctrl.send(JSON.stringify(msg))
      return true
    } catch (e) {
      this.opts.log(`发送控制消息失败：${e instanceof Error ? e.message : String(e)}`, 'error')
      return false
    }
  }

  /* ---------------- 发起方 ---------------- */

  async createInvite(): Promise<string> {
    this.teardown()
    const gen = this.generation
    this.opts.onStatus('creating')
    const pc = this.createPeerConnection(gen)
    this.attachChannel(pc.createDataChannel('ctrl', { ordered: true }), gen)
    this.attachChannel(pc.createDataChannel('data', { ordered: true }), gen)

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await this.waitForIce(pc, ICE_GATHER_TIMEOUT)

    const { code, candidates } = this.buildCode(pc, 'o')
    this.opts.log(`邀请码已生成（含 ${candidates} 个候选地址，${code.length} 字符）`)
    this.opts.log(`邀请码内容：${describe(unpack(code))}`)
    this.opts.onStatus('waiting', '等待对方应答码')
    return code
  }

  /* ---------------- 接收方 ---------------- */

  async createAnswer(offerCode: string): Promise<string> {
    const info = unpack(offerCode)
    if (info.r !== 'o') {
      throw new Error('这看起来是「应答码」而不是「邀请码」，请粘贴发起方给你的邀请码')
    }
    this.opts.log(`解析到邀请码：${describe(info)}`)
    this.teardown()
    const gen = this.generation
    this.opts.onStatus('creating')
    const pc = this.createPeerConnection(gen)

    await pc.setRemoteDescription({ type: 'offer', sdp: expand(info) })
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await this.waitForIce(pc, ICE_GATHER_TIMEOUT)

    const { code, candidates } = this.buildCode(pc, 'a')
    this.opts.log(`应答码已生成（含 ${candidates} 个候选地址，${code.length} 字符）`)
    this.opts.onStatus('waiting', '等待对方确认')
    return code
  }

  /* ---------------- 发起方应用应答码 ---------------- */

  async applyAnswer(answerCode: string): Promise<void> {
    // 先校验粘贴内容，这样“没粘贴/粘贴错了/贴错了类型”都能得到准确提示
    const info = unpack(answerCode)
    if (info.r !== 'a') {
      throw new Error('这看起来是「邀请码」而不是「应答码」，请粘贴对方回传给你的应答码')
    }
    const pc = this.pc
    if (!pc) throw new Error('请先在第 1 步生成邀请码')
    this.opts.log(`解析到应答码：${describe(info)}`)
    this.opts.onStatus('connecting')
    await pc.setRemoteDescription({ type: 'answer', sdp: expand(info) })
  }

  /* ---------------- 关闭 ---------------- */

  /** 静默拆掉底层连接（重新握手时使用，不触发 onClosed） */
  private teardown(): void {
    this.stopPing()
    this.generation++
    this.connectedFlag = false
    try {
      this.ctrl?.close()
      this.data?.close()
      this.pc?.close()
    } catch {
      /* 忽略 */
    }
    this.ctrl = null
    this.data = null
    this.pc = null
  }

  /** 主动断开并通知上层 */
  close(reason = ''): void {
    const wasConnected = this.connectedFlag
    if (wasConnected) this.send({ t: 'bye' })
    this.teardown()
    if (reason) this.opts.onClosed(reason)
  }

  /* ---------------- 内部实现 ---------------- */

  private createPeerConnection(gen: number): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.opts.getIceServers() })
    this.pc = pc

    pc.addEventListener('icecandidate', (e) => {
      if (gen !== this.generation) return
      const c = e.candidate
      if (c) {
        const anyC = c as unknown as { type?: string; address?: string; port?: number; protocol?: string }
        this.opts.log(`ICE 候选：${anyC.type || '?'} ${anyC.address || ''}:${anyC.port || ''} ${anyC.protocol || ''}`)
      } else {
        this.opts.log('ICE 候选收集完毕')
      }
    })

    pc.addEventListener('iceconnectionstatechange', () => {
      if (gen !== this.generation) return
      this.opts.log(`ICE 状态：${pc.iceConnectionState}`)
    })

    pc.addEventListener('connectionstatechange', () => {
      if (gen !== this.generation) return
      this.opts.log(`连接状态：${pc.connectionState}`)
      switch (pc.connectionState) {
        case 'connected':
          this.maybeConnected()
          break
        case 'failed':
          this.opts.onStatus('error', '直连失败')
          this.opts.onSys('直连建立失败：可能是防火墙拦截、双方不在同一局域网，或候选地址不可达。可尝试在设置里勾选“使用公网 STUN 服务器”，并检查系统防火墙是否允许浏览器通信。')
          break
        case 'disconnected':
          this.opts.onSys('连接中断，正在尝试自动恢复…')
          break
        case 'closed':
          if (this.connectedFlag) this.close('连接已关闭')
          break
      }
    })

    pc.addEventListener('datachannel', (e) => {
      if (gen !== this.generation) return
      this.attachChannel(e.channel, gen)
    })

    return pc
  }

  private attachChannel(ch: RTCDataChannel, gen: number): void {
    this.opts.log(`数据通道就绪：${ch.label} #${ch.id}`)
    if (ch.label === 'ctrl') {
      this.ctrl = ch
      ch.onmessage = (ev) => {
        if (gen !== this.generation) return
        this.onCtrlMessage(String(ev.data))
      }
    } else if (ch.label === 'data') {
      this.data = ch
      ch.binaryType = 'arraybuffer'
      ch.onmessage = (ev) => {
        if (gen !== this.generation) return
        this.opts.onBinary(ev.data as ArrayBuffer)
      }
    } else {
      return
    }
    ch.onopen = () => {
      if (gen !== this.generation) return
      this.maybeConnected()
    }
    ch.onclose = () => {
      if (gen !== this.generation) return
      this.opts.log(`数据通道关闭：${ch.label}`)
      if (ch.label === 'ctrl' && this.connectedFlag) this.close('数据通道已关闭')
    }
    ch.onerror = () => {
      if (gen !== this.generation) return
      this.opts.log(`数据通道错误：${ch.label}`, 'error')
    }
    if (ch.readyState === 'open') this.maybeConnected()
  }

  private maybeConnected(): void {
    const ready = this.ctrl?.readyState === 'open' && this.data?.readyState === 'open'
    if (!ready || this.connectedFlag) return
    this.connectedFlag = true
    this.opts.onStatus('connected')
    this.opts.onOpen()
    this.send({ t: 'hello', name: this.opts.getName(), ua: navigator.userAgent })
    this.startPing()
    void this.refreshPath()
  }

  private onCtrlMessage(raw: string): void {
    let msg: CtrlMsg
    try {
      msg = JSON.parse(raw) as CtrlMsg
    } catch {
      this.opts.log('收到无法解析的控制消息', 'warn')
      return
    }
    if (!msg || !msg.t) return
    if (msg.t.startsWith('file-') || msg.t === 'credit') {
      this.opts.onFileMsg(msg)
      return
    }
    switch (msg.t) {
      case 'hello':
        this.opts.onPeerName(String(msg.name || '对方').slice(0, 24))
        break
      case 'chat':
        this.opts.onChat(String(msg.text || ''), Number(msg.ts) || Date.now())
        break
      case 'ping':
        this.send({ t: 'pong', id: msg.id })
        break
      case 'pong': {
        const sent = msg.id ? this.pendingPings.get(msg.id) : undefined
        if (sent !== undefined && msg.id) {
          this.pendingPings.delete(msg.id)
          this.opts.onRtt(performance.now() - sent)
        }
        break
      }
      case 'bye':
        this.close('对方主动断开了连接')
        break
      case 'note':
        this.opts.onSys(String(msg.text || ''))
        break
      default:
        this.opts.log(`未知控制消息：${msg.t}`, 'warn')
    }
  }

  private waitForIce(pc: RTCPeerConnection, timeout: number): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise<void>((resolve) => {
      let done = false
      const timer = setTimeout(finish, timeout)
      function finish(): void {
        if (done) return
        done = true
        clearTimeout(timer)
        pc.removeEventListener('icegatheringstatechange', onChange)
        resolve()
      }
      function onChange(): void {
        if (pc.iceGatheringState === 'complete') finish()
      }
      pc.addEventListener('icegatheringstatechange', onChange)
    })
  }

  /**
   * 从本地 SDP 生成信令码。
   * 注意要用压缩后实际保留下来的候选数来判断，而不是原始 SDP 里的候选数
   * （relay / TCP 候选会被过滤掉，可能一个都不剩）。
   */
  private buildCode(pc: RTCPeerConnection, role: SignalRole): { code: string; candidates: number } {
    const sdp = pc.localDescription?.sdp
    if (!sdp) throw new Error('本地 SDP 生成失败')
    const obj = compact(sdp, { role, name: this.opts.getName() })
    if (!obj.c.length) {
      throw new Error('没有收集到可用的局域网候选地址，请在设置里尝试启用「公网 STUN 服务器」后重试')
    }
    return { code: pack(obj), candidates: obj.c.length }
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (!this.connectedFlag) return
      const id = uid('p')
      this.pendingPings.set(id, performance.now())
      this.send({ t: 'ping', id })
      const now = performance.now()
      this.pendingPings.forEach((sent, key) => {
        if (now - sent > 10000) this.pendingPings.delete(key)
      })
    }, 2000)
    this.statsTimer = setInterval(() => void this.refreshPath(), 5000)
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.pingTimer = null
    this.statsTimer = null
    this.pendingPings.clear()
  }

  /** 读取选中的候选对，展示直连类型与本地地址（排查链路问题很有用） */
  async refreshPath(): Promise<void> {
    const pc = this.pc
    if (!pc || !this.connectedFlag) return
    try {
      const stats = await pc.getStats()
      const pairs: RTCIceCandidatePairStats[] = []
      stats.forEach((report) => {
        if (report.type === 'candidate-pair') pairs.push(report as RTCIceCandidatePairStats)
      })
      const pair =
        pairs.find((p) => p.state === 'succeeded' && (p.nominated || isSelected(p))) ??
        pairs.find((p) => p.state === 'succeeded')
      if (!pair) return
      const local = pair.localCandidateId ? stats.get(pair.localCandidateId) : undefined
      const remote = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : undefined
      if (!local || !remote) return
      const l = local as { candidateType?: string; address?: string; ip?: string; port?: number }
      const r = remote as { candidateType?: string }
      const addr = `${l.address || l.ip || ''}${l.port ? ':' + l.port : ''}`
      this.opts.onPath(`${l.candidateType || '?'}↔${r.candidateType || '?'}${addr ? ' @' + addr : ''}`)
    } catch {
      /* getStats 失败不影响使用 */
    }
  }
}
