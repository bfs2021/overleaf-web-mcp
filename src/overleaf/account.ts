import { z } from 'zod'

import { McpError } from '../core/errors.js'
import { AccessPolicy } from '../core/policy.js'

export interface JsonPoster {
  postJson(path: string, body?: unknown, options?: { read?: boolean }): Promise<unknown>
}

export interface ProjectSummary {
  id: string
  name: string
  accessLevel: string
  /** ISO timestamp of the last change Overleaf recorded, when it reported one. */
  lastUpdated?: string
  archived: boolean
  trashed: boolean
}

export type ProjectSort = 'lastUpdated' | 'name'

export interface ListProjectsOptions {
  /** Case-insensitive substring matched against the project name. */
  query?: string | undefined
  includeArchived?: boolean | undefined
  includeTrashed?: boolean | undefined
  /** Maximum number of projects returned after filtering and sorting. */
  limit?: number | undefined
  /** `lastUpdated` is newest first; `name` is alphabetical. */
  sort?: ProjectSort | undefined
}

export interface ProjectListing {
  projects: ProjectSummary[]
  /** Projects that passed the filters, before `limit` was applied. */
  totalMatched: number
  /** Every project the account can access, including archived and trashed ones. */
  totalProjects: number
}

export const DEFAULT_PROJECT_LIMIT = 50
export const MAX_PROJECT_LIMIT = 200

const listedProjectSchema = z
  .object({
    _id: z.string().optional(),
    id: z.string().optional(),
    name: z.string(),
    accessLevel: z.string(),
    lastUpdated: z.string().optional(),
    archived: z.boolean().optional(),
    trashed: z.boolean().optional(),
  })
  .refine(project => project._id !== undefined || project.id !== undefined, {
    message: 'project without an id',
  })

const projectListSchema = z.object({
  totalSize: z.number().int().nonnegative().optional(),
  projects: z.array(listedProjectSchema),
})

function compareByLastUpdated(left: ProjectSummary, right: ProjectSummary): number {
  // Projects Overleaf never dated sort last, then ties fall back to the name.
  if (left.lastUpdated === undefined) return right.lastUpdated === undefined ? 0 : 1
  if (right.lastUpdated === undefined) return -1
  return right.lastUpdated.localeCompare(left.lastUpdated) || left.name.localeCompare(right.name)
}

/**
 * Reads the account's project list through the same endpoint the Overleaf dashboard uses.
 *
 * Overleaf returns every project in one response and paginates in the browser, so filtering,
 * sorting, and `limit` are applied here rather than requested from the server.
 */
export class AccountApi {
  readonly #http: JsonPoster
  readonly #policy: AccessPolicy

  constructor(http: JsonPoster, policy: AccessPolicy = AccessPolicy.permissive) {
    this.#http = http
    this.#policy = policy
  }

  /**
   * Every project the account can access, or with `OVERLEAF_ALLOWED_PROJECTS` only the allowed
   * ones; projects outside the allowlist are not listed or counted.
   */
  async fetchProjects(): Promise<{ projects: ProjectSummary[]; totalSize: number }> {
    this.#policy.assertEffect('overleaf-read')
    // A POST that only reads, so it is retried like a GET after a passing failure.
    const response = await this.#http.postJson('/api/project', {}, { read: true })
    let parsed: z.infer<typeof projectListSchema>
    try {
      parsed = projectListSchema.parse(response)
    } catch (error) {
      throw new McpError('PROTOCOL_UNSUPPORTED', 'Overleaf returned an unsupported project list response.', {
        cause: error,
      })
    }
    const projects = parsed.projects.map(project => ({
      // The refine above guarantees one of the two is present.
      id: (project.id ?? project._id) as string,
      name: project.name,
      accessLevel: project.accessLevel,
      ...(project.lastUpdated === undefined ? {} : { lastUpdated: project.lastUpdated }),
      archived: project.archived ?? false,
      trashed: project.trashed ?? false,
    }))
    if (this.#policy.restrictsProjects) {
      const allowed = projects.filter(project => this.#policy.allowsProject(project.id))
      return { projects: allowed, totalSize: allowed.length }
    }
    return { projects, totalSize: parsed.totalSize ?? projects.length }
  }

  async listProjects(options: ListProjectsOptions = {}): Promise<ProjectListing> {
    const limit = options.limit ?? DEFAULT_PROJECT_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROJECT_LIMIT) {
      throw new McpError('INVALID_ARGUMENT', `limit must be an integer between 1 and ${MAX_PROJECT_LIMIT}.`)
    }
    const query = options.query?.toLowerCase()
    const { projects, totalSize } = await this.fetchProjects()
    const matched = projects.filter(
      project =>
        (options.includeArchived === true || !project.archived) &&
        (options.includeTrashed === true || !project.trashed) &&
        (query === undefined || query === '' || project.name.toLowerCase().includes(query))
    )
    matched.sort(options.sort === 'name' ? (left, right) => left.name.localeCompare(right.name) : compareByLastUpdated)
    return {
      projects: matched.slice(0, limit),
      totalMatched: matched.length,
      totalProjects: totalSize,
    }
  }

  async countProjects(): Promise<number> {
    return (await this.fetchProjects()).totalSize
  }

  /** Looks a project up by id, including archived and trashed ones. */
  async findProject(projectId: string): Promise<ProjectSummary> {
    this.#policy.assertProject(projectId)
    const { projects } = await this.fetchProjects()
    const project = projects.find(candidate => candidate.id === projectId)
    if (!project) {
      throw new McpError('NOT_FOUND', 'Project was not found in the projects this account can access.')
    }
    return project
  }
}
