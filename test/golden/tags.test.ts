import { rm } from 'node:fs/promises'

import { describe, expect, test } from 'vitest'

import { createOverleafService } from '../../src/service/operations.js'
import { expectGolden } from '../helpers/golden.js'
import { createTestRuntime } from '../helpers/runtime.js'

const THESIS = '64b000000000000000000001'
const EMPTY = '64b000000000000000000002'
const CREATED = '64b000000000000000000003'

const projects = [
  { _id: 'p1', name: 'Paper', accessLevel: 'owner', lastUpdated: '2026-09-02T00:00:00.000Z' },
  { _id: 'p2', name: 'Talk', accessLevel: 'readAndWrite', lastUpdated: '2026-09-01T00:00:00.000Z' },
]

/** Overleaf's answers for the project list and the tag routes, holding the tags in memory. */
async function runtimeWithTags() {
  const tags: { _id: string; user_id: string; name: string; color?: string; project_ids: string[]; __v: number }[] = [
    { _id: THESIS, user_id: 'user', name: 'Thesis', color: '#336699', project_ids: ['p1'], __v: 0 },
    { _id: EMPTY, user_id: 'user', name: 'Empty', project_ids: [], __v: 0 },
  ]
  return await createTestRuntime({
    fetcher: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      if (method === 'POST' && url.pathname === '/api/project') {
        return Response.json({ totalSize: projects.length, projects })
      }
      if (method === 'GET' && url.pathname === '/tag') return Response.json(tags)
      if (method === 'POST' && url.pathname === '/tag') {
        const created = { _id: CREATED, user_id: 'user', name: String(body.name), project_ids: [], __v: 0 }
        tags.push(created)
        return Response.json(created)
      }
      if (method === 'POST' && url.pathname === `/tag/${THESIS}/projects`) {
        tags[0]!.project_ids.push(...(body.projectIds as string[]))
        return new Response(null, { status: 204 })
      }
      if (method === 'DELETE' && url.pathname === `/tag/${EMPTY}`) {
        tags.splice(1, 1)
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected ${method} ${url.pathname}`)
    },
  })
}

describe('golden tag results', () => {
  test('list_projects with includeTags', async () => {
    const { runtime, fetches, directory } = await runtimeWithTags()
    try {
      const result = await createOverleafService(runtime).list_projects({
        includeArchived: false,
        includeTrashed: false,
        includeTags: true,
        limit: 50,
        sort: 'lastUpdated',
      })
      expect(fetches).toEqual(['POST /api/project', 'GET /tag'])
      expectGolden('list_projects', result)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('manage_tags create, add_projects, and delete', async () => {
    const { runtime, fetches, directory } = await runtimeWithTags()
    try {
      const service = createOverleafService(runtime)
      const created = await service.manage_tags({ action: 'create', name: 'Grant' })
      expectGolden('manage_tags', created)
      const added = await service.manage_tags({ action: 'add_projects', tagId: THESIS, projectIds: ['p2'] })
      expectGolden('manage_tags', added)
      const deleted = await service.manage_tags({ action: 'delete', tagId: EMPTY, confirmName: 'Empty' })
      expectGolden('manage_tags', deleted)
      expect(fetches).toEqual([
        'GET /tag',
        'POST /tag',
        'GET /tag',
        'GET /tag',
        'POST /api/project',
        `POST /tag/${THESIS}/projects`,
        'GET /tag',
        'GET /tag',
        `DELETE /tag/${EMPTY}`,
        'GET /tag',
      ])
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
