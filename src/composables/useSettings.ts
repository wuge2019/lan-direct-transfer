import { computed, reactive, ref, shallowRef } from 'vue'
import type { AppSettings } from '../lib/types'
import {
  getDirectoryPicker,
  supportsDirectoryPicker,
  supportsFileSystemAccess,
  type DirectoryHandleLike
} from '../lib/sinks'
import { showToast } from './useToast'
import { addLog } from './useLog'

const STORAGE_KEY = 'lan-direct-transfer-settings'

const defaultName = `用户${Math.floor(1000 + Math.random() * 8999)}`

const settings = reactive<AppSettings>({
  name: defaultName,
  saveMode: supportsFileSystemAccess() ? 'ask' : 'download',
  autoAccept: false,
  stun: false,
  stunUrl: 'stun:stun.l.google.com:19302',
  serverUrl: ''
})

/** 设置弹窗开关 */
const dialogOpen = ref(false)

/** 会话内选定的固定保存目录（浏览器不允许持久化目录句柄到 localStorage） */
const dirHandle = shallowRef<DirectoryHandleLike | null>(null)

const dirStatus = computed(() => {
  if (dirHandle.value) {
    return `已选择文件夹：${dirHandle.value.name}（仅在本次会话有效，接收的文件会直接写入）`
  }
  if (!supportsDirectoryPicker()) {
    return '当前浏览器不支持选择文件夹（Chrome / Edge 支持），可改用“询问保存位置”或“浏览器下载”。'
  }
  return '未选择文件夹。'
})

export function loadSettings(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as Partial<AppSettings>
    if (saved.name) settings.name = String(saved.name).slice(0, 24)
    if (saved.saveMode) settings.saveMode = saved.saveMode
    settings.autoAccept = !!saved.autoAccept
    settings.stun = !!saved.stun
    if (saved.stunUrl) settings.stunUrl = saved.stunUrl
    settings.serverUrl = saved.serverUrl || ''
  } catch (e) {
    addLog(`读取本地设置失败（${e instanceof Error ? e.message : String(e)}），使用默认设置`, 'warn')
  }
}

export function saveSettings(): void {
  settings.name = settings.name.trim().slice(0, 24) || '匿名用户'
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch (e) {
    addLog(`保存设置到本地失败：${e instanceof Error ? e.message : String(e)}`, 'warn')
  }
  showToast('设置已保存', 'ok')
  addLog(`设置已保存：${JSON.stringify(settings)}`)
}

export function openSettings(): void {
  dialogOpen.value = true
}

export function closeSettings(): void {
  dialogOpen.value = false
}

export async function chooseDirectory(): Promise<void> {
  const picker = getDirectoryPicker()
  if (!picker) {
    showToast('当前浏览器不支持选择文件夹', 'err')
    return
  }
  try {
    dirHandle.value = await picker({ mode: 'readwrite' })
    settings.saveMode = 'dir'
    showToast(`已选择文件夹：${dirHandle.value.name}`, 'ok')
    addLog(`已选择固定保存文件夹：${dirHandle.value.name}`)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return
    showToast(`选择文件夹失败：${e instanceof Error ? e.message : String(e)}`, 'err')
  }
}

export function clearDirectory(): void {
  dirHandle.value = null
  showToast('已清除固定文件夹')
}

export function useSettings() {
  return {
    settings,
    dialogOpen,
    dirHandle,
    dirStatus,
    supportsFileSystemAccess,
    supportsDirectoryPicker,
    loadSettings,
    saveSettings,
    openSettings,
    closeSettings,
    chooseDirectory,
    clearDirectory
  }
}
