import { parseArgs, type ParseArgsConfig } from 'node:util'

import { OPERATION_NAMES, type OperationName } from '../contracts/operations.js'
import { ALIASES, OPERATION_COMMAND_WORDS, usageError, type AliasCall, type AliasCommand } from './commands.js'

/** Where `call` reads its request from. */
export type RequestSource =
  { from: 'none' } | { from: 'file'; path: string } | { from: 'stdin' } | { from: 'json'; text: string }

export type OperationCommand =
  | { kind: 'help' }
  | { kind: 'call'; tool: OperationName; request: RequestSource; progress: boolean }
  | { kind: 'schema'; tool: OperationName; io: 'input' | 'output' }
  | { kind: 'capabilities'; projectId?: string }
  | { kind: 'doctor'; projectId?: string }
  | ({ kind: 'alias'; command: string } & AliasCall)

/** `legacy` hands the arguments, untouched, to `parseCliCommand`: serve, login, keepalive, and help. */
export type ParsedCommandLine = { kind: 'legacy' } | OperationCommand

const HELP = { help: { type: 'boolean', short: 'h' } } as const

function isOperationName(value: string): value is OperationName {
  return (OPERATION_NAMES as readonly string[]).includes(value)
}

function toolName(value: string | undefined, command: string): OperationName {
  if (value === undefined) throw usageError(`${command} needs a tool name.`)
  if (!isOperationName(value)) {
    throw usageError(`${command}: unknown tool. Run \`overleaf-web-mcp capabilities\` for the tool names.`)
  }
  return value
}

/** Option names are short and the caller's own; values never appear in a message. */
function optionName(message: string): string {
  const match = /'(--?[A-Za-z][A-Za-z0-9-]{0,40})/u.exec(message)
  return match?.[1] ?? 'an option'
}

/**
 * Runs `parseArgs` strictly, and turns its failures into usage errors that name the option but
 * never echo a value, since a misplaced value could be document text.
 */
function parse(
  args: string[],
  options: NonNullable<ParseArgsConfig['options']>,
  command: string
): { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: { ...options, ...HELP },
      strict: true,
      allowPositionals: true,
    })
    return { values, positionals }
  } catch (error) {
    const code = (error as { code?: unknown }).code
    const message = error instanceof Error ? error.message : ''
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') throw usageError(`${command} does not take ${optionName(message)}.`)
    if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      throw usageError(`${command}: ${optionName(message)} needs a value, or takes none.`)
    }
    throw usageError(`${command}: the arguments could not be read.`)
  }
}

function expectPositionals(positionals: string[], names: readonly string[], command: string): void {
  if (positionals.length !== names.length) {
    const expected = names.length === 0 ? 'no arguments' : names.map(name => `<${name}>`).join(' ')
    throw usageError(
      `${command} takes ${expected}; got ${positionals.length} argument${positionals.length === 1 ? '' : 's'}.`
    )
  }
}

function findAlias(argv: string[]): AliasCommand | undefined {
  return ALIASES.find(alias => alias.words.every((word, index) => argv[index] === word))
}

function parseCall(args: string[]): OperationCommand {
  const { values, positionals } = parse(
    args,
    { request: { type: 'string' }, json: { type: 'string' }, progress: { type: 'boolean' } },
    'call'
  )
  if (values.help === true) return { kind: 'help' }
  if (positionals.length > 1) throw usageError('call takes one tool name.')
  const tool = toolName(positionals[0], 'call')
  const request = values.request
  const json = values.json
  if (request !== undefined && json !== undefined) throw usageError('call takes --request or --json, not both.')
  let source: RequestSource = { from: 'none' }
  if (typeof request === 'string') source = request === '-' ? { from: 'stdin' } : { from: 'file', path: request }
  if (typeof json === 'string') source = { from: 'json', text: json }
  return { kind: 'call', tool, request: source, progress: values.progress === true }
}

function parseSchema(args: string[]): OperationCommand {
  const { values, positionals } = parse(args, { input: { type: 'boolean' }, output: { type: 'boolean' } }, 'schema')
  if (values.help === true) return { kind: 'help' }
  if (positionals.length > 1) throw usageError('schema takes one tool name.')
  const tool = toolName(positionals[0], 'schema')
  if ((values.input === true) === (values.output === true))
    throw usageError('schema takes exactly one of --input or --output.')
  return { kind: 'schema', tool, io: values.input === true ? 'input' : 'output' }
}

function parseCapabilities(args: string[]): OperationCommand {
  const { values, positionals } = parse(args, {}, 'capabilities')
  if (values.help === true) return { kind: 'help' }
  if (positionals.length > 1) throw usageError('capabilities takes at most one projectId.')
  return positionals[0] === undefined ? { kind: 'capabilities' } : { kind: 'capabilities', projectId: positionals[0] }
}

function parseDoctor(args: string[]): OperationCommand {
  const { values, positionals } = parse(args, {}, 'doctor')
  if (values.help === true) return { kind: 'help' }
  if (positionals.length > 1) throw usageError('doctor takes at most one projectId.')
  return positionals[0] === undefined ? { kind: 'doctor' } : { kind: 'doctor', projectId: positionals[0] }
}

/**
 * Reads the command line of an operation command. Any other first word (serve, login, keepalive,
 * help, or an unknown command) is left to `parseCliCommand`, which keeps its own behaviour.
 */
export function parseCommandLine(argv: string[]): ParsedCommandLine {
  const first = argv[0]
  if (first === undefined || !OPERATION_COMMAND_WORDS.has(first)) return { kind: 'legacy' }
  // --help or -h anywhere before a -- separator wins, even over an option the command does not take.
  const end = argv.indexOf('--')
  const head = end === -1 ? argv : argv.slice(0, end)
  if (head.includes('--help') || head.includes('-h')) return { kind: 'help' }
  if (first === 'call') return parseCall(argv.slice(1))
  if (first === 'schema') return parseSchema(argv.slice(1))
  if (first === 'capabilities') return parseCapabilities(argv.slice(1))
  if (first === 'doctor') return parseDoctor(argv.slice(1))
  const alias = findAlias(argv)
  if (alias === undefined) {
    const known = ALIASES.filter(candidate => candidate.words[0] === first).map(candidate => candidate.words.join(' '))
    throw usageError(`Unknown ${first} command; use one of: ${known.join(', ')}.`)
  }
  const command = alias.words.join(' ')
  const { values, positionals } = parse(argv.slice(alias.words.length), alias.options, command)
  if (values.help === true) return { kind: 'help' }
  expectPositionals(positionals, alias.positionals, command)
  return { kind: 'alias', command, ...alias.build(positionals, values) }
}
