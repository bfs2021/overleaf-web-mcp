import { CookieJar } from 'tough-cookie'
import { describe, expect, test, vi } from 'vitest'

import { McpError } from '../../src/core/errors.js'
import { FifoQueue } from '../../src/core/queue.js'
import { createRevision } from '../../src/core/revision.js'
import { OverleafHttpClient } from '../../src/http/client.js'
import { CommentsApi } from '../../src/overleaf/comments.js'
import type { JoinedDocument } from '../../src/protocol/project-connection.js'

const tree = [
  {
    id: 'doc1',
    name: 'main.tex',
    path: 'main.tex',
    type: 'doc' as const,
    parentFolderId: 'root',
  },
  {
    id: 'doc2',
    name: 'other.tex',
    path: 'other.tex',
    type: 'doc' as const,
    parentFolderId: 'root',
  },
]

// The shape Overleaf's /threads route sends: names and emails, and millisecond timestamps.
const threads = {
  open: {
    messages: [
      {
        id: 'm1',
        content: 'Please revise',
        timestamp: Date.UTC(2026, 0, 1),
        user_id: 'reviewer',
        user: { id: 'reviewer', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test' },
      },
    ],
  },
  resolved: {
    resolved: true,
    resolved_at: '2026-01-02T00:00:00.000Z',
    resolved_by_user_id: 'owner',
    resolved_by_user: { id: 'owner', first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.test' },
    messages: [],
  },
}

function shareDocument(content: string, version: number, comments: unknown[] = []): JoinedDocument {
  return {
    docId: 'doc1',
    protocol: 'sharejs',
    version,
    content,
    ranges: { comments, changes: [] },
    rawSnapshot: content,
  }
}

function historyDocument(resolved: boolean, version: number): JoinedDocument {
  const snapshot = {
    content: 'hello',
    comments: [
      {
        id: 'open',
        ranges: [{ pos: 1, length: 2 }],
        resolved,
      },
    ],
    trackedChanges: [],
  }
  return {
    docId: 'doc1',
    protocol: 'history-ot',
    version,
    content: 'hello',
    ranges: null,
    rawSnapshot: snapshot,
  }
}

// A fixture that is an Error is thrown by that join instead of returned.
function connectionHarness(documents: Array<JoinedDocument | Error>, submitError?: McpError) {
  const connection = {
    queue: new FifoQueue(),
    getTree: () => tree,
    joinDocument: vi.fn(async (): Promise<JoinedDocument> => {
      const value = documents.shift()
      if (!value) throw new Error('no document fixture')
      if (value instanceof Error) throw value
      return value
    }),
    leaveDocument: vi.fn(async () => undefined),
    submitUpdate: vi.fn(async () => {
      if (submitError) throw submitError
    }),
    trackChangesActive: false,
  }
  const connections = {
    withConnection: async <T>(_projectId: string, operation: (value: typeof connection) => Promise<T>) =>
      await operation(connection),
    invalidate: vi.fn(async () => undefined),
  }
  return { connection, connections }
}

describe('review comments API', () => {
  test('lists open threads and lazily joins only documents with matching ranges', async () => {
    const http = {
      getJson: vi.fn(async (path: string) => {
        if (path.endsWith('/threads')) return threads
        return [
          {
            id: 'doc1',
            ranges: {
              comments: [{ op: { p: 2, c: 'bc', t: 'open' } }],
              changes: [],
            },
          },
          {
            id: 'doc2',
            ranges: {
              comments: [{ op: { p: 0, c: 'x', t: 'resolved' }, resolved: true }],
              changes: [],
            },
          },
        ]
      }),
      postJson: vi.fn(),
      deleteJson: vi.fn(),
    }
    const { connection, connections } = connectionHarness([
      shareDocument('a\nbcde', 1, [{ op: { p: 2, c: 'bc', t: 'open' } }]),
    ])
    const api = new CommentsApi(http, connections, { currentUserId: 'user' })

    const result = await api.listComments('project')

    expect(result.positionsUnavailable).toBe(false)
    expect(result.threads).toEqual([
      expect.objectContaining({
        id: 'open',
        filePath: 'main.tex',
        quotedText: 'bc',
        start: { line: 2, column: 1 },
        end: { line: 2, column: 3 },
      }),
    ])
    expect(connection.joinDocument).toHaveBeenCalledTimes(1)
    expect(connection.joinDocument).toHaveBeenCalledWith('doc1')
  })

  test('maps threads to authors with display names and never returns an email', async () => {
    const http = {
      getJson: vi.fn(async (path: string) => {
        if (path.endsWith('/threads')) return threads
        throw new McpError('NOT_FOUND', 'no ranges')
      }),
      postJson: vi.fn(),
      deleteJson: vi.fn(),
    }
    const { connections } = connectionHarness([])
    const api = new CommentsApi(http, connections)

    const result = await api.listComments('project', { status: 'all' })

    expect(result.threads).toEqual([
      {
        id: 'open',
        status: 'open',
        messages: [
          {
            id: 'm1',
            author: { id: 'reviewer', displayName: 'Ada Lovelace' },
            content: 'Please revise',
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        ],
        unlocated: true,
      },
      {
        id: 'resolved',
        status: 'resolved',
        messages: [],
        resolvedAt: '2026-01-02T00:00:00.000Z',
        resolvedBy: { id: 'owner', displayName: 'Grace Hopper' },
        unlocated: true,
      },
    ])
    expect(JSON.stringify(result)).not.toContain('@example.test')
  })

  test('filters by an author display name and not by email', async () => {
    const http = {
      getJson: vi.fn(async (path: string) => {
        if (path.endsWith('/threads')) return threads
        throw new McpError('NOT_FOUND', 'no ranges')
      }),
      postJson: vi.fn(),
      deleteJson: vi.fn(),
    }
    const { connections } = connectionHarness([])
    const api = new CommentsApi(http, connections)

    const byName = await api.listComments('project', { author: 'ada love' })
    const byId = await api.listComments('project', { author: 'reviewer' })
    const byEmail = await api.listComments('project', { author: 'ada@example' })

    expect(byName.threads.map(thread => thread.id)).toEqual(['open'])
    expect(byId.threads.map(thread => thread.id)).toEqual(['open'])
    expect(byEmail.threads).toEqual([])
  })

  test('does not join every document when the project range route is absent', async () => {
    const http = {
      getJson: vi.fn(async (path: string) => {
        if (path.endsWith('/threads')) return threads
        throw new McpError('NOT_FOUND', 'no ranges')
      }),
      postJson: vi.fn(),
      deleteJson: vi.fn(),
    }
    const { connection, connections } = connectionHarness([])
    const api = new CommentsApi(http, connections, { currentUserId: 'user' })

    const result = await api.listComments('project')

    expect(result.positionsUnavailable).toBe(true)
    expect(result.threads[0]).toMatchObject({ id: 'open', unlocated: true })
    expect(connection.joinDocument).not.toHaveBeenCalled()
  })

  test.each([
    ['HTTP 500', async () => await Promise.resolve(new Response('busy', { status: 500 }))],
    [
      'a network failure',
      async () => {
        throw new TypeError('fetch failed')
      },
    ],
  ])(
    'still lists threads unlocated when the range route keeps failing with %s through retries',
    async (_name, ranges) => {
      const rangeRequests = vi.fn(ranges)
      const http = new OverleafHttpClient({
        baseUrl: 'https://overleaf.test',
        jar: new CookieJar(),
        readAttempts: 3,
        sleep: async () => await Promise.resolve(),
        fetcher: async (url: string) => {
          if (url.endsWith('/threads')) {
            return new Response(JSON.stringify(threads), { headers: { 'content-type': 'application/json' } })
          }
          return await rangeRequests()
        },
      })
      const { connection, connections } = connectionHarness([])
      const api = new CommentsApi(http, connections, { currentUserId: 'user' })

      const result = await api.listComments('project')

      expect(result.positionsUnavailable).toBe(true)
      expect(result.threads[0]).toMatchObject({ id: 'open', unlocated: true })
      expect(rangeRequests).toHaveBeenCalledTimes(3)
      expect(connection.joinDocument).not.toHaveBeenCalled()
    }
  )

  test('joins a filePath document only once while resolving its matching threads', async () => {
    const http = {
      getJson: vi.fn(async () => threads),
      postJson: vi.fn(),
      deleteJson: vi.fn(),
    }
    const { connection, connections } = connectionHarness([
      shareDocument('a\nbcde', 1, [{ op: { p: 2, c: 'bc', t: 'open' } }]),
    ])
    const api = new CommentsApi(http, connections)

    const result = await api.listComments('project', { filePath: 'main.tex' })

    expect(result.threads).toHaveLength(1)
    expect(connection.joinDocument).toHaveBeenCalledOnce()
    expect(connection.leaveDocument).toHaveBeenCalledOnce()
  })

  function reply(id: string, timestamp: number) {
    return {
      id,
      content: 'My reply',
      user_id: 'user',
      user: { id: 'user', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test' },
      timestamp,
    }
  }

  test('returns the created reply message, not the whole thread', async () => {
    const now = Date.UTC(2026, 0, 1)
    const http = {
      postJson: vi.fn(async () => undefined),
      getJson: vi
        .fn()
        .mockResolvedValueOnce(threads)
        .mockResolvedValueOnce({
          ...threads,
          open: { messages: [...threads.open.messages, reply('m2', now)] },
        }),
      deleteJson: vi.fn(),
    }
    const { connections } = connectionHarness([])
    const api = new CommentsApi(http, connections, { currentUserId: 'user', now: () => now })

    const result = await api.replyToComment('project', 'open', 'My reply')

    expect(http.postJson).toHaveBeenCalledWith('/project/project/thread/open/messages', { content: 'My reply' })
    expect(result).toEqual({
      threadId: 'open',
      message: {
        id: 'm2',
        author: { id: 'user', displayName: 'Ada Lovelace' },
        content: 'My reply',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      trackChangesActive: false,
      writeMode: 'untracked',
    })
  })

  test('reads trackChangesActive before posting, so a failed project join posts no reply', async () => {
    const http = {
      postJson: vi.fn(async () => undefined),
      getJson: vi.fn(async () => threads),
      deleteJson: vi.fn(),
    }
    const connections = {
      withConnection: vi.fn(async () => {
        throw new McpError('REMOTE_ERROR', 'join cut off', {
          retryable: true,
          details: { reason: 'disconnected' },
        })
      }),
      invalidate: vi.fn(async () => undefined),
    }
    const api = new CommentsApi(http, connections, { currentUserId: 'user' })

    await expect(api.replyToComment('project', 'open', 'My reply')).rejects.toMatchObject({
      code: 'REMOTE_ERROR',
      retryable: true,
    })
    expect(http.postJson).not.toHaveBeenCalled()
  })

  test('refuses a reply to a thread that does not exist before posting anything', async () => {
    const http = {
      postJson: vi.fn(),
      getJson: vi.fn(async () => threads),
      deleteJson: vi.fn(),
    }
    const { connections } = connectionHarness([])
    const api = new CommentsApi(http, connections, { currentUserId: 'user' })

    await expect(api.replyToComment('project', 'missing', 'My reply')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { threadId: 'missing' },
    })
    expect(http.postJson).not.toHaveBeenCalled()
  })

  test('recovers a timed-out reply by matching the current user, content, and time window', async () => {
    const now = Date.now()
    const http = {
      postJson: vi.fn(async () => {
        throw new McpError('TIMEOUT', 'request timed out')
      }),
      getJson: vi
        .fn()
        .mockResolvedValueOnce({ open: { messages: [] } })
        .mockResolvedValueOnce({ open: { messages: [reply('new-message', now + 1)] } }),
      deleteJson: vi.fn(),
    }
    const { connections } = connectionHarness([])
    const api = new CommentsApi(http, connections, {
      currentUserId: 'user',
      now: () => now,
    })

    await expect(api.replyToComment('project', 'open', 'My reply')).resolves.toMatchObject({
      message: { id: 'new-message', content: 'My reply' },
      recoveredAfterTimeout: true,
      trackChangesActive: false,
      writeMode: 'untracked',
    })
  })

  test('does not take an identical earlier reply as proof that a timed-out reply applied', async () => {
    const now = Date.now()
    const earlier = { open: { messages: [reply('earlier', now)] } }
    const http = {
      postJson: vi.fn(async () => {
        throw new McpError('TIMEOUT', 'request timed out')
      }),
      getJson: vi.fn(async () => earlier),
      deleteJson: vi.fn(),
    }
    const { connections } = connectionHarness([])
    const api = new CommentsApi(http, connections, { currentUserId: 'user', now: () => now })

    await expect(api.replyToComment('project', 'open', 'My reply')).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    })
    expect(http.postJson).toHaveBeenCalledOnce()
  })

  test('creates a thread, attaches its range, and returns the verified revision', async () => {
    const before = shareDocument('hello', 1)
    const after = shareDocument('hello', 2, [{ op: { p: 1, c: 'el', t: 'thread' } }])
    const { connection, connections } = connectionHarness([before, after])
    const http = {
      getJson: vi.fn(async () => ({
        thread: {
          messages: [
            {
              id: 'message',
              content: 'Review this',
              timestamp: Date.UTC(2026, 0, 1),
              user_id: 'user',
              user: { id: 'user', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test' },
            },
          ],
        },
      })),
      postJson: vi.fn(async () => ({ id: 'message' })),
      deleteJson: vi.fn(async () => ({})),
    }
    const api = new CommentsApi(http, connections, {
      currentUserId: 'user',
      threadIdFactory: () => 'thread',
    })
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc1',
      protocol: 'sharejs',
      otVersion: 1,
      content: 'hello',
    })

    const result = await api.addComment({
      projectId: 'project',
      filePath: 'main.tex',
      revision,
      start: { line: 1, column: 2 },
      end: { line: 1, column: 4 },
      expectedText: 'el',
      content: 'Review this',
    })

    expect(http.postJson).toHaveBeenCalledWith('/project/project/thread/thread/messages', { content: 'Review this' })
    expect(connection.submitUpdate).toHaveBeenCalledWith('doc1', {
      doc: 'doc1',
      v: 1,
      op: [{ p: 1, c: 'el', t: 'thread' }],
    })
    expect(result).toMatchObject({ threadId: 'thread', writeMode: 'untracked' })
    expect(result.revision).toEqual(expect.any(String))
    expect(result.thread).toEqual({
      id: 'thread',
      status: 'open',
      messages: [
        {
          id: 'message',
          author: { id: 'user', displayName: 'Ada Lovelace' },
          content: 'Review this',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
  })

  test('polls for a late comment attachment before considering orphan cleanup', async () => {
    const before = shareDocument('hello', 1)
    const unchanged = shareDocument('hello', 1)
    const attached = shareDocument('hello', 2, [{ op: { p: 1, c: 'el', t: 'thread' } }])
    const { connections } = connectionHarness([before, unchanged, attached], new McpError('TIMEOUT', 'apply timeout'))
    const http = {
      getJson: vi.fn(async () => ({ thread: { messages: [] } })),
      postJson: vi.fn(async () => ({ id: 'message' })),
      deleteJson: vi.fn(async () => ({})),
    }
    const api = new CommentsApi(http, connections, {
      threadIdFactory: () => 'thread',
      recoveryTimeoutMs: 20,
      recoveryPollIntervalMs: 0,
    })
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc1',
      protocol: 'sharejs',
      otVersion: 1,
      content: 'hello',
    })

    await expect(
      api.addComment({
        projectId: 'project',
        filePath: 'main.tex',
        revision,
        start: { line: 1, column: 2 },
        end: { line: 1, column: 4 },
        expectedText: 'el',
        content: 'Review this',
      })
    ).resolves.toMatchObject({ recoveredAfterTimeout: true })
    expect(http.deleteJson).not.toHaveBeenCalled()
  })

  function addCommentInput() {
    return {
      projectId: 'project',
      filePath: 'main.tex',
      revision: createRevision({
        projectId: 'project',
        docId: 'doc1',
        protocol: 'sharejs',
        otVersion: 1,
        content: 'hello',
      }),
      start: { line: 1, column: 2 },
      end: { line: 1, column: 4 },
      expectedText: 'el',
      content: 'Review this',
    }
  }

  test('observes an attachment whose socket failed after it was sent, and keeps the thread', async () => {
    const attached = shareDocument('hello', 2, [{ op: { p: 1, c: 'el', t: 'thread' } }])
    const { connection, connections } = connectionHarness(
      [shareDocument('hello', 1), attached],
      new McpError('OUTCOME_UNKNOWN', 'socket closed')
    )
    const http = {
      getJson: vi.fn(async () => ({ thread: { messages: [] } })),
      postJson: vi.fn(async () => ({ id: 'message' })),
      deleteJson: vi.fn(async () => ({})),
    }
    const api = new CommentsApi(http, connections, {
      threadIdFactory: () => 'thread',
      recoveryTimeoutMs: 20,
      recoveryPollIntervalMs: 0,
    })

    await expect(api.addComment(addCommentInput())).resolves.toMatchObject({
      threadId: 'thread',
      recoveredAfterTimeout: true,
    })
    expect(connections.invalidate).toHaveBeenCalledWith('project')
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
    expect(http.postJson).toHaveBeenCalledOnce()
    expect(http.deleteJson).not.toHaveBeenCalled()
  })

  test('reports an attachment cut off by a lost socket as not applied only after observing it absent', async () => {
    const { connection, connections } = connectionHarness(
      [shareDocument('hello', 1), ...Array.from({ length: 50 }, () => shareDocument('hello', 1))],
      new McpError('OUTCOME_UNKNOWN', 'socket closed')
    )
    const http = {
      getJson: vi.fn(async () => ({ thread: { messages: [] } })),
      postJson: vi.fn(async () => ({ id: 'message' })),
      deleteJson: vi.fn(async () => ({})),
    }
    const api = new CommentsApi(http, connections, {
      threadIdFactory: () => 'thread',
      recoveryTimeoutMs: 0,
      recoveryPollIntervalMs: 0,
    })

    await expect(api.addComment(addCommentInput())).rejects.toMatchObject({
      code: 'REMOTE_ERROR',
      retryable: false,
      details: { threadId: 'thread', outcome: 'not_applied' },
    })
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
    expect(http.deleteJson).toHaveBeenCalledOnce()
  })

  test('observes an applied attachment whose verification read lost the socket', async () => {
    const lost = new McpError('REMOTE_ERROR', 'socket closed', {
      retryable: true,
      details: { event: 'joinDoc', reason: 'disconnected' },
    })
    const attached = shareDocument('hello', 2, [{ op: { p: 1, c: 'el', t: 'thread' } }])
    const { connection, connections } = connectionHarness([shareDocument('hello', 1), lost, attached])
    const http = {
      getJson: vi.fn(async () => ({ thread: { messages: [] } })),
      postJson: vi.fn(async () => ({ id: 'message' })),
      deleteJson: vi.fn(async () => ({})),
    }
    const api = new CommentsApi(http, connections, {
      threadIdFactory: () => 'thread',
      recoveryTimeoutMs: 20,
      recoveryPollIntervalMs: 0,
    })

    await expect(api.addComment(addCommentInput())).resolves.toMatchObject({
      threadId: 'thread',
      recoveredAfterTimeout: true,
    })
    expect(connections.invalidate).toHaveBeenCalledWith('project')
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
    expect(http.postJson).toHaveBeenCalledOnce()
    expect(http.deleteJson).not.toHaveBeenCalled()
  })

  test('never reports an applied attachment as retryable when it cannot be observed', async () => {
    const lost = new McpError('REMOTE_ERROR', 'socket closed', {
      retryable: true,
      details: { event: 'joinDoc', reason: 'disconnected' },
    })
    const { connections } = connectionHarness([shareDocument('hello', 1), lost])
    const http = {
      getJson: vi.fn(async () => ({ thread: { messages: [] } })),
      postJson: vi.fn(async () => ({ id: 'message' })),
      deleteJson: vi.fn(async () => ({})),
    }
    const api = new CommentsApi(http, connections, {
      threadIdFactory: () => 'thread',
      recoveryTimeoutMs: 0,
      recoveryPollIntervalMs: 0,
    })

    await expect(api.addComment(addCommentInput())).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      retryable: false,
      details: { threadId: 'thread' },
    })
    expect(http.deleteJson).not.toHaveBeenCalled()
  })

  test('resolves a ShareJS thread anchored in the named document', async () => {
    const anchored = [{ op: { p: 1, c: 'el', t: 'open' } }]
    const { connections } = connectionHarness([
      shareDocument('hello', 1, anchored),
      shareDocument('hello', 1, anchored),
    ])
    const http = {
      getJson: vi.fn(async () => ({ open: { ...threads.open, resolved: true } })),
      postJson: vi.fn(async () => undefined),
      deleteJson: vi.fn(),
    }
    const api = new CommentsApi(http, connections)
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc1',
      protocol: 'sharejs',
      otVersion: 1,
      content: 'hello',
    })

    await expect(
      api.setCommentStatus({
        projectId: 'project',
        filePath: 'main.tex',
        revision,
        threadId: 'open',
        status: 'resolved',
      })
    ).resolves.toMatchObject({ threadId: 'open', status: 'resolved' })
    expect(http.postJson).toHaveBeenCalledWith('/project/project/doc/doc1/thread/open/resolve', {})
  })

  test.each<['sharejs' | 'history-ot', JoinedDocument]>([
    ['sharejs', shareDocument('hello', 1)],
    [
      'history-ot',
      { ...historyDocument(false, 1), rawSnapshot: { content: 'hello', comments: [], trackedChanges: [] } },
    ],
  ])('refuses a %s status change for a thread not anchored in filePath', async (protocol, document) => {
    const { connection, connections } = connectionHarness([document])
    const http = {
      getJson: vi.fn(async () => threads),
      postJson: vi.fn(),
      deleteJson: vi.fn(),
    }
    const api = new CommentsApi(http, connections)
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc1',
      protocol,
      otVersion: 1,
      content: 'hello',
    })

    await expect(
      api.setCommentStatus({
        projectId: 'project',
        filePath: 'main.tex',
        revision,
        threadId: 'open',
        status: 'resolved',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', details: { threadId: 'open' } })
    expect(http.postJson).not.toHaveBeenCalled()
    expect(connection.submitUpdate).not.toHaveBeenCalled()
    expect(connection.leaveDocument).toHaveBeenCalledWith('doc1')
  })

  test('recovers a timed-out history-OT status update from the verified live state', async () => {
    const { connections } = connectionHarness(
      [historyDocument(false, 1), historyDocument(true, 2)],
      new McpError('TIMEOUT', 'apply timeout')
    )
    const http = {
      getJson: vi.fn(async () => threads),
      postJson: vi.fn(),
      deleteJson: vi.fn(),
    }
    const api = new CommentsApi(http, connections, {
      recoveryTimeoutMs: 0,
      recoveryPollIntervalMs: 0,
    })
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc1',
      protocol: 'history-ot',
      otVersion: 1,
      content: 'hello',
    })

    await expect(
      api.setCommentStatus({
        projectId: 'project',
        filePath: 'main.tex',
        revision,
        threadId: 'open',
        status: 'resolved',
      })
    ).resolves.toMatchObject({
      status: 'resolved',
      recoveredAfterTimeout: true,
    })
  })

  function statusInput(protocol: 'sharejs' | 'history-ot' = 'history-ot') {
    return {
      projectId: 'project',
      filePath: 'main.tex',
      revision: createRevision({
        projectId: 'project',
        docId: 'doc1',
        protocol,
        otVersion: 1,
        content: 'hello',
      }),
      threadId: 'open',
      status: 'resolved' as const,
    }
  }

  test('observes an applied status change whose verification read lost the socket', async () => {
    const lost = new McpError('REMOTE_ERROR', 'socket closed', {
      retryable: true,
      details: { event: 'joinDoc', reason: 'disconnected' },
    })
    const { connection, connections } = connectionHarness([historyDocument(false, 1), lost, historyDocument(true, 2)])
    const http = {
      getJson: vi.fn(async () => threads),
      postJson: vi.fn(),
      deleteJson: vi.fn(),
    }
    const api = new CommentsApi(http, connections, {
      recoveryTimeoutMs: 20,
      recoveryPollIntervalMs: 0,
    })

    await expect(api.setCommentStatus(statusInput())).resolves.toMatchObject({
      status: 'resolved',
      recoveredAfterTimeout: true,
    })
    expect(connections.invalidate).toHaveBeenCalledWith('project')
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
  })

  // Its anchored text was deleted, so the snapshot keeps the comment with no range.
  function rangelessHistoryDocument(resolved: boolean, version: number): JoinedDocument {
    return {
      ...historyDocument(resolved, version),
      rawSnapshot: { content: 'hello', comments: [{ id: 'open', ranges: [], resolved }], trackedChanges: [] },
    }
  }

  test.each<[string, McpError | undefined]>([
    ['a confirmed', undefined],
    ['a timed-out', new McpError('TIMEOUT', 'apply timeout')],
  ])('verifies %s status change of a history-OT comment with no range from its snapshot', async (_, submitError) => {
    const { connection, connections } = connectionHarness(
      [rangelessHistoryDocument(false, 1), rangelessHistoryDocument(true, 2)],
      submitError
    )
    // The REST thread still reads open: history-OT keeps the status in the snapshot.
    const http = {
      getJson: vi.fn(async () => threads),
      postJson: vi.fn(),
      deleteJson: vi.fn(),
    }
    const api = new CommentsApi(http, connections, {
      recoveryTimeoutMs: 0,
      recoveryPollIntervalMs: 0,
    })

    await expect(api.setCommentStatus(statusInput())).resolves.toMatchObject({
      threadId: 'open',
      status: 'resolved',
    })
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
    expect(http.postJson).not.toHaveBeenCalled()
  })

  test('reports a status change cut off by a lost socket as not applied, without retry', async () => {
    const { connection, connections } = connectionHarness(
      Array.from({ length: 50 }, () => historyDocument(false, 1)),
      new McpError('OUTCOME_UNKNOWN', 'socket closed')
    )
    const http = {
      getJson: vi.fn(async () => threads),
      postJson: vi.fn(),
      deleteJson: vi.fn(),
    }
    const api = new CommentsApi(http, connections, {
      recoveryTimeoutMs: 0,
      recoveryPollIntervalMs: 0,
    })

    await expect(api.setCommentStatus(statusInput())).rejects.toMatchObject({
      code: 'REMOTE_ERROR',
      retryable: false,
      details: { threadId: 'open', outcome: 'not_applied' },
    })
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
  })

  // Overleaf's Comment.toRaw writes resolved: true for a resolved comment and leaves the key out for an open one.
  function overleafHistoryDocument(
    resolved: boolean,
    version: number,
    ranges: Array<{ pos: number; length: number }>
  ): JoinedDocument {
    return {
      ...historyDocument(resolved, version),
      rawSnapshot: {
        content: 'hello',
        comments: [{ id: 'open', ranges, ...(resolved ? { resolved: true } : {}) }],
        trackedChanges: [],
      },
    }
  }

  test.each<[string, Array<{ pos: number; length: number }>, McpError | undefined]>([
    ['a confirmed reopen of a comment with no range', [], undefined],
    ['a timed-out reopen of a comment with no range', [], new McpError('TIMEOUT', 'apply timeout')],
    ['a confirmed reopen of an anchored comment', [{ pos: 1, length: 2 }], undefined],
    ['a timed-out reopen of an anchored comment', [{ pos: 1, length: 2 }], new McpError('TIMEOUT', 'apply timeout')],
  ])('verifies %s from a history-OT snapshot that leaves resolved out', async (_, ranges, submitError) => {
    const { connection, connections } = connectionHarness(
      [overleafHistoryDocument(true, 1, ranges), overleafHistoryDocument(false, 2, ranges)],
      submitError
    )
    // The REST thread still reads resolved: history-OT keeps the status in the snapshot.
    const http = {
      getJson: vi.fn(async () => ({ open: { ...threads.open, resolved: true } })),
      postJson: vi.fn(),
      deleteJson: vi.fn(),
    }
    const api = new CommentsApi(http, connections, {
      recoveryTimeoutMs: 0,
      recoveryPollIntervalMs: 0,
    })

    await expect(api.setCommentStatus({ ...statusInput(), status: 'open' })).resolves.toMatchObject({
      threadId: 'open',
      status: 'open',
    })
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
    expect(http.postJson).not.toHaveBeenCalled()
  })

  test.each<['sharejs' | 'history-ot', JoinedDocument]>([
    ['sharejs', shareDocument('hello', 1, [{ op: { p: 1, c: 'el', t: 'open' } }])],
    ['history-ot', historyDocument(false, 1)],
  ])(
    'never reports a confirmed %s status change as not applied when its verification read failed',
    async (protocol, document) => {
      const lost = new McpError('REMOTE_ERROR', 'socket closed', {
        retryable: true,
        details: { event: 'joinDoc', reason: 'disconnected' },
      })
      // Every observation still shows the thread open, as if a collaborator reopened it meanwhile.
      const { connection, connections } = connectionHarness([
        document,
        lost,
        ...Array.from({ length: 50 }, () => document),
      ])
      const http = {
        getJson: vi.fn(async () => threads),
        postJson: vi.fn(async () => ({})),
        deleteJson: vi.fn(),
      }
      const api = new CommentsApi(http, connections, {
        recoveryTimeoutMs: 0,
        recoveryPollIntervalMs: 0,
      })

      const error = await api.setCommentStatus(statusInput(protocol)).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(McpError)
      expect(error).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: false, details: { threadId: 'open' } })
      expect((error as McpError).details).not.toHaveProperty('outcome')
      expect(connection.submitUpdate.mock.calls.length + http.postJson.mock.calls.length).toBe(1)
    }
  )

  test('never cleans up or reports as not applied a confirmed attachment whose verification read failed', async () => {
    const lost = new McpError('REMOTE_ERROR', 'socket closed', {
      retryable: true,
      details: { event: 'joinDoc', reason: 'disconnected' },
    })
    const { connection, connections } = connectionHarness([
      shareDocument('hello', 1),
      lost,
      ...Array.from({ length: 50 }, () => shareDocument('hello', 1)),
    ])
    const http = {
      getJson: vi.fn(async () => ({ thread: { messages: [] } })),
      postJson: vi.fn(async () => ({ id: 'message' })),
      deleteJson: vi.fn(async () => ({})),
    }
    const api = new CommentsApi(http, connections, {
      threadIdFactory: () => 'thread',
      recoveryTimeoutMs: 0,
      recoveryPollIntervalMs: 0,
    })

    const error = await api.addComment(addCommentInput()).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: false, details: { threadId: 'thread' } })
    expect((error as McpError).details).not.toHaveProperty('outcome')
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
    expect(http.deleteJson).not.toHaveBeenCalled()
  })

  // What the HTTP client throws for a 429: retryable, which after a sent write would invite a resend.
  function rateLimited(): McpError {
    return new McpError('RATE_LIMITED', 'Overleaf rate-limited this request.', {
      retryable: true,
      details: { status: 429, path: '/project/project/threads' },
    })
  }

  test.each<[string, () => Promise<unknown>]>([
    ['an accepted', async () => undefined],
    [
      'a timed-out',
      async () => {
        throw new McpError('TIMEOUT', 'request timed out', { retryable: true })
      },
    ],
  ])('a reply whose read-back fails after %s post is OUTCOME_UNKNOWN, never retryable', async (_, post) => {
    const http = {
      postJson: vi.fn(post),
      getJson: vi.fn().mockResolvedValueOnce(threads).mockRejectedValueOnce(rateLimited()),
      deleteJson: vi.fn(),
    }
    const { connections } = connectionHarness([])
    // A current user, so a timed-out post is recovered by reading the thread back.
    const api = new CommentsApi(http, connections, { currentUserId: 'user' })

    const error = await api.replyToComment('project', 'open', 'My reply').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: false, details: { threadId: 'open' } })
    expect(http.postJson).toHaveBeenCalledOnce()
    // Read before the post, and once after it.
    expect(http.getJson).toHaveBeenCalledTimes(2)
  })

  test('returns a verified comment without its thread when the thread cannot be read back', async () => {
    const { connection, connections } = connectionHarness([
      shareDocument('hello', 1),
      shareDocument('hello', 2, [{ op: { p: 1, c: 'el', t: 'thread' } }]),
    ])
    const http = {
      getJson: vi.fn(async () => {
        throw rateLimited()
      }),
      postJson: vi.fn(async () => ({ id: 'message' })),
      deleteJson: vi.fn(async () => ({})),
    }
    const api = new CommentsApi(http, connections, { currentUserId: 'user', threadIdFactory: () => 'thread' })

    const result = await api.addComment(addCommentInput())

    expect(result).toEqual({
      threadId: 'thread',
      revision: expect.any(String),
      protocol: 'sharejs',
      trackChangesActive: false,
      writeMode: 'untracked',
    })
    expect(result).not.toHaveProperty('thread')
    expect(http.getJson).toHaveBeenCalledOnce()
    expect(http.postJson).toHaveBeenCalledOnce()
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
    expect(http.deleteJson).not.toHaveBeenCalled()
  })

  test('a timed-out thread creation that cannot be read back is OUTCOME_UNKNOWN, with nothing attached', async () => {
    const { connection, connections } = connectionHarness([shareDocument('hello', 1)])
    const http = {
      getJson: vi.fn(async () => {
        throw rateLimited()
      }),
      postJson: vi.fn(async () => {
        throw new McpError('TIMEOUT', 'request timed out', { retryable: true })
      }),
      deleteJson: vi.fn(async () => ({})),
    }
    const api = new CommentsApi(http, connections, { currentUserId: 'user', threadIdFactory: () => 'thread' })

    const error = await api.addComment(addCommentInput()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: false, details: { threadId: 'thread' } })
    expect(http.getJson).toHaveBeenCalledOnce()
    expect(http.postJson).toHaveBeenCalledOnce()
    expect(connection.submitUpdate).not.toHaveBeenCalled()
    expect(http.deleteJson).not.toHaveBeenCalled()
  })

  test('an applied ShareJS status change whose thread cannot be read back is OUTCOME_UNKNOWN', async () => {
    // No resolved flag on the range, so the status is verified from the REST threads.
    const anchored = [{ op: { p: 1, c: 'el', t: 'open' } }]
    const { connection, connections } = connectionHarness([
      shareDocument('hello', 1, anchored),
      shareDocument('hello', 1, anchored),
    ])
    const http = {
      getJson: vi.fn(async () => {
        throw rateLimited()
      }),
      postJson: vi.fn(async () => undefined),
      deleteJson: vi.fn(),
    }
    const api = new CommentsApi(http, connections)

    const error = await api.setCommentStatus(statusInput('sharejs')).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: false, details: { threadId: 'open' } })
    expect((error as McpError).details).not.toHaveProperty('outcome')
    expect(http.postJson).toHaveBeenCalledOnce()
    expect(http.postJson).toHaveBeenCalledWith('/project/project/doc/doc1/thread/open/resolve', {})
    expect(http.getJson).toHaveBeenCalledOnce()
    expect(connection.submitUpdate).not.toHaveBeenCalled()
  })
})
