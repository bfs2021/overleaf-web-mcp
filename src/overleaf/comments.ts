import { asMcpError, McpError } from '../core/errors.js'
import { assertUpdateSize } from '../core/limits.js'
import { AccessPolicy, assertPathSafeId } from '../core/policy.js'
import type { FifoQueue } from '../core/queue.js'
import { assertRevisionMatches, createRevision, type OtProtocol } from '../core/revision.js'
import { lineColumnToOffset, normalizeLf, offsetToLineColumn, type LineColumn } from '../core/text.js'
import {
  buildCommentOperation,
  buildStatusOperation,
  generateIdSeed,
  makeUpdate,
  snapshotToVisibleOffset,
  visibleToSnapshotOffset,
  type HistorySnapshot,
} from '../protocol/ot.js'
import type { JoinedDocument } from '../protocol/project-connection.js'
import {
  isUnchangedDocument,
  isUnconfirmedWriteError,
  notAppliedError,
  observeUnconfirmedWrite,
  refusedUpdateReason,
} from './recovery.js'
import { resolveProjectPath, type ProjectEntity } from './tree.js'

interface CommentHttp {
  getJson(path: string): Promise<unknown>
  postJson(path: string, body?: unknown): Promise<unknown>
  deleteJson(path: string): Promise<unknown>
}

interface CommentConnection {
  queue: FifoQueue
  getTree(): ProjectEntity[]
  joinDocument(docId: string): Promise<JoinedDocument>
  leaveDocument(docId: string): Promise<void>
  submitUpdate(docId: string, update: Record<string, unknown>): Promise<void>
  trackChangesActive: boolean
}

interface CommentConnections {
  withConnection<T>(projectId: string, operation: (connection: CommentConnection) => Promise<T>): Promise<T>
  invalidate(projectId: string): Promise<void>
}

interface OverleafUser {
  id?: string
  first_name?: string
  last_name?: string
  [key: string]: unknown
}

interface ThreadMessage {
  id?: string
  content?: string
  timestamp?: string | number
  user_id?: string
  user?: OverleafUser
  [key: string]: unknown
}

interface ThreadData {
  messages?: ThreadMessage[]
  resolved?: boolean
  resolved_at?: string | number
  resolved_by_user_id?: string
  resolved_by_user?: OverleafUser
  [key: string]: unknown
}

type ThreadsResponse = Record<string, ThreadData>

interface LocatedRange {
  threadId: string
  docId: string
  start: number
  end: number
  quotedText?: string
  resolved?: boolean
}

export interface CommentAuthor {
  id: string
  displayName: string
}

export interface CommentMessage {
  id?: string
  author: CommentAuthor | null
  content: string
  timestamp?: string
}

export interface CommentThread {
  id: string
  status: 'open' | 'resolved'
  messages: CommentMessage[]
  resolvedAt?: string
  resolvedBy?: CommentAuthor
}

export interface ListedComment extends CommentThread {
  filePath?: string
  start?: LineColumn
  end?: LineColumn
  quotedText?: string
  unlocated?: true
}

export interface AddCommentInput {
  projectId: string
  filePath: string
  revision: string
  start: LineColumn
  end: LineColumn
  expectedText: string
  content: string
}

export interface CommentsApiOptions {
  currentUserId?: string
  maxUpdateChars?: number
  threadIdFactory?: () => string
  now?: () => number
  recoveryTimeoutMs?: number
  recoveryPollIntervalMs?: number
  /** Defaults to allowing everything but ids that are not path-safe. */
  policy?: AccessPolicy
}

function generateThreadId(): string {
  return `${generateIdSeed()}000001`
}

function legacyRange(docId: string, value: unknown): LocatedRange | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entry = value as {
    id?: unknown
    op?: { p?: unknown; c?: unknown; t?: unknown }
    resolved?: unknown
  }
  const threadId = typeof entry.op?.t === 'string' ? entry.op.t : typeof entry.id === 'string' ? entry.id : undefined
  const start = entry.op?.p
  const text = entry.op?.c
  if (!threadId || typeof start !== 'number' || typeof text !== 'string') return undefined
  return {
    threadId,
    docId,
    start,
    end: start + text.length,
    quotedText: text,
    ...(typeof entry.resolved === 'boolean' ? { resolved: entry.resolved } : {}),
  }
}

function rangesFromDocument(document: JoinedDocument): LocatedRange[] {
  if (document.protocol === 'history-ot') {
    const snapshot = document.rawSnapshot as HistorySnapshot
    return (snapshot.comments ?? []).flatMap(comment => {
      const range = comment.ranges[0]
      if (!range) return []
      const start = snapshotToVisibleOffset(snapshot, range.pos)
      const end = snapshotToVisibleOffset(snapshot, range.pos + range.length)
      return [
        {
          threadId: comment.id,
          docId: document.docId,
          start,
          end,
          quotedText: document.content.slice(start, end),
          // Overleaf leaves resolved out of an open comment's snapshot entry.
          resolved: comment.resolved === true,
        },
      ]
    })
  }
  const comments = (document.ranges as { comments?: unknown[] } | undefined)?.comments ?? []
  return comments.flatMap(value => {
    const range = legacyRange(document.docId, value)
    return range ? [range] : []
  })
}

function projectRanges(value: unknown): LocatedRange[] {
  if (!Array.isArray(value)) return []
  const output: LocatedRange[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const entry = item as { id?: unknown; ranges?: { comments?: unknown[] } }
    if (typeof entry.id !== 'string') continue
    for (const comment of entry.ranges?.comments ?? []) {
      const range = legacyRange(entry.id, comment)
      if (range) output.push(range)
    }
  }
  return output
}

function isoTimestamp(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

// Overleaf sends each user's name and email; only the id and display name leave this module.
function mapAuthor(userId: string | undefined, user: OverleafUser | undefined): CommentAuthor | null {
  const id = typeof user?.id === 'string' ? user.id : typeof userId === 'string' ? userId : undefined
  if (id === undefined) return null
  const names = [user?.first_name, user?.last_name].filter(name => typeof name === 'string')
  return { id, displayName: names.join(' ').trim() }
}

function mapMessage(message: ThreadMessage): CommentMessage {
  const timestamp = isoTimestamp(message.timestamp)
  return {
    ...(typeof message.id === 'string' ? { id: message.id } : {}),
    author: mapAuthor(message.user_id, message.user),
    content: typeof message.content === 'string' ? message.content : '',
    ...(timestamp === undefined ? {} : { timestamp }),
  }
}

function mapThread(id: string, thread: ThreadData): CommentThread {
  const resolved = thread.resolved === true
  const resolvedAt = resolved ? isoTimestamp(thread.resolved_at) : undefined
  const resolvedBy = resolved ? mapAuthor(thread.resolved_by_user_id, thread.resolved_by_user) : null
  return {
    id,
    status: resolved ? 'resolved' : 'open',
    messages: (thread.messages ?? []).map(mapMessage),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    ...(resolvedBy === null ? {} : { resolvedBy }),
  }
}

function authorMatches(thread: CommentThread, filter: string): boolean {
  const needle = filter.toLocaleLowerCase()
  return thread.messages.some(
    ({ author }) => author !== null && (author.id === filter || author.displayName.toLocaleLowerCase().includes(needle))
  )
}

async function leaveQuietly(connection: CommentConnection, docId: string): Promise<void> {
  try {
    await connection.leaveDocument(docId)
  } catch {
    // A subsequent connection refresh will clean up the room.
  }
}

function attachment(document: JoinedDocument, threadId: string): LocatedRange | undefined {
  return rangesFromDocument(document).find(range => range.threadId === threadId)
}

// A history-OT comment whose text was deleted keeps its entry with no range, and is still this document's.
function anchoredIn(document: JoinedDocument, threadId: string): boolean {
  if (document.protocol === 'history-ot') {
    return ((document.rawSnapshot as HistorySnapshot).comments ?? []).some(comment => comment.id === threadId)
  }
  return attachment(document, threadId) !== undefined
}

/**
 * Combines REST thread messages with OT-backed ranges and status metadata.
 * Mutations verify the resulting thread or document state before reporting success.
 */
export class CommentsApi {
  readonly #http: CommentHttp
  readonly #connections: CommentConnections
  readonly #currentUserId: string | undefined
  readonly #maxUpdateChars: number
  readonly #threadIdFactory: () => string
  readonly #now: () => number
  readonly #recoveryTimeoutMs: number
  readonly #recoveryPollIntervalMs: number
  readonly #policy: AccessPolicy

  constructor(http: CommentHttp, connections: CommentConnections, options: CommentsApiOptions = {}) {
    this.#http = http
    this.#connections = connections
    this.#currentUserId = options.currentUserId
    this.#maxUpdateChars = options.maxUpdateChars ?? 7 * 1024 * 1024
    this.#threadIdFactory = options.threadIdFactory ?? generateThreadId
    this.#now = options.now ?? Date.now
    this.#recoveryTimeoutMs = options.recoveryTimeoutMs ?? 30_000
    this.#recoveryPollIntervalMs = options.recoveryPollIntervalMs ?? 250
    this.#policy = options.policy ?? AccessPolicy.permissive
  }

  async getThreads(projectId: string): Promise<ThreadsResponse> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read')
    return (await this.#http.getJson(`/project/${encodeURIComponent(projectId)}/threads`)) as ThreadsResponse
  }

  async listComments(
    projectId: string,
    options: { filePath?: string; status?: 'open' | 'resolved' | 'all'; author?: string } = {}
  ): Promise<{ threads: ListedComment[]; positionsUnavailable: boolean }> {
    this.#policy.assertProject(projectId)
    const threads = await this.getThreads(projectId)
    const status = options.status ?? 'open'
    const filtered = Object.entries(threads)
      .map(([id, thread]): [string, CommentThread] => [id, mapThread(id, thread)])
      .filter(([, thread]) => {
        if (status !== 'all' && thread.status !== status) return false
        return options.author ? authorMatches(thread, options.author) : true
      })

    let indexedRanges: LocatedRange[] = []
    let positionsUnavailable = false
    if (!options.filePath) {
      // The project index selects relevant documents; its absence must never trigger a join-all scan.
      try {
        indexedRanges = projectRanges(await this.#http.getJson(`/project/${encodeURIComponent(projectId)}/ranges`))
      } catch (error) {
        if (
          error instanceof McpError &&
          ['NOT_FOUND', 'REMOTE_ERROR', 'TRANSIENT_FAILURE', 'PROTOCOL_UNSUPPORTED'].includes(error.code)
        ) {
          positionsUnavailable = true
        } else {
          throw error
        }
      }
    }

    if (positionsUnavailable) {
      return {
        positionsUnavailable: true,
        threads: filtered.map(([, thread]) => ({ ...thread, unlocated: true })),
      }
    }

    return await this.#connections.withConnection(
      projectId,
      async connection =>
        await connection.queue.run(async () => {
          const tree = connection.getTree()
          const documentsById = new Map<string, JoinedDocument>()
          if (options.filePath) {
            const entity = resolveProjectPath(tree, options.filePath, 'doc')
            const document = await connection.joinDocument(entity.id)
            indexedRanges = rangesFromDocument(document)
            documentsById.set(entity.id, document)
            await leaveQuietly(connection, entity.id)
          }

          const filteredIds = new Set(filtered.map(([id]) => id))
          const documentIds = [
            ...new Set(indexedRanges.filter(range => filteredIds.has(range.threadId)).map(range => range.docId)),
          ]
          const liveByThread = new Map<string, { range: LocatedRange; document: JoinedDocument }>()
          for (const docId of documentIds) {
            const cached = documentsById.get(docId)
            const document = cached ?? (await connection.joinDocument(docId))
            for (const range of rangesFromDocument(document)) {
              if (filteredIds.has(range.threadId)) liveByThread.set(range.threadId, { range, document })
            }
            if (!cached) await leaveQuietly(connection, docId)
          }

          const pathById = new Map(tree.map(entity => [entity.id, entity.path]))
          const listed: ListedComment[] = []
          for (const [id, thread] of filtered) {
            const live = liveByThread.get(id)
            const fallback = indexedRanges.find(range => range.threadId === id)
            const range = live?.range ?? fallback
            if (options.filePath && range?.docId !== resolveProjectPath(tree, options.filePath, 'doc').id) {
              continue
            }
            if (!range || !live) {
              listed.push({ ...thread, unlocated: true })
              continue
            }
            const start = range.start
            const end = range.end
            listed.push({
              ...thread,
              ...(pathById.get(range.docId) === undefined ? {} : { filePath: pathById.get(range.docId)! }),
              start: offsetToLineColumn(live.document.content, start),
              end: offsetToLineColumn(live.document.content, end),
              quotedText: live.document.content.slice(start, end),
            })
          }
          return { threads: listed, positionsUnavailable: false }
        })
    )
  }

  async replyToComment(
    projectId: string,
    threadId: string,
    content: string
  ): Promise<{
    threadId: string
    message: CommentMessage
    trackChangesActive: boolean
    writeMode: 'untracked'
    recoveredAfterTimeout?: true
  }> {
    this.#policy.assertProject(projectId)
    assertPathSafeId(threadId, 'threadId')
    // The thread is read before and after posting, so that read is allowed before anything is posted.
    this.#policy.assertEffect('overleaf-write', 'overleaf-read')
    const normalized = normalizeLf(content)
    // Overleaf creates any thread a message is posted to, so an unknown id would start a new thread.
    const before = (await this.getThreads(projectId))[threadId]
    if (!before) {
      throw new McpError('NOT_FOUND', 'No comment thread has this threadId.', { details: { threadId } })
    }
    // Read before posting: a project join that fails afterwards would report a posted reply as an error.
    const disclosure = await this.#mutationDisclosure(projectId)
    const earlier = new Set((before.messages ?? []).map(message => message.id))
    const started = this.#now()
    // A reply is identified as the one new message in the thread from this account with this content.
    const created = (thread: ThreadData | undefined): ThreadMessage[] =>
      (thread?.messages ?? []).filter(
        message =>
          typeof message.id === 'string' &&
          !earlier.has(message.id) &&
          message.content === normalized &&
          (this.#currentUserId === undefined || mapAuthor(message.user_id, message.user)?.id === this.#currentUserId)
      )
    // Once the reply was sent, a read-back that fails leaves its outcome unknown: a retryable
    // error from that read would invite posting the reply twice.
    const readBack = async (): Promise<ThreadData | undefined> => {
      try {
        return (await this.getThreads(projectId))[threadId]
      } catch (error) {
        throw new McpError(
          'OUTCOME_UNKNOWN',
          'The reply was sent but the thread could not be read back to confirm it. Do not retry it; list the comments first.',
          { cause: error, details: { threadId } }
        )
      }
    }
    try {
      await this.#http.postJson(
        `/project/${encodeURIComponent(projectId)}/thread/${encodeURIComponent(threadId)}/messages`,
        {
          content: normalized,
        }
      )
    } catch (error) {
      if (!isUnconfirmedWriteError(error)) {
        throw error
      }
      // A timed-out POST is accepted only when author, content, and request window identify one reply.
      const matched =
        this.#currentUserId === undefined
          ? []
          : created(await readBack()).filter(message => {
              const timestamp = new Date(message.timestamp ?? 0).getTime()
              return timestamp >= started - 1_000 && timestamp <= this.#now() + 60_000
            })
      if (matched.length === 1) {
        return { threadId, message: mapMessage(matched[0]!), ...disclosure, recoveredAfterTimeout: true }
      }
      throw new McpError(
        'OUTCOME_UNKNOWN',
        'The reply request timed out and no uniquely matching message could be confirmed. Do not retry blindly.',
        { details: { threadId } }
      )
    }
    const replies = created(await readBack())
    if (replies.length !== 1) {
      throw new McpError(
        'OUTCOME_UNKNOWN',
        'Overleaf accepted the reply but it could not be read back. Do not retry it.',
        { details: { threadId } }
      )
    }
    return { threadId, message: mapMessage(replies[0]!), ...disclosure }
  }

  async #mutationDisclosure(projectId: string): Promise<{
    trackChangesActive: boolean
    writeMode: 'untracked'
  }> {
    return await this.#connections.withConnection(projectId, connection =>
      Promise.resolve({
        trackChangesActive: connection.trackChangesActive,
        writeMode: 'untracked',
      })
    )
  }

  async addComment(input: AddCommentInput): Promise<{
    threadId: string
    thread?: CommentThread
    revision: string
    protocol: OtProtocol
    trackChangesActive: boolean
    writeMode: 'untracked'
    recoveredAfterTimeout?: true
  }> {
    this.#policy.assertProject(input.projectId)
    this.#policy.assertEffect('overleaf-write', 'overleaf-read')
    const expectedText = normalizeLf(input.expectedText)
    const messageContent = normalizeLf(input.content)
    const threadId = this.#threadIdFactory()
    assertPathSafeId(threadId, 'threadId')
    const project = encodeURIComponent(input.projectId)

    const submit = await this.#connections.withConnection(
      input.projectId,
      async connection =>
        await connection.queue.run(async () => {
          const entity = resolveProjectPath(connection.getTree(), input.filePath, 'doc')
          const before = await connection.joinDocument(entity.id)
          assertRevisionMatches(input.revision, {
            projectId: input.projectId,
            docId: entity.id,
            protocol: before.protocol,
            otVersion: before.version,
            content: before.content,
          })
          const visibleStart = lineColumnToOffset(before.content, input.start)
          const visibleEnd = lineColumnToOffset(before.content, input.end)
          if (visibleEnd <= visibleStart) {
            throw new McpError('INVALID_ARGUMENT', 'Comment range must not be empty.')
          }
          if (before.content.slice(visibleStart, visibleEnd) !== expectedText) {
            throw new McpError('REVISION_CONFLICT', 'expectedText does not match the live selection.')
          }

          // Overleaf creates the REST thread first; a separate OT update anchors it to the document.
          try {
            await this.#http.postJson(`/project/${project}/thread/${encodeURIComponent(threadId)}/messages`, {
              content: messageContent,
            })
          } catch (error) {
            if (!isUnconfirmedWriteError(error)) {
              throw asMcpError(error)
            }
            // A failed read-back cannot tell whether the thread was created, so it is not retryable either.
            const thread = await this.getThreads(input.projectId).then(
              threads => threads[threadId],
              () => undefined
            )
            const created = thread?.messages?.some(message => message.content === messageContent)
            if (!created) {
              throw new McpError('OUTCOME_UNKNOWN', 'Could not confirm creation of the comment thread.', {
                details: { threadId },
              })
            }
          }

          let start = visibleStart
          let end = visibleEnd
          if (before.protocol === 'history-ot') {
            const snapshot = before.rawSnapshot as HistorySnapshot
            start = visibleToSnapshotOffset(snapshot, visibleStart)
            end = visibleToSnapshotOffset(snapshot, visibleEnd)
          }
          const operation = buildCommentOperation(before.protocol, threadId, start, end, expectedText)
          const update = makeUpdate(entity.id, before.version, operation, before.protocol)
          assertUpdateSize(update, this.#maxUpdateChars)
          let submitError: unknown
          try {
            await connection.submitUpdate(entity.id, update)
          } catch (error) {
            submitError = error
          }
          await leaveQuietly(connection, entity.id)
          // OUTCOME_UNKNOWN means the socket failed after the update was sent, so it may have applied.
          if (isUnconfirmedWriteError(submitError)) {
            return {
              entity,
              before,
              visibleStart,
              visibleEnd,
              trackChangesActive: connection.trackChangesActive,
              submitError,
            }
          }
          if (submitError) {
            // A definite OT failure proves no attachment applied, so deleting the orphan is safe.
            try {
              await this.#http.deleteJson(
                `/project/${project}/doc/${encodeURIComponent(entity.id)}/thread/${encodeURIComponent(threadId)}`
              )
            } catch (cleanupError) {
              throw new McpError('PARTIAL_CLEANUP', 'Comment attachment failed and orphan cleanup also failed.', {
                cause: cleanupError,
                details: { threadId },
              })
            }
            throw asMcpError(submitError)
          }
          let live: JoinedDocument
          try {
            live = await connection.joinDocument(entity.id)
          } catch (error) {
            // The attachment applied, so a failed verification read is settled by observation, never a resend.
            return {
              entity,
              before,
              visibleStart,
              visibleEnd,
              trackChangesActive: connection.trackChangesActive,
              submitError: error,
              confirmed: true,
            }
          }
          await leaveQuietly(connection, entity.id)
          return {
            entity,
            before,
            visibleStart,
            visibleEnd,
            live,
            trackChangesActive: connection.trackChangesActive,
          }
        })
    )

    let live = submit.live
    let recoveredAfterTimeout = false
    // Overleaf acknowledged the attachment and only its verification read failed, so it is never cleaned up.
    const confirmed = submit.confirmed === true
    if (!live) {
      // An ambiguous attachment is recovered by observing the generated thread ID and exact range.
      await this.#connections.invalidate(input.projectId)
      const observation = await observeUnconfirmedWrite({
        observe: async () =>
          await this.#connections.withConnection(
            input.projectId,
            async connection =>
              await connection.queue.run(async () => {
                const entity = resolveProjectPath(connection.getTree(), input.filePath, 'doc')
                const document = await connection.joinDocument(entity.id)
                await leaveQuietly(connection, entity.id)
                return document
              })
          ),
        classify: document => {
          const range = attachment(document, threadId)
          if (range?.start === submit.visibleStart && range.end === submit.visibleEnd) return 'target'
          return isUnchangedDocument(document, submit.before) ? 'original' : 'other'
        },
        timeoutMs: this.#recoveryTimeoutMs,
        pollIntervalMs: this.#recoveryPollIntervalMs,
        onOther: () =>
          new McpError('OUTCOME_UNKNOWN', 'The document changed while the comment attachment remained unconfirmed.', {
            details: { threadId },
          }),
        onUnobserved: cause =>
          new McpError('OUTCOME_UNKNOWN', 'Could not verify the unconfirmed comment attachment.', {
            cause,
            details: { threadId },
          }),
      })
      live = observation.observed
      recoveredAfterTimeout = true
    }

    const verifiedRange = attachment(live, threadId)
    if (verifiedRange?.start !== submit.visibleStart || verifiedRange.end !== submit.visibleEnd) {
      if (confirmed || !recoveredAfterTimeout || !isUnchangedDocument(live, submit.before)) {
        throw new McpError('OUTCOME_UNKNOWN', 'The comment thread exists but its exact range could not be verified.', {
          details: { threadId },
        })
      }
      // Cleanup is permitted only after the unchanged document proves the range was not attached.
      try {
        await this.#http.deleteJson(
          `/project/${project}/doc/${encodeURIComponent(submit.entity.id)}/thread/${encodeURIComponent(threadId)}`
        )
      } catch (error) {
        throw new McpError('PARTIAL_CLEANUP', 'The comment range is absent and orphan cleanup failed.', {
          cause: error,
          details: { threadId },
        })
      }
      const reason = refusedUpdateReason(submit.submitError)
      throw notAppliedError(submit.submitError, 'The comment range attachment was not applied.', {
        threadId,
        ...(reason === undefined ? {} : { reason }),
      })
    }

    // The comment is attached and verified; a thread that cannot be read back is left out of the result.
    const thread = await this.getThreads(input.projectId).then(
      threads => threads[threadId],
      () => undefined
    )
    return {
      threadId,
      ...(thread === undefined ? {} : { thread: mapThread(threadId, thread) }),
      revision: createRevision({
        projectId: input.projectId,
        docId: live.docId,
        protocol: live.protocol,
        otVersion: live.version,
        content: live.content,
      }),
      protocol: live.protocol,
      trackChangesActive: submit.trackChangesActive,
      writeMode: 'untracked',
      ...(recoveredAfterTimeout ? { recoveredAfterTimeout: true } : {}),
    }
  }

  async setCommentStatus(input: {
    projectId: string
    filePath: string
    revision: string
    threadId: string
    status: 'open' | 'resolved'
  }): Promise<{
    threadId: string
    status: 'open' | 'resolved'
    revision: string
    trackChangesActive: boolean
    writeMode: 'untracked'
    recoveredAfterTimeout?: true
  }> {
    this.#policy.assertProject(input.projectId)
    assertPathSafeId(input.threadId, 'threadId')
    // The thread is read afterwards to confirm the status, so that read is allowed first.
    this.#policy.assertEffect('overleaf-write', 'overleaf-read')
    const resolved = input.status === 'resolved'
    const submission = await this.#connections.withConnection(
      input.projectId,
      async connection =>
        await connection.queue.run(async () => {
          const entity = resolveProjectPath(connection.getTree(), input.filePath, 'doc')
          const before = await connection.joinDocument(entity.id)
          assertRevisionMatches(input.revision, {
            projectId: input.projectId,
            docId: entity.id,
            protocol: before.protocol,
            otVersion: before.version,
            content: before.content,
          })
          if (!anchoredIn(before, input.threadId)) {
            await leaveQuietly(connection, entity.id)
            throw new McpError('NOT_FOUND', 'The comment thread is not anchored in filePath.', {
              details: { threadId: input.threadId },
            })
          }
          let submitError: unknown
          try {
            // History-OT stores status in its snapshot; ShareJS exposes dedicated REST actions.
            if (before.protocol === 'history-ot') {
              const update = makeUpdate(
                entity.id,
                before.version,
                buildStatusOperation(before.protocol, input.threadId, resolved),
                before.protocol
              )
              assertUpdateSize(update, this.#maxUpdateChars)
              await connection.submitUpdate(entity.id, update)
            } else {
              await this.#http.postJson(
                `/project/${encodeURIComponent(input.projectId)}/doc/${encodeURIComponent(entity.id)}/thread/${encodeURIComponent(input.threadId)}/${resolved ? 'resolve' : 'reopen'}`,
                {}
              )
            }
          } catch (error) {
            submitError = error
          }
          await leaveQuietly(connection, entity.id)
          if (isUnconfirmedWriteError(submitError)) {
            return {
              before,
              entity,
              trackChangesActive: connection.trackChangesActive,
              submitError,
            }
          }
          if (submitError) throw asMcpError(submitError)
          let live: JoinedDocument
          try {
            live = await connection.joinDocument(entity.id)
          } catch (error) {
            // The change applied, so a failed verification read is settled by observation, never a resend.
            return {
              before,
              entity,
              trackChangesActive: connection.trackChangesActive,
              submitError: error,
              confirmed: true,
            }
          }
          await leaveQuietly(connection, entity.id)
          return { before, entity, live, trackChangesActive: connection.trackChangesActive }
        })
    )

    let live = submission.live
    let recoveredAfterTimeout = false
    // Overleaf acknowledged the change and only its verification read failed, so it can never be not applied.
    const confirmed = submission.confirmed === true
    if (!live) {
      await this.#connections.invalidate(input.projectId)
      const observation = await observeUnconfirmedWrite({
        observe: async () => {
          const document = await this.#connections.withConnection(
            input.projectId,
            async connection =>
              await connection.queue.run(async () => {
                const entity = resolveProjectPath(connection.getTree(), input.filePath, 'doc')
                const joined = await connection.joinDocument(entity.id)
                await leaveQuietly(connection, entity.id)
                return joined
              })
          )
          // A protocol change is classified below; the status of such a document is never read.
          if (document.protocol !== submission.before.protocol) return { document, matched: false }
          return { document, matched: await this.#statusMatches(input.projectId, document, input.threadId, resolved) }
        },
        classify: ({ document, matched }) =>
          document.protocol !== submission.before.protocol ? 'other' : matched ? 'target' : 'original',
        // A read the deployment's protocol cannot serve would fail the same way for the whole window.
        rethrow: error => error instanceof McpError && error.code === 'PROTOCOL_UNSUPPORTED',
        timeoutMs: this.#recoveryTimeoutMs,
        pollIntervalMs: this.#recoveryPollIntervalMs,
        onOther: () =>
          new McpError('PROTOCOL_UNSUPPORTED', 'Document protocol changed during comment-status recovery.'),
        onUnobserved: cause =>
          new McpError('OUTCOME_UNKNOWN', 'Could not observe the unconfirmed comment status.', {
            cause,
            details: { threadId: input.threadId },
          }),
      })
      live = observation.observed.document
      if (observation.state === 'original') {
        if (confirmed) {
          throw new McpError(
            'OUTCOME_UNKNOWN',
            'Overleaf accepted the comment status change but the requested state could not be verified. Do not retry it.',
            { retryable: false, details: { threadId: input.threadId } }
          )
        }
        const reason = refusedUpdateReason(submission.submitError)
        throw notAppliedError(
          submission.submitError,
          'The comment status change was not confirmed and the requested state is not live.',
          { threadId: input.threadId, ...(reason === undefined ? {} : { reason }) }
        )
      }
      recoveredAfterTimeout = true
    } else if (!(await this.#statusMatches(input.projectId, live, input.threadId, resolved).catch(() => false))) {
      throw new McpError('OUTCOME_UNKNOWN', 'Could not verify the requested comment status.', {
        details: { threadId: input.threadId },
      })
    }

    return {
      threadId: input.threadId,
      // The state that was verified, not the caller's string, which a library caller need not have parsed.
      status: resolved ? 'resolved' : 'open',
      revision: createRevision({
        projectId: input.projectId,
        docId: live.docId,
        protocol: live.protocol,
        otVersion: live.version,
        content: live.content,
      }),
      trackChangesActive: submission.trackChangesActive,
      writeMode: 'untracked',
      ...(recoveredAfterTimeout ? { recoveredAfterTimeout: true } : {}),
    }
  }

  async #statusMatches(
    projectId: string,
    document: JoinedDocument,
    threadId: string,
    resolved: boolean
  ): Promise<boolean> {
    if (document.protocol === 'history-ot') {
      // The snapshot holds the status even for a comment whose anchored text was deleted.
      const comment = ((document.rawSnapshot as HistorySnapshot).comments ?? []).find(entry => entry.id === threadId)
      // Overleaf writes resolved: true only for a resolved comment and leaves the key out for an open one.
      if (comment) return (comment.resolved === true) === resolved
    }
    const range = attachment(document, threadId)
    if (range?.resolved !== undefined) return range.resolved === resolved
    const thread = (await this.getThreads(projectId))[threadId]
    return thread !== undefined && (thread.resolved === true) === resolved
  }
}
