import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, test } from 'vitest'

import type { CapabilitiesReport } from '../../src/cli/capabilities.js'
import { DOCTOR_CHECK_IDS, type DoctorReport } from '../../src/cli/doctor.js'
import type { OperationOutput } from '../../src/contracts/operations.js'

/**
 * Drives a throwaway project through the built command line only, as a script or an agent would:
 * every step is a spawned `node dist/cli.js <args>` with the maintainer's own environment, so the
 * saved session and every OVERLEAF_* setting apply. The project is trashed, never deleted.
 */
const enabled = process.env.RUN_OVERLEAF_LIVE_TESTS === '1' && process.env.RUN_OVERLEAF_LIVE_CLI_TESTS === '1'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CLI = join(ROOT, 'dist', 'cli.js')
// A dist/ built before the operation commands has dist/cli.js but no dist/cli/run.js.
const BUILD_OUTPUTS = [CLI, join(ROOT, 'dist', 'cli', 'run.js')]
const COMMAND_TIMEOUT_MS = 180_000

const DOCUMENT = '\\documentclass{article}\n\\begin{document}\nDisposable command line test.\n\\end{document}\n'
// A 1x1 PNG, enough for an upload and a hash comparison.
const FIGURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

interface CliRun {
  exitCode: number
  stdout: string
  stderr: string
}

/** Every variable of this process, plus the new project in OVERLEAF_ALLOWED_PROJECTS when one is set. */
function childEnvironment(projectId?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const allowed = env.OVERLEAF_ALLOWED_PROJECTS
  // A project created by one process is allowed only inside it, so the next commands need its id.
  if (projectId !== undefined && allowed !== undefined && allowed.trim() !== '') {
    env.OVERLEAF_ALLOWED_PROJECTS = `${allowed},${projectId}`
  }
  return env
}

/** Runs `node dist/cli.js <args>` and resolves with its exit code and output, whatever the code. */
async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliRun> {
  return await new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: ROOT, env, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr })
        } else if (typeof error.code === 'number') {
          resolve({ exitCode: error.code, stdout, stderr })
        } else {
          // Spawn failure or timeout. The command words are enough; argv may hold a project id.
          reject(
            new Error(`${args.slice(0, 2).join(' ')} did not exit normally (${String(error.signal ?? error.code)}).`)
          )
        }
      }
    )
    // Operation commands never wait for typed input; a closed pipe is what a script gives them.
    child.stdin?.end()
  })
}

/** Exit 0, nothing on stderr, and exactly one JSON value on stdout. */
function succeeded<T>(run: CliRun): T {
  expect({ exitCode: run.exitCode, stderr: run.stderr }).toEqual({ exitCode: 0, stderr: '' })
  expect(run.stdout.endsWith('\n')).toBe(true)
  return JSON.parse(run.stdout) as T
}

describe.skipIf(!enabled)('command line against a throwaway Overleaf project', () => {
  beforeAll(() => {
    const missing = BUILD_OUTPUTS.filter(path => !existsSync(path))
    if (missing.length > 0) {
      throw new Error('dist/ is missing or predates the operation commands; run npm run build first.')
    }
  })

  test(
    'creates, reads, writes, syncs, compiles, reads the log, checks the install, and trashes a project through spawned commands',
    async () => {
      const name = `mcp-cli-${Date.now()}`
      const scratch = await mkdtemp(join(tmpdir(), 'overleaf-live-cli-'))
      // Kept apart, so the sync plan never sees the document written with --content-file.
      const contentFile = join(scratch, 'content', 'main.tex')
      const syncFolder = join(scratch, 'sync')
      await mkdir(join(scratch, 'content'))
      await writeFile(contentFile, DOCUMENT)
      await mkdir(join(syncFolder, 'figures'), { recursive: true })
      await writeFile(join(syncFolder, 'figures', 'plot.png'), FIGURE)

      let projectId: string | undefined
      let trash: CliRun | undefined
      try {
        const created = succeeded<OperationOutput<'create_project'>>(
          await runCli(['call', 'create_project', '--json', JSON.stringify({ name })], childEnvironment())
        )
        projectId = created.projectId
        expect(created.name).toBe(name)
        expect(projectId).toMatch(/^\w+$/u)
        const env = childEnvironment(projectId)

        const tree = succeeded<OperationOutput<'get_project_tree'>>(await runCli(['tree', projectId], env))
        expect(tree.rootDocPath).toBe('main.tex')
        expect(tree.entities).toContainEqual(expect.objectContaining({ path: 'main.tex', type: 'doc' }))

        const stub = succeeded<OperationOutput<'read_file'>>(
          await runCli(['files', 'read', projectId, 'main.tex'], env)
        )
        expect(stub).toMatchObject({ newline: 'LF', revision: expect.any(String) })

        const written = succeeded<OperationOutput<'write_file'>>(
          await runCli(
            ['files', 'write', projectId, 'main.tex', '--revision', stub.revision, '--content-file', contentFile],
            env
          )
        )
        expect(written.writeMode).toBe('untracked')
        expect(written.revision).not.toBe(stub.revision)
        const reread = succeeded<OperationOutput<'read_file'>>(
          await runCli(['files', 'read', projectId, 'main.tex'], env)
        )
        expect(reread.content === DOCUMENT).toBe(true)
        expect(reread.revision).toBe(written.revision)

        const plan = succeeded<OperationOutput<'plan_sync'>>(await runCli(['sync', 'plan', projectId, syncFolder], env))
        expect(plan.toUpload.map(entry => entry.destinationPath)).toEqual(['figures/plot.png'])
        expect(plan.conflicts).toEqual([])

        const applied = succeeded<OperationOutput<'sync_directory'>>(
          await runCli(
            ['sync', 'apply', projectId, syncFolder, '--mode', 'additive', '--plan-token', plan.planToken],
            env
          )
        )
        expect(applied).toMatchObject({ status: 'complete', mode: 'additive', failed: [], planned: true })
        expect(applied.completed).toContainEqual(
          expect.objectContaining({ destinationPath: 'figures/plot.png', action: 'upload' })
        )

        const build = succeeded<OperationOutput<'compile_project'>>(await runCli(['compile', 'run', projectId], env))
        expect(build.rootFilePath).toBe('main.tex')
        expect(build.summary).toMatchObject({ builtCleanly: true, errorCount: 0 })
        expect(build.buildRef).toEqual(expect.any(String))

        const log = succeeded<OperationOutput<'get_compile_log'>>(
          await runCli(['compile', 'log', projectId, '--build-ref', build.buildRef ?? '', '--tail', '5'], env)
        )
        expect(log.errorLines).toEqual([])
        expect(log.buildId).toEqual(expect.any(String))

        // doctor checks every step read-only and names no project, file, or person.
        const doctor = succeeded<DoctorReport>(await runCli(['doctor', projectId], env))
        expect(doctor.checks.map(check => check.id)).toEqual([...DOCTOR_CHECK_IDS])
        expect(doctor.checks.filter(check => check.status !== 'ok')).toEqual([])
        expect(JSON.stringify(doctor)).not.toContain(projectId)
        expect(JSON.stringify(doctor)).not.toContain(name)

        // The account owns the project, so it can decide tracked changes there unless its plan says no.
        const capabilities = succeeded<CapabilitiesReport>(await runCli(['capabilities', projectId], env))
        expect(capabilities.project).toMatchObject({ projectId, allowedByPolicy: true, accessLevel: 'owner' })
        expect(capabilities.backend).toMatchObject({ kind: 'web-session', review: { list: true } })
        expect(typeof capabilities.backend.review.decide).toBe('boolean')
      } finally {
        if (projectId !== undefined) {
          // Trash, never delete: a failed step must leave something a human can inspect.
          trash = await runCli(
            ['call', 'manage_project', '--json', JSON.stringify({ projectId, action: 'trash', confirmName: name })],
            childEnvironment(projectId)
          )
          if (trash.exitCode !== 0) {
            console.warn(`Could not trash ${name} (exit ${trash.exitCode}); trash it in the web UI.`)
          }
        }
        await rm(scratch, { recursive: true, force: true })
      }
      // Reached only when every step passed, so a failed cleanup never hides the first failure.
      expect(trash).toBeDefined()
      const trashed = succeeded<OperationOutput<'manage_project'>>(trash as CliRun)
      expect(trashed).toMatchObject({ action: 'trash', projectId, name })
    },
    15 * 60_000
  )
})
