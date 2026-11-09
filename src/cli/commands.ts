import type { ParseArgsConfig } from 'node:util'

import type { OperationName } from '../contracts/operations.js'
import { McpError } from '../core/errors.js'

type OptionValues = Record<string, string | boolean | string[] | undefined>
type Options = NonNullable<ParseArgsConfig['options']>

/** What an alias asks the runner to do: one operation call, built from its arguments. */
export interface AliasCall {
  tool: OperationName
  input: Record<string, unknown>
  /** Read the document text for `content` from stdin. */
  contentFromStdin?: true
  /** `compile run --download`: save output.pdf from the same build afterwards. */
  download?: { localPath: string; overwrite: boolean }
  progress: boolean
}

/**
 * A shorthand that only builds an operation's input. Its result, errors, and exit codes are those
 * of `call <tool>` with the same input; anything an alias does not cover goes through `call`.
 */
export interface AliasCommand {
  words: readonly [string, ...string[]]
  tool: OperationName
  usage: string
  summary: string
  positionals: readonly string[]
  options: Options
  build(positionals: string[], values: OptionValues): AliasCall
}

/** A usage error: the call never reaches an operation, and the command exits 2. */
export function usageError(message: string): McpError {
  return new McpError('INVALID_ARGUMENT', `${message} Run \`overleaf-web-mcp --help\` for usage.`)
}

function wholeNumber(values: OptionValues, name: string): number | undefined {
  const value = values[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d{1,15}$/u.test(value)) {
    throw usageError(`--${name} must be a whole number.`)
  }
  return Number(value)
}

function text(values: OptionValues, name: string): string | undefined {
  const value = values[name]
  return typeof value === 'string' ? value : undefined
}

function flag(values: OptionValues, name: string): boolean {
  return values[name] === true
}

function list(values: OptionValues, name: string): string[] | undefined {
  const value = values[name]
  return Array.isArray(value) ? value : undefined
}

/** Leaves out every field whose value is undefined, so the contract's defaults apply. */
function defined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

function call(tool: OperationName, input: Record<string, unknown>, extra: Partial<AliasCall> = {}): AliasCall {
  return { tool, input: defined(input), progress: false, ...extra }
}

/** `tracked-changes accept` and `tracked-changes reject`, which differ only in the action. */
function decisionAlias(action: 'accept' | 'reject', summary: string): AliasCommand {
  return {
    words: ['tracked-changes', action],
    tool: 'manage_tracked_changes',
    usage: `tracked-changes ${action} <projectId> <path> --revision <r> --change <id>... --confirm-count <n>`,
    summary,
    positionals: ['projectId', 'path'],
    options: {
      revision: { type: 'string' },
      change: { type: 'string', multiple: true },
      'confirm-count': { type: 'string' },
    },
    // A missing --confirm-count is left to the operation, which refuses it with CONFIRMATION_MISMATCH.
    build: ([projectId, filePath], values) =>
      call('manage_tracked_changes', {
        projectId,
        filePath,
        revision: text(values, 'revision'),
        action,
        changeIds: list(values, 'change'),
        confirmCount: wholeNumber(values, 'confirm-count'),
      }),
  }
}

export const ALIASES: readonly AliasCommand[] = [
  {
    words: ['projects', 'list'],
    tool: 'list_projects',
    usage:
      'projects list [--query <q>] [--limit <n>] [--sort lastUpdated|name] [--include-archived] [--include-trashed]',
    summary: 'List and search projects, newest first',
    positionals: [],
    options: {
      query: { type: 'string' },
      limit: { type: 'string' },
      sort: { type: 'string' },
      'include-archived': { type: 'boolean' },
      'include-trashed': { type: 'boolean' },
    },
    build: (_positionals, values) =>
      call('list_projects', {
        query: text(values, 'query'),
        limit: wholeNumber(values, 'limit'),
        sort: text(values, 'sort'),
        includeArchived: flag(values, 'include-archived') || undefined,
        includeTrashed: flag(values, 'include-trashed') || undefined,
      }),
  },
  {
    words: ['tree'],
    tool: 'get_project_tree',
    usage: 'tree <projectId>',
    summary: 'Read the file tree with the root document and compiler',
    positionals: ['projectId'],
    options: {},
    build: ([projectId]) => call('get_project_tree', { projectId }),
  },
  {
    words: ['files', 'read'],
    tool: 'read_file',
    usage: 'files read <projectId> <path>',
    summary: 'Read a text document and its revision',
    positionals: ['projectId', 'path'],
    options: {},
    build: ([projectId, filePath]) => call('read_file', { projectId, filePath }),
  },
  {
    words: ['files', 'write'],
    tool: 'write_file',
    usage: 'files write <projectId> <path> --revision <r> (--content-file <f> | --stdin) [--tracked]',
    summary: 'Replace a document with a revision-checked edit; the text never goes in argv',
    positionals: ['projectId', 'path'],
    options: {
      revision: { type: 'string' },
      'content-file': { type: 'string' },
      stdin: { type: 'boolean' },
      tracked: { type: 'boolean' },
    },
    build: ([projectId, filePath], values) => {
      const contentFile = text(values, 'content-file')
      const fromStdin = flag(values, 'stdin')
      if ((contentFile === undefined) === !fromStdin) {
        throw usageError('files write takes exactly one of --content-file <f> or --stdin.')
      }
      return call(
        'write_file',
        {
          projectId,
          filePath,
          revision: text(values, 'revision'),
          // A file is read by the operation itself, so the local-read policy covers it.
          localPath: contentFile,
          writeMode: flag(values, 'tracked') ? 'tracked' : undefined,
        },
        fromStdin ? { contentFromStdin: true } : {}
      )
    },
  },
  {
    words: ['files', 'download'],
    tool: 'download_file',
    usage: 'files download <projectId> <path> <localPath> [--overwrite]',
    summary: 'Save a document or binary file locally',
    positionals: ['projectId', 'path', 'localPath'],
    options: { overwrite: { type: 'boolean' } },
    build: ([projectId, filePath, localPath], values) =>
      call('download_file', { projectId, filePath, localPath, overwrite: flag(values, 'overwrite') || undefined }),
  },
  {
    words: ['sync', 'plan'],
    tool: 'plan_sync',
    usage: 'sync plan <projectId> <localFolder> [--destination <path>] [--ignore <glob>]... [--verbose] [--progress]',
    summary: 'Compare a local folder with a project folder, changing nothing',
    positionals: ['projectId', 'localFolder'],
    options: {
      destination: { type: 'string' },
      ignore: { type: 'string', multiple: true },
      verbose: { type: 'boolean' },
      progress: { type: 'boolean' },
    },
    build: ([projectId, localFolderPath], values) =>
      call(
        'plan_sync',
        {
          projectId,
          localFolderPath,
          destinationFolderPath: text(values, 'destination'),
          ignore: list(values, 'ignore'),
          verbose: flag(values, 'verbose') || undefined,
        },
        { progress: flag(values, 'progress') }
      ),
  },
  {
    words: ['sync', 'apply'],
    tool: 'sync_directory',
    usage:
      'sync apply <projectId> <localFolder> --mode additive|mirror (--plan-token <t> | --unplanned) [--destination <path>] [--ignore <glob>]... [--confirm-delete-count <n>] [--tracked] [--stop-on-error] [--progress]',
    summary: 'Apply a plan: upload what changed, and in mirror mode delete what is gone locally',
    positionals: ['projectId', 'localFolder'],
    options: {
      mode: { type: 'string' },
      'plan-token': { type: 'string' },
      unplanned: { type: 'boolean' },
      destination: { type: 'string' },
      ignore: { type: 'string', multiple: true },
      'confirm-delete-count': { type: 'string' },
      tracked: { type: 'boolean' },
      'stop-on-error': { type: 'boolean' },
      progress: { type: 'boolean' },
    },
    build: ([projectId, localFolderPath], values) =>
      call(
        'sync_directory',
        {
          projectId,
          localFolderPath,
          mode: text(values, 'mode'),
          planToken: text(values, 'plan-token'),
          unplanned: flag(values, 'unplanned') || undefined,
          destinationFolderPath: text(values, 'destination'),
          ignore: list(values, 'ignore'),
          confirmDeleteCount: wholeNumber(values, 'confirm-delete-count'),
          writeMode: flag(values, 'tracked') ? 'tracked' : undefined,
          stopOnError: flag(values, 'stop-on-error') || undefined,
        },
        { progress: flag(values, 'progress') }
      ),
  },
  {
    words: ['compile', 'run'],
    tool: 'compile_project',
    usage:
      'compile run <projectId> [--root <path>] [--draft] [--stop-on-first-error] [--download <localPath>] [--overwrite]',
    summary: 'Compile and report the build; --download also saves its PDF',
    positionals: ['projectId'],
    options: {
      root: { type: 'string' },
      draft: { type: 'boolean' },
      'stop-on-first-error': { type: 'boolean' },
      download: { type: 'string' },
      overwrite: { type: 'boolean' },
    },
    build: ([projectId], values) => {
      const localPath = text(values, 'download')
      if (localPath === undefined && flag(values, 'overwrite')) {
        throw usageError('--overwrite applies only with --download <localPath>.')
      }
      return call(
        'compile_project',
        {
          projectId,
          rootFilePath: text(values, 'root'),
          draft: flag(values, 'draft') || undefined,
          stopOnFirstError: flag(values, 'stop-on-first-error') || undefined,
        },
        localPath === undefined ? {} : { download: { localPath, overwrite: flag(values, 'overwrite') } }
      )
    },
  },
  {
    words: ['compile', 'log'],
    tool: 'get_compile_log',
    usage: 'compile log <projectId> --build-ref <r> [--tail <n>] [--kind latex|bibtex] [--errors-only]',
    summary: "Read a build's LaTeX or BibTeX log without compiling again",
    positionals: ['projectId'],
    options: {
      'build-ref': { type: 'string' },
      tail: { type: 'string' },
      kind: { type: 'string' },
      'errors-only': { type: 'boolean' },
    },
    build: ([projectId], values) => {
      const buildRef = text(values, 'build-ref')
      // A new process has no latest build, so the build is always named.
      if (buildRef === undefined) throw usageError('compile log needs --build-ref <r> from compile run.')
      return call('get_compile_log', {
        projectId,
        buildRef,
        tail: wholeNumber(values, 'tail'),
        kind: text(values, 'kind'),
        format: flag(values, 'errors-only') ? 'errors-only' : undefined,
      })
    },
  },
  {
    words: ['compile', 'download'],
    tool: 'download_compile_output',
    usage: 'compile download <projectId> <localPath> --build-ref <r> [--file <f>] [--overwrite]',
    summary: "Save a build's PDF, or another output file, locally",
    positionals: ['projectId', 'localPath'],
    options: {
      'build-ref': { type: 'string' },
      file: { type: 'string' },
      overwrite: { type: 'boolean' },
    },
    build: ([projectId, localPath], values) => {
      const buildRef = text(values, 'build-ref')
      if (buildRef === undefined) throw usageError('compile download needs --build-ref <r> from compile run.')
      return call('download_compile_output', {
        projectId,
        localPath,
        buildRef,
        file: text(values, 'file'),
        overwrite: flag(values, 'overwrite') || undefined,
      })
    },
  },
  {
    words: ['comments', 'list'],
    tool: 'list_comments',
    usage: 'comments list <projectId> [--status open|resolved|all] [--file <path>] [--author <a>]',
    summary: 'List review threads with their locations',
    positionals: ['projectId'],
    options: {
      status: { type: 'string' },
      file: { type: 'string' },
      author: { type: 'string' },
    },
    build: ([projectId], values) =>
      call('list_comments', {
        projectId,
        status: text(values, 'status'),
        filePath: text(values, 'file'),
        author: text(values, 'author'),
      }),
  },
  {
    words: ['tracked-changes', 'list'],
    tool: 'list_tracked_changes',
    usage:
      'tracked-changes list <projectId> [--file <path>] [--type insert|delete] [--author <id>] [--limit <n>] [--excerpt-chars <n>]',
    summary: 'List tracked changes with their locations and the revision to decide them with',
    positionals: ['projectId'],
    options: {
      file: { type: 'string' },
      type: { type: 'string' },
      author: { type: 'string' },
      limit: { type: 'string' },
      'excerpt-chars': { type: 'string' },
    },
    build: ([projectId], values) =>
      call('list_tracked_changes', {
        projectId,
        filePath: text(values, 'file'),
        type: text(values, 'type'),
        authorId: text(values, 'author'),
        limit: wholeNumber(values, 'limit'),
        excerptChars: wholeNumber(values, 'excerpt-chars'),
      }),
  },
  decisionAlias('accept', 'Accept tracked changes in one document: keep inserted text, remove deleted text'),
  decisionAlias('reject', 'Reject tracked changes in one document: remove inserted text, restore deleted text'),
]

/** The generic commands, which reach every operation and describe the contracts. */
export const GENERIC_USAGE = [
  {
    usage: 'call <tool_name> [--request <file> | --request - | --json <object>] [--progress]',
    summary: 'Run any operation with a JSON request; prints its result',
  },
  { usage: 'schema <tool_name> (--input | --output)', summary: "Print an operation's input or output JSON Schema" },
  { usage: 'capabilities [projectId]', summary: 'List operations, effects, the access policy, and exit codes' },
  {
    usage: 'doctor [projectId]',
    summary: 'Check, read-only, that the session, Overleaf, and a project socket work with this release',
  },
] as const

/** The first words that select an operation command; anything else is a server or session command. */
export const OPERATION_COMMAND_WORDS: ReadonlySet<string> = new Set([
  'call',
  'schema',
  'capabilities',
  'doctor',
  ...ALIASES.map(alias => alias.words[0]),
])
