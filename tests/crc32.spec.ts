import { describe, expect, it } from 'vitest'
import { crc32, crc32Hex, crc32Update } from '../src/lib/crc32'
import { base64UrlToUtf8, formatBytes, formatDuration, uid, utf8ToBase64Url } from '../src/lib/utils'

describe('CRC-32', () => {
  it('已知向量 "123456789" 应为 CBF43926', () => {
    expect(crc32Hex(crc32(new TextEncoder().encode('123456789')))).toBe('cbf43926')
  })

  it('空数据为 00000000', () => {
    expect(crc32Hex(crc32(new Uint8Array(0)))).toBe('00000000')
  })

  it('增量计算与一次性计算一致（含非对齐分片）', () => {
    const data = new Uint8Array(10000)
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff
    const sizes = [1, 2, 3, 7, 16, 100, 1024, 4096]
    let inc = 0
    let offset = 0
    let k = 0
    while (offset < data.length) {
      const n = Math.min(sizes[k++ % sizes.length], data.length - offset)
      inc = crc32Update(inc, data.subarray(offset, offset + n))
      offset += n
    }
    expect(crc32Hex(inc)).toBe(crc32Hex(crc32(data)))
  })

  it('能检出单比特翻转', () => {
    const data = new Uint8Array(1024).fill(7)
    const before = crc32(data)
    data[500] ^= 0x01
    expect(crc32(data)).not.toBe(before)
  })
})

describe('Base64URL（UTF-8 安全）', () => {
  it('中文 / emoji 往返一致', () => {
    const text = '局域网直连-测试🚀{"a":1}'
    expect(base64UrlToUtf8(utf8ToBase64Url(text))).toBe(text)
  })

  it('输出不含 + / = 等 URL 不安全字符', () => {
    expect(utf8ToBase64Url('????>>>>????')).not.toMatch(/[+/=]/)
  })
})

describe('通用工具', () => {
  it('formatBytes 分级正确', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(2048)).toBe('2.00 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB')
  })

  it('formatDuration 分级正确', () => {
    expect(formatDuration(45)).toBe('45 秒')
    expect(formatDuration(125)).toBe('2 分 5 秒')
  })

  it('uid 不重复', () => {
    const set = new Set(Array.from({ length: 5000 }, () => uid('f')))
    expect(set.size).toBe(5000)
  })
})
