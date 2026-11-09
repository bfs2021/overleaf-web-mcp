import type { Agent } from 'node:http'

import WebSocket from 'ws'
import type { CookieJar } from 'tough-cookie'

import { AUTH_LOGIN_INSTRUCTION, McpError } from '../core/errors.js'
import { USER_AGENT } from '../version.js'
import { ProjectConnection, type JoinProjectData } from './project-connection.js'
import { SocketIo09Peer, type WebSocketPeer } from './socketio09-client.js'
import { parseHandshake } from './socketio09-codec.js'
import { upstreamCodeReason, upstreamReason } from './upstream-reason.js'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>
type WebSocketFactory = (url: string, options: { headers: Record<string, string> }) => WebSocketPeer

export interface OpenProjectConnectionOptions {
  baseUrl: string
  projectId: string
  jar: CookieJar
  supportedProtocolVersions: number[]
  currentUserId?: string
  timeoutMs?: number
  applyTimeoutMs?: number
  fetcher?: Fetcher
  /** Carries the WebSocket, for example through a proxy; pair it with a `fetcher` taking the same route. */
  webSocketAgent?: Agent
  webSocketFactory?: WebSocketFactory
}

function createWebSocketFactory(agent?: Agent): WebSocketFactory {
  return (url, options) =>
    new WebSocket(url, {
      headers: options.headers,
      perMessageDeflate: false,
      ...(agent === undefined ? {} : { agent }),
    })
}

function responseSetCookies(headers: Headers): string[] {
  const enhanced = headers as Headers & { getSetCookie?: () => string[] }
  if (enhanced.getSetCookie) return enhanced.getSetCookie()
  const value = headers.get('set-cookie')
  return value ? [value] : []
}

/**
 * Maps real-time's `connectionRejected` payload to a typed error, by its coded `code` first and
 * then its message. Nothing was sent to the project in any case. Only an invalid session means
 * signing in again; a rejection this release does not know stays `REMOTE_ERROR`, never
 * `AUTH_EXPIRED`, so an agent is not told to stop for a failure a new login would not fix.
 */
export function classifyRejection(value: unknown): McpError {
  const reason = upstreamCodeReason(value) ?? upstreamReason(value)
  const details = { reason }
  switch (reason) {
    case 'invalid_session':
      return new McpError('AUTH_EXPIRED', `Overleaf rejected the socket connection. ${AUTH_LOGIN_INSTRUCTION}`, {
        details,
      })
    case 'join_rate_limited':
    case 'rate_limited':
      return new McpError(
        'RATE_LIMITED',
        'Overleaf rate-limited joining this project. Nothing was sent; wait a minute before trying again.',
        { retryable: true, details }
      )
    case 'retry':
      return new McpError(
        'TRANSIENT_FAILURE',
        'Overleaf asked the client to connect again later, as it does while restarting. Nothing was sent; try again shortly.',
        { retryable: true, details }
      )
    case 'not_authorized':
    case 'unauthorized':
      return new McpError('PERMISSION_DENIED', 'Overleaf refused to let this account join the project.', { details })
    case 'project_not_found':
      return new McpError('NOT_FOUND', 'Overleaf could not find this project.', { details })
    case 'bad_project_id':
      return new McpError('INVALID_ARGUMENT', 'Overleaf did not accept the projectId as a project id.', { details })
    default:
      return new McpError('REMOTE_ERROR', 'Overleaf rejected the socket connection.', {
        retryable: reason === 'connection_error' || reason === 'realtime_error',
        details,
      })
  }
}

/** Performs the legacy handshake, validates project bootstrap data, and returns a live socket. */
export async function openProjectConnection(options: OpenProjectConnectionOptions): Promise<ProjectConnection> {
  const baseUrl = options.baseUrl.replace(/\/$/u, '')
  const timeoutMs = options.timeoutMs ?? 30_000
  const query = new URLSearchParams({
    projectId: options.projectId,
    t: String(Date.now()),
  })
  const handshakeUrl = `${baseUrl}/socket.io/1/?${query.toString()}`
  const cookie = await options.jar.getCookieString(handshakeUrl)
  const fetcher = options.fetcher ?? fetch
  let response: Response
  try {
    response = await fetcher(handshakeUrl, {
      headers: {
        accept: 'text/plain',
        ...(cookie ? { cookie } : {}),
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    })
  } catch (error) {
    throw new McpError('TIMEOUT', 'Socket.IO handshake failed or timed out.', {
      retryable: true,
      cause: error,
    })
  }
  if (response.status === 401 || (response.url && new URL(response.url).pathname.startsWith('/login'))) {
    throw new McpError('AUTH_EXPIRED', `Overleaf authentication expired. ${AUTH_LOGIN_INSTRUCTION}`)
  }
  if (!response.ok) {
    throw new McpError('REMOTE_ERROR', `Socket.IO handshake returned HTTP ${response.status}.`, {
      retryable: response.status >= 500,
      details: { status: response.status },
    })
  }
  // SaaS handshakes can set a load-balancer cookie; the WebSocket must use the same route.
  const handshakeCookieUrl = response.url || handshakeUrl
  for (const value of responseSetCookies(response.headers)) {
    await options.jar.setCookie(value, handshakeCookieUrl)
  }
  const websocketCookie = await options.jar.getCookieString(handshakeUrl)
  const handshake = parseHandshake(await response.text())
  if (!handshake.transports.includes('websocket')) {
    throw new McpError('PROTOCOL_UNSUPPORTED', 'Overleaf did not offer the websocket transport.')
  }

  const websocketUrl = new URL(baseUrl)
  websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  websocketUrl.pathname = `/socket.io/1/websocket/${handshake.sessionId}`
  websocketUrl.search = ''
  const webSocketFactory = options.webSocketFactory ?? createWebSocketFactory(options.webSocketAgent)
  const socket = webSocketFactory(websocketUrl.href, {
    headers: {
      ...(websocketCookie ? { Cookie: websocketCookie } : {}),
      Origin: baseUrl,
      'User-Agent': USER_AGENT,
    },
  })
  const peer = new SocketIo09Peer(socket)

  const join = await new Promise<JoinProjectData>((resolve, reject) => {
    const timer = setTimeout(() => {
      peer.close()
      reject(new McpError('TIMEOUT', 'Timed out waiting for joinProjectResponse.'))
    }, timeoutMs)
    const finish = (callback: () => void): void => {
      clearTimeout(timer)
      callback()
    }
    peer.once('joinProjectResponse', (value: JoinProjectData) => finish(() => resolve(value)))
    peer.once('connectionRejected', (value: unknown) => finish(() => reject(classifyRejection(value))))
    // The socket's own error text is not passed on; this server's typed errors are.
    peer.once('error', error =>
      finish(() =>
        reject(
          error instanceof McpError
            ? error
            : new McpError('REMOTE_ERROR', 'The Overleaf socket failed while joining the project.', { cause: error })
        )
      )
    )
    peer.once('disconnect', () =>
      finish(() =>
        reject(
          new McpError('REMOTE_ERROR', 'Socket disconnected during project join.', {
            retryable: true,
            details: { reason: 'disconnected' },
          })
        )
      )
    )
  })

  return new ProjectConnection({
    projectId: options.projectId,
    peer,
    join,
    supportedProtocolVersions: options.supportedProtocolVersions,
    ...(options.currentUserId === undefined ? {} : { currentUserId: options.currentUserId }),
    callTimeoutMs: timeoutMs,
    applyTimeoutMs: options.applyTimeoutMs ?? timeoutMs,
  })
}
