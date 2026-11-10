import { PassThrough } from 'node:stream'

import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer, type ServerContext } from '@modelcontextprotocol/server'
import { describe, expect, test, vi } from 'vitest'

import { McpError } from '../src/core/errors.js'
import { SERVER_INSTRUCTIONS } from '../src/mcp/instructions.js'
import { ToolActivity, TOOL_NAMES, type ToolCallExtra } from '../src/mcp/tools.js'
import { createMcpServer, runStdioServer, SERVER_NAME, serveOverStdio } from '../src/server.js'

function fakeRuntime() {
  return {
    authStatus: vi.fn(),
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

/** A runtime whose plan_sync reports two progress steps before returning a schema-valid plan. */
function runtimeWithPlanProgress() {
  const runtime = fakeRuntime()
  const plan = {
    planToken: 'token',
    localFolderPath: '/work/paper',
    destinationFolderPath: '',
    toUpload: [{ localPath: 'a.png', destinationPath: 'a.png', reason: 'new' }],
    identical: { count: 0, paths: [] },
    remoteOnly: [{ destinationPath: 'old', entityId: 'e', type: 'folder', contains: 2 }],
    conflicts: [],
    ignored: { count: 1, entries: [{ localPath: 'main.aux', matchedPattern: '*.aux' }] },
  }
  runtime.sync.planSync.mockImplementation(
    async (
      _id: string,
      _path: string,
      options: {
        onProgress?: (progress: number, total: number, message: string) => Promise<void>
      }
    ) => {
      await options.onProgress?.(1, 2, 'Read 1 of 2 documents')
      await options.onProgress?.(2, 2, 'Read 2 of 2 documents')
      return plan
    }
  )
  return { runtime, plan }
}

async function connectedPair() {
  const server = createMcpServer(fakeRuntime())
  const client = new Client({ name: 'smoke-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { server, client }
}

describe('MCP server', () => {
  test('constructs the SDK server with the full tool surface', () => {
    const registerTool = vi.spyOn(McpServer.prototype, 'registerTool')
    try {
      const server = createMcpServer(fakeRuntime())

      expect(server).toBeInstanceOf(McpServer)
      expect(registerTool.mock.calls.map(call => call[0])).toEqual(TOOL_NAMES)
    } finally {
      registerTool.mockRestore()
    }
  })

  test('lists all tools over an MCP transport handshake', async () => {
    const { server, client } = await connectedPair()
    const result = await client.listTools()

    expect(result.tools.map(tool => tool.name)).toEqual(TOOL_NAMES)
    // Parameter descriptions survive the schema conversion the SDK performs.
    expect(result.tools.find(tool => tool.name === 'list_projects')?.inputSchema.properties?.query).toMatchObject({
      description: 'Case-insensitive substring of the project name',
    })
    await client.close()
    await server.close()
  })

  test("serves the latest build's log and PDF as read-only resources", async () => {
    const runtime = fakeRuntime()
    runtime.compile.readCompileOutput.mockImplementation(async (_projectId: string, file: string) => ({
      bytes: new TextEncoder().encode(file === 'output.pdf' ? '%PDF-1.5' : 'This is pdfTeX'),
      truncated: false,
      buildId: 'b',
    }))
    const server = createMcpServer(runtime)
    const client = new Client({ name: 'smoke-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { resourceTemplates } = await client.listResourceTemplates()
    expect(resourceTemplates.map(template => template.uriTemplate)).toEqual([
      'overleaf://project/{projectId}/output/output.log',
      'overleaf://project/{projectId}/output/output.pdf',
    ])
    const log = await client.readResource({ uri: 'overleaf://project/abc/output/output.log' })
    expect(log.contents).toEqual([
      { uri: 'overleaf://project/abc/output/output.log', mimeType: 'text/plain', text: 'This is pdfTeX' },
    ])
    const pdf = await client.readResource({ uri: 'overleaf://project/abc/output/output.pdf' })
    expect(Buffer.from((pdf.contents[0] as { blob: string }).blob, 'base64').toString()).toBe('%PDF-1.5')
    expect(runtime.compile.readCompileOutput).toHaveBeenCalledWith('abc', 'output.pdf', 16 * 1024 * 1024)

    runtime.compile.readCompileOutput.mockRejectedValueOnce(new McpError('NO_BUILD', 'No compile yet.'))
    await expect(client.readResource({ uri: 'overleaf://project/abc/output/output.log' })).rejects.toThrow(/NO_BUILD/u)
    await client.close()
    await server.close()
  })

  test('keeps tools/list identical to the committed snapshot', async () => {
    // Names, descriptions, schemas, and annotations are the public contract; a change must be
    // deliberate, reviewed in this file's diff, and listed in CHANGELOG.md.
    const { server, client } = await connectedPair()
    const { tools } = await client.listTools()

    await expect(`${JSON.stringify(tools, null, 2)}\n`).toMatchFileSnapshot('__snapshots__/list-tools.json')
    await client.close()
    await server.close()
  })

  test('returns structuredContent that satisfies the declared outputSchema over the transport', async () => {
    const runtime = fakeRuntime()
    const listing = {
      projects: [{ id: 'p', name: 'Paper', accessLevel: 'owner', archived: false, trashed: false }],
      totalMatched: 1,
      totalProjects: 1,
    }
    runtime.account.listProjects.mockResolvedValue(listing)
    const server = createMcpServer(runtime)
    const client = new Client({ name: 'smoke-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const listed = await client.listTools()
    expect(listed.tools.find(tool => tool.name === 'list_projects')?.outputSchema).toBeDefined()
    const result = await client.callTool({ name: 'list_projects', arguments: { query: 'Pap' } })
    expect(result.structuredContent).toEqual(listing)
    expect(runtime.account.listProjects).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Pap', includeArchived: false, limit: 50 })
    )
    await client.close()
    await server.close()
  })

  test('validates list_comments structuredContent against its output schema over the transport', async () => {
    const runtime = fakeRuntime()
    const listing = {
      positionsUnavailable: false,
      threads: [
        {
          id: 't1',
          status: 'open',
          messages: [
            {
              id: 'm1',
              author: { id: 'u1', displayName: 'Ada Lovelace' },
              content: 'Please revise',
              timestamp: '2026-01-01T00:00:00.000Z',
            },
          ],
          filePath: 'main.tex',
          start: { line: 2, column: 1 },
          end: { line: 2, column: 3 },
          quotedText: 'bc',
        },
        {
          id: 't2',
          status: 'resolved',
          messages: [{ author: null, content: '' }],
          resolvedAt: '2026-01-02T00:00:00.000Z',
          resolvedBy: { id: 'u2', displayName: '' },
          unlocated: true,
        },
      ],
    }
    runtime.comments.listComments.mockResolvedValue(listing)
    const server = createMcpServer(runtime)
    const client = new Client({ name: 'smoke-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const result = await client.callTool({ name: 'list_comments', arguments: { projectId: 'p' } })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual(listing)
    await client.close()
    await server.close()
  })

  test('validates reply_to_comment structuredContent against its output schema over the transport', async () => {
    const runtime = fakeRuntime()
    const reply = {
      threadId: 't1',
      message: {
        id: 'm2',
        author: { id: 'u1', displayName: 'Ada Lovelace' },
        content: 'Done',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      trackChangesActive: false,
      writeMode: 'untracked',
      recoveredAfterTimeout: true,
    }
    runtime.comments.replyToComment.mockResolvedValue(reply)
    const server = createMcpServer(runtime)
    const client = new Client({ name: 'smoke-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const result = await client.callTool({
      name: 'reply_to_comment',
      arguments: { projectId: 'p', threadId: 't1', content: 'Done' },
    })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual(reply)
    await client.close()
    await server.close()
  })

  test('validates auth_status structuredContent against its output schema over the transport', async () => {
    const runtime = fakeRuntime()
    const status = {
      authenticated: true,
      baseUrl: 'https://overleaf.test',
      userId: 'user',
      projectCount: 3,
      sessionExpiresAt: '2026-09-19T00:00:00.000Z',
      permissionsUnchecked: false,
      socketPresenceNotice: 'notice',
    }
    runtime.authStatus.mockResolvedValue(status)
    const server = createMcpServer(runtime)
    const client = new Client({ name: 'smoke-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const result = await client.callTool({ name: 'auth_status', arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual(status)
    await client.close()
    await server.close()
  })

  test('delivers sync progress notifications and a schema-valid plan over the transport', async () => {
    const { runtime, plan } = runtimeWithPlanProgress()
    const server = createMcpServer(runtime)
    const client = new Client({ name: 'smoke-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const progress: Array<{ progress: number; total?: number | undefined }> = []
    const result = await client.callTool(
      { name: 'plan_sync', arguments: { projectId: 'p', localFolderPath: '/work/paper' } },
      { onprogress: update => progress.push({ progress: update.progress, total: update.total }) }
    )

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual(plan)
    expect(progress).toEqual([
      { progress: 1, total: 2 },
      { progress: 2, total: 2 },
    ])
    expect(runtime.sync.planSync).toHaveBeenCalledWith(
      'p',
      '/work/paper',
      expect.objectContaining({ destinationFolderPath: '', verbose: false })
    )
    await client.close()
    await server.close()
  })

  test('sends bounded usage instructions to a connecting client', async () => {
    const { server, client } = await connectedPair()
    const instructions = client.getInstructions()

    expect(instructions).toBe(SERVER_INSTRUCTIONS)
    // The contract an assistant must know without reading the docs.
    for (const term of [
      'read_file',
      'revision',
      'REVISION_CONFLICT',
      'upload_file',
      'confirmPath',
      'confirmName',
      'manage_project',
      'plan_sync',
      'planToken',
      'confirmDeleteCount',
      'REMOTE_DRIFT',
      'add_comment',
      'list_tracked_changes',
      'manage_tracked_changes',
      'confirmCount',
      'NOT_FOUND',
      'AUTH_EXPIRED',
    ]) {
      expect(instructions).toContain(term)
    }
    // Instructions ride along on every session; keep them short enough to be read.
    expect(instructions!.split(/\s+/u).length).toBeLessThan(450)
    await client.close()
    await server.close()
  })
})

// serveOverStdio is what `overleaf-web-mcp serve` runs. The client's opening message decides the
// protocol era, and both eras must receive the same tools and the same usage instructions.
describe('protocol eras', () => {
  function served(runtime: ReturnType<typeof fakeRuntime> = fakeRuntime()) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const connection = serveOverStdio(runtime, serverTransport)
    return { clientTransport, connection }
  }

  test.each(['2024-10-07', '2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'])(
    'serves a client on protocol %s through initialize',
    async version => {
      const { clientTransport, connection } = served()
      const client = new Client({ name: 'legacy-client', version: '1.0.0' }, { supportedProtocolVersions: [version] })
      await client.connect(clientTransport)

      expect(client.getProtocolEra()).toBe('legacy')
      expect(client.getNegotiatedProtocolVersion()).toBe(version)
      expect(client.getDiscoverResult()).toBeUndefined()
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS)
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(TOOL_NAMES)
      await client.close()
      await connection.close()
    }
  )

  test('answers a bare initialize from a client without the v2 SDK', async () => {
    const { clientTransport: peer, connection } = served()
    const waiting = new Map<number, (message: { result?: Record<string, unknown> }) => void>()
    peer.onmessage = (message: unknown) => {
      const response = message as { id?: unknown; result?: Record<string, unknown> }
      if (typeof response.id === 'number') waiting.get(response.id)?.(response)
    }
    await peer.start()
    const request = (id: number, method: string, params: Record<string, unknown>) =>
      new Promise<{ result?: Record<string, unknown> }>(resolve => {
        waiting.set(id, resolve)
        void peer.send({ jsonrpc: '2.0', id, method, params })
      })

    const initialized = await request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'bare', version: '0' },
    })
    expect(initialized.result).toMatchObject({
      protocolVersion: '2024-11-05',
      serverInfo: { name: SERVER_NAME },
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    })
    await peer.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const listed = await request(2, 'tools/list', {})
    const tools = listed.result?.tools as Array<{ name: string }>
    expect(tools.map(tool => tool.name)).toEqual(TOOL_NAMES)
    await peer.close()
    await connection.close()
  })

  test('serves a 2026-07-28 client through server/discover with the same instructions', async () => {
    const { clientTransport, connection } = served()
    const client = new Client(
      { name: 'modern-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    )
    await client.connect(clientTransport)

    expect(client.getProtocolEra()).toBe('modern')
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28')
    expect(client.getDiscoverResult()?.instructions).toBe(SERVER_INSTRUCTIONS)
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS)
    expect((await client.discover()).instructions).toBe(SERVER_INSTRUCTIONS)
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(TOOL_NAMES)
    await client.close()
    await connection.close()
  })

  test('delivers sync progress to a 2026-07-28 client', async () => {
    const { runtime, plan } = runtimeWithPlanProgress()
    const { clientTransport, connection } = served(runtime)
    const client = new Client(
      { name: 'modern-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    )
    await client.connect(clientTransport)

    const progress: number[] = []
    const result = await client.callTool(
      { name: 'plan_sync', arguments: { projectId: 'p', localFolderPath: '/work/paper' } },
      { onprogress: update => progress.push(update.progress) }
    )

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual(plan)
    expect(progress).toEqual([1, 2])
    await client.close()
    await connection.close()
  })

  test('rejects a tool name the server does not register', async () => {
    const { clientTransport, connection } = served()
    const client = new Client({ name: 'legacy-client', version: '1.0.0' })
    await client.connect(clientTransport)

    await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toMatchObject({
      code: -32602,
    })
    await client.close()
    await connection.close()
  })

  test('tools read the progress token and notifier where the SDK puts them', () => {
    // Compile-time guard: npm run check fails if ServerContext.mcpReq loses `_meta` or `notify`, or
    // either stops matching what ToolCallExtra reads. The progress tests cover it at run time.
    type Provided = Pick<ServerContext['mcpReq'], '_meta' | 'notify'>
    const read = (fields: Provided): NonNullable<ToolCallExtra['mcpReq']> => fields
    expect(read).toBeTypeOf('function')
  })
})

describe('tool activity', () => {
  test('counts running calls and reports when they settle', async () => {
    const activity = new ToolActivity()
    expect(await activity.whenIdle(10)).toBe(true)

    let finish!: () => void
    const call = activity.track(() => new Promise<void>(resolve => (finish = resolve)))
    expect(activity.running).toBe(1)
    expect(await activity.whenIdle(10)).toBe(false)

    const idle = activity.whenIdle(1000)
    finish()
    await call
    expect(await idle).toBe(true)
    expect(activity.running).toBe(0)
  })

  test('settles a failed call too', async () => {
    const activity = new ToolActivity()
    await expect(activity.track(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(activity.running).toBe(0)
  })
})

// runStdioServer is the whole `overleaf-web-mcp serve` lifecycle after the runtime is created.
describe('stdio lifecycle', () => {
  function stdio(runtime: ReturnType<typeof fakeRuntime>, stdinCloseGraceMs = 1000) {
    const input = new PassThrough()
    const output = new PassThrough()
    const lines: string[] = []
    let buffered = ''
    output.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const parts = buffered.split('\n')
      buffered = parts.pop() ?? ''
      lines.push(...parts.filter(Boolean))
    })
    const close = vi.fn(async () => undefined)
    const exit = vi.fn()
    const server = runStdioServer({ ...runtime, close }, { input, output, exit, stdinCloseGraceMs })
    const send = (message: Record<string, unknown>) =>
      input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    const reply = async (id: number) => {
      await vi.waitFor(() => expect(lines.some(line => (JSON.parse(line) as { id?: unknown }).id === id)).toBe(true))
      return JSON.parse(lines.find(line => (JSON.parse(line) as { id?: unknown }).id === id)!) as Record<
        string,
        unknown
      >
    }
    const initialize = async () => {
      send({
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pipe', version: '0' } },
      })
      await reply(1)
      send({ method: 'notifications/initialized' })
    }
    return { input, lines, close, exit, server, send, reply, initialize }
  }

  /** A runtime whose plan_sync stays running until release() is called. */
  function runtimeWithSlowPlan() {
    const runtime = fakeRuntime()
    let release!: () => void
    let started!: () => void
    const running = new Promise<void>(resolve => (started = resolve))
    runtime.sync.planSync.mockImplementation(async () => {
      started()
      await new Promise<void>(resolve => (release = resolve))
      return {}
    })
    return { runtime, running, release: () => release() }
  }

  test('writes only JSON-RPC to stdout and exits once when the client closes stdin', async () => {
    const { input, lines, close, exit, initialize } = stdio(fakeRuntime())
    await initialize()
    input.end()

    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1))
    expect(exit).toHaveBeenCalledWith(0)
    expect(close).toHaveBeenCalledTimes(1)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect((JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc).toBe('2.0')
  })

  /**
   * A client transport over the server's own stdin and stdout streams, one JSON-RPC message per
   * line, as a real MCP client's stdio transport frames them.
   */
  function pipeTransport(input: PassThrough, lines: string[]) {
    let seen = 0
    let timer: ReturnType<typeof setInterval> | undefined
    const transport = {
      onmessage: undefined as ((message: any) => void) | undefined,
      onclose: undefined as (() => void) | undefined,
      onerror: undefined as ((error: Error) => void) | undefined,
      async start() {
        timer = setInterval(() => {
          while (seen < lines.length) transport.onmessage?.(JSON.parse(lines[seen++]!))
        }, 1)
        await Promise.resolve()
      },
      async send(message: unknown) {
        input.write(`${JSON.stringify(message)}\n`)
        await Promise.resolve()
      },
      async close() {
        clearInterval(timer)
        input.end()
        transport.onclose?.()
        await Promise.resolve()
      },
    }
    return transport
  }

  test.each([
    ['2025-11-25', 'legacy'],
    ['2026-07-28', 'modern'],
  ] as const)('a %s client receives the instructions over stdio and stdout stays JSON-RPC', async (version, era) => {
    const { input, lines, close, exit } = stdio(fakeRuntime())
    const client = new Client(
      { name: `stdio-${version}`, version: '1.0.0' },
      { versionNegotiation: { mode: era === 'modern' ? { pin: version } : 'legacy' } }
    )
    await client.connect(pipeTransport(input, lines))

    expect(client.getProtocolEra()).toBe(era)
    expect(client.getNegotiatedProtocolVersion()).toBe(version)
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS)
    if (era === 'modern') expect((await client.discover()).instructions).toBe(SERVER_INSTRUCTIONS)
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(TOOL_NAMES)
    await client.close()

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(close).toHaveBeenCalledTimes(1)
    for (const line of lines) expect((JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc).toBe('2.0')
  })

  test('lets a running tool call finish before closing the runtime when stdin closes', async () => {
    const { runtime, running, release } = runtimeWithSlowPlan()
    const { input, close, exit, send, initialize } = stdio(runtime)
    await initialize()
    send({
      id: 2,
      method: 'tools/call',
      params: { name: 'plan_sync', arguments: { projectId: 'p', localFolderPath: '/w' } },
    })
    await running
    input.end()

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(close).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('closes after the grace period even if a call is still running', async () => {
    const { runtime, running } = runtimeWithSlowPlan()
    const { input, close, exit, send, initialize } = stdio(runtime, 30)
    await initialize()
    send({
      id: 2,
      method: 'tools/call',
      params: { name: 'plan_sync', arguments: { projectId: 'p', localFolderPath: '/w' } },
    })
    await running
    input.end()

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('shutdown closes at once, for signals', async () => {
    const { runtime, running } = runtimeWithSlowPlan()
    const { close, exit, send, server, initialize } = stdio(runtime)
    await initialize()
    send({
      id: 2,
      method: 'tools/call',
      params: { name: 'plan_sync', arguments: { projectId: 'p', localFolderPath: '/w' } },
    })
    await running

    await server.shutdown()
    await server.shutdown()
    expect(close).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
  })
})
