import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { vi } from 'vitest'

import { readConfig } from '../../src/config.js'
import type { RawFolder } from '../../src/overleaf/tree.js'
import { ProjectConnection } from '../../src/protocol/project-connection.js'
import { OverleafRuntime } from '../../src/runtime.js'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** A protected Netscape cookie jar holding one long-lived session cookie, in a fresh folder. */
export async function cookieJar(): Promise<{ directory: string; cookiePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'overleaf-runtime-'))
  const cookiePath = join(directory, 'cookies.txt')
  await writeFile(
    cookiePath,
    '# Netscape HTTP Cookie File\n.overleaf.test\tTRUE\t/\tTRUE\t2147483647\toverleaf.sid\tsession\n'
  )
  if (process.platform !== 'win32') await chmod(cookiePath, 0o600)
  return { directory, cookiePath }
}

export const BOOTSTRAP_PAGE = '<meta name="ol-csrfToken" content="csrf"><meta name="ol-user_id" content="user">'

export interface TestRuntimeOptions {
  /** The project tree every joined connection reports. */
  root?: RawFolder
  /** Lines of every joined document. */
  documentLines?: string[]
  /** Answers every request but the bootstrap `GET /project`. */
  fetcher?: Fetcher
  env?: Record<string, string>
}

/**
 * A real `OverleafRuntime` over an injected fetcher and connection factory, counting every fetch
 * after the bootstrap and every socket call.
 */
export async function createTestRuntime(options: TestRuntimeOptions = {}) {
  const { cookiePath, directory } = await cookieJar()
  const root: RawFolder = options.root ?? {
    _id: 'root',
    name: 'rootFolder',
    docs: [{ _id: 'd1', name: 'main.tex' }],
    fileRefs: [],
    folders: [],
  }
  const fetches: string[] = []
  const socketCalls: string[] = []
  const connectionFactory = vi.fn(async (projectId: string) => {
    const peer = {
      on() {
        return peer
      },
      once() {
        return peer
      },
      removeListener() {
        return peer
      },
      call: async (name: string) => {
        socketCalls.push(name)
        return name === 'joinDoc' ? [null, options.documentLines ?? ['hello'], 3, null, {}, 'sharejs-text-ot'] : [null]
      },
      close() {},
    }
    return new ProjectConnection({
      projectId,
      peer,
      join: {
        publicId: 'public',
        project: { _id: projectId, rootFolder: [structuredClone(root)] },
        permissionsLevel: 'owner',
        protocolVersion: 2,
      },
      supportedProtocolVersions: [2],
    })
  })
  const runtime = await OverleafRuntime.create(
    readConfig({
      OVERLEAF_COOKIE_JAR_FILE: cookiePath,
      OVERLEAF_BASE_URL: 'https://overleaf.test',
      OVERLEAF_BROWSER_PROFILE_DIR: join(directory, 'profile'),
      ...options.env,
    }),
    {
      fetcher: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.pathname === '/project') return new Response(BOOTSTRAP_PAGE)
        fetches.push(`${method} ${url.pathname}${url.search}`)
        if (options.fetcher !== undefined) return await options.fetcher(input, init)
        throw new Error(`unexpected ${method} ${url.pathname}`)
      },
      connectionFactory,
      // Retries keep their attempts, without real waits between them.
      sleep: async () => await Promise.resolve(),
    }
  )
  return { runtime, fetches, socketCalls, connectionFactory, cookiePath, directory, root }
}
