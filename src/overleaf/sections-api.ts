import { McpError } from '../core/errors.js'
import {
  DEFAULT_INCLUDE_DEPTH,
  flattenDocument,
  mapFlattenedRange,
  publicSourceMap,
  type FlattenedDocument,
  type IncludeEntity,
  type SourceMapEntry,
  type UnresolvedInclude,
} from '../core/includes.js'
import { AccessPolicy } from '../core/policy.js'
import { decodeRevision } from '../core/revision.js'
import { findSections, replaceSection, SECTION_COMMANDS, type LatexSection } from '../core/sections.js'
import { normalizeLf } from '../core/text.js'
import type { ReadFileResult, WriteFileResult, WriteMode } from './documents.js'
import { normalizeProjectPath } from './tree.js'

interface SectionDocuments {
  readFile(projectId: string, filePath: string): Promise<ReadFileResult>
  writeFile(
    projectId: string,
    filePath: string,
    revision: string,
    content: string,
    writeMode?: WriteMode
  ): Promise<WriteFileResult>
}

/** The project tree as the flattener needs it: entities and the configured root document. */
type ProjectTreeReader = (projectId: string) => Promise<{ entities: readonly IncludeEntity[]; rootDocPath?: string }>

/** A section found in a flattened document: offsets into the flattened text, plus its own file. */
export interface IncludedSection extends LatexSection {
  /** The file that holds the heading. */
  filePath: string
  /** That file's revision, to pass to write_section. */
  revision: string
  /** Whether text from another file falls inside the section, so it cannot be written as one. */
  spansFiles: boolean
}

export interface FullDocument {
  rootFilePath: string
  text: string
  sourceMap: SourceMapEntry[]
  files: string[]
  unresolved: UnresolvedInclude[]
  includeOnly?: string[]
}

/** Where a section's body lies in the file that holds its heading. */
interface SectionLocation {
  section: IncludedSection
  bodyStart: number
  end: number
  /** Every file whose text, other than white space, falls inside the section. */
  files: string[]
}

export interface SectionOptions {
  /** Parse the document with its include directives followed, from `filePath` down. */
  followIncludes?: boolean | undefined
}

const COMMAND_ALTERNATION = SECTION_COMMANDS.join('|')
const INCLUDED_ID = new RegExp(String.raw`^(.*)#(${COMMAND_ALTERNATION}):(\d+)$`, 'su')
const SINGLE_FILE_ID = new RegExp(String.raw`^(${COMMAND_ALTERNATION}):(\d+)$`, 'u')

/** A section id that names its file, so the section can be found again in that file alone. */
function includedSectionId(filePath: string, command: string, start: number): string {
  return `${filePath}#${command}:${start}`
}

/**
 * Locates every section of a flattened document in the file holding its heading. A section whose
 * heading is in an included file ends, at the latest, where that inclusion ends: the parent's text
 * after the directive, such as `\end{document}`, is never part of it. A section spans files when
 * text other than white space from another visit falls inside it; white space alone, such as the
 * line break after an `\input` line, does not count. A section that does not span files is
 * written by replacing its body in its own file, from the body's start to the end of that file's
 * last run inside it.
 */
function locateSections(document: FlattenedDocument): SectionLocation[] {
  // Masked file by file, so a comment on an included file's last line never hides what follows it.
  return findSections(document.text, document.masked).map(parsed => {
    // The heading's first character is always copied from one file.
    const heading = mapFlattenedRange(document.segments, parsed.start, parsed.start + 1)[0]!
    const visit = document.visits[heading.instance]!
    // The run the heading starts in. A heading that runs past its end, because an include
    // directive sits inside it or its file ends mid-heading, cannot be replaced in one file.
    const headingRun = document.segments.find(
      segment =>
        segment.instance === heading.instance &&
        segment.flattenedStart <= parsed.start &&
        parsed.start < segment.flattenedEnd
    )!
    const straddles = parsed.headingEnd > headingRun.flattenedEnd
    const section = { ...parsed, end: Math.max(parsed.bodyStart, Math.min(parsed.end, visit.flattenedEnd)) }
    const covered = mapFlattenedRange(document.segments, section.start, section.end)
    const own = covered.filter(segment => segment.instance === heading.instance)
    const significant = covered.filter(
      segment => !/^\s*$/u.test(document.text.slice(segment.flattenedStart, segment.flattenedEnd))
    )
    const files = [...new Set(significant.map(segment => segment.filePath))]
    const spansFiles = straddles || significant.some(segment => segment.instance !== heading.instance)
    const bodyStart =
      headingRun.originalStart + Math.min(section.bodyStart, headingRun.flattenedEnd) - headingRun.flattenedStart
    return {
      section: {
        ...section,
        id: includedSectionId(heading.filePath, section.command, heading.originalStart),
        filePath: heading.filePath,
        revision: heading.revision,
        spansFiles,
      },
      bodyStart,
      end: Math.max(bodyStart, own.at(-1)!.originalEnd),
      files,
    }
  })
}

/** The file, command, and heading offset a section id names: `path#command:offset`, or a single-file id in the root file. */
function parseSectionId(
  sectionId: string,
  rootFilePath: string
): { filePath: string; command: string; offset: number } | undefined {
  const included = INCLUDED_ID.exec(sectionId)
  if (included !== null) return { filePath: included[1]!, command: included[2]!, offset: Number(included[3]) }
  const single = SINGLE_FILE_ID.exec(sectionId)
  if (single !== null) return { filePath: rootFilePath, command: single[1]!, offset: Number(single[2]) }
  return undefined
}

/** Every visit's location of the section an id names; a file included twice holds it twice. */
function findLocations(document: FlattenedDocument, sectionId: string): SectionLocation[] {
  const parsed = parseSectionId(sectionId, document.rootFilePath)
  if (parsed === undefined) return []
  const id = includedSectionId(parsed.filePath, parsed.command, parsed.offset)
  return locateSections(document).filter(location => location.section.id === id)
}

function sectionNotFound(sectionId: string, followIncludes: boolean): McpError {
  const hint =
    !followIncludes && sectionId.includes('#')
      ? ' Section ids that name a file come from get_sections with followIncludes: true; pass followIncludes: true here too.'
      : ' List the sections again: an id names its heading by position, so it changes when text before the heading changes.'
  return new McpError('NOT_FOUND', `Section ${sectionId} was not found.${hint}`)
}

export class SectionsApi {
  readonly #documents: SectionDocuments
  readonly #getProjectTree: ProjectTreeReader
  readonly #policy: AccessPolicy

  constructor(documents: SectionDocuments, options: { getProjectTree: ProjectTreeReader; policy?: AccessPolicy }) {
    this.#documents = documents
    this.#getProjectTree = options.getProjectTree
    this.#policy = options.policy ?? AccessPolicy.permissive
  }

  /**
   * Flattens a document from `rootFilePath`, or from the project's root document, following its
   * include directives. Every file is read through the same revision-producing read as read_file.
   */
  async getFullDocument(
    projectId: string,
    rootFilePath?: string,
    maxDepth = DEFAULT_INCLUDE_DEPTH
  ): Promise<FullDocument> {
    const document = await this.#flatten(projectId, rootFilePath, maxDepth)
    return {
      rootFilePath: document.rootFilePath,
      text: document.text,
      sourceMap: publicSourceMap(document.segments),
      files: document.files,
      unresolved: document.unresolved,
      ...(document.includeOnly === undefined ? {} : { includeOnly: document.includeOnly }),
    }
  }

  async getSections(
    projectId: string,
    filePath: string,
    options: SectionOptions = {}
  ): Promise<
    | { sections: LatexSection[]; revision: string; singleFileOnly: true }
    | { sections: IncludedSection[]; revision: string; singleFileOnly: false; unresolved: UnresolvedInclude[] }
  > {
    if (options.followIncludes === true) {
      const document = await this.#flatten(projectId, filePath)
      return {
        sections: locateSections(document).map(location => location.section),
        revision: document.documents.get(document.rootFilePath)!.revision,
        singleFileOnly: false,
        unresolved: document.unresolved,
      }
    }
    const file = await this.#documents.readFile(projectId, filePath)
    return {
      sections: findSections(file.content),
      revision: file.revision,
      singleFileOnly: true,
    }
  }

  async getSectionContent(
    projectId: string,
    filePath: string,
    sectionId: string,
    options: SectionOptions = {}
  ): Promise<{ content: string; section: LatexSection | IncludedSection; revision: string }> {
    if (options.followIncludes === true) {
      const document = await this.#flatten(projectId, filePath)
      const location = findLocations(document, sectionId)[0]
      if (location === undefined) throw sectionNotFound(sectionId, true)
      const { section } = location
      // A section in one file reads as that file holds it, which is what write_section replaces.
      const content = section.spansFiles
        ? document.text.slice(section.bodyStart, section.end)
        : document.documents.get(section.filePath)!.content.slice(location.bodyStart, location.end)
      return { content, section, revision: section.revision }
    }
    const file = await this.#documents.readFile(projectId, filePath)
    const section = findSections(file.content).find(candidate => candidate.id === sectionId)
    if (!section) throw sectionNotFound(sectionId, false)
    return {
      content: file.content.slice(section.bodyStart, section.end),
      section,
      revision: file.revision,
    }
  }

  async writeSection(
    projectId: string,
    filePath: string,
    revision: string,
    sectionId: string,
    content: string,
    writeMode: WriteMode = 'untracked',
    options: SectionOptions = {}
  ): Promise<WriteFileResult & { filePath?: string }> {
    // Both paths read before they write, so both effects are checked before any request.
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read', 'overleaf-write')
    if (options.followIncludes === true) {
      const document = await this.#flatten(projectId, filePath)
      const named = parseSectionId(sectionId, document.rootFilePath)
      const read = named === undefined ? undefined : document.documents.get(named.filePath)
      if (read === undefined) throw sectionNotFound(sectionId, true)
      // Checked before the section is looked up: a change to its file can move its heading, and the
      // caller should learn that the file changed, not that the section is gone.
      if (read.revision !== revision) {
        // A token that is not a revision at all is a malformed call, as on the single-file path.
        decodeRevision(revision)
        throw new McpError(
          'REVISION_CONFLICT',
          `${named!.filePath} is not at the revision given: it changed since the sections were listed, or the revision is another file's. List the sections again with followIncludes: true and pass the section's revision.`,
          { details: { filePath: named!.filePath, liveRevision: read.revision } }
        )
      }
      const locations = findLocations(document, sectionId)
      if (locations.length === 0) throw sectionNotFound(sectionId, true)
      const spanning = locations.find(location => location.section.spansFiles)
      if (spanning !== undefined) {
        throw new McpError(
          'INVALID_ARGUMENT',
          `Section ${sectionId} spans more than one file, so it cannot be replaced in one write. Write each file with write_file, or write a section that lies in one file.`,
          { details: { kind: 'spans_files', files: spanning.files } }
        )
      }
      // A file included twice holds the section once: both visits locate the same body.
      const location = locations[0]!
      const target = location.section.filePath
      const current = document.documents.get(target)!.content
      const updated = current.slice(0, location.bodyStart) + normalizeLf(content) + current.slice(location.end)
      // The write checks the revision against the live document again, so a change since the read
      // above is REVISION_CONFLICT too, and nothing is sent.
      const written = await this.#documents.writeFile(projectId, target, revision, updated, writeMode)
      return { ...written, filePath: target }
    }
    const file = await this.#documents.readFile(projectId, filePath)
    if (!findSections(file.content).some(candidate => candidate.id === sectionId)) {
      throw sectionNotFound(sectionId, false)
    }
    const updated = replaceSection(file.content, sectionId, normalizeLf(content))
    return await this.#documents.writeFile(projectId, filePath, revision, updated, writeMode)
  }

  async #flatten(projectId: string, rootFilePath: string | undefined, maxDepth = DEFAULT_INCLUDE_DEPTH) {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read')
    const tree = await this.#getProjectTree(projectId)
    const root = rootFilePath ?? tree.rootDocPath
    if (root === undefined) {
      throw new McpError(
        'INVALID_ARGUMENT',
        'The project has no root document configured. Pass rootFilePath, or set one with update_project_settings.'
      )
    }
    const rootPath = normalizeProjectPath(root)
    const rootEntity = tree.entities.find(entity => entity.path === rootPath)
    if (rootEntity === undefined) throw new McpError('NOT_FOUND', `Project path was not found: ${rootPath}`)
    if (rootEntity.type !== 'doc') {
      throw new McpError('INVALID_ARGUMENT', `${rootEntity.path} is a ${rootEntity.type}, not a doc.`)
    }
    return await flattenDocument(
      rootEntity.path,
      {
        entities: tree.entities,
        read: async path => await this.#documents.readFile(projectId, path),
      },
      { maxDepth }
    )
  }
}
