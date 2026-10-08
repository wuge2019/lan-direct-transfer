/**
 * Peer 层的输入校验测试（不需要真实 WebRTC：这些校验都发生在
 * 触碰 RTCPeerConnection 之前）
 */
import { describe, expect, it } from 'vitest'
import { Peer, type PeerOptions } from '../src/lib/peer'
import { compact, pack, unpack } from '../src/lib/sdp-codec'

const SAMPLE = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:1 1 udp 2122260223 192.168.1.23 64166 typ host generation 0',
  'a=ice-ufrag:4ZcD',
  'a=ice-pwd:2/1muCWoQF7Zc0iCeomR2yyg',
  'a=fingerprint:sha-256 6B:8B:5A:1F:11:A1:0C:12:8D:5F:2E:C4:3B:B7:9C:3A:2D:25:9C:1B:3D:1B:8F:9E:00:3E:1D:E5:5C:1F:8A:6C',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  ''
].join('\r\n')

function makePeer(): Peer {
  const options: PeerOptions = {
    getIceServers: () => [],
    getName: () => '测试端',
    log: () => {},
    onStatus: () => {},
    onOpen: () => {},
    onClosed: () => {},
    onSys: () => {},
    onChat: () => {},
    onPeerName: () => {},
    onRtt: () => {},
    onPath: () => {},
    onFileMsg: () => {},
    onBinary: () => {}
  }
  return new Peer(options)
}

const offerCode = pack(compact(SAMPLE, { role: 'o', name: '发起方' }))
const answerCode = pack(compact(SAMPLE, { role: 'a', name: '接收方' }))

describe('Peer 信令码校验', () => {
  it('把应答码当邀请码粘贴时给出明确提示', async () => {
    const peer = makePeer()
    await expect(peer.createAnswer(answerCode)).rejects.toThrow(/邀请码/)
  })

  it('把邀请码当应答码粘贴时给出明确提示', async () => {
    const peer = makePeer()
    await expect(peer.applyAnswer(offerCode)).rejects.toThrow(/应答码/)
  })

  it('尚未生成邀请码就应用应答码时提示先完成第 1 步', async () => {
    const peer = makePeer()
    await expect(peer.applyAnswer(answerCode)).rejects.toThrow(/第 1 步/)
  })

  it('空内容会被 unpack 拦下', async () => {
    const peer = makePeer()
    await expect(peer.applyAnswer('   ')).rejects.toThrow(/请先粘贴/)
  })
})

describe('指纹算法随信令码传递', () => {
  it('compact 记录算法，expand 还原成同一种算法', () => {
    const sha384 = SAMPLE.replace('a=fingerprint:sha-256', 'a=fingerprint:sha-384')
    const obj = compact(sha384, { role: 'o', name: '' })
    expect(obj.fa).toBe('sha-384')
    const code = pack(obj)
    expect(unpack(code).fa).toBe('sha-384')
    expect(code).toBeTruthy()
  })

  it('旧版本信令码（没有 fa 字段）仍然按 sha-256 处理', () => {
    const obj = compact(SAMPLE, { role: 'o', name: '' })
    delete obj.fa
    const back = unpack(pack(obj))
    expect(back.fa).toBe('sha-256')
  })
})
