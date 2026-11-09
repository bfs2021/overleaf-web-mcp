import { readFile } from 'node:fs/promises'

import { renderHelp } from '../cli-command.js'
import { readConfig, type AppConfig } from '../config.js'
import type { OperationContext } from '../contracts/context.js'
import type { OperationName } from '../contracts/operations.js'
import { parseOperationInput } from '../contracts/parse.js'
import type { OverleafServiceRuntime } from '../contracts/service.js'
import { asMcpError, McpError } from '../core/errors.js'
import { decodeUtf8Text } from '../core/local-file.js'
import { AccessPolicy, assertPathSafeId } from '../core/policy.js'
import type { AccountApi } from '../overleaf/account.js'
import { OverleafRuntime } from '../runtime.js'
import { createOverleafService } from '../service/operations.js'
import { buildCapabilities, type ProjectLookup } from './capabilities.js'
import { doctorExitCode, runDoctor, type DoctorDependencies } from './doctor.js'
import { exitCodeForError, exitCodeForResult } from './exit-codes.js'
import { operationJsonSchema } from './json-schema.js'
import { parseCommandLine, type OperationCommand, type RequestSource } from './parse.js'

/** The process streams an operation command uses; `src/cli.ts` supplies the real ones. */
export interface CliIo {
  stdout(text: string): void
  stderr(text: string): void
  /** All of stdin. Refuses a terminal, since an operation command never waits for typed input. */
  readStdin(): Promise<Uint8Array>
}

/** A runtime an operation command can run on and must close. */
export type CliRuntime = OverleafServiceRuntime & {
  account: Pick<AccountApi, 'listProjects' | 'findProject'>
  reviewSupport(projectId: string): Promise<{ decide: boolean }>
  close(): Promise<void>
}

export interface CliDependencies {
  env?: NodeJS.ProcessEnv
  createRuntime?: (config: AppConfig) => Promise<CliRuntime>
  /** The transport `doctor` checks, replaced in tests. */
  doctor?: DoctorDependencies
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function parseJsonObject(text: string, source: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // The request may hold document text, so the parser's message, which quotes it, is dropped.
    throw new McpError('INVALID_ARGUMENT', `${source} is not valid JSON.`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new McpError('INVALID_ARGUMENT', `${source} must be a JSON object.`)
  }
  return value as Record<string, unknown>
}

function utf8(bytes: Uint8Array, source: string): string {
  const text = decodeUtf8Text(bytes)
  if (text === undefined) throw new McpError('INVALID_ARGUMENT', `${source} is not valid UTF-8 text.`)
  return text
}

async function readRequest(source: RequestSource, io: CliIo): Promise<Record<string, unknown>> {
  switch (source.from) {
    case 'none':
      return {}
    case 'json':
      return parseJsonObject(source.text, 'The --json request')
    case 'stdin':
      return parseJsonObject(utf8(await io.readStdin(), 'The request on stdin'), 'The request on stdin')
    case 'file': {
      let bytes: Uint8Array
      try {
        bytes = await readFile(source.path)
      } catch (error) {
        // The request is the command's own input, so an unreadable one is a call to fix.
        throw new McpError('INVALID_ARGUMENT', 'The --request file could not be read.', {
          details: { errno: (error as { code?: unknown }).code ?? 'unknown' },
        })
      }
      return parseJsonObject(utf8(bytes, 'The --request file'), 'The --request file')
    }
  }
}

function progressContext(io: CliIo, enabled: boolean): OperationContext {
  if (!enabled) return {}
  return {
    onProgress: async (progress, total, message) => {
      io.stderr(`${JSON.stringify({ progress: { progress, total, message } })}\n`)
      await Promise.resolve()
    },
  }
}

interface Run {
  /** The operation whose failure decides the exit code. */
  operation?: OperationName | undefined
}

async function withRuntime<T>(
  dependencies: CliDependencies,
  run: Run,
  work: (runtime: CliRuntime) => Promise<T>
): Promise<T> {
  const config = readConfig(dependencies.env)
  const create =
    dependencies.createRuntime ?? (async (runtimeConfig: AppConfig) => await OverleafRuntime.create(runtimeConfig))
  // Opening the session only reads (GET /project), so its failure exits as a read's would, even
  // for a command that writes: nothing of the operation was sent yet.
  const operation = run.operation
  run.operation = 'auth_status'
  const runtime = await create(config)
  run.operation = operation
  try {
    return await work(runtime)
  } finally {
    await runtime.close().catch(() => undefined)
  }
}

async function runOperation(
  command: Extract<OperationCommand, { kind: 'call' | 'alias' }>,
  io: CliIo,
  dependencies: CliDependencies,
  run: Run
): Promise<number> {
  run.operation = command.tool
  let raw: Record<string, unknown>
  if (command.kind === 'call') {
    raw = await readRequest(command.request, io)
  } else {
    raw = command.input
    if (command.contentFromStdin === true) raw = { ...raw, content: utf8(await io.readStdin(), 'stdin') }
  }
  // Parsed before any session is opened, so a refused call sends nothing.
  const input = parseOperationInput(command.tool, raw)
  const download =
    command.kind === 'alias' && command.download !== undefined
      ? parseOperationInput('download_compile_output', {
          projectId: input.projectId,
          localPath: command.download.localPath,
          overwrite: command.download.overwrite,
        })
      : undefined
  const context = progressContext(io, command.progress)
  const result = await withRuntime(dependencies, run, async runtime => {
    const service = createOverleafService(runtime)
    const call = service[command.tool] as (input: unknown, context: OperationContext) => Promise<unknown>
    const value = await call(input, context)
    if (download === undefined) return value
    // The build is named explicitly: it is this process's latest, and the result keeps its buildRef.
    const buildRef = (value as { buildRef?: string }).buildRef
    try {
      const saved = await service.download_compile_output(
        buildRef === undefined ? download : { ...download, buildRef },
        context
      )
      return { status: 'complete', compile: value, download: saved }
    } catch (error) {
      // The compile already spent the allowance; its result stays on stdout with the download's error.
      return { status: 'partial', compile: value, download: null, downloadError: asMcpError(error).toJSON() }
    }
  })
  io.stdout(json(result))
  return exitCodeForResult(result)
}

async function runCapabilities(
  projectId: string | undefined,
  io: CliIo,
  dependencies: CliDependencies,
  run: Run
): Promise<number> {
  const config = readConfig(dependencies.env)
  // The policy is resolved as every other command resolves it, local paths only, so a root that
  // does not exist fails here too instead of being reported as configured.
  await AccessPolicy.create({
    allowedProjects: config.allowedProjects,
    localReadRoots: config.localReadRoots,
    localWriteRoots: config.localWriteRoots,
    allowedEffects: config.allowedEffects,
    cookieJarFile: config.cookieJarFile,
    browserProfileDir: config.browserProfileDir,
  })
  let lookup: ProjectLookup | undefined
  if (projectId !== undefined) {
    assertPathSafeId(projectId, 'projectId')
    if (config.allowedProjects !== undefined && !config.allowedProjects.includes(projectId)) {
      lookup = { projectId, denied: true }
    } else {
      // The lookup is the project listing list_projects reads, so its failures exit as that read's would.
      run.operation = 'list_projects'
      lookup = await withRuntime(dependencies, run, async runtime => {
        const summary = await runtime.account.findProject(projectId)
        // Joining the project is a read too, and shows the account online until the socket idles out.
        const review = await runtime.reviewSupport(projectId)
        return { projectId, summary, review }
      })
    }
  }
  io.stdout(json(buildCapabilities(config, lookup)))
  return 0
}

/**
 * Runs an operation command and returns its exit code. Success prints exactly one JSON value on
 * stdout; failure leaves stdout empty and prints one line of `{ code, message, retryable, details? }`
 * on stderr. Nothing here prompts, opens a browser, supplies a confirmation, or retries.
 */
export async function runOperationCommand(
  command: OperationCommand,
  io: CliIo,
  dependencies: CliDependencies = {}
): Promise<number> {
  const run: Run = {}
  try {
    switch (command.kind) {
      case 'help':
        io.stdout(renderHelp())
        return 0
      case 'schema':
        io.stdout(json(operationJsonSchema(command.tool, command.io)))
        return 0
      case 'capabilities':
        return await runCapabilities(command.projectId, io, dependencies, run)
      case 'doctor': {
        if (command.projectId !== undefined) assertPathSafeId(command.projectId, 'projectId')
        const report = await runDoctor(readConfig(dependencies.env), command.projectId, dependencies.doctor)
        io.stdout(json(report))
        return doctorExitCode(report)
      }
      case 'call':
      case 'alias':
        return await runOperation(command, io, dependencies, run)
    }
  } catch (error) {
    const failure = asMcpError(error)
    io.stderr(`${JSON.stringify(failure.toJSON())}\n`)
    return exitCodeForError(failure, run.operation)
  }
}

/**
 * Parses and runs an operation command. `legacy` means the arguments name serve, login, keepalive,
 * help, or an unknown command, which `src/cli.ts` handles as it always has.
 */
export async function runCommandLine(
  argv: string[],
  io: CliIo,
  dependencies: CliDependencies = {}
): Promise<number | 'legacy'> {
  let command
  try {
    command = parseCommandLine(argv)
  } catch (error) {
    const failure = asMcpError(error)
    io.stderr(`${JSON.stringify(failure.toJSON())}\n`)
    return exitCodeForError(failure)
  }
  if (command.kind === 'legacy') return 'legacy'
  return await runOperationCommand(command, io, dependencies)
}
