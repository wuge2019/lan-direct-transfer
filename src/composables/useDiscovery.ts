import { computed, ref, watch } from 'vue'
import {
  DiscoveryClient,
  normalizeBaseUrl,
  probeServer,
  type DiscoveryStatus,
  type RemotePeer,
  type ServerInfo
} from '../lib/discovery'
import { unpack } from '../lib/sdp-codec'
import { addLog } from './useLog'
import { showToast } from './useToast'
import { useSettings } from './useSettings'
import { usePeer } from './usePeer'

const { settings } = useSettings()
const { sysMessage, createInvite, createAnswerFromOffer, applyAnswerCode, status: peerStatus } = usePeer()

/* =========================================================
 * 响应式状态
 * ======================================================= */
const discoveryStatus = ref<DiscoveryStatus>('idle')
const discoveryDetail = ref('')
const serverInfo = ref<ServerInfo | null>(null)
const serverBase = ref('')
const roster = ref<RemotePeer[]>([])
/** 别人请求连我 */
const incomingRequest = ref<RemotePeer | null>(null)
/** 我请求连别人，等待对方同意 */
const outgoingRequest = ref<RemotePeer | null>(null)
/** 当前通过发现服务配对成功的对端 id（P2P 建立后仍然保留，用于断开时通知服务端） */
const sessionPeerId = ref<string | null>(null)
const selfPeerId = ref('')
/** 服务端已确认注册（此时才能安全地发请求/信令） */
const readyFlag = ref(false)

let client: DiscoveryClient | null = null
let requestTimer: ReturnType<typeof setTimeout> | null = null
let handshaking = false

const REQUEST_TIMEOUT = 30000

/** 通道就绪即可操作；注册完成前的消息会由 DiscoveryClient 排队后补发 */
const available = computed(() => discoveryStatus.value === 'online')
const otherPeers = computed(() => roster.value.filter((peer) => peer.peerId !== selfPeerId.value))
const sessionPeerName = computed(() => {
  const found = roster.value.find((peer) => peer.peerId === sessionPeerId.value)
  return found?.name || ''
})

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clearRequestTimer(): void {
  if (requestTimer) {
    clearTimeout(requestTimer)
    requestTimer = null
  }
}

/* =========================================================
 * 启动 / 停止
 * ======================================================= */
/** 计算要使用的服务地址：用户填写的优先，否则用当前站点 */
function resolveBaseUrl(): string {
  const manual = normalizeBaseUrl(settings.serverUrl)
  if (manual) return manual
  if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) return location.origin
  return ''
}

async function init(): Promise<void> {
  // 允许重复调用（例如改完服务地址后重新探测）
  shutdown()
  discoveryStatus.value = 'probing'
  discoveryDetail.value = ''
  const base = resolveBaseUrl()
  serverBase.value = base

  if (!base) {
    discoveryStatus.value = 'offline'
    discoveryDetail.value = '当前不是由发现服务托管的页面，可在设置里填写服务器地址'
    addLog('未配置发现服务地址，使用手动连接模式')
    return
  }

  const info = await probeServer(base)
  if (!info) {
    discoveryStatus.value = 'offline'
    discoveryDetail.value = `在 ${base} 上没有找到发现服务`
    addLog(`探测发现服务失败：${base}`, 'warn')
    return
  }

  serverInfo.value = info
  if (settings.serverUrl) {
    // 使用了手填地址时，把服务端返回的局域网地址展示出来，方便转告别人
    addLog(`已找到发现服务「${info.serverName}」，当前在线 ${info.peers} 人`)
  }

  client = new DiscoveryClient(base, settings.name, {
    onStatus: (next, detail) => {
      discoveryStatus.value = next
      discoveryDetail.value = detail || ''
      if (next !== 'online') readyFlag.value = false
    },
    onReady: () => {
      readyFlag.value = true
    },
    onServer: (welcome) => {
      serverInfo.value = { ...(serverInfo.value || welcome), ...welcome }
    },
    onRoster: (peers) => {
      roster.value = peers
    },
    onRequest: (from) => {
      if (peerStatus.value === 'connected' || sessionPeerId.value || outgoingRequest.value) {
        // 已经忙于别的连接：直接礼貌拒绝，避免对方干等
        client?.respond(from.peerId, false, '对方正在连接中')
        return
      }
      incomingRequest.value = from
      sysMessage(`${from.name} 想与你建立连接…`)
    },
    onResponse: (peerId, accept, reason) => {
      if (!outgoingRequest.value || outgoingRequest.value.peerId !== peerId) return
      clearRequestTimer()
      const target = outgoingRequest.value
      outgoingRequest.value = null
      if (!accept) {
        sysMessage(`${target.name} 拒绝了连接请求${reason ? `：${reason}` : ''}`)
        showToast(`${target.name} 拒绝了连接`, 'warn')
        return
      }
      sessionPeerId.value = peerId
      sysMessage(`${target.name} 已同意，正在建立直连…`)
      void startHandshakeAsRequester(peerId)
    },
    onSignal: (peerId, payload) => {
      void handleSignal(peerId, payload)
    },
    onSessionEnd: (peerId, reason) => {
      if (sessionPeerId.value && sessionPeerId.value !== peerId) return
      sessionPeerId.value = null
      if (reason === 'offline') sysMessage('对方已离线，会话结束')
      else if (reason === 'bye') sysMessage('对方结束了会话')
    },
    onError: (code, message) => {
      addLog(`发现服务返回错误：${code} ${message}`, 'warn')
      if (code === 'not-found') {
        clearRequestTimer()
        outgoingRequest.value = null
        showToast('对方已离线', 'warn')
      } else if (code === 'busy' || code === 'too-fast') {
        showToast(message, 'warn')
      }
    },
    log: addLog
  })

  selfPeerId.value = client.peerId
  client.connect()
}

function shutdown(): void {
  clearRequestTimer()
  client?.close()
  client = null
  roster.value = []
  incomingRequest.value = null
  outgoingRequest.value = null
  sessionPeerId.value = null
  discoveryStatus.value = 'idle'
}

/* =========================================================
 * 连接流程
 * ======================================================= */
function connectTo(peer: RemotePeer): void {
  if (!client || !available.value) {
    showToast('发现服务未连接，请使用手动连接方式', 'warn')
    return
  }
  if (peerStatus.value === 'connected') {
    showToast('当前已经与某人连接，请先断开', 'warn')
    return
  }
  if (outgoingRequest.value) {
    showToast('已有待确认的连接请求', 'warn')
    return
  }

  outgoingRequest.value = peer
  client.request(peer.peerId)
  sysMessage(`已向 ${peer.name} 发出连接请求，等待对方同意…`)
  clearRequestTimer()
  requestTimer = setTimeout(() => {
    if (!outgoingRequest.value || outgoingRequest.value.peerId !== peer.peerId) return
    outgoingRequest.value = null
    sysMessage(`等待 ${peer.name} 同意超时`)
    showToast('对方一直没有响应', 'warn')
  }, REQUEST_TIMEOUT)
}

function cancelOutgoing(): void {
  if (!outgoingRequest.value) return
  const target = outgoingRequest.value
  clearRequestTimer()
  client?.respond(target.peerId, false, '已取消')
  outgoingRequest.value = null
  sysMessage(`已取消对 ${target.name} 的连接请求`)
}

async function acceptIncoming(): Promise<void> {
  const from = incomingRequest.value
  if (!from || !client) return
  incomingRequest.value = null
  sessionPeerId.value = from.peerId
  client.respond(from.peerId, true)
  sysMessage(`已同意 ${from.name} 的连接，正在建立直连…`)
}

function rejectIncoming(): void {
  const from = incomingRequest.value
  if (!from || !client) return
  incomingRequest.value = null
  client.respond(from.peerId, false, '对方拒绝了连接')
  sysMessage(`已拒绝 ${from.name} 的连接请求`)
}

/** 我是发起方：生成邀请码并发给对方 */
async function startHandshakeAsRequester(peerId: string): Promise<void> {
  if (handshaking) return
  handshaking = true
  try {
    const code = await createInvite()
    client?.sendSignal(peerId, code)
    addLog(`已通过发现服务把邀请码发给 ${peerId}`)
  } catch (error) {
    sysMessage(`建立直连失败：${errText(error)}`)
    showToast(`建立直连失败：${errText(error)}`, 'err')
    leaveSession()
  } finally {
    handshaking = false
  }
}

/** 收到对方信令：按角色决定「生成应答码」还是「应用应答码」 */
async function handleSignal(peerId: string, payload: string): Promise<void> {
  if (!client) return
  if (!sessionPeerId.value) sessionPeerId.value = peerId
  if (sessionPeerId.value !== peerId) {
    addLog(`忽略来自非当前会话（${peerId}）的信令`, 'warn')
    return
  }
  if (handshaking) return
  handshaking = true
  try {
    const info = unpack(payload)
    if (info.r === 'o') {
      // 对方是发起方：我生成应答码回传
      const answer = await createAnswerFromOffer(payload)
      client.sendSignal(peerId, answer)
      addLog('已通过发现服务把应答码回传给对方')
    } else {
      await applyAnswerCode(payload)
      addLog('已应用对方的应答码，等待直连建立')
    }
  } catch (error) {
    sysMessage(`信令交换失败：${errText(error)}`)
    showToast(`信令交换失败：${errText(error)}`, 'err')
    leaveSession()
  } finally {
    handshaking = false
  }
}

/** 结束与当前对端的发现层会话（P2P 由 usePeer.disconnect 负责） */
function leaveSession(): void {
  const peerId = sessionPeerId.value
  if (peerId) client?.bye(peerId)
  sessionPeerId.value = null
}

/** P2P 断开或失败后清理发现层状态，并通知服务端释放配对关系 */
watch(peerStatus, (next, previous) => {
  if (next === previous) return
  if (next === 'idle' || next === 'error') leaveSession()
})

/* =========================================================
 * 对外接口
 * ======================================================= */
export function useDiscovery() {
  return {
    // 状态
    discoveryStatus,
    discoveryDetail,
    serverInfo,
    serverBase,
    roster,
    otherPeers,
    available,
    selfPeerId,
    /** 服务端已确认注册（供界面显示/排查用） */
    serverReady: readyFlag,
    incomingRequest,
    outgoingRequest,
    sessionPeerId,
    sessionPeerName,
    // 操作
    init,
    refresh: init,
    shutdown,
    connectTo,
    acceptIncoming,
    rejectIncoming,
    cancelOutgoing,
    leaveSession,
    rename: (name: string) => client?.rename(name)
  }
}
