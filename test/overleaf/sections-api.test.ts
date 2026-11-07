import { describe, expect, test, vi } from 'vitest'
import { McpError } from '../../src/core/errors.js'
import { createRevision } from '../../src/core/revision.js'

import { SectionsApi } from '../../src/overleaf/sections-api.js'

describe('section tools API', () => {
  test('returns single-file section metadata and writes through the document revision', async () => {
    const documents = {
      readFile: vi.fn(async () => ({
        content: '\\section{One}\nOld\n\\section{Two}\nNext\n',
        revision: 'revision',
        newline: 'LF' as const,
        protocol: 'sharejs' as const,
        trackChangesActive: false,
      })),
      writeFile: vi.fn(async () => ({
        revision: 'new-revision',
        protocol: 'sharejs' as const,
        trackChangesActive: false,
        writeMode: 'untracked' as const,
      })),
    }
    const api = new SectionsApi(documents, { getProjectTree: vi.fn() })
    const sections = await api.getSections('project', 'main.tex')

    expect(sections.sections).toHaveLength(2)
    await api.writeSection('project', 'main.tex', 'revision', sections.sections[0]!.id, 'Replacement\n', 'tracked')
    expect(documents.writeFile).toHaveBeenCalledWith(
      'project',
      'main.tex',
      'revision',
      '\\section{One}\nReplacement\n\\section{Two}\nNext\n',
      'tracked'
    )
  })

  test('does not turn a heading commented out after a line break into a live one', async () => {
    const content = String.raw`\section{Edge}
Line break then comment \\% \section{Commented After Linebreak}
\section{Next}
`
    const documents = {
      readFile: vi.fn(async () => ({
        content,
        revision: 'revision',
        newline: 'LF' as const,
        protocol: 'sharejs' as const,
        trackChangesActive: false,
      })),
      writeFile: vi.fn(async () => ({
        revision: 'new-revision',
        protocol: 'sharejs' as const,
        trackChangesActive: false,
        writeMode: 'untracked' as const,
      })),
    }
    const api = new SectionsApi(documents, { getProjectTree: vi.fn() })
    const { sections } = await api.getSections('project', 'main.tex')
    expect(sections.map(section => section.title)).toEqual(['Edge', 'Next'])

    await api.writeSection('project', 'main.tex', 'revision', sections[0]!.id, 'New body.\n')
    expect(documents.writeFile).toHaveBeenCalledWith(
      'project',
      'main.tex',
      'revision',
      '\\section{Edge}\nNew body.\n\\section{Next}\n',
      'untracked'
    )
  })
})

/** An in-memory project whose writes are revision-checked as Overleaf's are. */
function includedProject(files: Record<string, string>) {
  const documents = new Map(Object.entries(files).map(([path, content]) => [path, { content, version: 1 }]))
  const revisionOf = (path: string) => {
    const document = documents.get(path)!
    return createRevision({
      projectId: 'p',
      docId: path,
      protocol: 'sharejs',
      otVersion: document.version,
      content: document.content,
    })
  }
  const api = {
    readFile: vi.fn(async (_projectId: string, filePath: string) => {
      const document = documents.get(filePath)
      if (document === undefined) throw new McpError('NOT_FOUND', 'missing')
      return {
        content: document.content,
        revision: revisionOf(filePath),
        newline: 'LF' as const,
        protocol: 'sharejs' as const,
        trackChangesActive: false,
      }
    }),
    writeFile: vi.fn(async (_projectId: string, filePath: string, revision: string, content: string) => {
      const document = documents.get(filePath)!
      if (revision !== revisionOf(filePath)) throw new McpError('REVISION_CONFLICT', 'The document changed.')
      document.content = content
      document.version += 1
      return {
        revision: revisionOf(filePath),
        protocol: 'sharejs' as const,
        trackChangesActive: false,
        writeMode: 'untracked' as const,
      }
    }),
  }
  const tree = {
    entities: [...documents.keys()].map((path, index) => ({ id: `doc-${index}`, path, type: 'doc' as const })),
    rootDocPath: 'main.tex',
  }
  const sections = new SectionsApi(api, { getProjectTree: vi.fn(async () => tree) })
  return { documents, api, sections, revisionOf }
}

const SPLIT = {
  'main.tex': [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\section{Introduction}',
    'Opening words.',
    '\\input{sections/background}',
    '\\section{Methods}',
    '\\input{sections/methods}',
    '\\end{document}',
    '',
  ].join('\n'),
  'sections/background.tex': '\\subsection{Background}\nPrior work.\n',
  'sections/methods.tex': 'We measured.\n\\subsection{Setup}\nThe setup.\n',
}

describe('section tools with followIncludes', () => {
  test('lists the headings of every included file, each in its own file', async () => {
    const { sections, revisionOf } = includedProject(SPLIT)
    const result = await sections.getSections('p', 'main.tex', { followIncludes: true })
    expect(result.singleFileOnly).toBe(false)
    expect(result).toMatchObject({ revision: revisionOf('main.tex'), unresolved: [] })
    expect(
      result.sections.map(section => {
        const included = section as typeof section & { filePath: string; spansFiles: boolean }
        return [section.title, included.filePath, included.spansFiles, section.id]
      })
    ).toEqual([
      ['Introduction', 'main.tex', true, `main.tex#section:${SPLIT['main.tex'].indexOf('\\section{Introduction}')}`],
      ['Background', 'sections/background.tex', false, 'sections/background.tex#subsection:0'],
      ['Methods', 'main.tex', true, `main.tex#section:${SPLIT['main.tex'].indexOf('\\section{Methods}')}`],
      ['Setup', 'sections/methods.tex', false, 'sections/methods.tex#subsection:13'],
    ])
  })

  test('reads and writes a section that lies in one included file, through that file only', async () => {
    const { sections, documents, api, revisionOf } = includedProject(SPLIT)
    const listed = await sections.getSections('p', 'main.tex', { followIncludes: true })
    const background = listed.sections.find(section => section.title === 'Background') as unknown as {
      id: string
      revision: string
    }
    const read = await sections.getSectionContent('p', 'main.tex', background.id, { followIncludes: true })
    expect(read).toMatchObject({ content: 'Prior work.\n', revision: revisionOf('sections/background.tex') })

    const written = await sections.writeSection(
      'p',
      'main.tex',
      background.revision,
      background.id,
      'Newer work.\n',
      'untracked',
      { followIncludes: true }
    )
    expect(documents.get('sections/background.tex')!.content).toBe('\\subsection{Background}\nNewer work.\n')
    expect(written).toMatchObject({
      filePath: 'sections/background.tex',
      revision: revisionOf('sections/background.tex'),
    })
    expect(documents.get('main.tex')!.content).toBe(SPLIT['main.tex'])
    expect(api.writeFile).toHaveBeenCalledTimes(1)
  })

  test('the last section of an included file reads to the end of that file, not into the next', async () => {
    const { sections } = includedProject(SPLIT)
    const read = await sections.getSectionContent('p', 'main.tex', 'sections/methods.tex#subsection:13', {
      followIncludes: true,
    })
    expect(read.content).toBe('The setup.\n')
  })

  test('refuses a section that spans files before anything is sent, and names the files', async () => {
    const { sections, api, revisionOf } = includedProject(SPLIT)
    const read = await sections.getSectionContent('p', 'main.tex', 'main.tex#section:41', { followIncludes: true })
    // Reading a spanning section gives the flattened body, for reading only.
    expect(read.content).toBe('Opening words.\n\\subsection{Background}\nPrior work.\n\n')
    const failure = await sections
      .writeSection('p', 'main.tex', revisionOf('main.tex'), 'main.tex#section:41', 'x\n', 'untracked', {
        followIncludes: true,
      })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { kind: 'spans_files', files: ['main.tex', 'sections/background.tex'] },
    })
    expect(api.writeFile).not.toHaveBeenCalled()
  })

  test('a file changed after the sections were listed is REVISION_CONFLICT, and nothing is written', async () => {
    const { sections, documents } = includedProject(SPLIT)
    const listed = await sections.getSections('p', 'main.tex', { followIncludes: true })
    const setup = listed.sections.find(section => section.title === 'Setup') as unknown as {
      id: string
      revision: string
    }
    // A collaborator edits the included file in between.
    const methods = documents.get('sections/methods.tex')!
    methods.content = 'We measured twice.\n\\subsection{Setup}\nThe setup.\n'
    methods.version += 1

    const failure = await sections
      .writeSection('p', 'main.tex', setup.revision, setup.id, 'Changed.\n', 'untracked', { followIncludes: true })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(methods.content).toBe('We measured twice.\n\\subsection{Setup}\nThe setup.\n')
  })

  test('an id that names a file needs followIncludes, and a single-file id names the start file', async () => {
    const { sections } = includedProject(SPLIT)
    const failure = await sections
      .getSectionContent('p', 'main.tex', 'sections/background.tex#subsection:0')
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/followIncludes: true/u) })
    const single = await sections.getSectionContent('p', 'main.tex', 'section:41', { followIncludes: true })
    expect(single.section).toMatchObject({ title: 'Introduction', filePath: 'main.tex' })
  })

  test('get_full_document defaults to the root document and returns the public source map', async () => {
    const { sections } = includedProject(SPLIT)
    const full = await sections.getFullDocument('p')
    expect(full.rootFilePath).toBe('main.tex')
    expect(full.files).toEqual(['main.tex', 'sections/background.tex', 'sections/methods.tex'])
    expect(full.text).toContain('Opening words.\n\\subsection{Background}\nPrior work.\n\n\\section{Methods}')
    expect(Object.keys(full.sourceMap[0]!).sort()).toEqual(
      ['docId', 'filePath', 'flattenedEnd', 'flattenedStart', 'originalEnd', 'originalStart', 'revision'].sort()
    )
    expect(full).not.toHaveProperty('includeOnly')
  })

  test('get_full_document refuses a binary root, a missing root, and a project without one', async () => {
    const { api } = includedProject(SPLIT)
    const withTree = (tree: {
      entities: { id: string; path: string; type: 'doc' | 'file' | 'folder' }[]
      rootDocPath?: string
    }) => new SectionsApi(api, { getProjectTree: vi.fn(async () => tree) })
    const entities = [
      { id: 'd', path: 'main.tex', type: 'doc' as const },
      { id: 'f', path: 'figure.png', type: 'file' as const },
    ]
    await expect(withTree({ entities }).getFullDocument('p')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(withTree({ entities }).getFullDocument('p', 'figure.png')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(withTree({ entities }).getFullDocument('p', 'other.tex')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(api.readFile).not.toHaveBeenCalled()
  })
})

describe('section tools with followIncludes: edge cases', () => {
  test('a comment on an included file’s last line does not hide the heading after the directive', async () => {
    const { sections } = includedProject({
      'main.tex': '\\input{intro}\\input{methods}\n\\input{c}\\section{C}\nend\n',
      'intro.tex': '\\section{Intro}\nHello.\n% end of intro',
      'methods.tex': '\\section{Methods}\nWe did.\n',
      'c.tex': 'c\n%c',
    })
    const result = await sections.getSections('p', 'main.tex', { followIncludes: true })
    expect(result.sections.map(section => section.title)).toEqual(['Intro', 'Methods', 'C'])
  })

  test('a heading with an include inside it cannot be written, even when the included file is empty', async () => {
    const { sections, api, revisionOf } = includedProject({
      'main.tex': '\\section{Intro \\input{e}}\nold body\n\\section{B}\nx\n',
      'e.tex': '',
    })
    const listed = await sections.getSections('p', 'main.tex', { followIncludes: true })
    expect(listed.sections[0]).toMatchObject({ id: 'main.tex#section:0', spansFiles: true })
    const failure = await sections
      .writeSection('p', 'main.tex', revisionOf('main.tex'), 'main.tex#section:0', 'new\n', 'untracked', {
        followIncludes: true,
      })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'INVALID_ARGUMENT', details: { kind: 'spans_files' } })
    expect(api.writeFile).not.toHaveBeenCalled()
  })

  test('a heading whose file ends inside it spans files, and its body never ends before it starts', async () => {
    const { sections, api, revisionOf } = includedProject({
      'main.tex': '\\input{a}{Title}\nBody\n',
      'a.tex': '\\section',
    })
    const listed = await sections.getSections('p', 'main.tex', { followIncludes: true })
    const [section] = listed.sections as Array<{ spansFiles: boolean; bodyStart: number; end: number }>
    expect(section).toMatchObject({ spansFiles: true })
    expect(section!.end).toBeGreaterThanOrEqual(section!.bodyStart)
    const failure = await sections
      .writeSection('p', 'main.tex', revisionOf('a.tex'), 'a.tex#section:0', 'NEW\n', 'untracked', {
        followIncludes: true,
      })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'INVALID_ARGUMENT', details: { kind: 'spans_files' } })
    expect(api.writeFile).not.toHaveBeenCalled()
  })

  test('a stale revision carries the live one, and a malformed one is INVALID_ARGUMENT as on one file', async () => {
    const { sections, documents, revisionOf } = includedProject(SPLIT)
    const stale = revisionOf('sections/background.tex')
    documents.get('sections/background.tex')!.version += 1
    const conflict = await sections
      .writeSection('p', 'main.tex', stale, 'sections/background.tex#subsection:0', 'x\n', 'untracked', {
        followIncludes: true,
      })
      .catch((error: unknown) => error)
    expect(conflict).toMatchObject({
      code: 'REVISION_CONFLICT',
      details: { filePath: 'sections/background.tex', liveRevision: revisionOf('sections/background.tex') },
    })
    const malformed = await sections
      .writeSection('p', 'main.tex', 'garbage', 'sections/background.tex#subsection:0', 'x\n', 'untracked', {
        followIncludes: true,
      })
      .catch((error: unknown) => error)
    expect(malformed).toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  test('a tracked write reaches the included file as tracked, never untracked', async () => {
    const { sections, api, revisionOf } = includedProject(SPLIT)
    await sections.writeSection(
      'p',
      'main.tex',
      revisionOf('sections/background.tex'),
      'sections/background.tex#subsection:0',
      'Tracked.\n',
      'tracked',
      { followIncludes: true }
    )
    expect(api.writeFile).toHaveBeenCalledWith(
      'p',
      'sections/background.tex',
      expect.any(String),
      '\\subsection{Background}\nTracked.\n',
      'tracked'
    )
  })

  test('get_full_document returns the \\includeonly list it applied', async () => {
    const { sections } = includedProject({
      'main.tex': '\\includeonly{a}\n\\include{a}\\include{b}',
      'a.tex': 'A',
      'b.tex': 'B',
    })
    const full = await sections.getFullDocument('p', 'main.tex')
    expect(full.includeOnly).toEqual(['a'])
    expect(full.unresolved).toEqual([{ file: 'main.tex', line: 2, target: 'b', reason: 'excluded_by_includeonly' }])
  })
})
