import { computed, reactive, ref } from 'vue'
import { Peer } from '../lib/peer'
import { TransferManager } from '../lib/transfer'
import { fileSink, getDirectoryPicker, getSaveFilePicker, memorySink } from '../lib/sinks'
import type {
  ChatMessage,
  CtrlMsg,
  PeerStatus,
  Sink,
  TransferRecord,
  TransferView
} from '../lib/types'
import { formatBytes, formatDuration, formatSpeed, uid } from '../lib/utils'
import { addLog } from './useLog'
import { showToast } from './useToast'
import { useSettings } from './useSettings'

const MAX_MESSAGES = 500
/** 一次性多删一点，避免到达上限后每条消息都要挪动整个数组 */
const TRIM_MESSAGES = 100
/** 超过这个大小就不再走“内存接收 + 浏览器下载”，必须让用户确认 */
const MEMORY_PATH_LIMIT = 512 * 1024 * 1024

const { settings, dirHandle } = useSettings()

/* =========================================================
 * 响应式状态（模块级单例，所有组件共享同一份连接）
 * ======================================================= */
const status = ref<PeerStatus>('idle')
const statusDetail = ref('')
const inviteCode = ref('')
const answerOut = ref('')
const peerName = ref('')
const rttMs = ref(0)
const pathInfo = ref('')
const messages = reactive<ChatMessage[]>([])
const transfers = reactive<TransferView[]>([])
const pairingRole = ref<'host' | 'guest' | null>(null)
const pairingHint = ref('')

const STATUS_TEXT: Record<PeerStatus, string> = {
  idle: '未连接',
  creating: '正在生成信令码…',
  waiting: '等待对方…',
  connecting: '正在建立直连…',
  connected: '已连接',
  error: '连接异常'
}

const statusText = computed(() => statusDetail.value || STATUS_TEXT[status.value])

const netInfo = computed(() => {
  if (status.value !== 'connected') return ''
  const parts: string[] = []
  if (rttMs.value) parts.push(`延迟 ${Math.round(rttMs.value)} ms`)
  if (pathInfo.value) parts.push(pathInfo.value)
  return parts.join(' · ')
})

const connected = computed(() => status.value === 'connected')

/* =========================================================
 * 消息
 * ======================================================= */
let seqCounter = 0
function nextSeq(): number {
  seqCounter += 1
  return seqCounter
}

function pushMessage(kind: ChatMessage['kind'], text: string, ts?: number): void {
  messages.push({ id: uid('msg'), seq: nextSeq(), kind, text, ts: ts ?? Date.now() })
  if (messages.length > MAX_MESSAGES + TRIM_MESSAGES) {
    messages.splice(0, messages.length - MAX_MESSAGES)
  }
}

function sysMessage(text: string): void {
  pushMessage('sys', text)
}

/**
 * 清空聊天区：消息全清；已结束的文件卡片一并移除，
 * 但进行中的传输（可取消 / 等待确认）保留，避免丢失操作入口。
 * 被移除的内存接收文件会释放其 blob URL，避免大文件长期占用内存。
 */
function clearChat(): void {
  messages.splice(0, messages.length)
  for (let i = transfers.length - 1; i >= 0; i--) {
    const item = transfers[i]
    if (item.canCancel || item.canAccept) continue
    if (item.url) {
      try {
        URL.revokeObjectURL(item.url)
      } catch {
        /* 忽略 */
      }
    }
    transfers.splice(i, 1)
  }
}

/* =========================================================
 * 传输记录 -> 视图模型
 * ======================================================= */
const transferSeq = new Map<string, number>()

function upsertTransfer(rec: TransferRecord): void {
  let seq = transferSeq.get(rec.id)
  if (seq === undefined) {
    seq = nextSeq()
    transferSeq.set(rec.id, seq)
  }
  const view = toView(rec, seq)
  const i = transfers.findIndex((t) => t.id === rec.id)
  if (i >= 0) Object.assign(transfers[i], view)
  else transfers.push(view)
}

function toView(rec: TransferRecord, seq: number): TransferView {
  const total = rec.size || 1
  const done = rec.dir === 'out' ? rec.sent : rec.received
  const percent = Math.min(100, (done / total) * 100)

  let stateText: string = rec.state
  let tone: TransferView['tone'] = ''
  let canCancel = false
  let canAccept = false
  let canReject = false

  if (rec.dir === 'out') {
    switch (rec.state) {
      case 'queued':
        stateText = '排队等待发送…'
        canCancel = true
        break
      case 'offered':
        stateText = '等待对方接受…'
        tone = 'state-warn'
        canCancel = true
        break
      case 'sending':
        stateText = `发送中 ${percent.toFixed(1)}%`
        canCancel = true
        break
      case 'verifying':
        stateText = '发送完毕，等待对方校验…'
        tone = 'state-warn'
        canCancel = true
        break
      case 'done':
        stateText = '发送完成，CRC 校验通过 ✓'
        tone = 'state-ok'
        break
      case 'rejected':
        stateText = '对方拒绝接收'
        tone = 'state-err'
        break
      case 'cancelled':
        stateText = '已取消'
        tone = 'state-warn'
        break
      case 'failed':
        stateText = `发送失败：${rec.error || '未知原因'}`
        tone = 'state-err'
        break
    }
  } else {
    switch (rec.state) {
      case 'pending':
        stateText = '对方想发送此文件，等待你确认'
        tone = 'state-warn'
        canAccept = true
        canReject = true
        break
      case 'receiving':
        stateText = `接收中 ${percent.toFixed(1)}%`
        canCancel = true
        break
      case 'done':
        stateText = `接收完成，CRC 校验通过 ✓${rec.savePath ? `（${rec.savePath}）` : ''}`
        tone = 'state-ok'
        break
      case 'failed':
        stateText = `接收失败：${rec.error || '未知原因'}`
        tone = 'state-err'
        break
      case 'cancelled':
        stateText = '已取消'
        tone = 'state-warn'
        break
      case 'rejected':
        stateText = '已拒绝'
        tone = 'state-warn'
        break
    }
  }

  const moving = rec.state === 'sending' || rec.state === 'receiving'
  const speedText = moving
    ? `${formatSpeed(rec.speed)}${rec.eta ? ` · 约 ${formatDuration(rec.eta)}` : ''}`
    : ''

  return {
    id: rec.id,
    seq,
    dir: rec.dir,
    name: rec.name,
    size: rec.size,
    sizeText: formatBytes(rec.size),
    state: rec.state,
    percent,
    stateText,
    tone,
    isDone: rec.state === 'done',
    isFailed: rec.state === 'failed' || rec.state === 'cancelled' || rec.state === 'rejected',
    speedText,
    canCancel,
    canAccept,
    canReject,
    canSave: rec.dir === 'in' && rec.state === 'done' && !!rec.url,
    url: rec.url,
    savePath: rec.savePath
  }
}

/* =========================================================
 * 连接层与传输引擎
 * ======================================================= */
/* 两边互相引用，这里用一层间接避免初始化顺序问题 */
const handlers: {
  file?: (msg: CtrlMsg) => void
  binary?: (buf: ArrayBuffer) => void
} = {}

/** 直连迟迟建立不起来时给用户一个可操作的提示，避免界面一直“转圈” */
let connectWatchdog: ReturnType<typeof setTimeout> | null = null

function clearConnectWatchdog(): void {
  if (connectWatchdog) {
    clearTimeout(connectWatchdog)
    connectWatchdog = null
  }
}

function armConnectWatchdog(): void {
  clearConnectWatchdog()
  connectWatchdog = setTimeout(() => {
    connectWatchdog = null
    if (peer.connected) return
    sysMessage(
      '等待直连建立已超过 30 秒。请检查：双方是否在同一局域网、系统防火墙是否放行了浏览器、' +
        'Wi-Fi 是否开启了「客户端隔离（AP 隔离）」；也可以在设置里勾选「使用公网 STUN 服务器」后重新连接。'
    )
  }, 30000)
}

const peer = new Peer({
  getIceServers: () => (settings.stun && settings.stunUrl ? [{ urls: settings.stunUrl }] : []),
  getName: () => settings.name,
  log: addLog,
  onStatus: (next, detail) => {
    status.value = next
    statusDetail.value = detail || ''
    if (next === 'connecting') armConnectWatchdog()
    else if (next !== 'waiting') clearConnectWatchdog()
  },
  onOpen: () => {
    sysMessage('点对点直连已建立。所有消息与文件都在这两台设备之间直接传输，不经过任何服务器。')
  },
  onClosed: (reason) => {
    resetAfterClose()
    if (reason) sysMessage(reason)
  },
  onSys: sysMessage,
  onChat: (text, ts) => pushMessage('peer', text, ts),
  onPeerName: (name) => {
    peerName.value = name
    sysMessage(`对方（${name}）已就绪`)
  },
  onRtt: (ms) => {
    rttMs.value = ms
  },
  onPath: (text) => {
    pathInfo.value = text
  },
  onFileMsg: (msg) => handlers.file?.(msg),
  onBinary: (buf) => handlers.binary?.(buf)
})

const transfer = new TransferManager({
  sendCtrl: (msg) => peer.send(msg),
  getChannel: () => peer.dataChannel,
  onUpdate: upsertTransfer,
  onIncomingOffer: (rec) => {
    if (canAutoAccept()) {
      addLog(`已开启自动接收，正在保存：${rec.name}`)
      void createSinkFor(rec, true)
        .then((sink) => {
          if (sink) transfer.accept(rec.id, sink)
        })
        .catch((e: unknown) => showToast(`自动接收失败：${errText(e)}`, 'err'))
    }
  },
  log: addLog
})

handlers.file = (msg) => transfer.handleCtrl(msg)
handlers.binary = (buf) => transfer.handleBinary(buf)

/* =========================================================
 * 落盘方式选择
 * ======================================================= */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function canAutoAccept(): boolean {
  if (!settings.autoAccept) return false
  if (settings.saveMode === 'download') return true
  if (settings.saveMode === 'dir' && dirHandle.value) return true
  return false
}

/** 依据设置决定本次接收的落盘方式；用户取消选择时返回 null */
async function createSinkFor(rec: TransferRecord, auto = false): Promise<Sink | null> {
  const mode = settings.saveMode
  let sink: Sink | null = null

  if (mode === 'ask') {
    const picker = getSaveFilePicker()
    if (picker) {
      try {
        const handle = await picker({ suggestedName: rec.name })
        return fileSink(handle)
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return null
        addLog(`打开“保存位置”对话框失败，改用内存接收：${errText(e)}`, 'warn')
      }
    }
  } else if (mode === 'dir') {
    if (!dirHandle.value && !auto) {
      const picker = getDirectoryPicker()
      if (picker) {
        try {
          dirHandle.value = await picker({ mode: 'readwrite' })
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return null
          addLog(`选择文件夹失败，改用内存接收：${errText(e)}`, 'warn')
        }
      }
    }
    if (dirHandle.value) {
      try {
        const name = await uniqueName(dirHandle.value, rec.name)
        const handle = await dirHandle.value.getFileHandle(name, { create: true })
        return fileSink(handle)
      } catch (e) {
        addLog(`写入目标文件夹失败，改用内存接收：${errText(e)}`, 'warn')
        dirHandle.value = null
      }
    }
  }

  if (!sink) {
    // 内存接收对超大文件必然爆内存：非自动接收时让用户明确确认
    if (rec.size > MEMORY_PATH_LIMIT) {
      const message =
        `当前保存方式需要先把整个文件缓存在内存中（${formatBytes(rec.size)}），` +
        '可能导致页面卡死甚至崩溃。建议在设置里改用“询问保存位置”或“固定文件夹”。'
      if (auto) {
        showToast(message, 'warn', 8000)
      } else if (typeof window.confirm === 'function' && !window.confirm(`${message}\n\n仍要继续接收吗？`)) {
        return null
      }
    }
    sink = memorySink(rec)
  }
  return sink
}

async function uniqueName(dir: { name: string; getFileHandle(n: string, o?: { create?: boolean }): Promise<unknown> }, name: string): Promise<string> {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = name
  for (let i = 1; i < 2000; i++) {
    try {
      await dir.getFileHandle(candidate)
    } catch {
      return candidate
    }
    candidate = `${base} (${i})${ext}`
  }
  return `${base}-${Date.now()}${ext}`
}

/* =========================================================
 * 连接流程
 * ======================================================= */
/**
 * 握手操作全局互斥：生成邀请码 / 生成应答码 / 应用应答码 都会重建底层
 * PeerConnection（内部 teardown + generation++），并发执行会互相作废，
 * 所以这里统一串行化，并在界面上禁用相关按钮。
 */
const handshakeBusy = ref(false)

async function runHandshake<T>(fn: () => Promise<T>): Promise<T> {
  if (handshakeBusy.value) throw new Error('上一个握手操作还在进行中，请稍候再试')
  handshakeBusy.value = true
  try {
    return await fn()
  } finally {
    handshakeBusy.value = false
  }
}

function createInvite(): Promise<string> {
  return runHandshake(async () => {
    if (peer.connected) sysMessage('已放弃当前连接，重新生成邀请码。')
    inviteCode.value = ''
    const code = await peer.createInvite()
    inviteCode.value = code
    return code
  })
}

function createAnswerFromOffer(offerCode: string): Promise<string> {
  return runHandshake(async () => {
    answerOut.value = ''
    const code = await peer.createAnswer(offerCode)
    answerOut.value = code
    return code
  })
}

function applyAnswerCode(answerCode: string): Promise<void> {
  return runHandshake(async () => {
    try {
      await peer.applyAnswer(answerCode)
    } catch (e) {
      // 应答码无效时把状态退回“等待”，让用户可以重新粘贴
      clearConnectWatchdog()
      status.value = 'waiting'
      statusDetail.value = '应答码无效，请检查后重试'
      throw e
    }
    sysMessage('已收到对方的应答码，正在打洞建立直连…')
  })
}

function resetAfterClose(): void {
  clearConnectWatchdog()
  peerName.value = ''
  rttMs.value = 0
  pathInfo.value = ''
  statusDetail.value = ''
  status.value = 'idle'
  transfer.abortAll('连接已断开')
}

/** 断开 / 重置 */
function disconnect(): void {
  const wasConnected = peer.connected
  peer.close('')
  resetAfterClose()
  inviteCode.value = ''
  answerOut.value = ''
  pairingRole.value = null
  pairingHint.value = ''
  if (wasConnected) sysMessage('已断开连接。')
  addLog('已重置连接状态')
}

/* =========================================================
 * 聊天与文件
 * ======================================================= */
function sendChat(text: string): boolean {
  const value = text.replace(/\s+$/, '')
  if (!value) return false
  if (!peer.connected) {
    showToast('尚未建立连接，无法发送消息', 'err')
    return false
  }
  if (!peer.send({ t: 'chat', text: value, ts: Date.now() })) return false
  pushMessage('me', value)
  return true
}

function sendFiles(files: File[] | FileList): void {
  const list = Array.prototype.slice.call(files) as File[]
  if (!list.length) return
  if (!peer.connected) {
    showToast('尚未建立连接，无法发送文件', 'err')
    return
  }
  const total = list.reduce((sum, f) => sum + f.size, 0)
  addLog(`准备发送 ${list.length} 个文件，共 ${formatBytes(total)}`)
  transfer.enqueue(list)
}

async function acceptTransfer(id: string): Promise<void> {
  const rec = transfer.getRecord(id)
  if (!rec || rec.state !== 'pending') return
  const sink = await createSinkFor(rec)
  if (!sink) return
  transfer.accept(id, sink)
}

function rejectTransfer(id: string): void {
  transfer.reject(id, '对方拒绝接收')
}

function cancelTransfer(id: string): void {
  transfer.cancel(id)
}

function hasActiveTransfer(): boolean {
  const s = transfer.stats()
  return s.sending > 0 || s.receiving > 0
}

/* =========================================================
 * 本机自动配对（同一浏览器多标签页，走 BroadcastChannel）
 * ======================================================= */
const myPeerId = uid('peer')
const bcSupported = typeof BroadcastChannel === 'function'
const channel: BroadcastChannel | null = bcSupported ? new BroadcastChannel('lan-direct-transfer-signal-v1') : null

if (channel) {
  channel.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as { kind?: string; from?: string; to?: string; code?: string; ts?: number }
    if (!msg || typeof msg !== 'object' || msg.from === myPeerId) return
    if (Date.now() - (msg.ts || 0) > 60000) return

    if (msg.kind === 'offer' && pairingRole.value === 'guest' && !peer.connected) {
      pairingRole.value = null
      pairingHint.value = '收到主叫邀请，正在自动生成应答码…'
      const offer = msg.code || ''
      createAnswerFromOffer(offer)
        .then((code) => {
          channel.postMessage({ kind: 'answer', from: myPeerId, to: msg.from, code, ts: Date.now() })
          pairingHint.value = '已发回应答码，等待建立直连…'
        })
        .catch((e: unknown) => showToast(`本机配对失败：${errText(e)}`, 'err'))
    } else if (msg.kind === 'answer' && pairingRole.value === 'host' && !peer.connected) {
      pairingRole.value = null
      pairingHint.value = '收到被叫应答，正在建立直连…'
      applyAnswerCode(msg.code || '').catch((e: unknown) => showToast(`本机配对失败：${errText(e)}`, 'err'))
    }
  }
  addLog('本机自动配对通道已就绪（BroadcastChannel）')
}

async function startLocalPairing(role: 'host' | 'guest'): Promise<void> {
  if (!channel) {
    showToast('当前浏览器不支持 BroadcastChannel，无法本机自动配对', 'err')
    return
  }
  if (pairingRole.value) {
    showToast('本机配对已经开始了，请稍候…', 'warn')
    return
  }
  pairingRole.value = role
  pairingHint.value = role === 'host'
    ? '已作为主叫广播邀请，请在另一个标签页点“本机配对（被叫）”…'
    : '已作为被叫待命，请在另一个标签页点“本机配对（主叫）”…'
  if (role === 'host') {
    const code = await createInvite()
    channel.postMessage({ kind: 'offer', from: myPeerId, to: '', code, ts: Date.now() })
  }
}

/* =========================================================
 * 对外接口
 * ======================================================= */
export function usePeer() {
  return {
    // 状态
    status,
    statusText,
    netInfo,
    connected,
    peerName,
    rttMs,
    pathInfo,
    inviteCode,
    answerOut,
    messages,
    transfers,
    pairingRole,
    pairingHint,
    bcSupported,
    handshakeBusy,
    // 连接
    createInvite,
    createAnswerFromOffer,
    applyAnswerCode,
    disconnect,
    startLocalPairing,
    // 会话
    sendChat,
    sendFiles,
    clearChat,
    // 文件
    acceptTransfer,
    rejectTransfer,
    cancelTransfer,
    hasActiveTransfer
  }
}
