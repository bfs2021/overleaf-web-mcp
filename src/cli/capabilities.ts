import type { AppConfig } from '../config.js'
import type { Effect } from '../contracts/effects.js'
import { ERROR_CODES } from '../contracts/error-codes.js'
import { OPERATION_NAMES, OPERATIONS, type OperationAnnotations } from '../contracts/operations.js'
import type { ProjectSummary } from '../overleaf/account.js'
import { SERVER_VERSION } from '../version.js'
import { ALIASES } from './commands.js'
import { EXIT_CODES } from './exit-codes.js'

type Unknown = 'unknown'

export interface CapabilitiesReport {
  version: string
  operations: Array<{
    name: string
    effects: readonly Effect[]
    annotations: OperationAnnotations
    /** Effects of this operation that OVERLEAF_ALLOWED_EFFECTS refuses; the operation fails when it needs one. */
    blockedEffects: Effect[]
    /** Shorthand commands for this operation besides `call <name>`. */
    commands: string[]
  }>
  policy: {
    projectsRestricted: boolean
    effectsRestricted: boolean
    localReadRestricted: boolean
    localWriteRestricted: boolean
  }
  /** Each field is "unknown" without a projectId, or when the policy refused the project. */
  project: {
    projectId: string
    allowedByPolicy: boolean | Unknown
    accessLevel: string
    archived: boolean | Unknown
    trashed: boolean | Unknown
  }
  /**
   * What the backend behind every operation can do. The only backend is the saved web session;
   * `review.decide` needs a projectId and is "unknown" without one or when the policy refused it.
   */
  backend: {
    kind: 'web-session'
    liveRevisions: boolean
    trackedWrites: boolean
    review: { list: boolean; decide: boolean | Unknown }
    comments: boolean
    compile: boolean
    history: boolean
  }
  errorCodes: readonly string[]
  exitCodes: typeof EXIT_CODES
}

/** What the project lookup found: the project, or that the policy refused it before any request. */
export type ProjectLookup =
  { projectId: string; summary: ProjectSummary; review: { decide: boolean } } | { projectId: string; denied: true }

/**
 * Describes what this install can do from its contracts and its configuration alone. Only the
 * project fields and `backend.review.decide` need requests, the project list and a join of the
 * project's socket; without a projectId, or for one the policy refuses, they are `unknown`. The
 * other `backend` fields describe the backend, not the access policy: `blockedEffects` does that.
 */
export function buildCapabilities(config: AppConfig, lookup?: ProjectLookup): CapabilitiesReport {
  const allowed = config.allowedEffects === undefined ? undefined : new Set<Effect>(config.allowedEffects)
  return {
    version: SERVER_VERSION,
    operations: OPERATION_NAMES.map(name => {
      const contract = OPERATIONS[name]
      return {
        name,
        effects: contract.effects,
        annotations: contract.annotations,
        blockedEffects: allowed === undefined ? [] : contract.effects.filter(effect => !allowed.has(effect)),
        commands: ALIASES.filter(alias => alias.tool === name).map(alias => alias.words.join(' ')),
      }
    }),
    policy: {
      projectsRestricted: config.allowedProjects !== undefined,
      effectsRestricted: config.allowedEffects !== undefined,
      localReadRestricted: config.localReadRoots !== undefined,
      localWriteRestricted: config.localWriteRoots !== undefined,
    },
    project:
      lookup === undefined
        ? {
            projectId: 'unknown',
            allowedByPolicy: 'unknown',
            accessLevel: 'unknown',
            archived: 'unknown',
            trashed: 'unknown',
          }
        : 'denied' in lookup
          ? {
              projectId: lookup.projectId,
              allowedByPolicy: false,
              accessLevel: 'unknown',
              archived: 'unknown',
              trashed: 'unknown',
            }
          : {
              projectId: lookup.projectId,
              allowedByPolicy: true,
              accessLevel: lookup.summary.accessLevel,
              archived: lookup.summary.archived,
              trashed: lookup.summary.trashed,
            },
    backend: {
      kind: 'web-session',
      liveRevisions: true,
      trackedWrites: true,
      review: {
        list: true,
        decide: lookup === undefined || 'denied' in lookup ? 'unknown' : lookup.review.decide,
      },
      comments: true,
      compile: true,
      history: true,
    },
    errorCodes: ERROR_CODES,
    exitCodes: EXIT_CODES,
  }
}
