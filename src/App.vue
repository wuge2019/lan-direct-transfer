<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import TopBar from './components/TopBar.vue'
import PeerList from './components/PeerList.vue'
import ConnectPanel from './components/ConnectPanel.vue'
import SessionPanel from './components/SessionPanel.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import RequestDialog from './components/RequestDialog.vue'
import LogPanel from './components/LogPanel.vue'
import ToastHost from './components/ToastHost.vue'
import { usePeer } from './composables/usePeer'
import { useDiscovery } from './composables/useDiscovery'

const { sendFiles, hasActiveTransfer } = usePeer()
const { init: initDiscovery, shutdown: shutdownDiscovery } = useDiscovery()

const dragActive = ref(false)
let dragDepth = 0

function hasFiles(e: DragEvent): boolean {
  const dt = e.dataTransfer
  if (!dt) return false
  return Array.from(dt.types).includes('Files')
}

function onDragEnter(e: DragEvent): void {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth += 1
  dragActive.value = true
}

function onDragOver(e: DragEvent): void {
  if (hasFiles(e)) e.preventDefault()
}

/**
 * 注意：dragleave 的 dataTransfer.types 在部分浏览器/场景下是空的，
 * 这里不能再用 hasFiles 过滤，否则遮罩会一直留在界面上。
 */
function onDragLeave(e: DragEvent): void {
  dragDepth = Math.max(0, dragDepth - 1)
  // relatedTarget 为 null 说明鼠标已经离开窗口
  if (dragDepth === 0 || !e.relatedTarget) resetDrag()
}

function resetDrag(): void {
  dragDepth = 0
  dragActive.value = false
}

function onDrop(e: DragEvent): void {
  if (!hasFiles(e)) return
  e.preventDefault()
  resetDrag()
  const files = e.dataTransfer?.files
  if (files && files.length) sendFiles(files)
}

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (!hasActiveTransfer()) return
  e.preventDefault()
  e.returnValue = '还有文件正在传输，确定离开吗？'
}

onMounted(() => {
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
  window.addEventListener('dragend', resetDrag)
  window.addEventListener('blur', resetDrag)
  window.addEventListener('beforeunload', onBeforeUnload)
  void initDiscovery()
})

onBeforeUnmount(() => {
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
  window.removeEventListener('dragend', resetDrag)
  window.removeEventListener('blur', resetDrag)
  window.removeEventListener('beforeunload', onBeforeUnload)
  shutdownDiscovery()
})
</script>

<template>
  <TopBar />
  <main class="layout">
    <div class="side-column">
      <PeerList />
      <details class="manual-panel">
        <summary>手动连接（没有发现服务时，交换邀请码）</summary>
        <ConnectPanel />
      </details>
    </div>
    <SessionPanel />
    <LogPanel />
  </main>

  <div class="drop-overlay" :class="{ active: dragActive }">
    <div class="drop-overlay-inner">
      <div class="drop-icon">⬇</div>
      <p>松开鼠标即可发送文件</p>
    </div>
  </div>

  <RequestDialog />
  <SettingsDialog />
  <ToastHost />
</template>
