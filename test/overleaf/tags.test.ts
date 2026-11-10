import { describe, expect, test, vi } from 'vitest'

import { McpError } from '../../src/core/errors.js'
import { AccessPolicy } from '../../src/core/policy.js'
import { TagsApi, type TagAction } from '../../src/overleaf/tags.js'

const ID = (n: number) => `${'a'.repeat(23)}${n}`
const THESIS = ID(1)
const REVIEW = ID(2)
const P1 = 'p1'
const P2 = 'p2'

interface RawTag {
  _id: string
  name: string
  color?: string
  project_ids: string[]
  user_id?: string
}

/**
 * An in-memory Overleaf tag store with the routes' own semantics: changes to an unknown tag
 * answer 204 and do nothing, and project ids are filed unchecked.
 */
function fakeOverleaf(initial: RawTag[]) {
  const tags: RawTag[] = structuredClone(initial)
  const writes: string[] = []
  let next = 10
  const find = (id: string) => tags.find(tag => tag._id === id)
  const http = {
    getJson: vi.fn(async (path: string): Promise<unknown> => {
      if (path !== '/tag') throw new Error(`unexpected GET ${path}`)
      return structuredClone(tags.map(tag => ({ ...tag, user_id: 'user', __v: 0 })))
    }),
    postJson: vi.fn(async (path: string, body?: unknown): Promise<unknown> => {
      writes.push(`POST ${path}`)
      const input = body as { name?: string; color?: string; projectIds?: string[] }
      if (path === '/tag') {
        const created = {
          _id: ID(next++),
          name: input.name!,
          project_ids: [] as string[],
          ...(input.color ? { color: input.color } : {}),
        }
        tags.push(created)
        return { ...created, user_id: 'user' }
      }
      const match = /^\/tag\/([^/]+)\/(edit|projects|projects\/remove)$/u.exec(path)
      if (!match) throw new Error(`unexpected POST ${path}`)
      const tag = find(decodeURIComponent(match[1]!))
      if (tag === undefined) return undefined
      if (match[2] === 'edit') {
        tag.name = input.name!
        if (input.color === undefined) delete tag.color
        else tag.color = input.color
      } else if (match[2] === 'projects') {
        for (const id of input.projectIds!) if (!tag.project_ids.includes(id)) tag.project_ids.push(id)
      } else {
        tag.project_ids = tag.project_ids.filter(id => !input.projectIds!.includes(id))
      }
      return undefined
    }),
    deleteJson: vi.fn(async (path: string) => {
      writes.push(`DELETE ${path}`)
      const at = tags.findIndex(tag => `/tag/${tag._id}` === path)
      if (at >= 0) tags.splice(at, 1)
      return undefined
    }),
  }
  return { http, tags, writes }
}

function tagsApi(initial: RawTag[], options: { policy?: AccessPolicy; accessible?: string[] } = {}) {
  const overleaf = fakeOverleaf(initial)
  const accessibleProjectIds = vi.fn(async () => new Set(options.accessible ?? [P1, P2]))
  const api = new TagsApi(overleaf.http, { accessibleProjectIds, policy: options.policy })
  return { ...overleaf, api, accessibleProjectIds }
}

const thesis: RawTag = { _id: THESIS, name: 'Thesis', color: '#336699', project_ids: [P1] }
const review: RawTag = { _id: REVIEW, name: 'Review', project_ids: [] }

async function failure(promise: Promise<unknown>): Promise<McpError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(McpError)
  return error as McpError
}

describe('tags API', () => {
  test('lists every tag by name, without the owner, and with an absent color left out', async () => {
    const { api } = tagsApi([thesis, review])
    expect(await api.listTags()).toEqual([
      { id: REVIEW, name: 'Review', projectIds: [] },
      { id: THESIS, name: 'Thesis', color: '#336699', projectIds: [P1] },
    ])
  })

  test('refuses a tag list it does not understand', async () => {
    const { api, http } = tagsApi([])
    http.getJson.mockResolvedValueOnce({ tags: [] })
    expect((await failure(api.listTags())).code).toBe('PROTOCOL_UNSUPPORTED')
  })

  test('creates a tag and reports it as read back', async () => {
    const { api, writes } = tagsApi([thesis])
    const result = await api.manageTags({ action: 'create', name: 'Grant', color: 'hsl(200, 70%, 45%)' })
    expect(writes).toEqual(['POST /tag'])
    expect(result).toEqual({
      action: 'create',
      tag: { id: ID(10), name: 'Grant', color: 'hsl(200, 70%, 45%)', projectIds: [] },
      deleted: false,
      verified: true,
    })
  })

  test.each<[string, TagAction]>([
    ['a blank name', { action: 'create', name: '   ' }],
    ['a name over 50 characters', { action: 'create', name: 'x'.repeat(51) }],
    ['a color Overleaf refuses', { action: 'create', name: 'Grant', color: 'blue' }],
    ['an edit with nothing to change', { action: 'edit', tagId: THESIS }],
    ['an unsafe tag id', { action: 'delete', tagId: '../x', confirmName: 'x' }],
    ['no project ids', { action: 'add_projects', tagId: THESIS, projectIds: [] }],
  ])('refuses %s before any request', async (_label, input) => {
    const { api, http } = tagsApi([thesis])
    expect((await failure(api.manageTags(input))).code).toBe('INVALID_ARGUMENT')
    expect(http.getJson).not.toHaveBeenCalled()
  })

  test('refuses a name another tag has, with that tag id, and sends nothing', async () => {
    const { api, writes } = tagsApi([thesis, review])
    const created = await failure(api.manageTags({ action: 'create', name: 'Thesis' }))
    expect(created.code).toBe('INVALID_ARGUMENT')
    expect(created.details).toEqual({ kind: 'tag_name_taken', tagId: THESIS })
    const renamed = await failure(api.manageTags({ action: 'edit', tagId: REVIEW, name: 'Thesis' }))
    expect(renamed.details).toEqual({ kind: 'tag_name_taken', tagId: THESIS })
    expect(writes).toEqual([])
  })

  test('reports an unknown tag id as NOT_FOUND before any change', async () => {
    const { api, writes } = tagsApi([thesis])
    const error = await failure(api.manageTags({ action: 'edit', tagId: ID(9), name: 'Other' }))
    expect(error.code).toBe('NOT_FOUND')
    expect(error.details).toEqual({ tagId: ID(9) })
    expect(writes).toEqual([])
  })

  test('renames a tag and keeps its color, which the edit route would otherwise drop', async () => {
    const { api, http } = tagsApi([thesis])
    const result = await api.manageTags({ action: 'edit', tagId: THESIS, name: 'Dissertation' })
    expect(http.postJson).toHaveBeenCalledWith(`/tag/${THESIS}/edit`, { name: 'Dissertation', color: '#336699' })
    expect(result.tag).toEqual({ id: THESIS, name: 'Dissertation', color: '#336699', projectIds: [P1] })
    expect(result.verified).toBe(true)
  })

  test('changes only the color, sending the current name', async () => {
    const { api, http } = tagsApi([thesis])
    const result = await api.manageTags({ action: 'edit', tagId: THESIS, color: '#aa0000' })
    expect(http.postJson).toHaveBeenCalledWith(`/tag/${THESIS}/edit`, { name: 'Thesis', color: '#aa0000' })
    expect(result.tag.color).toBe('#aa0000')
  })

  test('deletes a tag only when confirmName repeats its name', async () => {
    const { api, writes, tags } = tagsApi([thesis])
    const mismatch = await failure(api.manageTags({ action: 'delete', tagId: THESIS, confirmName: 'thesis' }))
    expect(mismatch.code).toBe('CONFIRMATION_MISMATCH')
    expect(writes).toEqual([])

    const result = await api.manageTags({ action: 'delete', tagId: THESIS, confirmName: 'Thesis' })
    expect(writes).toEqual([`DELETE /tag/${THESIS}`])
    expect(tags).toEqual([])
    expect(result).toEqual({
      action: 'delete',
      tag: { id: THESIS, name: 'Thesis', color: '#336699', projectIds: [P1] },
      deleted: true,
      verified: true,
    })
  })

  test('adds and removes projects in one request each, and reports the tag read back', async () => {
    const { api, http } = tagsApi([thesis])
    const added = await api.manageTags({ action: 'add_projects', tagId: THESIS, projectIds: [P2, P1, P2] })
    expect(http.postJson).toHaveBeenCalledWith(`/tag/${THESIS}/projects`, { projectIds: [P2, P1] })
    expect(added.tag.projectIds).toEqual([P1, P2])

    const removed = await api.manageTags({ action: 'remove_projects', tagId: THESIS, projectIds: [P1] })
    expect(http.postJson).toHaveBeenCalledWith(`/tag/${THESIS}/projects/remove`, { projectIds: [P1] })
    expect(removed.tag.projectIds).toEqual([P2])
  })

  test('refuses projects the account cannot access, naming them, before any change', async () => {
    const { api, writes } = tagsApi([thesis], { accessible: [P1] })
    const error = await failure(api.manageTags({ action: 'add_projects', tagId: THESIS, projectIds: [P1, 'p9'] }))
    expect(error.code).toBe('NOT_FOUND')
    expect(error.details).toEqual({ projectIds: ['p9'] })
    expect(writes).toEqual([])
  })

  test('keeps a refusal from Overleaf as it is, with nothing read back', async () => {
    const { api, http } = tagsApi([thesis])
    http.postJson.mockRejectedValueOnce(new McpError('RATE_LIMITED', 'slow down', { retryable: true }))
    expect((await failure(api.manageTags({ action: 'edit', tagId: THESIS, name: 'Other' }))).code).toBe('RATE_LIMITED')
    expect(http.getJson).toHaveBeenCalledTimes(1)
  })

  test('classifies a timed-out change that applied from the read-back, never resending it', async () => {
    const { api, http, tags } = tagsApi([thesis])
    http.postJson.mockImplementationOnce(async () => {
      tags[0]!.project_ids.push(P2)
      throw new McpError('TIMEOUT', 'timed out', { retryable: true })
    })
    const result = await api.manageTags({ action: 'add_projects', tagId: THESIS, projectIds: [P2] })
    expect(http.postJson).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ verified: true, recoveredAfterTimeout: true, tag: { projectIds: [P1, P2] } })
  })

  test('reports a timed-out change the read-back does not show as OUTCOME_UNKNOWN, not resent', async () => {
    const { api, http } = tagsApi([thesis])
    http.deleteJson.mockRejectedValueOnce(new McpError('REMOTE_ERROR', 'cut off', { details: { kind: 'network' } }))
    const error = await failure(api.manageTags({ action: 'delete', tagId: THESIS, confirmName: 'Thesis' }))
    expect(error.code).toBe('OUTCOME_UNKNOWN')
    expect(error.retryable).toBe(false)
    expect(error.details).toEqual({ outcome: 'unknown' })
    expect(http.deleteJson).toHaveBeenCalledTimes(1)
  })

  test('recovers a timed-out create from the read-back by name', async () => {
    const { api, http, tags } = tagsApi([])
    http.postJson.mockImplementationOnce(async () => {
      tags.push({ _id: ID(7), name: 'Grant', project_ids: [] })
      throw new McpError('TIMEOUT', 'timed out', { retryable: true })
    })
    const result = await api.manageTags({ action: 'create', name: 'Grant' })
    expect(result).toEqual({
      action: 'create',
      tag: { id: ID(7), name: 'Grant', projectIds: [] },
      deleted: false,
      verified: true,
      recoveredAfterTimeout: true,
    })
  })

  test('reports a change Overleaf accepted but the read-back contradicts as OUTCOME_UNKNOWN', async () => {
    const { api, http } = tagsApi([thesis])
    // 204, but the edit never landed, as when another change came in between.
    http.postJson.mockResolvedValueOnce(undefined)
    const error = await failure(api.manageTags({ action: 'edit', tagId: THESIS, name: 'Other' }))
    expect(error.code).toBe('OUTCOME_UNKNOWN')
  })

  test('returns an accepted change unverified when the tags cannot be read again', async () => {
    const { api, http } = tagsApi([thesis])
    http.getJson.mockImplementationOnce(async () => [{ ...thesis, user_id: 'user' }])
    http.getJson.mockRejectedValueOnce(new McpError('TIMEOUT', 'timed out', { retryable: true }))
    const result = await api.manageTags({ action: 'edit', tagId: THESIS, color: '#000000' })
    expect(result).toEqual({
      action: 'edit',
      tag: { id: THESIS, name: 'Thesis', color: '#000000', projectIds: [P1] },
      deleted: false,
      verified: false,
    })
  })

  test('returns an accepted create unverified, with the id Overleaf gave, when the tags cannot be read again', async () => {
    const { api, http } = tagsApi([])
    http.getJson.mockImplementationOnce(async () => [])
    http.getJson.mockRejectedValueOnce(new McpError('TIMEOUT', 'timed out', { retryable: true }))
    expect(await api.manageTags({ action: 'create', name: 'Grant' })).toEqual({
      action: 'create',
      tag: { id: ID(10), name: 'Grant', projectIds: [] },
      deleted: false,
      verified: false,
    })
  })

  test('reports an accepted create the read-back does not show as OUTCOME_UNKNOWN', async () => {
    const { api, http } = tagsApi([])
    http.postJson.mockResolvedValueOnce({ _id: ID(8), name: 'Grant' })
    const error = await failure(api.manageTags({ action: 'create', name: 'Grant' }))
    expect(error.code).toBe('OUTCOME_UNKNOWN')
    expect(error.message).toMatch(/did not show it/u)
  })

  test('says so when an accepted create named no tag and the tags could not be read', async () => {
    const { api, http } = tagsApi([])
    http.postJson.mockResolvedValueOnce({})
    http.getJson.mockImplementationOnce(async () => [])
    http.getJson.mockRejectedValueOnce(new McpError('TIMEOUT', 'timed out', { retryable: true }))
    const error = await failure(api.manageTags({ action: 'create', name: 'Grant' }))
    expect(error.code).toBe('OUTCOME_UNKNOWN')
    expect(error.message).toMatch(/could not be read back/u)
  })

  test('reads back after an HTTP 5xx, which may have applied, and never resends', async () => {
    const { api, http, tags } = tagsApi([thesis])
    http.postJson.mockImplementationOnce(async () => {
      tags[0]!.name = 'Other'
      throw new McpError('REMOTE_ERROR', 'HTTP 502', { details: { status: 502, path: '/tag' } })
    })
    const result = await api.manageTags({ action: 'edit', tagId: THESIS, name: 'Other' })
    expect(result).toMatchObject({ verified: true, recoveredAfterTimeout: true, tag: { name: 'Other' } })
    expect(http.postJson).toHaveBeenCalledTimes(1)
  })

  test('names the read-back failure when both the change and the read-back failed', async () => {
    const { api, http } = tagsApi([thesis])
    http.postJson.mockRejectedValueOnce(new McpError('TIMEOUT', 'timed out', { retryable: true }))
    http.getJson.mockImplementationOnce(async () => [{ ...thesis, user_id: 'user' }])
    http.getJson.mockRejectedValueOnce(new McpError('AUTH_EXPIRED', 'expired'))
    const error = await failure(api.manageTags({ action: 'add_projects', tagId: THESIS, projectIds: [P2] }))
    expect(error.code).toBe('OUTCOME_UNKNOWN')
    expect(error.details).toEqual({ outcome: 'unknown', readBack: 'AUTH_EXPIRED' })
  })

  describe('with an access policy', () => {
    test('shows only allowed projects and refuses others as projectIds, before any request', async () => {
      const policy = await AccessPolicy.create({ allowedProjects: [P1] })
      const { api, http } = tagsApi([{ ...thesis, project_ids: [P1, P2] }], { policy })
      expect((await api.listTags())[0]!.projectIds).toEqual([P1])
      const error = await failure(api.manageTags({ action: 'add_projects', tagId: THESIS, projectIds: [P2] }))
      expect(error.code).toBe('POLICY_DENIED')
      expect(error.details).toEqual({ parameter: 'projectIds' })
      expect(http.getJson).toHaveBeenCalledTimes(1)
    })

    test('refuses to edit or delete a tag that holds projects outside the allowlist', async () => {
      const policy = await AccessPolicy.create({ allowedProjects: [P1] })
      const { api, writes } = tagsApi([{ ...thesis, project_ids: [P1, P2] }], { policy })
      expect((await failure(api.manageTags({ action: 'edit', tagId: THESIS, name: 'Other' }))).code).toBe(
        'POLICY_DENIED'
      )
      expect((await failure(api.manageTags({ action: 'delete', tagId: THESIS, confirmName: 'Thesis' }))).code).toBe(
        'POLICY_DENIED'
      )
      expect(writes).toEqual([])
    })

    test('needs overleaf-delete to delete, and project-lifecycle for any change', async () => {
      const lifecycle = await AccessPolicy.create({ allowedEffects: ['project-lifecycle', 'overleaf-read'] })
      const { api, http } = tagsApi([thesis], { policy: lifecycle })
      const error = await failure(api.manageTags({ action: 'delete', tagId: THESIS, confirmName: 'Thesis' }))
      expect(error.details).toEqual({ effect: 'overleaf-delete' })
      const readOnly = await AccessPolicy.create({ allowedEffects: ['overleaf-read'] })
      const other = tagsApi([thesis], { policy: readOnly })
      expect((await failure(other.api.manageTags({ action: 'create', name: 'Grant' }))).details).toEqual({
        effect: 'project-lifecycle',
      })
      expect(http.getJson).not.toHaveBeenCalled()
      expect(other.http.getJson).not.toHaveBeenCalled()
    })
  })
})
