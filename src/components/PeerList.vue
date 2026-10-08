<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import JoinQr from './JoinQr.vue'
import { useDiscovery } from '../composables/useDiscovery'
import { usePeer } from '../composables/usePeer'
import { useSettings } from '../composables/useSettings'
import { useToast } from '../composables/useToast'
import { copyText } from '../lib/utils'
import type { RemotePeer } from '../lib/discovery'

const {
  discoveryStatus,
  discoveryDetail,
  serverInfo,
  serverBase,
  otherPeers,
  available,
  selfPeerId,
  outgoingRequest,
  sessionPeerId,
  sessionPeerName,
  connectTo,
  cancelOutgoing,
  rename
} = useDiscovery()
const { status: peerStatus, disconnect: disconnectPeer, peerName } = usePeer()
const { settings, saveSettings, openSettings } = useSettings()
const { showToast } = useToast()

const nameDraft = ref(settings.name)
const editingName = ref(false)

watch(
  () => settings.name,
  (value) => {
    if (!editingName.value) nameDraft.value = value
  }
)

const statusText = computed(() => {
  switch (discoveryStatus.value) {
    case 'probing':
      return '正在寻找发现服务…'
    case 'connecting':
      return '正在连接发现服务…'
    case 'online':
      return `已连接「${serverInfo.value?.serverName || '发现服务'}」`
    case 'offline':
      return discoveryDetail.value || '未找到发现服务'
    case 'error':
      return discoveryDetail.value || '发现服务连接异常'
    default:
      return '未启用自动发现'
  }
})

const statusDot = computed(() => {
  switch (discoveryStatus.value) {
    case 'online':
      return 'dot dot-on'
    case 'probing':
    case 'connecting':
      return 'dot dot-wait'
    case 'error':
      return 'dot dot-err'
    default:
      return 'dot dot-off'
  }
})

const joinUrls = computed(() => {
  const urls = serverInfo.value?.urls || []
  if (urls.length) return urls
  if (serverBase.value && /^https?:\/\//.test(serverBase.value)) return [serverBase.value]
  return []
})

const primaryJoinUrl = computed(() => joinUrls.value[0] || '')

function peerStateText(peer: RemotePeer): string {
  if (peer.peerId === sessionPeerId.value && peerStatus.value === 'connected') return '已连接'
  if (peer.peerId === sessionPeerId.value) return '正在建立直连…'
  if (peer.busy) return '连接中'
  return '空闲'
}

function canConnect(peer: RemotePeer): boolean {
  if (!available.value) return false
  if (peer.busy) return false
  if (peerStatus.value === 'connected') return false
  if (outgoingRequest.value) return false
  return true
}

function onSaveName(): void {
  const value = nameDraft.value.trim().slice(0, 24)
  if (!value) {
    showToast('昵称不能为空', 'warn')
    return
  }
  settings.name = value
  saveSettings()
  rename(value)
  editingName.value = false
  showToast(`昵称已改为「${value}」`, 'ok')
}

async function onCopy(text: string): Promise<void> {
  if (!text) return
  try {
    await copyText(text)
    showToast('已复制，发给同事即可', 'ok')
  } catch {
    showToast('复制失败，请手动选中复制', 'warn')
  }
}

function onDisconnect(): void {
  disconnectPeer()
}
</script>

<template>
  <section class="panel peer-panel">
    <div class="panel-head">
      <h2>局域网用户</h2>
      <span class="pill">{{ otherPeers.length }} 人在线</span>
    </div>

    <div class="server-status">
      <span :class="statusDot"></span>
      <span class="server-status-text">{{ statusText }}</span>
      <button v-if="discoveryStatus === 'offline' || discoveryStatus === 'error'" class="btn btn-ghost small" @click="openSettings">
        配置地址
      </button>
    </div>

    <div class="name-row">
      <span class="name-label">我的昵称</span>
      <input
        v-model="nameDraft"
        class="name-input"
        type="text"
        maxlength="24"
        aria-label="我的昵称"
        @focus="editingName = true"
        @keydown.enter.prevent="onSaveName"
      />
      <button class="btn btn-ghost small" @click="onSaveName">保存</button>
    </div>

    <!-- 等待对方同意 -->
    <div v-if="outgoingRequest" class="request-banner">
      <div class="request-text">正在等待「{{ outgoingRequest.name }}」同意…</div>
      <button class="btn btn-ghost small" @click="cancelOutgoing">取消</button>
    </div>

    <!-- 当前会话 -->
    <div v-if="sessionPeerId && peerStatus === 'connected'" class="session-banner">
      <div class="request-text">已与「{{ peerName || sessionPeerName }}」建立直连</div>
      <button class="btn btn-danger small" @click="onDisconnect">断开</button>
    </div>
    <div v-else-if="sessionPeerId" class="request-banner">
      <div class="request-text">正在与「{{ sessionPeerName }}」建立直连…</div>
    </div>

    <!-- 用户列表 -->
    <ul v-if="otherPeers.length" class="peer-list">
      <li v-for="peer in otherPeers" :key="peer.peerId" class="peer-item">
        <span class="peer-avatar">{{ peer.name.slice(0, 1) }}</span>
        <span class="peer-name" :title="peer.name">{{ peer.name }}</span>
        <span class="peer-state" :class="{ 'state-ok': peerStateText(peer) === '已连接' }">
          {{ peerStateText(peer) }}
        </span>
        <button class="btn btn-primary small" :disabled="!canConnect(peer)" @click="connectTo(peer)">连接</button>
      </li>
    </ul>
    <p v-else-if="available" class="hint">
      目前只有你一个人在线。把下面的加入地址（或二维码）发给同事，用浏览器打开就能互相看见。
    </p>
    <p v-else class="hint">
      没有找到发现服务。可以让一台机器执行 <code>pnpm lan</code> 启动服务，
      或在设置里填写服务地址；也可以直接用下面的「手动连接」交换邀请码。
    </p>

    <!-- 邀请他人加入 -->
    <details v-if="joinUrls.length" class="invite-box">
      <summary>邀请他人加入（扫码或复制链接）</summary>
      <JoinQr :url="primaryJoinUrl" />
      <div class="row">
        <button class="btn btn-ghost small" @click="onCopy(primaryJoinUrl)">复制加入地址</button>
      </div>
      <ul v-if="joinUrls.length > 1" class="url-list">
        <li v-for="url in joinUrls" :key="url">
          <button class="link-like" @click="onCopy(url)">{{ url }}</button>
        </li>
      </ul>
    </details>

    <p v-if="!selfPeerId" class="hint">正在获取本机标识…</p>
  </section>
</template>
