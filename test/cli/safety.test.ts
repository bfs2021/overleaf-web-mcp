import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import type * as BrowserLogin from '../../src/auth/browser-login.js'

vi.mock('../../src/auth/browser-login.js', async importOriginal => ({
  ...(await importOriginal<typeof BrowserLogin>()),
  captureBrowserSession: vi.fn(async () => {
    throw new Error('A browser was opened.')
  }),
}))

import { captureBrowserSession } from '../../src/auth/browser-login.js'
import { runLoginCommand } from '../../src/auth/login-command.js'
import { ALIASES } from '../../src/cli/commands.js'
import { runCommandLine, type CliIo, type CliRuntime } from '../../src/cli/run.js'
import { readConfig } from '../../src/config.js'
import { OPERATION_NAMES, type OperationName } from '../../src/contracts/operations.js'
import { McpError } from '../../src/core/errors.js'
import { OverleafRuntime } from '../../src/runtime.js'
import { fakeServiceRuntime } from '../helpers/fake-runtime.js'
import { INPUTS } from '../helpers/operation-inputs.js'
import { BOOTSTRAP_PAGE, createTestRuntime } from '../helpers/runtime.js'

/** The session cookie's value in the jar every real runtime here loads. */
const COOKIE = 'cookie-sentinel-3b7e5a9d0c'
/** The body of a review comment reply, and of an added comment. */
const COMMENT = 'COMMENT-BODY-SENTINEL-61af'
/** Document text, sent through stdin, a content file, or a request. */
const DOCUMENT = 'DOCUMENT-SENTINEL-c40e'
/** The name of a local file a sync uploads; progress messages are counts only. */
const FILENAME = 'filename-sentinel-77d2.tex'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

// Named while the file is collected, since test.each builds every command line, paths included, then;
// made in beforeAll, so collecting the file without running it leaves nothing behind.
const base = join(tmpdir(), `overleaf-cli-safety-${randomUUID()}`)
const jar = join(base, 'cookies.txt')
const local = join(base, 'local')
const out = join(base, 'out')
const cleanup: string[] = [base]

beforeAll(async () => {
  await mkdir(base, { mode: 0o700 })
  await writeFile(
    jar,
    `# Netscape HTTP Cookie File\n.overleaf.test\tTRUE\t/\tTRUE\t2147483647\toverleaf.sid\t${COOKIE}\n`
  )
  if (process.platform !== 'win32') await chmod(jar, 0o600)
  await mkdir(local)
  await mkdir(out)
  await writeFile(join(local, 'main.tex'), DOCUMENT)
  await writeFile(join(local, FILENAME), `${DOCUMENT} in a second file`)
})

afterAll(async () => {
  await Promise.all(cleanup.map(async folder => await rm(folder, { recursive: true, force: true })))
})

/** Each input with its local paths moved into this test's folders and its text replaced by sentinels. */
function callInput(name: OperationName): Record<string, unknown> {
  const moved = JSON.parse(
    JSON.stringify(INPUTS[name], (_key, value: unknown) => {
      if (typeof value !== 'string' || !value.startsWith('/tmp/')) return value
      return value === '/tmp/paper' ? local : join(out, basename(value))
    })
  ) as Record<string, unknown>
  if (name === 'reply_to_comment' || name === 'add_comment') moved.content = COMMENT
  if (name === 'write_file' || name === 'write_section') moved.content = DOCUMENT
  if (name === 'create_file') moved.content = DOCUMENT
  return moved
}

interface Command {
  label: string
  argv: string[]
}

/** A representative command line for every alias, every operation through call, and the rest. */
function commands(): Command[] {
  const aliases: Command[] = [
    {
      label: 'projects list',
      argv: [
        'projects',
        'list',
        '--query',
        'Paper',
        '--limit',
        '5',
        '--sort',
        'name',
        '--include-archived',
        '--include-trashed',
      ],
    },
    { label: 'tree', argv: ['tree', 'p'] },
    { label: 'files read', argv: ['files', 'read', 'p', 'main.tex'] },
    {
      label: 'files write --stdin',
      argv: ['files', 'write', 'p', 'main.tex', '--revision', 'r', '--stdin', '--tracked'],
    },
    {
      label: 'files write --content-file',
      argv: ['files', 'write', 'p', 'main.tex', '--revision', 'r', '--content-file', join(local, 'main.tex')],
    },
    { label: 'files download', argv: ['files', 'download', 'p', 'main.tex', join(out, 'copy.tex'), '--overwrite'] },
    { label: 'sync plan', argv: ['sync', 'plan', 'p', local, '--verbose', '--progress'] },
    {
      label: 'sync apply',
      argv: ['sync', 'apply', 'p', local, '--mode', 'additive', '--unplanned', '--stop-on-error', '--progress'],
    },
    {
      label: 'compile run',
      argv: ['compile', 'run', 'p', '--draft', '--download', join(out, 'run.pdf'), '--overwrite'],
    },
    { label: 'compile log', argv: ['compile', 'log', 'p', '--build-ref', 'ref', '--tail', '20', '--errors-only'] },
    {
      label: 'compile download',
      argv: ['compile', 'download', 'p', join(out, 'build.pdf'), '--build-ref', 'ref', '--overwrite'],
    },
    { label: 'comments list', argv: ['comments', 'list', 'p', '--status', 'all', '--author', 'Ada'] },
    {
      label: 'tracked-changes list',
      argv: ['tracked-changes', 'list', 'p', '--file', 'main.tex', '--type', 'insert', '--limit', '5'],
    },
    {
      label: 'tracked-changes accept',
      argv: ['tracked-changes', 'accept', 'p', 'main.tex', '--revision', 'r', '--change', 'c', '--confirm-count', '1'],
    },
    {
      label: 'tracked-changes reject',
      argv: ['tracked-changes', 'reject', 'p', 'main.tex', '--revision', 'r', '--change', 'c', '--confirm-count', '1'],
    },
  ]
  const calls = OPERATION_NAMES.map(name => ({
    label: `call ${name}`,
    argv: ['call', name, '--json', JSON.stringify(callInput(name)), '--progress'],
  }))
  return [
    ...aliases,
    ...calls,
    { label: 'help', argv: ['files', '--help'] },
    { label: 'schema', argv: ['schema', 'reply_to_comment', '--input'] },
    { label: 'capabilities', argv: ['capabilities'] },
    { label: 'capabilities of a project', argv: ['capabilities', 'p'] },
  ]
}

async function cli(argv: string[], runtime: unknown, env: NodeJS.ProcessEnv = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  const io: CliIo = {
    stdout: text => {
      stdout.push(text)
    },
    stderr: text => {
      stderr.push(text)
    },
    readStdin: async () => Buffer.from(DOCUMENT, 'utf8'),
  }
  const createRuntime = vi.fn(async () => runtime as CliRuntime)
  const exitCode = await runCommandLine(argv, io, { env, createRuntime })
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join(''), createRuntime }
}

/** stderr holds no session cookie, comment body, document text, or file name from a progress line. */
function expectNothingLeaked(stderr: string, label: string): void {
  expect(stderr, label).not.toContain(COOKIE)
  expect(stderr, label).not.toContain(COMMENT)
  expect(stderr, label).not.toContain(DOCUMENT)
  for (const line of stderr.split('\n').filter(line => line !== '')) {
    const value = JSON.parse(line) as Record<string, unknown>
    if ('progress' in value) expect(line, label).not.toContain(FILENAME)
  }
}

const STYLES = ['server-error', 'json-error', 'unexpected-json', 'network'] as const
type Style = (typeof STYLES)[number]

/** What the request carried: its cookie header and its body, form fields and files included. */
async function sent(init: RequestInit | undefined): Promise<string> {
  const parts = [new Headers(init?.headers).get('cookie') ?? '']
  const body = init?.body
  if (typeof body === 'string') parts.push(body)
  if (body instanceof FormData) {
    for (const [, value] of body.entries()) parts.push(typeof value === 'string' ? value : await value.text())
  }
  return parts.join(' ')
}

/** An Overleaf that answers every request by echoing what it was sent, in one failure style. */
function reflecting(style: Style): Fetcher {
  return async (_input, init) => {
    const echo = await sent(init)
    switch (style) {
      case 'network':
        throw new Error(`socket hang up after sending ${echo}`)
      case 'server-error':
        return new Response(`Internal error while handling ${echo}`, {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        })
      case 'json-error':
        return Response.json({ error: echo, message: echo }, { status: 400 })
      case 'unexpected-json':
        return Response.json({ message: echo, content: echo, name: echo, error: echo })
    }
  }
}

const TIMEOUTS = {
  OVERLEAF_REQUEST_TIMEOUT_MS: '2000',
  OVERLEAF_APPLY_TIMEOUT_MS: '200',
  OVERLEAF_RECOVERY_TIMEOUT_MS: '200',
}

/** A real runtime with injected sockets, the seeded jar, and a reflecting Overleaf. */
async function socketRuntime(style: Style) {
  const env = { OVERLEAF_COOKIE_JAR_FILE: jar, ...TIMEOUTS }
  const test = await createTestRuntime({ env, fetcher: reflecting(style), documentLines: [DOCUMENT] })
  cleanup.push(test.directory)
  return { runtime: test.runtime, env }
}

/** A real runtime whose own socket handshake goes through the reflecting Overleaf, cookie and all. */
async function handshakeRuntime(style: Style) {
  const env = {
    OVERLEAF_COOKIE_JAR_FILE: jar,
    OVERLEAF_BASE_URL: 'https://overleaf.test',
    OVERLEAF_BROWSER_PROFILE_DIR: join(base, 'profile'),
    ...TIMEOUTS,
  }
  const reflect = reflecting(style)
  const runtime = await OverleafRuntime.create(readConfig(env), {
    fetcher: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if ((init?.method ?? 'GET') === 'GET' && url.pathname === '/project') return new Response(BOOTSTRAP_PAGE)
      return await reflect(input, init)
    },
    // Retries keep their attempts, without real waits between them.
    sleep: async () => await Promise.resolve(),
  })
  return { runtime, env }
}

describe('operation commands never open a browser or print a secret', () => {
  // Cleared, not reset: the mock keeps its throwing implementation, and each test sees only its own calls.
  afterEach(() => {
    vi.mocked(captureBrowserSession).mockClear()
  })

  test('the sweep covers every alias and every operation', () => {
    const lines = commands()
    for (const alias of ALIASES) {
      expect(
        lines.some(command => alias.words.every((word, index) => command.argv[index] === word)),
        alias.words.join(' ')
      ).toBe(true)
    }
    for (const name of OPERATION_NAMES)
      expect(
        lines.some(command => command.label === `call ${name}`),
        name
      ).toBe(true)
  })

  test('every local path in the sweep is inside its own temporary folder', () => {
    const paths = commands().flatMap(command =>
      command.argv.flatMap(arg =>
        arg.startsWith('{') ? (JSON.stringify(JSON.parse(arg)).match(/"\/[^"]*"/gu) ?? []) : [arg]
      )
    )
    const found = paths.map(path => path.replace(/^"|"$/gu, '')).filter(path => path.includes('/'))
    expect(found.length).toBeGreaterThan(10)
    for (const path of found) {
      expect(isAbsolute(path), path).toBe(true)
      expect(path.startsWith(`${base}/`), path).toBe(true)
    }
  })

  test.each(commands().map(command => [command.label, command]))('%s', async (_label, command) => {
    for (const fake of [fakeServiceRuntime(), fakeServiceRuntime()]) {
      const run = await cli(command.argv, fake)
      expectNothingLeaked(run.stderr, `${command.label} with a fake`)
    }
    const failing = fakeServiceRuntime()
    for (const mock of Object.values(failing).flatMap(value =>
      vi.isMockFunction(value) ? [value] : Object.values(value)
    )) {
      if (vi.isMockFunction(mock) && mock !== failing.close) {
        mock.mockRejectedValue(new McpError('TIMEOUT', 'Timed out.', { retryable: true }))
      }
    }
    expectNothingLeaked((await cli(command.argv, failing)).stderr, `${command.label} with a failing fake`)

    for (const style of STYLES) {
      for (const open of [socketRuntime, handshakeRuntime]) {
        const { runtime, env } = await open(style)
        const label = `${command.label}, ${style}, ${open.name}`
        const run = await cli(command.argv, runtime, env)
        expect(typeof run.exitCode, label).toBe('number')
        expectNothingLeaked(run.stderr, label)
        expect(run.stdout === '' || run.stderr === '' || run.stderr.includes('"progress"'), label).toBe(true)
      }
    }
    expect(captureBrowserSession).not.toHaveBeenCalled()
  })

  test('a reply whose post fails never prints its body or the cookie', async () => {
    for (const style of STYLES) {
      const reflect = reflecting(style)
      const env = { OVERLEAF_COOKIE_JAR_FILE: jar, ...TIMEOUTS }
      const live = await createTestRuntime({
        env,
        fetcher: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input))
          if ((init?.method ?? 'GET') === 'GET' && url.pathname === '/project/p/threads') {
            return Response.json({ t: { messages: [] } })
          }
          return await reflect(input, init)
        },
      })
      cleanup.push(live.directory)
      const run = await cli(
        ['call', 'reply_to_comment', '--json', JSON.stringify({ projectId: 'p', threadId: 't', content: COMMENT })],
        live.runtime,
        env
      )
      // The reply reached Overleaf, so the body was in a request the fake echoed back.
      expect(live.fetches, style).toContain('POST /project/p/thread/t/messages')
      expect(run.exitCode, style).not.toBe(0)
      expect(run.stdout, style).toBe('')
      expectNothingLeaked(run.stderr, style)
    }
    expect(captureBrowserSession).not.toHaveBeenCalled()
  })

  test('a refused request never quotes the comment body', async () => {
    const valid = { projectId: 'p', threadId: 't', content: COMMENT }
    for (const text of [
      JSON.stringify({ ...valid, contnet: COMMENT }),
      JSON.stringify({ ...valid, threadId: 7 }),
      JSON.stringify({ ...valid, content: [COMMENT] }),
      JSON.stringify(valid).slice(0, -1),
      JSON.stringify([valid]),
    ]) {
      const run = await cli(['call', 'reply_to_comment', '--json', text], fakeServiceRuntime())
      expect(run.exitCode, text).toBe(2)
      expect(run.createRuntime, text).not.toHaveBeenCalled()
      expectNothingLeaked(run.stderr, text)
    }
    expect(captureBrowserSession).not.toHaveBeenCalled()
  })

  test('the browser mock is the one the login command reaches', async () => {
    // Only login may open a browser; here it reaches the mock, so every other test here would have seen any call.
    await expect(
      runLoginCommand(
        readConfig({ OVERLEAF_COOKIE_JAR_FILE: join(base, 'unused.txt'), OVERLEAF_BASE_URL: 'https://overleaf.test' })
      )
    ).rejects.toThrow('A browser was opened.')
    expect(captureBrowserSession).toHaveBeenCalledTimes(1)
  })
})
