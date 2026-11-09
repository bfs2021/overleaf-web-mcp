import { delimiter, isAbsolute } from 'node:path'

import { McpError } from './core/errors.js'
import { MAX_READ_ATTEMPTS } from './core/retry.js'
import { resolveAuthPaths } from './auth/paths.js'
import { EFFECTS, type Effect } from './contracts/effects.js'
import { resolveProxyUrl } from './http/proxy.js'

export interface AppConfig {
  baseUrl: string
  cookieJarFile: string
  browserPath?: string
  browserProfileDir: string
  loginTimeoutMs: number
  maxDocLength: number
  maxUpdateChars: number
  socketCacheSize: number
  socketIdleTtlMs: number
  requestTimeoutMs: number
  applyTimeoutMs: number
  recoveryTimeoutMs: number
  compileTimeoutMs: number
  /** Attempts of a read after a transient failure, 1 to 3; writes are never retried. */
  readAttempts: number
  /** The least time between the starts of two REST requests; 0 paces nothing. */
  minRequestIntervalMs: number
  supportedProtocolVersions: number[]
  /** Proxy for every connection to `baseUrl`; absent to connect directly. */
  proxyUrl?: string
  /** Projects any operation may touch; absent allows every project the account can access. */
  allowedProjects?: string[]
  /** Folders local reads must stay inside; absent allows any path the process can read. */
  localReadRoots?: string[]
  /** Folders local writes must stay inside; absent allows any path but the saved session's files. */
  localWriteRoots?: string[]
  /** Effects operations may have; absent allows every effect. */
  allowedEffects?: Effect[]
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new McpError('INVALID_ARGUMENT', `${name} must be a positive integer.`)
  }
  return parsed
}

function nonNegativeInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new McpError('INVALID_ARGUMENT', `${name} must be zero or a positive integer.`)
  }
  return parsed
}

/** A comma-separated list, or `undefined` when the variable is unset or empty. */
function list(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const values = raw.split(',').map(value => value.trim())
  if (values.some(value => value === '')) {
    throw new McpError('INVALID_ARGUMENT', `${name} must be a comma-separated list without empty entries.`)
  }
  return values
}

/** Absolute folders separated by the platform path delimiter, `:` on POSIX and `;` on Windows. */
function roots(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const values = raw.split(delimiter).filter(value => value !== '')
  if (values.some(value => !isAbsolute(value))) {
    throw new McpError('INVALID_ARGUMENT', `${name} must list absolute folder paths separated by "${delimiter}".`)
  }
  return values
}

function effects(env: NodeJS.ProcessEnv, name: string): Effect[] | undefined {
  const values = list(env, name)
  if (values === undefined) return undefined
  const known = new Set<string>(EFFECTS)
  if (values.some(value => !known.has(value))) {
    throw new McpError('INVALID_ARGUMENT', `${name} may only list these effects: ${EFFECTS.join(', ')}.`)
  }
  return values as Effect[]
}

export interface ConfigContext {
  platform?: NodeJS.Platform
  homeDir?: string
}

export function readConfig(env: NodeJS.ProcessEnv = process.env, context: ConfigContext = {}): AppConfig {
  const authPaths = resolveAuthPaths({ env, ...context })
  const cookieJarFile = env.OVERLEAF_COOKIE_JAR_FILE ?? authPaths.cookieJarFile

  let baseUrl: URL
  try {
    baseUrl = new URL(env.OVERLEAF_BASE_URL ?? 'https://www.overleaf.com')
  } catch (error) {
    throw new McpError('INVALID_ARGUMENT', 'OVERLEAF_BASE_URL is invalid.', { cause: error })
  }
  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
    throw new McpError('INVALID_ARGUMENT', 'OVERLEAF_BASE_URL must use HTTP or HTTPS.')
  }

  const supportedProtocolVersions = (env.OVERLEAF_PROTOCOL_VERSIONS ?? '2')
    .split(',')
    .map(value => Number(value.trim()))
  if (supportedProtocolVersions.some(value => !Number.isSafeInteger(value))) {
    throw new McpError('INVALID_ARGUMENT', 'OVERLEAF_PROTOCOL_VERSIONS must be integers.')
  }

  const proxyUrl = resolveProxyUrl(baseUrl, env)
  const allowedProjects = list(env, 'OVERLEAF_ALLOWED_PROJECTS')
  const localReadRoots = roots(env, 'OVERLEAF_LOCAL_READ_ROOTS')
  const localWriteRoots = roots(env, 'OVERLEAF_LOCAL_WRITE_ROOTS')
  const allowedEffects = effects(env, 'OVERLEAF_ALLOWED_EFFECTS')

  return {
    baseUrl: baseUrl.href.replace(/\/$/u, ''),
    cookieJarFile,
    ...(env.OVERLEAF_BROWSER_PATH ? { browserPath: env.OVERLEAF_BROWSER_PATH } : {}),
    browserProfileDir: env.OVERLEAF_BROWSER_PROFILE_DIR ?? authPaths.browserProfileDir,
    loginTimeoutMs: Math.min(positiveInteger(env, 'OVERLEAF_LOGIN_TIMEOUT_MS', 5 * 60_000), 15 * 60_000),
    maxDocLength: positiveInteger(env, 'OVERLEAF_MAX_DOC_LENGTH', 2 * 1024 * 1024),
    maxUpdateChars: positiveInteger(env, 'OVERLEAF_MAX_UPDATE_CHARS', 7 * 1024 * 1024),
    socketCacheSize: positiveInteger(env, 'OVERLEAF_SOCKET_CACHE_SIZE', 2),
    socketIdleTtlMs: positiveInteger(env, 'OVERLEAF_SOCKET_IDLE_TTL_MS', 90_000),
    requestTimeoutMs: positiveInteger(env, 'OVERLEAF_REQUEST_TIMEOUT_MS', 30_000),
    applyTimeoutMs: positiveInteger(env, 'OVERLEAF_APPLY_TIMEOUT_MS', 30_000),
    recoveryTimeoutMs: positiveInteger(env, 'OVERLEAF_RECOVERY_TIMEOUT_MS', 30_000),
    compileTimeoutMs: Math.min(positiveInteger(env, 'OVERLEAF_COMPILE_TIMEOUT_MS', 120_000), 15 * 60_000),
    readAttempts: Math.min(positiveInteger(env, 'OVERLEAF_READ_ATTEMPTS', MAX_READ_ATTEMPTS), MAX_READ_ATTEMPTS),
    minRequestIntervalMs: Math.min(nonNegativeInteger(env, 'OVERLEAF_MIN_REQUEST_INTERVAL_MS', 0), 60_000),
    supportedProtocolVersions,
    ...(proxyUrl === undefined ? {} : { proxyUrl }),
    ...(allowedProjects === undefined ? {} : { allowedProjects }),
    ...(localReadRoots === undefined ? {} : { localReadRoots }),
    ...(localWriteRoots === undefined ? {} : { localWriteRoots }),
    ...(allowedEffects === undefined ? {} : { allowedEffects }),
  }
}
