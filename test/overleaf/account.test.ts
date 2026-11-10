import { describe, expect, test, vi } from 'vitest'

import { AccountApi } from '../../src/overleaf/account.js'

const projects = [
  { _id: 'b', name: 'Zulu', accessLevel: 'readOnly', lastUpdated: '2026-08-01T00:00:00.000Z' },
  { id: 'a', name: 'Alpha', accessLevel: 'owner', lastUpdated: '2026-09-01T00:00:00.000Z' },
  { _id: 'c', name: 'Archived notes', accessLevel: 'owner', archived: true, lastUpdated: '2026-09-02T00:00:00.000Z' },
  { _id: 'd', name: 'Trashed draft', accessLevel: 'owner', trashed: true },
  { _id: 'e', name: 'alpha centauri', accessLevel: 'owner' },
]

function api(body: unknown = { totalSize: projects.length, projects }) {
  const http = { postJson: vi.fn(async () => body) }
  return { http, api: new AccountApi(http) }
}

describe('account API', () => {
  test('reads the dashboard list, hides archived and trashed projects, and sorts newest first', async () => {
    const { http, api: account } = api()

    const listing = await account.listProjects()

    expect(http.postJson).toHaveBeenCalledWith('/api/project', {}, { read: true })
    expect(listing.projects.map(project => project.id)).toEqual(['a', 'b', 'e'])
    expect(listing.projects[0]).toEqual({
      id: 'a',
      name: 'Alpha',
      accessLevel: 'owner',
      lastUpdated: '2026-09-01T00:00:00.000Z',
      archived: false,
      trashed: false,
    })
    expect(listing.totalMatched).toBe(3)
    expect(listing.totalProjects).toBe(5)
  })

  test('includes archived and trashed projects only on request', async () => {
    const { api: account } = api()

    const listing = await account.listProjects({ includeArchived: true, includeTrashed: true, sort: 'name' })

    expect(listing.projects.map(project => project.name)).toEqual([
      'Alpha',
      'alpha centauri',
      'Archived notes',
      'Trashed draft',
      'Zulu',
    ])
    expect(listing.totalMatched).toBe(5)
  })

  test('filters by a case-insensitive name substring and caps the page with limit', async () => {
    const { api: account } = api()

    const listing = await account.listProjects({ query: 'ALPHA', limit: 1 })

    expect(listing.projects.map(project => project.id)).toEqual(['a'])
    expect(listing.totalMatched).toBe(2)
    expect(listing.totalProjects).toBe(5)
  })

  test('rejects a limit outside the allowed range before calling Overleaf', async () => {
    const { http, api: account } = api()

    await expect(account.listProjects({ limit: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(account.listProjects({ limit: 201 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(http.postJson).not.toHaveBeenCalled()
  })

  test('counts every project through the dashboard total', async () => {
    const { api: account } = api()

    await expect(account.countProjects()).resolves.toBe(5)
  })

  test('finds a project by id regardless of its archived or trashed state', async () => {
    const { api: account } = api()

    await expect(account.findProject('d')).resolves.toMatchObject({ name: 'Trashed draft', trashed: true })
    await expect(account.findProject('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  test('reports an unexpected response shape as PROTOCOL_UNSUPPORTED', async () => {
    const { api: account } = api({ projects: [{ name: 'no id', accessLevel: 'owner' }] })

    await expect(account.listProjects()).rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' })
  })

  test('falls back to the project count when Overleaf omits totalSize', async () => {
    const { api: account } = api({ projects: [{ _id: 'a', name: 'Alpha', accessLevel: 'owner' }] })

    await expect(account.listProjects()).resolves.toMatchObject({ totalMatched: 1, totalProjects: 1 })
  })

  describe('tags', () => {
    const tags = [
      { id: 't1', name: 'Thesis', color: '#336699', projectIds: ['a', 'c', 'gone'] },
      { id: 't2', name: 'Empty', projectIds: [] },
    ]

    test('reads no tags unless asked', async () => {
      const listTags = vi.fn(async () => tags)
      const account = new AccountApi({ postJson: vi.fn(async () => ({ projects })) }, undefined, listTags)
      const listing = await account.listProjects()
      expect(listTags).not.toHaveBeenCalled()
      expect(listing).not.toHaveProperty('tags')
      expect(listing.projects[0]).not.toHaveProperty('tags')
    })

    test("adds each project's tags and every tag with how many listed projects it holds", async () => {
      const account = new AccountApi({ postJson: vi.fn(async () => ({ projects })) }, undefined, async () => tags)
      const listing = await account.listProjects({ includeTags: true })
      expect(listing.projects.map(project => [project.id, project.tags])).toEqual([
        ['a', [{ id: 't1', name: 'Thesis' }]],
        ['b', []],
        ['e', []],
      ])
      // 'c' is archived but still the account's; 'gone' is not, so it is not counted.
      expect(listing.tags).toEqual([
        { id: 't1', name: 'Thesis', color: '#336699', projectCount: 2 },
        { id: 't2', name: 'Empty', projectCount: 0 },
      ])
    })

    test('lists only the projects in the tag with that exact name', async () => {
      const account = new AccountApi({ postJson: vi.fn(async () => ({ projects })) }, undefined, async () => tags)
      const listing = await account.listProjects({ tag: 'Thesis', includeArchived: true })
      expect(listing.projects.map(project => project.id)).toEqual(['c', 'a'])
      expect(listing.totalMatched).toBe(2)
      expect(listing).not.toHaveProperty('tags')
      await expect(account.listProjects({ tag: 'thesis' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    test('refuses tags on a backend that cannot read them', async () => {
      const account = new AccountApi({ postJson: vi.fn(async () => ({ projects })) })
      await expect(account.listProjects({ includeTags: true })).rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' })
    })
  })
})
