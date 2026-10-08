import { describe, expect, it } from 'vitest'
import {
  CODEC_PREFIX,
  CODEC_VERSION,
  compact,
  describe as describeSignal,
  expand,
  pack,
  parseSdp,
  unpack,
  type CompactSignal
} from '../src/lib/sdp-codec'

/** 一份贴近 Chrome 真实输出的 datachannel SDP */
const SAMPLE_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 64166 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 192.168.1.23',
  'a=candidate:1467250027 1 udp 2122260223 192.168.1.23 64166 typ host generation 0 network-id 1',
  'a=candidate:1467250027 1 tcp 1518280447 192.168.1.23 9 typ host tcptype active generation 0 network-id 1',
  'a=candidate:2708162159 1 udp 1686052607 203.0.113.7 54321 typ srflx raddr 192.168.1.23 rport 64166 generation 0 network-id 1',
  'a=candidate:9999 1 udp 41885439 198.51.100.9 34789 typ relay raddr 0.0.0.0 rport 0 generation 0',
  'a=ice-ufrag:4ZcD',
  'a=ice-pwd:2/1muCWoQF7Zc0iCeomR2yyg',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 6B:8B:5A:1F:11:A1:0C:12:8D:5F:2E:C4:3B:B7:9C:3A:2D:25:9C:1B:3D:1B:8F:9E:00:3E:1D:E5:5C:1F:8A:6C',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  ''
].join('\r\n')

describe('SDP 解析', () => {
  it('正确提取 ufrag / pwd / 指纹 / 候选 / 端口', () => {
    const info = parseSdp(SAMPLE_OFFER)
    expect(info.ufrag).toBe('4ZcD')
    expect(info.pwd).toBe('2/1muCWoQF7Zc0iCeomR2yyg')
    expect(info.setup).toBe('actpass')
    expect(info.sctpPort).toBe(5000)
    expect(info.maxMessageSize).toBe(262144)
    expect(info.fingerprint?.startsWith('6B:8B:5A')).toBe(true)
    expect(info.candidates).toHaveLength(4)
  })
})

describe('SDP 压缩', () => {
  it('过滤 TCP 与 relay 候选，保留 host / srflx', () => {
    const obj = compact(SAMPLE_OFFER, { role: 'o', name: '小明' })
    expect(obj.c).toHaveLength(2)
    expect(obj.c[0][2]).toBe('host')
    expect(obj.c[1][2]).toBe('srflx')
    expect(obj.c[1][3]).toBe('192.168.1.23')
    expect(obj.v).toBe(CODEC_VERSION)
    expect(obj.n).toBe('小明')
  })

  it('缺少必要字段时抛出明确错误', () => {
    expect(() => compact('v=0\r\n', { role: 'o', name: '' })).toThrow(/SDP 不完整/)
  })
})

describe('信令码打包 / 解包', () => {
  it('往返一致，且长度足够短', () => {
    const obj = compact(SAMPLE_OFFER, { role: 'o', name: '小明' })
    const code = pack(obj)
    expect(code.startsWith(CODEC_PREFIX)).toBe(true)
    expect(code.length).toBeLessThan(800)
    const back = unpack(code)
    expect(back.u).toBe(obj.u)
    expect(back.p).toBe(obj.p)
    expect(back.f).toBe(obj.f)
    expect(back.s).toBe(obj.s)
    expect(back.n).toBe(obj.n)
    expect(back.c).toEqual(obj.c)
  })

  it('容忍换行、前后包裹文字与多余空格', () => {
    const code = pack(compact(SAMPLE_OFFER, { role: 'a', name: '' }))
    const messy = `这是我的应答码：\n${code.slice(0, 30)}\n  ${code.slice(30)}\n谢谢！`
    expect(unpack(messy).r).toBe('a')
  })

  it('非法信令码给出可读的错误', () => {
    expect(() => unpack('')).toThrow(/请先粘贴/)
    expect(() => unpack('P2P1-abcdefghijklmnop')).toThrow(/解析失败|不完整/)
  })
})

describe('SDP 还原', () => {
  it('还原后的 SDP 可再次解析且信息等价', () => {
    const obj = compact(SAMPLE_OFFER, { role: 'o', name: '' })
    const sdp = expand(obj)
    const info = parseSdp(sdp)
    expect(info.ufrag).toBe(obj.u)
    expect(info.pwd).toBe(obj.p)
    expect(info.fingerprint).toBe(obj.f)
    expect(info.setup).toBe('actpass')
    expect(info.sctpPort).toBe(5000)
    expect(info.candidates).toHaveLength(2)
    expect(info.candidates[0].addr).toBe('192.168.1.23')
    expect(info.candidates[0].port).toBe('64166')
    expect(info.candidates[0].typ).toBe('host')
    expect(info.candidates[0].proto.toLowerCase()).toBe('udp')
    expect(info.candidates[1].typ).toBe('srflx')
    expect(sdp).toContain('m=application 9 UDP/DTLS/SCTP webrtc-datachannel')
    expect(sdp).toContain('a=group:BUNDLE 0')
    expect(sdp).toContain('a=mid:0')
  })

  it('应答方默认 setup:active', () => {
    const obj: CompactSignal = compact(SAMPLE_OFFER, { role: 'a', name: '' })
    obj.s = ''
    expect(expand(obj)).toContain('a=setup:active')
  })

  it('describe 输出可读描述', () => {
    const text = describeSignal(compact(SAMPLE_OFFER, { role: 'o', name: '小明' }))
    expect(text).toContain('发起方')
    expect(text).toContain('小明')
    expect(text).toContain('host:192.168.1.23:64166')
  })
})
