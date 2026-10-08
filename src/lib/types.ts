/** 全局共享类型定义 */

export type LogLevel = 'info' | 'warn' | 'error'

export type PeerStatus = 'idle' | 'creating' | 'waiting' | 'connecting' | 'connected' | 'error'

export type TransferState =
  | 'queued'      // 排队等待发送
  | 'offered'     // 已发请求，等待对方接受
  | 'sending'     // 发送中
  | 'verifying'   // 发完，等待对方校验回执
  | 'pending'     // 收到请求，等待本机用户确认
  | 'receiving'   // 接收中
  | 'done'
  | 'rejected'
  | 'cancelled'
  | 'failed'

/** 控制通道（ctrl）上的协议消息 */
export interface CtrlMsg {
  t: string
  id?: string
  /** file-offer 里携带的数据流号 */
  sid?: number
  name?: string
  size?: number
  mime?: string
  lastModified?: number
  crc?: string
  ok?: boolean
  reason?: string
  n?: number
  text?: string
  ts?: number
  ua?: string
}

/** 接收端落盘方式 */
export interface SinkResult {
  path?: string
  url?: string
  blob?: Blob
}

export interface Sink {
  readonly kind: 'memory' | 'fsa'
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<SinkResult>
  abort(): Promise<void>
}

/** 传输记录（传输引擎内部使用，不直接暴露给视图） */
export interface TransferRecord {
  id: string
  /** 数据通道分片的流号（二进制分片头部 4 字节），用于识别分片归属 */
  streamId: number
  dir: 'in' | 'out'
  name: string
  size: number
  mime: string
  lastModified: number
  state: TransferState

  file: File | null
  sent: number

  received: number
  written: number
  sink: Sink | null
  savePath: string
  url: string
  pendingDone: CtrlMsg | null
  finishing: boolean

  crc: number
  startedAt: number
  speed: number
  eta: number
  error: string
  cancelRequested: boolean

  lastBytes: number
  lastTick: number
  chain: Promise<void>
  ack: ((msg: CtrlMsg) => void) | null
}

/** 传输记录在界面上的视图模型（纯数据，可安全放入 Vue 响应式系统） */
export interface TransferView {
  id: string
  seq: number
  dir: 'in' | 'out'
  name: string
  size: number
  sizeText: string
  state: TransferState
  percent: number
  stateText: string
  tone: '' | 'state-ok' | 'state-err' | 'state-warn'
  isDone: boolean
  isFailed: boolean
  speedText: string
  canCancel: boolean
  canAccept: boolean
  canReject: boolean
  canSave: boolean
  url: string
  savePath: string
}

export interface ChatMessage {
  id: string
  /** 全局递增序号，用于把消息与文件卡片按时间顺序合成一条时间线 */
  seq: number
  kind: 'me' | 'peer' | 'sys'
  text: string
  ts: number
}

export interface ToastItem {
  id: string
  text: string
  type: 'info' | 'ok' | 'warn' | 'err'
}

export interface AppSettings {
  name: string
  saveMode: 'ask' | 'dir' | 'download'
  autoAccept: boolean
  stun: boolean
  stunUrl: string
}
