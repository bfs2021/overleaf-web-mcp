import { describe, expect, test } from 'vitest'

import { createMinimalTextEdit } from '../../src/core/diff.js'
import { buildHistoryTextOperation, buildShareJsOperation, type HistorySnapshot } from '../../src/protocol/ot.js'
import { trackedWriteCoverage } from '../../src/protocol/tracked-changes.js'
import { recordShareJsChanges, type ShareChange } from '../helpers/fake-overleaf.js'
import { applyShareJs } from '../helpers/overleaf-socket.js'

// The tracked-write fidelity check: every span a tracked write inserted or deleted must be held by
// a tracked change by the writing user after it, judged by coverage rather than by new ids.

const USER = 'user'
const TC = '0123456789abcdef01'

function change(id: string, op: ShareChange['op'], user = USER): ShareChange {
  return { id, op, metadata: { user_id: user, ts: '2026-01-01T00:00:00.000Z' } }
}

/** Writes `after` over `before` as a tracked ShareJS update, with Overleaf's change tracking simulated. */
function shareWrite(before: string, after: string, changes: ShareChange[] = [], tracked = true) {
  const operation = buildShareJsOperation(before, after)
  const document = { changes: structuredClone(changes) }
  expect(applyShareJs(before, operation)).toBe(after)
  recordShareJsChanges(document, operation, tracked ? TC : undefined)
  return trackedWriteCoverage({
    protocol: 'sharejs',
    beforeContent: before,
    beforeRanges: { changes },
    afterRanges: { changes: document.changes },
    operation,
    userId: USER,
  })
}

const covered = { uncoveredInserts: 0, uncoveredDeletes: 0 }

describe('ShareJS tracked-write coverage', () => {
  test('a recorded replacement is covered, and the same write recorded untracked is not', () => {
    expect(shareWrite('An old line.', 'A new line.')).toEqual(covered)
    expect(shareWrite('An old line.', 'A new line.', [], false)).toEqual({ uncoveredInserts: 1, uncoveredDeletes: 1 })
  })

  test('holds for an operation with several components, around a character outside the BMP', () => {
    const before = 'Intro \u{1F600} text old.'
    const after = 'Intro2 \u{1F600} text new.'
    expect(buildShareJsOperation(before, after)).toHaveLength(4)
    expect(shareWrite(before, after)).toEqual(covered)
    expect(shareWrite(before, after, [], false)).toEqual({ uncoveredInserts: 2, uncoveredDeletes: 2 })
  })

  test('a granular write of several separated words is covered word by word', () => {
    const before = 'One draft line.\nKept.\nAnother draft line.\n'
    const after = 'One final line.\nKept.\nAnother last line.\n'
    expect(buildShareJsOperation(before, after)).toHaveLength(4)
    expect(shareWrite(before, after)).toEqual(covered)
    expect(shareWrite(before, after, [], false)).toEqual({ uncoveredInserts: 2, uncoveredDeletes: 2 })
  })

  test("a deletion recorded untracked beside the user's earlier deletion of the same text is not covered", () => {
    // Untracked, Overleaf only moves the earlier deletion to the new one's point, where its text
    // still holds the deleted text; what it holds must grow by what was deleted.
    const earlier = [change('a1', { p: 3, d: '.' })]
    expect(shareWrite('ab.', 'ab', earlier)).toEqual(covered)
    expect(shareWrite('ab.', 'ab', earlier, false)).toEqual({ uncoveredInserts: 0, uncoveredDeletes: 1 })

    const before = 'one. Two.'
    const after = 'one Two'
    expect(buildShareJsOperation(before, after)).toEqual([
      { p: 3, d: '.' },
      { p: 7, d: '.' },
    ])
    const both = [change('a1', { p: 4, d: '..' }), change('a2', { p: 9, d: '..' })]
    expect(shareWrite(before, after, both)).toEqual(covered)
    expect(shareWrite(before, after, both, false)).toEqual({ uncoveredInserts: 0, uncoveredDeletes: 2 })
  })

  test('changes by another user do not count', () => {
    const operation = [{ p: 3, i: 'new' }]
    const ranges = { changes: [change('a', { p: 3, i: 'new' }, 'someone-else')] }
    expect(
      trackedWriteCoverage({
        protocol: 'sharejs',
        beforeContent: 'An line.',
        beforeRanges: {},
        afterRanges: ranges,
        operation,
        userId: USER,
      })
    ).toEqual({ uncoveredInserts: 1, uncoveredDeletes: 0 })
  })

  test('an insert merged into an earlier insert by the user is covered by it', () => {
    const earlier = [change(`${TC}000001`, { p: 0, i: 'Hello' })]
    expect(shareWrite('Hello world', 'Hello, world', earlier)).toEqual(covered)
  })

  test("deleting another author's tracked insert needs no tracked delete; the rest does", () => {
    const theirs = [change('theirs', { p: 4, i: 'big ' }, 'someone-else')]
    // Only text that was their tracked insert is deleted: it simply shrinks.
    expect(shareWrite('The big cat.', 'The cat.', theirs)).toEqual(covered)
    // The deletion runs past their insert, so the rest must be a tracked delete by the user.
    expect(shareWrite('The big cat.', 'The .', theirs)).toEqual(covered)
    expect(shareWrite('The big cat.', 'The .', theirs, false)).toEqual({ uncoveredInserts: 0, uncoveredDeletes: 1 })
  })

  test('a deletion that absorbs an existing tracked delete is covered by the merged one', () => {
    const theirs = [change('theirs', { p: 4, d: 'very ' }, 'someone-else')]
    expect(shareWrite('The big cat.', 'The cat.', theirs)).toEqual(covered)
  })

  // Overleaf splices a tracked delete whose point lies inside the new deletion into the new
  // delete's text at that point. The after-ranges below are what its RangesTracker records.
  describe('a deletion around an existing tracked delete is covered by the merged one', () => {
    const check = (
      beforeContent: string,
      before: ShareChange[],
      operation: Array<{ p: number; i?: string; d?: string }>,
      after: ShareChange[]
    ) =>
      trackedWriteCoverage({
        protocol: 'sharejs',
        beforeContent,
        beforeRanges: { changes: before },
        afterRanges: { changes: after },
        operation,
        userId: USER,
      })

    test.each([
      ['another author', 'someone-else'],
      ['this account', USER],
    ])('by %s, as a plain delete', (_, author) => {
      const before = [change('earlier', { p: 8, d: 'very ' }, author)]
      const operation = [{ p: 4, d: 'big fat ' }]
      expect(check('The big fat cat.', before, operation, [change('merged', { p: 4, d: 'big very fat ' })])).toEqual(
        covered
      )
      // The same deletion recorded untracked leaves the earlier delete where it was.
      expect(check('The big fat cat.', before, operation, [change('earlier', { p: 4, d: 'very ' }, author)])).toEqual({
        uncoveredInserts: 0,
        uncoveredDeletes: 1,
      })
    })

    test.each([
      ['another author', 'someone-else'],
      ['this account', USER],
    ])('by %s, as a replacement', (_, author) => {
      const before = [change('earlier', { p: 2, d: 'X' }, author)]
      const operation = [
        { p: 1, d: 'bc' },
        { p: 1, i: 'Z' },
      ]
      const after = [change('insert', { p: 1, i: 'Z' }), change('merged', { p: 2, d: 'bXc' })]
      expect(check('abcd', before, operation, after)).toEqual(covered)
    })

    test('the minimal cases a comparison with Overleaf found', () => {
      expect(
        check(
          'eehj',
          [change('earlier', { p: 2, d: 'jaf' }, 'someone-else')],
          [{ p: 0, d: 'eeh' }],
          [change('merged', { p: 0, d: 'eejafh' })]
        )
      ).toEqual(covered)
      expect(
        check(
          'cdgeff',
          [change('earlier', { p: 3, d: 'be' })],
          [
            { p: 1, d: 'dge' },
            { p: 1, i: 'iec' },
          ],
          [change('insert', { p: 1, i: 'iec' }), change('merged', { p: 4, d: 'dgbee' })]
        )
      ).toEqual(covered)
    })

    test('deletes sharing a point, joined by an earlier component of the update, are covered', () => {
      // A document converted from history-OT can hold two tracked deletes at one point. Here the
      // single span is split around the emoji it keeps. The first delete takes in 'old ', so
      // Overleaf joins the pair at 17 in order, 'PQ', before the second delete takes it in; taken
      // in one at a time, without the first, it would hold 'QP'.
      const before = 'one two \u{1F600} three four'
      const operation = [
        { p: 0, d: 'one two ' },
        { p: 2, d: ' three four' },
      ]
      expect(buildShareJsOperation(before, '\u{1F600}', [createMinimalTextEdit(before, '\u{1F600}')!])).toEqual(
        operation
      )
      const pair = [change('p', { p: 17, d: 'P' }, 'someone-else'), change('q', { p: 17, d: 'Q' })]
      const earlier = [change('old', { p: 4, d: 'old ' }), ...pair]
      expect(
        check(before, earlier, operation, [
          change('old', { p: 0, d: 'one old two ' }),
          change('p', { p: 2, d: ' three PQfour' }),
        ])
      ).toEqual(covered)
      expect(
        check(before, pair, operation, [
          change(`${TC}000001`, { p: 0, d: 'one two ' }),
          change('p', { p: 2, d: ' three QPfour' }),
        ])
      ).toEqual(covered)
      // Recorded untracked, the deletes only move, and the pair is joined under its first author.
      expect(
        check(before, earlier, operation, [
          change('old', { p: 0, d: 'old ' }),
          change('p', { p: 2, d: 'PQ' }, 'someone-else'),
        ])
      ).toEqual({ uncoveredInserts: 0, uncoveredDeletes: 2 })
    })

    test('the simulated tracker records the same merge', () => {
      const theirs = [change('theirs', { p: 8, d: 'very ' }, 'someone-else')]
      const document = { changes: structuredClone(theirs) }
      recordShareJsChanges(document, [{ p: 4, d: 'big fat ' }], TC)
      expect(document.changes.map(entry => entry.op)).toEqual([{ p: 4, d: 'big very fat ' }])
      expect(shareWrite('The big fat cat.', 'The cat.', theirs)).toEqual(covered)
    })
  })
})

describe('history-OT tracked-write coverage', () => {
  const tracking = { userId: USER, timestamp: '2026-01-01T00:00:00.000Z' }

  function snapshotAfter(snapshot: HistorySnapshot, operation: unknown[], user = USER): HistorySnapshot {
    let content = ''
    let cursor = 0
    const trackedChanges: NonNullable<HistorySnapshot['trackedChanges']> = []
    for (const component of operation as Array<number | string | Record<string, any>>) {
      if (typeof component === 'number' && component > 0) {
        content += snapshot.content.slice(cursor, cursor + component)
        cursor += component
      } else if (typeof component === 'number') {
        cursor -= component
      } else if (typeof component === 'string') {
        content += component
      } else if ('i' in component) {
        trackedChanges.push({
          range: { pos: content.length, length: component.i.length },
          tracking: { ...component.tracking, userId: user },
        })
        content += component.i
      } else {
        trackedChanges.push({
          range: { pos: content.length, length: component.r },
          tracking: { ...component.tracking, userId: user },
        })
        content += snapshot.content.slice(cursor, cursor + component.r)
        cursor += component.r
      }
    }
    return { content, trackedChanges }
  }

  test('tracked ranges by the user cover the write; ranges by another user or none do not', () => {
    const before: HistorySnapshot = { content: 'Draft sentence.' }
    const operation = buildHistoryTextOperation(before, 'Final sentence.', tracking)
    const textOperation = operation[0]!.textOperation as unknown[]
    const check = (after: HistorySnapshot) =>
      trackedWriteCoverage({ protocol: 'history-ot', after, operation, userId: USER })

    expect(check(snapshotAfter(before, textOperation))).toEqual(covered)
    expect(check(snapshotAfter(before, textOperation, 'someone-else'))).toEqual({
      uncoveredInserts: 1,
      uncoveredDeletes: 1,
    })
    const untracked = snapshotAfter(before, textOperation)
    delete untracked.trackedChanges
    expect(check(untracked)).toEqual({ uncoveredInserts: 1, uncoveredDeletes: 1 })
  })

  test('a granular write of several separated words is covered word by word', () => {
    const before: HistorySnapshot = { content: 'One draft line.\nKept.\nAnother draft line.\n' }
    const operation = buildHistoryTextOperation(before, 'One final line.\nKept.\nAnother last line.\n', tracking)
    const textOperation = operation[0]!.textOperation as unknown[]
    expect(textOperation.filter(component => typeof component === 'object')).toHaveLength(4)
    const check = (after: HistorySnapshot) =>
      trackedWriteCoverage({ protocol: 'history-ot', after, operation, userId: USER })

    const after = snapshotAfter(before, textOperation)
    expect(check(after)).toEqual(covered)
    // Losing the tracking of one word is one uncovered span, not the whole write.
    expect(check({ ...after, trackedChanges: after.trackedChanges!.slice(1) })).toEqual({
      uncoveredInserts: 1,
      uncoveredDeletes: 0,
    })
  })

  test('maps earlier spans through later text operations of the same update', () => {
    const operation = [
      { textOperation: [{ i: 'ab', tracking: { type: 'insert', userId: USER, ts: 'T' } }, 3] },
      { textOperation: [5, { i: 'cd', tracking: { type: 'insert', userId: USER, ts: 'T' } }] },
    ]
    const after: HistorySnapshot = {
      content: 'abxyzcd',
      trackedChanges: [
        { range: { pos: 0, length: 2 }, tracking: { type: 'insert', userId: USER, ts: 'T' } },
        { range: { pos: 5, length: 2 }, tracking: { type: 'insert', userId: USER, ts: 'T' } },
      ],
    }
    expect(trackedWriteCoverage({ protocol: 'history-ot', after, operation, userId: USER })).toEqual(covered)
    const firstOnly = { ...after, trackedChanges: after.trackedChanges!.slice(0, 1) }
    expect(trackedWriteCoverage({ protocol: 'history-ot', after: firstOnly, operation, userId: USER })).toEqual({
      uncoveredInserts: 1,
      uncoveredDeletes: 0,
    })
  })
})
