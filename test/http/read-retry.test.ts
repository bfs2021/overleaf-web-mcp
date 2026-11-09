import { CookieJar } from 'tough-cookie'
import { describe, expect, test, vi } from 'vitest'

import { McpError } from '../../src/core/errors.js'
import { retryRead } from '../../src/core/retry.js'
import { OverleafHttpClient } from '../../src/http/client.js'
import { isTransientJoinFailure } from '../../src/runtime.js'

function client(fetcher: (url: string, init?: RequestInit) => Promise<Response>, extra = {}) {
  const sleep = vi.fn<(ms: number) => Promise<undefined>>(async () => undefined)
  return {
    sleep,
    http: new OverleafHttpClient({
      baseUrl: 'https://overleaf.test',
      jar: new CookieJar(),
      fetcher,
      readAttempts: 3,
      sleep,
      ...extra,
    }),
  }
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

describe('read retry', () => {
  test('sends a GET again after HTTP 5xx and returns the answer that followed', async () => {
    const fetcher = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(json({ ok: true }))
    const { http, sleep } = client(fetcher)

    await expect(http.getJson('/api/project')).resolves.toEqual({ ok: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  test('sends a GET again after a network failure', async () => {
    const fetcher = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json({ ok: true }))
    const { http } = client(fetcher)

    await expect(http.getJson('/api/project')).resolves.toEqual({ ok: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test('gives up after three attempts with TRANSIENT_FAILURE, retryable, naming no response text', async () => {
    const fetcher = vi.fn(async () => await Promise.resolve(new Response('<h1>secret page</h1>', { status: 502 })))
    const { http, sleep } = client(fetcher)

    const failure = await http.getJson('/api/project').catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: 'TRANSIENT_FAILURE',
      retryable: true,
      details: { attempts: 3, lastCode: 'REMOTE_ERROR', status: 502, path: '/api/project' },
    })
    expect(JSON.stringify((failure as McpError).toJSON())).not.toContain('secret')
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  test.each(['POST', 'DELETE'])('never sends a %s twice', async method => {
    const fetcher = vi.fn(async () => await Promise.resolve(new Response('busy', { status: 503 })))
    const { http } = client(fetcher)

    await expect(http.request(method, '/project/p/doc', {})).rejects.toMatchObject({
      code: 'REMOTE_ERROR',
      details: { status: 503 },
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test.each([
    [new Response('', { status: 429 }), 'RATE_LIMITED'],
    [new Response('', { status: 404 }), 'NOT_FOUND'],
    [new Response('', { status: 403 }), 'PERMISSION_DENIED'],
    [new Response('', { status: 400 }), 'REMOTE_ERROR'],
  ])('does not retry a read Overleaf answered with %#', async (response, code) => {
    const fetcher = vi.fn(async () => await Promise.resolve(response.clone()))
    const { http } = client(fetcher)

    await expect(http.getJson('/api/project')).rejects.toMatchObject({ code })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('does not retry a read that timed out', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      await new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      )
      return new Response('')
    })
    const { http } = client(fetcher, { defaultTimeoutMs: 5 })

    await expect(http.getJson('/api/project')).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('sends a POST marked as a read again, as the project list is', async () => {
    const fetcher = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(json({ projects: [] }))
    const { http } = client(fetcher)

    await expect(http.postJson('/api/project', {}, { read: true })).resolves.toEqual({ projects: [] })
    expect(fetcher).toHaveBeenCalledTimes(2)
    // It is still a POST, so it carries the CSRF header path and follows no redirect.
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('manual')
  })

  test('never sends a postJson or postForm twice without the read mark', async () => {
    const fetcher = vi.fn(async () => await Promise.resolve(new Response('busy', { status: 503 })))
    const { http } = client(fetcher)

    await expect(http.postJson('/project/p/doc', { name: 'a.tex' })).rejects.toMatchObject({ code: 'REMOTE_ERROR' })
    await expect(http.postForm('/project/p/upload', new FormData())).rejects.toMatchObject({ code: 'REMOTE_ERROR' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test('reads a GET whose body was cut off again, as a typed retryable failure', async () => {
    const cutOff = (): Response =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"ok":'))
            controller.error(new TypeError('terminated'))
          },
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    const fetcher = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(cutOff())
      .mockResolvedValueOnce(json({ ok: true }))
    const { http } = client(fetcher)
    await expect(http.getJson('/api/thing')).resolves.toEqual({ ok: true })

    const always = vi.fn(async () => await Promise.resolve(cutOff()))
    const failing = client(always).http
    await expect(failing.getBytes('/file')).rejects.toMatchObject({
      code: 'TRANSIENT_FAILURE',
      details: { attempts: 3, lastCode: 'REMOTE_ERROR', path: '/file' },
    })
  })

  test('reports a write whose answer was cut off once, typed and not retryable', async () => {
    const fetcher = vi.fn(
      async () =>
        await Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError('terminated'))
              },
            })
          )
        )
    )
    const { http } = client(fetcher)
    await expect(http.postJson('/project/p/doc', {})).rejects.toMatchObject({
      code: 'REMOTE_ERROR',
      retryable: false,
      details: { kind: 'network' },
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('with readAttempts 1 a transient failure keeps its own code', async () => {
    const fetcher = vi.fn(async () => await Promise.resolve(new Response('busy', { status: 503 })))
    const { http } = client(fetcher, { readAttempts: 1 })

    await expect(http.getJson('/api/project')).rejects.toMatchObject({ code: 'REMOTE_ERROR' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('paces request starts by the minimum interval', async () => {
    const fetcher = vi.fn(async () => await Promise.resolve(json({ ok: true })))
    const { http, sleep } = client(fetcher, { minRequestIntervalMs: 1_000 })

    await Promise.all([http.getJson('/a'), http.getJson('/b'), http.postJson('/c')])
    const waits = sleep.mock.calls.map(([ms]) => ms)
    expect(waits).toHaveLength(2)
    expect(waits[0]).toBeGreaterThan(900)
    expect(waits[1]).toBeGreaterThan(1_900)
  })
})

describe('retryRead', () => {
  test('rethrows a failure that is not transient at once', async () => {
    const work = vi.fn(async () => {
      throw new McpError('NOT_FOUND', 'x')
    })
    await expect(
      retryRead(work, { attempts: 3, isTransient: () => false, sleep: async () => {} })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(work).toHaveBeenCalledTimes(1)
  })

  test.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    'makes one attempt when attempts is %s, never looping',
    async attempts => {
      const work = vi.fn(async () => {
        throw new McpError('REMOTE_ERROR', 'x', { retryable: true })
      })
      await expect(
        retryRead(work, { attempts: attempts as number, isTransient: () => true, sleep: async () => {} })
      ).rejects.toMatchObject({ code: 'REMOTE_ERROR' })
      expect(work).toHaveBeenCalledTimes(1)
    }
  )

  test('says the failed read changed nothing without claiming the call changed nothing', async () => {
    const failure = await retryRead(
      async () => {
        throw new McpError('REMOTE_ERROR', 'x', { retryable: true })
      },
      { attempts: 2, isTransient: () => true, sleep: async () => {} }
    ).catch((error: unknown) => error as McpError)
    expect(failure.message).toMatch(/the read itself changed nothing/u)
    expect(failure.message).not.toMatch(/Nothing was changed/u)
  })

  test('caps attempts at three', async () => {
    const work = vi.fn(async () => {
      throw new McpError('REMOTE_ERROR', 'x', { retryable: true })
    })
    await expect(
      retryRead(work, { attempts: 10, isTransient: () => true, sleep: async () => {} })
    ).rejects.toMatchObject({
      code: 'TRANSIENT_FAILURE',
      details: { attempts: 3 },
    })
    expect(work).toHaveBeenCalledTimes(3)
  })

  test.each([
    [new McpError('TRANSIENT_FAILURE', 'x', { retryable: true, details: { reason: 'retry' } }), true],
    [new McpError('REMOTE_ERROR', 'x', { retryable: true, details: { reason: 'disconnected' } }), true],
    [new McpError('REMOTE_ERROR', 'x', { details: { reason: 'unrecognized' } }), false],
    [new McpError('RATE_LIMITED', 'x', { retryable: true }), false],
    [new McpError('TIMEOUT', 'x'), false],
    [new McpError('AUTH_EXPIRED', 'x'), false],
  ])('treats a join failure %# as transient: %s', (error, transient) => {
    expect(isTransientJoinFailure(error)).toBe(transient)
  })
})
