import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { McpError } from '../../src/core/errors.js'
import { TOOL_NAMES, registerOverleafTools } from '../../src/mcp/tools.js'

function fakeRuntime() {
  return {
    authStatus: vi.fn(async () => ({
      authenticated: true as const,
      baseUrl: 'https://overleaf.test',
      projectCount: 0,
      permissionsUnchecked: false,
      socketPresenceNotice: 'notice',
    })),
    account: { listProjects: vi.fn() },
    projects: {
      createProject: vi.fn(),
      cloneProject: vi.fn(),
      importProjectZip: vi.fn(),
      downloadProjectZip: vi.fn(),
      manageProject: vi.fn(),
      updateProjectSettings: vi.fn(),
    },
    entities: {
      getProjectTree: vi.fn(),
      manageEntity: vi.fn(),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
    },
    documents: { readFile: vi.fn(), writeFile: vi.fn() },
    createFile: vi.fn(),
    sections: {
      getFullDocument: vi.fn(),
      getSections: vi.fn(),
      getSectionContent: vi.fn(),
      writeSection: vi.fn(),
    },
    compile: {
      compileProject: vi.fn(),
      stopCompile: vi.fn(),
      getCompileLog: vi.fn(),
      downloadCompileOutput: vi.fn(),
      readCompileOutput: vi.fn(),
    },
    comments: {
      listComments: vi.fn(),
      replyToComment: vi.fn(),
      addComment: vi.fn(),
      setCommentStatus: vi.fn(),
    },
    trackedChanges: { listTrackedChanges: vi.fn(), manageTrackedChanges: vi.fn() },
    history: { monitorProjectHistory: vi.fn() },
    sync: { planSync: vi.fn(), syncDirectory: vi.fn(), deleteEntities: vi.fn(), batchUpload: vi.fn() },
    tags: { manageTags: vi.fn() },
  }
}

describe('MCP tool registration', () => {
  test('registers the complete standalone tool surface', () => {
    const registered = new Map<string, { config: any; handler: (...args: any[]) => any }>()
    const server = {
      registerTool: (name: string, config: any, handler: (...args: any[]) => any) => {
        registered.set(name, { config, handler })
      },
    }

    registerOverleafTools(server, fakeRuntime())

    expect([...registered.keys()]).toEqual(TOOL_NAMES)
    expect(registered.get('write_file')?.config.description).toMatch(/tracked/i)
    expect(registered.get('write_section')?.config.description).toMatch(/single file/i)
  })

  test('documents the tool count in the README badge and the docs reference so neither can drift', async () => {
    const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8')
    const reference = await readFile(new URL('../../docs/tools.md', import.meta.url), 'utf8')
    const badge = /alt="(\d+) MCP tools"/u.exec(readme)?.[1]
    const prose = /The server registers (\d+) tools/u.exec(reference)?.[1]

    expect(badge).toBe(String(TOOL_NAMES.length))
    expect(prose).toBe(String(TOOL_NAMES.length))
    // The tool-list sentence and the Documentation table row, plus the comparison's Tools cell.
    const allCounts = [...readme.matchAll(/All (\d+) tools/gu)].map(match => match[1])
    expect(allCounts).toHaveLength(2)
    expect(allCounts).toEqual([String(TOOL_NAMES.length), String(TOOL_NAMES.length)])
    expect(/^\| Tools \| (\d+) \|/mu.exec(readme)?.[1]).toBe(String(TOOL_NAMES.length))
    // The README's tool table must name every registered tool, or it rots like the count would.
    for (const name of TOOL_NAMES) expect(readme).toContain(`| \`${name}\` |`)
  })

  test('returns auth_status as structured content with a declared output schema', async () => {
    const runtime = fakeRuntime()
    const status = {
      authenticated: true as const,
      baseUrl: 'https://overleaf.test',
      projectCount: 2,
      sessionExpiresAt: '2026-09-19T00:00:00.000Z',
      permissionsUnchecked: false,
      socketPresenceNotice: 'notice',
    }
    runtime.authStatus.mockResolvedValue(status)
    const registered = new Map<string, { config: any; handler: (...args: any[]) => any }>()
    registerOverleafTools(
      {
        registerTool: (name: string, config: any, handler: (...args: any[]) => any) => {
          registered.set(name, { config, handler })
        },
      },
      runtime
    )

    const tool = registered.get('auth_status')
    expect(tool?.config.outputSchema.shape).toHaveProperty('sessionExpiresAt')
    expect(tool?.config.annotations).toEqual({ readOnlyHint: true })
    const result = await tool?.handler({})
    expect(result.structuredContent).toEqual(status)
    expect(JSON.parse(result.content[0].text)).toEqual(status)
  })

  test('marks an in-place upload as destructive and lets a compile default its root', () => {
    const registered = new Map<string, { config: any }>()
    registerOverleafTools(
      {
        registerTool: (name: string, config: any) => {
          registered.set(name, { config })
        },
      },
      fakeRuntime()
    )

    // upload_file replaces an existing entity in place, so it must not advertise itself as safe.
    expect(registered.get('upload_file')?.config.annotations).toMatchObject({
      destructiveHint: true,
    })
    expect(registered.get('compile_project')?.config.description).not.toMatch(/rootDoc_id/u)
    const rootFilePathSchema = registered.get('compile_project')?.config.inputSchema.shape.rootFilePath as {
      safeParse: (value: unknown) => { success: boolean }
    }
    expect(rootFilePathSchema.safeParse(undefined).success).toBe(true)
  })

  test('accepts write_file content from disk and refuses ambiguous sources', async () => {
    const runtime = fakeRuntime()
    const registered = new Map<string, (...args: any[]) => any>()
    registerOverleafTools(
      {
        registerTool: (name: string, _config: any, handler: (...args: any[]) => any) => {
          registered.set(name, handler)
        },
      },
      runtime
    )
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-tool-'))
    const localPath = join(directory, 'main.tex')
    await writeFile(localPath, '\\section{From disk}\n')

    await registered.get('write_file')?.({
      projectId: 'project',
      filePath: 'main.tex',
      revision: 'revision',
      localPath,
      writeMode: 'untracked',
    })
    expect(runtime.documents.writeFile).toHaveBeenCalledWith(
      'project',
      'main.tex',
      'revision',
      '\\section{From disk}\n',
      'untracked'
    )

    const ambiguous = await registered.get('write_file')?.({
      projectId: 'project',
      filePath: 'main.tex',
      revision: 'revision',
      content: 'inline',
      localPath,
      writeMode: 'untracked',
    })
    expect(ambiguous).toMatchObject({ isError: true })
    expect(JSON.parse(ambiguous.content[0].text)).toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(runtime.documents.writeFile).toHaveBeenCalledTimes(1)
  })

  test('forwards explicit tracked mode through every text-writing tool', async () => {
    const runtime = fakeRuntime()
    const registered = new Map<string, (...args: any[]) => any>()
    registerOverleafTools(
      {
        registerTool: (name: string, _config: any, handler: (...args: any[]) => any) => {
          registered.set(name, handler)
        },
      },
      runtime
    )

    await registered.get('write_file')?.({
      projectId: 'project',
      filePath: 'main.tex',
      revision: 'revision',
      content: 'content',
      writeMode: 'tracked',
    })
    await registered.get('write_section')?.({
      projectId: 'project',
      filePath: 'main.tex',
      revision: 'revision',
      sectionId: 'section',
      content: 'content',
      writeMode: 'tracked',
    })
    await registered.get('create_file')?.({
      projectId: 'project',
      filePath: 'chapter.tex',
      content: 'content',
      writeMode: 'tracked',
    })

    expect(runtime.documents.writeFile).toHaveBeenCalledWith('project', 'main.tex', 'revision', 'content', 'tracked')
    expect(runtime.sections.writeSection).toHaveBeenCalledWith(
      'project',
      'main.tex',
      'revision',
      'section',
      'content',
      'tracked',
      { followIncludes: undefined }
    )
    expect(runtime.createFile).toHaveBeenCalledWith('project', 'chapter.tex', 'content', 'tracked')
  })

  test('returns structured tool errors without leaking stack traces', async () => {
    const runtime = fakeRuntime()
    runtime.documents.readFile.mockRejectedValue(new McpError('AUTH_EXPIRED', 'Re-export cookies.'))
    const registered = new Map<string, (...args: any[]) => any>()
    registerOverleafTools(
      {
        registerTool: (name: string, _config: any, handler: (...args: any[]) => any) => {
          registered.set(name, handler)
        },
      },
      runtime
    )

    const result = await registered.get('read_file')?.({
      projectId: 'project',
      filePath: 'main.tex',
    })

    expect(result).toMatchObject({ isError: true })
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'AUTH_EXPIRED' })
    expect(result.content[0].text).not.toContain('stack')
  })

  test('forwards list_projects filters and mirrors the listing as structuredContent', async () => {
    const runtime = fakeRuntime()
    const listing = { projects: [], totalMatched: 0, totalProjects: 3 }
    runtime.account.listProjects.mockResolvedValue(listing)
    const registered = new Map<string, { config: any; handler: (...args: any[]) => any }>()
    registerOverleafTools(
      {
        registerTool: (name: string, config: any, handler: (...args: any[]) => any) => {
          registered.set(name, { config, handler })
        },
      },
      runtime
    )

    const tool = registered.get('list_projects')
    expect(tool?.config.annotations).toEqual({ readOnlyHint: true })
    expect(tool?.config.outputSchema.shape).toHaveProperty('projects')
    const result = await tool?.handler({ query: 'thesis', includeTrashed: true, limit: 5, sort: 'name' })
    expect(runtime.account.listProjects).toHaveBeenCalledWith({
      query: 'thesis',
      includeTrashed: true,
      limit: 5,
      sort: 'name',
    })
    expect(result.structuredContent).toEqual(listing)
    expect(JSON.parse(result.content[0].text)).toEqual(listing)
  })

  test('registers the project lifecycle tools with output schemas and the expected annotations', () => {
    const registered = new Map<string, { config: any }>()
    registerOverleafTools(
      {
        registerTool: (name: string, config: any) => {
          registered.set(name, { config })
        },
      },
      fakeRuntime()
    )

    for (const name of ['create_project', 'clone_project', 'import_project_zip']) {
      expect(registered.get(name)?.config.annotations).toEqual({ destructiveHint: false, idempotentHint: false })
      expect(registered.get(name)?.config.outputSchema.shape).toHaveProperty('projectId')
    }
    expect(registered.get('manage_project')?.config.annotations).toEqual({
      destructiveHint: true,
      idempotentHint: false,
    })
    expect(registered.get('manage_project')?.config.description).toMatch(/confirmName/u)
    expect(registered.get('manage_project')?.config.description).toMatch(/trashed/u)
    expect(registered.get('update_project_settings')?.config.annotations).toEqual({
      destructiveHint: false,
      idempotentHint: true,
    })
    expect(registered.get('create_project')?.config.description).toMatch(/main\.tex/u)
  })

  test('refuses manage_project actions with missing companion fields before calling the runtime', async () => {
    const runtime = fakeRuntime()
    runtime.projects.manageProject.mockResolvedValue({ action: 'delete', projectId: 'p', name: 'Paper' })
    const registered = new Map<string, (...args: any[]) => any>()
    registerOverleafTools(
      {
        registerTool: (name: string, _config: any, handler: (...args: any[]) => any) => {
          registered.set(name, handler)
        },
      },
      runtime
    )
    const manage = registered.get('manage_project')!

    const missing = await manage({ projectId: 'p', action: 'trash' })
    expect(missing).toMatchObject({ isError: true })
    expect(JSON.parse(missing.content[0].text)).toMatchObject({ code: 'INVALID_ARGUMENT' })
    const rename = await manage({ projectId: 'p', action: 'rename' })
    expect(JSON.parse(rename.content[0].text)).toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(runtime.projects.manageProject).not.toHaveBeenCalled()

    const deleted = await manage({ projectId: 'p', action: 'delete', confirmName: 'Paper' })
    expect(runtime.projects.manageProject).toHaveBeenCalledWith('p', { action: 'delete', confirmName: 'Paper' })
    expect(deleted.structuredContent).toEqual({ action: 'delete', projectId: 'p', name: 'Paper' })

    await manage({ projectId: 'p', action: 'restore' })
    expect(runtime.projects.manageProject).toHaveBeenCalledWith('p', { action: 'restore' })
  })

  test('shapes each manage_tags action and refuses one with missing fields before calling the runtime', async () => {
    const runtime = fakeRuntime()
    runtime.tags.manageTags.mockResolvedValue({
      action: 'delete',
      tag: { id: 't', name: 'Thesis', projectIds: [] },
      deleted: true,
      verified: true,
    })
    const registered = new Map<string, (...args: any[]) => any>()
    registerOverleafTools(
      {
        registerTool: (name: string, _config: any, handler: (...args: any[]) => any) => {
          registered.set(name, handler)
        },
      },
      runtime
    )
    const manage = registered.get('manage_tags')!

    for (const input of [
      { action: 'create' },
      { action: 'delete', tagId: 't' },
      { action: 'add_projects', tagId: 't' },
      { action: 'edit', name: 'No id' },
    ]) {
      const missing = await manage(input)
      expect(JSON.parse(missing.content[0].text), input.action).toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    expect(runtime.tags.manageTags).not.toHaveBeenCalled()

    const deleted = await manage({ action: 'delete', tagId: 't', confirmName: 'Thesis', name: 'ignored' })
    expect(runtime.tags.manageTags).toHaveBeenLastCalledWith({ action: 'delete', tagId: 't', confirmName: 'Thesis' })
    expect(deleted.structuredContent).toMatchObject({ action: 'delete', deleted: true })
    await manage({ action: 'remove_projects', tagId: 't', projectIds: ['p'] })
    expect(runtime.tags.manageTags).toHaveBeenLastCalledWith({
      action: 'remove_projects',
      tagId: 't',
      projectIds: ['p'],
    })
    await manage({ action: 'create', name: 'Grant', color: '#000000' })
    expect(runtime.tags.manageTags).toHaveBeenLastCalledWith({ action: 'create', name: 'Grant', color: '#000000' })
  })

  test('forwards every project setting and the creation arguments unchanged', async () => {
    const runtime = fakeRuntime()
    runtime.projects.updateProjectSettings.mockResolvedValue({ projectId: 'p', rootDocPath: 'paper.tex' })
    runtime.projects.createProject.mockResolvedValue({ projectId: 'n', name: 'New', url: 'u' })
    runtime.projects.importProjectZip.mockResolvedValue({ projectId: 'z', name: 'Zip', url: 'u' })
    const registered = new Map<string, (...args: any[]) => any>()
    registerOverleafTools(
      {
        registerTool: (name: string, _config: any, handler: (...args: any[]) => any) => {
          registered.set(name, handler)
        },
      },
      runtime
    )

    const settings = await registered.get('update_project_settings')!({
      projectId: 'p',
      rootFilePath: 'paper.tex',
      compiler: 'xelatex',
      imageName: 'texlive-full:2024.1',
      spellCheckLanguage: 'de',
    })
    expect(runtime.projects.updateProjectSettings).toHaveBeenCalledWith('p', {
      rootFilePath: 'paper.tex',
      compiler: 'xelatex',
      imageName: 'texlive-full:2024.1',
      spellCheckLanguage: 'de',
    })
    expect(settings.structuredContent).toEqual({ projectId: 'p', rootDocPath: 'paper.tex' })

    await registered.get('create_project')!({ name: 'New', template: 'example' })
    expect(runtime.projects.createProject).toHaveBeenCalledWith('New', 'example')
    await registered.get('import_project_zip')!({ localZipPath: '/tmp/x.zip' })
    expect(runtime.projects.importProjectZip).toHaveBeenCalledWith('/tmp/x.zip', undefined)
    await registered.get('clone_project')!({ sourceProjectId: 's', name: 'Copy' })
    expect(runtime.projects.cloneProject).toHaveBeenCalledWith('s', 'Copy')
  })

  test('registers the sync tools with output schemas and the expected annotations', () => {
    const registered = new Map<string, { config: any }>()
    registerOverleafTools(
      {
        registerTool: (name: string, config: any) => {
          registered.set(name, { config })
        },
      },
      fakeRuntime()
    )

    expect(registered.get('plan_sync')?.config.annotations).toEqual({ readOnlyHint: true })
    expect(registered.get('sync_directory')?.config.annotations).toEqual({
      destructiveHint: true,
      idempotentHint: true,
    })
    expect(registered.get('delete_entities')?.config.annotations).toEqual({
      destructiveHint: true,
      idempotentHint: false,
    })
    for (const name of ['plan_sync', 'sync_directory', 'delete_entities']) {
      expect(registered.get(name)?.config.outputSchema).toBeDefined()
    }
    // The safety contract has to be readable from the descriptions alone.
    const sync = registered.get('sync_directory')?.config.description as string
    for (const term of [
      'plan_sync',
      'planToken',
      'REMOTE_DRIFT',
      'REVISION_CONFLICT',
      'confirmDeleteCount',
      'CONFIRMATION_MISMATCH',
      'never after any upload or write failed',
    ]) {
      expect(sync).toContain(term)
    }
    expect(registered.get('plan_sync')?.config.description).toMatch(/changing nothing/u)
    expect(registered.get('plan_sync')?.config.description).toMatch(/PATH_OUTSIDE_ROOT/u)
    expect(registered.get('delete_entities')?.config.description).toMatch(/confirmCount/u)
    const mode = registered.get('sync_directory')?.config.inputSchema.shape.mode as {
      safeParse: (value: unknown) => { success: boolean }
    }
    // The mode is always chosen explicitly; there is no default that could delete.
    expect(mode.safeParse(undefined).success).toBe(false)
  })

  test('forwards sync arguments and reports progress only when the client asked for it', async () => {
    const runtime = fakeRuntime()
    const result = {
      status: 'complete',
      mode: 'mirror',
      completed: [],
      failed: [],
      remaining: [],
      identicalCount: 0,
    }
    runtime.sync.syncDirectory.mockImplementation(
      async (
        _id: string,
        _path: string,
        options: {
          onProgress?: (progress: number, total: number, message: string) => Promise<void>
        }
      ) => {
        await options.onProgress?.(1, 2, 'Uploaded 1 of 2')
        return result
      }
    )
    const registered = new Map<string, (...args: any[]) => any>()
    registerOverleafTools(
      {
        registerTool: (name: string, _config: any, handler: (...args: any[]) => any) => {
          registered.set(name, handler)
        },
      },
      runtime
    )
    const args = {
      projectId: 'p',
      localFolderPath: '/work/paper',
      mode: 'mirror',
      destinationFolderPath: '',
      planToken: 'token',
      confirmDeleteCount: 3,
      writeMode: 'untracked',
      stopOnError: false,
    }

    const notify = vi.fn(async () => undefined)
    const synced = await registered.get('sync_directory')!(args, {
      mcpReq: { _meta: { progressToken: 7 }, notify },
    })
    expect(runtime.sync.syncDirectory).toHaveBeenCalledWith(
      'p',
      '/work/paper',
      expect.objectContaining({
        mode: 'mirror',
        planToken: 'token',
        confirmDeleteCount: 3,
        writeMode: 'untracked',
        stopOnError: false,
      })
    )
    expect(notify).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: { progressToken: 7, progress: 1, total: 2, message: 'Uploaded 1 of 2' },
    })
    expect(synced.structuredContent).toEqual(result)

    await registered.get('sync_directory')!(args, { mcpReq: { notify } })
    expect(runtime.sync.syncDirectory.mock.calls[1]?.[2].onProgress).toBeUndefined()

    await registered.get('delete_entities')!({ projectId: 'p', paths: ['a.png'], confirmCount: 1, stopOnError: true })
    expect(runtime.sync.deleteEntities).toHaveBeenCalledWith('p', ['a.png'], 1, {
      stopOnError: true,
      onProgress: undefined,
    })
  })

  test('registers batch_upload and download_project_zip with schemas, annotations, and defaults', async () => {
    const runtime = fakeRuntime()
    const registered = new Map<string, { config: any; handler: (...args: any[]) => any }>()
    registerOverleafTools(
      {
        registerTool: (name: string, config: any, handler: (...args: any[]) => any) => {
          registered.set(name, { config, handler })
        },
      },
      runtime
    )

    const batch = registered.get('batch_upload')!
    expect(batch.config.annotations).toEqual({ destructiveHint: true, idempotentHint: false })
    expect(batch.config.outputSchema).toBeDefined()
    for (const term of [
      'destinationPath',
      'onConflict',
      'fail',
      'skip',
      'overwrite',
      'write_file',
      'stopOnError',
      'never resubmitted',
      'OUTCOME_UNKNOWN',
    ]) {
      expect(batch.config.description).toContain(term)
    }
    const input = batch.config.inputSchema as { parse: (value: unknown) => Record<string, unknown> }
    // No default replaces anything: omitted, a taken destination refuses the call.
    const parsed = input.parse({ projectId: 'p', files: [{ localPath: '/a.png', destinationPath: 'a.png' }] })
    expect(parsed).toMatchObject({ stopOnError: false, onConflict: 'fail' })
    expect(() => input.parse({ projectId: 'p', files: [] })).toThrow()

    const zip = registered.get('download_project_zip')!
    // It writes a local file, so it is not read-only, and overwrite can replace one.
    expect(zip.config.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false })
    expect(zip.config.outputSchema).toBeDefined()
    for (const term of [
      'overwrite',
      'CONFIRMATION_MISMATCH',
      'mirror sync_directory',
      'RATE_LIMITED',
      'PERMISSION_DENIED',
    ]) {
      expect(zip.config.description).toContain(term)
    }
    expect(
      (zip.config.inputSchema as { parse: (value: unknown) => unknown }).parse({ projectId: 'p', localPath: 'b.zip' })
    ).toEqual({
      projectId: 'p',
      localPath: 'b.zip',
      overwrite: false,
    })

    const uploaded = {
      status: 'complete',
      onConflict: 'skip',
      completed: [],
      skipped: [],
      failed: [],
      remaining: [],
      verified: true,
    }
    runtime.sync.batchUpload.mockResolvedValue(uploaded)
    const files = [{ localPath: '/a.png', destinationPath: 'figs/a.png' }]
    const batchResult = await batch.handler({ projectId: 'p', files, onConflict: 'skip', stopOnError: true })
    expect(runtime.sync.batchUpload).toHaveBeenCalledWith('p', files, {
      onConflict: 'skip',
      stopOnError: true,
      onProgress: undefined,
    })
    expect(batchResult.structuredContent).toEqual(uploaded)

    const downloaded = { projectId: 'p', localPath: '/abs/b.zip', bytes: 10, replaced: false }
    runtime.projects.downloadProjectZip.mockResolvedValue(downloaded)
    const zipResult = await zip.handler({ projectId: 'p', localPath: 'b.zip', overwrite: false })
    expect(runtime.projects.downloadProjectZip).toHaveBeenCalledWith('p', 'b.zip', {
      overwrite: false,
      timeoutMs: undefined,
    })
    expect(zipResult.structuredContent).toEqual(downloaded)
  })

  test('registers a read-only history monitor and forwards its cursor', async () => {
    const runtime = fakeRuntime()
    const registered = new Map<string, { config: any; handler: (...args: any[]) => any }>()
    registerOverleafTools(
      {
        registerTool: (name: string, config: any, handler: (...args: any[]) => any) => {
          registered.set(name, { config, handler })
        },
      },
      runtime
    )

    expect(registered.get('monitor_project_history')?.config.annotations).toEqual({
      readOnlyHint: true,
    })
    await registered.get('monitor_project_history')?.handler({
      projectId: 'project',
      sinceVersion: 12,
    })
    expect(runtime.history.monitorProjectHistory).toHaveBeenCalledWith('project', 12)
  })
})
