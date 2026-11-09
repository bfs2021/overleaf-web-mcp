import { isDeepStrictEqual } from 'node:util'

import { asMcpError, McpError } from '../core/errors.js'
import { assertDocumentSize, assertUpdateSize } from '../core/limits.js'
import { AccessPolicy } from '../core/policy.js'
import type { FifoQueue } from '../core/queue.js'
import { assertRevisionMatches, createRevision, type OtProtocol } from '../core/revision.js'
import type { LineColumn } from '../core/text.js'
import { makeUpdate, type HistorySnapshot } from '../protocol/ot.js'
import type { JoinedDocument } from '../protocol/project-connection.js'
import {
  canonicalHistorySnapshot,
  createLocator,
  excerpt,
  expectedAfterDecision,
  missingChangeIds,
  overlappingChanges,
  parseHistoryOtChanges,
  parseShareJsChanges,
  planHistoryOtDecision,
  planShareJsReject,
  visibleEnd,
  type ExpectedDecisionState,
  type HistoryOtTrackedChange,
  type TrackedChange,
  type TrackedChangeAction,
  type TrackedChangeType,
} from '../protocol/tracked-changes.js'
import {
  isUnchangedDocument,
  isUnconfirmedWriteError,
  notAppliedError,
  observeUnconfirmedWrite,
  refusedUpdateReason,
  type RecoveryState,
} from './recovery.js'
import { resolveProjectPath, type ProjectEntity } from './tree.js'

export const DEFAULT_TRACKED_CHANGE_LIMIT = 100
export const MAX_TRACKED_CHANGE_LIMIT = 500
export const DEFAULT_EXCERPT_CHARS = 120
export const MAX_EXCERPT_CHARS = 500
export const MAX_CHANGE_IDS = 500

interface TrackedChangesHttp {
  getJson(path: string): Promise<unknown>
  /** Resolves only for a successful status; the body is never read. */
  request(method: string, path: string, body?: unknown): Promise<Response>
}

interface TrackedChangesConnection {
  queue: FifoQueue
  getTree(): ProjectEntity[]
  joinDocument(docId: string): Promise<JoinedDocument>
  leaveDocument(docId: string): Promise<void>
  submitUpdate(docId: string, update: Record<string, unknown>): Promise<void>
  trackChangesActive: boolean
  /** `owner`, `readAndWrite`, `review`, or `readOnly`, as joinProject reports it. */
  permissionsLevel: string
  /** The project as joinProject reports it; `features` is read defensively. */
  project: { features?: unknown }
}

interface TrackedChangesConnections {
  withConnection<T>(projectId: string, operation: (connection: TrackedChangesConnection) => Promise<T>): Promise<T>
  invalidate(projectId: string): Promise<void>
}

export interface TrackedChangesApiOptions {
  maxDocLength?: number
  maxUpdateChars?: number
  recoveryTimeoutMs?: number
  recoveryPollIntervalMs?: number
  /** Defaults to allowing everything but ids that are not path-safe. */
  policy?: AccessPolicy
}

export interface ListedTrackedChange {
  changeId: string
  type: TrackedChangeType
  start: LineColumn
  end: LineColumn
  length: number
  excerpt?: string
  excerptTruncated: boolean
  authorId: string | null
  timestamp?: string
  pairedChangeId?: string
}

export interface TrackedChangeDocument {
  filePath: string
  revision: string
  protocol: OtProtocol
  totalChanges: number
  undecidableChanges?: number
  changes: ListedTrackedChange[]
}

export interface ListTrackedChangesOptions {
  filePath?: string | undefined
  type?: TrackedChangeType | undefined
  authorId?: string | undefined
  excerptChars?: number | undefined
  limit?: number | undefined
}

export interface ListTrackedChangesResult {
  documents: TrackedChangeDocument[]
  totalMatched: number
  truncated: boolean
  trackChangesActive: boolean
  indexUnavailable?: true
}

export interface ManageTrackedChangesInput {
  projectId: string
  filePath: string
  revision: string
  action: TrackedChangeAction
  changeIds: readonly string[]
  confirmCount?: number | undefined
}

export interface ManageTrackedChangesResult {
  action: TrackedChangeAction
  filePath: string
  changeIds: string[]
  revision: string
  protocol: OtProtocol
  remainingChangeCount: number
  trackChangesActive: boolean
  recoveredAfterTimeout?: true
}

/** How a decision reaches Overleaf: the REST accept route, or one untracked OT update. */
type DecisionPlan =
  | { kind: 'rest'; expected: ExpectedDecisionState }
  | { kind: 'ot'; update: Record<string, unknown>; expected: ExpectedDecisionState }

interface Submission {
  entity: ProjectEntity
  before: JoinedDocument
  plan: DecisionPlan
  trackChangesActive: boolean
  live?: JoinedDocument
  submitError?: unknown
  /** Overleaf acknowledged the decision and only the verification read failed. */
  confirmed?: true
}

const ACCESS_LEVELS = new Set(['owner', 'readAndWrite', 'review', 'readOnly'])
/** The levels Overleaf lets accept a change and send an untracked edit, which a reject is. */
const DECIDING_LEVELS = new Set(['owner', 'readAndWrite'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseChanges(document: JoinedDocument): TrackedChange[] {
  return document.protocol === 'history-ot'
    ? parseHistoryOtChanges(document.rawSnapshot as HistorySnapshot, document.docId)
    : parseShareJsChanges(document.ranges)
}

function revisionOf(projectId: string, document: JoinedDocument): string {
  return createRevision({
    projectId,
    docId: document.docId,
    protocol: document.protocol,
    otVersion: document.version,
    content: document.content,
  })
}

async function leaveQuietly(connection: TrackedChangesConnection, docId: string): Promise<void> {
  try {
    await connection.leaveDocument(docId)
  } catch {
    // A later connection refresh cleans up the room.
  }
}

/** Ids from the project range index whose entry lists at least one tracked change. */
function indexedDocumentIds(index: unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of index) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue
    const ranges = entry.ranges
    if (isRecord(ranges) && Array.isArray(ranges.changes) && ranges.changes.length > 0) ids.add(entry.id)
  }
  return ids
}

function assertWholeNumber(value: number, parameter: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new McpError('INVALID_ARGUMENT', `${parameter} must be a whole number from ${min} to ${max}.`, {
      details: { parameter },
    })
  }
}

/** Refuses a caller who cannot decide tracked changes, before any document is read. */
function assertCanDecide(connection: TrackedChangesConnection): void {
  const level = connection.permissionsLevel
  if (!DECIDING_LEVELS.has(level)) {
    throw new McpError(
      'PERMISSION_DENIED',
      'Accepting or rejecting tracked changes needs owner or edit access to the project; review-only and read-only collaborators cannot decide them here. Nothing was sent.',
      { details: { accessLevel: ACCESS_LEVELS.has(level) ? level : 'unrecognized' } }
    )
  }
  const features = isRecord(connection.project) ? connection.project.features : undefined
  if (isRecord(features) && (features.trackChanges === false || features.trackChangesVisible === false)) {
    throw new McpError(
      'REVIEW_UNSUPPORTED',
      "Track changes is not available for this project, on its owner's plan or on this Overleaf deployment, so its tracked changes cannot be decided. Nothing was sent.",
      { details: { kind: 'feature_disabled' } }
    )
  }
}

/** Whether this account can accept or reject tracked changes in the joined project, as checked before a decision. */
export function canDecideTrackedChanges(connection: TrackedChangesConnection): boolean {
  try {
    assertCanDecide(connection)
    return true
  } catch {
    return false
  }
}

/** Refuses ids that name no live change, and a decision that would leave an overlapping change behind. */
function assertDecidable(changes: readonly TrackedChange[], changeIds: readonly string[]): void {
  const missing = missingChangeIds(changes, changeIds)
  if (missing.length > 0) {
    throw new McpError(
      'NOT_FOUND',
      'Some changeIds are not tracked changes in this document: they were decided already, merged, or belong elsewhere. List the tracked changes again. Nothing was sent.',
      { details: { missingChangeIds: missing } }
    )
  }
  const overlapping = overlappingChanges(changes, changeIds)
  if (overlapping.length > 0) {
    const named = overlapping.flatMap(change => (change.changeId === undefined ? [] : [change.changeId]))
    const unnamed = overlapping.length - named.length
    throw new McpError(
      'INVALID_ARGUMENT',
      'A tracked change that was left out overlaps one of the chosen changes; decide them together. Nothing was sent.',
      { details: { overlappingChangeIds: named, ...(unnamed > 0 ? { undecidableOverlaps: unnamed } : {}) } }
    )
  }
}

/**
 * Refuses a ShareJS reject whose chosen ranges disagree with the text: an insert whose text is not
 * at its position, or a delete point past the end. Overleaf would refuse that edit, possibly after
 * acknowledging it, which leaves the outcome unknown instead of nothing sent.
 */
function assertRangesMatchContent(
  content: string,
  changes: readonly TrackedChange[],
  changeIds: readonly string[]
): void {
  const chosen = new Set(changeIds)
  for (const change of changes) {
    if (change.changeId === undefined || !chosen.has(change.changeId)) continue
    const matches =
      change.type === 'insert'
        ? content.slice(change.position, change.position + change.length) === change.text
        : change.position <= content.length
    if (!matches) {
      throw new McpError(
        'PROTOCOL_UNSUPPORTED',
        'A chosen tracked change does not match the document text, so it cannot be rejected safely. Nothing was sent.'
      )
    }
  }
}

/**
 * Remaps a failed REST accept: a definite refusal becomes its error, and anything that may have
 * reached Overleaf (a timeout, a transport failure, or a server error) is `undefined`, to observe.
 */
function restAcceptFailure(error: unknown): McpError | undefined {
  if (!(error instanceof McpError)) return undefined
  if (error.code === 'TIMEOUT') return undefined
  if (error.code === 'NOT_FOUND') {
    // The document was just read, so a 404 is the route, not the document.
    return new McpError(
      'REVIEW_UNSUPPORTED',
      'This Overleaf deployment has no route to accept tracked changes. Nothing was changed.',
      { details: { kind: 'route_unavailable' } }
    )
  }
  if (error.code !== 'REMOTE_ERROR') return error
  const status = error.details?.status
  if (typeof status !== 'number') return undefined
  if (status === 422) {
    return new McpError(
      'REVIEW_UNSUPPORTED',
      "Overleaf refused to accept tracked changes in this document's protocol. Nothing was changed.",
      { details: { kind: 'document_protocol' } }
    )
  }
  if (status === 400) {
    return new McpError('INVALID_ARGUMENT', 'Overleaf refused the changeIds as malformed. Nothing was changed.', {
      details: { status },
    })
  }
  return status >= 500 ? undefined : error
}

/**
 * Lists tracked changes and accepts or rejects them, one document per decision. Every decision is
 * checked against the live document before it is sent, sent once, and verified on a fresh join.
 */
export class TrackedChangesApi {
  readonly #http: TrackedChangesHttp
  readonly #connections: TrackedChangesConnections
  readonly #maxDocLength: number
  readonly #maxUpdateChars: number
  readonly #recoveryTimeoutMs: number
  readonly #recoveryPollIntervalMs: number
  readonly #policy: AccessPolicy

  constructor(
    http: TrackedChangesHttp,
    connections: TrackedChangesConnections,
    options: TrackedChangesApiOptions = {}
  ) {
    this.#http = http
    this.#connections = connections
    this.#maxDocLength = options.maxDocLength ?? 2 * 1024 * 1024
    this.#maxUpdateChars = options.maxUpdateChars ?? 7 * 1024 * 1024
    this.#recoveryTimeoutMs = options.recoveryTimeoutMs ?? 30_000
    this.#recoveryPollIntervalMs = options.recoveryPollIntervalMs ?? 250
    this.#policy = options.policy ?? AccessPolicy.permissive
  }

  async listTrackedChanges(
    projectId: string,
    options: ListTrackedChangesOptions = {}
  ): Promise<ListTrackedChangesResult> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read')
    const limit = options.limit ?? DEFAULT_TRACKED_CHANGE_LIMIT
    const excerptChars = options.excerptChars ?? DEFAULT_EXCERPT_CHARS
    assertWholeNumber(limit, 'limit', 1, MAX_TRACKED_CHANGE_LIMIT)
    assertWholeNumber(excerptChars, 'excerptChars', 0, MAX_EXCERPT_CHARS)

    let indexed: Set<string> | undefined
    if (options.filePath === undefined) {
      // The index chooses the documents to read; without it, no document is read at all.
      let index: unknown
      try {
        index = await this.#http.getJson(`/project/${encodeURIComponent(projectId)}/ranges`)
      } catch (error) {
        if (!(error instanceof McpError) || !['NOT_FOUND', 'PROTOCOL_UNSUPPORTED'].includes(error.code)) throw error
      }
      if (!Array.isArray(index)) {
        const trackChangesActive = await this.#connections.withConnection(projectId, connection =>
          Promise.resolve(connection.trackChangesActive)
        )
        return { documents: [], totalMatched: 0, truncated: false, trackChangesActive, indexUnavailable: true }
      }
      indexed = indexedDocumentIds(index)
    }

    return await this.#connections.withConnection(
      projectId,
      async connection =>
        await connection.queue.run(async () => {
          const tree = connection.getTree()
          const entities =
            options.filePath === undefined
              ? tree.filter(entity => entity.type === 'doc' && indexed!.has(entity.id))
              : [resolveProjectPath(tree, options.filePath, 'doc')]

          const documents: TrackedChangeDocument[] = []
          let totalMatched = 0
          let remaining = limit
          for (const entity of entities) {
            const document = await connection.joinDocument(entity.id)
            await leaveQuietly(connection, entity.id)
            const changes = parseChanges(document)
            const undecidable = changes.filter(change => change.changeId === undefined).length
            const matching = changes.filter(
              change =>
                change.changeId !== undefined &&
                (options.type === undefined || change.type === options.type) &&
                (options.authorId === undefined || change.authorId === options.authorId)
            )
            totalMatched += matching.length
            const locate = createLocator(document.content)
            const listed = matching.slice(0, remaining).map((change): ListedTrackedChange => {
              const cut = excerpt(change.text, excerptChars)
              return {
                changeId: change.changeId!,
                type: change.type,
                start: locate(change.position),
                end: locate(visibleEnd(change)),
                length: change.length,
                ...(excerptChars === 0 ? {} : { excerpt: cut.excerpt }),
                excerptTruncated: cut.truncated,
                authorId: change.authorId,
                ...(change.timestamp === undefined ? {} : { timestamp: change.timestamp }),
                ...(change.pairedChangeId === undefined ? {} : { pairedChangeId: change.pairedChangeId }),
              }
            })
            remaining -= listed.length
            documents.push({
              filePath: entity.path,
              revision: revisionOf(projectId, document),
              protocol: document.protocol,
              totalChanges: changes.length,
              ...(undecidable > 0 ? { undecidableChanges: undecidable } : {}),
              changes: listed,
            })
          }
          return {
            documents,
            totalMatched,
            truncated: totalMatched > limit,
            trackChangesActive: connection.trackChangesActive,
          }
        })
    )
  }

  async manageTrackedChanges(input: ManageTrackedChangesInput): Promise<ManageTrackedChangesResult> {
    this.#policy.assertProject(input.projectId)
    // The document is read before and after the decision, so that read is allowed first.
    this.#policy.assertEffect('overleaf-write', 'overleaf-read')
    if (input.action !== 'accept' && input.action !== 'reject') {
      throw new McpError('INVALID_ARGUMENT', 'action must be accept or reject.', { details: { parameter: 'action' } })
    }
    const changeIds = [...input.changeIds]
    if (input.confirmCount !== changeIds.length) {
      throw new McpError(
        'CONFIRMATION_MISMATCH',
        'confirmCount must equal the number of changeIds, after the user has confirmed the changes. Nothing was sent.',
        input.confirmCount === undefined ? { details: { missing: 'confirmCount' } } : {}
      )
    }
    if (changeIds.length === 0 || changeIds.length > MAX_CHANGE_IDS) {
      throw new McpError('INVALID_ARGUMENT', `changeIds must hold 1 to ${MAX_CHANGE_IDS} ids.`, {
        details: { parameter: 'changeIds' },
      })
    }
    if (changeIds.some(id => typeof id !== 'string' || id === '')) {
      throw new McpError('INVALID_ARGUMENT', 'Every changeId must be a non-empty string.', {
        details: { parameter: 'changeIds' },
      })
    }
    const duplicates = [...new Set(changeIds.filter((id, index) => changeIds.indexOf(id) !== index))]
    if (duplicates.length > 0) {
      throw new McpError('INVALID_ARGUMENT', 'changeIds lists an id more than once.', {
        details: { parameter: 'changeIds', duplicateChangeIds: duplicates },
      })
    }

    const submission = await this.#connections.withConnection(
      input.projectId,
      async connection =>
        await connection.queue.run(async (): Promise<Submission> => {
          assertCanDecide(connection)
          const entity = resolveProjectPath(connection.getTree(), input.filePath, 'doc')
          const before = await connection.joinDocument(entity.id)
          let plan: DecisionPlan
          try {
            assertRevisionMatches(input.revision, {
              projectId: input.projectId,
              docId: entity.id,
              protocol: before.protocol,
              otVersion: before.version,
              content: before.content,
            })
            plan = this.#plan(before, changeIds, input.action)
          } catch (error) {
            await leaveQuietly(connection, entity.id)
            throw error
          }
          const base = { entity, before, plan, trackChangesActive: connection.trackChangesActive }

          let submitError: unknown
          try {
            if (plan.kind === 'rest') await this.#postAccept(input.projectId, entity.id, changeIds)
            else await connection.submitUpdate(entity.id, plan.update)
          } catch (error) {
            submitError = error
          }
          await leaveQuietly(connection, entity.id)
          if (submitError !== undefined) {
            const definite =
              plan.kind === 'rest'
                ? restAcceptFailure(submitError)
                : isUnconfirmedWriteError(submitError)
                  ? undefined
                  : asMcpError(submitError)
            if (definite !== undefined) throw definite
            return { ...base, submitError }
          }

          let live: JoinedDocument
          try {
            live = await connection.joinDocument(entity.id)
          } catch (error) {
            // The decision was acknowledged, so a failed verification read is settled by observation.
            return { ...base, submitError: error, confirmed: true }
          }
          await leaveQuietly(connection, entity.id)
          return { ...base, live }
        })
    )

    const { entity, before, plan } = submission
    let live = submission.live
    let recoveredAfterTimeout = false
    if (live !== undefined) {
      if (live.protocol !== before.protocol) {
        throw new McpError('PROTOCOL_UNSUPPORTED', 'Document protocol changed during tracked-change verification.')
      }
      if (!this.#reachedTarget(plan, before, live, changeIds)) {
        throw new McpError(
          'REVISION_CONFLICT',
          'The document read back after the decision does not show its expected result.',
          { retryable: false, details: { outcome: 'unknown', liveRevision: revisionOf(input.projectId, live) } }
        )
      }
    } else {
      // Never resend an unconfirmed decision: observe which state is live.
      await this.#connections.invalidate(input.projectId)
      const observation = await observeUnconfirmedWrite({
        observe: async () =>
          await this.#connections.withConnection(
            input.projectId,
            async connection =>
              await connection.queue.run(async () => {
                const current = resolveProjectPath(connection.getTree(), input.filePath, 'doc')
                const document = await connection.joinDocument(current.id)
                await leaveQuietly(connection, current.id)
                return document
              })
          ),
        classify: document => this.#classify(plan, before, document, changeIds),
        timeoutMs: this.#recoveryTimeoutMs,
        pollIntervalMs: this.#recoveryPollIntervalMs,
        onOther: document =>
          new McpError('REVISION_CONFLICT', 'The document changed while the decision was unconfirmed.', {
            retryable: false,
            details: { outcome: 'unknown', liveRevision: revisionOf(input.projectId, document) },
          }),
        onUnobserved: cause =>
          new McpError('OUTCOME_UNKNOWN', 'Could not observe the document after the unconfirmed decision.', { cause }),
      })
      if (observation.state === 'original') {
        if (submission.confirmed) {
          throw new McpError(
            'OUTCOME_UNKNOWN',
            'Overleaf acknowledged the decision but its result could not be verified. Do not retry it; list the tracked changes first.',
            { retryable: false }
          )
        }
        const reason = refusedUpdateReason(submission.submitError)
        throw notAppliedError(
          submission.submitError,
          'The decision was not confirmed and the changes are still live.',
          reason === undefined ? {} : { reason }
        )
      }
      live = observation.observed
      recoveredAfterTimeout = true
    }

    return {
      action: input.action,
      filePath: entity.path,
      changeIds,
      revision: revisionOf(input.projectId, live),
      protocol: live.protocol,
      remainingChangeCount: parseChanges(live).length,
      trackChangesActive: submission.trackChangesActive,
      ...(recoveredAfterTimeout ? { recoveredAfterTimeout: true } : {}),
    }
  }

  /** Checks the decision against the live document and builds what is sent and what it should leave. */
  #plan(before: JoinedDocument, changeIds: readonly string[], action: TrackedChangeAction): DecisionPlan {
    if (before.protocol === 'history-ot') {
      const snapshot = before.rawSnapshot as HistorySnapshot
      const changes: HistoryOtTrackedChange[] = parseHistoryOtChanges(snapshot, before.docId)
      assertDecidable(changes, changeIds)
      const operation = planHistoryOtDecision(snapshot, changes, changeIds, action)
      const expected = expectedAfterDecision({ protocol: 'history-ot', snapshot, changes, changeIds, action })
      return this.#otPlan(before, [operation], expected)
    }
    const changes = parseShareJsChanges(before.ranges)
    assertDecidable(changes, changeIds)
    const expected = expectedAfterDecision({ protocol: 'sharejs', content: before.content, changes, changeIds, action })
    if (action === 'accept') return { kind: 'rest', expected }
    assertRangesMatchContent(before.content, changes, changeIds)
    // A reject is an untracked edit: no tracking metadata, so it can never be recorded as a suggestion.
    return this.#otPlan(before, planShareJsReject(changes, changeIds), expected)
  }

  #otPlan(before: JoinedDocument, operation: unknown[], expected: ExpectedDecisionState): DecisionPlan {
    assertDocumentSize(expected.content, this.#maxDocLength)
    const update = makeUpdate(before.docId, before.version, operation, before.protocol)
    assertUpdateSize(update, this.#maxUpdateChars)
    return { kind: 'ot', update, expected }
  }

  async #postAccept(projectId: string, docId: string, changeIds: readonly string[]): Promise<void> {
    const response = await this.#http.request(
      'POST',
      `/project/${encodeURIComponent(projectId)}/doc/${encodeURIComponent(docId)}/changes/accept`,
      { change_ids: changeIds }
    )
    // The reply can carry previews of document text, so it is discarded unread.
    try {
      await response.body?.cancel()
    } catch {
      // Nothing to release.
    }
  }

  /** Whether a fresh join shows exactly what the decision should leave. */
  #reachedTarget(
    plan: DecisionPlan,
    before: JoinedDocument,
    live: JoinedDocument,
    changeIds: readonly string[]
  ): boolean {
    if (live.protocol !== before.protocol || live.content !== plan.expected.content) return false
    if (live.protocol === 'history-ot') {
      return isDeepStrictEqual(canonicalHistorySnapshot(live.rawSnapshot as HistorySnapshot), plan.expected.snapshot)
    }
    return missingChangeIds(parseChanges(live), changeIds).length === changeIds.length
  }

  /**
   * Classifies an observation after an unconfirmed decision. A REST accept changes no text, so it
   * is told by its ids alone: all gone is the target and all still present the original. An OT
   * decision is the target when the document shows its expected result, and the original when
   * the document is exactly as it was.
   */
  #classify(
    plan: DecisionPlan,
    before: JoinedDocument,
    live: JoinedDocument,
    changeIds: readonly string[]
  ): RecoveryState {
    if (live.protocol !== before.protocol) return 'other'
    if (plan.kind === 'rest') {
      const missing = missingChangeIds(parseChanges(live), changeIds).length
      if (missing === changeIds.length) return 'target'
      return missing === 0 ? 'original' : 'other'
    }
    if (this.#reachedTarget(plan, before, live, changeIds)) return 'target'
    return isUnchangedDocument(live, before) ? 'original' : 'other'
  }
}
