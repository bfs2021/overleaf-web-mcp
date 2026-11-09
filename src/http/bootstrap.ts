import { AUTH_LOGIN_INSTRUCTION, McpError } from '../core/errors.js'

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&')
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
}

function attributes(tag: string): Record<string, string> {
  const output: Record<string, string> = {}
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu
  for (const match of tag.matchAll(pattern)) {
    output[match[1]!.toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? '')
  }
  return output
}

export interface BootstrapMeta {
  csrfToken?: string
  userId?: string
  maxDocLength?: number
}

export function parseBootstrapMeta(html: string): BootstrapMeta {
  const meta = new Map<string, string>()
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    const attrs = attributes(match[0])
    if (attrs.name && attrs.content !== undefined) meta.set(attrs.name, attrs.content)
  }
  const rawLimit = meta.get('ol-maxDocLength')
  const maxDocLength = rawLimit === undefined ? undefined : Number(rawLimit)
  const output: BootstrapMeta = {}
  const csrfToken = meta.get('ol-csrfToken')
  const userId = meta.get('ol-user_id')
  if (csrfToken !== undefined) output.csrfToken = csrfToken
  if (userId !== undefined) output.userId = userId
  if (maxDocLength !== undefined && Number.isSafeInteger(maxDocLength) && maxDocLength > 0) {
    output.maxDocLength = maxDocLength
  }
  return output
}

/**
 * The CSRF token every request that changes something needs, or the reason the page has none. A
 * signed-in page (one naming `ol-user_id`) without a token is a page this release does not read,
 * not a lost session, since signing in again would not change it.
 */
export function requireCsrfToken(meta: BootstrapMeta): string {
  if (meta.csrfToken !== undefined && meta.csrfToken !== '') return meta.csrfToken
  if (meta.userId !== undefined) {
    throw new McpError(
      'PROTOCOL_UNSUPPORTED',
      'Overleaf served a signed-in project page without the CSRF token this release reads.',
      { details: { kind: 'response_shape', endpoint: 'GET /project' } }
    )
  }
  throw new McpError('AUTH_EXPIRED', `Overleaf did not expose an authenticated CSRF token. ${AUTH_LOGIN_INSTRUCTION}`)
}
