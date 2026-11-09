import { EventEmitter } from 'node:events'
import { join } from 'node:path'

import { readConfig, type AppConfig } from '../../src/config.js'
import { McpError } from '../../src/core/errors.js'
import type { RawFolder } from '../../src/overleaf/tree.js'
import type { HistorySnapshot, ShareJsComponent } from '../../src/protocol/ot.js'
import { ProjectConnection } from '../../src/protocol/project-connection.js'
import { OverleafRuntime, type RuntimeDependencies } from '../../src/runtime.js'
import { createOverleafService } from '../../src/service/operations.js'
import { applyShareJs } from './overleaf-socket.js'
import { BOOTSTRAP_PAGE, cookieJar } from './runtime.js'

/** The one project the fake serves. */
export const PROJECT = 'project'
const TIMESTAMP = '2026-01-01T00:00:00.000Z'

type Mark = 'insert' | 'delete' | undefined

/** A ShareJS tracked change as Overleaf stores it, with plain (not latin1-encoded) text. */
export interface ShareChange {
  id: string
  op: { p: number; i?: string; d?: string }
  metadata: { user_id: string; ts: string }
}

/** One document as the fake Overleaf holds it. History-OT keeps tracked deletions in `content`. */
export interface ServerDocument {
  protocol: 'sharejs' | 'history-ot'
  version: number
  content: string
  /** History-OT only: the tracked state of each UTF-16 unit of `content`. */
  marks: Mark[]
  /** ShareJS only: tracked changes, recorded for updates that carry `meta.tc`. */
  changes?: ShareChange[]
}

/** The project state every socket the runtime opens shares, so a rejoin sees what an update did. */
export interface FakeOverleaf {
  root: RawFolder
  documents: Map<string, ServerDocument>
  trackChangesState?: boolean
  newDocumentProtocol: 'sharejs' | 'history-ot'
  /**
   * The next applyOtUpdate applies and then fails as a socket would. For `too-large` it is
   * acknowledged, then refused with `otUpdateError("update is too large")`, storing nothing; for
   * `update-error` it is acknowledged, then refused with `otUpdateError("Invalid hash")`, storing
   * nothing, and for `applied-update-error` the same error follows the update being stored.
   */
  failNextApply?: 'timeout' | 'lost-socket' | 'too-large' | 'update-error' | 'applied-update-error'
  /** Apply tracked updates as untracked ones, recording no tracked changes, as a deployment without review might. */
  ignoreTracking?: boolean
  /** Runs once right after the next update is stored, as another client's update that follows it would. */
  afterNextApply?: (document: ServerDocument) => void
  /** The access level joinProject reports; `owner` unless set. */
  permissionsLevel?: string
  applied: number
  /** Every request after the bootstrap `GET /project`, as `METHOD /path`. */
  requests: string[]
  /** Every bootstrap `GET /project`, one per runtime opened. */
  bootstraps: number
  /** Every project socket a runtime opened, in order. */
  peers: FakePeer[]
}

export function sharejs(content: string, version: number): ServerDocument {
  return { protocol: 'sharejs', version, content, marks: [] }
}

export function history(content: string, version: number, deleted?: { pos: number; length: number }): ServerDocument {
  const marks: Mark[] = Array.from({ length: content.length }, (_, index) =>
    deleted !== undefined && index >= deleted.pos && index < deleted.pos + deleted.length ? 'delete' : undefined
  )
  return { protocol: 'history-ot', version, content, marks }
}

/** A project whose first document is `main.tex` and every other `<id>.tex`, all in the root folder. */
export function fakeOverleaf(
  documents: Record<string, ServerDocument>,
  options: { trackChangesState?: boolean; newDocumentProtocol?: 'sharejs' | 'history-ot' } = {}
): FakeOverleaf {
  return {
    root: {
      _id: 'root-folder',
      name: 'rootFolder',
      docs: Object.keys(documents).map((id, index) => ({ _id: id, name: index === 0 ? 'main.tex' : `${id}.tex` })),
      fileRefs: [],
      folders: [],
    },
    documents: new Map(Object.entries(documents)),
    ...(options.trackChangesState === undefined ? {} : { trackChangesState: options.trackChangesState }),
    newDocumentProtocol: options.newDocumentProtocol ?? 'sharejs',
    applied: 0,
    requests: [],
    bootstraps: 0,
    peers: [],
  }
}

/** The raw snapshot a history-OT join returns: tracked ranges as runs of one mark, all by `user`. */
export function snapshotOf(document: ServerDocument): HistorySnapshot {
  const trackedChanges: NonNullable<HistorySnapshot['trackedChanges']> = []
  let start = 0
  for (let index = 1; index <= document.marks.length; index += 1) {
    if (index < document.marks.length && document.marks[index] === document.marks[start]) continue
    const type = document.marks[start]
    if (type !== undefined) {
      trackedChanges.push({
        range: { pos: start, length: index - start },
        tracking: { type, userId: 'user', ts: TIMESTAMP },
      })
    }
    start = index
  }
  return { content: document.content, comments: [], trackedChanges }
}

/** Moves, merges, splits, and adds ShareJS tracked changes for one component, roughly as Overleaf does. */
export function trackShareJs(
  document: { changes?: ShareChange[] },
  component: { p: number; i?: string; d?: string },
  metadata: ShareChange['metadata'] | undefined,
  nextId: () => string
): void {
  const changes = (document.changes ??= [])
  if (component.i !== undefined) {
    const length = component.i.length
    let merged = false
    for (const change of [...changes]) {
      if (change.op.d !== undefined) {
        if (change.op.p >= component.p) change.op.p += length
        continue
      }
      const end = change.op.p + change.op.i!.length
      if (
        !merged &&
        metadata &&
        change.metadata.user_id === metadata.user_id &&
        component.p >= change.op.p &&
        component.p <= end
      ) {
        const offset = component.p - change.op.p
        change.op.i = change.op.i!.slice(0, offset) + component.i + change.op.i!.slice(offset)
        merged = true
      } else if (change.op.p >= component.p) {
        change.op.p += length
      } else if (component.p < end) {
        const offset = component.p - change.op.p
        changes.push({
          id: `${change.id}s`,
          op: { p: component.p + length, i: change.op.i!.slice(offset) },
          metadata: { ...change.metadata },
        })
        change.op.i = change.op.i!.slice(0, offset)
      }
    }
    if (metadata && !merged) changes.push({ id: nextId(), op: { p: component.p, i: component.i }, metadata })
  } else if (component.d !== undefined) {
    const start = component.p
    const end = start + component.d.length
    // As Overleaf's RangesTracker does, the new delete's text is edited in its own coordinates:
    // text a tracked insert held is cut out, since deleting it only shortens that insert, and a
    // tracked delete it absorbs is spliced in at its point. Applied in descending order, cuts first.
    const modifications: Array<{ p: number; cut?: number; text?: string }> = []
    for (const change of [...changes]) {
      if (change.op.i === undefined) continue
      const changeEnd = change.op.p + change.op.i.length
      if (changeEnd <= start) continue
      if (change.op.p >= end) {
        change.op.p -= end - start
        continue
      }
      const from = Math.max(start, change.op.p)
      const to = Math.min(end, changeEnd)
      modifications.push({ p: from - start, cut: to - from })
      change.op.i = change.op.i.slice(0, from - change.op.p) + change.op.i.slice(to - change.op.p)
      change.op.p = Math.min(change.op.p, start)
      if (change.op.i === '') changes.splice(changes.indexOf(change), 1)
    }
    for (const change of [...changes]) {
      if (change.op.d === undefined) continue
      if (change.op.p > end) change.op.p -= end - start
      else if (change.op.p >= start) {
        if (metadata) {
          modifications.push({ p: change.op.p - start, text: change.op.d })
          changes.splice(changes.indexOf(change), 1)
        } else {
          change.op.p = start
        }
      }
    }
    const cutsFirst = (modification: { cut?: number }) => (modification.cut === undefined ? 1 : 0)
    modifications.sort((left, right) => right.p - left.p || cutsFirst(left) - cutsFirst(right))
    let text = component.d
    for (const modification of modifications) {
      text =
        modification.cut !== undefined
          ? text.slice(0, modification.p) + text.slice(modification.p + modification.cut)
          : text.slice(0, modification.p) + modification.text! + text.slice(modification.p)
    }
    if (metadata && text !== '') changes.push({ id: nextId(), op: { p: start, d: text }, metadata })
  }
  changes.sort((left, right) => left.op.p - right.op.p || (left.op.d !== undefined ? -1 : 1))
}

/** Records one ShareJS update's components in the document's tracked changes, ids `tc` and a 6-hex counter. */
export function recordShareJsChanges(
  document: { changes?: ShareChange[] },
  components: readonly ShareJsComponent[],
  tc: string | undefined
): void {
  let counter = 0
  const nextId = () => `${tc}${(++counter).toString(16).padStart(6, '0')}`
  for (const component of components) {
    if (component.c !== undefined) continue
    trackShareJs(document, component, tc === undefined ? undefined : { user_id: 'user', ts: TIMESTAMP }, nextId)
  }
}

/** Overleaf sends ShareJS range text as the latin1 string of its UTF-8 bytes. */
export function encodedRanges(document: { changes?: ShareChange[] }): Record<string, unknown> {
  if (!document.changes?.length) return {}
  const encode = (text: string | undefined) => (text === undefined ? {} : Buffer.from(text, 'utf8').toString('latin1'))
  return {
    changes: document.changes.map(change => ({
      id: change.id,
      op: {
        p: change.op.p,
        ...(change.op.i === undefined ? {} : { i: encode(change.op.i) }),
        ...(change.op.d === undefined ? {} : { d: encode(change.op.d) }),
      },
      metadata: { ...change.metadata },
    })),
  }
}

export type TextComponent =
  number | string | { i: string; tracking: { type: Mark } } | { r: number; tracking: { type: Mark } }

/** Applies one history-OT text operation, which must span the whole raw content. */
export function applyTextOperation(document: ServerDocument, operation: TextComponent[]): void {
  let cursor = 0
  let content = ''
  const marks: Mark[] = []
  const repeat = (mark: Mark, length: number): Mark[] => Array.from({ length }, () => mark)
  for (const component of operation) {
    if (typeof component === 'number' && component >= 0) {
      content += document.content.slice(cursor, cursor + component)
      marks.push(...document.marks.slice(cursor, cursor + component))
      cursor += component
    } else if (typeof component === 'number') {
      cursor -= component
    } else if (typeof component === 'string') {
      content += component
      marks.push(...repeat(undefined, component.length))
    } else if ('i' in component) {
      content += component.i
      marks.push(...repeat(component.tracking.type, component.i.length))
    } else {
      content += document.content.slice(cursor, cursor + component.r)
      marks.push(...repeat(component.tracking.type, component.r))
      cursor += component.r
    }
  }
  if (cursor !== document.content.length) throw new Error('the operation does not span the document')
  document.content = content
  document.marks = marks
}

/** A project socket that answers joinDoc, leaveDoc, and applyOtUpdate from the shared state. */
export class FakePeer extends EventEmitter {
  closed = false
  /** Every socket call this peer received, by name. */
  readonly calls: string[] = []
  readonly #server: FakeOverleaf

  constructor(server: FakeOverleaf) {
    super()
    this.#server = server
  }

  async call(name: string, args: unknown[]): Promise<unknown[]> {
    this.calls.push(name)
    if (this.closed) throw new McpError('OUTCOME_UNKNOWN', 'Overleaf socket is not connected.')
    if (name === 'leaveDoc') return [null]
    const document = this.#server.documents.get(args[0] as string)
    if (document === undefined) return [{ message: 'not found' }]
    if (name === 'joinDoc') {
      return document.protocol === 'history-ot'
        ? [null, snapshotOf(document), document.version, [], {}, 'history-ot']
        : [
            null,
            document.content.split('\n').map(line => Buffer.from(line, 'utf8').toString('latin1')),
            document.version,
            [],
            encodedRanges(document),
            'sharejs-text-ot',
          ]
    }
    if (name !== 'applyOtUpdate') throw new Error(`unexpected socket call ${name}`)
    const update = args[1] as { doc: string; v: number; op: unknown[]; meta?: { tc?: string } }
    if (update.v !== document.version) return [{ message: 'version mismatch' }]
    const refusal = (message: string): unknown[] => {
      // Overleaf acknowledges the update, then sends the error and disconnects the socket.
      setImmediate(() => {
        this.emit('otUpdateError', message, { project_id: PROJECT, doc_id: update.doc, error: message })
        this.closed = true
        this.emit('disconnect')
      })
      return [null]
    }
    if (this.#server.failNextApply === 'too-large' || this.#server.failNextApply === 'update-error') {
      const failure = this.#server.failNextApply
      delete this.#server.failNextApply
      return refusal(failure === 'too-large' ? 'update is too large' : 'Invalid hash')
    }
    if (document.protocol === 'sharejs') {
      const components = update.op as ShareJsComponent[]
      document.content = applyShareJs(document.content, components)
      recordShareJsChanges(document, components, this.#server.ignoreTracking ? undefined : update.meta?.tc)
    } else {
      for (const step of update.op as Array<{ textOperation: TextComponent[] }>) {
        const untracked = (component: TextComponent): TextComponent =>
          typeof component !== 'object'
            ? component
            : 'i' in component
              ? component.i
              : component.tracking.type === 'delete'
                ? -component.r
                : component
        applyTextOperation(
          document,
          this.#server.ignoreTracking ? step.textOperation.map(untracked) : step.textOperation
        )
      }
    }
    document.version += 1
    this.#server.applied += 1
    const followUp = this.#server.afterNextApply
    delete this.#server.afterNextApply
    followUp?.(document)
    const failure = this.#server.failNextApply
    delete this.#server.failNextApply
    if (failure === 'timeout') throw new McpError('TIMEOUT', 'Timed out waiting for otUpdateApplied.')
    if (failure === 'lost-socket') {
      this.closed = true
      throw new Error('socket closed')
    }
    if (failure === 'applied-update-error') return refusal('Invalid hash')
    setImmediate(() => this.emit('otUpdateApplied', { doc: update.doc, v: update.v }))
    return [null]
  }

  close(): void {
    this.closed = true
  }
}

function findFolder(folder: RawFolder, id: string): RawFolder | undefined {
  if (folder._id === id) return folder
  for (const child of folder.folders ?? []) {
    const found = findFolder(child, id)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The configuration and injected fetcher and socket factory of a session over the fake, as
 * `OverleafRuntime.create` and `createOverleafClient` take them. `directory` is a fresh folder
 * holding the session's protected cookie jar, free for local files.
 */
export async function fakeSession(
  server: FakeOverleaf
): Promise<{ config: AppConfig; dependencies: RuntimeDependencies; directory: string }> {
  const { cookiePath, directory } = await cookieJar()
  let created = 0
  const config = readConfig({
    OVERLEAF_COOKIE_JAR_FILE: cookiePath,
    OVERLEAF_BASE_URL: 'https://overleaf.test',
    OVERLEAF_BROWSER_PROFILE_DIR: join(directory, 'profile'),
    OVERLEAF_RECOVERY_TIMEOUT_MS: '500',
  })
  const dependencies: RuntimeDependencies = {
    // Retries keep their attempts, without real waits between them.
    sleep: async () => await Promise.resolve(),
    fetcher: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.pathname === '/project') {
        server.bootstraps += 1
        return new Response(BOOTSTRAP_PAGE)
      }
      server.requests.push(`${method} ${url.pathname}`)
      if (method === 'POST' && url.pathname === '/api/project') {
        return Response.json({
          totalSize: 1,
          projects: [{ _id: PROJECT, name: 'Placeholder project', accessLevel: 'owner' }],
        })
      }
      if (method === 'POST' && url.pathname === `/project/${PROJECT}/doc`) {
        const body = JSON.parse(String(init?.body)) as { parent_folder_id: string; name: string }
        const folder = findFolder(server.root, body.parent_folder_id)
        if (folder === undefined) return new Response(null, { status: 404 })
        created += 1
        const id = `new-doc-${created}`
        ;(folder.docs ??= []).push({ _id: id, name: body.name })
        server.documents.set(id, server.newDocumentProtocol === 'sharejs' ? sharejs('', 0) : history('', 0))
        return new Response(JSON.stringify({ _id: id, name: body.name }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected ${method} ${url.pathname}`)
    },
    connectionFactory: async projectId => {
      const peer = new FakePeer(server)
      server.peers.push(peer)
      return new ProjectConnection({
        projectId,
        peer,
        join: {
          publicId: 'public',
          project: {
            _id: projectId,
            rootFolder: [structuredClone(server.root)],
            ...(server.trackChangesState === undefined ? {} : { trackChangesState: server.trackChangesState }),
          },
          permissionsLevel: server.permissionsLevel ?? 'owner',
          protocolVersion: 2,
        },
        supportedProtocolVersions: [2],
        currentUserId: 'user',
        callTimeoutMs: 1_000,
        applyTimeoutMs: 1_000,
      })
    },
  }
  return { config, dependencies, directory }
}

/** A real runtime over the fake, with the operations as every interface calls them. */
export async function openFakeRuntime(server: FakeOverleaf) {
  const { config, dependencies, directory } = await fakeSession(server)
  const runtime = await OverleafRuntime.create(config, dependencies)
  return { runtime, service: createOverleafService(runtime), directory }
}

/** The text an editor shows: history-OT tracked deletions left out. */
export function visible(server: FakeOverleaf, id: string): string {
  return visibleText(server.documents.get(id)!)
}

/** The text an editor shows of one document: history-OT tracked deletions left out. */
export function visibleText(document: ServerDocument): string {
  return document.content
    .split('')
    .filter((_, index) => document.marks[index] !== 'delete')
    .join('')
}
