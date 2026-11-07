import { posix } from 'node:path'

import { McpError } from './errors.js'
import { backslashesBefore, maskIgnored, readBalanced, skipWhitespace } from './sections.js'

/** How deep includes are followed when the caller names no depth. */
export const DEFAULT_INCLUDE_DEPTH = 10
/** The deepest a caller may ask includes to be followed. */
export const MAX_INCLUDE_DEPTH = 32
/** The longest flattened text returned, in UTF-16 code units, however many files it takes in. */
export const MAX_FLATTENED_LENGTH = 8 * 1024 * 1024
/**
 * The most file visits one flatten makes, counting a file once for each time it is included. It
 * bounds the work, and the source map, of an include graph that fans out without emitting text.
 */
export const MAX_INCLUDE_VISITS = 10_000

/**
 * What a directive pulls in: `input` the named file, `include` the named `.tex` file (subject to
 * `\includeonly`), `subfile` the body of a `subfiles` document, and `includeonly` names the
 * files `\include` may take in.
 */
type DirectiveKind = 'input' | 'include' | 'subfile' | 'includeonly'

/** One include directive found in a file, outside comments and verbatim text. */
export interface IncludeDirective {
  command: string
  kind: DirectiveKind
  /** The path as written: for `\import{dir}{file}` and its relatives, the two joined. */
  target: string
  /** Resolve against the including file's folder before the project root (`\subimport`). */
  relativeFirst: boolean
  start: number
  end: number
  /** 1-based line of the directive in its file. */
  line: number
}

const DIRECTIVE_COMMANDS: Record<string, { kind: DirectiveKind; folderArgument?: 'root' | 'relative' }> = {
  input: { kind: 'input' },
  include: { kind: 'include' },
  includeonly: { kind: 'includeonly' },
  subfile: { kind: 'subfile' },
  import: { kind: 'input', folderArgument: 'root' },
  inputfrom: { kind: 'input', folderArgument: 'root' },
  includefrom: { kind: 'include', folderArgument: 'root' },
  subimport: { kind: 'input', folderArgument: 'relative' },
  subinputfrom: { kind: 'input', folderArgument: 'relative' },
  subincludefrom: { kind: 'include', folderArgument: 'relative' },
}

// \input as the operand of an assignment or a test, as in `\let\oldinput\input` or `\ifx\input\undefined`.
const TOKEN_CONTEXT =
  /\\(?:let|ifx|def|gdef|edef|xdef|show|meaning|string|noexpand|expandafter)\s*(?:\\[A-Za-z@]+\s*=?\s*)?$/u

// A name that continues with a letter or `@` is another command, such as \inputencoding or \input@path.
const DIRECTIVE_PATTERN = new RegExp(String.raw`\\(${Object.keys(DIRECTIVE_COMMANDS).join('|')})(?![A-Za-z@])\*?`, 'gu')

function lineAt(source: string, index: number): number {
  let line = 1
  for (let cursor = source.indexOf('\n'); cursor !== -1 && cursor < index; cursor = source.indexOf('\n', cursor + 1)) {
    line += 1
  }
  return line
}

function joinFolder(folder: string, file: string): string {
  const trimmed = folder.trim()
  if (trimmed === '') return file
  return trimmed.endsWith('/') ? `${trimmed}${file}` : `${trimmed}/${file}`
}

/**
 * Finds `\input`, `\include`, `\includeonly`, `\subfile`, and the `import` package's `\import`,
 * `\subimport`, `\inputfrom`, `\subinputfrom`, `\includefrom`, and `\subincludefrom`, in order,
 * skipping `%` comments and verbatim text as the section parser does. `\input` also takes the
 * unbraced TeX form, `\input chapter`.
 */
export function findIncludeDirectives(source: string, masked = maskIgnored(source)): IncludeDirective[] {
  const directives: IncludeDirective[] = []
  for (const match of masked.matchAll(DIRECTIVE_PATTERN)) {
    const start = match.index
    // After an odd run, this backslash ends a `\\` line break, so the name that follows is text.
    if (backslashesBefore(masked, start) % 2 === 1) continue
    const command = match[1]!
    // A command used as a token, not called, includes nothing.
    if (TOKEN_CONTEXT.test(masked.slice(Math.max(0, start - 64), start))) continue
    const { kind, folderArgument } = DIRECTIVE_COMMANDS[command]!
    let cursor = skipWhitespace(masked, start + match[0].length)
    let folder: string | undefined
    if (folderArgument !== undefined) {
      const folderRange = readBalanced(masked, cursor, '{', '}')
      if (!folderRange) continue
      folder = source.slice(cursor + 1, folderRange.end - 1)
      cursor = skipWhitespace(masked, folderRange.end)
    }
    let target: string
    let end: number
    const argument = readBalanced(masked, cursor, '{', '}')
    if (argument) {
      target = source.slice(cursor + 1, argument.end - 1)
      end = argument.end
    } else if (command === 'input' && !masked.slice(start + match[0].length, cursor).includes('\n')) {
      // `\input chapter`, or `\input\jobname.tex`, which is listed as a macro argument. The
      // unbraced name must be on the same line, so a command on the next line is never taken for one.
      const bare = /[^\s{}%\\]+|\\(?:[A-Za-z@]+|.)[^\s{}%\\]*/uy
      bare.lastIndex = cursor
      const name = bare.exec(masked)?.[0]
      if (name === undefined) continue
      target = source.slice(cursor, cursor + name.length)
      end = cursor + name.length
    } else {
      continue
    }
    directives.push({
      command,
      kind,
      target: folder === undefined ? target.trim() : joinFolder(folder, target.trim()),
      relativeFirst: folderArgument === 'relative',
      start,
      end,
      line: lineAt(source, start),
    })
  }
  return directives
}

/** Why a directive was left in the flattened text as written instead of replaced. */
export type UnresolvedReason = 'missing' | 'binary_file' | 'macro_argument' | 'excluded_by_includeonly'

export interface UnresolvedInclude {
  /** The file holding the directive. */
  file: string
  line: number
  target: string
  reason: UnresolvedReason
}

/** A run of flattened text copied unchanged from one file. */
export interface SourceMapEntry {
  flattenedStart: number
  flattenedEnd: number
  filePath: string
  docId: string
  originalStart: number
  originalEnd: number
  revision: string
}

/** A source-map entry plus the visit it came from, since one file can be included twice. */
export interface FlattenedSegment extends SourceMapEntry {
  instance: number
}

export interface IncludeEntity {
  id: string
  path: string
  type: 'doc' | 'file' | 'folder'
}

export interface LoadedDocument {
  content: string
  revision: string
  docId: string
}

/** The project the flattener reads from: its tree, and a reader for one text document. */
export interface IncludeLoader {
  entities: readonly IncludeEntity[]
  read(path: string): Promise<{ content: string; revision: string }>
}

export interface FlattenedDocument {
  rootFilePath: string
  text: string
  /**
   * `text` with each file's comments and verbatim text blanked as that file alone reads, so a `%`
   * comment on a file's last line never runs on into the text that follows the directive.
   */
  masked: string
  segments: FlattenedSegment[]
  /** Every file visited, each once, in the order first visited. */
  files: string[]
  unresolved: UnresolvedInclude[]
  /** The files `\includeonly` allows, when a visited file names them. */
  includeOnly?: string[]
  /** The content and revision each visited file was read at, by path. */
  documents: Map<string, LoadedDocument>
  /** Each visit by number: the file and the flattened range it produced, nested includes included. */
  visits: FlattenedVisit[]
}

export interface FlattenedVisit {
  filePath: string
  flattenedStart: number
  flattenedEnd: number
}

function stripQuotes(target: string): string {
  return target.length >= 2 && target.startsWith('"') && target.endsWith('"') ? target.slice(1, -1) : target
}

/** Normalizes a path relative to the project root, or undefined when it leaves the project. */
function projectPath(base: string, target: string): string | undefined {
  if (target.startsWith('/')) return undefined
  const joined = posix.normalize(posix.join(base, target)).replace(/^\.\//u, '')
  if (joined === '.' || joined === '..' || joined.startsWith('../')) return undefined
  return joined
}

function folderOf(path: string): string {
  const folder = posix.dirname(path)
  return folder === '.' ? '' : folder
}

/**
 * The paths a directive may name, in the order they are tried: relative to the project root and
 * then to the including file's folder (the other way round for `\subimport`); `\input` and
 * `\subfile` try the name as written and then with `.tex`, while `\include` always means `.tex`.
 */
export function candidatePaths(
  directive: Pick<IncludeDirective, 'kind' | 'target' | 'relativeFirst'>,
  includer: string
): string[] {
  const target = stripQuotes(directive.target)
  const folders = directive.relativeFirst ? [folderOf(includer), ''] : ['', folderOf(includer)]
  const candidates: string[] = []
  for (const folder of folders) {
    const path = projectPath(folder, target)
    if (path === undefined) continue
    const names = path.endsWith('.tex')
      ? [path]
      : directive.kind === 'include'
        ? [`${path}.tex`]
        : [path, `${path}.tex`]
    for (const name of names) if (!candidates.includes(name)) candidates.push(name)
  }
  return candidates
}

function includeOnlyName(name: string): string {
  return (projectPath('', stripQuotes(name.trim())) ?? name.trim()).replace(/\.tex$/u, '')
}

/**
 * The region of a `subfiles` document that `\subfile` takes in: its document body, up to the first
 * `\end{document}` after `\begin{document}` as LaTeX reads it, or the whole file without one.
 */
function subfileBody(content: string, masked: string): [number, number] {
  const live = (pattern: RegExp): number[] =>
    [...masked.matchAll(pattern)].map(match => match.index).filter(index => backslashesBefore(masked, index) % 2 === 0)
  const begins = live(/\\begin\s*\{document\}/gu)
  const ends = live(/\\end\s*\{document\}/gu)
  const begin = begins[0]
  const end = begin === undefined ? undefined : ends.find(index => index > begin)
  if (begin === undefined || end === undefined) return [0, content.length]
  const beginEnd = /\\begin\s*\{document\}/uy
  beginEnd.lastIndex = begin
  beginEnd.exec(masked)
  return [beginEnd.lastIndex, end]
}

/**
 * Flattens a document latexpand-style: every resolvable include directive is replaced by the text
 * it takes in, recursively, and the source map records where each run of the result came from. A
 * directive that cannot be followed stays as written and is listed in `unresolved`. The page
 * breaks `\include` adds are not inserted, so every character of the result comes from a file.
 */
export async function flattenDocument(
  rootFilePath: string,
  loader: IncludeLoader,
  options: { maxDepth?: number; maxLength?: number; maxVisits?: number } = {}
): Promise<FlattenedDocument> {
  const maxDepth = options.maxDepth ?? DEFAULT_INCLUDE_DEPTH
  const maxLength = options.maxLength ?? MAX_FLATTENED_LENGTH
  const maxVisits = options.maxVisits ?? MAX_INCLUDE_VISITS
  const byPath = new Map(loader.entities.map(entity => [entity.path, entity]))
  const documents = new Map<string, LoadedDocument>()
  const pending = new Map<string, Promise<LoadedDocument>>()
  const segments: FlattenedSegment[] = []
  const files: string[] = []
  const unresolved: UnresolvedInclude[] = []
  let includeOnly: Set<string> | undefined
  let includeOnlyList: string[] | undefined
  let length = 0
  const visits: FlattenedVisit[] = []
  const parts: string[] = []
  const maskedParts: string[] = []
  // A file's text is fixed for the whole flatten, so it is masked and scanned once however often it is included.
  const scans = new Map<string, { masked: string; directives: IncludeDirective[] }>()
  const scan = (path: string, content: string) => {
    let scanned = scans.get(path)
    if (scanned === undefined) {
      const masked = maskIgnored(content)
      scanned = { masked, directives: findIncludeDirectives(content, masked) }
      scans.set(path, scanned)
    }
    return scanned
  }

  const load = async (path: string): Promise<LoadedDocument> => {
    let loading = pending.get(path)
    if (loading === undefined) {
      const entity = byPath.get(path)
      loading = loader.read(path).then(read => {
        const document = { content: read.content, revision: read.revision, docId: entity?.id ?? '' }
        documents.set(path, document)
        return document
      })
      pending.set(path, loading)
    }
    return await loading
  }

  const emit = (path: string, document: LoadedDocument, instance: number, from: number, to: number): void => {
    if (to <= from) return
    if (length + (to - from) > maxLength) {
      throw new McpError(
        'DOC_TOO_LARGE',
        `The flattened document would be longer than ${maxLength} UTF-16 code units. Start from a file further down the includes, or read the included files one at a time with read_file.`,
        { details: { kind: 'flattened', limit: maxLength } }
      )
    }
    segments.push({
      flattenedStart: length,
      flattenedEnd: length + (to - from),
      filePath: path,
      docId: document.docId,
      originalStart: from,
      originalEnd: to,
      revision: document.revision,
      instance,
    })
    parts.push(document.content.slice(from, to))
    maskedParts.push(scan(path, document.content).masked.slice(from, to))
    length += to - from
  }

  const resolve = (directive: IncludeDirective, includer: string): { path: string } | { reason: UnresolvedReason } => {
    if (/[\\#]/u.test(directive.target)) return { reason: 'macro_argument' }
    let binary = false
    for (const candidate of candidatePaths(directive, includer)) {
      const entity = byPath.get(candidate)
      if (entity?.type === 'doc') return { path: candidate }
      if (entity?.type === 'file') binary = true
    }
    return { reason: binary ? 'binary_file' : 'missing' }
  }

  const visit = async (path: string, chain: string[], subfile = false) => {
    if (chain.includes(path)) {
      const cycle = [...chain.slice(chain.indexOf(path)), path]
      throw new McpError('INCLUDE_CYCLE', `The include directives form a cycle: ${cycle.join(' -> ')}.`, {
        details: { chain: cycle },
      })
    }
    // The root file is depth 0, so maxDepth counts the levels of includes below it.
    if (chain.length > maxDepth) {
      throw new McpError(
        'INCLUDE_DEPTH_EXCEEDED',
        `Includes nest deeper than maxDepth ${maxDepth}: ${[...chain, path].join(' -> ')}.`,
        { details: { maxDepth, chain: [...chain, path] } }
      )
    }
    if (visits.length >= maxVisits) {
      throw new McpError(
        'DOC_TOO_LARGE',
        `The include directives take in files more than ${maxVisits} times in all. Start from a file further down the includes, or read the included files one at a time with read_file.`,
        { details: { kind: 'includes', limit: maxVisits } }
      )
    }
    const document = await load(path)
    if (!files.includes(path)) files.push(path)
    const instance = visits.length
    const visitRecord = { filePath: path, flattenedStart: length, flattenedEnd: length }
    visits.push(visitRecord)
    const { masked, directives } = scan(path, document.content)
    const [from, to] = subfile ? subfileBody(document.content, masked) : [0, document.content.length]
    let cursor = from
    for (const directive of directives) {
      if (directive.start < from || directive.end > to) continue
      if (directive.kind === 'includeonly') {
        includeOnlyList = directive.target
          .split(',')
          .map(name => name.trim())
          .filter(name => name !== '')
        includeOnly = new Set(includeOnlyList.map(includeOnlyName))
        continue
      }
      const resolved = resolve(directive, path)
      const report = (reason: UnresolvedReason) =>
        unresolved.push({ file: path, line: directive.line, target: directive.target, reason })
      if ('reason' in resolved) {
        report(resolved.reason)
        continue
      }
      // LaTeX compares the \include argument as written with the \includeonly list.
      if (
        directive.kind === 'include' &&
        includeOnly !== undefined &&
        !includeOnly.has(includeOnlyName(directive.target))
      ) {
        report('excluded_by_includeonly')
        continue
      }
      emit(path, document, instance, cursor, directive.start)
      await visit(resolved.path, [...chain, path], directive.kind === 'subfile')
      cursor = directive.end
    }
    emit(path, document, instance, cursor, to)
    visitRecord.flattenedEnd = length
  }

  await visit(rootFilePath, [])
  return {
    rootFilePath,
    text: parts.join(''),
    masked: maskedParts.join(''),
    segments,
    files,
    unresolved,
    ...(includeOnlyList === undefined ? {} : { includeOnly: includeOnlyList }),
    documents,
    visits,
  }
}

/** The source map without the visit numbers, as callers see it. */
export function publicSourceMap(segments: readonly FlattenedSegment[]): SourceMapEntry[] {
  return segments.map(segment => ({
    flattenedStart: segment.flattenedStart,
    flattenedEnd: segment.flattenedEnd,
    filePath: segment.filePath,
    docId: segment.docId,
    originalStart: segment.originalStart,
    originalEnd: segment.originalEnd,
    revision: segment.revision,
  }))
}

/**
 * Maps a range of the flattened text back to the files it came from: one entry per run it
 * touches, clipped to the range, in order.
 */
export function mapFlattenedRange(
  segments: readonly FlattenedSegment[],
  start: number,
  end: number
): FlattenedSegment[] {
  const mapped: FlattenedSegment[] = []
  for (const segment of segments) {
    const from = Math.max(start, segment.flattenedStart)
    const to = Math.min(end, segment.flattenedEnd)
    if (to <= from) continue
    mapped.push({
      ...segment,
      flattenedStart: from,
      flattenedEnd: to,
      originalStart: segment.originalStart + (from - segment.flattenedStart),
      originalEnd: segment.originalStart + (to - segment.flattenedStart),
    })
  }
  return mapped
}
