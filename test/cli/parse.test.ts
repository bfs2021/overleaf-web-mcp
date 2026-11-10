import { describe, expect, test } from 'vitest'

import { ALIASES } from '../../src/cli/commands.js'
import { parseCommandLine } from '../../src/cli/parse.js'
import { OPERATION_NAMES } from '../../src/contracts/operations.js'

function usage(argv: string[]): unknown {
  try {
    parseCommandLine(argv)
  } catch (error) {
    return error
  }
  throw new Error(`parsed: ${argv.join(' ')}`)
}

describe('CLI command line', () => {
  test.each([[[]], [['serve']], [['login']], [['keepalive']], [['--help']], [['unknown']], [['login', '--x']]])(
    'leaves %j to the server and session commands',
    argv => {
      expect(parseCommandLine(argv)).toEqual({ kind: 'legacy' })
    }
  )

  test('reads call with each request source', () => {
    expect(parseCommandLine(['call', 'auth_status'])).toEqual({
      kind: 'call',
      tool: 'auth_status',
      request: { from: 'none' },
      progress: false,
    })
    expect(parseCommandLine(['call', 'read_file', '--request', 'r.json'])).toMatchObject({
      request: { from: 'file', path: 'r.json' },
    })
    expect(parseCommandLine(['call', 'read_file', '--request', '-'])).toMatchObject({ request: { from: 'stdin' } })
    expect(parseCommandLine(['call', 'sync_directory', '--json', '{}', '--progress'])).toMatchObject({
      request: { from: 'json', text: '{}' },
      progress: true,
    })
  })

  test('refuses an unknown tool, two request sources, and stray arguments', () => {
    for (const argv of [
      ['call'],
      ['call', 'nope'],
      ['call', 'read_file', '--request', 'a', '--json', '{}'],
      ['call', 'read_file', 'extra'],
      ['schema', 'read_file'],
      ['schema', 'read_file', '--input', '--output'],
      ['capabilities', 'a', 'b'],
      ['files', 'rename', 'p'],
      ['files', 'read', 'p'],
      ['files', 'read', 'p', 'a', 'b'],
    ]) {
      expect(usage(argv), argv.join(' ')).toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
  })

  test('names an unknown option but never echoes a value', () => {
    const secret = 'Some manuscript sentence'
    const error = usage(['files', 'read', 'p', 'main.tex', '--contents', secret]) as Error
    expect(error.message).toContain('--contents')
    expect(error.message).not.toContain(secret)
    const missing = usage(['files', 'write', 'p', 'main.tex', '--revision']) as Error
    expect(missing).toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  test('builds each alias input, leaving defaults to the contract', () => {
    expect(
      parseCommandLine(['projects', 'list', '--query', 'Thesis', '--limit', '5', '--include-trashed'])
    ).toMatchObject({
      kind: 'alias',
      tool: 'list_projects',
      input: { query: 'Thesis', limit: 5, includeTrashed: true },
    })
    expect(parseCommandLine(['projects', 'list', '--include-tags', '--tag', 'Thesis'])).toMatchObject({
      tool: 'list_projects',
      input: { includeTags: true, tag: 'Thesis' },
    })
    expect(parseCommandLine(['tree', 'p'])).toMatchObject({ tool: 'get_project_tree', input: { projectId: 'p' } })
    expect(
      parseCommandLine(['files', 'write', 'p', 'main.tex', '--revision', 'r', '--content-file', 'new.tex', '--tracked'])
    ).toMatchObject({
      tool: 'write_file',
      input: { projectId: 'p', filePath: 'main.tex', revision: 'r', localPath: 'new.tex', writeMode: 'tracked' },
    })
    const fromStdin = parseCommandLine(['files', 'write', 'p', 'main.tex', '--revision', 'r', '--stdin'])
    expect(fromStdin).toMatchObject({ tool: 'write_file', contentFromStdin: true })
    expect((fromStdin as { input: object }).input).not.toHaveProperty('writeMode')
    expect(parseCommandLine(['files', 'download', 'p', 'fig.png', './fig.png', '--overwrite'])).toMatchObject({
      tool: 'download_file',
      input: { projectId: 'p', filePath: 'fig.png', localPath: './fig.png', overwrite: true },
    })
    expect(
      parseCommandLine([
        'sync',
        'plan',
        'p',
        './paper',
        '--destination',
        'src',
        '--ignore',
        '*.pdf',
        '--ignore',
        'out/',
        '--progress',
      ])
    ).toMatchObject({
      tool: 'plan_sync',
      input: { projectId: 'p', localFolderPath: './paper', destinationFolderPath: 'src', ignore: ['*.pdf', 'out/'] },
      progress: true,
    })
    expect(
      parseCommandLine([
        'sync',
        'apply',
        'p',
        './paper',
        '--mode',
        'mirror',
        '--plan-token',
        't',
        '--confirm-delete-count',
        '2',
        '--stop-on-error',
      ])
    ).toMatchObject({
      tool: 'sync_directory',
      input: { mode: 'mirror', planToken: 't', confirmDeleteCount: 2, stopOnError: true },
    })
    expect(
      parseCommandLine(['compile', 'run', 'p', '--root', 'paper.tex', '--download', 'out.pdf', '--overwrite'])
    ).toMatchObject({
      tool: 'compile_project',
      input: { projectId: 'p', rootFilePath: 'paper.tex' },
      download: { localPath: 'out.pdf', overwrite: true },
    })
    expect(
      parseCommandLine(['compile', 'log', 'p', '--build-ref', 'b', '--tail', '50', '--errors-only'])
    ).toMatchObject({
      tool: 'get_compile_log',
      input: { projectId: 'p', buildRef: 'b', tail: 50, format: 'errors-only' },
    })
    expect(
      parseCommandLine(['compile', 'download', 'p', 'out.pdf', '--build-ref', 'b', '--file', 'output.log'])
    ).toMatchObject({
      tool: 'download_compile_output',
      input: { projectId: 'p', localPath: 'out.pdf', buildRef: 'b', file: 'output.log' },
    })
    expect(parseCommandLine(['comments', 'list', 'p', '--status', 'all', '--file', 'main.tex'])).toMatchObject({
      tool: 'list_comments',
      input: { projectId: 'p', status: 'all', filePath: 'main.tex' },
    })
    expect(
      parseCommandLine([
        'tracked-changes',
        'list',
        'p',
        '--file',
        'main.tex',
        '--type',
        'delete',
        '--author',
        'u1',
        '--limit',
        '20',
        '--excerpt-chars',
        '0',
      ])
    ).toEqual({
      kind: 'alias',
      command: 'tracked-changes list',
      tool: 'list_tracked_changes',
      input: { projectId: 'p', filePath: 'main.tex', type: 'delete', authorId: 'u1', limit: 20, excerptChars: 0 },
      progress: false,
    })
    for (const action of ['accept', 'reject'] as const) {
      expect(
        parseCommandLine([
          'tracked-changes',
          action,
          'p',
          'main.tex',
          '--revision',
          'r',
          '--change',
          'c1',
          '--change',
          'c2',
          '--confirm-count',
          '2',
        ])
      ).toEqual({
        kind: 'alias',
        command: `tracked-changes ${action}`,
        tool: 'manage_tracked_changes',
        input: {
          projectId: 'p',
          filePath: 'main.tex',
          revision: 'r',
          action,
          changeIds: ['c1', 'c2'],
          confirmCount: 2,
        },
        progress: false,
      })
    }
    // A missing --confirm-count is the operation's to refuse, so it is left out, never filled in.
    expect(
      parseCommandLine(['tracked-changes', 'accept', 'p', 'main.tex', '--revision', 'r', '--change', 'c1'])
    ).toMatchObject({ input: { changeIds: ['c1'] } })
    expect(
      parseCommandLine(['tracked-changes', 'accept', 'p', 'main.tex', '--revision', 'r', '--change', 'c1'])
    ).not.toHaveProperty('input.confirmCount')
  })

  test('refuses an alias call that cannot be right, before any operation', () => {
    for (const argv of [
      ['files', 'write', 'p', 'main.tex', '--revision', 'r'],
      ['files', 'write', 'p', 'main.tex', '--revision', 'r', '--stdin', '--content-file', 'x'],
      ['compile', 'log', 'p'],
      ['compile', 'download', 'p', 'out.pdf'],
      ['compile', 'run', 'p', '--overwrite'],
      ['projects', 'list', '--limit', 'ten'],
      ['sync', 'apply', 'p', '.', '--mode', 'mirror', '--confirm-delete-count', '-1'],
      ['tracked-changes', 'accept', 'p', 'main.tex', '--revision', 'r', '--change', 'c', '--confirm-count', 'one'],
      ['tracked-changes', 'list', 'p', '--excerpt-chars', '1.5'],
      ['tracked-changes', 'decide', 'p'],
      ['tracked-changes', 'reject', 'p', '--revision', 'r', '--change', 'c', '--confirm-count', '1'],
    ]) {
      expect(usage(argv), argv.join(' ')).toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
  })

  test('every alias targets a real operation, and --help is help everywhere', () => {
    for (const alias of ALIASES) {
      expect(OPERATION_NAMES).toContain(alias.tool)
      expect(parseCommandLine([...alias.words, '--help'])).toEqual({ kind: 'help' })
    }
    expect(parseCommandLine(['call', '--help'])).toEqual({ kind: 'help' })
    // Help wins over an option the command does not take, or one missing its value.
    expect(parseCommandLine(['call', 'read_file', '--bogus', '--help'])).toEqual({ kind: 'help' })
    expect(parseCommandLine(['files', 'read', '--bogus', '-h'])).toEqual({ kind: 'help' })
    expect(parseCommandLine(['files', 'write', 'p', 'm', '--revision', '--help'])).toEqual({ kind: 'help' })
    expect(parseCommandLine(['files', '-h'])).toEqual({ kind: 'help' })
  })
})
