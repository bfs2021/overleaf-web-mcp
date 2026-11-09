import { McpError } from './errors.js'

/** At most this many attempts of one read, the first included. */
export const MAX_READ_ATTEMPTS = 3

const BASE_DELAY_MS = 250

export type Sleep = (ms: number) => Promise<void>

export const defaultSleep: Sleep = async ms => await new Promise(resolve => setTimeout(resolve, ms))

export interface ReadRetryOptions {
  /** Attempts in all, from 1 (no retry) to `MAX_READ_ATTEMPTS`. */
  attempts: number
  sleep?: Sleep
  signal?: AbortSignal
  /** Whether this failure may be tried again: only failures that changed nothing qualify. */
  isTransient(error: McpError): boolean
  /** Short identifiers for the exhausted error's details; never response text. */
  details?: Record<string, unknown>
}

/** Full jitter on an exponential step, so parallel callers do not retry in step. */
function backoffMs(attempt: number): number {
  const ceiling = BASE_DELAY_MS * 2 ** (attempt - 1)
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2))
}

/**
 * Runs a read and tries it again after a transient failure, with bounded exponential backoff.
 * Only reads go through here: a write is never resubmitted by this package. When every attempt
 * failed transiently, the last failure becomes `TRANSIENT_FAILURE`; any other failure is thrown
 * as it is, at once. The read changed nothing, but a call can read after it wrote, as to read a
 * result back, so the error does not say the call changed nothing.
 */
export async function retryRead<T>(work: () => Promise<T>, options: ReadRetryOptions): Promise<T> {
  // A value that is not a number, as from a configuration built by hand, never loops: one attempt.
  const requested = Number.isFinite(options.attempts) ? Math.trunc(options.attempts) : 1
  const attempts = Math.min(Math.max(1, requested), MAX_READ_ATTEMPTS)
  const sleep = options.sleep ?? defaultSleep
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work()
    } catch (error) {
      if (!(error instanceof McpError) || !options.isTransient(error)) throw error
      if (attempts === 1) throw error
      if (attempt >= attempts || options.signal?.aborted === true) {
        throw new McpError(
          'TRANSIENT_FAILURE',
          `A read from Overleaf failed ${attempt} times in a row for a reason that usually passes; the read itself changed nothing. Try again later. If this call changes something, check the project first: the change may have been sent before the read failed.`,
          {
            retryable: true,
            details: {
              attempts: attempt,
              lastCode: error.code,
              ...pick(error.details, ['status', 'reason', 'path']),
              ...options.details,
            },
            cause: error,
          }
        )
      }
      await sleep(backoffMs(attempt))
    }
  }
}

function pick(details: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> {
  if (details === undefined) return {}
  return Object.fromEntries(keys.filter(key => details[key] !== undefined).map(key => [key, details[key]]))
}
