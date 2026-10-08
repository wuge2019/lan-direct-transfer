<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useDiscovery } from '../composables/useDiscovery'

const { incomingRequest, acceptIncoming, rejectIncoming } = useDiscovery()

const dialogEl = ref<HTMLDialogElement | null>(null)
const countdown = ref(30)
let timer: ReturnType<typeof setInterval> | null = null

function stopTimer(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

watch(incomingRequest, (request) => {
  const el = dialogEl.value
  if (!el) return
  if (request) {
    countdown.value = 30
    stopTimer()
    timer = setInterval(() => {
      countdown.value -= 1
      if (countdown.value <= 0) {
        stopTimer()
        rejectIncoming()
      }
    }, 1000)
    if (!el.open) {
      if (typeof el.showModal === 'function') el.showModal()
      else el.setAttribute('open', '')
    }
  } else {
    stopTimer()
    if (el.open) {
      if (typeof el.close === 'function') el.close()
      else el.removeAttribute('open')
    }
  }
})

onBeforeUnmount(stopTimer)

function onAccept(): void {
  stopTimer()
  void acceptIncoming()
}

function onReject(): void {
  stopTimer()
  rejectIncoming()
}
</script>

<template>
  <dialog ref="dialogEl" class="request-dialog" @cancel.prevent="onReject">
    <div v-if="incomingRequest" class="request-body">
      <div class="request-avatar">{{ incomingRequest.name.slice(0, 1) }}</div>
      <h3>「{{ incomingRequest.name }}」请求与你建立连接</h3>
      <p class="hint">
        同意后双方会建立浏览器之间的点对点直连，之后的消息与文件都只在你们两台设备之间传输。
      </p>
      <p class="hint">（{{ countdown }} 秒内未处理将自动拒绝）</p>
      <div class="request-actions">
        <button class="btn btn-ghost" @click="onReject">拒绝</button>
        <button class="btn btn-primary" @click="onAccept">同意</button>
      </div>
    </div>
  </dialog>
</template>
