/** 通用工具函数（无第三方依赖） */

let seq = 0

/** 生成短且唯一的 id（用作文件传输标识、消息标识） */
export function uid(prefix = 'id'): string {
  seq = (seq + 1) % 100000
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 让出主线程（宏任务）。
 * 不要用 setTimeout：后台标签页的定时器会被浏览器节流到 1 秒以上，
 * 长传输会被拖成龟速；MessageChannel 不受该节流影响。
 */
export function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel !== 'function') {
      setTimeout(resolve, 0)
      return
    }
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(0)
  })
}

export function formatBytes(bytes: number, digits?: number): string {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = value
  let i = -1
  do {
    v /= 1024
    i++
  } while (v >= 1024 && i < units.length - 1)
  const d = digits ?? (v >= 100 ? 0 : v >= 10 ? 1 : 2)
  return `${v.toFixed(d)} ${units[i]}`
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  return `${formatBytes(bytesPerSecond, 1)}/s`
}

export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '—'
  const s = Math.round(seconds)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`
}

export function formatTime(ts?: number): string {
  const d = ts ? new Date(ts) : new Date()
  const p = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/* ---------------- Base64URL（UTF-8 安全） ---------------- */

export function utf8ToBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlToUtf8(b64url: string): string {
  let b64 = String(b64url).replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

/* ---------------- 剪贴板 ---------------- */

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      /* 回退到 execCommand */
    }
  }
  await legacyCopy(text)
}

function legacyCopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.top = '-1000px'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      ta.setSelectionRange(0, ta.value.length)
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      ok ? resolve() : reject(new Error('execCommand copy 失败'))
    } catch (e) {
      reject(e)
    }
  })
}

/** 节流：用于高频进度回调，避免 DOM 抖动 */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, wait: number): (...args: A) => void {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastArgs: A | null = null
  return (...args: A) => {
    lastArgs = args
    const now = Date.now()
    const remain = wait - (now - last)
    if (remain <= 0) {
      last = now
      fn(...lastArgs)
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null
        last = Date.now()
        if (lastArgs) fn(...lastArgs)
      }, remain)
    }
  }
}
