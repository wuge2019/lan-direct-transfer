/**
 * 极简 WebSocket 服务端实现（RFC 6455 子集）
 *
 * 为什么不用 ws 之类的库：
 *   本项目希望「下载下来 node server/index.mjs 就能跑」，不依赖 node_modules。
 *   这里只需要文本帧、掩码解析、ping/pong、close 与分片重组，
 *   足以支撑局域网发现与信令转发。
 *
 * 说明：同一进程内一次性解析，未做 backpressure 控制（信令消息都很小）。
 */

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/** 单条消息上限：信令码只有几百字节，1MB 已经非常宽松 */
const DEFAULT_MAX_PAYLOAD = 1024 * 1024

export class WebSocketConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head 升级请求里已经读到的多余字节
   */
  constructor(socket, head, options = {}) {
    super()
    this.socket = socket
    this.id = options.id || ''
    this.closed = false
    this.isAlive = true
    this.data = options.data || null

    this.maxPayload = options.maxPayload || DEFAULT_MAX_PAYLOAD
    this.buffer = Buffer.alloc(0)
    this.fragments = null
    this.fragmentLength = 0
    this.closeEmitted = false

    socket.setNoDelay(true)
    socket.on('data', (chunk) => this.feed(chunk))
    socket.on('close', () => this.handleSocketClose())
    socket.on('error', () => this.destroy())

    if (head && head.length) this.feed(head)
  }

  /** 发送一条文本消息 */
  send(text) {
    if (this.closed) return false
    try {
      this.socket.write(encodeFrame(OP_TEXT, Buffer.from(String(text), 'utf8')))
      return true
    } catch {
      this.destroy()
      return false
    }
  }

  /** 发送 JSON */
  sendJson(value) {
    return this.send(JSON.stringify(value))
  }

  ping() {
    if (this.closed) return
    this.isAlive = false
    try {
      this.socket.write(encodeFrame(OP_PING, Buffer.alloc(0)))
    } catch {
      this.destroy()
    }
  }

  /** 正常关闭：发 close 帧后断开 */
  close(code = 1000, reason = '') {
    if (this.closed) return
    const reasonBuffer = Buffer.from(String(reason), 'utf8')
    const payload = Buffer.allocUnsafe(2 + reasonBuffer.length)
    payload.writeUInt16BE(code, 0)
    reasonBuffer.copy(payload, 2)
    try {
      this.socket.write(encodeFrame(OP_CLOSE, payload))
    } catch {
      /* 忽略 */
    }
    this.closed = true
    // 给对端一点时间收 close 帧
    setTimeout(() => this.destroy(), 50)
  }

  destroy() {
    if (this.socket.destroyed) return
    try {
      this.socket.destroy()
    } catch {
      /* 忽略 */
    }
  }

  /* ---------------- 内部 ---------------- */

  handleSocketClose() {
    this.closed = true
    this.emitClose()
  }

  /** close 事件只发一次（close 帧与 socket 关闭可能都触发） */
  emitClose() {
    if (this.closeEmitted) return
    this.closeEmitted = true
    this.emit('close')
  }

  /** 协议错误：按规范回 close 帧并断开 */
  fail(code, reason) {
    if (this.closed) return
    this.close(code, reason)
  }

  feed(chunk) {
    if (this.closed) return
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk

    for (;;) {
      if (this.buffer.length < 2) return
      const b0 = this.buffer[0]
      const b1 = this.buffer[1]
      const fin = (b0 & 0x80) !== 0
      const rsv = b0 & 0x70
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let length = b1 & 0x7f
      let offset = 2

      if (rsv !== 0) return this.fail(1002, 'RSV 必须为 0（不支持扩展）')

      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const big = this.buffer.readBigUInt64BE(2)
        if (big > BigInt(this.maxPayload)) return this.fail(1009, '消息过大')
        length = Number(big)
        offset = 10
      }

      if (length > this.maxPayload) return this.fail(1009, '消息过大')

      const isControl = opcode >= 0x8
      if (isControl && (!fin || length > 125)) return this.fail(1002, '控制帧格式错误')

      // 客户端发来的帧必须掩码（RFC 6455 5.1）
      if (!masked) return this.fail(1002, '客户端帧必须使用掩码')

      if (this.buffer.length < offset + 4) return
      const maskKey = this.buffer.subarray(offset, offset + 4)
      offset += 4

      if (this.buffer.length < offset + length) return

      const payload = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i++) {
        payload[i] = this.buffer[offset + i] ^ maskKey[i & 3]
      }
      this.buffer = this.buffer.subarray(offset + length)

      this.handleFrame(fin, opcode, payload)
      if (this.closed) return
    }
  }

  handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP_CONTINUATION: {
        if (!this.fragments) return this.fail(1002, '没有待续帧')
        this.fragmentLength += payload.length
        if (this.fragmentLength > this.maxPayload) return this.fail(1009, '消息过大')
        this.fragments.push(payload)
        if (fin) {
          const type = this.fragmentType
          const full = Buffer.concat(this.fragments, this.fragmentLength)
          this.fragments = null
          this.fragmentLength = 0
          this.dispatch(type, full)
        }
        return
      }
      case OP_TEXT:
      case OP_BINARY: {
        if (this.fragments) return this.fail(1002, '分片消息未结束')
        if (fin) {
          this.dispatch(opcode, payload)
        } else {
          this.fragments = [payload]
          this.fragmentType = opcode
          this.fragmentLength = payload.length
        }
        return
      }
      case OP_CLOSE: {
        this.closed = true
        try {
          this.socket.write(encodeFrame(OP_CLOSE, payload.subarray(0, 2)))
        } catch {
          /* 忽略 */
        }
        this.emitClose()
        this.destroy()
        return
      }
      case OP_PING: {
        try {
          this.socket.write(encodeFrame(OP_PONG, payload))
        } catch {
          this.destroy()
        }
        return
      }
      case OP_PONG: {
        this.isAlive = true
        this.emit('pong')
        return
      }
      default:
        return this.fail(1003, '不支持的操作码')
    }
  }

  dispatch(opcode, payload) {
    if (opcode === OP_TEXT) {
      const text = decodeUtf8(payload)
      if (text === null) return this.fail(1007, '文本帧不是合法 UTF-8')
      this.emit('message', text)
    } else {
      this.emit('binary', payload)
    }
  }
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return null
  }
}

function encodeFrame(opcode, payload) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

/**
 * 把一个 HTTP server 升级为支持 WebSocket 的服务端
 * @returns {{ close: () => void, heartbeat: () => NodeJS.Timeout }}
 */
export function attachWebSocketServer(httpServer, options) {
  const {
    path = '/ws',
    maxPayload = DEFAULT_MAX_PAYLOAD,
    onConnection,
    verifyClient,
    heartbeatInterval = 30000
  } = options || {}

  const connections = new Set()

  httpServer.on('upgrade', (req, socket, head) => {
    const requestPath = (req.url || '').split('?')[0]
    if (requestPath !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    if (verifyClient && !verifyClient(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const key = req.headers['sec-websocket-key']
    const version = req.headers['sec-websocket-version']
    if (!key || String(version) !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )

    const connection = new WebSocketConnection(socket, head, { maxPayload })
    connections.add(connection)
    connection.on('close', () => connections.delete(connection))
    try {
      onConnection?.(connection, req)
    } catch (error) {
      console.error('[ws] 处理新连接时出错：', error)
      connection.close(1011, '服务端内部错误')
    }
  })

  const timer = setInterval(() => {
    for (const connection of connections) {
      if (!connection.isAlive) {
        connection.destroy()
        connections.delete(connection)
        continue
      }
      connection.ping()
    }
  }, heartbeatInterval)
  timer.unref?.()

  return {
    connections,
    close() {
      clearInterval(timer)
      for (const connection of connections) connection.close(1001, '服务端关闭')
    }
  }
}
