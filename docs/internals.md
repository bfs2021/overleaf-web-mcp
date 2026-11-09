# Internals

How the server talks to Overleaf, and the guarantees that follow from it. Read this if you are
debugging, contributing, or deciding whether to trust a particular behaviour.

## Connection model

Two channels are used, both through the same saved web session:

- **Private REST endpoints**, the ones the Overleaf editor and dashboard call, for the project
  list, project creation, cloning, zip import, renaming, trash and archive state, project
  settings, the file tree operations, uploads, downloads, compiles, comment threads, accepting
  tracked changes, and history.
  Every route is listed in the [private API catalogue](private-api.md).
- **Socket.IO 0.9 with operational transformation (OT)** for reading and writing document text.
  The server implements the Socket.IO 0.9 wire format used by the targeted Overleaf client family
  and rejects unsupported protocol versions at project bootstrap.

No Overleaf Git integration is involved.

## Layers

Every operation is defined once and reached through one engine, whichever interface calls it.

- **Adapters**: the MCP server (`src/mcp/`); the [command line](cli.md) (`src/cli/`), which
  parses arguments and requests with the contract schemas, refuses unknown keys, prints the
  result, and maps errors to exit codes; and `createOverleafClient` (`src/client.ts`), the
  [SDK](sdk.md)'s client. The Agent Skills sit on top of the command line and call only its public
  commands. `src/cli.ts` loads the MCP server only for `serve`, so an operation command never
  loads the MCP SDK.
- **Contracts** (`src/contracts/`): for each operation, its input and output schemas, its
  description, its MCP annotations, and its effects, plus the error codes and the
  `OperationContext` an interface passes in (progress, cancellation, diagnostics). Tests check
  that the annotations agree with the effects and that every destructive operation takes a
  confirm value or an expected state.
- **Service** (`src/service/operations.ts`): `createOverleafService(runtime)` returns one function
  per operation. Each one shapes its arguments for the domain engine and nothing else; the MCP
  handlers in `src/mcp/tools.ts` make one service call each, as do each command line call and
  each client method. The service also checks a read-only result against its output schema, so
  an answer this release does not understand fails the same way through every interface.
- **Domain engine** (`src/overleaf/`, `src/protocol/`, `src/http/`): every public method checks
  the [access policy](configuration.md#access-policy) for the project and each effect it
  performs before any request, so a direct call through the exported runtime is held to the same
  rules as a tool call. The per-project queue, revision checks, write verification, and timeout
  recovery live here.

The engine is published without MCP as `overleaf-web-mcp/core`, which exports
`createOverleafClient`, `createOverleafService`, `OverleafRuntime`, `readConfig`, `McpError`,
`ERROR_CODES`, and the contract types and constants, and never loads the MCP SDK. It enforces the
same defaults as the MCP server. The [SDK page](sdk.md#stable-surface) lists the stable surface;
the runtime's fields, such as `http`, `documents`, and `connections`, and `RuntimeDependencies`
with its `fetcher` and `connectionFactory`, are internal.

```ts
import { createOverleafClient } from 'overleaf-web-mcp/core'

const client = await createOverleafClient()
try {
  const { content, revision } = await client.readFile({ projectId, filePath: 'main.tex' })
} finally {
  await client.close()
}
```

## Protocol and reliability notes

- ShareJS text OT and history-OT are normalized behind one document interface. Tracked ShareJS
  writes carry the authenticated author in update metadata; tracked history-OT writes carry author
  and timestamp metadata on inserted and retained-deletion components.
- Visible history-OT offsets account for tracked deletions retained in the raw snapshot.
- Before any OT update is sent, its shape is checked against the account's access level, the
  way Overleaf's real-time service judges it: an update that only adds comments needs view
  access, one that only makes tracked changes (it carries a `tc` id seed) needs review access,
  and anything else needs owner or edit access. An update the level does not allow is refused
  locally with `PERMISSION_DENIED`, since Overleaf would answer `not authorized` and drop the
  socket.
- `otUpdateError` has two sources. `update is too large`, matched exactly, comes from the
  real-time service to the sender alone, after its acknowledgement, with nothing stored; it is
  `UPDATE_TOO_LARGE` with `details.outcome: "not_applied"`. Every other one comes from the
  document updater, reaches every client joined to the document, and can follow
  `otUpdateApplied`, so the write is treated as unconfirmed and observed on a fresh connection,
  never resent. Known messages map to a `details.reason`; none is quoted.
- At most two project sockets are cached by default. Active sockets are never evicted, and idle
  sockets disconnect after 90 seconds. A socket Overleaf or a protocol error closed is dropped when
  the next call takes it, and that call opens a fresh one. A call on a closed socket sends nothing
  and fails with a retryable `REMOTE_ERROR`; a read whose socket closes before the reply does too.
  Freeing a slot wakes every call waiting for one, a recovery waiting to drop a socket included,
  and each checks again whether it can proceed.
- All document sessions and tree mutations in a project share one FIFO queue, because Overleaf's
  join/leave epoch is socket-wide. A document is joined for one queued operation and then left.
- A write is built from the text the editor shows and the complete target. Lines common to both ends
  are set aside, the rest is compared line by line, and each changed run of lines word by word, both
  with Myers' O(ND) difference algorithm. A token is a run of letters, digits, marks, and
  underscores, a run of horizontal whitespace, a newline, or any other single code point, so no edit
  splits a word or a surrogate pair. Two edits with one whitespace token between them are joined, so
  "a b" to "x y" is one change. Scripts written without spaces, such as Chinese or Japanese, have no
  word breaks but punctuation, so a change there replaces the whole run up to the nearest
  punctuation mark. The edits become one update: ShareJS components in order, each at a position in
  the text the previous ones left, or one history-OT `TextOperation` whose retains, counted in the
  raw snapshot, keep the tracked deletions between edits and at the end of an edit, while an edit
  takes in one at its start, as the single span always did. Edits are then kept clear of the
  document's ranges: every comment range and tracked insertion, of any author, as an extent in the
  visible text (a point, where it covers only tracked-deleted text), and every tracked deletion's
  point. An edit touches a range if it overlaps it, or starts or ends where it does, or reaches a
  tracked deletion's point, ends included: Overleaf folds, grows, splits, or merges a range an edit
  only reaches the end of, in ways that differ by protocol and by tracked or untracked mode, and an
  edit that touches nothing only moves each range along. An edit that touches a range is cut down to
  the characters that differ; if that still touches one and is a pure insertion or deletion of text
  repeated nearby, such as one of two spaces, it moves along the equal text, at most 64 characters
  each way and never past a neighbouring edit, to the nearest place clear of every range. The plan
  of one edit per changed group of words is sent if none of its edits touches a range; otherwise the
  plan of one edit per changed run of lines, on the same terms; otherwise the single span, as every
  write was sent before. On ShareJS an untracked delete makes Overleaf merge, across the whole
  document, tracked deletions that share a point and touching insertions by one author. Editing
  never leaves such a pair, and edits that touch no range cannot make one, but a document converted
  from history-OT can hold them, so an untracked ShareJS write to such a document is the single
  span. A tracked ShareJS delete merges them only when it cancels against tracked-inserted text
  alone, which touches that insertion. A plan is also passed over when, for a tracked write, its
  changes (one per deletion and one per insertion) would take the document past Overleaf's limit of
  2,000 tracked changes, or when placing looks at more than 4 million ranges in all. A line or word
  search past an edit distance of 2,000, a change more than 1,000 code units inside one word, or a
  diff past a work budget of about 100 ms on a 2 MB document, falls back to one span from the first
  change to the last, for the whole text or for that run of lines; all three plans come from one
  line search.
- A write succeeds only after acknowledgement, a matching `otUpdateApplied`, a leave and rejoin,
  and content-hash verification of the live document.
- If a write times out, or its socket closes or fails after the update was sent, or the
  verification read after an applied update fails, the intended hash proves success, the
  unchanged original revision proves the write was not applied, and any third observable state is
  reported as a conflict. The write is never submitted again automatically.
- ShareJS sends each line as the latin1 string of its UTF-8 bytes. A line is decoded only when
  those bytes are valid UTF-8, so a real U+FFFD in the text, which Overleaf stores for an emoji
  typed into its legacy editor, reads back exactly. A ShareJS write never sends a character
  outside the Basic Multilingual Plane, since Overleaf would store each as U+FFFD and the write
  could never verify. An edit that spans one the document already holds is split into several
  components that step around it, and if the word diff pairs them so that one would still be sent,
  the write steps around them as one span does; text that adds one, adds another copy, or
  reorders them is refused before anything is sent. A history-OT write steps around them the same
  way, since Overleaf refuses a history-OT insertion that holds one. The text of comment and
  tracked-change ranges in a ShareJS `joinDoc` reply is encoded the same way and decoded the same
  way; positions, ids, and metadata are not encoded, and the project range index sends plain
  UTF-8.
- Tracked changes are parsed from both protocols into one shape. A ShareJS change has an id
  Overleaf made from the update's `tc` seed and a counter; a history-OT tracked range has no id, so
  this server makes one, `ht_` plus a hash of the document, type, position, length, author, and
  timestamp, which is valid only with the revision it was listed with. An insert followed by a
  delete by the same author right where the insert ends is reported as a pair, a replacement.
- A decision is planned and checked locally first: every id must be live, and no change left out
  may overlap a chosen one. A ShareJS accept is one `POST` to Overleaf's accept route, which
  leaves the version and text unchanged; its response body is never read. A ShareJS reject is one
  untracked update with `u: true` on each component, in ascending order with cumulative shifts,
  that removes a rejected insert's text and restores a rejected delete's. A history-OT decision is
  one `TextOperation` over the raw snapshot that removes or keeps text and clears its tracking.
  None carries tracking metadata. The result must match the planned state on a fresh join;
  history-OT snapshots are compared after merging touching ranges as Overleaf does. A decision that
  timed out is observed like a write and never resent.
- After a tracked write verifies, its tracked ranges are checked by coverage: each inserted span
  must lie inside tracked inserts by this user and each deleted span inside tracked deletes by
  this user, unless the deleted text was a tracked insert. A covering change need not be new,
  since Overleaf merges a user's touching changes under the first id. On ShareJS, where a tracked
  delete is a point, the user's deletes at each point must also hold at least the text deleted
  there plus every earlier tracked delete that lands there: an untracked delete only moves an
  earlier one beside it, whose text may hold the same characters. Tracked deletes that share a
  point are expected in the new delete's text in either order: taken in one at a time they land
  reversed, but once an earlier delete of the same update has taken one in, Overleaf has joined
  each such pair across the document in order. A write that landed untracked is reported as
  `applied_untracked` and left in place.
- A comment is created as a REST thread and then attached through OT. An attachment that timed
  out, lost its socket after it was sent, or whose verification read failed is recovered by
  checking the new thread id and exact range; orphan cleanup happens only after the unchanged
  document proves attachment did not apply, and never for an attachment Overleaf acknowledged.
- A reply is identified as the one message that was not in the thread before it was posted, with
  the current author and exact normalized content. A timed-out reply is accepted only when exactly
  one such message, within the request-time window, is in the refreshed thread. The project's
  track-changes state is read before the reply is posted, so a failed join never follows a post.
- ShareJS comment status uses the dedicated REST action. History-OT comment status is part of the
  document operation and snapshot, and is verified from the snapshot, where Overleaf writes
  `resolved: true` for a resolved comment and leaves the key out for an open one. A status change
  Overleaf accepted is never reported as not applied; if the requested state is not seen, the
  result is `OUTCOME_UNKNOWN`.
- Folder sync is a composition, not a second implementation: `sync_directory` calls the same
  document write, upload, folder creation, and delete that the single-file tools use, one at a
  time through the project queue, and each upload or delete re-opens the project so the next
  step sees a fresh tree. A plan token is a small base64url JSON object holding three truncated
  SHA-256 digests: of the arguments that decide the scope, of every project entity in scope
  (path, type, id, and binary hash or document version and content hash), and of every local
  file's blob hash and folder. Nothing is stored on the server between calls, so a token survives
  a restart; after a sync, the digest covers what it changed as re-read from the tree and
  everything else as planned.
- `batch_upload` is the same kind of composition: one tree read, the folder creation and upload
  that `sync_directory` uses, and one read-back that confirms each upload and classifies a
  timed-out one without sending it again. It stops at the first `RATE_LIMITED`, since Overleaf
  counts uploads per project and would refuse the rest. `download_project_zip` streams the
  archive to a temporary file beside the target and moves it into place, never holding the whole
  archive in memory. It keeps the last 64 KB as it goes, the most a zip end record and its
  comment can span, and checks for that record there, because Overleaf builds the archive while
  sending it and a transfer cut short still ends with HTTP 200.
- History monitoring reads one 25-group update window, strips email fields, and keeps no cursor or
  background state on the server.

Protocol fixtures under `test/fixtures/protocol` are sanitized: cookies, user data, project and
document ids, and document content are removed.

## How comment and tracked-change locations are resolved

Thread messages, authors, and resolution state come from `/project/:id/threads`. When the
deployment exposes `/project/:id/ranges`, that project-wide index identifies which documents
contain the filtered threads, and only those documents are joined to compute line and column
positions and quoted context.

If a usable project-wide range index is unavailable, a project-wide `list_comments` call returns
threads with `positionsUnavailable: true`; it never scans every document silently. Supplying
`filePath` joins only that document and resolves its ShareJS ranges or history-OT comment state.
Threads without a document range are returned as `unlocated`.

`list_tracked_changes` uses the same index only to choose documents: without `filePath` it joins
just the documents the index lists with changes, and reads each list from the joined document,
never from the index. The index can lag or leave a document out, and its change ids for a
history-OT document are drawn afresh on every flush, so naming a document with `filePath` is the
authoritative way to list it. Without an index the result has `indexUnavailable: true` and no
document is joined.

The discussion record and the source range are separate Overleaf objects. The thread endpoint
provides messages; live document state provides attachment and status.

## Related projects

Representative rather than exhaustive; capabilities change over time. The README's
[comparison table](https://github.com/mhmdaskari/overleaf-web-mcp#how-it-compares) checks each
capability against the source of the most widely used servers.

| Implementation | Connection model | Focus |
| --- | --- | --- |
| **This project** | Browser-assisted saved session plus private REST and Socket.IO/OT | Project and file management, tracked writing, compilation, review comments and tracked-change decisions, and recent history, from MCP, a shell, or TypeScript |
| [`@netique/overleaf-mcp`](https://github.com/netique/overleaf-mcp) | Browser session plus private REST and Socket.IO/OT | A close web/OT peer with review comments and tracked-change workflows |
| [`overleaf-mcp-rt`](https://github.com/DanielHou315/overleaf-mcp-rt) | Session authentication plus native OT | Real-time file, compile, and comment tooling for `www.overleaf.com` and Community Edition |
| [`olcli`](https://github.com/aloth/olcli) | Session cookie plus private REST | A command-line client with an MCP mode: whole-file uploads, compilation, comments, and local-folder diffs |
| [`OverleafMCP`](https://github.com/mjyoo2/OverleafMCP), [`overleaf-mcp-server`](https://github.com/YounesBensafia/overleaf-mcp-server), [`vibeTeX`](https://github.com/oscardvs/vibetex) | Overleaf Git bridge | Git-backed synchronization, editing, and history |

The Git-bridge servers need Overleaf's Git integration, a paid feature on `www.overleaf.com`, and
work on the repository rather than the live document, so their edits bypass tracked changes and
revision checks entirely. Web-session peers such as `@netique/overleaf-mcp` share this project's
connection model and also offer tracked changes; what sets this project apart is the project
lifecycle tools, the verified-write guarantees described above, and folder sync that, given the
`planToken` from `plan_sync`, stops when either side drifted from the plan. The command line and
the TypeScript client over the same engine shipped in 0.7.0, and accepting and rejecting tracked
changes, on history-OT documents as well as ShareJS ones, in 0.8.0, and multi-file documents
(`get_full_document`, and `followIncludes` on the section tools, across `\input`, `\include`,
`\subfile`, and `\import`) in 0.9.0, and 1.0.0 classified socket rejections, retried transient
reads, and added `doctor` and the backend capabilities.

Review-range investigation was informed by
[Overleaf Comment Exporter](https://github.com/salokr/overleaf-comment-exporter). Real-time
protocol behaviour was informed by [Overleaf Workshop](https://github.com/iamhyc/Overleaf-Workshop).
