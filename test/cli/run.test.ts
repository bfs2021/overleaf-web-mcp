import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { runCommandLine, runOperationCommand, type CliIo, type CliRuntime } from '../../src/cli/run.js'
import { ALIASES } from '../../src/cli/commands.js'
import type { CapabilitiesReport } from '../../src/cli/capabilities.js'
import { ERROR_CODES, type ErrorCode } from '../../src/contracts/error-codes.js'
import { OPERATION_NAMES, OPERATIONS, type OperationName } from '../../src/contracts/operations.js'
import { McpError } from '../../src/core/errors.js'
import { createRevision } from '../../src/core/revision.js'
import type { RawFolder } from '../../src/overleaf/tree.js'
import { fakeServiceRuntime } from '../helpers/fake-runtime.js'
import { INPUTS } from '../helpers/operation-inputs.js'
import { OUTPUTS } from '../helpers/operation-outputs.js'
import { createTestRuntime, type TestRuntimeOptions } from '../helpers/runtime.js'

type FakeRuntime = ReturnType<typeof fakeServiceRuntime>
type Mock = ReturnType<typeof vi.fn>

const folders: string[] = []

async function temporaryFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'overleaf-cli-run-'))
  folders.push(folder)
  return folder
}

afterEach(async () => {
  await Promise.all(folders.splice(0).map(async folder => await rm(folder, { recursive: true, force: true })))
})

/** Records what a command writes. stdin, unless a test supplies it, fails the command if read. */
function recorder(stdin?: Uint8Array | string) {
  const stdoutWrites: string[] = []
  const stderrWrites: string[] = []
  const readStdin = vi.fn(async (): Promise<Uint8Array> => {
    if (stdin === undefined) throw new Error('stdin was read by a command that takes no stdin')
    return typeof stdin === 'string' ? Buffer.from(stdin, 'utf8') : stdin
  })
  const io: CliIo = {
    stdout: text => {
      stdoutWrites.push(text)
    },
    stderr: text => {
      stderrWrites.push(text)
    },
    readStdin,
  }
  return { io, stdoutWrites, stderrWrites, readStdin }
}

interface CliRun {
  exitCode: number | 'legacy'
  stdout: string
  stderr: string
  stdoutWrites: string[]
  createRuntime: Mock
  readStdin: Mock
}

interface CliOptions {
  runtime?: unknown
  stdin?: Uint8Array | string
  env?: NodeJS.ProcessEnv
}

/** Runs one command line in process, on the given runtime (a fake one by default). */
async function cli(argv: string[], options: CliOptions = {}): Promise<CliRun> {
  const runtime = (options.runtime ?? fakeServiceRuntime()) as CliRuntime
  const createRuntime = vi.fn(async () => runtime)
  const recorded = recorder(options.stdin)
  const exitCode = await runCommandLine(argv, recorded.io, { env: options.env ?? {}, createRuntime })
  return {
    exitCode,
    stdout: recorded.stdoutWrites.join(''),
    stderr: recorded.stderrWrites.join(''),
    stdoutWrites: recorded.stdoutWrites,
    createRuntime,
    readStdin: recorded.readStdin,
  }
}

/** Exactly one JSON value on stdout and nothing on stderr. */
function expectResult(run: CliRun): any {
  expect(run.stderr).toBe('')
  expect(run.stdoutWrites).toHaveLength(1)
  expect(run.stdout.endsWith('\n')).toBe(true)
  return JSON.parse(run.stdout)
}

interface ErrorLine {
  code: ErrorCode
  message: string
  retryable: boolean
  details?: Record<string, any>
}

/** stdout empty, and exactly one stderr line holding `{ code, message, retryable, details? }`. */
function expectError(run: CliRun): ErrorLine {
  expect(run.stdout).toBe('')
  const lines = run.stderr.split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toBe('')
  const error = JSON.parse(lines[0]!) as ErrorLine
  const keys = Object.keys(error)
  expect(keys.filter(key => key !== 'details').sort()).toEqual(['code', 'message', 'retryable'])
  expect(keys.every(key => ['code', 'message', 'retryable', 'details'].includes(key))).toBe(true)
  expect(typeof error.message).toBe('string')
  expect(typeof error.retryable).toBe('boolean')
  if ('details' in error) expect(typeof error.details).toBe('object')
  return error
}

/** Every mock of a fake runtime, so a test can show none was called. */
function mocks(value: unknown): Mock[] {
  if (vi.isMockFunction(value)) return [value as Mock]
  if (typeof value !== 'object' || value === null) return []
  return Object.values(value).flatMap(mocks)
}

/** Makes every domain method of a fake reject with `error`, so any operation fails with it. */
function rejectAll(fake: FakeRuntime, error: McpError): FakeRuntime {
  for (const mock of mocks(fake)) {
    if (mock !== fake.close) mock.mockRejectedValue(error)
  }
  return fake
}

function callCommand(name: OperationName, input: Record<string, unknown> = INPUTS[name]) {
  return {
    kind: 'call' as const,
    tool: name,
    request: { from: 'json' as const, text: JSON.stringify(input) },
    progress: false,
  }
}

/** Runs `call <name>` through `runOperationCommand` on a fake runtime. */
async function runCall(name: OperationName, fake: FakeRuntime, input?: Record<string, unknown>): Promise<CliRun> {
  const createRuntime = vi.fn(async () => fake as unknown as CliRuntime)
  const recorded = recorder()
  const exitCode = await runOperationCommand(callCommand(name, input), recorded.io, { env: {}, createRuntime })
  return {
    exitCode,
    stdout: recorded.stdoutWrites.join(''),
    stderr: recorded.stderrWrites.join(''),
    stdoutWrites: recorded.stdoutWrites,
    createRuntime,
    readStdin: recorded.readStdin,
  }
}

/**
 * The exit code of each error code with no outcome, from a write and from a read, written out
 * here rather than taken from exitCodeForError so the command line is held to the documented table.
 */
const EXIT_TABLE: Record<ErrorCode, { write: number; read: number }> = {
  AUTH_EXPIRED: { write: 3, read: 3 },
  PERMISSION_DENIED: { write: 3, read: 3 },
  POLICY_DENIED: { write: 3, read: 3 },
  INVALID_ARGUMENT: { write: 2, read: 2 },
  CONFIRMATION_MISMATCH: { write: 2, read: 2 },
  PATH_OUTSIDE_ROOT: { write: 2, read: 2 },
  REVISION_CONFLICT: { write: 4, read: 4 },
  REMOTE_DRIFT: { write: 4, read: 4 },
  OUTCOME_UNKNOWN: { write: 5, read: 5 },
  TIMEOUT: { write: 5, read: 7 },
  RATE_LIMITED: { write: 7, read: 7 },
  COMPILE_RATE_LIMITED: { write: 7, read: 7 },
  COMPILE_UNAVAILABLE: { write: 7, read: 7 },
  NOT_FOUND: { write: 1, read: 1 },
  PROTOCOL_UNSUPPORTED: { write: 1, read: 1 },
  UPDATE_TOO_LARGE: { write: 1, read: 1 },
  DOC_TOO_LARGE: { write: 1, read: 1 },
  COMPILE_FAILED: { write: 1, read: 1 },
  COMPILE_TIMEOUT: { write: 1, read: 1 },
  NO_BUILD: { write: 1, read: 1 },
  BUILD_NOT_FOUND: { write: 1, read: 1 },
  PARTIAL_CLEANUP: { write: 1, read: 1 },
  REMOTE_ERROR: { write: 1, read: 1 },
  REVIEW_UNSUPPORTED: { write: 3, read: 3 },
  INCLUDE_CYCLE: { write: 1, read: 1 },
  INCLUDE_DEPTH_EXCEEDED: { write: 1, read: 1 },
}

describe('operation command framing', () => {
  test('the exit table names every error code', () => {
    expect(Object.keys(EXIT_TABLE).sort()).toEqual([...ERROR_CODES].sort())
  })

  test.each(OPERATION_NAMES.map(name => [name]))(
    'call %s prints its result as one JSON value and exits 0',
    async name => {
      const fake = fakeServiceRuntime()
      const run = await runCall(name, fake)
      expect(run.exitCode).toBe(0)
      expect(expectResult(run)).toEqual(OUTPUTS[name])
      expect(run.createRuntime).toHaveBeenCalledTimes(1)
      expect(fake.close).toHaveBeenCalledTimes(1)
      expect(run.readStdin).not.toHaveBeenCalled()
    }
  )

  test.each(ERROR_CODES.map(code => [code]))(
    '%s leaves stdout empty, prints one error line, and exits by the table',
    async code => {
      for (const [name, expected] of [
        ['read_file', EXIT_TABLE[code].read],
        ['write_file', EXIT_TABLE[code].write],
      ] as const) {
        const injected = new McpError(code, `Injected ${code}.`)
        const fake = rejectAll(fakeServiceRuntime(), injected)
        const run = await runCall(name, fake)
        expect(run.exitCode, name).toBe(expected)
        const error = expectError(run)
        expect(error).toEqual(injected.toJSON())
        expect(Object.keys(error).sort()).toEqual(['code', 'message', 'retryable'])
        expect(fake.close, name).toHaveBeenCalledTimes(1)
      }
    }
  )

  test('a timed-out write exits 5 and a timed-out read 7', async () => {
    for (const name of ['write_file', 'upload_file', 'create_project'] as const) {
      const fake = rejectAll(fakeServiceRuntime(), new McpError('TIMEOUT', 'Timed out.', { retryable: true }))
      const run = await runCall(name, fake)
      expect(run.exitCode, name).toBe(5)
      expect(expectError(run)).toEqual({ code: 'TIMEOUT', message: 'Timed out.', retryable: true })
    }
    const fake = rejectAll(fakeServiceRuntime(), new McpError('TIMEOUT', 'Timed out.', { retryable: true }))
    const run = await runCall('read_file', fake)
    expect(run.exitCode).toBe(7)
    expect(expectError(run).code).toBe('TIMEOUT')
  })

  test('a session that fails to open exits as a read, since nothing of a write was sent', async () => {
    const recorded = recorder()
    const createRuntime = vi.fn(async () => {
      throw new McpError('TIMEOUT', 'Timed out.', { retryable: true })
    })
    const argv = ['files', 'write', 'p', 'main.tex', '--revision', 'r', '--stdin']
    const exitCode = await runCommandLine(argv, recorder('text').io, { env: {}, createRuntime })
    expect(exitCode).toBe(7)
    const expired = vi.fn(async () => {
      throw new McpError('AUTH_EXPIRED', 'Sign in again.')
    })
    expect(
      await runCommandLine(['call', 'write_file', '--json', JSON.stringify(INPUTS.write_file)], recorded.io, {
        env: {},
        createRuntime: expired,
      })
    ).toBe(3)
  })

  test('a timed-out write known not to have applied exits 4, and an unknown outcome 5', async () => {
    const notApplied = new McpError('TIMEOUT', 'Timed out.', { retryable: true, details: { outcome: 'not_applied' } })
    const first = await runCall('write_file', rejectAll(fakeServiceRuntime(), notApplied))
    expect(first.exitCode).toBe(4)
    expect(expectError(first)).toEqual(notApplied.toJSON())

    const unknown = new McpError('REVISION_CONFLICT', 'Changed.', { details: { outcome: 'unknown' } })
    const second = await runCall('write_file', rejectAll(fakeServiceRuntime(), unknown))
    expect(second.exitCode).toBe(5)
    expect(expectError(second)).toEqual({
      code: 'REVISION_CONFLICT',
      message: 'Changed.',
      retryable: false,
      details: { outcome: 'unknown' },
    })
  })

  test('a create_file error that says the document was created exits 4, never 2 or 7', async () => {
    for (const [code, without] of [
      ['INVALID_ARGUMENT', 2],
      ['RATE_LIMITED', 7],
    ] as const) {
      const created = new McpError(code, 'The content was not written.', { details: { created: true } })
      const run = await runCall('create_file', rejectAll(fakeServiceRuntime(), created))
      expect(run.exitCode, code).toBe(4)
      expect(expectError(run)).toEqual(created.toJSON())
      // The same code without details.created keeps its own exit.
      const plain = await runCall('create_file', rejectAll(fakeServiceRuntime(), new McpError(code, 'Refused.')))
      expect(plain.exitCode, code).toBe(without)
    }
  })

  test('a partial bulk result exits 6 with the result on stdout', async () => {
    const cases = [
      ['sync_directory', (fake: FakeRuntime) => fake.sync.syncDirectory],
      ['batch_upload', (fake: FakeRuntime) => fake.sync.batchUpload],
      ['delete_entities', (fake: FakeRuntime) => fake.sync.deleteEntities],
    ] as const
    for (const [name, method] of cases) {
      const fake = fakeServiceRuntime()
      const partial = { ...OUTPUTS[name], status: 'partial' }
      method(fake).mockResolvedValueOnce(partial)
      const run = await runCall(name, fake)
      expect(run.exitCode, name).toBe(6)
      expect(expectResult(run)).toEqual(partial)
    }
  })
})

describe('call request sources', () => {
  const READ = { projectId: 'p', filePath: 'main.tex' }

  test('reads the request from a file, from stdin, from --json, and as {} without one', async () => {
    const folder = await temporaryFolder()
    const file = join(folder, 'request.json')
    await writeFile(file, JSON.stringify(READ))

    for (const [argv, stdin] of [
      [['call', 'read_file', '--request', file], undefined],
      [['call', 'read_file', '--request', '-'], JSON.stringify(READ)],
      [['call', 'read_file', '--json', JSON.stringify(READ)], undefined],
    ] as const) {
      const fake = fakeServiceRuntime()
      const run = await cli([...argv], { runtime: fake, ...(stdin === undefined ? {} : { stdin }) })
      expect(run.exitCode, argv.join(' ')).toBe(0)
      expect(expectResult(run)).toEqual(OUTPUTS.read_file)
      expect(fake.documents.readFile).toHaveBeenCalledWith('p', 'main.tex')
      expect(run.readStdin).toHaveBeenCalledTimes(stdin === undefined ? 0 : 1)
    }

    const fake = fakeServiceRuntime()
    const none = await cli(['call', 'auth_status'], { runtime: fake })
    expect(none.exitCode).toBe(0)
    expect(expectResult(none)).toEqual(OUTPUTS.auth_status)
    expect(fake.authStatus).toHaveBeenCalledTimes(1)
    expect(none.readStdin).not.toHaveBeenCalled()

    const missing = await cli(['call', 'read_file'], { runtime: fakeServiceRuntime() })
    expect(missing.exitCode).toBe(2)
    expect(expectError(missing).details?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'projectId' })])
    )
    expect(missing.createRuntime).not.toHaveBeenCalled()
  })

  test('a request that is not JSON, not an object, not UTF-8, or unreadable exits 2 and never quotes it', async () => {
    const sentinel = 'REQUEST-SENTINEL-4d1f'
    const folder = await temporaryFolder()
    const bad: Array<{ label: string; text: string | Uint8Array }> = [
      { label: 'not JSON', text: `{"projectId": "p", "filePath": "${sentinel}"` },
      { label: 'bare text', text: sentinel },
      { label: 'an array', text: JSON.stringify([sentinel]) },
      { label: 'a string', text: JSON.stringify(sentinel) },
      { label: 'null', text: 'null' },
      { label: 'not UTF-8', text: Buffer.concat([Buffer.from(`{"content":"${sentinel}`), Buffer.from([0xff, 0xfe])]) },
    ]
    for (const { label, text } of bad) {
      const file = join(folder, `${label.replace(/\W/gu, '-')}.json`)
      await writeFile(file, text)
      const runs = [
        await cli(['call', 'read_file', '--request', file]),
        await cli(['call', 'read_file', '--request', '-'], { stdin: text }),
        ...(typeof text === 'string' ? [await cli(['call', 'read_file', '--json', text])] : []),
      ]
      for (const run of runs) {
        expect(run.exitCode, label).toBe(2)
        const error = expectError(run)
        expect(error.code, label).toBe('INVALID_ARGUMENT')
        expect(run.stderr, label).not.toContain(sentinel)
        expect(run.createRuntime, label).not.toHaveBeenCalled()
      }
    }

    for (const path of [join(folder, 'missing.json'), folder]) {
      const run = await cli(['call', 'read_file', '--request', path])
      expect(run.exitCode).toBe(2)
      const error = expectError(run)
      expect(error.code).toBe('INVALID_ARGUMENT')
      expect(error.details?.errno).toBe(path === folder ? 'EISDIR' : 'ENOENT')
      expect(run.createRuntime).not.toHaveBeenCalled()
    }
  })

  test('an unknown key at any depth exits 2 naming it, before any session is opened', async () => {
    const cases: Array<[OperationName, Record<string, unknown>, string[]]> = [
      ['read_file', { ...READ, writemode: 'tracked' }, ['writemode']],
      [
        'batch_upload',
        { projectId: 'p', files: [{ localPath: '/tmp/a.png', destinationPath: 'a.png', overwrite: true }] },
        ['files.0.overwrite'],
      ],
      ['add_comment', { ...INPUTS.add_comment, start: { line: 1, column: 1, offset: 0 } }, ['start.offset']],
      ['auth_status', { verbose: true }, ['verbose']],
    ]
    for (const [name, input, unknownKeys] of cases) {
      for (const argv of [
        ['call', name, '--json', JSON.stringify(input)],
        ['call', name, '--request', '-'],
      ]) {
        const fake = fakeServiceRuntime()
        const run = await cli(argv, { runtime: fake, stdin: JSON.stringify(input) })
        expect(run.exitCode, name).toBe(2)
        const error = expectError(run)
        expect(error.code).toBe('INVALID_ARGUMENT')
        expect(error.details).toEqual({ unknownKeys })
        expect(run.createRuntime).not.toHaveBeenCalled()
        for (const mock of mocks(fake)) expect(mock).not.toHaveBeenCalled()
      }
    }
  })
})

/** A real runtime over the test fetcher and sockets, whose close the command must call. */
async function realRuntime(options: TestRuntimeOptions = {}) {
  const test = await createTestRuntime(options)
  folders.push(test.directory)
  const close = vi.spyOn(test.runtime, 'close')
  return { ...test, close }
}

/** `p` holding main.tex and old.tex, both reading as "hello". */
const TWO_DOCUMENTS: RawFolder = {
  _id: 'root',
  name: 'rootFolder',
  docs: [
    { _id: 'd1', name: 'main.tex' },
    { _id: 'd2', name: 'old.tex' },
  ],
  fileRefs: [],
  folders: [],
}

function noDeletes(fetches: string[]): void {
  expect(fetches.filter(fetch => fetch.startsWith('DELETE '))).toEqual([])
}

describe('safety checks with a real runtime', () => {
  test('files write with a stale revision exits 4 and never applies an update', async () => {
    const stale = createRevision({
      projectId: 'p',
      docId: 'd1',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'other text',
    })
    const live = await realRuntime()
    const run = await cli(['files', 'write', 'p', 'main.tex', '--revision', stale, '--stdin'], {
      runtime: live.runtime,
      stdin: 'new text',
    })
    expect(run.exitCode).toBe(4)
    expect(expectError(run).code).toBe('REVISION_CONFLICT')
    // The live document was joined and compared, and nothing was sent after the comparison failed.
    expect(live.socketCalls).toContain('joinDoc')
    expect(live.socketCalls).not.toContain('applyOtUpdate')
    expect(live.fetches).toEqual([])
    expect(live.close).toHaveBeenCalledTimes(1)
  })

  test('manage_entity delete without a matching confirmPath exits 2 and sends no DELETE', async () => {
    const missing = await realRuntime()
    const run = await cli(
      ['call', 'manage_entity', '--json', JSON.stringify({ projectId: 'p', action: 'delete', path: 'main.tex' })],
      { runtime: missing.runtime }
    )
    expect(run.exitCode).toBe(2)
    expect(expectError(run).code).toBe('INVALID_ARGUMENT')
    expect(missing.fetches).toEqual([])
    expect(missing.connectionFactory).not.toHaveBeenCalled()
    expect(missing.close).toHaveBeenCalledTimes(1)

    const wrong = await realRuntime()
    const mismatch = await cli(
      [
        'call',
        'manage_entity',
        '--json',
        JSON.stringify({ projectId: 'p', action: 'delete', path: 'main.tex', confirmPath: 'other.tex' }),
      ],
      { runtime: wrong.runtime }
    )
    expect(mismatch.exitCode).toBe(2)
    expect(expectError(mismatch).code).toBe('CONFIRMATION_MISMATCH')
    noDeletes(wrong.fetches)
  })

  test('sync apply --mode mirror with a valid plan token but no --confirm-delete-count exits 2 and deletes nothing', async () => {
    const local = await temporaryFolder()
    await writeFile(join(local, 'main.tex'), 'hello')

    const planner = await realRuntime({ root: TWO_DOCUMENTS })
    const planned = await cli(['sync', 'plan', 'p', local], { runtime: planner.runtime })
    expect(planned.exitCode).toBe(0)
    const plan = expectResult(planned)
    expect(plan.remoteOnly).toEqual([expect.objectContaining({ destinationPath: 'old.tex', type: 'doc' })])
    expect(planner.close).toHaveBeenCalledTimes(1)

    const applier = await realRuntime({ root: TWO_DOCUMENTS })
    const run = await cli(['sync', 'apply', 'p', local, '--mode', 'mirror', '--plan-token', plan.planToken], {
      runtime: applier.runtime,
    })
    expect(run.exitCode).toBe(2)
    expect(expectError(run).code).toBe('CONFIRMATION_MISMATCH')
    noDeletes(applier.fetches)
    expect(applier.close).toHaveBeenCalledTimes(1)

    // With the count the same token reaches the delete, so it was only the confirmation that was missing.
    const confirmed = await realRuntime({
      root: TWO_DOCUMENTS,
      fetcher: async () => new Response(null, { status: 204 }),
    })
    await cli(
      ['sync', 'apply', 'p', local, '--mode', 'mirror', '--plan-token', plan.planToken, '--confirm-delete-count', '1'],
      { runtime: confirmed.runtime }
    )
    expect(confirmed.fetches.filter(fetch => fetch.startsWith('DELETE '))).toHaveLength(1)
  })

  test('tracked-changes accept without --confirm-count exits 2 before any document is read or request sent', async () => {
    const revision = createRevision({
      projectId: 'p',
      docId: 'd1',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'hello',
    })
    for (const extra of [[], ['--confirm-count', '2']]) {
      const live = await realRuntime()
      const run = await cli(
        ['tracked-changes', 'accept', 'p', 'main.tex', '--revision', revision, '--change', 'c1', ...extra],
        { runtime: live.runtime }
      )
      expect(run.exitCode).toBe(2)
      expect(expectError(run).code).toBe('CONFIRMATION_MISMATCH')
      expect(live.socketCalls).toEqual([])
      expect(live.connectionFactory).not.toHaveBeenCalled()
      expect(live.fetches).toEqual([])
      expect(live.close).toHaveBeenCalledTimes(1)
    }
  })

  test('tracked-changes exits 3 for review the deployment cannot do', async () => {
    for (const kind of ['feature_disabled', 'route_unavailable', 'document_protocol']) {
      const fake = rejectAll(
        fakeServiceRuntime(),
        new McpError('REVIEW_UNSUPPORTED', 'No review.', { details: { kind } })
      )
      const run = await cli(
        ['tracked-changes', 'reject', 'p', 'main.tex', '--revision', 'r', '--change', 'c1', '--confirm-count', '1'],
        { runtime: fake }
      )
      expect(run.exitCode, kind).toBe(3)
      expect(expectError(run)).toEqual({
        code: 'REVIEW_UNSUPPORTED',
        message: 'No review.',
        retryable: false,
        details: { kind },
      })
      expect(fake.trackedChanges.manageTrackedChanges).toHaveBeenCalledWith({
        projectId: 'p',
        filePath: 'main.tex',
        revision: 'r',
        action: 'reject',
        changeIds: ['c1'],
        confirmCount: 1,
      })
    }
  })

  test('sync apply prints progress on stderr only with --progress, and only as progress lines', async () => {
    const local = await temporaryFolder()
    await writeFile(join(local, 'main.tex'), 'hello')

    const planner = await realRuntime()
    const plan = expectResult(await cli(['sync', 'plan', 'p', local], { runtime: planner.runtime }))
    expect(plan.identical).toEqual({ count: 1, paths: ['main.tex'] })

    const quiet = await realRuntime()
    const run = await cli(['sync', 'apply', 'p', local, '--mode', 'additive', '--plan-token', plan.planToken], {
      runtime: quiet.runtime,
    })
    expect(run.exitCode).toBe(0)
    const result = expectResult(run)
    expect(result).toMatchObject({ status: 'complete', planned: true, identicalCount: 1 })
    expect(quiet.close).toHaveBeenCalledTimes(1)

    const loud = await realRuntime()
    const progress = await cli(
      ['sync', 'apply', 'p', local, '--mode', 'additive', '--plan-token', plan.planToken, '--progress'],
      { runtime: loud.runtime }
    )
    expect(progress.exitCode).toBe(0)
    expect(progress.stdoutWrites).toHaveLength(1)
    expect(JSON.parse(progress.stdout)).toEqual(result)
    const lines = progress.stderr.split('\n')
    expect(lines.pop()).toBe('')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      const value = JSON.parse(line) as { progress: Record<string, unknown> }
      expect(Object.keys(value)).toEqual(['progress'])
      expect(Object.keys(value.progress).sort()).toEqual(['message', 'progress', 'total'])
      expect(typeof value.progress.progress).toBe('number')
      expect(typeof value.progress.total).toBe('number')
      expect(value.progress.message).not.toContain('main.tex')
    }
  })
})

describe('a write that was sent never exits as if nothing changed', () => {
  test('reply_to_comment whose read-back is rate-limited exits 5, having posted once', async () => {
    let threadReads = 0
    const live = await realRuntime({
      fetcher: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.pathname === '/project/p/threads') {
          threadReads += 1
          return threadReads === 1 ? Response.json({ t: { messages: [] } }) : new Response(null, { status: 429 })
        }
        if (method === 'POST' && url.pathname === '/project/p/thread/t/messages') return Response.json({})
        throw new Error(`unexpected ${method} ${url.pathname}`)
      },
    })
    const request = JSON.stringify({ projectId: 'p', threadId: 't', content: 'A reply.' })
    const run = await cli(['call', 'reply_to_comment', '--json', request], { runtime: live.runtime })
    expect(run.exitCode).toBe(5)
    expect(expectError(run)).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: false, details: { threadId: 't' } })
    expect(live.fetches).toEqual([
      'GET /project/p/threads',
      'POST /project/p/thread/t/messages',
      'GET /project/p/threads',
    ])
    expect(live.close).toHaveBeenCalledTimes(1)
  })

  test('update_project_settings rate-limited after storing the compiler exits 4, and 7 when nothing was stored', async () => {
    const settings = (answers: number[]) => async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (init?.method === 'POST' && url.pathname === '/project/p/settings') {
        return new Response(null, { status: answers.shift() ?? 500 })
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url.pathname}`)
    }
    const argv = [
      'call',
      'update_project_settings',
      '--json',
      JSON.stringify({ projectId: 'p', compiler: 'xelatex', imageName: 'texlive-full:2025.1' }),
    ]

    const partly = await realRuntime({ fetcher: settings([204, 429]) })
    const run = await cli(argv, { runtime: partly.runtime })
    expect(run.exitCode).toBe(4)
    expect(expectError(run)).toMatchObject({
      code: 'RATE_LIMITED',
      details: { applied: ['compiler'], failed: 'imageName' },
    })
    expect(partly.fetches).toEqual(['POST /project/p/settings', 'POST /project/p/settings'])

    const none = await realRuntime({ fetcher: settings([429]) })
    const refused = await cli(argv, { runtime: none.runtime })
    expect(refused.exitCode).toBe(7)
    expect(expectError(refused)).toMatchObject({ code: 'RATE_LIMITED', details: { applied: [], failed: 'compiler' } })
    expect(none.fetches).toEqual(['POST /project/p/settings'])
  })
})

describe('compile run --download', () => {
  test('prints the compile and the download, and downloads from the same build', async () => {
    const folder = await temporaryFolder()
    const pdf = join(folder, 'paper.pdf')
    const fake = fakeServiceRuntime()
    const run = await cli(['compile', 'run', 'p', '--download', pdf], { runtime: fake })
    expect(run.exitCode).toBe(0)
    expect(expectResult(run)).toEqual({
      status: 'complete',
      compile: OUTPUTS.compile_project,
      download: OUTPUTS.download_compile_output,
    })
    expect(fake.compile.compileProject).toHaveBeenCalledTimes(1)
    expect(fake.compile.downloadCompileOutput).toHaveBeenCalledTimes(1)
    const [projectId, localPath, options] = fake.compile.downloadCompileOutput.mock.calls[0]!
    expect([projectId, localPath]).toEqual(['p', pdf])
    expect(options).toMatchObject({ buildRef: OUTPUTS.compile_project.buildRef, overwrite: false })
    expect(fake.close).toHaveBeenCalledTimes(1)

    const overwriting = fakeServiceRuntime()
    expect(
      (await cli(['compile', 'run', 'p', '--download', pdf, '--overwrite'], { runtime: overwriting })).exitCode
    ).toBe(0)
    expect(overwriting.compile.downloadCompileOutput.mock.calls[0]![2]).toMatchObject({ overwrite: true })
  })

  test('a failed download after the compile prints a partial result and exits 6', async () => {
    const fake = fakeServiceRuntime()
    const failure = new McpError('CONFIRMATION_MISMATCH', 'The file exists; pass overwrite.', {
      details: { kind: 'exists' },
    })
    fake.compile.downloadCompileOutput.mockRejectedValueOnce(failure)
    const run = await cli(['compile', 'run', 'p', '--download', join(await temporaryFolder(), 'paper.pdf')], {
      runtime: fake,
    })
    expect(run.exitCode).toBe(6)
    expect(expectResult(run)).toEqual({
      status: 'partial',
      compile: OUTPUTS.compile_project,
      download: null,
      downloadError: failure.toJSON(),
    })
  })

  test('a failed compile prints nothing on stdout, downloads nothing, and exits by its code', async () => {
    for (const [error, exitCode] of [
      [new McpError('COMPILE_RATE_LIMITED', 'Wait.', { retryable: true }), 7],
      [new McpError('COMPILE_TIMEOUT', 'Too long.'), 1],
      [new McpError('TIMEOUT', 'Timed out.', { retryable: true }), 5],
    ] as const) {
      const fake = fakeServiceRuntime()
      fake.compile.compileProject.mockRejectedValueOnce(error)
      const run = await cli(['compile', 'run', 'p', '--download', join(await temporaryFolder(), 'paper.pdf')], {
        runtime: fake,
      })
      expect(run.exitCode, error.code).toBe(exitCode)
      expect(expectError(run)).toEqual(error.toJSON())
      expect(fake.compile.downloadCompileOutput).not.toHaveBeenCalled()
    }
  })

  test('a LaTeX failure is still a result, and --overwrite needs --download', async () => {
    const fake = fakeServiceRuntime()
    const failed = {
      ...OUTPUTS.compile_project,
      status: 'failure',
      summary: { ...OUTPUTS.compile_project.summary, builtCleanly: false },
    }
    fake.compile.compileProject.mockResolvedValueOnce(failed)
    const run = await cli(['compile', 'run', 'p'], { runtime: fake })
    expect(run.exitCode).toBe(0)
    expect(expectResult(run)).toEqual(failed)
    expect(fake.compile.downloadCompileOutput).not.toHaveBeenCalled()

    const usage = await cli(['compile', 'run', 'p', '--overwrite'])
    expect(usage.exitCode).toBe(2)
    expect(expectError(usage).code).toBe('INVALID_ARGUMENT')
    expect(usage.createRuntime).not.toHaveBeenCalled()
  })
})

describe('files write content sources', () => {
  test('--stdin decodes UTF-8 and drops a leading byte order mark', async () => {
    const text = 'Grüße, ☃ and 𝔼 = mc²\r\nSecond line\n'
    const fake = fakeServiceRuntime()
    const run = await cli(['files', 'write', 'p', 'main.tex', '--revision', 'r', '--stdin'], {
      runtime: fake,
      stdin: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]),
    })
    expect(run.exitCode).toBe(0)
    expect(expectResult(run)).toEqual(OUTPUTS.write_file)
    expect(run.readStdin).toHaveBeenCalledTimes(1)
    expect(fake.documents.writeFile).toHaveBeenCalledWith('p', 'main.tex', 'r', text, 'untracked')
  })

  test('invalid UTF-8 on stdin exits 2 before any session is opened', async () => {
    const run = await cli(['files', 'write', 'p', 'main.tex', '--revision', 'r', '--stdin'], {
      stdin: Buffer.from([0x68, 0x69, 0xc3, 0x28, 0xff]),
    })
    expect(run.exitCode).toBe(2)
    expect(expectError(run).code).toBe('INVALID_ARGUMENT')
    expect(run.createRuntime).not.toHaveBeenCalled()
  })

  test('--content-file is read by the operation itself, as localPath', async () => {
    const folder = await temporaryFolder()
    const file = join(folder, 'main.tex')
    await writeFile(file, 'From disk\n')
    const fake = fakeServiceRuntime()
    const run = await cli(['files', 'write', 'p', 'main.tex', '--revision', 'r', '--content-file', file, '--tracked'], {
      runtime: fake,
    })
    expect(run.exitCode).toBe(0)
    expect(run.readStdin).not.toHaveBeenCalled()
    expect(fake.documents.writeFile).toHaveBeenCalledWith('p', 'main.tex', 'r', 'From disk\n', 'tracked')

    for (const argv of [
      ['files', 'write', 'p', 'main.tex', '--revision', 'r'],
      ['files', 'write', 'p', 'main.tex', '--revision', 'r', '--stdin', '--content-file', file],
    ]) {
      const usage = await cli(argv, { stdin: 'text' })
      expect(usage.exitCode).toBe(2)
      expect(usage.createRuntime).not.toHaveBeenCalled()
    }
  })

  test('--content-file outside OVERLEAF_LOCAL_READ_ROOTS exits 2 with nothing sent', async () => {
    const base = await temporaryFolder()
    const allowed = join(base, 'allowed')
    const outside = join(base, 'outside')
    await mkdir(allowed)
    await mkdir(outside)
    const sentinel = 'CONTENT-FILE-SENTINEL-91c2'
    const file = join(outside, 'main.tex')
    await writeFile(file, sentinel)
    const env = { OVERLEAF_LOCAL_READ_ROOTS: allowed }
    const live = await realRuntime({ env })
    const run = await cli(['files', 'write', 'p', 'main.tex', '--revision', 'r', '--content-file', file], {
      runtime: live.runtime,
      env,
    })
    expect(run.exitCode).toBe(2)
    const error = expectError(run)
    expect(error.code).toBe('PATH_OUTSIDE_ROOT')
    expect(run.stderr).not.toContain(sentinel)
    expect(live.socketCalls).toEqual([])
    expect(live.connectionFactory).not.toHaveBeenCalled()
    expect(live.fetches).toEqual([])
    expect(live.close).toHaveBeenCalledTimes(1)
  })
})

/** The capabilities report on stdout, and its entry for one operation. */
function capabilities(run: CliRun) {
  const report = expectResult(run) as CapabilitiesReport
  const operation = (name: string) => {
    const entry = report.operations.find(candidate => candidate.name === name)
    expect(entry, name).toBeDefined()
    return entry!
  }
  return { report, operation }
}

describe('capabilities', () => {
  test('fails on an access policy every other command would refuse, without opening a session', async () => {
    const missing = join(await temporaryFolder(), 'does-not-exist')
    const run = await cli(['capabilities'], { env: { OVERLEAF_LOCAL_READ_ROOTS: missing } })
    expect(run.exitCode).toBe(2)
    expect(expectError(run).code).toBe('INVALID_ARGUMENT')
    expect(run.createRuntime).not.toHaveBeenCalled()
    const unsafe = await cli(['capabilities'], { env: { OVERLEAF_ALLOWED_PROJECTS: 'a/b' } })
    expect(unsafe.exitCode).toBe(2)
  })

  test('lists every operation without opening a session', async () => {
    const run = await cli(['capabilities'])
    expect(run.exitCode).toBe(0)
    expect(run.createRuntime).not.toHaveBeenCalled()
    const { report, operation } = capabilities(run)
    expect(report.operations.map(entry => entry.name)).toEqual([...OPERATION_NAMES])
    expect(operation('download_file').effects).toContain('local-write')
    expect(operation('download_file').commands).toEqual(['files download'])
    for (const alias of ALIASES) expect(operation(alias.tool).commands).toContain(alias.words.join(' '))
    for (const entry of report.operations) expect(entry.blockedEffects, entry.name).toEqual([])
    expect(report.project).toEqual({
      projectId: 'unknown',
      allowedByPolicy: 'unknown',
      accessLevel: 'unknown',
      archived: 'unknown',
      trashed: 'unknown',
    })
    expect(report.errorCodes).toEqual([...ERROR_CODES])
  })

  test('reports the effects OVERLEAF_ALLOWED_EFFECTS refuses', async () => {
    const run = await cli(['capabilities'], { env: { OVERLEAF_ALLOWED_EFFECTS: 'overleaf-read,local-read' } })
    expect(run.exitCode).toBe(0)
    expect(run.createRuntime).not.toHaveBeenCalled()
    const { report, operation } = capabilities(run)
    const blocked = (name: string): string[] => operation(name).blockedEffects
    expect(blocked('read_file')).toEqual([])
    expect(blocked('plan_sync')).toEqual([])
    expect(blocked('download_file')).toEqual(['local-write'])
    expect(blocked('write_file')).toEqual(['overleaf-write'])
    expect(blocked('sync_directory')).toEqual(['overleaf-write', 'overleaf-delete'])
    for (const name of OPERATION_NAMES) {
      expect(blocked(name), name).toEqual(
        OPERATIONS[name].effects.filter(effect => effect !== 'overleaf-read' && effect !== 'local-read')
      )
    }
    expect(report.policy).toMatchObject({ effectsRestricted: true, projectsRestricted: false })
  })

  test('a project outside OVERLEAF_ALLOWED_PROJECTS is reported without a request', async () => {
    const fake = fakeServiceRuntime()
    const run = await cli(['capabilities', 'other'], { runtime: fake, env: { OVERLEAF_ALLOWED_PROJECTS: 'mine' } })
    expect(run.exitCode).toBe(0)
    expect(run.createRuntime).not.toHaveBeenCalled()
    expect(fake.account.findProject).not.toHaveBeenCalled()
    expect(capabilities(run).report.project).toEqual({
      projectId: 'other',
      allowedByPolicy: false,
      accessLevel: 'unknown',
      archived: 'unknown',
      trashed: 'unknown',
    })
  })

  test('an allowed project is looked up once and its access reported', async () => {
    const fake = fakeServiceRuntime()
    fake.account.findProject.mockResolvedValueOnce({
      id: 'mine',
      name: 'Paper',
      accessLevel: 'readAndWrite',
      archived: true,
      trashed: false,
    })
    const run = await cli(['capabilities', 'mine'], { runtime: fake, env: { OVERLEAF_ALLOWED_PROJECTS: 'mine' } })
    expect(run.exitCode).toBe(0)
    expect(run.createRuntime).toHaveBeenCalledTimes(1)
    expect(fake.account.findProject).toHaveBeenCalledTimes(1)
    expect(fake.account.findProject).toHaveBeenCalledWith('mine')
    expect(fake.close).toHaveBeenCalledTimes(1)
    expect(capabilities(run).report.project).toEqual({
      projectId: 'mine',
      allowedByPolicy: true,
      accessLevel: 'readAndWrite',
      archived: true,
      trashed: false,
    })
  })

  test('a failed lookup exits as the project listing would', async () => {
    for (const [error, exitCode] of [
      [new McpError('NOT_FOUND', 'No such project.'), 1],
      [new McpError('TIMEOUT', 'Timed out.', { retryable: true }), 7],
    ] as const) {
      const fake = fakeServiceRuntime()
      fake.account.findProject.mockRejectedValueOnce(error)
      const run = await cli(['capabilities', 'p'], { runtime: fake })
      expect(run.exitCode, error.code).toBe(exitCode)
      expect(expectError(run)).toEqual(error.toJSON())
      expect(fake.close).toHaveBeenCalledTimes(1)
    }
  })
})
