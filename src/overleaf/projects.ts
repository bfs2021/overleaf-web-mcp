import { readFile } from 'node:fs/promises'
import { basename, posix } from 'node:path'

import { z } from 'zod'

import { asMcpError, McpError } from '../core/errors.js'
import { prepareLocalDownload, writeDownload } from '../core/local-download.js'
import { AccessPolicy, isPathSafeId } from '../core/policy.js'
import { ERROR_CODE_PATTERN } from '../http/client.js'
import type { EntityType, ProjectEntity, ProjectTree } from './tree.js'

interface ProjectsHttp {
  postJson(path: string, body?: unknown): Promise<unknown>
  deleteJson(path: string): Promise<unknown>
  postForm(path: string, form: FormData): Promise<unknown>
  getStream(
    path: string,
    options?: { timeoutMs?: number }
  ): Promise<{ body: ReadableStream<Uint8Array>; contentType?: string }>
}

export interface ProjectsApiOptions {
  http: ProjectsHttp
  /** Origin the web UI lives at, used to build the `url` of created projects. */
  baseUrl: string
  findProject(projectId: string): Promise<{ name: string; archived: boolean; trashed: boolean }>
  resolvePath(projectId: string, path: string, type: EntityType): Promise<ProjectEntity>
  getProjectTree(projectId: string): Promise<ProjectTree>
  /** Drops the cached project socket, whose join snapshot holds the settings and name. */
  invalidate(projectId: string): Promise<void>
  /** Defaults to allowing everything but ids that are not path-safe. */
  policy?: AccessPolicy | undefined
}

export const COMPILERS = ['pdflatex', 'latex', 'xelatex', 'lualatex'] as const
export type Compiler = (typeof COMPILERS)[number]

export type ProjectTemplate = 'blank' | 'example'

export type ProjectAction =
  | { action: 'rename'; newName: string }
  | { action: 'trash' | 'archive' | 'delete'; confirmName: string }
  | { action: 'restore' | 'unarchive' }

export interface ProjectSettingsInput {
  rootFilePath?: string | undefined
  compiler?: Compiler | undefined
  imageName?: string | undefined
  /** Overleaf language code, for example `en` or `de`; an empty string turns spell checking off. */
  spellCheckLanguage?: string | undefined
}

export interface CreatedProject {
  projectId: string
  name: string
  url: string
  /** Absent only if Overleaf created the project without a root document. */
  rootDocPath?: string
}

export interface DownloadedProjectZip {
  projectId: string
  /** Absolute path the archive was written to. */
  localPath: string
  bytes: number
  /** Whether a local file was replaced. */
  replaced: boolean
}

export interface DownloadProjectZipOptions {
  overwrite?: boolean | undefined
  timeoutMs?: number | undefined
}

/** A whole-project archive can take a while to build and stream; this bounds the transfer. */
export const DEFAULT_ZIP_DOWNLOAD_TIMEOUT_MS = 5 * 60_000

export interface ProjectSettings {
  projectId: string
  rootDocPath?: string
  compiler?: string
  imageName?: string
  spellCheckLanguage?: string
}

/** Overleaf's own limit on project names, enforced client-side to fail before the request. */
const MAX_PROJECT_NAME_LENGTH = 150

/** Overleaf's default `validRootDocExtensions`, matched case-insensitively as Overleaf does. */
const ROOT_DOC_EXTENSION = /^\.(?:tex|ltx|rtex|rnw)$/iu

/** Overleaf reports zip import rejections as HTTP 422 with a machine-readable code. */
const ZIP_ERRORS: Record<string, string> = {
  invalid_zip_file: 'Overleaf could not read the archive as a zip file.',
  empty_zip_file: 'The zip archive contains no files Overleaf can import.',
  zip_contents_too_large: 'The extracted archive exceeds the project size Overleaf allows.',
  invalid_filename:
    'The archive holds a file name Overleaf rejects. Names are limited to 150 characters and may not use reserved names or path separators.',
  project_has_too_many_files: 'The archive holds more files than a project may contain.',
}

const createdProjectSchema = z.object({ project_id: z.string().min(1) })

function validateProjectName(name: string): void {
  if (name.trim() === '' || name.length > MAX_PROJECT_NAME_LENGTH || /[/\\]/u.test(name)) {
    throw new McpError(
      'INVALID_ARGUMENT',
      `Invalid project name. Names must be 1 to ${MAX_PROJECT_NAME_LENGTH} characters without slashes.`
    )
  }
}

/** A local file header, or the end-of-directory record that is all an empty archive holds. */
const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
] as const

function startsLikeZip(head: Uint8Array): boolean {
  return head.byteLength >= 4 && ZIP_SIGNATURES.some(signature => signature.every((byte, at) => head[at] === byte))
}

/**
 * Whether the bytes end with a zip end-of-central-directory record whose comment length
 * accounts exactly for what follows it. Overleaf builds the archive while it streams it, so a
 * transfer cut short arrives with HTTP 200 and a valid start but no end record.
 */
function endsLikeZip(tail: Uint8Array): boolean {
  for (let at = tail.byteLength - 22; at >= 0; at -= 1) {
    if (tail[at] === 0x50 && tail[at + 1] === 0x4b && tail[at + 2] === 0x05 && tail[at + 3] === 0x06) {
      const commentLength = tail[at + 20]! | (tail[at + 21]! << 8)
      if (at + 22 + commentLength === tail.byteLength) return true
    }
  }
  return false
}

const MIME_TYPE_PATTERN = /^[a-z]+\/[a-z0-9.+-]{1,64}$/u

function zipFailure(error: unknown): McpError {
  const code = typeof error === 'string' && ERROR_CODE_PATTERN.test(error) ? error : undefined
  const detail = code === undefined ? undefined : ZIP_ERRORS[code]
  return new McpError(
    'INVALID_ARGUMENT',
    detail ?? 'Overleaf rejected the zip archive.',
    code === undefined ? {} : { details: { overleafError: code } }
  )
}

/** Read-back failure codes an import keeps, since each means the same as for any other call. */
const READ_BACK_CODES_KEPT: ReadonlySet<string> = new Set(['AUTH_EXPIRED', 'POLICY_DENIED', 'TIMEOUT'])

/** Keeps the failure's code and details and adds which settings were stored before it. */
function partialSettingsFailure(error: unknown, applied: string[], failed: string): McpError {
  const cause = asMcpError(error)
  const stored =
    applied.length === 0 ? 'No setting was' : `${applied.join(', ')} ${applied.length === 1 ? 'was' : 'were'}`
  return new McpError(
    cause.code,
    `${cause.message} ${stored} applied before the request for ${failed} failed, and no later setting was sent.`,
    { retryable: cause.retryable, details: { ...cause.details, applied: [...applied], failed }, cause }
  )
}

/**
 * Creates, clones, imports, renames, trashes, archives, deletes, and configures projects through
 * the same browser-facing routes the Overleaf web UI uses.
 *
 * Destructive actions follow Overleaf's own model: trash first, permanent delete only from the
 * trash, and both require the caller to repeat the project's current name.
 */
export class ProjectsApi {
  readonly #options: ProjectsApiOptions
  readonly #policy: AccessPolicy

  constructor(options: ProjectsApiOptions) {
    this.#options = options
    this.#policy = options.policy ?? AccessPolicy.permissive
  }

  #projectUrl(projectId: string): string {
    return `${this.#options.baseUrl}/project/${encodeURIComponent(projectId)}`
  }

  #parseCreated(response: unknown, what: string): string {
    let projectId: string
    try {
      projectId = createdProjectSchema.parse(response).project_id
    } catch (error) {
      throw new McpError('PROTOCOL_UNSUPPORTED', `Overleaf returned an unsupported ${what} response.`, { cause: error })
    }
    if (!isPathSafeId(projectId)) {
      throw new McpError('PROTOCOL_UNSUPPORTED', `Overleaf returned an unsupported project id from ${what}.`)
    }
    // A project this process created stays reachable for the rest of it, allowlist or not.
    this.#policy.allowProject(projectId)
    return projectId
  }

  /**
   * Creates a project. "blank" is Overleaf's basic project, which still ships a stub `main.tex`
   * as the root document; callers importing their own root should point the project at it with
   * `updateProjectSettings` or delete the stub.
   */
  async createProject(name: string, template: ProjectTemplate = 'blank'): Promise<CreatedProject> {
    // The new project's tree is read afterwards, so that read is allowed before anything is created.
    this.#policy.assertEffect('project-lifecycle', 'overleaf-read')
    validateProjectName(name)
    const response = await this.#options.http.postJson('/project/new', {
      projectName: name,
      template: template === 'example' ? 'example' : 'none',
    })
    const projectId = this.#parseCreated(response, 'project creation')
    let tree: ProjectTree
    try {
      tree = await this.#options.getProjectTree(projectId)
    } catch (error) {
      // The project exists; hand back its id so the caller does not create a duplicate.
      throw new McpError(
        'REMOTE_ERROR',
        'The project was created but its tree could not be read. Call get_project_tree with the projectId in details.',
        { details: { projectId }, cause: error }
      )
    }
    return {
      projectId,
      name,
      url: this.#projectUrl(projectId),
      ...(tree.rootDocPath === undefined ? {} : { rootDocPath: tree.rootDocPath }),
    }
  }

  async cloneProject(sourceProjectId: string, name: string): Promise<CreatedProject> {
    this.#policy.assertProject(sourceProjectId, 'sourceProjectId')
    this.#policy.assertEffect('project-lifecycle')
    validateProjectName(name)
    const response = await this.#options.http.postJson(`/Project/${encodeURIComponent(sourceProjectId)}/clone`, {
      projectName: name,
    })
    const projectId = this.#parseCreated(response, 'project clone')
    return { projectId, name, url: this.#projectUrl(projectId) }
  }

  /**
   * Imports a local zip archive as a new project. Overleaf rate-limits this route, so a
   * `RATE_LIMITED` error with `retryAfterMs` is expected under repeated use.
   */
  async importProjectZip(localZipPath: string, name?: string): Promise<CreatedProject> {
    const fileName = basename(localZipPath)
    if (!/\.zip$/iu.test(fileName)) {
      throw new McpError('INVALID_ARGUMENT', 'localZipPath must point to a .zip archive.')
    }
    const projectName = name ?? fileName.replace(/\.zip$/iu, '')
    validateProjectName(projectName)
    // The stored name is read back afterwards, so that read is allowed before anything is uploaded.
    this.#policy.assertEffect('project-lifecycle', 'overleaf-read')
    const readPath = await this.#policy.resolveLocalRead(localZipPath)
    const bytes = await readFile(readPath).catch((error: unknown) => {
      throw new McpError('NOT_FOUND', `Local file could not be read: ${localZipPath}`, {
        cause: error,
      })
    })
    const form = new FormData()
    form.append('qqfile', new Blob([bytes], { type: 'application/zip' }), fileName)
    form.append('name', projectName)
    let response: unknown
    try {
      response = await this.#options.http.postForm('/project/new/upload', form)
    } catch (error) {
      if (error instanceof McpError) {
        const status = (error.details as { status?: number } | undefined)?.status
        if (status === 422) {
          throw zipFailure((error.details as { overleafError?: string }).overleafError)
        }
        if (error.code === 'UPDATE_TOO_LARGE') {
          throw new McpError(
            'UPDATE_TOO_LARGE',
            'The zip archive exceeds the upload size Overleaf allows (50 MB on overleaf.com).',
            { cause: error }
          )
        }
      }
      throw error
    }
    const body = response as { success?: boolean; error?: unknown } | null
    if (body?.success === false) throw zipFailure(body.error)
    const projectId = this.#parseCreated(response, 'project import')
    // Overleaf names the project after the root document's \title when it has one, and adds
    // " (n)" to a name the account already uses, so only a read-back tells the stored name.
    let stored: { name: string }
    try {
      stored = await this.#options.findProject(projectId)
    } catch (error) {
      // The project exists now, so the error is never retryable: retrying the import would create
      // a second project. Only codes that mean the same here as for any call are kept; this tool's
      // NOT_FOUND and RATE_LIMITED say nothing was created.
      const kept = error instanceof McpError && READ_BACK_CODES_KEPT.has(error.code) ? error : undefined
      throw new McpError(
        kept?.code ?? 'REMOTE_ERROR',
        `The project was imported, but its stored name could not be read${kept === undefined ? '.' : `: ${kept.message}`} Do not import it again; call list_projects or get_project_tree with the projectId in details.`,
        { retryable: false, details: { ...kept?.details, projectId }, cause: error }
      )
    }
    return { projectId, name: stored.name, url: this.#projectUrl(projectId) }
  }

  /**
   * Downloads the whole project as Overleaf's "Download as zip" archive, streamed to a local
   * file. An existing file is replaced only with `overwrite`, and atomically, so a failed
   * download leaves it as it was.
   */
  async downloadProjectZip(
    projectId: string,
    localPath: string,
    options: DownloadProjectZipOptions = {}
  ): Promise<DownloadedProjectZip> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read')
    const target = await prepareLocalDownload(
      await this.#policy.resolveLocalWrite(localPath),
      options.overwrite === true
    )
    let response: { body: ReadableStream<Uint8Array>; contentType?: string }
    try {
      response = await this.#options.http.getStream(`/Project/${encodeURIComponent(projectId)}/download/zip`, {
        timeoutMs: options.timeoutMs ?? DEFAULT_ZIP_DOWNLOAD_TIMEOUT_MS,
      })
    } catch (error) {
      await target.discard()
      throw error
    }
    const { body, contentType } = response
    const cutShort = (): McpError =>
      new McpError(
        'REMOTE_ERROR',
        'The archive Overleaf sent ended before it was complete; nothing was written. Try again.',
        { retryable: true }
      )
    const written = await writeDownload(body, target, {
      head: head => {
        if (startsLikeZip(head)) return
        // A body that stops inside the signature is a transfer cut short, not some other format.
        if (head.byteLength < 4 && ZIP_SIGNATURES.some(signature => head.every((byte, at) => byte === signature[at]))) {
          throw cutShort()
        }
        const type = contentType?.split(';')[0]?.trim().toLowerCase()
        throw new McpError(
          'PROTOCOL_UNSUPPORTED',
          'Overleaf did not return a zip archive for this project; nothing was written.',
          type !== undefined && MIME_TYPE_PATTERN.test(type) ? { details: { contentType: type } } : {}
        )
      },
      tail: tail => {
        if (!endsLikeZip(tail)) throw cutShort()
      },
    })
    return { projectId, localPath: target.path, bytes: written.bytes, replaced: written.replaced }
  }

  async manageProject(
    projectId: string,
    input: ProjectAction
  ): Promise<{ action: ProjectAction['action']; projectId: string; name: string }> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('project-lifecycle', 'overleaf-read')
    if (input.action === 'delete') this.#policy.assertEffect('overleaf-delete')
    const project = await this.#options.findProject(projectId)
    const id = encodeURIComponent(projectId)
    let name = project.name
    switch (input.action) {
      case 'rename':
        validateProjectName(input.newName)
        await this.#options.http.postJson(`/project/${id}/rename`, { newProjectName: input.newName })
        name = input.newName
        break
      case 'trash':
      case 'archive':
      case 'delete': {
        if (input.confirmName !== project.name) {
          throw new McpError(
            'CONFIRMATION_MISMATCH',
            `confirmName must exactly match the current project name before a project can be ${
              input.action === 'trash' ? 'trashed' : input.action === 'archive' ? 'archived' : 'deleted'
            }.`
          )
        }
        if (input.action === 'trash') await this.#options.http.postJson(`/project/${id}/trash`)
        else if (input.action === 'archive') await this.#options.http.postJson(`/Project/${id}/archive`)
        else {
          if (!project.trashed) {
            throw new McpError(
              'INVALID_ARGUMENT',
              'Permanent deletion requires the project to be trashed first. Use action "trash", then "delete".'
            )
          }
          await this.#options.http.deleteJson(`/Project/${id}`)
        }
        break
      }
      case 'restore':
        await this.#options.http.deleteJson(`/project/${id}/trash`)
        break
      case 'unarchive':
        await this.#options.http.deleteJson(`/Project/${id}/archive`)
        break
    }
    await this.#options.invalidate(projectId)
    return { action: input.action, projectId, name }
  }

  /**
   * Persists root document, compiler, TeX Live image, or spell-check language in the project's
   * own settings, so the web UI's Recompile follows the change too. Returns the settings as
   * re-read from a fresh project join.
   */
  async updateProjectSettings(projectId: string, settings: ProjectSettingsInput): Promise<ProjectSettings> {
    this.#policy.assertProject(projectId)
    // The settings are re-read afterwards, so that read is allowed before anything is changed.
    this.#policy.assertEffect('project-lifecycle', 'overleaf-read')
    if (settings.rootFilePath !== undefined && !ROOT_DOC_EXTENSION.test(posix.extname(settings.rootFilePath))) {
      throw new McpError(
        'INVALID_ARGUMENT',
        'rootFilePath must name a .tex, .ltx, .Rtex, or .Rnw document; Overleaf compiles no other root. Nothing was changed.'
      )
    }
    // Overleaf applies a settings request field by field in this order and stops at the first
    // failure with a bare HTTP 500, so one request per field tells which ones were stored.
    const updates: Array<{ setting: keyof ProjectSettingsInput; body: Record<string, string> }> = []
    if (settings.compiler !== undefined) updates.push({ setting: 'compiler', body: { compiler: settings.compiler } })
    if (settings.imageName !== undefined) {
      updates.push({ setting: 'imageName', body: { imageName: settings.imageName } })
    }
    if (settings.spellCheckLanguage !== undefined) {
      updates.push({ setting: 'spellCheckLanguage', body: { spellCheckLanguage: settings.spellCheckLanguage } })
    }
    if (settings.rootFilePath !== undefined) {
      const rootDocId = (await this.#options.resolvePath(projectId, settings.rootFilePath, 'doc')).id
      updates.push({ setting: 'rootFilePath', body: { rootDocId } })
    }
    if (updates.length === 0) {
      throw new McpError(
        'INVALID_ARGUMENT',
        'Provide at least one of rootFilePath, compiler, imageName, or spellCheckLanguage.'
      )
    }
    const applied: string[] = []
    try {
      for (const update of updates) {
        try {
          await this.#options.http.postJson(`/project/${encodeURIComponent(projectId)}/settings`, update.body)
        } catch (error) {
          throw partialSettingsFailure(error, applied, update.setting)
        }
        applied.push(update.setting)
      }
    } finally {
      // The cached join snapshot never learns about settings changes, applied in full or in part.
      await this.#options.invalidate(projectId)
    }
    let tree: Awaited<ReturnType<ProjectsApiOptions['getProjectTree']>>
    try {
      tree = await this.#options.getProjectTree(projectId)
    } catch (error) {
      // Every setting is stored by now, so the error says so: a call to run again, it is not.
      const cause = asMcpError(error)
      throw new McpError(
        cause.code,
        `${cause.message} Every setting was stored (${applied.join(', ')}), but reading them back failed. Do not send them again; call get_project_tree to see them.`,
        { retryable: false, details: { ...cause.details, applied: [...applied] }, cause }
      )
    }
    return {
      projectId,
      ...(tree.rootDocPath === undefined ? {} : { rootDocPath: tree.rootDocPath }),
      ...(tree.compiler === undefined ? {} : { compiler: tree.compiler }),
      ...(tree.imageName === undefined ? {} : { imageName: tree.imageName }),
      ...(tree.spellCheckLanguage === undefined ? {} : { spellCheckLanguage: tree.spellCheckLanguage }),
    }
  }
}
