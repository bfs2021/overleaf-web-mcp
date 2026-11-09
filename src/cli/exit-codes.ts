import type { ErrorCode } from '../contracts/error-codes.js'
import { operationContract, type OperationName } from '../contracts/operations.js'
import type { McpError } from '../core/errors.js'

/**
 * What an operation command's exit code tells a script it may safely do next. A wrapper that
 * re-runs on "retry later" must never re-run a write whose outcome is unknown, so the code depends
 * on the operation and on `details.outcome`, not on `retryable` alone: the HTTP client marks every
 * timeout retryable, uploads and deletes included.
 */
export const EXIT_CODES = [
  { exitCode: 0, meaning: 'Complete.', errorCodes: [] },
  { exitCode: 1, meaning: 'Failed for another reason; read the error code.', errorCodes: [] },
  {
    exitCode: 2,
    meaning:
      'Fix the call: a usage error or an argument, confirmation, or local path was refused. Nothing was changed.',
    errorCodes: ['INVALID_ARGUMENT', 'CONFIRMATION_MISMATCH', 'PATH_OUTSIDE_ROOT'],
  },
  {
    exitCode: 3,
    meaning: 'Not allowed or not available; do not retry. AUTH_EXPIRED means run `overleaf-web-mcp login`.',
    errorCodes: ['AUTH_EXPIRED', 'PERMISSION_DENIED', 'POLICY_DENIED', 'REVIEW_UNSUPPORTED'],
  },
  {
    exitCode: 4,
    meaning:
      'Read or plan again, then decide: the document or project changed, a write is known not to have applied, or part of it applied (details.created or details.applied), or a tracked write applied untracked (details.kind "applied_untracked").',
    errorCodes: ['REVISION_CONFLICT', 'REMOTE_DRIFT', 'TIMEOUT', 'PROTOCOL_UNSUPPORTED'],
  },
  {
    exitCode: 5,
    meaning: 'Outcome unknown: a write may have applied. Read before acting; never re-run it blindly.',
    errorCodes: ['OUTCOME_UNKNOWN', 'TIMEOUT', 'TRANSIENT_FAILURE'],
  },
  {
    exitCode: 6,
    meaning: 'Partial: some steps completed. The result is on stdout with status "partial".',
    errorCodes: [],
  },
  {
    exitCode: 7,
    meaning: 'Safe to retry later: nothing was changed.',
    errorCodes: ['RATE_LIMITED', 'COMPILE_RATE_LIMITED', 'COMPILE_UNAVAILABLE', 'TRANSIENT_FAILURE', 'TIMEOUT'],
  },
] as const satisfies ReadonlyArray<{ exitCode: number; meaning: string; errorCodes: readonly ErrorCode[] }>

const FIX_THE_CALL: ReadonlySet<ErrorCode> = new Set(['INVALID_ARGUMENT', 'CONFIRMATION_MISMATCH', 'PATH_OUTSIDE_ROOT'])
const NOT_ALLOWED: ReadonlySet<ErrorCode> = new Set([
  'AUTH_EXPIRED',
  'PERMISSION_DENIED',
  'POLICY_DENIED',
  'REVIEW_UNSUPPORTED',
])
const RETRY_LATER: ReadonlySet<ErrorCode> = new Set([
  'RATE_LIMITED',
  'COMPILE_RATE_LIMITED',
  'COMPILE_UNAVAILABLE',
  'TRANSIENT_FAILURE',
])

/** Whether the operation changes nothing on Overleaf and writes nothing locally. */
export function isReadOnly(operation: OperationName | undefined): boolean {
  return operation !== undefined && operationContract(operation).annotations.readOnlyHint === true
}

/** Whether the error says part of a write already applied: a created document, or stored settings. */
function partlyApplied(details: Record<string, unknown> | undefined): boolean {
  const applied = details?.applied
  return details?.created === true || (Array.isArray(applied) && applied.length > 0)
}

/**
 * The exit code for a failed operation command. An outcome that may have applied wins over
 * everything else, so a script never re-runs it; a usage error has no operation and exits 2.
 * Exits 2 and 7 promise that nothing changed, so an error that says part of the call applied
 * exits 4 instead, unless it is one of the codes that exit 3.
 */
export function exitCodeForError(error: McpError, operation?: OperationName): number {
  const outcome = error.details?.outcome
  const readOnly = isReadOnly(operation)
  if (outcome === 'unknown' || error.code === 'OUTCOME_UNKNOWN') return 5
  if (NOT_ALLOWED.has(error.code)) return 3
  if (!readOnly && operation !== undefined && partlyApplied(error.details)) return 4
  // A tracked write that applied untracked is live, never reverted: read it, then decide.
  if (error.code === 'PROTOCOL_UNSUPPORTED' && error.details?.kind === 'applied_untracked') return 4
  if (FIX_THE_CALL.has(error.code)) return 2
  if (error.code === 'REVISION_CONFLICT' || error.code === 'REMOTE_DRIFT') return 4
  if (error.code === 'TIMEOUT') {
    if (readOnly) return 7
    return outcome === 'not_applied' ? 4 : 5
  }
  // The read that failed changed nothing, but an operation that writes may have read after its
  // write, as to read a result back, so only a read-only one is promised to have changed nothing.
  if (error.code === 'TRANSIENT_FAILURE') return readOnly ? 7 : 5
  // A write observed not to have applied, as after a lost socket, is as safe as a stale revision.
  if (!readOnly && operation !== undefined && outcome === 'not_applied') return 4
  if (RETRY_LATER.has(error.code)) return 7
  // A read changes nothing, so any failure Overleaf marks transient can be retried later.
  if (readOnly && error.retryable) return 7
  return 1
}

/** The exit code for a result: 6 when a bulk operation stopped part way, else 0. */
export function exitCodeForResult(result: unknown): number {
  return (result as { status?: unknown } | null)?.status === 'partial' ? 6 : 0
}
