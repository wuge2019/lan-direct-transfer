<script setup lang="ts">
import { computed } from 'vue'
import { usePeer } from '../composables/usePeer'
import { useSettings } from '../composables/useSettings'

const { status, statusText, netInfo, clearChat, disconnect } = usePeer()
const { openSettings } = useSettings()

const dotClass = computed(() => {
  switch (status.value) {
    case 'connected': return 'dot dot-on'
    case 'error': return 'dot dot-err'
    case 'idle': return 'dot dot-off'
    default: return 'dot dot-wait'
  }
})
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="logo">⇆</span>
      <div class="brand-text">
        <strong>局域网直连</strong>
        <small>Vue 3 · 纯前端点对点通信与文件实时传输</small>
      </div>
    </div>

    <div class="status-box">
      <span :class="dotClass"></span>
      <span>{{ statusText }}</span>
      <span v-if="netInfo" class="net-info">{{ netInfo }}</span>
    </div>

    <div class="topbar-actions">
      <button class="btn btn-ghost" @click="clearChat">清空</button>
      <button class="btn btn-ghost" @click="openSettings">设置</button>
      <button class="btn btn-danger" :disabled="status === 'idle'" @click="disconnect">断开</button>
    </div>
  </header>
</template>
