import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CookieJar } from 'tough-cookie'
import { describe, expect, test, vi } from 'vitest'

import { OPERATION_NAMES, OPERATIONS, type OperationName } from '../src/contracts/operations.js'
import { OverleafHttpClient } from '../src/http/client.js'
import { createOverleafService } from '../src/service/operations.js'
import { INPUTS } from './helpers/operation-inputs.js'
import { createTestRuntime } from './helpers/runtime.js'

type Service = Record<OperationName, (input: unknown) => Promise<unknown>>

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

async function localFolders() {
  const base = await mkdtemp(join(tmpdir(), 'overleaf-policy-runtime-'))
  const allowed = join(base, 'allowed')
  const outside = join(base, 'outside')
  await mkdir(allowed)
  await mkdir(outside)
  await writeFile(join(outside, 'main.tex'), 'text')
  await writeFile(join(outside, 'paper.zip'), 'PK')
  await writeFile(join(outside, 'figure.png'), 'png')
  await symlink(outside, join(allowed, 'escape'))
  return { base, allowed, outside }
}

describe('local roots through the real runtime', () => {
  test('refuses every local read outside OVERLEAF_LOCAL_READ_ROOTS with nothing sent', async () => {
    const { allowed, outside } = await localFolders()
    const { runtime, fetches, connectionFactory } = await createTestRuntime({
      env: { OVERLEAF_LOCAL_READ_ROOTS: allowed },
    })
    const service = createOverleafService(runtime) as unknown as Service
    try {
      for (const folder of [outside, join(allowed, 'escape')]) {
        const calls: Array<[OperationName, Record<string, unknown>]> = [
          ['write_file', { projectId: 'p', filePath: 'main.tex', revision: 'r', localPath: join(folder, 'main.tex') }],
          ['upload_file', { projectId: 'p', localPath: join(folder, 'figure.png') }],
          [
            'batch_upload',
            { projectId: 'p', files: [{ localPath: join(folder, 'figure.png'), destinationPath: 'f.png' }] },
          ],
          ['import_project_zip', { localZipPath: join(folder, 'paper.zip') }],
          ['plan_sync', { projectId: 'p', localFolderPath: folder }],
          ['sync_directory', { projectId: 'p', localFolderPath: folder, mode: 'additive', unplanned: true }],
        ]
        for (const [name, input] of calls) {
          await expect(service[name](input), `${name} from ${folder}`).rejects.toMatchObject({
            code: 'PATH_OUTSIDE_ROOT',
            details: { kind: 'outside_read_roots' },
          })
        }
      }
      expect(fetches).toEqual([])
      expect(connectionFactory).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
    }
  })

  test('never reads the saved session, nor syncs a folder that holds it', async () => {
    const { runtime, fetches, connectionFactory, cookiePath, directory } = await createTestRuntime()
    const service = createOverleafService(runtime)
    try {
      await expect(
        service.write_file({ projectId: 'p', filePath: 'main.tex', revision: 'r', localPath: cookiePath })
      ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT', details: { kind: 'session_files' } })
      await expect(service.upload_file({ projectId: 'p', localPath: cookiePath })).rejects.toMatchObject({
        details: { kind: 'session_files' },
      })
      await expect(service.plan_sync({ projectId: 'p', localFolderPath: directory })).rejects.toMatchObject({
        details: { kind: 'session_files' },
      })
      expect(fetches).toEqual([])
      expect(connectionFactory).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
    }
  })

  test('never downloads onto the cookie jar, even with no roots set', async () => {
    const { runtime, fetches, connectionFactory, cookiePath, directory } = await createTestRuntime({
      root: { _id: 'root', name: 'rootFolder', docs: [{ _id: 'd1', name: 'main.tex' }], fileRefs: [], folders: [] },
    })
    const service = createOverleafService(runtime)
    try {
      await expect(
        service.download_file({ projectId: 'p', filePath: 'main.tex', localPath: cookiePath, overwrite: true })
      ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT', details: { kind: 'session_files' } })
      await expect(
        service.download_project_zip({
          projectId: 'p',
          localPath: join(directory, 'profile', 'x.zip'),
          overwrite: true,
        })
      ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT', details: { kind: 'session_files' } })
      expect(fetches).toEqual([])
      expect(connectionFactory).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
    }
  })

  test('keeps downloads inside OVERLEAF_LOCAL_WRITE_ROOTS', async () => {
    const { allowed, outside } = await localFolders()
    const { runtime, fetches } = await createTestRuntime({ env: { OVERLEAF_LOCAL_WRITE_ROOTS: allowed } })
    try {
      await expect(runtime.entities.downloadFile('p', 'main.tex', join(outside, 'copy.tex'))).rejects.toMatchObject({
        code: 'PATH_OUTSIDE_ROOT',
        details: { kind: 'outside_write_roots' },
      })
      await expect(
        runtime.projects.downloadProjectZip('p', join(allowed, 'escape', 'backup.zip'))
      ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT', details: { kind: 'outside_write_roots' } })
      expect(fetches).toEqual([])
    } finally {
      await runtime.close()
    }
  })
})

describe('allowed projects through the real runtime', () => {
  test('refuses every operation on another project with nothing sent', async () => {
    const { runtime, fetches, connectionFactory } = await createTestRuntime({ env: { OVERLEAF_ALLOWED_PROJECTS: 'a' } })
    const service = createOverleafService(runtime) as unknown as Service
    try {
      const scoped = OPERATION_NAMES.filter(name => {
        const shape = (OPERATIONS[name] as { inputSchema?: { shape: Record<string, unknown> } }).inputSchema?.shape
        return shape !== undefined && ('projectId' in shape || 'sourceProjectId' in shape)
      })
      // auth_status, list_projects, create_project, and import_project_zip name no project.
      expect(scoped).toHaveLength(OPERATION_NAMES.length - 4)
      for (const name of scoped) {
        const input = { ...INPUTS[name] }
        if ('projectId' in input) input.projectId = 'b'
        if ('sourceProjectId' in input) input.sourceProjectId = 'b'
        await expect(service[name](input), name).rejects.toMatchObject({ code: 'POLICY_DENIED' })
      }
      // The domain engine refuses it too, so the exported runtime is no way around the policy.
      await expect(runtime.documents.readFile('b', 'main.tex')).rejects.toMatchObject({ code: 'POLICY_DENIED' })
      await expect(runtime.compile.stopCompile('b')).rejects.toMatchObject({ code: 'POLICY_DENIED' })
      await expect(runtime.connections.withConnection('b', async () => undefined)).rejects.toMatchObject({
        code: 'POLICY_DENIED',
      })
      expect(fetches).toEqual([])
      expect(connectionFactory).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
    }
  })

  test('lists only allowed projects and accepts one this process created', async () => {
    const { runtime, fetches } = await createTestRuntime({
      env: { OVERLEAF_ALLOWED_PROJECTS: 'a' },
      fetcher: async (input, init) => {
        const url = new URL(String(input))
        if (init?.method === 'POST' && url.pathname === '/api/project') {
          return json({
            totalSize: 3,
            projects: ['a', 'b', 'n'].map(id => ({ _id: id, name: `Project ${id}`, accessLevel: 'owner' })),
          })
        }
        if (init?.method === 'POST' && url.pathname === '/project/new') return json({ project_id: 'n' })
        throw new Error(`unexpected ${url.pathname}`)
      },
    })
    const service = createOverleafService(runtime)
    try {
      const before = await service.list_projects({})
      expect(before.projects.map(project => project.id)).toEqual(['a'])
      expect(before).toMatchObject({ totalMatched: 1, totalProjects: 1 })
      await expect(runtime.authStatus()).resolves.toMatchObject({ projectCount: 1 })

      await expect(service.create_project({ name: 'New' })).resolves.toMatchObject({ projectId: 'n' })
      await expect(service.get_project_tree({ projectId: 'n' })).resolves.toBeDefined()
      expect((await service.list_projects({})).projects.map(project => project.id).sort()).toEqual(['a', 'n'])
      expect(fetches).toContain('POST /project/new')
    } finally {
      await runtime.close()
    }
  })
})

describe('allowed effects through the real runtime', () => {
  test('refuses a direct document write before anything is submitted', async () => {
    const { runtime, socketCalls } = await createTestRuntime({
      env: { OVERLEAF_ALLOWED_EFFECTS: 'overleaf-read,local-read' },
    })
    try {
      const read = await runtime.documents.readFile('p', 'main.tex')
      socketCalls.length = 0
      await expect(runtime.documents.writeFile('p', 'main.tex', read.revision, 'changed')).rejects.toMatchObject({
        code: 'POLICY_DENIED',
        details: { effect: 'overleaf-write' },
      })
      await expect(
        runtime.entities.manageEntity('p', { action: 'delete', path: 'main.tex', confirmPath: 'main.tex' })
      ).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { effect: 'overleaf-delete' } })
      await expect(runtime.compile.compileProject('p')).rejects.toMatchObject({ code: 'POLICY_DENIED' })
      // A section write reads first, with or without followIncludes; the write is refused before that read.
      for (const followIncludes of [false, true]) {
        await expect(
          runtime.sections.writeSection('p', 'main.tex', read.revision, 'section:0', 'x\n', 'untracked', {
            followIncludes,
          })
        ).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { effect: 'overleaf-write' } })
      }
      expect(socketCalls).toEqual([])
    } finally {
      await runtime.close()
    }
  })
})

describe('effects a write needs for its own reads', () => {
  test('are refused before the write, never after it', async () => {
    const { runtime, fetches, socketCalls } = await createTestRuntime({
      env: { OVERLEAF_ALLOWED_EFFECTS: 'project-lifecycle,overleaf-write' },
      fetcher: async () => json({ project_id: 'n' }),
    })
    const service = createOverleafService(runtime)
    try {
      // Each of these reads after changing something, so the read is checked before the change.
      await expect(service.create_project({ name: 'New' })).rejects.toMatchObject({ code: 'POLICY_DENIED' })
      await expect(service.update_project_settings({ projectId: 'p', compiler: 'xelatex' })).rejects.toMatchObject({
        code: 'POLICY_DENIED',
      })
      await expect(service.create_file({ projectId: 'p', filePath: 'new.tex', content: 'x' })).rejects.toMatchObject({
        code: 'POLICY_DENIED',
      })
      await expect(service.reply_to_comment({ projectId: 'p', threadId: 't', content: 'Hi' })).rejects.toMatchObject({
        code: 'POLICY_DENIED',
      })
      await expect(
        service.set_comment_status({
          projectId: 'p',
          filePath: 'main.tex',
          revision: 'r',
          threadId: 't',
          status: 'resolved',
        })
      ).rejects.toMatchObject({ code: 'POLICY_DENIED' })
      expect(fetches).toEqual([])
      expect(socketCalls).toEqual([])
    } finally {
      await runtime.close()
    }
  })
})

describe('path-safe ids and request origins', () => {
  test('refuses ids that could step into another route before any request', async () => {
    const { runtime, fetches } = await createTestRuntime()
    const service = createOverleafService(runtime)
    try {
      await expect(service.stop_compile({ projectId: '../x?' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      await expect(
        service.reply_to_comment({ projectId: 'p', threadId: '../x?', content: 'Hi' })
      ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        details: { parameter: 'threadId' },
      })
      await expect(runtime.comments.replyToComment('p', '../x?', 'Hi')).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
      await expect(runtime.compile.stopCompile('../x?')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      expect(fetches).toEqual([])
    } finally {
      await runtime.close()
    }
  })

  test('never sends a request to another origin, and never follows a redirect for a mutation', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe(init?.method === 'GET' ? 'follow' : 'manual')
      return new Response(null, { status: 302, headers: { location: 'https://other.example/steal' } })
    })
    const client = new OverleafHttpClient({
      baseUrl: 'https://overleaf.test',
      jar: new CookieJar(),
      fetcher,
      csrfToken: () => 'csrf',
    })

    await expect(client.request('POST', 'https://other.example/x')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { kind: 'cross_origin' },
    })
    await expect(client.request('GET', '//other.example/x')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(fetcher).not.toHaveBeenCalled()

    await expect(client.postJson('/project/p/rename', { newProjectName: 'x' })).rejects.toMatchObject({
      code: 'REMOTE_ERROR',
      details: { status: 302 },
    })
    expect(fetcher).toHaveBeenCalledTimes(1)

    fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/login' } }))
    await expect(client.postJson('/project/p/rename', {})).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
  })
})
