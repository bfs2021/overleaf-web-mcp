import { describe, expect, test } from 'vitest'

import { EXIT_CODES, exitCodeForError, exitCodeForResult } from '../../src/cli/exit-codes.js'
import { ERROR_CODES, type ErrorCode } from '../../src/contracts/error-codes.js'
import { McpError } from '../../src/core/errors.js'

/** The exit code of each error code with no outcome, from a write and from a read. */
const TABLE: Record<ErrorCode, { write: number; read: number }> = {
  AUTH_EXPIRED: { write: 3, read: 3 },
  PERMISSION_DENIED: { write: 3, read: 3 },
  POLICY_DENIED: { write: 3, read: 3 },
  INVALID_ARGUMENT: { write: 2, read: 2 },
  CONFIRMATION_MISMATCH: { write: 2, read: 2 },
  PATH_OUTSIDE_ROOT: { write: 2, read: 2 },
  REVISION_CONFLICT: { write: 4, read: 4 },
  REMOTE_DRIFT: { write: 4, read: 4 },
  OUTCOME_UNKNOWN: { write: 5, read: 5 },
  TIMEOUT: { write: 5, read: 7 },
  RATE_LIMITED: { write: 7, read: 7 },
  COMPILE_RATE_LIMITED: { write: 7, read: 7 },
  COMPILE_UNAVAILABLE: { write: 7, read: 7 },
  TRANSIENT_FAILURE: { write: 7, read: 7 },
  NOT_FOUND: { write: 1, read: 1 },
  PROTOCOL_UNSUPPORTED: { write: 1, read: 1 },
  UPDATE_TOO_LARGE: { write: 1, read: 1 },
  DOC_TOO_LARGE: { write: 1, read: 1 },
  COMPILE_FAILED: { write: 1, read: 1 },
  COMPILE_TIMEOUT: { write: 1, read: 1 },
  NO_BUILD: { write: 1, read: 1 },
  BUILD_NOT_FOUND: { write: 1, read: 1 },
  PARTIAL_CLEANUP: { write: 1, read: 1 },
  REMOTE_ERROR: { write: 1, read: 1 },
  REVIEW_UNSUPPORTED: { write: 3, read: 3 },
  INCLUDE_CYCLE: { write: 1, read: 1 },
  INCLUDE_DEPTH_EXCEEDED: { write: 1, read: 1 },
}

describe('CLI exit codes', () => {
  test.each(ERROR_CODES.map(code => [code]))('%s maps by the table from a write and from a read', code => {
    const error = new McpError(code, 'x')
    expect(exitCodeForError(error, 'write_file')).toBe(TABLE[code].write)
    expect(exitCodeForError(error, 'read_file')).toBe(TABLE[code].read)
  })

  test('a timed-out write exits 5, a timed-out read 7, and a write known not applied 4', () => {
    for (const operation of ['write_file', 'upload_file', 'create_project'] as const) {
      expect(exitCodeForError(new McpError('TIMEOUT', 'x', { retryable: true }), operation)).toBe(5)
    }
    expect(exitCodeForError(new McpError('TIMEOUT', 'x', { retryable: true }), 'read_file')).toBe(7)
    expect(exitCodeForError(new McpError('TIMEOUT', 'x', { details: { outcome: 'not_applied' } }), 'write_file')).toBe(
      4
    )
  })

  test('an unknown outcome wins over every code, and never invites a re-run', () => {
    for (const code of ERROR_CODES) {
      expect(exitCodeForError(new McpError(code, 'x', { details: { outcome: 'unknown' } }), 'write_file'), code).toBe(5)
    }
    expect(
      exitCodeForError(new McpError('REVISION_CONFLICT', 'x', { details: { outcome: 'unknown' } }), 'write_file')
    ).toBe(5)
  })

  test('an error saying part of a write applied exits 4, never 2 or 7, which promise nothing changed', () => {
    const created = new McpError('INVALID_ARGUMENT', 'x', { details: { created: true, line: 3 } })
    expect(exitCodeForError(created, 'create_file')).toBe(4)
    const stored = new McpError('RATE_LIMITED', 'x', {
      retryable: true,
      details: { applied: ['compiler'], failed: 'imageName' },
    })
    expect(exitCodeForError(stored, 'update_project_settings')).toBe(4)
    // Nothing stored yet: Overleaf refused the first request, so retrying later is safe.
    const refused = new McpError('RATE_LIMITED', 'x', { retryable: true, details: { applied: [], failed: 'compiler' } })
    expect(exitCodeForError(refused, 'update_project_settings')).toBe(7)
    // Signing in again comes first, and an unknown outcome still wins.
    expect(exitCodeForError(new McpError('AUTH_EXPIRED', 'x', { details: { created: true } }), 'create_file')).toBe(3)
    expect(
      exitCodeForError(
        new McpError('REVISION_CONFLICT', 'x', { details: { created: true, outcome: 'unknown' } }),
        'create_file'
      )
    ).toBe(5)
  })

  test('review the deployment cannot do exits 3, from the review tools and any other', () => {
    for (const kind of ['feature_disabled', 'route_unavailable', 'document_protocol']) {
      const error = new McpError('REVIEW_UNSUPPORTED', 'x', { details: { kind } })
      expect(exitCodeForError(error, 'manage_tracked_changes'), kind).toBe(3)
      expect(exitCodeForError(error, 'list_tracked_changes'), kind).toBe(3)
    }
  })

  test('a tracked write that applied untracked exits 4, and any other PROTOCOL_UNSUPPORTED 1', () => {
    const untracked = new McpError('PROTOCOL_UNSUPPORTED', 'x', { details: { kind: 'applied_untracked' } })
    for (const operation of ['write_file', 'write_section', 'create_file', 'sync_directory'] as const) {
      expect(exitCodeForError(untracked, operation), operation).toBe(4)
    }
    expect(
      exitCodeForError(new McpError('PROTOCOL_UNSUPPORTED', 'x', { details: { kind: 'response_shape' } }), 'write_file')
    ).toBe(1)
    // An unknown outcome still wins.
    expect(
      exitCodeForError(
        new McpError('PROTOCOL_UNSUPPORTED', 'x', { details: { kind: 'applied_untracked', outcome: 'unknown' } }),
        'write_file'
      )
    ).toBe(5)
  })

  test('a write observed not to have applied after a lost socket exits 4', () => {
    const error = new McpError('REMOTE_ERROR', 'x', { details: { outcome: 'not_applied', reason: 'disconnected' } })
    expect(exitCodeForError(error, 'write_file')).toBe(4)
  })

  test('a retryable failure exits 7 only from a read', () => {
    const error = new McpError('REMOTE_ERROR', 'x', { retryable: true, details: { reason: 'disconnected' } })
    expect(exitCodeForError(error, 'read_file')).toBe(7)
    expect(exitCodeForError(error, 'write_file')).toBe(1)
    expect(exitCodeForError(error, 'upload_file')).toBe(1)
  })

  test('a usage error has no operation and exits 2', () => {
    expect(exitCodeForError(new McpError('INVALID_ARGUMENT', 'x'))).toBe(2)
  })

  test('a partial result exits 6, anything else 0', () => {
    expect(exitCodeForResult({ status: 'partial' })).toBe(6)
    expect(exitCodeForResult({ status: 'complete' })).toBe(0)
    expect(exitCodeForResult({ status: 'failure' })).toBe(0)
    expect(exitCodeForResult(null)).toBe(0)
  })

  test('the published table lists each exit code once, in order', () => {
    expect(EXIT_CODES.map(entry => entry.exitCode)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    for (const entry of EXIT_CODES) for (const code of entry.errorCodes) expect(ERROR_CODES).toContain(code)
  })
})
