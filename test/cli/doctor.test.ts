import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { DOCTOR_CHECK_IDS, type DoctorReport } from '../../src/cli/doctor.js'
import { runCommandLine, type CliIo } from '../../src/cli/run.js'
import { FakeOverleafSocket } from '../helpers/overleaf-socket.js'

const PROJECT = '0123456789abcdef01234567'

async function sessionEnv(extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(join(tmpdir(), 'overleaf-doctor-'))
  const cookiePath = join(directory, 'cookies.txt')
  await writeFile(
    cookiePath,
    '# Netscape HTTP Cookie File\n.overleaf.test\tTRUE\t/\tTRUE\t2147483647\toverleaf.sid\tsession\n'
  )
  if (process.platform !== 'win32') await chmod(cookiePath, 0o600)
  return { OVERLEAF_COOKIE_JAR_FILE: cookiePath, OVERLEAF_BASE_URL: 'https://overleaf.test', ...extra }
}

interface FakeOptions {
  page?: string
  protocolVersion?: number
  rootDoc?: boolean
  /** The Socket.IO handshake's answer. */
  handshake?: () => Response
  /** Replaces the joinProjectResponse payload. */
  join?: unknown
}

function fakeOverleaf(options: FakeOptions = {}) {
  const sockets: FakeOverleafSocket[] = []
  const requests: string[] = []
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    if (url.pathname === '/project') {
      return new Response(
        options.page ?? '<meta name="ol-csrfToken" content="csrf"><meta name="ol-user_id" content="user">'
      )
    }
    if (url.pathname === '/api/project') {
      return new Response(
        JSON.stringify({ totalSize: 1, projects: [{ _id: PROJECT, name: 'Paper', accessLevel: 'owner' }] }),
        {
          headers: { 'content-type': 'application/json' },
        }
      )
    }
    if (url.pathname === '/socket.io/1/') return options.handshake?.() ?? new Response('SESSION:60:60:websocket')
    return new Response('', { status: 404 })
  }
  const webSocketFactory = () => {
    const socket = new FakeOverleafSocket({ content: 'text', version: 1 }, () => {
      throw new Error('doctor must never apply an update')
    })
    socket.readyState = 0
    sockets.push(socket)
    setImmediate(() => {
      socket.readyState = 1
      socket.emit('open')
      socket.emitEvent('joinProjectResponse', [
        'join' in options
          ? options.join
          : {
              publicId: 'P.client',
              project: {
                _id: PROJECT,
                ...(options.rootDoc === false ? {} : { rootDoc_id: 'doc' }),
                rootFolder: [
                  {
                    _id: 'root',
                    name: 'rootFolder',
                    docs: [{ _id: 'doc', name: 'main.tex' }],
                    fileRefs: [],
                    folders: [],
                  },
                ],
              },
              permissionsLevel: 'owner',
              protocolVersion: options.protocolVersion ?? 2,
            },
      ])
    })
    return socket
  }
  return { sockets, requests, dependencies: { fetcher, webSocketFactory } }
}

async function doctor(argv: string[], env: NodeJS.ProcessEnv, fake: ReturnType<typeof fakeOverleaf>) {
  let stdout = ''
  let stderr = ''
  const io: CliIo = {
    stdout: text => {
      stdout += text
    },
    stderr: text => {
      stderr += text
    },
    readStdin: async () => await Promise.resolve(new Uint8Array()),
  }
  const exitCode = await runCommandLine(['doctor', ...argv], io, { env, doctor: fake.dependencies })
  return { exitCode, stdout, stderr, report: stdout === '' ? undefined : (JSON.parse(stdout) as DoctorReport) }
}

function statuses(report: DoctorReport | undefined): Record<string, string> {
  return Object.fromEntries((report?.checks ?? []).map(check => [check.id, check.status]))
}

describe('doctor', () => {
  test('exits 0 when every check passes, joins and leaves the root document, and sends no update', async () => {
    const fake = fakeOverleaf()
    const run = await doctor([PROJECT], await sessionEnv(), fake)

    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.report?.checks.map(check => check.id)).toEqual([...DOCTOR_CHECK_IDS])
    expect(new Set(Object.values(statuses(run.report)))).toEqual(new Set(['ok']))
    expect(fake.sockets[0]?.events).toEqual(['joinDoc', 'leaveDoc'])
    expect(fake.sockets[0]?.readyState).toBe(3)
    expect(fake.sockets.flatMap(socket => socket.events)).not.toContain('applyOtUpdate')
    expect(fake.requests.every(request => request.startsWith('GET ') || request === 'POST /api/project')).toBe(true)
    // Ids, statuses, and codes only: no project id, name, or path.
    expect(run.stdout).not.toContain(PROJECT)
    expect(run.stdout).not.toContain('Paper')
    expect(run.stdout).not.toContain('main.tex')
  })

  test('exits 1 with joinProject.protocolVersion unsupported for protocol version 3', async () => {
    const fake = fakeOverleaf({ protocolVersion: 3 })
    const run = await doctor([PROJECT], await sessionEnv(), fake)

    expect(run.exitCode).toBe(1)
    expect(run.report?.checks).toContainEqual({
      id: 'joinProject.protocolVersion',
      status: 'unsupported',
      code: 'PROTOCOL_UNSUPPORTED',
    })
    expect(statuses(run.report)).toMatchObject({
      'socket.handshake': 'ok',
      joinProject: 'ok',
      'joinDoc.rootDocument': 'skipped',
    })
    expect(fake.sockets.flatMap(socket => socket.events)).toEqual([])
    expect(fake.sockets[0]?.readyState).toBe(3)
  })

  test.each([
    ['a join without its project', { join: { publicId: 'P', permissionsLevel: 'owner', protocolVersion: 2 } }],
    ['an empty join', { join: null }],
  ])('reports %s as joinProject unsupported and closes the socket', async (_name, options) => {
    const fake = fakeOverleaf(options)
    const run = await doctor([PROJECT], await sessionEnv(), fake)

    expect(run.exitCode).toBe(1)
    expect(run.report?.checks).toContainEqual({
      id: 'joinProject',
      status: 'unsupported',
      code: 'PROTOCOL_UNSUPPORTED',
    })
    expect(statuses(run.report)['socket.handshake']).toBe('ok')
    expect(fake.sockets[0]?.readyState).toBe(3)
  })

  test.each([
    [() => new Response('SESSION:60:60:xhr-polling'), 'unsupported', 'PROTOCOL_UNSUPPORTED'],
    [() => new Response('not a handshake'), 'unsupported', 'PROTOCOL_UNSUPPORTED'],
    [() => new Response('', { status: 502 }), 'failed', 'REMOTE_ERROR'],
  ])(
    'reports a handshake that answered %# as socket.handshake %s, opening no socket',
    async (handshake, status, code) => {
      const fake = fakeOverleaf({ handshake })
      const run = await doctor([PROJECT], await sessionEnv(), fake)

      expect(run.exitCode).toBe(1)
      expect(run.report?.checks).toContainEqual({ id: 'socket.handshake', status, code })
      expect(statuses(run.report).joinProject).toBe('skipped')
      expect(fake.sockets).toHaveLength(0)
    }
  )

  test.each([
    ['<meta name="ol-csrfToken" content=""><meta name="ol-user_id" content="user">', 'unsupported', 'ok'],
    ['<meta name="ol-csrfToken" content="csrf">', 'ok', 'unsupported'],
  ])('judges the bootstrap page %j as every command does', async (page, csrfStatus, userStatus) => {
    const fake = fakeOverleaf({ page })
    const run = await doctor([], await sessionEnv(), fake)

    expect(run.exitCode).toBe(1)
    expect(statuses(run.report)).toMatchObject({ 'bootstrap.csrfToken': csrfStatus, 'bootstrap.userId': userStatus })
  })

  test('refuses an environment variable it cannot read as a usage error, with no report', async () => {
    const fake = fakeOverleaf()
    const run = await doctor([], { ...(await sessionEnv()), OVERLEAF_REQUEST_TIMEOUT_MS: 'soon' }, fake)

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(run.stderr)).toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(fake.requests).toEqual([])
  })

  test('skips every socket check without a projectId', async () => {
    const fake = fakeOverleaf()
    const run = await doctor([], await sessionEnv(), fake)

    expect(run.exitCode).toBe(0)
    expect(fake.sockets).toHaveLength(0)
    expect(statuses(run.report)).toMatchObject({
      'api.projects': 'ok',
      'policy.project': 'skipped',
      'socket.handshake': 'skipped',
      joinProject: 'skipped',
      'joinProject.protocolVersion': 'skipped',
    })
  })

  test('reports a signed-in page without a CSRF token as unsupported', async () => {
    const fake = fakeOverleaf({ page: '<meta name="ol-user_id" content="user">' })
    const run = await doctor([], await sessionEnv(), fake)

    expect(run.exitCode).toBe(1)
    expect(run.report?.checks).toContainEqual({
      id: 'bootstrap.csrfToken',
      status: 'unsupported',
      code: 'PROTOCOL_UNSUPPORTED',
    })
    expect(statuses(run.report)['api.projects']).toBe('skipped')
  })

  test('reports a missing session as AUTH_EXPIRED and sends nothing', async () => {
    const fake = fakeOverleaf()
    const env = { ...(await sessionEnv()), OVERLEAF_COOKIE_JAR_FILE: join(tmpdir(), 'no-such-dir', 'cookies.txt') }
    const run = await doctor([], env, fake)

    expect(run.exitCode).toBe(1)
    expect(run.report?.checks).toContainEqual({ id: 'session.cookieJar', status: 'failed', code: 'AUTH_EXPIRED' })
    expect(fake.requests).toEqual([])
  })

  test('refuses a project outside the access policy before opening a socket', async () => {
    const fake = fakeOverleaf()
    const run = await doctor(
      [PROJECT],
      await sessionEnv({ OVERLEAF_ALLOWED_PROJECTS: 'abcdefabcdefabcdefabcdef' }),
      fake
    )

    expect(run.exitCode).toBe(1)
    expect(run.report?.checks).toContainEqual({ id: 'policy.project', status: 'failed', code: 'POLICY_DENIED' })
    expect(fake.sockets).toHaveLength(0)
  })

  test('skips the document checks when the project names no root document', async () => {
    const fake = fakeOverleaf({ rootDoc: false })
    const run = await doctor([PROJECT], await sessionEnv(), fake)

    expect(run.exitCode).toBe(0)
    expect(statuses(run.report)).toMatchObject({ joinProject: 'ok', 'joinDoc.rootDocument': 'skipped' })
  })

  test('refuses a projectId that is not path-safe as a usage error', async () => {
    const fake = fakeOverleaf()
    const run = await doctor(['../x'], await sessionEnv(), fake)

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(fake.requests).toEqual([])
  })
})
