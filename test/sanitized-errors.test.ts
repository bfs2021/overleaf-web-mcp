import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CookieJar } from 'tough-cookie'
import { describe, expect, test, vi } from 'vitest'

import { asMcpError } from '../src/core/errors.js'
import { FifoQueue } from '../src/core/queue.js'
import { OverleafHttpClient } from '../src/http/client.js'
import { CompileApi } from '../src/overleaf/compile.js'
import { EntitiesApi } from '../src/overleaf/entities.js'
import { openProjectConnection } from '../src/protocol/connect.js'
import { ProjectConnection } from '../src/protocol/project-connection.js'
import { SocketIo09Peer } from '../src/protocol/socketio09-client.js'

const SENTINEL = 'SENTINEL-7f3a'

/** What an MCP client, the CLI, or a log would see of the failure. */
async function serializedFailure(work: () => Promise<unknown>): Promise<string> {
  try {
    await work()
  } catch (error) {
    return JSON.stringify(asMcpError(error).toJSON())
  }
  throw new Error('expected a failure')
}

class FakeSocket extends EventEmitter {
  readyState = 1
  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = 3
    this.emit('close')
  })
}

function socketPair(onSend: (socket: FakeSocket, packet: string) => void = () => undefined) {
  const socket = new FakeSocket()
  socket.send.mockImplementation((packet: string) => onSend(socket, packet))
  return { socket, peer: new SocketIo09Peer(socket) }
}

function joinedConnection(peer: SocketIo09Peer): ProjectConnection {
  return new ProjectConnection({
    projectId: 'p',
    peer,
    join: { publicId: 'pub', project: { _id: 'p', rootFolder: [] }, permissionsLevel: 'owner', protocolVersion: 2 },
    supportedProtocolVersions: [2],
    callTimeoutMs: 1_000,
    applyTimeoutMs: 1_000,
  })
}

describe('upstream text never reaches an error', () => {
  test('an otUpdateError quoting document text', async () => {
    const { socket, peer } = socketPair((socket, packet) => {
      const ack = /^5:(\d+)\+/u.exec(packet)?.[1]
      if (ack === undefined) return
      setTimeout(() => {
        socket.emit('message', `6:::${ack}+[null]`)
        socket.emit(
          'message',
          `5:::${JSON.stringify({
            name: 'otUpdateError',
            args: [
              `Delete component '${SENTINEL} secret paragraph' does not match`,
              { doc_id: 'd', op: [{ i: SENTINEL }] },
            ],
          })}`
        )
      }, 0)
    })
    const connection = joinedConnection(peer)

    const text = await serializedFailure(() =>
      connection.submitUpdate('d', { doc: 'd', v: 1, op: [{ p: 0, i: SENTINEL }] })
    )
    expect(text).not.toContain(SENTINEL)
    // Not too-large, so the update may have applied: the outcome is unknown, never the quoted text.
    expect(JSON.parse(text)).toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      details: { event: 'otUpdateError', reason: 'unrecognized' },
    })
    socket.close()
  })

  test('a joinDoc error and a Socket.IO error packet', async () => {
    const { socket, peer } = socketPair((socket, packet) => {
      const ack = /^5:(\d+)\+/u.exec(packet)?.[1]
      if (ack !== undefined)
        setTimeout(() => socket.emit('message', `6:::${ack}+[{"message":"${SENTINEL} doc text"}]`), 0)
    })
    const connection = joinedConnection(peer)
    expect(await serializedFailure(() => connection.joinDocument('d'))).not.toContain(SENTINEL)

    const failure = new Promise(resolve => peer.once('error', resolve))
    socket.emit('message', `7:::${SENTINEL} reason`)
    const error = await failure
    expect(JSON.stringify(asMcpError(error).toJSON())).not.toContain(SENTINEL)
  })

  test('a connectionRejected message', async () => {
    const socket = new FakeSocket()
    socket.readyState = 0
    const text = await serializedFailure(() =>
      openProjectConnection({
        baseUrl: 'https://overleaf.test',
        projectId: 'p',
        jar: new CookieJar(),
        supportedProtocolVersions: [2],
        timeoutMs: 1_000,
        fetcher: async () => new Response('SESSION:60:60:websocket'),
        webSocketFactory: () => {
          setTimeout(() => {
            socket.readyState = 1
            socket.emit(
              'message',
              `5:::${JSON.stringify({ name: 'connectionRejected', args: [{ message: SENTINEL }] })}`
            )
          }, 0)
          return socket
        },
      })
    )
    expect(text).not.toContain(SENTINEL)
    expect(JSON.parse(text)).toMatchObject({ code: 'REMOTE_ERROR', details: { reason: 'unrecognized' } })
  })

  test('an upload body with free text in error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-sentinel-'))
    await writeFile(join(directory, 'a.png'), 'png')
    const connection = { queue: new FifoQueue(), getTree: () => [], rootFolderId: 'root', trackChangesActive: false }
    const api = new EntitiesApi(
      {
        postJson: vi.fn(),
        deleteJson: vi.fn(),
        getBytes: vi.fn(),
        postForm: vi.fn(async () => ({ success: false, error: `Free <b>${SENTINEL}</b> text` })),
      },
      { withConnection: async (_id, operation) => await operation(connection), invalidate: async () => undefined }
    )

    const text = await serializedFailure(() => api.uploadFile('p', join(directory, 'a.png')))
    expect(text).not.toContain(SENTINEL)
    expect(JSON.parse(text)).toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(JSON.parse(text)).not.toHaveProperty('details')
  })

  test('an HTML page where JSON was expected', async () => {
    const client = new OverleafHttpClient({
      baseUrl: 'https://overleaf.test',
      jar: new CookieJar(),
      fetcher: async () =>
        new Response(`<!DOCTYPE html><title>${SENTINEL}</title>`, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    })
    for (const call of [() => client.getJson('/project/p/threads'), () => client.postJson('/api/project')]) {
      const text = await serializedFailure(call)
      expect(text).not.toContain(SENTINEL)
      expect(text).not.toContain('<!DOCTYPE')
      expect(JSON.parse(text)).toMatchObject({
        code: 'PROTOCOL_UNSUPPORTED',
        details: { contentType: 'text/html' },
      })
    }
  })

  test('a compile status that is not an identifier', async () => {
    const http = {
      postJson: async () => ({
        status: `${SENTINEL} free text`,
        outputFiles: [{ path: 'output.log', type: 'log', url: SENTINEL }],
      }),
      getStream: async () => ({ body: new Response(SENTINEL).body! }),
    }
    const api = new CompileApi(http, async () => ({
      id: 'd',
      name: 'main.tex',
      path: 'main.tex',
      type: 'doc',
      parentFolderId: 'root',
    }))
    const text = await serializedFailure(() => api.compileProject('p', 'main.tex'))
    expect(text).not.toContain(SENTINEL)
    expect(JSON.parse(text)).toMatchObject({ code: 'COMPILE_FAILED' })
    // details.result is gone; only these keys remain.
    expect(JSON.parse(text).details).toEqual({ status: 'unrecognized', rootFilePath: 'main.tex' })

    const failed = new CompileApi(
      {
        ...http,
        postJson: async () => ({
          status: 'failure',
          outputFiles: [{ path: 'output.log', type: 'log', url: SENTINEL }],
        }),
      },
      async () => ({ id: 'd', name: 'main.tex', path: 'main.tex', type: 'doc', parentFolderId: 'root' })
    )
    // A failed build is a result with a summary, and it carries no URL from the response.
    const result = await failed.compileProject('p', 'main.tex')
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
    expect(result.summary).toMatchObject({ status: 'failure', builtCleanly: false })
  })
})
