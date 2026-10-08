import { computed, reactive } from 'vue'
import type { LogLevel } from '../lib/types'
import { formatTime } from '../lib/utils'

const MAX_LINES = 400
const TRIM_LINES = 100

/** 运行日志：既显示在界面上，也同步到控制台，便于排查问题 */
const logs = reactive<string[]>([])
const logText = computed(() => logs.join('\n'))

export function addLog(message: string, level?: LogLevel): void {
  logs.push(`[${formatTime()}] ${level ? `[${level.toUpperCase()}] ` : ''}${message}`)
  if (logs.length > MAX_LINES + TRIM_LINES) logs.splice(0, logs.length - MAX_LINES)
  if (level === 'error') console.error('[LAN]', message)
  else if (level === 'warn') console.warn('[LAN]', message)
  else console.log('[LAN]', message)
}

export function useLog() {
  return { logs, logText, addLog }
}
