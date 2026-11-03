import { createHash } from 'node:crypto'

import { McpError } from '../core/errors.js'
import type { LineColumn } from '../core/text.js'
import { normalizeLf } from '../core/text.js'
import {
  historyVisibleContent,
  snapshotToVisibleOffset,
  type HistoryOperation,
  type HistorySnapshot,
  type RawRange,
  type ShareJsComponent,
} from './ot.js'

/**
 * Pure readers and planners for tracked changes (suggestions) on both document protocols.
 *
 * ShareJS changes arrive as `{ id, op: { p, i } | { p, d }, metadata: { user_id, ts } }`, with text
 * already decoded by `ProjectConnection.joinDocument`. History-ot changes arrive as raw snapshot
 * ranges with no ids, so ids are synthesized from their parsed values and are valid only with the
 * revision they were listed with.
 */

export type TrackedChangeType = 'insert' | 'delete'
export type TrackedChangeAction = 'accept' | 'reject'

export interface TrackedChange {
  /** Missing on a ShareJS change Overleaf stored without one: listable, not decidable. */
  changeId?: string
  type: TrackedChangeType
  /** UTF-16 offset in the visible content. A delete is a point there: its text is not visible. */
  position: number
  /** UTF-16 length of `text`. */
  length: number
  text: string
  /** Opaque, as Overleaf recorded it; null when it recorded none. */
  authorId: string | null
  /** ISO 8601, when Overleaf recorded a readable timestamp. */
  timestamp?: string
  /** The other half of a replacement: an insert directly followed by a delete by the same author. */
  pairedChangeId?: string
}

export interface HistoryOtTrackedChange extends TrackedChange {
  changeId: string
  /** UTF-16 offset in the raw snapshot, which still holds tracked-deleted text. */
  rawPos: number
  rawLength: number
}

/** A raw history-ot tracked range, read tolerantly: a missing user is null and a missing timestamp empty. */
export interface RawTrackedChange {
  range: RawRange
  tracking: { type: TrackedChangeType; userId: string | null; ts: string }
}

/** A history-ot snapshot reduced to what a decision changes, comparable with deep equality. */
export interface CanonicalHistorySnapshot {
  content: string
  trackedChanges: RawTrackedChange[]
}

export interface ExpectedDecisionState {
  /** The visible content, line endings normalized as `JoinedDocument.content` is. */
  content: string
  /** History-ot only: the raw snapshot the decision leaves, canonicalized. */
  snapshot?: CanonicalHistorySnapshot
}

export type DecisionExpectationInput =
  | {
      protocol: 'sharejs'
      content: string
      changes: readonly TrackedChange[]
      changeIds: readonly string[]
      action: TrackedChangeAction
    }
  | {
      protocol: 'history-ot'
      snapshot: HistorySnapshot
      changes: readonly HistoryOtTrackedChange[]
      changeIds: readonly string[]
      action: TrackedChangeAction
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function timeOf(value: string): number {
  const time = Date.parse(value)
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time
}

/** The earlier of two recorded timestamps, as Overleaf keeps when ranges merge. */
function earlierTimestamp(left: string, right: string): string {
  const difference = timeOf(left) - timeOf(right)
  if (difference < 0) return left
  if (difference > 0) return right
  return left <= right ? left : right
}

/** Where a change ends in the visible content: after an insert's text, or at a delete's point. */
export function visibleEnd(change: TrackedChange): number {
  return change.type === 'insert' ? change.position + change.length : change.position
}

function byDocumentOrder<T extends TrackedChange>(left: T, right: T): number {
  if (left.position !== right.position) return left.position - right.position
  // At the same offset a delete's point lies before an insert's text, as Overleaf orders them.
  if (left.type !== right.type) return left.type === 'delete' ? -1 : 1
  return 0
}

/**
 * Marks replacements: an insert directly followed by a delete by the same author, which is how
 * Overleaf stores one. Each change is paired at most once, and only changes with ids are paired.
 */
function pairReplacements<T extends TrackedChange>(
  changes: T[],
  endOf: (change: T) => number,
  startOf: (change: T) => number
): T[] {
  const paired = new Set<T>()
  for (const insert of changes) {
    if (insert.type !== 'insert' || insert.changeId === undefined || paired.has(insert)) continue
    const end = endOf(insert)
    const deletion = changes.find(
      candidate =>
        candidate.type === 'delete' &&
        candidate.changeId !== undefined &&
        !paired.has(candidate) &&
        startOf(candidate) === end &&
        candidate.authorId === insert.authorId
    )
    if (deletion?.changeId === undefined) continue
    paired.add(insert)
    paired.add(deletion)
    insert.pairedChangeId = deletion.changeId
    deletion.pairedChangeId = insert.changeId
  }
  return changes
}

/**
 * Reads the changes of a joined ShareJS document's (decoded) ranges. Unknown op keys are ignored;
 * an entry without a usable position or a non-empty `i` or `d` string is skipped.
 */
export function parseShareJsChanges(ranges: unknown): TrackedChange[] {
  const entries = isRecord(ranges) && Array.isArray(ranges.changes) ? ranges.changes : []
  const changes: TrackedChange[] = []
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.op)) continue
    const { op } = entry
    if (!isOffset(op.p)) continue
    let type: TrackedChangeType
    let text: string
    if (typeof op.i === 'string') {
      type = 'insert'
      text = op.i
    } else if (typeof op.d === 'string') {
      type = 'delete'
      text = op.d
    } else {
      continue
    }
    if (text === '') continue
    const metadata = isRecord(entry.metadata) ? entry.metadata : {}
    const timestamp = isoTimestamp(metadata.ts)
    changes.push({
      ...(typeof entry.id === 'string' && entry.id !== '' ? { changeId: entry.id } : {}),
      type,
      position: op.p,
      length: text.length,
      text,
      authorId: typeof metadata.user_id === 'string' ? metadata.user_id : null,
      ...(timestamp === undefined ? {} : { timestamp }),
    })
  }
  // A stable sort keeps Overleaf's order for changes at one offset of one type.
  changes.sort(byDocumentOrder)
  return pairReplacements(changes, visibleEnd, change => change.position)
}

function readRawChanges(snapshot: HistorySnapshot): RawTrackedChange[] {
  const entries: unknown = snapshot.trackedChanges
  if (!Array.isArray(entries)) return []
  const output: RawTrackedChange[] = []
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.range) || !isRecord(entry.tracking)) continue
    const { range, tracking } = entry
    if (!isOffset(range.pos) || !isOffset(range.length) || range.length === 0) continue
    if (range.pos + range.length > snapshot.content.length) continue
    if (tracking.type !== 'insert' && tracking.type !== 'delete') continue
    output.push({
      range: { pos: range.pos, length: range.length },
      tracking: {
        type: tracking.type,
        userId: typeof tracking.userId === 'string' ? tracking.userId : null,
        ts: typeof tracking.ts === 'string' ? tracking.ts : '',
      },
    })
  }
  return output
}

/**
 * Sorts raw tracked ranges and merges each run of touching ranges with the same type and user into
 * one, keeping the earliest timestamp, as Overleaf does after every TextOperation. Two snapshots
 * that differ only in that merge give the same result.
 */
export function canonicalTrackedChanges(changes: readonly RawTrackedChange[]): RawTrackedChange[] {
  const sorted = changes
    .map(change => ({ range: { ...change.range }, tracking: { ...change.tracking } }))
    .sort((left, right) => left.range.pos - right.range.pos)
  const merged: RawTrackedChange[] = []
  for (const change of sorted) {
    const last = merged.at(-1)
    if (
      last &&
      last.range.pos + last.range.length === change.range.pos &&
      last.tracking.type === change.tracking.type &&
      last.tracking.userId === change.tracking.userId
    ) {
      last.range.length += change.range.length
      last.tracking.ts = earlierTimestamp(last.tracking.ts, change.tracking.ts)
      continue
    }
    merged.push(change)
  }
  return merged
}

/** The content and canonical tracked changes of a history-ot snapshot; comments are not compared. */
export function canonicalHistorySnapshot(snapshot: HistorySnapshot): CanonicalHistorySnapshot {
  return { content: snapshot.content, trackedChanges: canonicalTrackedChanges(readRawChanges(snapshot)) }
}

/** `ht_` and 22 base64url characters of a SHA-256 over the change's document and parsed values. */
export function historyOtChangeId(docId: string, change: RawTrackedChange): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        docId,
        change.tracking.type,
        change.range.pos,
        change.range.length,
        change.tracking.userId,
        change.tracking.ts,
      ])
    )
    .digest('base64url')
  return `ht_${digest.slice(0, 22)}`
}

/** Reads a history-ot snapshot's tracked changes, merged as Overleaf would merge them, with synthesized ids. */
export function parseHistoryOtChanges(snapshot: HistorySnapshot, docId: string): HistoryOtTrackedChange[] {
  const changes = canonicalTrackedChanges(readRawChanges(snapshot)).map((raw): HistoryOtTrackedChange => {
    const text = snapshot.content.slice(raw.range.pos, raw.range.pos + raw.range.length)
    const timestamp = isoTimestamp(raw.tracking.ts)
    return {
      changeId: historyOtChangeId(docId, raw),
      type: raw.tracking.type,
      position: snapshotToVisibleOffset(snapshot, raw.range.pos),
      length: text.length,
      text,
      authorId: raw.tracking.userId,
      ...(timestamp === undefined ? {} : { timestamp }),
      rawPos: raw.range.pos,
      rawLength: raw.range.length,
    }
  })
  return pairReplacements(
    changes,
    change => change.rawPos + change.rawLength,
    change => change.rawPos
  )
}

/**
 * Maps offsets in LF-normalized content to 1-based UTF-16 line and column values, as
 * `offsetToLineColumn` does, with the line starts computed once. An offset outside the content
 * means Overleaf's ranges and text disagree, so it is a protocol error, not a caller's mistake.
 */
export function createLocator(content: string): (offset: number) => LineColumn {
  const lineStarts = [0]
  for (let index = content.indexOf('\n'); index >= 0; index = content.indexOf('\n', index + 1)) {
    lineStarts.push(index + 1)
  }
  return offset => {
    if (!isOffset(offset) || offset > content.length) {
      throw new McpError('PROTOCOL_UNSUPPORTED', 'A tracked change lies outside the document.')
    }
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (lineStarts[middle]! <= offset) low = middle
      else high = middle - 1
    }
    return { line: low + 1, column: offset - lineStarts[low]! + 1 }
  }
}

/** The first `maxChars` UTF-16 units of `text` at most, never ending inside a surrogate pair. */
export function excerpt(text: string, maxChars: number): { excerpt: string; truncated: boolean } {
  const limit = Math.max(0, Math.floor(maxChars))
  if (text.length <= limit) return { excerpt: text, truncated: false }
  let cut = limit
  const last = text.charCodeAt(cut - 1)
  if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut -= 1
  return { excerpt: text.slice(0, cut), truncated: true }
}

/** The requested ids that no listed change carries, in the order given, each once. */
export function missingChangeIds(changes: readonly TrackedChange[], changeIds: readonly string[]): string[] {
  const known = new Set(changes.flatMap(change => (change.changeId === undefined ? [] : [change.changeId])))
  return [...new Set(changeIds)].filter(id => !known.has(id))
}

function selectChanges<T extends TrackedChange>(changes: readonly T[], changeIds: readonly string[]): T[] {
  const missing = missingChangeIds(changes, changeIds)
  if (missing.length > 0) {
    throw new McpError('NOT_FOUND', 'Some changeIds are not tracked changes in this document.', {
      details: { missingChangeIds: missing },
    })
  }
  const wanted = new Set(changeIds)
  return changes.filter(change => change.changeId !== undefined && wanted.has(change.changeId))
}

/**
 * The changes left out of a decision whose visible span strictly intersects a chosen one. An
 * insert spans its text and a delete is a point, so touching changes, such as the two halves of a
 * replacement, do not overlap. Changes without ids are included, since they cannot be chosen.
 */
export function overlappingChanges<T extends TrackedChange>(changes: readonly T[], changeIds: readonly string[]): T[] {
  const wanted = new Set(changeIds)
  const chosen = changes.filter(change => change.changeId !== undefined && wanted.has(change.changeId))
  const intersects = (left: TrackedChange, right: TrackedChange): boolean => {
    const leftEnd = visibleEnd(left)
    const rightEnd = visibleEnd(right)
    if (left.type === 'delete' && right.type === 'delete') return false
    if (left.type === 'delete') return right.position < left.position && left.position < rightEnd
    if (right.type === 'delete') return left.position < right.position && right.position < leftEnd
    return left.position < rightEnd && right.position < leftEnd
  }
  return changes.filter(
    change =>
      (change.changeId === undefined || !wanted.has(change.changeId)) &&
      chosen.some(selected => intersects(selected, change))
  )
}

/**
 * The untracked ShareJS update body that rejects the given changes: a rejected insert removes its
 * text and a rejected delete restores its text at its point, every component flagged `u: true`.
 * Components are in ascending document order, each at a position in the text the previous ones
 * left, so a replacement pair gives its `d` component before its `i` component at one position.
 */
export function planShareJsReject(changes: readonly TrackedChange[], changeIds: readonly string[]): ShareJsComponent[] {
  const selected = selectChanges(changes, changeIds).sort(byDocumentOrder)
  const components: ShareJsComponent[] = []
  let shift = 0
  for (const change of selected) {
    const p = change.position + shift
    if (change.type === 'insert') {
      components.push({ p, d: change.text, u: true })
      shift -= change.length
    } else {
      components.push({ p, i: change.text, u: true })
      shift += change.length
    }
  }
  return components
}

/**
 * The single history-ot TextOperation that accepts or rejects the given changes. Accepting an
 * insert or rejecting a delete clears its tracking (`{ r, tracking: { type: 'none' } }`); accepting
 * a delete or rejecting an insert removes the text (`-n`). Gaps are retained, and the operation
 * ends with a retain to the raw snapshot's length.
 */
export function planHistoryOtDecision(
  snapshot: HistorySnapshot,
  changes: readonly HistoryOtTrackedChange[],
  changeIds: readonly string[],
  action: TrackedChangeAction
): HistoryOperation {
  const selected = selectChanges(changes, changeIds).sort((left, right) => left.rawPos - right.rawPos)
  const textOperation: Array<number | Record<string, unknown>> = []
  let cursor = 0
  for (const change of selected) {
    if (change.rawPos < cursor) {
      throw new McpError('PROTOCOL_UNSUPPORTED', 'History-OT tracked changes overlap.')
    }
    if (change.rawPos > cursor) textOperation.push(change.rawPos - cursor)
    const removes = (action === 'accept') === (change.type === 'delete')
    textOperation.push(removes ? -change.rawLength : { r: change.rawLength, tracking: { type: 'none' } })
    cursor = change.rawPos + change.rawLength
  }
  if (snapshot.content.length > cursor) textOperation.push(snapshot.content.length - cursor)
  return { textOperation }
}

function applyShareJsComponents(content: string, components: readonly ShareJsComponent[]): string {
  let result = content
  for (const component of components) {
    if (component.d !== undefined) {
      result = result.slice(0, component.p) + result.slice(component.p + component.d.length)
    }
    if (component.i !== undefined) {
      result = result.slice(0, component.p) + component.i + result.slice(component.p)
    }
  }
  return result
}

/**
 * The state a decision should leave, for verification on a fresh join. A ShareJS accept leaves the
 * content as it was; a history-ot decision is checked by its canonical snapshot as well, since an
 * accepted insert leaves the visible content unchanged.
 */
export function expectedAfterDecision(input: DecisionExpectationInput): ExpectedDecisionState {
  if (input.protocol === 'sharejs') {
    if (input.action === 'accept') {
      selectChanges(input.changes, input.changeIds)
      return { content: input.content }
    }
    return { content: applyShareJsComponents(input.content, planShareJsReject(input.changes, input.changeIds)) }
  }

  const { snapshot } = input
  const selected = selectChanges(input.changes, input.changeIds)
  const removed: RawRange[] = selected
    .filter(change => (input.action === 'accept') === (change.type === 'delete'))
    .map(change => ({ pos: change.rawPos, length: change.rawLength }))
    .sort((left, right) => left.pos - right.pos)
  const decided: RawRange[] = selected.map(change => ({ pos: change.rawPos, length: change.rawLength }))
  const removedBefore = (pos: number): number =>
    removed.filter(range => range.pos + range.length <= pos).reduce((total, range) => total + range.length, 0)

  let content = ''
  let cursor = 0
  for (const range of removed) {
    content += snapshot.content.slice(cursor, range.pos)
    cursor = range.pos + range.length
  }
  content += snapshot.content.slice(cursor)

  // A decided span covers whole canonical ranges, so every raw range is either decided or kept whole.
  const kept = readRawChanges(snapshot).filter(
    change =>
      !decided.some(
        range => range.pos <= change.range.pos && change.range.pos + change.range.length <= range.pos + range.length
      )
  )
  const trackedChanges = canonicalTrackedChanges(
    kept.map(change => ({
      range: { pos: change.range.pos - removedBefore(change.range.pos), length: change.range.length },
      tracking: change.tracking,
    }))
  )
  const visible = historyVisibleContent({
    content,
    trackedChanges: trackedChanges.map(change => ({
      range: change.range,
      tracking: { ...change.tracking, userId: change.tracking.userId ?? '' },
    })),
  })
  return { content: normalizeLf(visible), snapshot: { content, trackedChanges } }
}

/** A half-open UTF-16 span `[start, end)`. */
interface Span {
  start: number
  end: number
}

/** Text an operation deleted: where its point lands after the write, and the span it held before. */
interface DeletedSpan {
  point: number
  before: Span
}

type Segment = { from: 'before'; start: number; length: number } | { from: 'operation'; length: number }

/** Splits the segment list at `position` and returns the index of the first segment from there. */
function splitSegments(segments: Segment[], position: number): number {
  let offset = 0
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!
    if (offset === position) return index
    if (position < offset + segment.length) {
      const head = position - offset
      const pieces: Segment[] =
        segment.from === 'before'
          ? [
              { from: 'before', start: segment.start, length: head },
              { from: 'before', start: segment.start + head, length: segment.length - head },
            ]
          : [
              { from: 'operation', length: head },
              { from: 'operation', length: segment.length - head },
            ]
      segments.splice(index, 1, ...pieces)
      return index + 1
    }
    offset += segment.length
  }
  return segments.length
}

/**
 * Where a ShareJS operation's text went: the spans it inserted, in the text after the write, and
 * the text it deleted, as the span it held before the write and the point it lands on after.
 * Components apply in order, each at a position in the text the previous ones left. A tracked
 * delete is a point, which an insert at it pushes along and a delete around it absorbs, as
 * Overleaf moves and merges its tracked deletes.
 */
function shareJsEditSpans(
  beforeLength: number,
  operation: readonly ShareJsComponent[],
  earlierPoints: readonly number[] = []
): { inserted: Span[]; deleted: DeletedSpan[]; earlierLanded: number[] } {
  const segments: Segment[] = beforeLength > 0 ? [{ from: 'before', start: 0, length: beforeLength }] : []
  const deleted: DeletedSpan[] = []
  const earlier = earlierPoints.map(point => ({ point }))
  for (const component of operation) {
    if (typeof component.i === 'string' && component.i !== '') {
      const length = component.i.length
      segments.splice(splitSegments(segments, component.p), 0, { from: 'operation', length })
      for (const span of [...deleted, ...earlier]) if (span.point >= component.p) span.point += length
    } else if (typeof component.d === 'string' && component.d !== '') {
      const start = component.p
      const end = start + component.d.length
      for (const span of [...deleted, ...earlier]) {
        if (span.point > end) span.point -= end - start
        else if (span.point > start) span.point = start
      }
      const first = splitSegments(segments, start)
      const last = splitSegments(segments, end)
      for (const segment of segments.splice(first, last - first)) {
        // Text the same operation inserted and then deleted leaves nothing to track.
        if (segment.from === 'before') {
          deleted.push({ point: start, before: { start: segment.start, end: segment.start + segment.length } })
        }
      }
    }
  }
  const inserted: Span[] = []
  let offset = 0
  for (const segment of segments) {
    if (segment.from === 'operation') inserted.push({ start: offset, end: offset + segment.length })
    offset += segment.length
  }
  return { inserted, deleted, earlierLanded: earlier.map(span => span.point) }
}

/** Whether the union of `covering` holds every unit of `span`. */
function spanCovered(span: Span, covering: readonly Span[]): boolean {
  let cursor = span.start
  for (const range of [...covering].sort((left, right) => left.start - right.start)) {
    if (cursor >= span.end) break
    if (range.start > cursor) break
    if (range.end > cursor) cursor = range.end
  }
  return cursor >= span.end
}

/** `span` less every part that lies inside one of `exempt`. */
function subtractSpans(span: Span, exempt: readonly Span[]): Span[] {
  let pieces: Span[] = [span]
  for (const range of exempt) {
    pieces = pieces.flatMap(piece => {
      if (range.end <= piece.start || range.start >= piece.end) return [piece]
      const kept: Span[] = []
      if (range.start > piece.start) kept.push({ start: piece.start, end: range.start })
      if (range.end < piece.end) kept.push({ start: range.end, end: piece.end })
      return kept
    })
  }
  return pieces
}

/** Spans of one text operation's output that came through it from its input, for mapping later operations. */
function mapSpansThrough(spans: readonly Span[], textOperation: readonly unknown[]): Span[] {
  const kept: Array<{ input: number; output: number; length: number }> = []
  let input = 0
  let output = 0
  for (const component of textOperation) {
    if (typeof component === 'number') {
      if (component > 0) {
        kept.push({ input, output, length: component })
        output += component
      }
      input += Math.abs(component)
    } else if (typeof component === 'string') {
      output += component.length
    } else if (isRecord(component) && typeof component.i === 'string') {
      output += component.i.length
    } else if (isRecord(component) && isOffset(component.r)) {
      kept.push({ input, output, length: component.r })
      input += component.r
      output += component.r
    }
  }
  return spans.flatMap(span =>
    kept.flatMap(piece => {
      const start = Math.max(span.start, piece.input)
      const end = Math.min(span.end, piece.input + piece.length)
      return start < end ? [{ start: piece.output + start - piece.input, end: piece.output + end - piece.input }] : []
    })
  )
}

/** Where a history-ot update's tracked inserts and deletes lie in the raw snapshot after it. */
function historyEditSpans(operation: readonly HistoryOperation[]): { inserted: Span[]; deleted: Span[] } {
  let inserted: Span[] = []
  let deleted: Span[] = []
  for (const step of operation) {
    const textOperation = isRecord(step) && Array.isArray(step.textOperation) ? step.textOperation : undefined
    if (textOperation === undefined) continue
    inserted = mapSpansThrough(inserted, textOperation)
    deleted = mapSpansThrough(deleted, textOperation)
    let output = 0
    for (const component of textOperation) {
      if (typeof component === 'number') {
        if (component > 0) output += component
      } else if (typeof component === 'string') {
        inserted.push({ start: output, end: output + component.length })
        output += component.length
      } else if (isRecord(component) && typeof component.i === 'string') {
        inserted.push({ start: output, end: output + component.i.length })
        output += component.i.length
      } else if (isRecord(component) && isOffset(component.r)) {
        const tracking = isRecord(component.tracking) ? component.tracking : undefined
        if (tracking?.type === 'delete') deleted.push({ start: output, end: output + component.r })
        output += component.r
      }
    }
  }
  const nonEmpty = (span: Span): boolean => span.end > span.start
  return { inserted: inserted.filter(nonEmpty), deleted: deleted.filter(nonEmpty) }
}

export type TrackedWriteCoverageInput =
  | {
      protocol: 'sharejs'
      /** The visible content before the write; ShareJS positions count it. */
      beforeContent: string
      /** The decoded ranges of the document before and after the write. */
      beforeRanges: unknown
      afterRanges: unknown
      operation: readonly ShareJsComponent[]
      userId: string
    }
  | {
      protocol: 'history-ot'
      after: HistorySnapshot
      operation: readonly HistoryOperation[]
      userId: string
    }

export interface TrackedWriteCoverage {
  /** Spans the write inserted that no tracked insert by the user holds. */
  uncoveredInserts: number
  /** Spans the write deleted that no tracked delete by the user holds, and that were not tracked inserts. */
  uncoveredDeletes: number
}

/**
 * Checks that a tracked write was recorded as tracked changes by the user, by coverage rather than
 * by new ids, since Overleaf merges a user's touching changes and keeps the first id. Holds for an
 * operation with any number of components.
 *
 * ShareJS: every inserted span lies inside tracked inserts by the user after the write, and the
 * text of every deleted span is held by a tracked delete by the user at the point it was deleted
 * from, except text that lay inside a tracked insert, of any author, before the write: deleting it
 * only shortens that insert. A tracked delete, of any author, whose point lay inside the deleted
 * text is merged into it at that point, so its text is expected there, and the user's tracked
 * deletes at a point must hold at least the text deleted there and every earlier tracked delete
 * that lands there, which an untracked delete only moves beside it. History-ot: inserted spans
 * lie inside `insert` ranges by the user and
 * deleted spans inside `delete` ranges by the user, in the raw snapshot after the write.
 */
export function trackedWriteCoverage(input: TrackedWriteCoverageInput): TrackedWriteCoverage {
  if (input.protocol === 'history-ot') {
    const { inserted, deleted } = historyEditSpans(input.operation)
    const owned = (type: TrackedChangeType): Span[] =>
      readRawChanges(input.after)
        .filter(change => change.tracking.type === type && change.tracking.userId === input.userId)
        .map(change => ({ start: change.range.pos, end: change.range.pos + change.range.length }))
    const inserts = owned('insert')
    const deletes = owned('delete')
    return {
      uncoveredInserts: inserted.filter(span => !spanCovered(span, inserts)).length,
      uncoveredDeletes: deleted.filter(span => !spanCovered(span, deletes)).length,
    }
  }

  const beforeChanges = parseShareJsChanges(input.beforeRanges)
  const earlierDeletes = beforeChanges.filter(change => change.type === 'delete')
  const { inserted, deleted, earlierLanded } = shareJsEditSpans(
    input.beforeContent.length,
    input.operation,
    earlierDeletes.map(change => change.position)
  )
  const after = parseShareJsChanges(input.afterRanges).filter(change => change.authorId === input.userId)
  const inserts = after
    .filter(change => change.type === 'insert')
    .map(change => ({ start: change.position, end: change.position + change.length }))
  const exempt = beforeChanges
    .filter(change => change.type === 'insert')
    .map(change => ({ start: change.position, end: change.position + change.length }))
  // Overleaf merges a tracked delete the new one spans into its text, spliced in at its point. Taken
  // in one at a time, deletes that share a point land in reverse order; but once an earlier
  // component of the update has taken one in, Overleaf has already joined every such group across
  // the document, in order. Either text is accepted: an untracked delete holds neither.
  const expectedTexts = (piece: Span): string[] => {
    const inside = earlierDeletes.filter(change => change.position > piece.start && change.position < piece.end)
    const points = [...new Set(inside.map(change => change.position))].sort((left, right) => right - left)
    const spliced = (joined: boolean): string => {
      let text = input.beforeContent.slice(piece.start, piece.end)
      for (const point of points) {
        const group = inside.filter(change => change.position === point).map(change => change.text)
        const offset = point - piece.start
        text = text.slice(0, offset) + (joined ? group : group.reverse()).join('') + text.slice(offset)
      }
      return text
    }
    return [spliced(false), spliced(true)]
  }
  // What the user's tracked deletes at each point must hold at least: the text deleted there, and
  // every earlier tracked delete that lands there, which a tracked delete takes in and an untracked
  // one only moves. A substring test alone passes an untracked delete beside an earlier one.
  const expectedLength = new Map<number, number>()
  const addExpected = (point: number, length: number): void => {
    expectedLength.set(point, (expectedLength.get(point) ?? 0) + length)
  }
  const pieces = deleted.map(span => subtractSpans(span.before, exempt))
  deleted.forEach((span, index) => {
    addExpected(span.point, 0)
    for (const piece of pieces[index]!) addExpected(span.point, piece.end - piece.start)
  })
  earlierLanded.forEach((point, index) => {
    if (expectedLength.has(point)) addExpected(point, earlierDeletes[index]!.length)
  })
  let uncoveredDeletes = 0
  deleted.forEach((span, index) => {
    const held = after
      .filter(change => change.type === 'delete' && change.position === span.point)
      .map(change => change.text)
      .join('')
    if (
      held.length < expectedLength.get(span.point)! ||
      pieces[index]!.some(piece => !expectedTexts(piece).some(text => held.includes(text)))
    ) {
      uncoveredDeletes += 1
    }
  })
  return {
    uncoveredInserts: inserted.filter(span => !spanCovered(span, inserts)).length,
    uncoveredDeletes,
  }
}
