# Private API catalogue

Every Overleaf route the server calls, with the request fields it sends and the response fields it
reads. These are the browser-facing endpoints of Overleaf's open-source web service
(`overleaf/overleaf`, `services/web/app/src/router.mjs`), reached through the saved web session
and its CSRF token. None of them is a public or documented API, so this page is the contract the
server assumes and the first place to look when Overleaf changes something.

Responses are private API shapes. The server reads only the fields listed here, validates the
ones it depends on, and never logs or returns a response body. Where a response is validated, an
unexpected shape surfaces as `PROTOCOL_UNSUPPORTED` rather than a parse exception.

## Session and bootstrap

| Method and route | Sent | Read | Notes |
| --- | --- | --- | --- |
| `GET /project` | session cookie | `<meta name="ol-csrfToken">`, `ol-user_id`, `ol-maxDocLength` from the HTML | Runs once at startup. A missing or empty CSRF token on a page with no signed-in user means the session expired (`AUTH_EXPIRED`); on a page that names one (`ol-user_id`) it is `PROTOCOL_UNSUPPORTED` with `details.kind: "response_shape"`. |
| `GET /socket.io/1/?...` and `WS /socket.io/1/websocket/:sessionId` | session cookie, `projectId` | Socket.IO 0.9 handshake, then the `joinProject` payload: `project.rootFolder`, `rootDoc_id`, `compiler`, `imageName`, `spellCheckLanguage`, `trackChangesState`, `features.trackChanges`, `features.trackChangesVisible`, `permissionsLevel`, `protocolVersion` | One cached socket per project; document text goes over this channel as OT. Each join counts against web's join-project limiter: 45 a minute for one user on one project. Past it the socket sends `connectionRejected` `{ message: "rate-limit hit when joining project", code: "TooManyRequests" }` (captured live), reported as `RATE_LIMITED` with `details.reason: "join_rate_limited"`. |

## Projects

| Method and route | Sent | Read | Used by |
| --- | --- | --- | --- |
| `POST /api/project` | `{}` | `totalSize`, `projects[]` with `_id` or `id`, `name`, `accessLevel`, `lastUpdated`, `archived`, `trashed` (validated) | `list_projects`, `auth_status`, and the name and trashed check behind `manage_project` |
| `POST /project/new` | `{ projectName, template }` where `template` is `example` or `none` | `project_id` (validated) | `create_project` |
| `POST /Project/:id/clone` | `{ projectName }` | `project_id` (validated) | `clone_project` |
| `POST /project/new/upload` | multipart `qqfile` (the archive) and `name` | `project_id` (validated); `{ success: false, error }` or HTTP 422 with a short `error` code on rejection; HTTP 429 when throttled | `import_project_zip` |
| `POST /project/:id/rename` | `{ newProjectName }` | nothing | `manage_project` `rename` |
| `POST /project/:id/settings` | one of `compiler`, `imageName`, `spellCheckLanguage`, `rootDocId` per request, sent in that order (the order Overleaf applies them) | nothing; the server re-joins the project to report the persisted values | `update_project_settings` |
| `POST /project/:id/trash`, `DELETE /project/:id/trash` | nothing | nothing | `manage_project` `trash`, `restore` |
| `POST /Project/:id/archive`, `DELETE /Project/:id/archive` | nothing | nothing | `manage_project` `archive`, `unarchive` |
| `DELETE /Project/:id` | nothing | nothing | `manage_project` `delete`; the server only sends it for a project the list reports as trashed |
| `GET /Project/:id/download/zip` | nothing | the archive's bytes, streamed to a temporary file and checked for a zip signature at the start and a zip end record at the end; `Content-Type` only when the bytes are not a zip; HTTP 429 without `Retry-After` past about 10 a minute per project; HTTP 403, not a login redirect, for an expired session | `download_project_zip` |

The capitalised `/Project/` prefix is Overleaf's own; both spellings are live routes.

## Tags

Confirmed in `services/web` `app/src/router.mjs`, `Features/Tags/TagsController.mjs`,
`TagsHandler.mjs`, and `models/Tag.mjs`. Every tag route needs a signed-in session, and tags
belong to the signed-in user. Each change route is rate-limited to 30 requests a minute;
`POST /tag/:tagId/edit` shares its limiter with `POST /tag/:tagId/rename`, and `GET /tag` has none.

| Method and route | Sent | Read | Used by |
| --- | --- | --- | --- |
| `GET /tag` | nothing | `[{ _id, name, color?, project_ids }]` (validated; `user_id` and `__v` are ignored) | `list_projects` with `includeTags` or `tag`, and the checks before and after every `manage_tags` change |
| `POST /tag` | `{ name, color? }` | the created tag's `_id`; the read-back finds it by name | `manage_tags` `create` |
| `POST /tag/:tagId/edit` | `{ name, color? }` | nothing (204) | `manage_tags` `edit` |
| `DELETE /tag/:tagId` | nothing | nothing (204) | `manage_tags` `delete` |
| `POST /tag/:tagId/projects` | `{ projectIds }` | nothing (204) | `manage_tags` `add_projects` |
| `POST /tag/:tagId/projects/remove` | `{ projectIds }` | nothing (204) | `manage_tags` `remove_projects` |

Names are at most 50 characters (`MAX_TAG_LENGTH`). A colour must match `TAG_COLOR_REGEX`:
`#rrggbb` or `hsl(<h>, 70%, 45%)`. `edit` stores the colour it is given, so leaving `color` out
would clear it; the server sends the current colour again. Every change route answers 204 even
when no tag of the user matched, and `add_projects` files any project id without checking access,
so the server reads the tags first, checks the tag and each project, and reads them again
afterwards. `POST /tag` with a name the user already has returns the existing tag; the server
refuses the duplicate before sending it. `POST /api/project` carries no tags; the dashboard reads
them from its page, and this server from `GET /tag`.

Overleaf builds the zip archive while it streams it, with no `Content-Length`, so a transfer cut
short arrives with HTTP 200; only the missing end record shows it. A file Overleaf fails to read
while building the archive is left out without an error.

## Files and folders

| Method and route | Sent | Read | Used by |
| --- | --- | --- | --- |
| `POST /project/:id/doc` | `{ parent_folder_id, name }` | `_id` | `create_file` |
| `POST /project/:id/folder` | `{ parent_folder_id, name }` | `_id`; HTTP 429 past about 60 a minute per project | `manage_entity` `create_folder` |
| `POST /project/:id/:type/:entityId/rename` | `{ name }` | nothing | `manage_entity` `rename` |
| `POST /project/:id/:type/:entityId/move` | `{ folder_id }` | nothing | `manage_entity` `move` |
| `DELETE /project/:id/:type/:entityId` | nothing | nothing | `manage_entity` `delete`; deleting a folder removes its subtree |
| `POST /project/:id/upload?folder_id=` | multipart `qqfile` and `name` | `success`, `entity_id`, `entity_type`, `hash`; HTTP 422 with a short `error` code on rejection; HTTP 429 past about 500 a project in 15 minutes | `upload_file`, `batch_upload` |
| `GET /Project/:id/doc/:entityId/download`, `GET /Project/:id/file/:entityId` | nothing | raw bytes | `download_file` |

`plan_sync`, `sync_directory`, `delete_entities`, and `batch_upload` add no routes of their own. They are built
from the rows above and from the document channel: the tree comes from a fresh `joinProject`,
documents are read and written over OT exactly as for `read_file` and `write_file`, and files,
folders, and deletes use the same routes as `upload_file` and `manage_entity`.

An upload over an existing path replaces the entity. In Overleaf's source a text document
replacing a text document keeps its id and is updated as a diff, recorded as tracked changes when
track changes is on for the uploading user; a binary replacing a binary, and a document replacing
a binary or the reverse, become a new entity with a new id.

`:type` is `doc`, `file`, or `folder`. Rejection codes the server translates: `duplicate_file_name`
(a folder of the same name is in the way), `invalid_filename`, `project_has_too_many_files`,
`folder_not_found` (uploads); `invalid_zip_file`, `empty_zip_file`, `zip_contents_too_large` (zip
import). Only a value matching `^[a-z][a-z0-9_]{0,63}$` is ever propagated, under
`details.overleafError`.

## Compilation

| Method and route | Sent | Read | Used by |
| --- | --- | --- | --- |
| `POST /project/:id/compile?file_line_errors=true` | `{ rootDoc_id, rootResourcePath, check: "silent", incrementalCompilesEnabled: true }` (overleaf.com builds `rootResourcePath`, and the configured root without it), plus `stopOnFirstError: true` and `draft: true` when asked | `status`; `outputFiles[]` reduced to `path`, `type`, and `build`; numeric `stats`; `clsiServerId`; the user ID of a per-user compile, taken from `url` only when it has the shape `/project/<this project>/user/<id>/build/<this build>/output/` for every file that names one. Everything else, `url` itself, `timings`, and `pdfDownloadDomain` included, is dropped | `compile_project` |
| `GET /project/:id[/user/:userId]/build/:buildId/output/:file` | `/user/:userId` when the compile was per user (Overleaf CE and Server Pro by default); `?clsiserverid=` when the compile response named one | the output file: `output.log` and `.blg` logs, at most 1 MB, for the summary and `get_compile_log`; any output for `download_compile_output` | `compile_project`, `get_compile_log`, `download_compile_output`, the compile output resources |
| `POST /project/:id/compile/stop` | nothing | nothing | `stop_compile` |

`file_line_errors` makes TeX run with `-file-line-error`, so each error names its file as
`./path.tex:12: message`; the parser also reads the classic `! message` form with its `l.<n>`
marker. Overleaf's compile statuses (from `CompileManager`, `ClsiManager`, and the editor's
`local-compile-context`) are `success`, `failure`, `stopped-on-first-error`,
`too-recently-compiled`, `rate-limited`, `autocompile-backoff`, `compile-in-progress`,
`project-too-large`, `validation-problems`, `clsi-maintenance`, `unavailable`, `timedout`,
`terminated`, and `exited`; the [tool reference](tools.md#compile_project) maps each to a result
or an error code. The response carries no top-level build id: it is each output file's `build`,
validated as Overleaf does (`^[0-9a-f]+-[0-9a-f]+$`), as is `clsiServerId` (`^[a-z0-9-]+$`). The
output route is built from those and a checked file path, never from an output file's `url`,
which on overleaf.com points at a separate download domain. Overleaf keeps build output only for
a while; a 404 from the output route is `BUILD_NOT_FOUND`.

## Review

| Method and route | Sent | Read | Used by |
| --- | --- | --- | --- |
| `GET /project/:id/threads` | nothing | thread ids, messages, authors, resolution state | `list_comments` |
| `GET /project/:id/ranges` | nothing | a top-level array `[{ id, ranges }]` with each document's comment and tracked-change ranges, when the deployment exposes it | `list_comments`, `list_tracked_changes` without `filePath` |
| `POST /project/:id/thread/:threadId/messages` | `{ content }` | nothing | `add_comment`, `reply_to_comment` |
| `DELETE /project/:id/doc/:docId/thread/:threadId` | nothing | nothing | orphan cleanup after a failed `add_comment` attachment |
| `POST /project/:id/doc/:docId/thread/:threadId/resolve` and `/reopen` | nothing | nothing | `set_comment_status` on ShareJS documents |
| `POST /project/:id/doc/:docId/changes/accept` | `{ change_ids }` | the status only; the body is never read | `manage_tracked_changes` `accept` on ShareJS documents |

Comment and tracked-change ranges themselves travel over the OT channel, not REST. The `/ranges`
handler is not in Overleaf's public source. Live, it answers 200 with a `ranges` of `{}` for a
document without any, lists a change before the document is flushed, with the same id joinDoc
reports, and carries plain UTF-8 text and ISO timestamps (live, www.overleaf.com, 2026-10-30). It is
a hint for choosing which ShareJS documents to join, not an authority: ids and positions are taken
only from a fresh joinDoc. For a history-ot document its ids are drawn at random each time the
document is flushed (overleaf/overleaf e039ad2), so they never identify a change.

## Tracked changes

Recorded from Overleaf's source at overleaf/overleaf e039ad2 and checked live on a disposable
project (live, www.overleaf.com, 2026-10-30), except where an entry says it was not captured live.

**Accept, ShareJS documents.** `POST /project/:id/doc/:docId/changes/accept` with
`{ change_ids }` and the `x-csrf-token` header, as the editor sends it. The web handler is not in
the public source; it reaches document-updater's `/change/accept`, whose reply carries previews of
the document's text, so the server never reads or logs the body. Live, it answers 204 with an
empty body, leaves the version and the content unchanged, and removes the ids from the ranges.
Unknown or already accepted ids, an empty list, and a document with no changes all answer 204 as
well, so every id is checked against a fresh join before the post. An id that is not an ObjectId
answers 400, an unknown document 500, and an unknown route 404. In source document-updater refuses
a history-ot document with 422, and the server never sends this route for one. The sender's own
socket, like every other editor's, then receives `accept-changes(docId, changeIds)`.

**Reject, ShareJS documents.** There is no client route; the editor rejects with one OT update.
It carries no `meta`, so it is untracked, is sent at the version of a fresh join (the server drops
`u` when it transforms a stale update), and lists its components in ascending document order, each
position shifted by the components before it. A tracked insert is rejected with
`{ p, d: <inserted text>, u: true }`, a tracked delete with `{ p, i: <deleted text>, u: true }` at
the delete's `p`, and at equal `p` the `d` component comes first. Live, a delete, an insert, and a
replacement pair rejected in one update each restored the original text exactly and removed their
ids, with no new change. `POST /project/:id/doc/:docId/changes/reject` exists, but it is a
private, basic-auth route that document-updater calls to tell web that changes were rejected, not a
client route, and the server never calls it. Any ShareJS update that removes tracked changes sends
that notification, so a ShareJS reject may notify the change's author.

**`meta.tc`.** An 18-hex id seed, not the author. Tracking is on exactly when `tc` is present, the
author is the session's user, and the k-th change an update creates gets the id `tc` followed by
k as six hex digits, from `000001`. The server has sent a fresh seed on every tracked ShareJS write
since 0.6.2.

**Update validation and authorization** (confirmed in source at e039ad2, not captured live).
real-time validates `applyOtUpdate` strictly: `meta` may hold only `tc`, and a component only `p`,
`i`, `d`, `c`, `t`, and `u`; any other key disconnects the socket. The access level an update
needs follows its shape, and nothing forces tracking for a `review` member. A ShareJS op made only
of comment components needs view level (any member), one with `meta.tc` review level (`owner`,
`readAndWrite`, `review`), and any other edit level (`owner`, `readAndWrite`). A history-ot op
made only of plain retains, tracked inserts, and retains whose tracking is not `none` needs review
level; any other text operation (an untracked insert, a removal, or a retain that clears tracking)
needs edit level, and an op made only of comment additions needs view level. An unauthorized
update is answered `not authorized` and its socket disconnected.

**ShareJS change shape.** joinDoc's `ranges` is `{ changes?, comments? }`, and a change is
`{ id, op: { p, i } | { p, d }, metadata: { user_id, ts } }`. `p` counts UTF-16 units of the
decoded document and `ts` is an ISO string. `user_id` is an opaque string, which can be
`anonymous-user`, or null in the web types. `id` is missing on a change restored from history, and
`op` can carry other keys, such as `u` or `fixedRemoveChange`. A tracked insert that touches one by
the same user merges into it, keeping the first id and the older timestamp; inserts by different
users never merge. A tracked replacement is stored as an insert at `p` and a delete at `p` plus the
insert's length, and at equal `p` deletes sort before inserts. Live, a tracked
`[{ p, d: "foo" }, { p, i: "bar" }]` became the insert `{ p, i: "bar" }`, id `tc` + `000002`, and
the delete `{ p + 3, d: "foo" }`, id `tc` + `000001`.

**Range text encoding.** joinDoc with `encodeRanges: true` encodes a ShareJS document's `op.i`,
`op.d`, and `op.c` as it encodes the lines: the UTF-8 bytes read as Latin-1 (`Ã©` for `é`), decoded
the same way. `p`, ids, and metadata are not encoded, a history-ot snapshot is sent as is, and the
`/ranges` text is plain UTF-8, never decoded.

**History-ot documents** (confirmed in source at e039ad2, not captured live). The joinDoc snapshot
is `{ content, comments?, trackedChanges? }`, with a key left out when it is empty, and joinDoc's
`ranges` is `{}`. A tracked change is
`{ range: { pos, length }, tracking: { type: "insert" | "delete", userId, ts } }`, with no id;
positions are UTF-16 offsets into the raw content, which still holds tracked-deleted text. Ranges
never overlap, and ranges that touch with the same type and user merge, keeping the earliest
timestamp, but only once a TextOperation is applied. An update is
`{ doc, v, op: [{ textOperation: [...] }] }` with no `meta`: a positive integer retains, a
negative one removes, a string or `{ i, tracking?, commentIds? }` inserts, and
`{ r, tracking: { type: "none" } }` retains and clears tracking. Its base length must equal the raw
content length. A decision is one such update for all the chosen changes of a document, in
ascending raw position, retaining the gaps and ending with a retain to the raw length:

| Tracked change | accept | reject |
| --- | --- | --- |
| insert of n units | `{ r: n, tracking: { type: "none" } }` | `-n` |
| delete of n units | `-n` | `{ r: n, tracking: { type: "none" } }` |

It bumps the version, needs edit level, and sends no rejection notification.

**Project features.** joinProject's `project.features` are the project owner's.
`features.trackChanges` is the owner's track-changes feature, false by default in source.
`features.trackChangesVisible` is false in the public source and set only where the deployment has
the review module; live, both are true. `trackChangesState` is sent only when
`features.trackChanges` is true, as a boolean or a map of user ids to booleans, and the server
counts `true`, or `true` for the user, as on.

**`otUpdateError`.** real-time emits it from two places.

- `update is too large`, the exact first argument, comes from real-time itself: it acknowledges the
  update with success, emits `otUpdateError("update is too large", { project_id, doc_id, error })`
  about 100 ms later to the sender only, and disconnects it. Nothing is stored. Not captured live.
- An error from document-updater, such as `Invalid hash`, `Delete component does not match`,
  `doc ops range is not loaded in redis`, `too many comments or tracked changes`, or `Op too old`, is
  emitted to every socket that has joined the document, and each is disconnected. It can arrive
  after `otUpdateApplied`: live, a ShareJS update with a wrong hash was acknowledged, then
  `otUpdateError("Invalid hash", { project_id, doc_id, error, _id, message })` arrived, then the
  disconnect, and nothing was stored.
- `too many comments or tracked changes` is document-updater refusing an update that would leave
  the document with more than 2,000 tracked changes or more than 500 comments (`MAX_CHANGES` and
  `MAX_COMMENTS` in its `RangesManager`; overleaf/overleaf e039ad2), whether or not the update is
  tracked. A tracked write here counts a change for each deletion and each insertion it sends,
  and any write one more for an insertion strictly inside a tracked insertion, which
  `RangesTracker` splits in two when the insertion is untracked or by another author, and sends
  fewer, larger edits when the document would pass 2,000. Not captured live.

This server treats the first as `UPDATE_TOO_LARGE` with `details.outcome: "not_applied"`. Any
other `otUpdateError` for the document leaves the write unconfirmed: it may come from another
client's update or follow ours being applied, so the write is observed on a fresh connection and
never resent. Either way the socket is not reused. Before sending, an update is checked against
the account's access level as real-time checks it: an update of only comment ops needs view
access, one with `meta.tc` (ShareJS) or of only positive retains, tracked inserts, and retains
whose tracking is not `none` (history-OT) needs review access, and anything else needs edit
access (`owner` or `readAndWrite`).

## History

| Method and route | Sent | Read | Used by |
| --- | --- | --- | --- |
| `GET /project/:id/updates?min_count=25` | nothing | `updates[]` with version ranges, timestamps, and users (validated; email fields dropped) | `monitor_project_history` |

## HTTP status mapping

The HTTP client maps statuses before any tool sees them: 401 or a redirect to `/login` is
`AUTH_EXPIRED`, 403 is `PERMISSION_DENIED`, 404 is `NOT_FOUND`, 413 is `UPDATE_TOO_LARGE`, 429 is
`RATE_LIMITED` with `retryAfterMs` from `Retry-After` when present (the zip download sends
none), and anything else that is not successful is `REMOTE_ERROR` with `details.status`. Writes
are never retried on any of these.

Every id in a route is URI-encoded, and a project or thread id containing `/`, `\`, `.`, `?`,
`#`, or `%` is refused before a request is built. A path that would resolve to another origin
than `OVERLEAF_BASE_URL`'s is refused before it is sent. Reads follow redirects; a request that
changes something follows none, because fetch would carry the `x-csrf-token` header to another
origin: a redirect to `/login` is still `AUTH_EXPIRED`, any other is `REMOTE_ERROR` with the
status. A body that should be JSON and is not, such as an HTML page, is `PROTOCOL_UNSUPPORTED`
with `details.path` and `details.contentType`, never quoted. A rejection's `error` field reaches
`details.overleafError` only when it is a short lowercase code.

Socket errors (`connectionRejected`, a failed `joinDoc`, `leaveDoc`, or `applyOtUpdate`
acknowledgement, `otUpdateError`, and a Socket.IO error packet) are free text. Of that text, only
the error string can carry document content or ids: a comment mismatch quotes document text, and
`document not found: <docId>` names a document. Their text never reaches a caller: a message this
release recognizes becomes an identifier in `details.reason`, such as `invalid_session` or
`update_too_large`, and anything else is `unrecognized`. An `otUpdateError` payload's `project_id`,
`doc_id`, and host-derived `_id` are never surfaced either.

`connectionRejected` is classified by its `code`, when real-time attaches one, and then its
message, as real-time's `Router.js` and `WebApiManager.js` send them:

| Payload | Code | `details.reason` |
| --- | --- | --- |
| `invalid session` | `AUTH_EXPIRED` | `invalid_session` |
| `rate-limit hit when joining project`, code `TooManyRequests`; or `too many requests` | `RATE_LIMITED`, retryable | `join_rate_limited`; `rate_limited` |
| `retry`, sent while real-time shuts down | `TRANSIENT_FAILURE`, retryable | `retry` |
| `not authorized`, web answered the join with 403; or `unauthorized` | `PERMISSION_DENIED` | `not_authorized`; `unauthorized` |
| `project not found`, code `ProjectNotFound` | `NOT_FOUND` | `project_not_found` |
| `missing/bad ?projectId=... query flag on handshake` | `INVALID_ARGUMENT` | `bad_project_id` |
| `error`, or `Something went wrong in real-time service` | `REMOTE_ERROR`, retryable | `connection_error`, `realtime_error` |
| anything else | `REMOTE_ERROR` | the identifier the message maps to among those above, otherwise `unrecognized` |

A join that failed before Overleaf answered it, for a reason that passes, is tried again as a read
is ([retries and pacing](configuration.md#retries-and-pacing)): a `retry` refusal, a retryable
`REMOTE_ERROR` (`connection_error`, `realtime_error`, `disconnected` for a socket that closed or
failed during the join, a handshake that failed on the network or answered HTTP 5xx, and a
Socket.IO error packet advising a reconnect, such as `client not handshaken`, `not_handshaken`).
A rate-limited, refused, or timed-out join is not. With retries on, a join that kept failing ends
as `TRANSIENT_FAILURE` with `details.event: "joinProject"`, `details.lastCode`, and the last
`details.reason`.

Since 1.0.0 only `invalid session` is reported as an expired session; before it, every rejection
but the rate limit was `AUTH_EXPIRED`. Overleaf also answers `not authorized` to a session that is
no longer signed in, since real-time then joins as an anonymous user and web refuses that join, so
its message says to check `auth_status`. A project page that names a signed-in user
(`ol-user_id`) but carries no `ol-csrfToken` is `PROTOCOL_UNSUPPORTED` with
`details.kind: "response_shape"`, not `AUTH_EXPIRED`. A `joinProjectResponse` without the fields
this release reads is `PROTOCOL_UNSUPPORTED` with `details.kind: "response_shape"` and
`details.event: "joinProject"`, and its socket is closed.
