import { McpError } from './errors.js'

/** The heading commands the section parser recognizes, outermost first; the index is the level. */
export const SECTION_COMMANDS = [
  'part',
  'chapter',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'subparagraph',
] as const

export type SectionCommand = (typeof SECTION_COMMANDS)[number]

const SECTION_LEVELS = new Map<SectionCommand, number>(SECTION_COMMANDS.map((command, level) => [command, level]))

const IGNORED_ENVIRONMENTS = new Set(['verbatim', 'verbatim*', 'lstlisting', 'minted', 'comment'])

export interface LatexSection {
  id: string
  index: number
  command: SectionCommand
  level: number
  starred: boolean
  title: string
  shortTitle?: string
  start: number
  headingEnd: number
  bodyStart: number
  end: number
}

export function skipWhitespace(source: string, index: number): number {
  while (/\s/u.test(source[index] ?? '')) index += 1
  return index
}

export function readBalanced(
  source: string,
  index: number,
  open: '[' | '{',
  close: ']' | '}'
): { value: string; end: number } | null {
  if (source[index] !== open) return null
  let depth = 1
  let cursor = index + 1
  while (cursor < source.length) {
    const char = source[cursor]
    if (char === '\\') {
      cursor += 2
      continue
    }
    if (char === open) depth += 1
    if (char === close) depth -= 1
    if (depth === 0) return { value: source.slice(index + 1, cursor), end: cursor + 1 }
    cursor += 1
  }
  return null
}

function lineEnd(source: string, index: number): number {
  const newline = source.indexOf('\n', index)
  return newline === -1 ? source.length : newline
}

// Returns the end of the ignored environment opened at `index`, or -1 when none opens there.
function ignoredEnvironmentEnd(source: string, index: number): number {
  const begin = /\\begin\{([^}]+)\}/uy
  begin.lastIndex = index
  const name = begin.exec(source)?.[1]
  if (name === undefined || !IGNORED_ENVIRONMENTS.has(name)) return -1
  // Inside these environments everything, `%` included, is literal up to the first matching end.
  const end = `\\end{${name}}`
  const found = source.indexOf(end, begin.lastIndex)
  return found === -1 ? source.length : found + end.length
}

// Returns the end of an inline `\verb` or `\lstinline` argument at `index`, or -1 when none starts there.
function inlineVerbatimEnd(source: string, index: number): number {
  const command = /\\(verb\*?|lstinline)(?![A-Za-z])/uy
  command.lastIndex = index
  const name = command.exec(source)?.[1]
  if (name === undefined) return -1
  let cursor = command.lastIndex
  if (name === 'lstinline') cursor = readBalanced(source, cursor, '[', ']')?.end ?? cursor
  const delimiter = source[cursor]
  if (delimiter === undefined || /\s/u.test(delimiter)) return -1

  // The argument cannot span lines, so an unclosed one ends with its line.
  const limit = lineEnd(source, cursor)
  if (name === 'lstinline' && delimiter === '{') {
    let depth = 0
    for (let offset = cursor; offset < limit; offset += 1) {
      if (source[offset] === '{') depth += 1
      if (source[offset] === '}' && --depth === 0) return offset + 1
    }
    return limit
  }
  const close = source.indexOf(delimiter, cursor + 1)
  return close === -1 || close > limit ? limit : close + 1
}

export function backslashesBefore(source: string, index: number): number {
  let count = 0
  while (source[index - count - 1] === '\\') count += 1
  return count
}

/**
 * Blanks `%` comments, the ignored environments, and inline verbatim arguments, keeping every
 * offset and newline, so a scan of the result finds only live commands.
 */
export function maskIgnored(source: string): string {
  // Spaces preserve every source offset; newlines preserve line structure for returned ranges.
  // Split by UTF-16 code unit, not code point, so array indexes match string offsets.
  const chars = source.split('')
  const mask = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (chars[index] !== '\n') chars[index] = ' '
    }
  }

  let index = 0
  while (index < source.length) {
    if (source[index] === '%') {
      const end = lineEnd(source, index)
      mask(index, end)
      index = end
      continue
    }
    if (source[index] === '\\') {
      let end = ignoredEnvironmentEnd(source, index)
      if (end === -1) end = inlineVerbatimEnd(source, index)
      if (end !== -1) {
        mask(index, end)
        index = end
        continue
      }
      // A control symbol such as `\%` or `\\` is consumed whole, so `\\%` still starts a comment.
      index += /[A-Za-z]/u.test(source[index + 1] ?? '') ? 1 : 2
      continue
    }
    index += 1
  }
  return chars.join('')
}

/**
 * Parses the section headings of LaTeX source. `masked`, when given, is the source already masked
 * (see `maskIgnored`), offset for offset; a flattened document passes one masked file by file.
 */
export function findSections(input: string, masked?: string): LatexSection[] {
  const source = masked === undefined ? input.replace(/\r\n?|\n/g, '\n') : input
  masked ??= maskIgnored(source)
  const candidates: Omit<LatexSection, 'index' | 'id' | 'end'>[] = []
  const commandPattern = new RegExp(String.raw`\\(${SECTION_COMMANDS.join('|')})(\*)?`, 'gu')
  let previousHeadingEnd = 0

  for (const match of masked.matchAll(commandPattern)) {
    // The pattern's alternation names exactly the section commands.
    const command = match[1] as SectionCommand
    const start = match.index
    // After an odd run, this backslash ends a `\\` line break, so the name that follows is text.
    if (backslashesBefore(masked, start) % 2 === 1) continue
    // A heading inside another heading's title is part of that title, or the outer section would
    // end before its own body starts.
    if (start < previousHeadingEnd) continue
    let cursor = start + match[0].length
    cursor = skipWhitespace(masked, cursor)
    let shortTitle: string | undefined
    const optional = readBalanced(masked, cursor, '[', ']')
    if (optional) {
      shortTitle = source.slice(cursor + 1, optional.end - 1)
      cursor = skipWhitespace(masked, optional.end)
    }
    const titleRange = readBalanced(masked, cursor, '{', '}')
    if (!titleRange) continue
    const title = source.slice(cursor + 1, titleRange.end - 1)
    const headingEnd = titleRange.end
    previousHeadingEnd = headingEnd
    const bodyStart = source[headingEnd] === '\n' ? headingEnd + 1 : headingEnd
    candidates.push({
      command,
      level: SECTION_LEVELS.get(command)!,
      starred: match[2] === '*',
      title,
      ...(shortTitle === undefined ? {} : { shortTitle }),
      start,
      headingEnd,
      bodyStart,
    })
  }

  return candidates.map((candidate, index) => {
    const next = candidates.slice(index + 1).find(item => item.level <= candidate.level)
    return {
      ...candidate,
      id: `${candidate.command}:${candidate.start}`,
      index,
      end: next?.start ?? source.length,
    }
  })
}

export function replaceSection(source: string, selector: string | number, replacement: string): string {
  const sections = findSections(source)
  const section =
    typeof selector === 'number' ? sections[selector] : sections.find(candidate => candidate.id === selector)
  if (!section) throw new McpError('NOT_FOUND', `Section ${String(selector)} was not found.`)

  const start = typeof selector === 'number' ? section.start : section.bodyStart
  return source.slice(0, start) + replacement + source.slice(section.end)
}
