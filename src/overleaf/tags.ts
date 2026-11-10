import { z } from 'zod'

import { asMcpError, McpError } from '../core/errors.js'
import { AccessPolicy, isPathSafeId } from '../core/policy.js'

interface TagsHttp {
  getJson(path: string): Promise<unknown>
  postJson(path: string, body?: unknown): Promise<unknown>
  deleteJson(path: string): Promise<unknown>
}

/** One of the account's project tags, as the Overleaf dashboard shows it. */
export interface ProjectTag {
  id: string
  name: string
  /** `#rrggbb` or `hsl(h, 70%, 45%)`; absent when Overleaf picks the colour from the id. */
  color?: string
  /** The projects in the tag; with `OVERLEAF_ALLOWED_PROJECTS`, only the allowed ones. */
  projectIds: string[]
}

export type TagAction =
  | { action: 'create'; name: string; color?: string | undefined }
  | { action: 'edit'; tagId: string; name?: string | undefined; color?: string | undefined }
  | { action: 'delete'; tagId: string; confirmName: string }
  | { action: 'add_projects' | 'remove_projects'; tagId: string; projectIds: string[] }

export type TagActionName = TagAction['action']

export interface ManageTagsResult {
  action: TagActionName
  /** The tag after the change; for `delete`, as it was before. */
  tag: ProjectTag
  deleted: boolean
  /** Whether reading the tags back after the change confirmed it. */
  verified: boolean
  /** The request timed out or lost its connection, and the read-back showed it applied. */
  recoveredAfterTimeout?: true
}

/** Overleaf's `MAX_TAG_LENGTH` (`Features/Tags/TagsHandler.mjs`). */
export const MAX_TAG_NAME_LENGTH = 50

/** Overleaf's `TAG_COLOR_REGEX` (`models/Tag.mjs`): hex, or the colour picker's HSL form. */
export const TAG_COLOR_PATTERN = /^(#[a-fA-F0-9]{6}|hsl\(\d{1,3}, 70%, 45%\))$/u

/** Overleaf's bulk routes take any number of ids; a bound keeps one call reviewable. */
export const MAX_TAG_PROJECT_IDS = 100

const rawTagSchema = z.object({
  _id: z.string().min(1),
  name: z.string(),
  color: z.string().nullish(),
  project_ids: z.array(z.string()).nullish(),
})

const createdTagSchema = z.object({ _id: z.string().min(1) })

/** A tag as Overleaf stores it: every project id, before the access policy filters them. */
interface StoredTag {
  id: string
  name: string
  color?: string
  projectIds: string[]
}

/**
 * A failure after which the write may still have applied: no answer, a cut-off answer, or a
 * server error. Every other failure is Overleaf refusing the request.
 */
function mayHaveApplied(error: McpError): boolean {
  if (error.code === 'TIMEOUT') return true
  if (error.code !== 'REMOTE_ERROR') return false
  const status = error.details?.status
  return error.details?.kind === 'network' || (typeof status === 'number' && status >= 500)
}

function validateName(name: string): void {
  if (name.trim() === '' || name.length > MAX_TAG_NAME_LENGTH) {
    throw new McpError('INVALID_ARGUMENT', `A tag name must be 1 to ${MAX_TAG_NAME_LENGTH} characters, not blank.`)
  }
}

function validateColor(color: string | undefined): void {
  if (color !== undefined && !TAG_COLOR_PATTERN.test(color)) {
    throw new McpError('INVALID_ARGUMENT', 'A tag color must be #rrggbb or hsl(H, 70%, 45%), as Overleaf accepts.')
  }
}

/**
 * Lists and changes the tags that organize projects on the Overleaf dashboard, through the same
 * routes the dashboard uses (`/tag`).
 *
 * Overleaf answers a tag change with 204 even when no tag matched, and files any project id
 * without checking access, so every change is checked against a fresh read first and verified by
 * another read afterwards. Nothing is retried: a change whose answer was lost is classified from
 * that read, never sent again.
 */
export class TagsApi {
  readonly #http: TagsHttp
  readonly #policy: AccessPolicy
  readonly #accessibleProjectIds: () => Promise<ReadonlySet<string>>

  constructor(
    http: TagsHttp,
    options: {
      /** Ids of the projects the account can access and the policy allows. */
      accessibleProjectIds: () => Promise<ReadonlySet<string>>
      policy?: AccessPolicy | undefined
    }
  ) {
    this.#http = http
    this.#policy = options.policy ?? AccessPolicy.permissive
    this.#accessibleProjectIds = options.accessibleProjectIds
  }

  /** Every tag of the account, sorted by name. */
  async listTags(): Promise<ProjectTag[]> {
    this.#policy.assertEffect('overleaf-read')
    return (await this.#readTags()).map(tag => this.#visible(tag))
  }

  async #readTags(): Promise<StoredTag[]> {
    const response = await this.#http.getJson('/tag')
    const parsed = z.array(rawTagSchema).safeParse(response)
    if (!parsed.success || parsed.data.some(tag => !isPathSafeId(tag._id))) {
      throw new McpError('PROTOCOL_UNSUPPORTED', 'Overleaf returned an unsupported tag list response.', {
        ...(parsed.success ? {} : { cause: parsed.error }),
      })
    }
    return parsed.data
      .map(tag => ({
        id: tag._id,
        name: tag.name,
        ...(typeof tag.color === 'string' && tag.color !== '' ? { color: tag.color } : {}),
        projectIds: [...new Set(tag.project_ids ?? [])],
      }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  }

  #visible(tag: StoredTag): ProjectTag {
    return { ...tag, projectIds: tag.projectIds.filter(id => this.#policy.allowsProject(id)) }
  }

  async manageTags(input: TagAction): Promise<ManageTagsResult> {
    this.#policy.assertEffect('project-lifecycle', 'overleaf-read')
    if (input.action === 'delete') this.#policy.assertEffect('overleaf-delete')
    if (input.action === 'create') {
      validateName(input.name)
      validateColor(input.color)
    } else {
      if (!isPathSafeId(input.tagId)) {
        throw new McpError('INVALID_ARGUMENT', 'tagId is not a valid tag id; nothing was sent.')
      }
      if (input.action === 'edit') {
        if (input.name === undefined && input.color === undefined) {
          throw new McpError('INVALID_ARGUMENT', 'edit needs a new name, a new color, or both.')
        }
        if (input.name !== undefined) validateName(input.name)
        validateColor(input.color)
      }
      if (input.action === 'add_projects' || input.action === 'remove_projects') {
        if (input.projectIds.length === 0 || input.projectIds.length > MAX_TAG_PROJECT_IDS) {
          throw new McpError('INVALID_ARGUMENT', `projectIds must hold 1 to ${MAX_TAG_PROJECT_IDS} project ids.`)
        }
        for (const projectId of input.projectIds) this.#policy.assertProject(projectId, 'projectIds')
      }
    }

    const before = await this.#readTags()
    if (input.action === 'create') {
      const taken = before.find(tag => tag.name === input.name)
      if (taken !== undefined) throw this.#nameTaken(taken)
      return await this.#create(input.name, input.color)
    }

    const current = before.find(tag => tag.id === input.tagId)
    if (current === undefined) {
      throw new McpError('NOT_FOUND', "Tag was not found among this account's tags.", {
        details: { tagId: input.tagId },
      })
    }
    switch (input.action) {
      case 'edit': {
        this.#assertWholeTagAllowed(current)
        const taken =
          input.name === undefined ? undefined : before.find(tag => tag.name === input.name && tag.id !== current.id)
        if (taken !== undefined) throw this.#nameTaken(taken)
        const color = input.color ?? current.color
        const expected: StoredTag = {
          ...current,
          name: input.name ?? current.name,
          ...(color === undefined ? {} : { color }),
        }
        // The edit route stores the color it is given, so an unchanged one is sent again.
        return await this.#apply(
          input.action,
          current.id,
          async () =>
            await this.#http.postJson(`/tag/${encodeURIComponent(current.id)}/edit`, {
              name: expected.name,
              ...(color === undefined ? {} : { color }),
            }),
          tag => tag !== undefined && tag.name === expected.name && tag.color === expected.color,
          expected
        )
      }
      case 'delete': {
        if (input.confirmName !== current.name) {
          throw new McpError(
            'CONFIRMATION_MISMATCH',
            "confirmName must exactly match the tag's current name before it can be deleted."
          )
        }
        this.#assertWholeTagAllowed(current)
        return await this.#apply(
          input.action,
          current.id,
          async () => await this.#http.deleteJson(`/tag/${encodeURIComponent(current.id)}`),
          tag => tag === undefined,
          current
        )
      }
      case 'add_projects':
      case 'remove_projects': {
        const requested = [...new Set(input.projectIds)]
        const accessible = await this.#accessibleProjectIds()
        const missing = requested.filter(id => !accessible.has(id))
        if (missing.length > 0) {
          throw new McpError(
            'NOT_FOUND',
            'Some projectIds are not projects this account can access; nothing was sent.',
            {
              details: { projectIds: missing },
            }
          )
        }
        const adding = input.action === 'add_projects'
        const route = adding ? 'projects' : 'projects/remove'
        const expected: StoredTag = {
          ...current,
          projectIds: adding
            ? [...new Set([...current.projectIds, ...requested])]
            : current.projectIds.filter(id => !requested.includes(id)),
        }
        return await this.#apply(
          input.action,
          current.id,
          async () =>
            await this.#http.postJson(`/tag/${encodeURIComponent(current.id)}/${route}`, { projectIds: requested }),
          tag => tag !== undefined && requested.every(id => tag.projectIds.includes(id) === adding),
          expected
        )
      }
    }
  }

  /** Creating adds a tag, so the read-back finds it by its name rather than an id known beforehand. */
  async #create(name: string, color: string | undefined): Promise<ManageTagsResult> {
    let createdId: string | undefined
    let failure: McpError | undefined
    try {
      const parsed = createdTagSchema.safeParse(
        await this.#http.postJson('/tag', { name, ...(color === undefined ? {} : { color }) })
      )
      if (parsed.success && isPathSafeId(parsed.data._id)) createdId = parsed.data._id
    } catch (error) {
      failure = asMcpError(error)
      if (!mayHaveApplied(failure)) throw failure
    }
    const after = await this.#readBack(failure)
    const found = after?.find(tag => tag.name === name)
    if (found !== undefined && (color === undefined || found.color === color)) {
      return this.#result('create', found, false, true, failure !== undefined)
    }
    if (after === undefined && failure === undefined && createdId !== undefined) {
      return this.#result(
        'create',
        { id: createdId, name, ...(color === undefined ? {} : { color }), projectIds: [] },
        false,
        false,
        false
      )
    }
    throw this.#unknown(failure, undefined, after === undefined)
  }

  async #apply(
    action: Exclude<TagActionName, 'create'>,
    tagId: string,
    send: () => Promise<unknown>,
    holds: (tag: StoredTag | undefined) => boolean,
    expected: StoredTag
  ): Promise<ManageTagsResult> {
    let failure: McpError | undefined
    try {
      await send()
    } catch (error) {
      failure = asMcpError(error)
      if (!mayHaveApplied(failure)) throw failure
    }
    const after = await this.#readBack(failure)
    const deleted = action === 'delete'
    if (after === undefined) {
      // Overleaf answered 204 but the tags could not be read again: report what was asked for.
      if (failure === undefined) return this.#result(action, expected, deleted, false, false)
      throw this.#unknown(failure)
    }
    const tag = after.find(candidate => candidate.id === tagId)
    if (holds(tag)) return this.#result(action, deleted ? expected : tag!, deleted, true, failure !== undefined)
    throw this.#unknown(failure)
  }

  /** The tags after a write, or `undefined` when they cannot be read; a lost write never hides behind a read error. */
  async #readBack(failure: McpError | undefined): Promise<StoredTag[] | undefined> {
    try {
      return await this.#readTags()
    } catch (error) {
      if (failure !== undefined) throw this.#unknown(failure, asMcpError(error))
      return undefined
    }
  }

  #result(
    action: TagActionName,
    tag: StoredTag,
    deleted: boolean,
    verified: boolean,
    recovered: boolean
  ): ManageTagsResult {
    return {
      action,
      tag: this.#visible(tag),
      deleted,
      verified,
      ...(recovered ? { recoveredAfterTimeout: true as const } : {}),
    }
  }

  #unknown(failure: McpError | undefined, readFailure?: McpError, readFailed = false): McpError {
    const message =
      failure !== undefined
        ? 'The tag change got no clear answer from Overleaf and the tags read back do not show it applied; it may still apply. Read the tags with list_projects includeTags before acting; it was not resent.'
        : readFailed
          ? 'Overleaf accepted the tag change, but its answer named no tag and the tags could not be read back. Read the tags with list_projects includeTags before acting; do not repeat the change blindly.'
          : 'Overleaf accepted the tag change, but reading the tags back did not show it, perhaps because another change came in between. Read the tags with list_projects includeTags before acting; do not repeat the change blindly.'
    return new McpError('OUTCOME_UNKNOWN', message, {
      retryable: false,
      details: { outcome: 'unknown', ...(readFailure === undefined ? {} : { readBack: readFailure.code }) },
      ...(failure === undefined ? {} : { cause: failure }),
    })
  }

  #nameTaken(taken: StoredTag): McpError {
    return new McpError('INVALID_ARGUMENT', 'Another tag of this account already has that name; nothing was sent.', {
      details: { kind: 'tag_name_taken', tagId: taken.id },
    })
  }

  /**
   * Renaming or deleting a tag changes how every project in it is labelled, so with
   * `OVERLEAF_ALLOWED_PROJECTS` a tag holding a project outside the list is left alone.
   */
  #assertWholeTagAllowed(tag: StoredTag): void {
    if (tag.projectIds.every(id => this.#policy.allowsProject(id))) return
    throw new McpError(
      'POLICY_DENIED',
      'The tag holds projects outside OVERLEAF_ALLOWED_PROJECTS, so it cannot be edited or deleted here; nothing was sent.',
      { details: { parameter: 'tagId' } }
    )
  }
}
