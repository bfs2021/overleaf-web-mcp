import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, test } from 'vitest'

import { ALIASES } from '../../src/cli/commands.js'
import { EXIT_CODES } from '../../src/cli/exit-codes.js'
import { operationCommandUsages, renderHelp } from '../../src/cli-command.js'
import * as core from '../../src/sdk.js'

const root = new URL('../../', import.meta.url)

async function text(path: string): Promise<string> {
  return await readFile(new URL(path, root), 'utf8')
}

/** Every line inside a fenced code block. */
function codeLines(markdown: string): string[] {
  return [...markdown.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gmu)].flatMap(match => match[1]!.split('\n'))
}

/** The body of a `## heading` section, up to the next `## ` heading. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`)
  expect(start, `section "${heading}"`).toBeGreaterThanOrEqual(0)
  const end = markdown.indexOf('\n## ', start + 1)
  return markdown.slice(start, end === -1 ? undefined : end)
}

function tableRows(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter(line => line.startsWith('| ') && !line.startsWith('| ---') && !line.startsWith('| :'))
}

function codeSpans(markdown: string): string[] {
  return [...markdown.matchAll(/`([^`]+)`/gu)].map(match => match[1]!)
}

/** Every name `src/sdk.ts` exports, types included, as the compiler resolves it. */
function sdkExports(): Set<string> {
  const entry = fileURLToPath(new URL('src/sdk.ts', root))
  const program = ts.createProgram([entry], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(entry)
  const symbol = source === undefined ? undefined : checker.getSymbolAtLocation(source)
  if (symbol === undefined) throw new Error('src/sdk.ts could not be read as a module')
  return new Set(checker.getExportsOfModule(symbol).map(exported => exported.getName()))
}

describe('docs/cli.md', () => {
  test('shows every command the help prints, word for word', async () => {
    const lines = new Set(codeLines(await text('docs/cli.md')))
    for (const command of ['serve', 'login', 'keepalive', '--help']) {
      expect(lines, command).toContain(`overleaf-web-mcp ${command}`)
    }
    const usages = operationCommandUsages()
    expect(usages.length).toBeGreaterThan(0)
    for (const usage of usages) {
      expect(lines, usage).toContain(`overleaf-web-mcp ${usage}`)
      expect(renderHelp()).toContain(`  overleaf-web-mcp ${usage}\n`)
    }
  })

  test('maps each shorthand command to the tool it builds the input for', async () => {
    const rows = tableRows(section(await text('docs/cli.md'), 'Commands'))
    for (const alias of ALIASES) {
      expect(rows, alias.words.join(' ')).toContainEqual(
        expect.stringMatching(new RegExp(`^\\| \`${alias.words.join(' ')}\` \\| \`${alias.tool}\` \\|`, 'u'))
      )
    }
  })

  test('has one exit-code row per code 0 to 7, naming the error codes src/cli/exit-codes.ts maps to it', async () => {
    const rows = tableRows(section(await text('docs/cli.md'), 'Exit codes'))
    expect(EXIT_CODES.map(entry => entry.exitCode)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(rows.slice(1).map(row => /^\| (\d+) \|/u.exec(row)?.[1])).toEqual(
      EXIT_CODES.map(entry => String(entry.exitCode))
    )
    for (const entry of EXIT_CODES) {
      const row = rows.find(line => line.startsWith(`| ${entry.exitCode} |`))
      for (const code of entry.errorCodes) expect(codeSpans(row!), `exit ${entry.exitCode}`).toContain(code)
    }
  })

  test('is the page the help links to, and both new pages are in the site navigation', async () => {
    expect(renderHelp()).toContain('https://mhmdaskari.github.io/overleaf-web-mcp/cli/')
    const nav = await text('mkdocs.yml')
    expect(nav).toMatch(/^ {2}- Command line: cli\.md$/mu)
    expect(nav).toMatch(/^ {2}- TypeScript SDK: sdk\.md$/mu)
  })
})

describe('docs/sdk.md', () => {
  /** The names docs/sdk.md promises as the stable surface. */
  const PROMISED = [
    'createOverleafClient',
    'createOverleafService',
    'OPERATIONS',
    'OPERATION_NAMES',
    'OperationInput',
    'OperationOutput',
    'OperationContext',
    'EFFECTS',
    'ERROR_CODES',
    'McpError',
    'readConfig',
    'OverleafRuntime',
  ]

  test('lists only names src/sdk.ts exports as its stable surface, and every promised one', async () => {
    const stable = section(await text('docs/sdk.md'), 'Stable surface')
    const listed = tableRows(stable)
      .slice(1)
      .flatMap(row => codeSpans(row.split(' | ')[0]!))
    expect(listed).toEqual(expect.arrayContaining(PROMISED))
    const exported = sdkExports()
    for (const name of listed) expect(exported, name).toContain(name)
  }, 30_000)

  test('names OverleafRuntime.create and close, which the runtime has', async () => {
    const stable = section(await text('docs/sdk.md'), 'Stable surface')
    expect(stable).toContain('`OverleafRuntime.create(config)`')
    expect(stable).toContain('`runtime.close()`')
    expect(typeof core.OverleafRuntime.create).toBe('function')
    expect(typeof core.OverleafRuntime.prototype.close).toBe('function')
    expect(typeof core.createOverleafClient).toBe('function')
    expect(typeof core.createOverleafService).toBe('function')
  })

  test('marks the runtime fields and its test hooks internal, outside the stable table', async () => {
    const stable = section(await text('docs/sdk.md'), 'Stable surface')
    const table = tableRows(stable).join('\n')
    const rest = stable.slice(stable.lastIndexOf('\n| ') + 1)
    for (const name of ['RuntimeDependencies', 'fetcher', 'connectionFactory', 'http', 'documents', 'connections']) {
      expect(rest, name).toContain(`\`${name}\``)
      expect(table, name).not.toContain(`\`${name}\``)
    }
  })
})
