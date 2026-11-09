import { McpError } from '../core/errors.js'

export interface SocketHandshake {
  sessionId: string
  heartbeatTimeoutSeconds: number
  connectionTimeoutSeconds: number
  transports: string[]
}

export type SocketPacket =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'heartbeat' }
  | { type: 'noop' }
  | { type: 'event'; name: string; args: unknown[]; ackId?: number }
  | { type: 'ack'; ackId: number; args: unknown[] }
  | { type: 'error'; reason: string; advice?: string }
  | { type: 'message'; value: string }

export function parseHandshake(value: string): SocketHandshake {
  const [sessionId, heartbeat, connection, transports] = value.trim().split(':')
  const heartbeatTimeoutSeconds = Number(heartbeat)
  const connectionTimeoutSeconds = Number(connection)
  if (
    !sessionId ||
    !Number.isFinite(heartbeatTimeoutSeconds) ||
    !Number.isFinite(connectionTimeoutSeconds) ||
    !transports
  ) {
    throw new McpError('PROTOCOL_UNSUPPORTED', 'Invalid Socket.IO 0.9 handshake.')
  }
  return {
    sessionId,
    heartbeatTimeoutSeconds,
    connectionTimeoutSeconds,
    transports: transports.split(','),
  }
}

export function encodeEventPacket(name: string, args: unknown[], ackId?: number): string {
  const id = ackId === undefined ? '' : `${ackId}+`
  return `5:${id}::${JSON.stringify({ name, args })}`
}

/** Socket.IO 0.9's error reasons and advice, by the index its parser encodes. */
const ERROR_REASONS = ['transport not supported', 'client not handshaken', 'unauthorized']
const ERROR_ADVICE = ['reconnect']

export function parseSocketPacket(value: string): SocketPacket {
  if (value === '0::') return { type: 'disconnect' }
  if (value === '1::') return { type: 'connect' }
  if (value === '2::') return { type: 'heartbeat' }
  if (value === '8::') return { type: 'noop' }

  const match = /^(\d):([^:]*):([^:]*):(.*)$/su.exec(value)
  if (!match) {
    throw new McpError('PROTOCOL_UNSUPPORTED', 'Unrecognized Socket.IO 0.9 packet.')
  }
  const [, type, rawId, , data] = match
  if (type === '3') return { type: 'message', value: data ?? '' }
  if (type === '5') {
    try {
      const event = JSON.parse(data ?? '') as { name?: unknown; args?: unknown }
      // Socket.IO 0.9 writes args only when an event has any.
      const args = event.args ?? []
      if (typeof event.name !== 'string' || !Array.isArray(args)) throw new Error('invalid event')
      const ackId = rawId ? Number(rawId.replace(/\+$/u, '')) : undefined
      return {
        type: 'event',
        name: event.name,
        args,
        ...(ackId === undefined ? {} : { ackId }),
      }
    } catch (error) {
      throw new McpError('PROTOCOL_UNSUPPORTED', 'Invalid Socket.IO event packet.', {
        cause: error,
      })
    }
  }
  if (type === '6') {
    // Socket.IO 0.9 permits both a bare acknowledgement ID and ID-plus-JSON arguments.
    const ack = /^(\d+)(?:\+(.*))?$/su.exec(data ?? '')
    if (!ack) throw new McpError('PROTOCOL_UNSUPPORTED', 'Invalid Socket.IO ack packet.')
    try {
      const args = ack[2] ? (JSON.parse(ack[2]) as unknown) : []
      if (!Array.isArray(args)) throw new Error('ack is not an array')
      return { type: 'ack', ackId: Number(ack[1]), args }
    } catch (error) {
      throw new McpError('PROTOCOL_UNSUPPORTED', 'Invalid Socket.IO ack payload.', {
        cause: error,
      })
    }
  }
  if (type === '7') {
    // Socket.IO 0.9 sends an error's reason and advice as indices, `reason+advice`.
    const [rawReason = '', rawAdvice] = (data ?? '').split('+')
    const reason = /^\d+$/u.test(rawReason) ? ERROR_REASONS[Number(rawReason)] : undefined
    const advice = rawAdvice !== undefined && /^\d+$/u.test(rawAdvice) ? ERROR_ADVICE[Number(rawAdvice)] : undefined
    return { type: 'error', reason: reason ?? (data || 'socket error'), ...(advice === undefined ? {} : { advice }) }
  }
  throw new McpError('PROTOCOL_UNSUPPORTED', `Unsupported Socket.IO packet type ${type}.`)
}
