import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { operationJsonSchema } from '../../src/cli/json-schema.js'
import { renderHelp } from '../../src/cli-command.js'
import { OPERATION_NAMES } from '../../src/contracts/operations.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * A module resolve hook that refuses the MCP SDK, registered before tsx so it is in force for the
 * whole entry point. Only `serve` may load the SDK; every other command must work without it.
 */
const REFUSED = 'MCP SDK refused: '
const REFUSE_MCP_SDK = `export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@modelcontextprotocol/')) throw new Error(${JSON.stringify(REFUSED)} + specifier)
  return await nextResolve(specifier, context)
}`
const REGISTER_HOOK = `import { register } from 'node:module'
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(REFUSE_MCP_SDK)}`)})`
const WITHOUT_MCP_SDK = `data:text/javascript,${encodeURIComponent(REGISTER_HOOK)}`

let base = ''
let env: NodeJS.ProcessEnv = {}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'overleaf-cli-process-'))
  // Built from nothing, so the maintainer's own session, configuration, and proxy never reach the child.
  env = {
    PATH: process.env.PATH ?? '',
    HOME: join(base, 'home'),
    XDG_CONFIG_HOME: join(base, 'config'),
    OVERLEAF_COOKIE_JAR_FILE: join(base, 'missing', 'cookies.txt'),
    OVERLEAF_BASE_URL: 'https://overleaf.test',
  }
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

interface Exit {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Runs the real entry point, `src/cli.ts`, as a child process with stdin closed and the MCP SDK
 * refused, so every command here is also shown to run without loading it.
 */
async function overleafWebMcp(...args: string[]): Promise<Exit> {
  const exit = await new Promise<Exit>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', WITHOUT_MCP_SDK, '--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', code => resolvePromise({ code, stdout, stderr }))
  })
  if (args[0] !== 'serve') expect(exit.stderr, args.join(' ')).not.toContain(REFUSED)
  return exit
}

/** Exactly one JSON error line on stderr. */
function errorLine(exit: Exit): { code: string; message: string; retryable: boolean } {
  const lines = exit.stderr.split('\n')
  expect(lines, exit.stderr).toHaveLength(2)
  expect(lines[1]).toBe('')
  const error = JSON.parse(lines[0]!) as { code: string; message: string; retryable: boolean }
  expect(
    Object.keys(error)
      .filter(key => key !== 'details')
      .sort()
  ).toEqual(['code', 'message', 'retryable'])
  return error
}

describe('the overleaf-web-mcp process', { timeout: 60_000 }, () => {
  test('an unknown command exits 1 with one JSON error line', async () => {
    const exit = await overleafWebMcp('unknown')
    expect(exit.code).toBe(1)
    expect(exit.stdout).toBe('')
    expect(errorLine(exit).code).toBe('INVALID_ARGUMENT')
  })

  test('--help exits 0 and prints the help', async () => {
    const exit = await overleafWebMcp('--help')
    expect(exit.code).toBe(0)
    expect(exit.stderr).toBe('')
    expect(exit.stdout).toBe(renderHelp())
  })

  test('schema prints the input schema as one JSON object', async () => {
    const exit = await overleafWebMcp('schema', 'read_file', '--input')
    expect(exit.code).toBe(0)
    expect(exit.stderr).toBe('')
    const schema = JSON.parse(exit.stdout) as Record<string, unknown>
    expect(schema.type).toBe('object')
    expect(schema).toEqual(operationJsonSchema('read_file', 'input'))
  })

  test('schema prints the output schema of get_full_document, source map included', async () => {
    const exit = await overleafWebMcp('schema', 'get_full_document', '--output')
    expect(exit.code).toBe(0)
    expect(exit.stderr).toBe('')
    const schema = JSON.parse(exit.stdout) as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['rootFilePath', 'text', 'sourceMap', 'files', 'unresolved'])
    )
  })

  test('capabilities needs no session', async () => {
    const exit = await overleafWebMcp('capabilities')
    expect(exit.code).toBe(0)
    expect(exit.stderr).toBe('')
    const report = JSON.parse(exit.stdout) as { operations: Array<{ name: string }>; project: { projectId: string } }
    expect(report.operations.map(operation => operation.name)).toEqual([...OPERATION_NAMES])
    expect(report.project.projectId).toBe('unknown')
  })

  test('an operation without a saved session exits 3 with AUTH_EXPIRED', async () => {
    const exit = await overleafWebMcp('call', 'auth_status')
    expect(exit.code).toBe(3)
    expect(exit.stdout).toBe('')
    expect(errorLine(exit).code).toBe('AUTH_EXPIRED')
  })

  test('an unknown option exits 2 naming it', async () => {
    const exit = await overleafWebMcp('files', 'read', 'p', 'main.tex', '--bogus')
    expect(exit.code).toBe(2)
    expect(exit.stdout).toBe('')
    const error = errorLine(exit)
    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(error.message).toContain('--bogus')
  })

  test('serve, under the same hook, is refused the MCP SDK, so the hook is in force', async () => {
    // Without the hook, serve would load the SDK and stop at the missing session with AUTH_EXPIRED.
    const exit = await overleafWebMcp('serve')
    expect(exit.code).toBe(1)
    expect(exit.stdout).toBe('')
    const error = errorLine(exit)
    expect(error.code).not.toBe('AUTH_EXPIRED')
    expect(error.message).toBe(`${REFUSED}@modelcontextprotocol/server`)
  })

  test('nothing was written where a session or configuration would live', async () => {
    expect(await readdir(base)).toEqual([])
  })
})
