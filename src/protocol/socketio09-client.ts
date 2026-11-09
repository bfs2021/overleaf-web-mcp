import { EventEmitter } from 'node:events'

import { McpError } from '../core/errors.js'
import { encodeEventPacket, parseSocketPacket } from './socketio09-codec.js'
import { upstreamReason } from './upstream-reason.js'

export interface WebSocketPeer extends EventEmitter {
  readyState: number
  send(value: string): void
  close(): void
}

/** Nothing was sent, so this is an ordinary failure even for a write. */
export function notConnectedError(): McpError {
  return new McpError('REMOTE_ERROR', 'Overleaf socket is not connected.', {
    retryable: true,
    details: { reason: 'not_connected' },
  })
}

interface PendingAck {
  resolve: (args: unknown[]) => void
  reject: (error: unknown) => void
  timer: NodeJS.Timeout
}

/** Maintains Socket.IO 0.9 heartbeats and correlates legacy event acknowledgements. */
export class SocketIo09Peer extends EventEmitter {
  readonly #socket: WebSocketPeer
  readonly #pending = new Map<number, PendingAck>()
  #nextAckId = 1
  #closed = false

  constructor(socket: WebSocketPeer) {
    super()
    this.#socket = socket
    socket.on('message', value => this.#onMessage(value))
    socket.on('error', error => this.#failProtocol(error))
    socket.on('close', () => {
      this.#closed = true
      // The peer cannot tell a read from a write; callers that know it was a read say so.
      this.#failAll(new McpError('OUTCOME_UNKNOWN', 'Overleaf socket disconnected.'))
      super.emit('disconnect')
    })
  }

  sendEvent(name: string, args: unknown[]): void {
    this.#assertOpen()
    this.#socket.send(encodeEventPacket(name, args))
  }

  call(name: string, args: unknown[], timeoutMs: number): Promise<unknown[]> {
    if (this.closed) return Promise.reject(notConnectedError())
    const ackId = this.#nextAckId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(ackId)
        reject(
          new McpError('TIMEOUT', `Socket acknowledgement timed out for ${name}.`, {
            retryable: false,
            details: { event: name },
          })
        )
      }, timeoutMs)
      this.#pending.set(ackId, { resolve, reject, timer })
      this.#socket.send(encodeEventPacket(name, args, ackId))
    })
  }

  close(): void {
    if (!this.#closed) this.#socket.close()
  }

  /** True once the socket is closing or closed and cannot carry another call. */
  get closed(): boolean {
    return this.#closed || this.#socket.readyState > 1
  }

  #assertOpen(): void {
    if (this.closed) throw notConnectedError()
  }

  #onMessage(raw: unknown): void {
    const value = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
    let packet
    try {
      packet = parseSocketPacket(value)
    } catch (error) {
      this.#failProtocol(error)
      return
    }
    if (packet.type === 'heartbeat') {
      this.#socket.send('2::')
    } else if (packet.type === 'event') {
      super.emit(packet.name, ...packet.args)
    } else if (packet.type === 'ack') {
      const pending = this.#pending.get(packet.ackId)
      if (pending) {
        clearTimeout(pending.timer)
        this.#pending.delete(packet.ackId)
        pending.resolve(packet.args)
      }
    } else if (packet.type === 'disconnect') {
      this.close()
    } else if (packet.type === 'error') {
      // Advice to reconnect, as for a WebSocket that reached a real-time instance without its
      // handshake, means a fresh connection can work.
      this.#failProtocol(
        new McpError('REMOTE_ERROR', 'Overleaf sent a Socket.IO error packet.', {
          retryable: packet.advice === 'reconnect',
          details: { reason: upstreamReason(packet.reason) },
        })
      )
    } else if (packet.type === 'connect') {
      super.emit('connect')
    }
  }

  #failAll(error: unknown): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #failProtocol(error: unknown): void {
    this.#failAll(error)
    if (this.listenerCount('error') > 0) super.emit('error', error)
    this.close()
  }
}
