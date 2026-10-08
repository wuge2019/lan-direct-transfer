/**
 * WebRTC SDP 信令码：压缩 / 还原
 *
 * 纯前端没有信令服务器，双方必须人工交换一次「邀请码 / 应答码」。
 * 原始 SDP 有 1.5 ~ 3 KB，复制粘贴太重；这里只提取建立 DataChannel
 * 直连必需的信息（ice-ufrag / ice-pwd / DTLS 指纹 / candidate 列表），
 * 打包成 300 ~ 600 字符的 Base64URL 短码；对端在本地重建一份标准 SDP
 * 交给 setRemoteDescription 即可。
 */

import { base64UrlToUtf8, utf8ToBase64Url } from './utils'

export const CODEC_PREFIX = 'P2P1-'
export const CODEC_VERSION = 1

export interface ParsedCandidate {
  foundation: string
  component: string
  proto: string
  priority: string
  addr: string
  port: string
  typ: string
  raddr?: string
  rport?: string
  tcptype?: string
}

export interface ParsedSdp {
  ufrag?: string
  pwd?: string
  fingerprint?: string
  fingerprintAlgo?: string
  setup?: string
  sctpPort?: number
  maxMessageSize?: number
  candidates: ParsedCandidate[]
}

/** 压缩后的信令对象；c 中每项为 [地址, 端口, 类型, (raddr, rport)] */
export interface CompactSignal {
  v: number
  r: 'o' | 'a'
  n: string
  u: string
  p: string
  f: string
  /** 指纹算法（如 sha-256）；旧版本信令码没有该字段，按 sha-256 处理 */
  fa?: string
  s: string
  sp: number
  mm: number
  c: string[][]
}

export type SignalRole = 'o' | 'a'

/* ---------------- 解析浏览器真实 SDP ---------------- */

export function parseSdp(sdp: string): ParsedSdp {
  const out: ParsedSdp = { candidates: [] }
  const lines = String(sdp || '').split(/\r?\n/)
  for (const line of lines) {
    if (!line) continue
    if (line.startsWith('a=ice-ufrag:')) {
      out.ufrag = line.slice(12).trim()
    } else if (line.startsWith('a=ice-pwd:')) {
      out.pwd = line.slice(10).trim()
    } else if (line.startsWith('a=fingerprint:')) {
      const fp = line.slice(14).trim()
      const sp = fp.indexOf(' ')
      if (sp > 0) {
        out.fingerprintAlgo = fp.slice(0, sp)
        out.fingerprint = fp.slice(sp + 1).trim()
      } else {
        out.fingerprintAlgo = 'sha-256'
        out.fingerprint = fp
      }
    } else if (line.startsWith('a=setup:')) {
      out.setup = line.slice(8).trim()
    } else if (line.startsWith('a=sctp-port:')) {
      out.sctpPort = parseInt(line.slice(12), 10) || 5000
    } else if (line.startsWith('a=max-message-size:')) {
      out.maxMessageSize = parseInt(line.slice(19), 10) || 262144
    } else if (line.startsWith('a=candidate:')) {
      const c = parseCandidate(line.slice(12).trim())
      if (c) out.candidates.push(c)
    }
  }
  return out
}

export function parseCandidate(str: string): ParsedCandidate | null {
  const p = String(str).split(/\s+/)
  if (p.length < 8 || p[6] !== 'typ') return null
  const c: ParsedCandidate = {
    foundation: p[0],
    component: p[1],
    proto: p[2],
    priority: p[3],
    addr: p[4],
    port: p[5],
    typ: p[7]
  }
  for (let i = 8; i < p.length - 1; i++) {
    if (p[i] === 'raddr') c.raddr = p[i + 1]
    else if (p[i] === 'rport') c.rport = p[i + 1]
    else if (p[i] === 'tcptype') c.tcptype = p[i + 1]
  }
  return c
}

/* ---------------- SDP -> 紧凑对象 ---------------- */

export function compact(sdp: string, meta: { role: SignalRole; name: string }): CompactSignal {
  const info = parseSdp(sdp)
  if (!info.ufrag || !info.pwd || !info.fingerprint) {
    throw new Error('SDP 不完整（缺少 ice-ufrag / ice-pwd / fingerprint）')
  }
  const seen = new Set<string>()
  const candidates: string[][] = []
  for (const c of info.candidates) {
    // 只保留 UDP 的 host / srflx：中继需要 TURN 凭据，TCP 候选对本场景无意义
    if (String(c.proto).toLowerCase() !== 'udp') continue
    if (c.typ !== 'host' && c.typ !== 'srflx') continue
    const key = `${c.addr}:${c.port}/${c.typ}`
    if (seen.has(key)) continue
    seen.add(key)
    const item = [c.addr, String(c.port), c.typ]
    if (c.raddr) item.push(c.raddr, String(c.rport ?? 0))
    candidates.push(item)
  }
  return {
    v: CODEC_VERSION,
    r: meta.role,
    n: (meta.name || '').slice(0, 24),
    u: info.ufrag,
    p: info.pwd,
    f: info.fingerprint,
    fa: info.fingerprintAlgo || 'sha-256',
    s: info.setup || (meta.role === 'o' ? 'actpass' : 'active'),
    sp: info.sctpPort || 5000,
    mm: info.maxMessageSize || 262144,
    c: candidates
  }
}

/* ---------------- 紧凑对象 -> 标准 SDP ---------------- */

export function expand(obj: CompactSignal): string {
  if (!obj || obj.v !== CODEC_VERSION) throw new Error('信令码版本不兼容')
  const role: SignalRole = obj.r === 'a' ? 'a' : 'o'
  const lines = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${obj.u}`,
    `a=ice-pwd:${obj.p}`,
    `a=fingerprint:${obj.fa || 'sha-256'} ${obj.f}`,
    `a=setup:${obj.s || (role === 'o' ? 'actpass' : 'active')}`,
    'a=mid:0',
    `a=sctp-port:${obj.sp || 5000}`,
    `a=max-message-size:${obj.mm || 262144}`
  ]
  const candidates = obj.c || []
  candidates.forEach((c, i) => lines.push(candidateLine(c, i)))
  return lines.join('\r\n') + '\r\n'
}

function candidateLine(c: string[], index: number): string {
  const typ = c[2] || 'host'
  const priority = typ === 'srflx' ? 1694498815 : typ === 'relay' ? 41885439 : 2122260223
  let s = `a=candidate:${index + 1} 1 udp ${priority} ${c[0]} ${c[1]} typ ${typ}`
  if (c[3]) s += ` raddr ${c[3]} rport ${c[4] || 0}`
  s += ' generation 0'
  return s
}

/* ---------------- 打包 / 解包 ---------------- */

export function pack(obj: CompactSignal): string {
  const clean: CompactSignal = {
    v: obj.v,
    r: obj.r,
    n: obj.n,
    u: obj.u,
    p: obj.p,
    f: obj.f,
    fa: obj.fa || 'sha-256',
    s: obj.s,
    sp: obj.sp,
    mm: obj.mm,
    c: obj.c
  }
  return CODEC_PREFIX + utf8ToBase64Url(JSON.stringify(clean))
}

export function unpack(code: string): CompactSignal {
  let raw = String(code ?? '').replace(/\s+/g, '')
  if (!raw) throw new Error('请先粘贴对方的信令码')
  const idx = raw.indexOf(CODEC_PREFIX)
  if (idx >= 0) raw = raw.slice(idx + CODEC_PREFIX.length)
  raw = raw.replace(/[^A-Za-z0-9\-_]/g, '')
  if (raw.length < 16) throw new Error('信令码太短，可能没有复制完整')
  let obj: CompactSignal
  try {
    obj = JSON.parse(base64UrlToUtf8(raw)) as CompactSignal
  } catch {
    throw new Error('信令码解析失败，可能被聊天软件截断或改写了字符')
  }
  if (!obj || obj.v !== CODEC_VERSION) throw new Error('信令码版本不兼容，请双方使用同一版本页面')
  if (!obj.u || !obj.p || !obj.f) throw new Error('信令码内容不完整')
  return obj
}

/** 便于排查问题：把信令对象转成可读描述 */
export function describe(obj: CompactSignal | null | undefined): string {
  if (!obj) return '(空)'
  const list = (obj.c || []).map((c) => `${c[2]}:${c[0]}:${c[1]}`).join(', ')
  return `角色=${obj.r === 'a' ? '应答方' : '发起方'} 昵称=${obj.n || '未设置'} 候选=${(obj.c || []).length} [${list}]`
}
