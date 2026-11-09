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
})
