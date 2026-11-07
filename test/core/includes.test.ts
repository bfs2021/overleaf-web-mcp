import { describe, expect, test, vi } from 'vitest'

import { McpError } from '../../src/core/errors.js'
import {
  candidatePaths,
  findIncludeDirectives,
  flattenDocument,
  mapFlattenedRange,
  type IncludeEntity,
  type IncludeLoader,
} from '../../src/core/includes.js'

/** A project of text documents by path, plus any binary files and folders named. */
function project(docs: Record<string, string>, binaries: string[] = []): IncludeLoader & { reads: string[] } {
  const entities: IncludeEntity[] = [
    ...Object.keys(docs).map((path, index) => ({ id: `doc-${index + 1}`, path, type: 'doc' as const })),
    ...binaries.map((path, index) => ({ id: `file-${index + 1}`, path, type: 'file' as const })),
  ]
  const reads: string[] = []
  return {
    entities,
    reads,
    read: vi.fn(async (path: string) => {
      reads.push(path)
      const content = docs[path]
      if (content === undefined) throw new McpError('NOT_FOUND', `Project path was not found: ${path}`)
      return { content, revision: `rev:${path}` }
    }),
  }
}

async function failure(work: Promise<unknown>): Promise<McpError> {
  try {
    await work
  } catch (error) {
    if (error instanceof McpError) return error
    throw error
  }
  throw new Error('expected a failure')
}

describe('findIncludeDirectives', () => {
  test('finds every directive kind with its line and span, joining an import folder and file', () => {
    const source = [
      String.raw`\includeonly{chapters/one, two}`,
      String.raw`\input{intro}\include{chapters/one}`,
      String.raw`\subfile{parts/a.tex}`,
      String.raw`\import{figures/}{plot}`,
      String.raw`\subimport*{sub}{deep}`,
      String.raw`\inputfrom{x}{y} \subinputfrom{z/}{w} \includefrom{a}{b} \subincludefrom{c}{d}`,
      String.raw`\input bare.tex`,
    ].join('\n')
    const directives = findIncludeDirectives(source)
    expect(
      directives.map(({ command, kind, target, relativeFirst, line }) => ({
        command,
        kind,
        target,
        relativeFirst,
        line,
      }))
    ).toEqual([
      { command: 'includeonly', kind: 'includeonly', target: 'chapters/one, two', relativeFirst: false, line: 1 },
      { command: 'input', kind: 'input', target: 'intro', relativeFirst: false, line: 2 },
      { command: 'include', kind: 'include', target: 'chapters/one', relativeFirst: false, line: 2 },
      { command: 'subfile', kind: 'subfile', target: 'parts/a.tex', relativeFirst: false, line: 3 },
      { command: 'import', kind: 'input', target: 'figures/plot', relativeFirst: false, line: 4 },
      { command: 'subimport', kind: 'input', target: 'sub/deep', relativeFirst: true, line: 5 },
      { command: 'inputfrom', kind: 'input', target: 'x/y', relativeFirst: false, line: 6 },
      { command: 'subinputfrom', kind: 'input', target: 'z/w', relativeFirst: true, line: 6 },
      { command: 'includefrom', kind: 'include', target: 'a/b', relativeFirst: false, line: 6 },
      { command: 'subincludefrom', kind: 'include', target: 'c/d', relativeFirst: true, line: 6 },
      { command: 'input', kind: 'input', target: 'bare.tex', relativeFirst: false, line: 7 },
    ])
    const first = directives[1]!
    expect(source.slice(first.start, first.end)).toBe(String.raw`\input{intro}`)
    const bare = directives.at(-1)!
    expect(source.slice(bare.start, bare.end)).toBe(String.raw`\input bare.tex`)
  })

  test('skips comments, verbatim text, a line break before the name, and longer command names', () => {
    const source = [
      String.raw`% \input{commented}`,
      String.raw`text \% \input{live} % \include{trailing}`,
      String.raw`\begin{verbatim}`,
      String.raw`\input{verbatim}`,
      String.raw`\end{verbatim}`,
      String.raw`\verb|\input{inline}|`,
      String.raw`\\input{not-a-directive} \inputencoding{utf8} \includegraphics{fig} \input@path`,
      String.raw`\\\input{after-break}`,
    ].join('\n')
    expect(findIncludeDirectives(source).map(directive => directive.target)).toEqual(['live', 'after-break'])
  })
})

describe('candidatePaths', () => {
  test('tries the project root, then the including folder; \\input adds .tex, \\include always means .tex', () => {
    expect(candidatePaths({ kind: 'input', target: 'intro', relativeFirst: false }, 'chapters/main.tex')).toEqual([
      'intro',
      'intro.tex',
      'chapters/intro',
      'chapters/intro.tex',
    ])
    expect(candidatePaths({ kind: 'include', target: 'one', relativeFirst: false }, 'main.tex')).toEqual(['one.tex'])
    expect(candidatePaths({ kind: 'input', target: 'a.tex', relativeFirst: false }, 'main.tex')).toEqual(['a.tex'])
    expect(candidatePaths({ kind: 'input', target: 'deep', relativeFirst: true }, 'sub/x.tex')).toEqual([
      'sub/deep',
      'sub/deep.tex',
      'deep',
      'deep.tex',
    ])
  })

  test('never leaves the project, and accepts a quoted name with spaces', () => {
    expect(candidatePaths({ kind: 'input', target: '../outside', relativeFirst: false }, 'main.tex')).toEqual([])
    expect(candidatePaths({ kind: 'input', target: '/etc/passwd', relativeFirst: false }, 'main.tex')).toEqual([])
    expect(candidatePaths({ kind: 'input', target: '../up', relativeFirst: false }, 'a/b.tex')).toEqual([
      'up',
      'up.tex',
    ])
    expect(candidatePaths({ kind: 'input', target: '"my file"', relativeFirst: false }, 'main.tex')).toEqual([
      'my file',
      'my file.tex',
    ])
  })
})

describe('flattenDocument', () => {
  test('replaces nested directives with file text and maps every run back to its file', async () => {
    const docs = {
      'main.tex': 'A\\input{intro}B\\include{chapters/one}C',
      'intro.tex': 'intro\n',
      'chapters/one.tex': 'one[\\input{two}]',
      'chapters/two.tex': 'two',
    }
    const loader = project(docs)
    const flat = await flattenDocument('main.tex', loader)
    expect(flat.text).toBe('Aintro\nBone[two]C')
    expect(flat.files).toEqual(['main.tex', 'intro.tex', 'chapters/one.tex', 'chapters/two.tex'])
    expect(flat.unresolved).toEqual([])
    // Every run is the file's own text at the recorded offsets, with its revision and id.
    for (const segment of flat.segments) {
      const content = docs[segment.filePath as keyof typeof docs]
      expect(flat.text.slice(segment.flattenedStart, segment.flattenedEnd)).toBe(
        content.slice(segment.originalStart, segment.originalEnd)
      )
      expect(segment.revision).toBe(`rev:${segment.filePath}`)
      expect(segment.docId).toMatch(/^doc-\d$/u)
    }
    // Runs are contiguous and cover the whole text.
    expect(flat.segments[0]!.flattenedStart).toBe(0)
    for (let index = 1; index < flat.segments.length; index += 1) {
      expect(flat.segments[index]!.flattenedStart).toBe(flat.segments[index - 1]!.flattenedEnd)
    }
    expect(flat.segments.at(-1)!.flattenedEnd).toBe(flat.text.length)
    // A range across files maps to one clipped entry per run.
    const start = flat.text.indexOf('ro\nB')
    expect(
      mapFlattenedRange(flat.segments, start, start + 4).map(({ filePath, originalStart, originalEnd }) => ({
        filePath,
        originalStart,
        originalEnd,
      }))
    ).toEqual([
      { filePath: 'intro.tex', originalStart: 3, originalEnd: 6 },
      { filePath: 'main.tex', originalStart: 14, originalEnd: 15 },
    ])
  })

  test('reads a file included twice once, and maps both visits', async () => {
    const loader = project({ 'main.tex': '\\input{m}|\\input{m}', 'm.tex': 'x' })
    const flat = await flattenDocument('main.tex', loader)
    expect(flat.text).toBe('x|x')
    expect(loader.reads).toEqual(['main.tex', 'm.tex'])
    expect(flat.files).toEqual(['main.tex', 'm.tex'])
    expect(new Set(flat.segments.filter(segment => segment.filePath === 'm.tex').map(s => s.instance)).size).toBe(2)
  })

  test('reports what it cannot follow and leaves those directives as written', async () => {
    const main = [
      '\\input{missing}',
      '\\input{figure.pdf}',
      '\\newcommand{\\chap}[1]{\\input{#1}}',
      '\\input{\\dir/x}',
      '\\input{../escape}',
    ].join('\n')
    const flat = await flattenDocument('main.tex', project({ 'main.tex': main }, ['figure.pdf']))
    expect(flat.text).toBe(main)
    expect(flat.unresolved).toEqual([
      { file: 'main.tex', line: 1, target: 'missing', reason: 'missing' },
      { file: 'main.tex', line: 2, target: 'figure.pdf', reason: 'binary_file' },
      { file: 'main.tex', line: 3, target: '#1', reason: 'macro_argument' },
      { file: 'main.tex', line: 4, target: '\\dir/x', reason: 'macro_argument' },
      { file: 'main.tex', line: 5, target: '../escape', reason: 'missing' },
    ])
  })

  test('follows a document whose name is also a reason, such as "missing"', async () => {
    const flat = await flattenDocument('main.tex', project({ 'main.tex': '\\input{missing}', missing: 'found' }))
    expect(flat.text).toBe('found')
    expect(flat.unresolved).toEqual([])
  })

  test('respects \\includeonly for \\include only, and keeps the list', async () => {
    const main = '\\includeonly{a}\n\\include{a}\\include{b}\\input{b}'
    const flat = await flattenDocument('main.tex', project({ 'main.tex': main, 'a.tex': 'A', 'b.tex': 'B' }))
    expect(flat.text).toBe('\\includeonly{a}\nA\\include{b}B')
    expect(flat.includeOnly).toEqual(['a'])
    expect(flat.unresolved).toEqual([{ file: 'main.tex', line: 2, target: 'b', reason: 'excluded_by_includeonly' }])
  })

  test('takes only the document body of a \\subfile, and resolves paths from the including folder', async () => {
    const flat = await flattenDocument(
      'main.tex',
      project({
        'main.tex': 'before\\subfile{parts/p}after',
        'parts/p.tex':
          '\\documentclass[../main]{subfiles}\n\\input{ignored}\n\\begin{document}\nBody \\input{local}\n\\end{document}\n',
        'parts/local.tex': 'L',
      })
    )
    expect(flat.text).toBe('before\nBody L\nafter')
    expect(flat.files).toEqual(['main.tex', 'parts/p.tex', 'parts/local.tex'])
    expect(flat.unresolved).toEqual([])
  })

  test('a \\subfile ends at its first \\end{document}, as LaTeX reads it, ignoring anything parked after', async () => {
    const loader = project({
      'main.tex': '\\begin{document}\n\\subfile{s}\n\\end{document}\n',
      's.tex':
        '\\documentclass[main]{subfiles}\n\\begin{document}\nReal\n\\end{document}\n\\section{Old draft}\n\\input{old}\n\\end{document}\n',
      'old.tex': 'OLD',
    })
    const flat = await flattenDocument('main.tex', loader)
    expect(flat.text).toBe('\\begin{document}\n\nReal\n\n\\end{document}\n')
    expect(flat.files).toEqual(['main.tex', 's.tex'])
  })

  test('an unbraced \\input of a macro is listed as a macro argument and left as written', async () => {
    const main = 'a\n\\input\\chapterfile\n\\input \\jobname.bbl\nb\n'
    const flat = await flattenDocument('main.tex', project({ 'main.tex': main }))
    expect(flat.text).toBe(main)
    expect(flat.unresolved).toEqual([
      { file: 'main.tex', line: 2, target: '\\chapterfile', reason: 'macro_argument' },
      { file: 'main.tex', line: 3, target: '\\jobname.bbl', reason: 'macro_argument' },
    ])
  })

  test('\\input used as a token, or followed by a name on the next line, includes nothing', async () => {
    const source = [
      '\\let\\oldinput\\input',
      '\\renewcommand{\\input}[1]{\\oldinput{#1}}',
      '\\let\\input\\@@input',
      '\\ifx\\input\\undefined\\fi',
      '\\input',
      '\\section{Not a file}',
    ].join('\n')
    expect(findIncludeDirectives(source)).toEqual([])
  })

  test('masks each file on its own, so a comment on an included last line stops at that file', async () => {
    const flat = await flattenDocument(
      'main.tex',
      project({ 'main.tex': '\\input{a}\\section{After}\n', 'a.tex': 'A\n% last line, no newline' })
    )
    expect(flat.text).toBe('A\n% last line, no newline\\section{After}\n')
    expect(flat.masked).toHaveLength(flat.text.length)
    expect(flat.masked).toContain('\\section{After}')
    expect(flat.masked).not.toContain('last line')
  })

  test('include fan-out that emits no text is bounded by a visit budget, not run to exhaustion', async () => {
    // Ten includes per file, ten levels deep: 10^10 visits without a budget, and no text at all.
    const docs: Record<string, string> = { 'f10.tex': '' }
    for (let level = 0; level < 10; level += 1) docs[`f${level}.tex`] = `\\input{f${level + 1}}`.repeat(10)
    const error = await failure(flattenDocument('f0.tex', project(docs)))
    expect(error.code).toBe('DOC_TOO_LARGE')
    expect(error.details).toEqual({ kind: 'includes', limit: 10_000 })
    const small = await failure(flattenDocument('f0.tex', project(docs), { maxVisits: 5 }))
    expect(small.details).toEqual({ kind: 'includes', limit: 5 })
  })

  test('a cycle is INCLUDE_CYCLE with the chain, before reading the repeated file again', async () => {
    const loader = project({ 'main.tex': '\\input{a}', 'a.tex': '\\input{b}', 'b.tex': '\\input{a}' })
    const error = await failure(flattenDocument('main.tex', loader))
    expect(error.code).toBe('INCLUDE_CYCLE')
    expect(error.details).toEqual({ chain: ['a.tex', 'b.tex', 'a.tex'] })
    expect(loader.reads).toEqual(['main.tex', 'a.tex', 'b.tex'])
    const self = await failure(flattenDocument('main.tex', project({ 'main.tex': 'x\\input{main}' })))
    expect(self.details).toEqual({ chain: ['main.tex', 'main.tex'] })
  })

  test('nesting deeper than maxDepth is INCLUDE_DEPTH_EXCEEDED, and exactly maxDepth is fine', async () => {
    const docs = { 'main.tex': '\\input{1}', '1.tex': '\\input{2}', '2.tex': '\\input{3}', '3.tex': 'end' }
    expect((await flattenDocument('main.tex', project(docs), { maxDepth: 3 })).text).toBe('end')
    const error = await failure(flattenDocument('main.tex', project(docs), { maxDepth: 2 }))
    expect(error.code).toBe('INCLUDE_DEPTH_EXCEEDED')
    expect(error.details).toEqual({ maxDepth: 2, chain: ['main.tex', '1.tex', '2.tex', '3.tex'] })
  })

  test('a flattened text over the limit is DOC_TOO_LARGE', async () => {
    const docs = { 'main.tex': '\\input{a}\\input{a}\\input{a}', 'a.tex': 'x'.repeat(10) }
    const error = await failure(flattenDocument('main.tex', project(docs), { maxLength: 25 }))
    expect(error.code).toBe('DOC_TOO_LARGE')
    expect(error.details).toEqual({ kind: 'flattened', limit: 25 })
    // maxDepth cannot shorten the result, so the message does not suggest it.
    expect(error.message).not.toMatch(/maxDepth/u)
  })
})
