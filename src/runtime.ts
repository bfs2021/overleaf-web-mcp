import type { AppConfig } from './config.js'
import type { OverleafServiceRuntime } from './contracts/service.js'
import { asMcpError, AUTH_LOGIN_INSTRUCTION, McpError } from './core/errors.js'
import { retryRead } from './core/retry.js'
import { AccessPolicy } from './core/policy.js'
import { parseBootstrapMeta, type BootstrapMeta } from './http/bootstrap.js'
import { OverleafHttpClient } from './http/client.js'
import { CookieStore } from './http/cookies.js'
import { createProxyRoute, type ProxyRoute } from './http/proxy.js'
import { AccountApi } from './overleaf/account.js'
import { CommentsApi } from './overleaf/comments.js'
import { CompileApi } from './overleaf/compile.js'
import { DocumentsApi, type WriteFileResult, type WriteMode } from './overleaf/documents.js'
import { EntitiesApi } from './overleaf/entities.js'
import { HistoryApi } from './overleaf/history.js'
import { ProjectsApi } from './overleaf/projects.js'
import { SectionsApi } from './overleaf/sections-api.js'
import { SyncApi } from './overleaf/sync.js'
import { canDecideTrackedChanges, TrackedChangesApi } from './overleaf/tracked-changes.js'
import { resolveProjectPath, type EntityType } from './overleaf/tree.js'
import { ProjectConnectionCache } from './protocol/connection-cache.js'
import { openProjectConnection } from './protocol/connect.js'
import type { ProjectConnection } from './protocol/project-connection.js'

/**
 * `nextStep` ends the message of a failure after the document was created. Sync leaves it out
 * and gives its own, since a hand-written leftover would drift from the planToken it returns.
 */
async function createDocument(
  runtime: Pick<OverleafRuntime, 'policy' | 'entities' | 'documents' | 'userId'>,
  projectId: string,
  filePath: string,
  content: string,
  writeMode: WriteMode,
  nextStep = ''
): Promise<WriteFileResult> {
  // The new document is read back after it is created, so that read is allowed first.
  runtime.policy.assertProject(projectId)
  runtime.policy.assertEffect('overleaf-write', 'overleaf-read')
  if (writeMode === 'tracked' && content === '') {
    throw new McpError('INVALID_ARGUMENT', 'Tracked file creation requires non-empty initial content.')
  }
  if (writeMode === 'tracked' && runtime.userId === undefined) {
    throw new McpError(
      'PROTOCOL_UNSUPPORTED',
      'Tracked writes require an authenticated Overleaf user ID from the project bootstrap.'
    )
  }
  await runtime.entities.createEmptyFile(projectId, filePath)
  try {
    const created = await runtime.documents.readFile(projectId, filePath)
    if (content !== '') {
      return await runtime.documents.writeFile(projectId, filePath, created.revision, content, writeMode)
    }
    return {
      revision: created.revision,
      protocol: created.protocol,
      trackChangesActive: created.trackChangesActive,
      writeMode: 'untracked' as const,
    }
  } catch (error) {
    // The document exists from here on and is never deleted unasked, so the error says so
    // and keeps the write's own classification. Creating it again would fail, so not retryable.
    const failure = asMcpError(error)
    throw new McpError(
      failure.code,
      `${failure.message} The document was created and now exists at the requested path, possibly still empty.${nextStep}`,
      { retryable: false, details: { ...failure.details, created: true }, cause: error }
    )
  }
}

/**
 * A project join that failed before Overleaf answered it, for a reason that passes: the socket
 * closed, real-time failed, the handshake met a network failure or HTTP 5xx, or Overleaf asked for
 * a retry. A refused, rate-limited, or timed-out join is not tried again.
 */
export function isTransientJoinFailure(error: McpError): boolean {
  if (error.code === 'TRANSIENT_FAILURE') return true
  return error.code === 'REMOTE_ERROR' && error.retryable
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface RuntimeDependencies {
  fetcher?: Fetcher
  connectionFactory?: (projectId: string) => Promise<ProjectConnection>
}

/**
 * Composes authenticated HTTP, cached collaboration sockets, and the domain APIs every operation runs on.
 * Callers must close the runtime so cached sockets do not outlive the server process.
 */
export class OverleafRuntime implements OverleafServiceRuntime {
  readonly config: AppConfig
  readonly cookieStore: CookieStore
  readonly http: OverleafHttpClient
  readonly account: AccountApi
  readonly entities: EntitiesApi
  readonly documents: DocumentsApi
  readonly sections: SectionsApi
  readonly compile: CompileApi
  readonly comments: CommentsApi
  readonly trackedChanges: TrackedChangesApi
  readonly history: HistoryApi
  readonly projects: ProjectsApi
  readonly sync: SyncApi
  readonly connections: ProjectConnectionCache<ProjectConnection>
  /** Decides which projects, local paths, and effects every operation may touch. */
  readonly policy: AccessPolicy
  readonly userId?: string
  readonly #proxy: ProxyRoute | undefined

  private constructor(options: {
    config: AppConfig
    cookieStore: CookieStore
    http: OverleafHttpClient
    account: AccountApi
    entities: EntitiesApi
    documents: DocumentsApi
    sections: SectionsApi
    compile: CompileApi
    comments: CommentsApi
    trackedChanges: TrackedChangesApi
    history: HistoryApi
    projects: ProjectsApi
    sync: SyncApi
    connections: ProjectConnectionCache<ProjectConnection>
    policy: AccessPolicy
    userId?: string
    proxy?: ProxyRoute
  }) {
    this.config = options.config
    this.cookieStore = options.cookieStore
    this.http = options.http
    this.account = options.account
    this.entities = options.entities
    this.documents = options.documents
    this.sections = options.sections
    this.compile = options.compile
    this.comments = options.comments
    this.trackedChanges = options.trackedChanges
    this.history = options.history
    this.projects = options.projects
    this.sync = options.sync
    this.connections = options.connections
    this.policy = options.policy
    if (options.userId !== undefined) this.userId = options.userId
    this.#proxy = options.proxy
  }

  static async create(config: AppConfig, dependencies: RuntimeDependencies = {}): Promise<OverleafRuntime> {
    // Roots resolve before anything is sent, so a misconfigured policy fails without a request.
    const policy = await AccessPolicy.create({
      allowedProjects: config.allowedProjects,
      localReadRoots: config.localReadRoots,
      localWriteRoots: config.localWriteRoots,
      allowedEffects: config.allowedEffects,
      cookieJarFile: config.cookieJarFile,
      browserProfileDir: config.browserProfileDir,
    })
    const cookieStore = await CookieStore.load(config.cookieJarFile)
    // One proxy decision, from readConfig, covers REST calls, the handshake, and the WebSocket.
    const proxy = config.proxyUrl === undefined ? undefined : createProxyRoute(config.proxyUrl)
    const fetcher = dependencies.fetcher ?? proxy?.fetcher
    const csrf = { token: undefined as string | undefined }
    const http = new OverleafHttpClient({
      baseUrl: config.baseUrl,
      jar: cookieStore.jar,
      defaultTimeoutMs: config.requestTimeoutMs,
      readAttempts: config.readAttempts,
      minRequestIntervalMs: config.minRequestIntervalMs,
      csrfToken: () => csrf.token,
      persistSetCookies: async (url, values) => await cookieStore.mergeSetCookies(url, values),
      ...(fetcher === undefined ? {} : { fetcher }),
    })

    let bootstrap: BootstrapMeta
    try {
      const bootstrapResponse = await http.request('GET', '/project')
      bootstrap = parseBootstrapMeta(await bootstrapResponse.text())
      // A signed-in page without a token is a page this release does not understand, not a lost
      // session: logging in again would not change it.
      if (!bootstrap.csrfToken && bootstrap.userId !== undefined) {
        throw new McpError(
          'PROTOCOL_UNSUPPORTED',
          'Overleaf served a signed-in project page without the CSRF token this release reads.',
          { details: { kind: 'response_shape', endpoint: 'GET /project' } }
        )
      }
      if (!bootstrap.csrfToken) {
        throw new McpError(
          'AUTH_EXPIRED',
          `Overleaf did not expose an authenticated CSRF token. ${AUTH_LOGIN_INSTRUCTION}`
        )
      }
    } catch (error) {
      await proxy?.close()
      throw error
    }
    csrf.token = bootstrap.csrfToken

    // Sockets are cached per project, while each document is freshly joined inside its queued call.
    // Joining sends nothing to the project, so a join refused for a passing reason is a read to retry.
    const factory =
      dependencies.connectionFactory ??
      (async (projectId: string) =>
        await retryRead(
          async () =>
            await openProjectConnection({
              baseUrl: config.baseUrl,
              projectId,
              jar: cookieStore.jar,
              supportedProtocolVersions: config.supportedProtocolVersions,
              timeoutMs: config.requestTimeoutMs,
              applyTimeoutMs: config.applyTimeoutMs,
              ...(bootstrap.userId === undefined ? {} : { currentUserId: bootstrap.userId }),
              ...(fetcher === undefined ? {} : { fetcher }),
              ...(proxy === undefined ? {} : { webSocketAgent: proxy.webSocketAgent }),
            }),
          {
            attempts: config.readAttempts,
            isTransient: isTransientJoinFailure,
            details: { event: 'joinProject' },
          }
        ))
    const connections = new ProjectConnectionCache<ProjectConnection>({
      capacity: config.socketCacheSize,
      idleTtlMs: config.socketIdleTtlMs,
      factory,
      // Every socket path, for every caller, is checked before a connection is reused or opened.
      beforeConnect: projectId => policy.assertProject(projectId),
    })
    const account = new AccountApi(http, policy)
    const documents = new DocumentsApi(connections, {
      maxDocLength: bootstrap.maxDocLength ?? config.maxDocLength,
      maxUpdateChars: config.maxUpdateChars,
      recoveryTimeoutMs: config.recoveryTimeoutMs,
      ...(bootstrap.userId === undefined ? {} : { currentUserId: bootstrap.userId }),
      policy,
    })
    const entities = new EntitiesApi(http, connections, policy)
    // A fresh join before flattening, so includes are never resolved against a stale tree.
    const sections = new SectionsApi(documents, {
      getProjectTree: async projectId => {
        await connections.invalidate(projectId)
        return await entities.getProjectTree(projectId)
      },
      policy,
    })
    // A fresh join before resolving, so a path is never looked up in a stale tree.
    const resolvePath = async (projectId: string, path: string, type: EntityType) => {
      await connections.invalidate(projectId)
      return await connections.withConnection(
        projectId,
        async connection => await connection.queue.run(() => resolveProjectPath(connection.getTree(), path, type))
      )
    }
    const compile = new CompileApi(
      http,
      resolvePath,
      config.compileTimeoutMs,
      // Overleaf's own root document, so a compile that names no root matches the web UI.
      async projectId => {
        await connections.invalidate(projectId)
        return await entities.getRootDocument(projectId)
      },
      policy
    )
    const comments = new CommentsApi(http, connections, {
      maxUpdateChars: config.maxUpdateChars,
      recoveryTimeoutMs: config.recoveryTimeoutMs,
      ...(bootstrap.userId === undefined ? {} : { currentUserId: bootstrap.userId }),
      policy,
    })
    const trackedChanges = new TrackedChangesApi(http, connections, {
      maxDocLength: bootstrap.maxDocLength ?? config.maxDocLength,
      maxUpdateChars: config.maxUpdateChars,
      recoveryTimeoutMs: config.recoveryTimeoutMs,
      policy,
    })
    const history = new HistoryApi(http, policy)
    const projects = new ProjectsApi({
      http,
      baseUrl: config.baseUrl,
      findProject: async projectId => await account.findProject(projectId),
      resolvePath,
      getProjectTree: async projectId => await entities.getProjectTree(projectId),
      invalidate: async projectId => await connections.invalidate(projectId),
      policy,
    })
    // Every sync step is an existing primitive; createFile lives on the runtime itself.
    const created: { runtime?: OverleafRuntime } = {}
    const sync = new SyncApi({
      getProjectTree: async projectId => {
        await connections.invalidate(projectId)
        return await entities.getProjectTree(projectId)
      },
      readFile: async (projectId, filePath) => await documents.readFile(projectId, filePath),
      writeFile: async (projectId, filePath, revision, content, writeMode) =>
        await documents.writeFile(projectId, filePath, revision, content, writeMode),
      createFile: async (projectId, filePath, content, writeMode) =>
        await createDocument(created.runtime!, projectId, filePath, content, writeMode),
      uploadFile: async (projectId, localPath, destinationFolderPath, destinationName, options) =>
        await entities.uploadFile(projectId, localPath, destinationFolderPath, destinationName, options ?? {}),
      manageEntity: async (projectId, action) => await entities.manageEntity(projectId, action),
      currentUserId: bootstrap.userId,
      policy,
    })

    const runtime = new OverleafRuntime({
      config,
      cookieStore,
      http,
      account,
      entities,
      documents,
      sections,
      compile,
      comments,
      trackedChanges,
      history,
      projects,
      sync,
      connections,
      policy,
      ...(bootstrap.userId === undefined ? {} : { userId: bootstrap.userId }),
      ...(proxy === undefined ? {} : { proxy }),
    })
    created.runtime = runtime
    return runtime
  }

  async authStatus(): Promise<{
    authenticated: true
    baseUrl: string
    userId?: string
    projectCount: number
    /** When the session lapses unless a request refreshes it first; absent if no cookie has a deadline. */
    sessionExpiresAt?: string
    permissionsUnchecked: boolean
    warning?: string
    socketPresenceNotice: string
  }> {
    const projectCount = await this.account.countProjects()
    const sessionExpiresAt = await this.cookieStore.sessionExpiresAt(`${this.config.baseUrl}/project`)
    return {
      authenticated: true,
      baseUrl: this.config.baseUrl,
      ...(this.userId === undefined ? {} : { userId: this.userId }),
      projectCount,
      ...(sessionExpiresAt === undefined ? {} : { sessionExpiresAt }),
      permissionsUnchecked: this.cookieStore.permissions.permissionsUnchecked,
      ...(this.cookieStore.permissions.warning === undefined ? {} : { warning: this.cookieStore.permissions.warning }),
      socketPresenceNotice:
        'An active cached project socket can make this account appear online to collaborators until the idle timeout.',
    }
  }

  /**
   * What the web-session backend can do in one project, read from a fresh `joinProject`: whether
   * this account can decide tracked changes there. Joining shows the account online to
   * collaborators until the socket idles out.
   */
  async reviewSupport(projectId: string): Promise<{ decide: boolean }> {
    this.policy.assertProject(projectId)
    this.policy.assertEffect('overleaf-read')
    await this.connections.invalidate(projectId)
    return await this.connections.withConnection(projectId, async connection =>
      Promise.resolve({ decide: canDecideTrackedChanges(connection) })
    )
  }

  async createFile(
    projectId: string,
    filePath: string,
    content = '',
    writeMode: WriteMode = 'untracked'
  ): Promise<WriteFileResult> {
    return await createDocument(
      this,
      projectId,
      filePath,
      content,
      writeMode,
      ' Do not create it again: read it with read_file and write its content with write_file.'
    )
  }

  async close(): Promise<void> {
    await this.connections.closeAll()
    await this.#proxy?.close()
  }
}
