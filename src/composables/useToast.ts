import { reactive } from 'vue'
import type { ToastItem } from '../lib/types'
import { uid } from '../lib/utils'

/** 轻量全局提示（Toast） */
const toasts = reactive<ToastItem[]>([])
const timers = new Map<string, ReturnType<typeof setTimeout>>()

export function dismissToast(id: string): void {
  const i = toasts.findIndex((t) => t.id === id)
  if (i >= 0) toasts.splice(i, 1)
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
}

export function showToast(
  text: string,
  type: ToastItem['type'] = 'info',
  duration?: number
): void {
  const item: ToastItem = { id: uid('toast'), text, type }
  toasts.push(item)
  const ms = duration ?? (type === 'err' ? 5200 : 3000)
  timers.set(
    item.id,
    setTimeout(() => dismissToast(item.id), ms)
  )
}

export function useToast() {
  return { toasts, showToast, dismissToast }
}
