import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { exitCodeForError } from '../../src/cli/exit-codes.js'
import { McpError } from '../../src/core/errors.js'
import { AccessPolicy } from '../../src/core/policy.js'
import { ProjectsApi } from '../../src/overleaf/projects.js'
import type { ProjectEntity, ProjectTree } from '../../src/overleaf/tree.js'

const rootDoc: ProjectEntity = {
  id: 'doc',
  name: 'main.tex',
  path: 'main.tex',
  type: 'doc',
  parentFolderId: 'root',
}

function harness(overrides: { name?: string; trashed?: boolean; archived?: boolean; policy?: AccessPolicy } = {}) {
  const calls: string[] = []
  const http = {
    postJson: vi.fn(async () => ({ project_id: 'new' })),
    deleteJson: vi.fn(async () => ({})),
    postForm: vi.fn(async () => ({ project_id: 'imported' })),
    getStream: vi.fn(async (): Promise<{ body: ReadableStream<Uint8Array>; contentType?: string }> => ({
      body: new Response(new Uint8Array()).body!,
    })),
  }
  const tree: ProjectTree = {
    entities: [rootDoc],
    rootDocPath: 'main.tex',
    compiler: 'pdflatex',
    imageName: 'texlive-full:2024.1',
    spellCheckLanguage: 'en',
    trackChangesActive: false,
    hashNote: '',
  }
  const options = {
    http,
    baseUrl: 'https://overleaf.test',
    findProject: vi.fn(async () => ({
      name: overrides.name ?? 'Paper',
      trashed: overrides.trashed ?? false,
      archived: overrides.archived ?? false,
    })),
    resolvePath: vi.fn(async () => rootDoc),
    getProjectTree: vi.fn(async () => {
      calls.push('tree')
      return tree
    }),
    invalidate: vi.fn(async () => {
      calls.push('invalidate')
    }),
    policy: overrides.policy,
  }
  return { api: new ProjectsApi(options), http, options, calls }
}

describe('projects API', () => {
  test('creates a blank project and reports its stub root from a real tree read', async () => {
    const { api, http, options } = harness()

    await expect(api.createProject('Thesis')).resolves.toEqual({
      projectId: 'new',
      name: 'Thesis',
      url: 'https://overleaf.test/project/new',
      rootDocPath: 'main.tex',
    })
    expect(http.postJson).toHaveBeenCalledWith('/project/new', { projectName: 'Thesis', template: 'none' })
    expect(options.getProjectTree).toHaveBeenCalledWith('new')
  })

  test('passes the example template through and rejects bad names before any request', async () => {
    const { api, http } = harness()

    await api.createProject('Example', 'example')
    expect(http.postJson).toHaveBeenCalledWith('/project/new', { projectName: 'Example', template: 'example' })

    await expect(api.createProject('a/b')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(api.createProject(' ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(http.postJson).toHaveBeenCalledTimes(1)
  })

  test('hands back the new projectId when the tree cannot be read after creation', async () => {
    const { api, options } = harness()
    options.getProjectTree.mockRejectedValue(new McpError('TIMEOUT', 'slow'))

    await expect(api.createProject('Thesis')).rejects.toMatchObject({
      code: 'REMOTE_ERROR',
      details: { projectId: 'new' },
    })
  })

  test('reports an unexpected creation response as PROTOCOL_UNSUPPORTED', async () => {
    const { api, http } = harness()
    http.postJson.mockResolvedValue({} as never)

    await expect(api.createProject('Thesis')).rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' })
  })

  test('clones a project through the capitalised route', async () => {
    const { api, http } = harness()

    await expect(api.cloneProject('source', 'Copy')).resolves.toEqual({
      projectId: 'new',
      name: 'Copy',
      url: 'https://overleaf.test/project/new',
    })
    expect(http.postJson).toHaveBeenCalledWith('/Project/source/clone', { projectName: 'Copy' })
  })

  describe('zip import', () => {
    test('uploads the archive as multipart with the project name defaulting to the file name', async () => {
      const { api, http, options } = harness({ name: 'My Paper' })
      const dir = await mkdtemp(join(tmpdir(), 'olzip-'))
      const zipPath = join(dir, 'My Paper.zip')
      await writeFile(zipPath, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))

      await expect(api.importProjectZip(zipPath)).resolves.toEqual({
        projectId: 'imported',
        name: 'My Paper',
        url: 'https://overleaf.test/project/imported',
      })
      const [path, form] = http.postForm.mock.calls[0] as unknown as [string, FormData]
      expect(path).toBe('/project/new/upload')
      expect(form.get('name')).toBe('My Paper')
      expect((form.get('qqfile') as File).name).toBe('My Paper.zip')
      expect(options.findProject).toHaveBeenCalledWith('imported')
    })

    test('reports the name Overleaf stored, which may come from the root document title', async () => {
      const { api } = harness({ name: 'A Study of Things (1)' })
      const dir = await mkdtemp(join(tmpdir(), 'olzip-'))
      const zipPath = join(dir, 'paper.zip')
      await writeFile(zipPath, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))

      await expect(api.importProjectZip(zipPath, 'Requested')).resolves.toMatchObject({
        projectId: 'imported',
        name: 'A Study of Things (1)',
      })
    })

    test('hands back the new projectId when the stored name cannot be read after the import', async () => {
      const { api, options, http } = harness()
      const dir = await mkdtemp(join(tmpdir(), 'olzip-'))
      const zipPath = join(dir, 'paper.zip')
      await writeFile(zipPath, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))

      // The read-back's own code is kept, but the import has happened, so it is never retryable.
      options.findProject.mockRejectedValueOnce(new McpError('TIMEOUT', 'slow', { retryable: true }))
      await expect(api.importProjectZip(zipPath)).rejects.toMatchObject({
        code: 'TIMEOUT',
        retryable: false,
        message: expect.stringMatching(/was imported/u),
        details: { projectId: 'imported' },
      })
      options.findProject.mockRejectedValueOnce(
        new McpError('AUTH_EXPIRED', 'signed out', { details: { reason: 'session' } })
      )
      await expect(api.importProjectZip(zipPath)).rejects.toMatchObject({
        code: 'AUTH_EXPIRED',
        retryable: false,
        details: { reason: 'session', projectId: 'imported' },
      })
      // This tool's NOT_FOUND and RATE_LIMITED say nothing was created, so they are not kept.
      for (const cause of [
        new Error('socket hang up'),
        new McpError('NOT_FOUND', 'missing'),
        new McpError('RATE_LIMITED', 'Wait before retrying.', { retryable: true, details: { retryAfterMs: 5 } }),
      ]) {
        options.findProject.mockRejectedValueOnce(cause)
        const error = await api.importProjectZip(zipPath).catch((caught: unknown) => caught)
        expect(error).toMatchObject({ code: 'REMOTE_ERROR', retryable: false })
        expect((error as McpError).details).toEqual({ projectId: 'imported' })
        expect((error as McpError).message).not.toMatch(/socket hang up|missing|retrying/u)
      }
      expect(http.postForm).toHaveBeenCalledTimes(5)
    })

    test('refuses an import whose name read-back the policy forbids, before uploading', async () => {
      const policy = await AccessPolicy.create({ allowedEffects: ['project-lifecycle', 'local-read'] })
      const { api, http } = harness({ policy })
      const dir = await mkdtemp(join(tmpdir(), 'olzip-'))
      const zipPath = join(dir, 'paper.zip')
      await writeFile(zipPath, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))

      await expect(api.importProjectZip(zipPath)).rejects.toMatchObject({
        code: 'POLICY_DENIED',
        details: { effect: 'overleaf-read' },
      })
      expect(http.postForm).not.toHaveBeenCalled()
    })

    test('rejects a non-zip path before reading it and reports a missing file as NOT_FOUND', async () => {
      const { api, http } = harness()

      await expect(api.importProjectZip('/tmp/paper.tar.gz')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      await expect(api.importProjectZip('/nonexistent/paper.zip')).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(http.postForm).not.toHaveBeenCalled()
    })

    test('translates Overleaf rejections and lets rate limits pass through', async () => {
      const { api, http } = harness()
      const dir = await mkdtemp(join(tmpdir(), 'olzip-'))
      const zipPath = join(dir, 'paper.zip')
      await writeFile(zipPath, new Uint8Array([1]))

      http.postForm.mockRejectedValueOnce(
        new McpError('REMOTE_ERROR', 'HTTP 422', { details: { status: 422, overleafError: 'invalid_zip_file' } })
      )
      await expect(api.importProjectZip(zipPath)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        details: { overleafError: 'invalid_zip_file' },
      })

      http.postForm.mockRejectedValueOnce(
        new McpError('RATE_LIMITED', 'slow down', { retryable: true, details: { status: 429, retryAfterMs: 5000 } })
      )
      await expect(api.importProjectZip(zipPath)).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        details: { retryAfterMs: 5000 },
      })

      http.postForm.mockResolvedValueOnce({ success: false, error: 'empty_zip_file' } as never)
      await expect(api.importProjectZip(zipPath)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        details: { overleafError: 'empty_zip_file' },
      })
    })
  })

  describe('manage_project', () => {
    test('renames after validating the name and invalidates the cached connection', async () => {
      const { api, http, options } = harness()

      await expect(api.manageProject('p', { action: 'rename', newName: 'Renamed' })).resolves.toEqual({
        action: 'rename',
        projectId: 'p',
        name: 'Renamed',
      })
      expect(http.postJson).toHaveBeenCalledWith('/project/p/rename', { newProjectName: 'Renamed' })
      expect(options.invalidate).toHaveBeenCalledTimes(1)
    })

    test('refuses trash, archive, and delete when confirmName differs, without touching Overleaf', async () => {
      const { api, http } = harness({ name: 'Paper', trashed: true })

      for (const action of ['trash', 'archive', 'delete'] as const) {
        await expect(api.manageProject('p', { action, confirmName: 'paper' })).rejects.toMatchObject({
          code: 'CONFIRMATION_MISMATCH',
        })
      }
      expect(http.postJson).not.toHaveBeenCalled()
      expect(http.deleteJson).not.toHaveBeenCalled()
    })

    test('trashes, archives, restores, and unarchives through the matching routes', async () => {
      const { api, http } = harness()

      await api.manageProject('p', { action: 'trash', confirmName: 'Paper' })
      expect(http.postJson).toHaveBeenCalledWith('/project/p/trash')
      await api.manageProject('p', { action: 'archive', confirmName: 'Paper' })
      expect(http.postJson).toHaveBeenCalledWith('/Project/p/archive')
      await api.manageProject('p', { action: 'restore' })
      expect(http.deleteJson).toHaveBeenCalledWith('/project/p/trash')
      await api.manageProject('p', { action: 'unarchive' })
      expect(http.deleteJson).toHaveBeenCalledWith('/Project/p/archive')
    })

    test('permanently deletes only a project that is already trashed', async () => {
      const live = harness({ trashed: false })
      await expect(live.api.manageProject('p', { action: 'delete', confirmName: 'Paper' })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
      expect(live.http.deleteJson).not.toHaveBeenCalled()

      const trashed = harness({ trashed: true })
      await expect(trashed.api.manageProject('p', { action: 'delete', confirmName: 'Paper' })).resolves.toEqual({
        action: 'delete',
        projectId: 'p',
        name: 'Paper',
      })
      expect(trashed.http.deleteJson).toHaveBeenCalledWith('/Project/p')
    })

    test('fails with NOT_FOUND for a project the account cannot see', async () => {
      const { api, http, options } = harness()
      options.findProject.mockRejectedValue(new McpError('NOT_FOUND', 'missing'))

      await expect(api.manageProject('p', { action: 'restore' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(http.deleteJson).not.toHaveBeenCalled()
    })
  })

  describe('update_project_settings', () => {
    test('requires at least one setting', async () => {
      const { api, http } = harness()

      await expect(api.updateProjectSettings('p', {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      expect(http.postJson).not.toHaveBeenCalled()
    })

    test('resolves rootFilePath to a document id, posts each given key on its own, and re-reads the project', async () => {
      const { api, http, options, calls } = harness()

      await expect(api.updateProjectSettings('p', { rootFilePath: 'main.tex', compiler: 'xelatex' })).resolves.toEqual({
        projectId: 'p',
        rootDocPath: 'main.tex',
        compiler: 'pdflatex',
        imageName: 'texlive-full:2024.1',
        spellCheckLanguage: 'en',
      })
      expect(options.resolvePath).toHaveBeenCalledWith('p', 'main.tex', 'doc')
      // Overleaf's own order: compiler, imageName, spellCheckLanguage, then the root document.
      expect(http.postJson.mock.calls).toEqual([
        ['/project/p/settings', { compiler: 'xelatex' }],
        ['/project/p/settings', { rootDocId: 'doc' }],
      ])
      // The cached join never learns about settings changes, so the re-read must follow an invalidate.
      expect(calls).toEqual(['invalidate', 'tree'])
    })

    test('names the settings applied before one fails and drops the cached join', async () => {
      const { api, http, options } = harness()
      http.postJson
        .mockResolvedValueOnce({} as never)
        .mockResolvedValueOnce({} as never)
        .mockRejectedValueOnce(
          new McpError('REMOTE_ERROR', 'Overleaf returned HTTP 500.', {
            details: { status: 500, path: '/project/p/settings' },
          })
        )

      const failure = api.updateProjectSettings('p', {
        rootFilePath: 'main.tex',
        compiler: 'lualatex',
        imageName: 'texlive-full:2025.1',
        spellCheckLanguage: 'fr',
      })
      await expect(failure).rejects.toMatchObject({
        code: 'REMOTE_ERROR',
        retryable: false,
        details: {
          status: 500,
          path: '/project/p/settings',
          applied: ['compiler', 'imageName'],
          failed: 'spellCheckLanguage',
        },
      })
      // Nothing after the failed setting is sent.
      expect(http.postJson).toHaveBeenCalledTimes(3)
      expect(options.invalidate).toHaveBeenCalledTimes(1)
      expect(options.getProjectTree).not.toHaveBeenCalled()
    })

    test('says every setting was stored when only reading them back fails', async () => {
      const { api, http, options } = harness()
      options.getProjectTree.mockRejectedValueOnce(
        new McpError('TRANSIENT_FAILURE', 'join kept failing', {
          retryable: true,
          details: { attempts: 3, lastCode: 'REMOTE_ERROR', event: 'joinProject' },
        })
      )

      const failure = await api.updateProjectSettings('p', { compiler: 'xelatex', spellCheckLanguage: 'fr' }).then(
        () => {
          throw new Error('expected a failure')
        },
        (error: unknown) => error as McpError
      )
      expect(failure).toMatchObject({
        code: 'TRANSIENT_FAILURE',
        retryable: false,
        details: { applied: ['compiler', 'spellCheckLanguage'], event: 'joinProject' },
      })
      expect(failure.message).toMatch(/Every setting was stored/u)
      expect(http.postJson).toHaveBeenCalledTimes(2)
      // The command line exits 4: read what is there, never re-run the whole call.
      expect(exitCodeForError(failure, 'update_project_settings')).toBe(4)
    })

    test('keeps the code and retryability of a failure on the first setting', async () => {
      const { api, http, options } = harness()
      http.postJson.mockRejectedValueOnce(new McpError('TIMEOUT', 'slow', { retryable: true }))

      await expect(api.updateProjectSettings('p', { imageName: 'texlive-full:2025.1' })).rejects.toMatchObject({
        code: 'TIMEOUT',
        retryable: true,
        details: { applied: [], failed: 'imageName' },
      })
      expect(options.invalidate).toHaveBeenCalledTimes(1)
    })

    test('refuses a root document Overleaf cannot compile before any request', async () => {
      const { api, http, options } = harness()

      for (const rootFilePath of ['refs.bib', 'chapters/intro.sty', 'README', '.tex']) {
        await expect(api.updateProjectSettings('p', { rootFilePath, compiler: 'xelatex' })).rejects.toMatchObject({
          code: 'INVALID_ARGUMENT',
        })
      }
      expect(options.resolvePath).not.toHaveBeenCalled()
      expect(http.postJson).not.toHaveBeenCalled()

      for (const rootFilePath of ['a.tex', 'b.ltx', 'c.Rtex', 'd.Rnw', 'E.TEX', 'sub/f.rnw']) {
        await api.updateProjectSettings('p', { rootFilePath })
      }
      expect(options.resolvePath).toHaveBeenCalledTimes(6)
    })

    test('sends an empty spellCheckLanguage to turn spell checking off', async () => {
      const { api, http } = harness()

      await api.updateProjectSettings('p', { spellCheckLanguage: '' })
      expect(http.postJson).toHaveBeenCalledWith('/project/p/settings', { spellCheckLanguage: '' })
    })
  })
})

describe('download_project_zip', () => {
  /** A zip end-of-central-directory record, with an optional trailing comment. */
  function endRecord(comment = ''): Uint8Array {
    const text = new TextEncoder().encode(comment)
    const record = new Uint8Array(22 + text.byteLength)
    record.set([0x50, 0x4b, 0x05, 0x06])
    record[20] = text.byteLength & 0xff
    record[21] = text.byteLength >> 8
    record.set(text, 22)
    return record
  }
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9, ...endRecord()])

  function streamOf(chunks: Uint8Array[], failWith?: unknown): ReadableStream<Uint8Array> {
    let index = 0
    return new ReadableStream({
      pull(controller) {
        const chunk = chunks[index++]
        if (chunk !== undefined) controller.enqueue(chunk)
        else if (failWith !== undefined) controller.error(failWith)
        else controller.close()
      },
    })
  }

  async function folder(): Promise<string> {
    return await mkdtemp(join(tmpdir(), 'overleaf-zip-'))
  }

  test('streams the archive into a new local file and leaves no temporary file behind', async () => {
    const { api, http } = harness()
    // Split inside the signature, so the check must join chunks before deciding.
    http.getStream.mockResolvedValueOnce({
      body: streamOf([zip.slice(0, 2), zip.slice(2)]),
      contentType: 'application/zip',
    })
    const dir = await folder()

    // An id that could step into another route is refused before anything is sent.
    await expect(api.downloadProjectZip('p/1', join(dir, 'backup.zip'))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { parameter: 'projectId' },
    })
    expect(http.getStream).not.toHaveBeenCalled()

    await expect(api.downloadProjectZip('p 1', join(dir, 'backup.zip'))).resolves.toEqual({
      projectId: 'p 1',
      localPath: join(dir, 'backup.zip'),
      bytes: zip.byteLength,
      replaced: false,
    })
    expect(http.getStream).toHaveBeenCalledWith('/Project/p%201/download/zip', { timeoutMs: 300_000 })
    expect(new Uint8Array(await readFile(join(dir, 'backup.zip')))).toEqual(zip)
    expect(await readdir(dir)).toEqual(['backup.zip'])

    // A name near the file-system limit still fits, since the temporary name does not repeat it.
    const long = `${'a'.repeat(240)}.zip`
    http.getStream.mockResolvedValueOnce({ body: streamOf([zip]) })
    await expect(api.downloadProjectZip('p', join(dir, long))).resolves.toMatchObject({ bytes: zip.byteLength })
  })

  test('removes the temporary file when the request itself fails', async () => {
    const { api, http } = harness()
    const dir = await folder()
    http.getStream.mockRejectedValueOnce(new McpError('RATE_LIMITED', 'Overleaf rate-limited this request.'))

    await expect(api.downloadProjectZip('p', join(dir, 'backup.zip'))).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(await readdir(dir)).toEqual([])
  })

  test('refuses an existing file without overwrite before any request, and replaces it with overwrite', async () => {
    const { api, http } = harness()
    const dir = await folder()
    const path = join(dir, 'backup.zip')
    await writeFile(path, 'previous')

    await expect(api.downloadProjectZip('p', path)).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
    expect(http.getStream).not.toHaveBeenCalled()
    expect(await readFile(path, 'utf8')).toBe('previous')

    http.getStream.mockResolvedValueOnce({ body: streamOf([zip]) })
    await expect(api.downloadProjectZip('p', path, { overwrite: true, timeoutMs: 5_000 })).resolves.toMatchObject({
      replaced: true,
      bytes: zip.byteLength,
    })
    expect(http.getStream).toHaveBeenCalledWith('/Project/p/download/zip', { timeoutMs: 5_000 })
    expect(new Uint8Array(await readFile(path))).toEqual(zip)
  })

  test('checks the local destination before any request', async () => {
    const { api, http } = harness()
    const dir = await folder()

    // A folder that cannot be written fails before the rate-limited request is spent.
    const locked = join(dir, 'locked')
    await mkdir(locked)
    await chmod(locked, 0o555)
    try {
      await expect(api.downloadProjectZip('p', join(locked, 'backup.zip'))).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        details: { errno: expect.stringMatching(/^E/u) },
      })
    } finally {
      await chmod(locked, 0o755)
    }

    await expect(api.downloadProjectZip('p', join(dir, 'missing', 'backup.zip'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(api.downloadProjectZip('p', dir, { overwrite: true })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(http.getStream).not.toHaveBeenCalled()
  })

  test('refuses a body that is not a zip archive without quoting it, and keeps the old file', async () => {
    const { api, http } = harness()
    const dir = await folder()
    const path = join(dir, 'backup.zip')
    await writeFile(path, 'previous')
    http.getStream.mockResolvedValueOnce({
      body: streamOf([new TextEncoder().encode('<!DOCTYPE html><p>SENTINEL</p>')]),
      contentType: 'text/html; charset=utf-8',
    })

    const error = await api.downloadProjectZip('p', path, { overwrite: true }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'PROTOCOL_UNSUPPORTED', details: { contentType: 'text/html' } })
    expect(JSON.stringify((error as McpError).toJSON())).not.toMatch(/SENTINEL|DOCTYPE/u)
    expect(await readFile(path, 'utf8')).toBe('previous')
    expect(await readdir(dir)).toEqual(['backup.zip'])

    http.getStream.mockResolvedValueOnce({
      body: streamOf([new Uint8Array([0x7b])]),
      contentType: 'SENTINEL free text',
    })
    const other = await api.downloadProjectZip('p', join(dir, 'other.zip')).catch((caught: unknown) => caught)
    expect(other).toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' })
    expect((other as McpError).details).toBeUndefined()
    expect(await readdir(dir)).toEqual(['backup.zip'])

    // A body that stops inside the signature, or before it, is a transfer cut short.
    for (const body of [new Uint8Array(0), new Uint8Array([0x50]), new Uint8Array([0x50, 0x4b, 0x05])]) {
      http.getStream.mockResolvedValueOnce({ body: streamOf(body.byteLength === 0 ? [] : [body]) })
      await expect(api.downloadProjectZip('p', join(dir, 'short.zip'))).rejects.toMatchObject({
        code: 'REMOTE_ERROR',
        retryable: true,
      })
    }
    expect(await readdir(dir)).toEqual(['backup.zip'])
  })

  test('refuses an archive cut short, and accepts an empty archive or one with a comment', async () => {
    const { api, http } = harness()
    const dir = await folder()
    const path = join(dir, 'backup.zip')
    await writeFile(path, 'previous')
    http.getStream.mockResolvedValueOnce({ body: streamOf([zip.slice(0, zip.byteLength - 5)]) })

    await expect(api.downloadProjectZip('p', path, { overwrite: true })).rejects.toMatchObject({
      code: 'REMOTE_ERROR',
      retryable: true,
    })
    expect(await readFile(path, 'utf8')).toBe('previous')
    expect(await readdir(dir)).toEqual(['backup.zip'])

    // A long archive arrives in many chunks; only its last bytes decide whether it is complete.
    const long = new Uint8Array(200_000)
    long.set([0x50, 0x4b, 0x03, 0x04])
    const chunks = [long.subarray(0, 70_000), long.subarray(70_000), endRecord('made by Overleaf')]
    http.getStream.mockResolvedValueOnce({ body: streamOf(chunks) })
    await expect(api.downloadProjectZip('p', join(dir, 'long.zip'))).resolves.toMatchObject({
      bytes: 200_000 + 22 + 16,
    })

    http.getStream.mockResolvedValueOnce({ body: streamOf([endRecord()]) })
    await expect(api.downloadProjectZip('p', join(dir, 'empty.zip'))).resolves.toMatchObject({ bytes: 22 })
  })

  test('a download that times out midway writes nothing and leaves the old file intact', async () => {
    const { api, http } = harness()
    const dir = await folder()
    const path = join(dir, 'backup.zip')
    await writeFile(path, 'previous')
    http.getStream.mockResolvedValueOnce({
      body: streamOf([zip], new DOMException('The operation timed out.', 'TimeoutError')),
    })

    await expect(api.downloadProjectZip('p', path, { overwrite: true })).rejects.toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
    })
    expect(await readFile(path, 'utf8')).toBe('previous')
    expect(await readdir(dir)).toEqual(['backup.zip'])
  })

  test('does not replace a file that appeared during the download', async () => {
    const { api, http } = harness()
    const dir = await folder()
    const path = join(dir, 'backup.zip')
    http.getStream.mockImplementationOnce(async () => {
      await writeFile(path, 'appeared')
      return { body: streamOf([zip]) }
    })

    await expect(api.downloadProjectZip('p', path)).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
    expect(await readFile(path, 'utf8')).toBe('appeared')
    expect(await readdir(dir)).toEqual(['backup.zip'])
  })
})
