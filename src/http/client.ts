import { STATUS_CODES } from 'node:http'

import type { CookieJar } from 'tough-cookie'

import { AUTH_LOGIN_INSTRUCTION, McpError } from '../core/errors.js'
import { defaultSleep, retryRead, type Sleep } from '../core/retry.js'
import { USER_AGENT } from '../version.js'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

export interface HttpClientOptions {
  baseUrl: string
  jar: CookieJar
  fetcher?: Fetcher
  defaultTimeoutMs?: number
  csrfToken?: () => string | undefined
  persistSetCookies?: (url: string, values: string[]) => Promise<void>
  /** Attempts of a GET or HEAD after a network failure or HTTP 5xx, 1 to 3; 1, the default, never retries. */
  readAttempts?: number
  /** The least time between the starts of two requests from this client; 0, the default, paces nothing. */
  minRequestIntervalMs?: number
  sleep?: Sleep
}

export interface RequestOptions {
  timeoutMs?: number
  headers?: HeadersInit
  signal?: AbortSignal
}

/**
 * Overleaf identifies rejected requests with a short lowercase code, for example
 * `duplicate_file_name`. Only a value matching that shape is propagated, so no response
 * content or free text can reach a caller through an error.
 */
export const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u

const MIME_TYPE_PATTERN = /^[a-z]+\/[a-z0-9.+-]{1,64}$/u

/**
 * Parses a JSON body, or fails with `PROTOCOL_UNSUPPORTED` carrying only the path and a
 * MIME-shaped content type, so a page Overleaf sent instead is never quoted in an error.
 */
async function parseJsonBody(response: Response, path: string, emptyValue?: unknown): Promise<unknown> {
  const text = await response.text()
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (emptyValue !== undefined) {
    if (text === '') return emptyValue
    // Express's res.sendStatus answers with the bare status text, `OK` for 200, and no data.
    if (contentType === 'text/plain' && text === STATUS_CODES[response.status]) return emptyValue
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new McpError('PROTOCOL_UNSUPPORTED', 'Overleaf returned a response that is not JSON.', {
      details: {
        path,
        ...(contentType !== undefined && MIME_TYPE_PATTERN.test(contentType) ? { contentType } : {}),
      },
      cause: error,
    })
  }
}

async function safeErrorCode(response: Response): Promise<string | undefined> {
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
    return undefined
  }
  try {
    const body: unknown = JSON.parse((await response.text()).slice(0, 2048))
    const code = (body as { error?: unknown } | null)?.error
    return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

/** `Retry-After` is either whole seconds or an HTTP date; anything else yields no hint. */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined
  const trimmed = header.trim()
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

function redirectTarget(response: Response, from: URL): URL | undefined {
  const location = response.headers.get('location')
  if (location === null) return undefined
  try {
    return new URL(location, from)
  } catch {
    return undefined
  }
}

function responseSetCookies(headers: Headers): string[] {
  const enhanced = headers as Headers & { getSetCookie?: () => string[] }
  if (enhanced.getSetCookie) return enhanced.getSetCookie()
  const value = headers.get('set-cookie')
  return value ? [value] : []
}

export class OverleafHttpClient {
  readonly baseUrl: string
  readonly jar: CookieJar
  readonly #fetcher: Fetcher
  readonly #defaultTimeoutMs: number
  readonly #csrfToken: (() => string | undefined) | undefined
  readonly #persistSetCookies: ((url: string, values: string[]) => Promise<void>) | undefined
  readonly #readAttempts: number
  readonly #minRequestIntervalMs: number
  readonly #sleep: Sleep
  #nextStartAt = 0

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/u, '')
    this.jar = options.jar
    this.#fetcher = options.fetcher ?? fetch
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000
    this.#csrfToken = options.csrfToken
    this.#persistSetCookies = options.persistSetCookies
    this.#readAttempts = options.readAttempts ?? 1
    this.#minRequestIntervalMs = options.minRequestIntervalMs ?? 0
    this.#sleep = options.sleep ?? defaultSleep
  }

  /**
   * Sends one request. A GET or HEAD that failed on the network or with HTTP 5xx is sent again
   * with backoff, up to `readAttempts` in all, and then fails with `TRANSIENT_FAILURE`. Nothing
   * else is ever sent twice: not a request that changes something, and not a read that timed out,
   * was rate-limited, or was refused.
   */
  async request(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<Response> {
    if (method !== 'GET' && method !== 'HEAD') return await this.#send(method, path, body, options)
    return await retryRead(async () => await this.#send(method, path, body, options), {
      attempts: this.#readAttempts,
      sleep: this.#sleep,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      isTransient: error =>
        error.code === 'REMOTE_ERROR' &&
        (error.details?.kind === 'network' ||
          (typeof error.details?.status === 'number' && error.details.status >= 500)),
      details: { path },
    })
  }

  /** Waits for this request's turn when requests are paced; each start books the next slot. */
  async #pace(): Promise<void> {
    if (this.#minRequestIntervalMs <= 0) return
    const now = Date.now()
    const startAt = Math.max(now, this.#nextStartAt)
    this.#nextStartAt = startAt + this.#minRequestIntervalMs
    if (startAt > now) await this.#sleep(startAt - now)
  }

  async #send(method: string, path: string, body: unknown, options: RequestOptions): Promise<Response> {
    const base = new URL(`${this.baseUrl}/`)
    const target = new URL(path, base)
    // A path that resolves elsewhere would carry the session cookie and CSRF token off Overleaf.
    if (target.origin !== base.origin) {
      throw new McpError('INVALID_ARGUMENT', 'Refusing a request outside OVERLEAF_BASE_URL; nothing was sent.', {
        details: { kind: 'cross_origin' },
      })
    }
    const url = target.href
    const mutating = !['GET', 'HEAD'].includes(method)
    const headers = new Headers(options.headers)
    const cookies = await this.jar.getCookieString(url)
    if (cookies) headers.set('cookie', cookies)
    headers.set('accept', 'application/json, text/plain, */*')
    headers.set('user-agent', USER_AGENT)
    if (body !== undefined && !(body instanceof FormData)) {
      headers.set('content-type', 'application/json')
    }
    if (mutating) {
      const csrf = this.#csrfToken?.()
      if (csrf) headers.set('x-csrf-token', csrf)
    }

    await this.#pace()
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? this.#defaultTimeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal

    let response: Response
    try {
      response = await this.#fetcher(url, {
        method,
        headers,
        signal,
        // fetch keeps x-csrf-token across a cross-origin redirect, so a mutation follows none.
        redirect: mutating ? 'manual' : 'follow',
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      })
    } catch (error) {
      if (signal.aborted) {
        throw new McpError('TIMEOUT', `Overleaf request timed out: ${method} ${path}`, {
          retryable: true,
          cause: error,
        })
      }
      throw new McpError('REMOTE_ERROR', `Overleaf request failed: ${method} ${path}`, {
        retryable: true,
        details: { kind: 'network' },
        cause: error,
      })
    }

    const setCookies = responseSetCookies(response.headers)
    for (const value of setCookies) await this.jar.setCookie(value, url)
    await this.#persistSetCookies?.(url, setCookies)

    const finalPath = response.url ? new URL(response.url).pathname : ''
    const redirect = mutating && response.status >= 300 && response.status < 400
    const location = redirect ? redirectTarget(response, target) : undefined
    const toLogin = location?.origin === base.origin && location.pathname.startsWith('/login')
    if (response.status === 401 || finalPath.startsWith('/login') || toLogin) {
      throw new McpError('AUTH_EXPIRED', `Overleaf authentication expired. ${AUTH_LOGIN_INSTRUCTION}`, {
        retryable: false,
      })
    }
    if (redirect) {
      throw new McpError(
        'REMOTE_ERROR',
        `Overleaf answered ${method} ${path} with a redirect, which a request that changes something never follows.`,
        { details: { status: response.status, path } }
      )
    }
    if (response.status === 403) {
      throw new McpError('PERMISSION_DENIED', 'Overleaf denied this operation.')
    }
    if (response.status === 404) {
      throw new McpError('NOT_FOUND', `Overleaf resource was not found: ${path}`)
    }
    if (response.status === 413) {
      throw new McpError(
        'UPDATE_TOO_LARGE',
        'Overleaf rejected the request as too large. Split it into smaller revisioned operations.'
      )
    }
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
      throw new McpError('RATE_LIMITED', 'Overleaf rate-limited this request. Wait before retrying.', {
        retryable: true,
        details: {
          status: 429,
          path,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      })
    }
    if (!response.ok) {
      const overleafError = await safeErrorCode(response)
      throw new McpError('REMOTE_ERROR', `Overleaf returned HTTP ${response.status}.`, {
        details: {
          status: response.status,
          path,
          ...(overleafError === undefined ? {} : { overleafError }),
        },
      })
    }
    return response
  }

  async getJson<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    const response = await this.request('GET', path, undefined, options)
    return (await parseJsonBody(response, path)) as T
  }

  async postJson<T = unknown>(path: string, body: unknown = {}, options?: RequestOptions): Promise<T> {
    const response = await this.request('POST', path, body, options)
    return (await parseJsonBody(response, path, {})) as T
  }

  async deleteJson<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    const response = await this.request('DELETE', path, undefined, options)
    return (await parseJsonBody(response, path, {})) as T
  }

  async getBytes(path: string, options?: RequestOptions): Promise<Uint8Array> {
    const response = await this.request('GET', path, undefined, options)
    return new Uint8Array(await response.arrayBuffer())
  }

  /**
   * Starts a GET and hands back the body unread, for downloads too large to buffer. The request
   * timeout keeps running while the caller reads, so it bounds the whole transfer.
   */
  async getStream(
    path: string,
    options?: RequestOptions
  ): Promise<{ body: ReadableStream<Uint8Array>; contentType?: string }> {
    const response = await this.request('GET', path, undefined, options)
    const contentType = response.headers.get('content-type') ?? undefined
    const body = response.body ?? new Response(new Uint8Array()).body!
    return { body, ...(contentType === undefined ? {} : { contentType }) }
  }

  async postForm<T = unknown>(path: string, form: FormData, options?: RequestOptions): Promise<T> {
    const response = await this.request('POST', path, form, options)
    return (await parseJsonBody(response, path, {})) as T
  }
}
