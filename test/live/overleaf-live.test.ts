import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { readConfig } from '../../src/config.js'
import { McpError } from '../../src/core/errors.js'
import { OverleafRuntime } from '../../src/runtime.js'
import { createOverleafService } from '../../src/service/operations.js'
import type { HistorySnapshot } from '../../src/protocol/ot.js'
import { resolveProjectPath } from '../../src/overleaf/tree.js'

const enabled = process.env.RUN_OVERLEAF_LIVE_TESTS === '1'

describe.skipIf(!enabled)('disposable Overleaf live project', () => {
  let runtime: OverleafRuntime
  let projectId: string

  beforeAll(async () => {
    projectId = process.env.OVERLEAF_LIVE_TEST_PROJECT_ID ?? ''
    if (!projectId) {
      throw new McpError(
        'INVALID_ARGUMENT',
        'OVERLEAF_LIVE_TEST_PROJECT_ID is required when RUN_OVERLEAF_LIVE_TESTS=1.'
      )
    }
    runtime = await OverleafRuntime.create(readConfig())
  })

  afterAll(async () => {
    await runtime?.close()
  })

  test('authenticates and joins the configured disposable project', async () => {
    await expect(runtime.authStatus()).resolves.toMatchObject({ authenticated: true })
    const tree = await runtime.entities.getProjectTree(projectId)
    expect(Array.isArray(tree.entities)).toBe(true)
    expect(tree.hashNote).toMatch(/git blob hash/u)
  })

  test.skipIf(process.env.RUN_OVERLEAF_LIVE_REVIEW_TESTS !== '1')(
    'reads review threads without mutating them when the deployment supports comments',
    async () => {
      const result = await runtime.comments.listComments(projectId, { status: 'all' })
      expect(Array.isArray(result.threads)).toBe(true)
    }
  )

  test.skipIf(process.env.RUN_OVERLEAF_LIVE_TRACKED_WRITE_TESTS !== '1')(
    'creates and verifies disposable tracked initial content',
    async () => {
      const filePath = `mcp-tracked-${Date.now()}.tex`
      try {
        const written = await runtime.createFile(
          projectId,
          filePath,
          '\\section{Tracked}\nDisposable live-test content.\n',
          'tracked'
        )
        expect(written).toMatchObject({ writeMode: 'tracked' })
        await expect(runtime.documents.readFile(projectId, filePath)).resolves.toMatchObject({
          content: '\\section{Tracked}\nDisposable live-test content.\n',
        })
        const trackingObserved = await runtime.connections.withConnection(
          projectId,
          async connection =>
            await connection.queue.run(async () => {
              const entity = resolveProjectPath(connection.getTree(), filePath, 'doc')
              const document = await connection.joinDocument(entity.id)
              try {
                if (document.protocol === 'history-ot') {
                  const snapshot = document.rawSnapshot as HistorySnapshot
                  return (
                    snapshot.trackedChanges?.some(
                      change => change.tracking.type === 'insert' && change.tracking.userId === runtime.userId
                    ) ?? false
                  )
                }
                const changes = (document.ranges as { changes?: unknown[] } | undefined)?.changes ?? []
                return changes.length > 0 && JSON.stringify(changes).includes(runtime.userId ?? '')
              } finally {
                await connection.leaveDocument(entity.id)
              }
            })
        )
        expect(trackingObserved).toBe(true)
      } finally {
        const tree = await runtime.entities.getProjectTree(projectId)
        if (tree.entities.some(entity => entity.path === filePath)) {
          await runtime.entities.manageEntity(projectId, {
            action: 'delete',
            path: filePath,
            confirmPath: filePath,
          })
        }
      }
    }
  )

  test.skipIf(process.env.RUN_OVERLEAF_LIVE_HISTORY_TESTS !== '1')(
    'reads recent project history without mutation',
    async () => {
      const result = await runtime.history.monitorProjectHistory(projectId)
      expect(result.projectId).toBe(projectId)
      expect(Array.isArray(result.updates)).toBe(true)
      if (result.updates[0]) {
        expect(Number.isInteger(result.updates[0].fromVersion)).toBe(true)
        expect(Number.isInteger(result.updates[0].toVersion)).toBe(true)
        expect(new Date(result.updates[0].startedAt).toISOString()).toBe(result.updates[0].startedAt)
        expect(new Date(result.updates[0].endedAt).toISOString()).toBe(result.updates[0].endedAt)
        expect(JSON.stringify(result.updates[0])).not.toContain('"email"')
      }
    }
  )

  test.skipIf(process.env.RUN_OVERLEAF_LIVE_TAG_TESTS !== '1')(
    'creates a throwaway tag, files the project in it, edits it, and deletes it again',
    async () => {
      const service = createOverleafService(runtime)
      const name = `mcp-tag-${Date.now()}`
      let tagId: string | undefined
      try {
        const created = await service.manage_tags({ action: 'create', name, color: '#336699' })
        tagId = created.tag.id
        expect(created).toMatchObject({
          verified: true,
          deleted: false,
          tag: { name, color: '#336699', projectIds: [] },
        })

        const listed = await service.list_projects({
          includeArchived: true,
          includeTrashed: true,
          includeTags: true,
          limit: 200,
          sort: 'lastUpdated',
        })
        expect(listed.tags).toContainEqual({ id: tagId, name, color: '#336699', projectCount: 0 })

        const added = await service.manage_tags({ action: 'add_projects', tagId, projectIds: [projectId] })
        expect(added).toMatchObject({ verified: true, tag: { projectIds: [projectId] } })
        const inTag = await service.list_projects({
          includeArchived: true,
          includeTrashed: true,
          includeTags: true,
          tag: name,
          limit: 200,
          sort: 'lastUpdated',
        })
        expect(inTag.projects.map(project => project.id)).toEqual([projectId])
        expect(inTag.projects[0]?.tags).toContainEqual({ id: tagId, name })

        const renamed = `${name}-renamed`
        const edited = await service.manage_tags({ action: 'edit', tagId, name: renamed, color: 'hsl(120, 70%, 45%)' })
        expect(edited).toMatchObject({ verified: true, tag: { name: renamed, color: 'hsl(120, 70%, 45%)' } })

        const removed = await service.manage_tags({ action: 'remove_projects', tagId, projectIds: [projectId] })
        expect(removed).toMatchObject({ verified: true, tag: { projectIds: [] } })

        await expect(service.manage_tags({ action: 'delete', tagId, confirmName: name })).rejects.toMatchObject({
          code: 'CONFIRMATION_MISMATCH',
        })
        const deleted = await service.manage_tags({ action: 'delete', tagId, confirmName: renamed })
        expect(deleted).toMatchObject({ verified: true, deleted: true })
        tagId = undefined
      } finally {
        // A failed run leaves no tag behind: the tag is this test's own, never one the account had.
        if (tagId !== undefined) {
          const left = (await runtime.tags.listTags()).find(tag => tag.id === tagId)
          if (left !== undefined) {
            await runtime.tags.manageTags({ action: 'delete', tagId, confirmName: left.name })
          }
        }
      }
    },
    120_000
  )
})

describe.skipIf(!enabled || process.env.RUN_OVERLEAF_LIVE_LIFECYCLE_TESTS !== '1')(
  'disposable Overleaf project lifecycle',
  () => {
    let runtime: OverleafRuntime

    beforeAll(async () => {
      runtime = await OverleafRuntime.create(readConfig())
    })

    afterAll(async () => {
      await runtime?.close()
    })

    test('creates, configures, compiles, and trashes a project without the web UI', async () => {
      const name = `mcp-lifecycle-${Date.now()}`
      const created = await runtime.projects.createProject(name, 'blank')
      try {
        expect(created.rootDocPath).toBe('main.tex')

        // The dashboard endpoint must return every project, or listing and counting would lie.
        const fetched = await runtime.account.fetchProjects()
        expect(fetched.projects).toHaveLength(fetched.totalSize)
        const listing = await runtime.account.listProjects({ query: name })
        expect(listing.projects.map(project => project.id)).toContain(created.projectId)

        await runtime.createFile(
          created.projectId,
          'paper.tex',
          '\\documentclass{article}\n\\begin{document}\nDisposable lifecycle test.\n\\end{document}\n'
        )
        const settings = await runtime.projects.updateProjectSettings(created.projectId, {
          rootFilePath: 'paper.tex',
        })
        expect(settings.rootDocPath).toBe('paper.tex')
        const compiled = await runtime.compile.compileProject(created.projectId)
        expect(compiled).toMatchObject({ status: 'success', rootFilePath: 'paper.tex' })
        expect(compiled.summary).toMatchObject({ builtCleanly: true, errorCount: 0, pageCount: 1 })
        const output = await mkdtemp(join(tmpdir(), 'overleaf-live-compile-'))
        try {
          const pdf = await runtime.compile.downloadCompileOutput(created.projectId, join(output, 'paper.pdf'))
          expect(pdf.sizeBytes).toBeGreaterThan(0)
          expect((await readFile(pdf.localPath)).subarray(0, 5).toString('latin1')).toBe('%PDF-')
          const log = await runtime.compile.getCompileLog(created.projectId, { buildRef: compiled.buildRef, tail: 5 })
          expect(log.errorLines).toEqual([])
        } finally {
          await rm(output, { recursive: true })
        }

        // A deliberate undefined command still yields a PDF and status success, but not a clean build.
        await runtime.createFile(
          created.projectId,
          'broken.tex',
          '\\documentclass{article}\n\\begin{document}\n\\undefinedcommand Disposable lifecycle test.\n\\end{document}\n'
        )
        // Overleaf refuses a compile within a second of the last one.
        await new Promise(resolve => setTimeout(resolve, 1_500))
        const broken = await runtime.compile.compileProject(created.projectId, 'broken.tex')
        expect(broken.status).toBe('success')
        expect(broken.summary.builtCleanly).toBe(false)
        expect(broken.summary.errorCount).toBeGreaterThanOrEqual(1)
        expect(broken.summary.errors[0]).toMatchObject({ file: 'broken.tex', line: 3 })
      } finally {
        // Trash, never delete: a failed assertion must leave something a human can inspect.
        await runtime.projects.manageProject(created.projectId, { action: 'trash', confirmName: name })
        await expect(runtime.account.findProject(created.projectId)).resolves.toMatchObject({
          trashed: true,
        })
      }
    }, 120_000)
  }
)

describe.skipIf(!enabled || process.env.RUN_OVERLEAF_LIVE_SYNC_TESTS !== '1')('disposable Overleaf folder sync', () => {
  let runtime: OverleafRuntime

  beforeAll(async () => {
    runtime = await OverleafRuntime.create(readConfig())
  })

  afterAll(async () => {
    await runtime?.close()
  })

  test('plans, mirrors, and re-plans a local folder into a throwaway project', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'overleaf-live-sync-'))
    await mkdir(join(folder, 'sections'))
    await writeFile(
      join(folder, 'main.tex'),
      '\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n'
    )
    await writeFile(join(folder, 'sections', 'intro.tex'), 'Disposable sync test.\n')
    await writeFile(join(folder, 'main.aux'), 'ignored build output\n')

    const name = `mcp-sync-${Date.now()}`
    const created = await runtime.projects.createProject(name, 'blank')
    try {
      const plan = await runtime.sync.planSync(created.projectId, folder)
      expect(plan.ignored.entries.map(entry => entry.localPath)).toContain('main.aux')
      expect(plan.toUpload.map(entry => entry.destinationPath)).toEqual(['main.tex', 'sections/intro.tex'])

      const result = await runtime.sync.syncDirectory(created.projectId, folder, {
        mode: 'mirror',
        planToken: plan.planToken,
        confirmDeleteCount: plan.remoteOnly.length,
      })
      expect(result.status).toBe('complete')

      const again = await runtime.sync.planSync(created.projectId, folder)
      expect(again.toUpload).toEqual([])
      expect(again.remoteOnly).toEqual([])
      expect(again.identical.count).toBe(2)
    } finally {
      await runtime.projects.manageProject(created.projectId, { action: 'trash', confirmName: name })
      await rm(folder, { recursive: true })
    }
  }, 120_000)

  test('batch-uploads into new folders, skips on request, and downloads the project as a zip', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'overleaf-live-batch-'))
    const figure = join(folder, 'figure.png')
    await writeFile(figure, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))
    await writeFile(join(folder, 'notes.tex'), 'Disposable batch upload test.\n')

    const name = `mcp-batch-${Date.now()}`
    const created = await runtime.projects.createProject(name, 'blank')
    try {
      const files = [
        { localPath: figure, destinationPath: 'figures/new/figure.png' },
        { localPath: join(folder, 'notes.tex'), destinationPath: 'notes.tex' },
      ]
      const uploaded = await runtime.sync.batchUpload(created.projectId, files)
      expect(uploaded).toMatchObject({ status: 'complete', verified: true, failed: [] })
      // A second batch onto the same paths is refused unless onConflict says what to do.
      await expect(runtime.sync.batchUpload(created.projectId, files)).rejects.toMatchObject({
        code: 'CONFIRMATION_MISMATCH',
      })
      expect(uploaded.completed.map(entry => entry.destinationPath)).toEqual([
        'figures',
        'figures/new',
        'figures/new/figure.png',
        'notes.tex',
      ])

      const skipped = await runtime.sync.batchUpload(created.projectId, files, { onConflict: 'skip' })
      expect(skipped.skipped.map(entry => entry.destinationPath)).toEqual(['figures/new/figure.png', 'notes.tex'])
      expect(skipped.completed).toEqual([])

      const zipPath = join(folder, 'backup.zip')
      const downloaded = await runtime.projects.downloadProjectZip(created.projectId, zipPath)
      expect(downloaded.bytes).toBeGreaterThan(0)
      expect((await readFile(zipPath)).subarray(0, 2).toString('latin1')).toBe('PK')
      await expect(runtime.projects.downloadProjectZip(created.projectId, zipPath)).rejects.toMatchObject({
        code: 'CONFIRMATION_MISMATCH',
      })
    } finally {
      await runtime.projects.manageProject(created.projectId, { action: 'trash', confirmName: name })
      await rm(folder, { recursive: true })
    }
  }, 120_000)
})
