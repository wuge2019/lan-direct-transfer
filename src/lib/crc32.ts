/**
 * 增量 CRC-32（IEEE 802.3 多项式 0xEDB88320）
 *
 * 用于文件传输完整性校验：边发边算，内存占用恒定。
 * 内部自动做首尾异或，所以可以安全地串联调用：
 *   let c = 0
 *   c = crc32Update(c, chunk1)
 *   c = crc32Update(c, chunk2)
 */

const TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    t[i] = c >>> 0
  }
  return t
})()

/** 增量更新；crc 传入上一次结果（首次传 0） */
export function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = ((crc >>> 0) ^ 0xffffffff) >>> 0
  for (let i = 0; i < bytes.length; i++) {
    c = (TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0
  }
  return (c ^ 0xffffffff) >>> 0
}

/** 转成 8 位小写十六进制字符串，便于比对与展示 */
export function crc32Hex(crc: number): string {
  return ('00000000' + (crc >>> 0).toString(16)).slice(-8)
}

/** 一次性计算（适合小数据） */
export function crc32(bytes: Uint8Array): number {
  return crc32Update(0, bytes)
}

export const crc32Api = { update: crc32Update, hex: crc32Hex, of: crc32 }
