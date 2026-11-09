/**
 * A call that relied on a default a later release tightens. It still did what it did before;
 * `enforcedIn` names the release from which the same call is refused. A result lists these in
 * `deprecations` from the minor that announces a change until the release that enforces it,
 * declared in that operation's `outputSchema`, and `serve` reports `DEPRECATED`.
 * 0.6.0 enforced every default 0.5.0 announced, so no result lists one now.
 */
export interface Deprecation {
  /** The parameter the caller should pass from now on. */
  parameter: string
  message: string
  enforcedIn: string
}

/** Adds a deprecation once per parameter. */
export function addDeprecation(list: Deprecation[], parameter: string, message: string, enforcedIn: string): void {
  if (list.some(entry => entry.parameter === parameter)) return
  list.push({ parameter, message, enforcedIn })
}
