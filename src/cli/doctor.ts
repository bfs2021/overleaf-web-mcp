import type { AppConfig } from '../config.js'
import { asMcpError } from '../core/errors.js'
import { AccessPolicy } from '../core/policy.js'
import { parseBootstrapMeta, requireCsrfToken } from '../http/bootstrap.js'
import { OverleafHttpClient } from '../http/client.js'
import { CookieStore } from '../http/cookies.js'
import { createProxyRoute } from '../http/proxy.js'
import { AccountApi } from '../overleaf/account.js'
import { openProjectConnection, type OpenProjectConnectionOptions } from '../protocol/connect.js'
import type { ProjectConnection } from '../protocol/project-connection.js'
import { SERVER_VERSION } from '../version.js'

/**
 * `ok` passed; `failed` did not, for the reason its `code` gives; `unsupported` means Overleaf
 * answered in a shape or protocol this release does not understand; `skipped` was not run, because
 * an earlier check failed or no projectId was given.
 */
export type DoctorStatus = 'ok' | 'failed' | 'unsupported' | 'skipped'

export const DOCTOR_CHECK_IDS = [
  'config',
  'session.cookieJar',
  'bootstrap.page',
  'bootstrap.csrfToken',
  'bootstrap.userId',
  'api.projects',
  'policy.project',
  'socket.handshake',
  'joinProject',
  'joinProject.protocolVersion',
  'joinDoc.rootDocument',
  'leaveDoc.rootDocument',
] as const

export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number]

export interface DoctorCheck {
  id: DoctorCheckId
  status: DoctorStatus
  code?: string
}

/** Names no project, file, or user: check ids, statuses, and error codes only. */
export interface DoctorReport {
  version: string
  checks: DoctorCheck[]
}

type Fetcher = NonNullable<OpenProjectConnectionOptions['fetcher']>

export interface DoctorDependencies {
  fetcher?: Fetcher
  webSocketFactory?: OpenProjectConnectionOptions['webSocketFactory']
}

function failure(id: DoctorCheckId, error: unknown): DoctorCheck {
  const { code } = asMcpError(error)
  return { id, status: code === 'PROTOCOL_UNSUPPORTED' ? 'unsupported' : 'failed', code }
}

function skipRest(checks: DoctorCheck[]): DoctorReport {
  const seen = new Set(checks.map(check => check.id))
  return {
    version: SERVER_VERSION,
    checks: [
      ...checks,
      ...DOCTOR_CHECK_IDS.filter(id => !seen.has(id)).map(id => ({ id, status: 'skipped' as const })),
    ],
  }
}

/**
 * Checks, read-only, that this install can reach Overleaf: the saved session, the bootstrap page,
 * the project list, and, with a projectId, the collaboration handshake, `joinProject` and its
 * protocol version, and a join and leave of the root document. Nothing is ever written: no OT
 * update, upload, or other mutation is sent. Joining the project shows the account online to
 * collaborators until the socket closes, which it does before this returns. Reads are tried once,
 * so a transient failure is reported as it is.
 */
export async function runDoctor(
  config: AppConfig,
  projectId: string | undefined,
  dependencies: DoctorDependencies = {}
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []
  let policy: AccessPolicy
  try {
    policy = await AccessPolicy.create({
      allowedProjects: config.allowedProjects,
      localReadRoots: config.localReadRoots,
      localWriteRoots: config.localWriteRoots,
      allowedEffects: config.allowedEffects,
      cookieJarFile: config.cookieJarFile,
      browserProfileDir: config.browserProfileDir,
    })
    policy.assertEffect('overleaf-read')
    checks.push({ id: 'config', status: 'ok' })
  } catch (error) {
    checks.push(failure('config', error))
    return skipRest(checks)
  }

  let cookieStore: CookieStore
  try {
    cookieStore = await CookieStore.load(config.cookieJarFile)
    checks.push({ id: 'session.cookieJar', status: 'ok' })
  } catch (error) {
    checks.push(failure('session.cookieJar', error))
    return skipRest(checks)
  }

  const proxy = config.proxyUrl === undefined ? undefined : createProxyRoute(config.proxyUrl)
  const fetcher = dependencies.fetcher ?? proxy?.fetcher
  try {
    const csrf = { token: undefined as string | undefined }
    const http = new OverleafHttpClient({
      baseUrl: config.baseUrl,
      jar: cookieStore.jar,
      defaultTimeoutMs: config.requestTimeoutMs,
      minRequestIntervalMs: config.minRequestIntervalMs ?? 0,
      csrfToken: () => csrf.token,
      ...(fetcher === undefined ? {} : { fetcher }),
    })

    let userId: string | undefined
    try {
      const page = await http.request('GET', '/project')
      const bootstrap = parseBootstrapMeta(await page.text())
      checks.push({ id: 'bootstrap.page', status: 'ok' })
      // The same check every other command makes before it starts.
      let token: string | undefined
      try {
        token = requireCsrfToken(bootstrap)
        checks.push({ id: 'bootstrap.csrfToken', status: 'ok' })
      } catch (error) {
        checks.push(failure('bootstrap.csrfToken', error))
      }
      checks.push(
        bootstrap.userId !== undefined
          ? { id: 'bootstrap.userId', status: 'ok' }
          : token === undefined
            ? { id: 'bootstrap.userId', status: 'failed', code: 'AUTH_EXPIRED' }
            : // A page with a token and no user is a shape change; tracked writes refuse it.
              { id: 'bootstrap.userId', status: 'unsupported', code: 'PROTOCOL_UNSUPPORTED' }
      )
      if (token === undefined) return skipRest(checks)
      csrf.token = token
      userId = bootstrap.userId
    } catch (error) {
      checks.push(failure('bootstrap.page', error))
      return skipRest(checks)
    }

    try {
      await new AccountApi(http, policy).fetchProjects()
      checks.push({ id: 'api.projects', status: 'ok' })
    } catch (error) {
      checks.push(failure('api.projects', error))
    }

    if (projectId === undefined) return skipRest(checks)
    try {
      policy.assertProject(projectId)
      checks.push({ id: 'policy.project', status: 'ok' })
    } catch (error) {
      checks.push(failure('policy.project', error))
      return skipRest(checks)
    }

    // Set only once the handshake answered with a session that offers the websocket transport.
    let handshakeAnswered = false
    let connection: ProjectConnection
    try {
      connection = await openProjectConnection({
        baseUrl: config.baseUrl,
        projectId,
        jar: cookieStore.jar,
        supportedProtocolVersions: config.supportedProtocolVersions,
        timeoutMs: config.requestTimeoutMs,
        onHandshake: () => {
          handshakeAnswered = true
        },
        ...(fetcher === undefined ? {} : { fetcher }),
        ...(userId === undefined ? {} : { currentUserId: userId }),
        ...(dependencies.webSocketFactory === undefined ? {} : { webSocketFactory: dependencies.webSocketFactory }),
        ...(proxy === undefined ? {} : { webSocketAgent: proxy.webSocketAgent }),
      })
    } catch (error) {
      const failed = asMcpError(error)
      if (!handshakeAnswered) {
        checks.push(failure('socket.handshake', failed))
        return skipRest(checks)
      }
      checks.push({ id: 'socket.handshake', status: 'ok' })
      // The connection refuses a protocol version it does not speak after joinProject answered.
      if (failed.code === 'PROTOCOL_UNSUPPORTED' && typeof failed.details?.actual === 'number') {
        checks.push({ id: 'joinProject', status: 'ok' })
        checks.push({ id: 'joinProject.protocolVersion', status: 'unsupported', code: 'PROTOCOL_UNSUPPORTED' })
      } else {
        checks.push(failure('joinProject', failed))
      }
      return skipRest(checks)
    }

    try {
      checks.push({ id: 'socket.handshake', status: 'ok' })
      checks.push({ id: 'joinProject', status: 'ok' })
      checks.push({ id: 'joinProject.protocolVersion', status: 'ok' })
      const rootDocId = connection.rootDocId
      if (rootDocId === undefined) return skipRest(checks)
      try {
        await connection.withDocument(rootDocId, async () => await Promise.resolve())
        checks.push({ id: 'joinDoc.rootDocument', status: 'ok' })
        checks.push({ id: 'leaveDoc.rootDocument', status: 'ok' })
      } catch (error) {
        const failed = asMcpError(error)
        if (failed.code === 'PARTIAL_CLEANUP') {
          // withDocument reports a document it joined but could not leave this way.
          checks.push({ id: 'joinDoc.rootDocument', status: 'ok' })
          checks.push({ id: 'leaveDoc.rootDocument', status: 'failed', code: failed.code })
        } else {
          checks.push(failure('joinDoc.rootDocument', failed))
        }
      }
      return skipRest(checks)
    } finally {
      connection.close()
    }
  } finally {
    await proxy?.close()
  }
}

/** Exit 0 when nothing failed or was unsupported; 1 otherwise. */
export function doctorExitCode(report: DoctorReport): number {
  return report.checks.some(check => check.status === 'failed' || check.status === 'unsupported') ? 1 : 0
}
