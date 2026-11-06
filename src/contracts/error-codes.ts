/**
 * Every error code a failure can carry, through every interface. `McpErrorCode` is derived from
 * this list, so a code cannot be thrown without being listed, and a new code is a public change
 * recorded in CHANGELOG.md.
 */
export const ERROR_CODES = [
  'AUTH_EXPIRED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'PROTOCOL_UNSUPPORTED',
  'UPDATE_TOO_LARGE',
  'DOC_TOO_LARGE',
  'TIMEOUT',
  'OUTCOME_UNKNOWN',
  'COMPILE_FAILED',
  'COMPILE_RATE_LIMITED',
  'COMPILE_UNAVAILABLE',
  'COMPILE_TIMEOUT',
  'NO_BUILD',
  'BUILD_NOT_FOUND',
  'PARTIAL_CLEANUP',
  'INVALID_ARGUMENT',
  'CONFIRMATION_MISMATCH',
  'RATE_LIMITED',
  'REMOTE_DRIFT',
  'PATH_OUTSIDE_ROOT',
  'POLICY_DENIED',
  'REMOTE_ERROR',
  'REVIEW_UNSUPPORTED',
  'INCLUDE_CYCLE',
  'INCLUDE_DEPTH_EXCEEDED',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]
