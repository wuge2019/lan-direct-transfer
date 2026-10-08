/**
 * 接收端落盘方式（Sink）
 *
 *  - memorySink：把分片收进内存，结束后生成 Blob 触发下载（兼容所有浏览器）
 *  - fileSink  ：走 File System Access API 流式写入磁盘，恒定内存占用，
 *                大文件首选（Chrome / Edge 支持）
 */

import type { Sink, SinkResult } from './types'

/* File System Access API 的最小结构化类型，避免依赖不同 TS 版本的内置声明 */
export interface WritableLike {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
  abort?(): Promise<void>
}

export interface FileHandleLike {
  readonly name: string
  createWritable(): Promise<WritableLike>
}

export interface DirectoryHandleLike {
  readonly name: string
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>
}

export type SaveFilePicker = (options?: { suggestedName?: string }) => Promise<FileHandleLike>
export type DirectoryPicker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<DirectoryHandleLike>

interface PickerHost {
  showSaveFilePicker?: SaveFilePicker
  showDirectoryPicker?: DirectoryPicker
  isSecureContext?: boolean
}

function host(): PickerHost {
  return typeof window === 'undefined' ? {} : (window as unknown as PickerHost)
}

export function getSaveFilePicker(): SaveFilePicker | null {
  const h = host()
  return typeof h.showSaveFilePicker === 'function' ? h.showSaveFilePicker.bind(window) : null
}

export function getDirectoryPicker(): DirectoryPicker | null {
  const h = host()
  return typeof h.showDirectoryPicker === 'function' ? h.showDirectoryPicker.bind(window) : null
}

export function supportsFileSystemAccess(): boolean {
  return getSaveFilePicker() !== null
}

export function supportsDirectoryPicker(): boolean {
  return getDirectoryPicker() !== null
}

/* ---------------- 具体实现 ---------------- */

export function memorySink(meta: { name: string; mime?: string }): Sink {
  let parts: Uint8Array[] = []
  let aborted = false
  return {
    kind: 'memory',
    write(chunk: Uint8Array): Promise<void> {
      if (!aborted) parts.push(chunk)
      return Promise.resolve()
    },
    close(): Promise<SinkResult> {
      const blob = new Blob(parts as BlobPart[], { type: meta.mime || 'application/octet-stream' })
      parts = []
      const url = typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(blob) : ''
      return Promise.resolve({ url, path: meta.name, blob })
    },
    abort(): Promise<void> {
      aborted = true
      parts = []
      return Promise.resolve()
    }
  }
}

export function fileSink(handle: FileHandleLike): Sink {
  let writable: WritableLike | null = null
  return {
    kind: 'fsa',
    async write(chunk: Uint8Array): Promise<void> {
      if (!writable) writable = await handle.createWritable()
      await writable.write(chunk)
    },
    async close(): Promise<SinkResult> {
      if (writable) await writable.close()
      return { path: handle.name }
    },
    async abort(): Promise<void> {
      try {
        if (writable && writable.abort) await writable.abort()
      } catch {
        /* 忽略：文件可能已经被关闭 */
      }
    }
  }
}
