import { EventEmitter } from 'node:events'

import { CookieJar } from 'tough-cookie'
import { describe, expect, test, vi } from 'vitest'

import { openProjectConnection } from '../../src/protocol/connect.js'
import { USER_AGENT } from '../../src/version.js'

class FakeSocket extends EventEmitter {
  readyState = 0
  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = 3
    this.emit('close')
  })
}

describe('project socket bootstrap', () => {
  test('uses the authenticated 0.9 handshake and validates joinProjectResponse', async () => {
    const jar = new CookieJar()
    await jar.setCookie('overleaf.sid=session; Path=/; Secure', 'https://overleaf.test')
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(String(_url)).toContain('/socket.io/1/')
      expect(String(_url)).toContain('projectId=project')
      expect(new Headers(init?.headers).get('cookie')).toContain('overleaf.sid=session')
      expect(new Headers(init?.headers).get('user-agent')).toBe(USER_AGENT)
      return new Response('SOCKET_SESSION:60:60:websocket', {
        headers: { 'set-cookie': 'GCLB=sticky-route; Path=/; Secure; HttpOnly' },
      })
    })
    const socket = new FakeSocket()
    const webSocketFactory = vi.fn((url: string, options: { headers: Record<string, string> }) => {
      expect(url).toBe('wss://overleaf.test/socket.io/1/websocket/SOCKET_SESSION')
      expect(options.headers.Cookie).toContain('overleaf.sid=session')
      expect(options.headers.Cookie).toContain('GCLB=sticky-route')
      expect(options.headers['User-Agent']).toBe(USER_AGENT)
      setTimeout(() => {
        socket.readyState = 1
        socket.emit('open')
        socket.emit(
          'message',
          Buffer.from(
            '5:::{"name":"joinProjectResponse","args":[{"publicId":"P.client","project":{"_id":"project","rootFolder":[]},"permissionsLevel":"owner","protocolVersion":2}]}'
          )
        )
      }, 0)
      return socket
    })

    const connection = await openProjectConnection({
      baseUrl: 'https://overleaf.test',
      projectId: 'project',
      jar,
      supportedProtocolVersions: [2],
      fetcher,
      webSocketFactory,
      timeoutMs: 1_000,
    })

    expect(connection.publicId).toBe('P.client')
    connection.close()
  })

  test('reports a socket closed during the join as a retryable failure', async () => {
    const socket = new FakeSocket()
    const fetcher = vi.fn(async () => new Response('SOCKET_SESSION:60:60:websocket'))
    const webSocketFactory = vi.fn(() => {
      setTimeout(() => {
        socket.readyState = 1
        socket.close()
      }, 0)
      return socket
    })

    await expect(
      openProjectConnection({
        baseUrl: 'https://overleaf.test',
        projectId: 'project',
        jar: new CookieJar(),
        supportedProtocolVersions: [2],
        fetcher,
        webSocketFactory,
        timeoutMs: 1_000,
      })
    ).rejects.toMatchObject({ code: 'REMOTE_ERROR', retryable: true, details: { reason: 'disconnected' } })
  })

  test.each([
    // The payload real-time sends when web's join-project limiter refuses the join, captured live.
    [
      { message: 'rate-limit hit when joining project', code: 'TooManyRequests' },
      'RATE_LIMITED',
      true,
      'join_rate_limited',
    ],
    [{ message: 'invalid session' }, 'AUTH_EXPIRED', false, 'invalid_session'],
    // The payloads real-time's Router and WebApiManager emit, read in overleaf/overleaf.
    [{ message: 'retry' }, 'TRANSIENT_FAILURE', true, 'retry'],
    [{ message: 'not authorized' }, 'PERMISSION_DENIED', false, 'not_authorized'],
    [{ message: 'project not found', code: 'ProjectNotFound' }, 'NOT_FOUND', false, 'project_not_found'],
    [{ message: 'error' }, 'REMOTE_ERROR', true, 'connection_error'],
    [{ message: 'Something went wrong in real-time service' }, 'REMOTE_ERROR', true, 'realtime_error'],
    [{ message: 'missing/bad ?projectId=... query flag on handshake' }, 'INVALID_ARGUMENT', false, 'bad_project_id'],
    [{ message: 'too many requests' }, 'RATE_LIMITED', true, 'rate_limited'],
    [{ message: 'a rejection no release has seen' }, 'REMOTE_ERROR', false, 'unrecognized'],
    [{ message: 'constructor' }, 'REMOTE_ERROR', false, 'unrecognized'],
    ['not an object', 'REMOTE_ERROR', false, 'unrecognized'],
  ])('maps connectionRejected %j to %s', async (payload, code, retryable, reason) => {
    const socket = new FakeSocket()
    const webSocketFactory = vi.fn(() => {
      setTimeout(() => {
        socket.readyState = 1
        socket.emit('message', `5:::${JSON.stringify({ name: 'connectionRejected', args: [payload] })}`)
      }, 0)
      return socket
    })

    await expect(
      openProjectConnection({
        baseUrl: 'https://overleaf.test',
        projectId: 'project',
        jar: new CookieJar(),
        supportedProtocolVersions: [2],
        fetcher: vi.fn(async () => new Response('SOCKET_SESSION:60:60:websocket')),
        webSocketFactory,
        timeoutMs: 1_000,
      })
    ).rejects.toMatchObject({ code, retryable, details: { reason } })
  })
})
