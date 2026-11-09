# Safety model

What the server guarantees, what it refuses to do, and how failures are reported. This is the
contract an assistant is held to, written for the person whose manuscript is on the other side.

## Guarantees in plain language

**Nothing is written blind.** Every text edit (`write_file`, `write_section`, and the content of
`create_file`) requires the `revision` returned by a prior read of that document. If the document
changed since that read, even by one character, the write fails with `REVISION_CONFLICT` and
nothing is applied. The assistant must read again and reconcile. It may never construct a
revision or reuse a stale one.

**Edits are small and verified.** You send the complete replacement text; the server compares it
with the document line by line and then word by word, submits one operational-transformation
update that changes only the words that differ, then rejoins the document and compares a content
hash against the intended result before returning the new revision. Text between two edits, and
comments on it, are not deleted and re-inserted. Word edits are sent only when none of them
touches a comment or a tracked change, so every range is left as it was, only moved along: an
edit that would is first cut down to the characters that differ, or moved along repeated text
to a place clear of every range. A write where an edit still touches a range, a change too large
to compare word by word, a tracked write that would pass Overleaf's limit of 2,000 tracked
changes, an untracked legacy-editor write to a document holding tracked deletions that share a
point, or touching insertions by one author, which Overleaf merges after any untracked deletion,
and word edits that would have to send again a character outside the Basic Multilingual
Plane the document holds, such as an emoji, fall back to one edit per changed run of lines or,
failing that, to one span from the first change to the last, as every write was sent before. An
acknowledgement alone is never treated as success.

**Timeouts are observed, never retried.** If a write times out, or its socket closes or fails
after the update was sent, or the verification read after an applied update fails, the server
watches the live document for a bounded window. Seeing the intended content means the write
applied. Seeing the original revision through the whole window means it did not. Seeing anything
else is reported as a conflict. In no case is the write submitted again, so a slow network can
never apply an edit twice. A timed-out upload in `batch_upload` is classified the same way from
the project tree afterwards, and is never sent again either.

**Tracked changes are honest.** `writeMode: "tracked"` records the edit as Overleaf tracked
changes for review. If tracking is not possible, for example because the session has no
authenticated user id, the call fails rather than quietly writing an untracked edit. Uploads
are the exception the caller does not control: when `upload_file` or `batch_upload` replaces an
existing document, Overleaf applies the difference itself and records it as tracked changes only
if track changes is already on for this account. `upload_file`'s result says which happened:
`writeMode` is `tracked` exactly when a text document replaced a text document while track
changes is on.

A tracked write is also checked after it verifies: every span it inserted must be held by tracked
inserts by this account, and every span it deleted by tracked deletes by this account, unless the
deleted text was itself a tracked insert. If Overleaf recorded any of it as a plain edit, the call
fails with `PROTOCOL_UNSUPPORTED` and `details.kind: "applied_untracked"`. That edit is live and
is never undone automatically, since undoing it would be another write; review it before writing
again.

**A write the account cannot make is never sent.** Overleaf judges a document update by its
shape: one that only adds comments needs view access, one that only makes tracked changes needs
review access, and anything else needs owner or edit access. Every document write is checked
against the account's access level to the project before it is sent, so an untracked write from
a review-only collaborator, a text change of any kind from a read-only one, and a history-OT
comment status change from either fail with `PERMISSION_DENIED` (`details.accessLevel`,
`details.required`), and nothing reaches Overleaf, which would otherwise refuse the update and drop
the connection.

**Tracked-change decisions are counted, checked, and verified.** `manage_tracked_changes` accepts or
rejects the tracked changes named by `changeIds` in one document, and needs the `revision` that
`list_tracked_changes` returned for it and `confirmCount` equal to the number of ids. Before
anything is sent it refuses, in this order: a missing or different `confirmCount`
(`CONFIRMATION_MISMATCH`); an account without owner or edit access (`PERMISSION_DENIED`); a project
whose owner's plan, or whose deployment, does not offer track changes (`REVIEW_UNSUPPORTED`); a
stale revision (`REVISION_CONFLICT`); an id that is not a live change in that document (`NOT_FOUND`,
`details.missingChangeIds`); a change left out that overlaps a chosen one (`INVALID_ARGUMENT`,
`details.overlappingChangeIds`), so a decision never takes half of an overlapping pair; and, for a
reject on a ShareJS document, a chosen change that does not match the document text
(`PROTOCOL_UNSUPPORTED`; list the changes again). The decision is then sent once, through Overleaf's
accept route or as one untracked edit that carries no tracking metadata, and verified on a fresh
read of the document: the chosen changes are gone and the text is what the decision should leave,
and on a history-OT document every tracked change left is as expected too. One that timed out is
observed like a write, never resent.

**Destructive actions need a second value.** Deleting an entity with `manage_entity` requires
`confirmPath` to equal `path` exactly, deleting several with `delete_entities` requires
`confirmCount` to equal the number of paths, a mirror `sync_directory` requires
`confirmDeleteCount` to equal the number of entries its plan would delete, and accepting or
rejecting tracked changes with `manage_tracked_changes` requires `confirmCount` to equal the number
of `changeIds`. Trashing, archiving, or deleting a project with `manage_project` requires
`confirmName` to equal the project's current name exactly, without trimming. The current name is
read from Overleaf first, and the check happens before any change is sent. A wrong value fails with
`CONFIRMATION_MISMATCH` and changes nothing. Projects follow Overleaf's own model: trash first,
which is reversible, and permanent deletion only from the trash. `download_file` and
`download_project_zip` refuse to replace an existing local file unless `overwrite` is `true`.

Replacements are confirmed by value or by expected state too. `upload_file` replaces a binary
file with `overwrite: true` or with `expectedHash` equal to the hash it has now, and a text
document with `uncheckedDocumentReplace: true`; `overwrite: false` refuses to replace anything.
Without them, nothing is sent: a binary is `CONFIRMATION_MISMATCH` and a document
`INVALID_ARGUMENT`, naming `write_file` with `localPath`. `batch_upload` replaces only with an
explicit `onConflict: "overwrite"`, and documents only with `uncheckedDocumentReplace: true`; its
default, `onConflict: "fail"`, refuses the whole call before any upload when a destination is
taken. A `revision` or a `planToken` counts as expected-state
confirmation. `stop_compile` is the one destructive tool without a confirm value: it stops a
running build and changes no content.

These were the defaults 0.5.x announced and 0.6.0 enforces; see
[what changed in 0.6.0](#what-changed-in-060).

**A folder sync needs a `planToken`, and stops when either side moved.** `plan_sync` changes nothing
and returns a `planToken` that covers both sides: every entity in scope in the project, with its
binary hash or document revision, and every file in the local folder. `sync_directory` with that
token compares both sides again first and stops with `REMOTE_DRIFT`, changing nothing, if either
one moved. Without a token it would have nothing to compare against, so it is refused with
`CONFIRMATION_MISMATCH` (`details.missing: "planToken"`) before anything is read, except an
additive sync that says so with `unplanned: true` and reports `planned: false`. A mirror sync
always needs a token, so `confirmDeleteCount` is never counted against a delete list nobody has
seen. Just before each upload, a sync also checks
that a new path is still empty and a changed binary still has the hash it compared, so a file a
collaborator replaced in between fails with `REMOTE_DRIFT` and every delete is withheld.
A `planToken` records what `plan_sync` observed, not that a person approved it; the approval is
the user looking at the plan and the confirm-by-value parameters. Changed documents are replaced through the same revision-checked write as `write_file`,
so an edit that lands mid-sync fails that file with `REVISION_CONFLICT` instead of being
overwritten. Uploads and writes always run before deletes, deletes happen only in mirror mode
with `confirmDeleteCount` equal to the planned count, and no delete runs once any upload or write
has failed. A path an ignore rule matches is protected on both sides and is never deleted.

**A partial result is partly applied.** `sync_directory`, `delete_entities`, and `batch_upload`
report each item. A `failed` entry does not undo the `completed` entries before it: those changes
were made and stay made. Read `completed`, `failed`, and `remaining` together before deciding what
to do next.

**A batch upload checks every path first.** `batch_upload` checks every entry before sending
anything: a missing local file, a folder given as a local file, a duplicate destination, or a
destination inside another listed one fails the whole call with nothing changed. Against one fresh
project tree, a destination that is a folder, or whose path runs through a file, fails that file
alone, in either mode. With `onConflict: "skip"` the destination is checked again inside the
upload's queue step, just before the request, so a file a collaborator added in between is
skipped, not replaced. The call stops at the first `RATE_LIMITED`, even without `stopOnError`,
and sends nothing more; the rest are listed in `remaining`. Afterwards the tree is read back once
and every upload is confirmed in it, binaries by hash; one that is missing or differs is reported
as failed.

**A project download never clobbers by accident.** `download_project_zip` streams the archive to a
temporary file beside `localPath`, checks that it starts as a zip archive and ends with a complete
zip end record, and only then moves it into place. Overleaf builds the archive while it sends
it, so a transfer cut short still arrives with HTTP 200; the end check turns that into a
retryable `REMOTE_ERROR` with nothing written. With `overwrite: true` the replacement is a
single rename, so a failed or interrupted download leaves the existing file as it was; without
it, a file that appeared at `localPath` in the meantime is not replaced. The temporary file is
removed on every failure, and neither the archive nor the names inside it are logged.

**Your session stays yours.** Cookies are saved in a file only your user can read, are never
returned by any tool, command, or SDK method, and are never logged. No tool reads or writes the
cookie jar, its lock and temporary files, or the browser profile `login` uses as a local file, and
no folder sync takes a folder that holds them, whatever the access policy says. The server
logs no document content, diffs, filenames, quoted context, or review-message bodies.

**Every command has one output shape.** `serve` reserves stdout for MCP protocol frames; the
diagnostics it writes to stderr name a tool and an error code, nothing else. `help` prints plain
text. Every other command, `login` and `keepalive` included, prints exactly one JSON value on
stdout when it succeeds. A failed [operation command](cli.md) leaves stdout empty and writes
exactly one line to stderr, `{ code, message, retryable, details? }`. Otherwise an operation
command writes nothing to stderr, unless `--progress` asked for JSON progress lines, which hold
counts, never file names. `login` also writes plain-text status lines to stderr while it waits
for the sign-in.

**Upstream text stays out of errors.** Error `details` carry status codes, short identifiers,
counts, and values the caller supplied, never a response body or a message from Overleaf, which
can quote document text. A compile status that is not a short identifier is reported as
`unrecognized`; a socket error carries `details.reason`, an identifier for a message this
release knows, or `unrecognized`; and a page Overleaf sent where JSON was expected is
`PROTOCOL_UNSUPPORTED` with only its path and content type.

**Ids cannot change a request.** A `projectId`, `sourceProjectId`, or `threadId` containing `/`,
`\`, `.`, `?`, `#`, or `%` is refused with `INVALID_ARGUMENT` before anything is sent, every id in
a request path is URI-encoded, and a request that would leave `OVERLEAF_BASE_URL`'s origin is
refused. A request that changes something never follows a redirect, because a redirect to
another origin would carry the CSRF token with it; a redirect to the login page is still
`AUTH_EXPIRED`.

**Presence is disclosed.** While the server holds a project connection open, up to 90 seconds
after the last call by default, the account may appear online to collaborators. `auth_status`
repeats this notice. Each command line call is its own session, which opens and closes its
connections while it runs, so a shell loop over many files repeats that, and multiplies the
requests Overleaf sees; `sync_directory`, `batch_upload`, and `delete_entities` do the same work
in one call.

## The exact contracts

- Reads normalize CRLF and lone CR to LF and report `newline: "LF"`.
- Revisions are opaque concurrency tokens containing project and document identity, OT protocol,
  version, and a SHA-256 content hash. Retain them; never construct them.
- Content writes change only the words that differ and are verified against a freshly joined
  document. Ambiguous writes are observed during a bounded recovery window and are never retried
  automatically.
- Explicit tracked writes never fall back to untracked writes. They require an authenticated user
  id, while `trackChangesActive` separately reports the project state observed at connection time.
- `manage_entity` deletion requires `confirmPath` to exactly equal `path`, else `CONFIRMATION_MISMATCH`.
- `manage_project` `trash`, `archive`, and `delete` require `confirmName` to exactly equal the
  current project name, else `CONFIRMATION_MISMATCH`. `delete` is refused with `INVALID_ARGUMENT`
  unless the project is already trashed.
- `update_project_settings` persists in the project itself and reports the settings as re-read
  from a fresh join, never the values it was asked to set. It sends one setting per request and
  never retries; a failure names the settings already stored in `details.applied` and the failed
  one in `details.failed`.
- `get_project_tree` reports `hash` as a git blob hash, `sha1("blob " + byteLength + "\0" +
  content)`, which is exactly what `git hash-object <file>` prints. Plain `sha1sum` never matches.
  The hash is present only on binary `file` entities; Overleaf stores no content hash for `doc`
  entities, so text documents must be compared by reading them.
- `upload_file` replaces an existing entity with no revision check and is annotated
  `destructiveHint: true`. A replaced text document keeps its entity id; a replaced binary may
  get a new one. Replacing a document is recorded as tracked changes only when track changes is
  already on for this account, and the result's `writeMode` says so. `overwrite: false` onto an
  existing document or binary is `CONFIRMATION_MISMATCH`, and an `expectedHash` that does not
  match is `REMOTE_DRIFT`, both before anything is sent. `expectedHash` is a preflight, not a
  compare-and-swap: a replacement that lands between the check and the upload is lost.
- `download_file` is annotated `{ readOnlyHint: false, destructiveHint: true, idempotentHint: false }`,
  since it writes locally, and fails with `INVALID_ARGUMENT` when the local path exists and
  `overwrite` is not `true`, before anything is fetched. With `overwrite: true` it replaces an
  existing file only by an atomic rename of a complete download, so its folder must be writable.
- `batch_upload` checks every `destinationPath` and `localPath` before any request, and fails the
  whole call with `INVALID_ARGUMENT` or `NOT_FOUND` on a bad one. It creates each missing folder
  once, uploads in the order given, never retries, and in `skip` mode re-checks each destination
  just before its upload. It stops at the first `RATE_LIMITED`, listing the rest in `remaining`.
  A timed-out upload is classified from the tree read back afterwards:
  `recoveredAfterTimeout: true` when a binary with the local file's hash is now at the path,
  `TIMEOUT` when the path is empty before and after or holds the same binary with the same hash,
  and `OUTCOME_UNKNOWN` in any other case, a document included. It is never sent again.
- Comment and history results name each author by id and display name, never by email address.
  Tracked changes name their author by id only.
- `list_tracked_changes` never reads every document: without `filePath` it reads only the
  documents Overleaf's range index lists with changes, and none at all, with
  `indexUnavailable: true`, when the deployment has no index. An excerpt is at most
  `excerptChars` UTF-16 units and never splits a surrogate pair.
- `manage_tracked_changes` requires `confirmCount` equal to the number of `changeIds`, else
  `CONFIRMATION_MISMATCH` before the project is joined. It takes at most 500 ids, each once, all
  in one document. A ShareJS accept is one request to Overleaf's accept route with exactly those
  ids; a ShareJS reject and every history-OT decision is one OT update with no tracking metadata.
  Either is verified on a fresh join and never sent twice.
- `download_project_zip` fails with `CONFIRMATION_MISMATCH` before any request when `localPath`
  holds a file and `overwrite` is not `true`, with `PROTOCOL_UNSUPPORTED` when the response is
  not a zip archive, and with `REMOTE_ERROR`, retryable, when the archive lacks its zip end
  record. It replaces an existing file only by an atomic rename of a complete download.
- `plan_sync` is read-only. `sync_directory` with a `planToken` fails with `REMOTE_DRIFT` before
  any change when the project or the local folder differs from the plan. Without a `planToken` or
  `unplanned: true` it is `CONFIRMATION_MISMATCH` with `details.missing: "planToken"`, and
  `unplanned: true` with a `planToken` or in mirror mode is `INVALID_ARGUMENT`, both before
  anything is read. In mirror mode it
  requires `confirmDeleteCount` equal to the number of `remoteOnly` entries, else
  `CONFIRMATION_MISMATCH`; it runs deletes only after every upload and write succeeded and was
  confirmed in the tree, and re-checks each entity's identity just before deleting it.
- `sync_directory` replaces changed documents only through revision-checked writes, never by
  upload, and with `writeMode: "tracked"` records every text change it writes as tracked
  changes. It never retries a step.
- `delete_entities` requires `confirmCount` equal to the number of paths, else
  `CONFIRMATION_MISMATCH`, and resolves every path before deleting any.
- A `planToken` is expected-state confirmation: it records what `plan_sync` observed, not human
  approval. A `failed` entry in a per-item result leaves the earlier `completed` entries applied.
- Folder sync resolves `localFolderPath` on the server's disk and refuses a symbolic link that
  leads outside it, and an `.olignore` that links to a file outside it, with `PATH_OUTSIDE_ROOT`.
- Every operation with a destructive effect takes a confirm value or an expected state
  (`confirmPath`, `confirmName`, `confirmCount`, `confirmDeleteCount`, `overwrite`, `onConflict`,
  `revision`, or `planToken`), except `stop_compile`. A test enforces it.
- An operation checks every effect it will use, a read after a write included, before it sends
  anything, so a `POLICY_DENIED` never follows a change.
- Compiles use the account's compile allowance. `compile_project.timeoutMs` bounds only how long
  the call waits, and a compile request that timed out is never retried, since the compile may
  still be running.
- `compile_project` passes on only `status`, output paths and types, build ids, numeric `stats`,
  and a parsed summary of the logs; Overleaf's URLs, timings, and any other field are dropped.
  A summary message is one error or warning line cut to 240 characters, never the source
  excerpt after `l.<n>`. `builtCleanly` is never `true` without a log that was read.
- `download_compile_output` and `get_compile_log` request output only from
  `/project/<projectId>/build/<buildId>/output/<file>`, or
  `/project/<projectId>/user/<userId>/build/<buildId>/output/<file>` for a per-user compile, with
  `file` checked to be a relative path without `..` before any request; a URL from Overleaf's
  response is never followed. Only a user ID of 24 hex digits is taken from it, when it names this
  project and this build.
  `download_compile_output` replaces an existing local file only with `overwrite: true`, by an
  atomic rename. `get_compile_log` reads at most 1 MB.

## Error codes

Every failure is returned as JSON with `code`, `message`, `retryable`, and optional `details`.
The [command line](cli.md) writes it as one line on stderr and maps it to an
[exit code](cli.md#exit-codes); the [SDK](sdk.md) rejects with an `McpError` carrying the same
fields. `retryable` is advisory; even when it is `true`, neither the server, the command line,
nor the SDK retries a write. Only reads are tried again, at most three attempts in all and below
every interface, before they fail with `TRANSIENT_FAILURE`
([retries and pacing](configuration.md#retries-and-pacing)). A `TIMEOUT` is marked retryable even when it came from a write, which
is why the command line's exit code depends on whether the operation is read-only and on
`details.outcome`: exit 5 means the write may have applied, and it must never be re-run blindly.

| Code | Meaning | What to do | Since |
| --- | --- | --- | --- |
| `AUTH_EXPIRED` | No saved session, or Overleaf no longer accepts it: a redirect to the login page, HTTP 401, a project page without a signed-in user, or a project socket refused as `invalid session` (`details.reason: "invalid_session"`). No other socket refusal is reported as an expired session, though `PERMISSION_DENIED` with `details.reason: "not_authorized"` can also mean one. | Run `npx overleaf-web-mcp login` again. Do not retry the call. | <!-- md:version 0.1.0 --> |
| `PERMISSION_DENIED` | Overleaf refused the operation for this account (HTTP 403), or a document write needs more access than the account has, which is checked before anything is sent (`details.accessLevel`, `details.required`): review-only collaborators can write only tracked changes, and read-only ones only add comments. From `manage_tracked_changes`, the account is not the owner or an editor, which deciding tracked changes needs (`details.accessLevel`), with nothing sent. From `download_project_zip` it can also mean the session expired, since that route checks project access rather than the login. Overleaf refusing to let the account join the project's socket is this code too (`details.reason: "not_authorized"`), with nothing sent; Overleaf sends that refusal also when the saved session is no longer signed in. | Check the project's access level; a review-only collaborator writes with `writeMode: "tracked"`. For a project download, or `details.reason: "not_authorized"`, check `auth_status` too. | <!-- md:version 0.1.0 --> |
| `NOT_FOUND` | The project, path, or Overleaf resource does not exist (HTTP 404), or a local file to upload or a local folder to download into does not exist (`details.errno: "ENOENT"`), or a `changeIds` entry is not a tracked change in the document (`details.missingChangeIds`, nothing sent), or Overleaf found no such project when joining its socket (`details.reason: "project_not_found"`). | Re-read the tree; the entity may have been renamed or removed. For a tracked change, list the changes again. | <!-- md:version 0.1.0 --> |
| `REVISION_CONFLICT` | The document changed since the revision you hold, or the verified result differs from the intent, or another update followed a tracked write before it could be checked as tracked (the text is live; `details.outcome: "unknown"`). `details.liveRevision` carries the current revision. From `write_section` with `followIncludes: true`, the file holding the section is no longer at the revision given, checked before anything is sent (`details.filePath`, `details.liveRevision`). | Read again, reconcile, and write with the new revision. | <!-- md:version 0.1.0 --> |
| `PROTOCOL_UNSUPPORTED` | The deployment speaks a collaboration protocol version this release does not, or its signed-in project page no longer carries the CSRF token this release reads (`details.kind: "response_shape"`, `details.endpoint`), or the document's OT protocol changed between read and write, or a tracked write has no user id, or a project download was not a zip archive, or a downloaded `.pdf` was not a PDF, or a response that should be JSON was not (`details.path`, and `details.contentType` when it names a media type), or a compile response lacked its expected keys (`details` `{ endpoint, expectedKeys, receivedKeys }`), or a read-only tool's result did not match its output schema (`details.kind: "response_shape"`, `details.paths`), or a tracked write applied without being recorded as tracked changes by this account (`details.kind: "applied_untracked"`, `details.liveRevision`, no `details.outcome`: it is live and not reverted), or a `manage_tracked_changes` reject on a ShareJS document found a chosen change that does not match the document text (nothing was sent). | Read again. If the protocol version is the issue, see `OVERLEAF_PROTOCOL_VERSIONS`. For `applied_untracked`, review the live text before writing again. For a refused reject, list the tracked changes again. | <!-- md:version 0.1.0 --> |
| `DOC_TOO_LARGE` | The resulting document would reach the advertised maximum length, or a flattened document from `get_full_document` or `followIncludes` would be longer than 8,388,608 UTF-16 code units (`details.kind: "flattened"`), or its include directives take in files more than 10,000 times in all (`details.kind: "includes"`). | Split the content across documents. For a flattened document, start from a file further down the includes, or read the included files one at a time with `read_file`; a lower `maxDepth` never makes the result shorter. | <!-- md:version 0.1.0 --> |
| `UPDATE_TOO_LARGE` | The serialized edit exceeds the configured update limit, or Overleaf answered HTTP 413, or refused a document update as too large (`details.outcome: "not_applied"`: nothing was stored). | Split the change into smaller writes, each with a fresh revision. | <!-- md:version 0.1.0 --> |
| `TIMEOUT` | A request or OT application timed out. For writes, `details.outcome: "not_applied"` means the original revision stayed live throughout the recovery window. In a `batch_upload` result, the path was as before the upload when the tree was read back; the upload could still land late. | Safe to read and try again with a fresh revision. | <!-- md:version 0.1.0 --> |
| `OUTCOME_UNKNOWN` | A write timed out, or its socket closed or failed, or Overleaf reported an error on the document, after the update was sent, and the live document could not be observed afterwards, or a timed-out `batch_upload` entry whose path the tree read back cannot settle either way. | Read the document, or `get_project_tree`, before doing anything else; do not assume either outcome. | <!-- md:version 0.1.0 --> |
| `COMPILE_FAILED` | Overleaf ended the compile with no build to report on: `terminated`, `exited`, `project-too-large`, `validation-problems`, or a status this server does not know. A LaTeX error is not this: that build returns a summary. `details` is `{ status, rootFilePath, buildId?, buildRef? }`; `status` is `unrecognized` when Overleaf's was not a short identifier. | Inspect the status; with a `buildRef`, read the log with `get_compile_log`. | <!-- md:version 0.1.0 --> |
| `COMPILE_RATE_LIMITED` | Overleaf did not run the compile: `too-recently-compiled`, `rate-limited`, `autocompile-backoff`, `compile-in-progress`, or HTTP 429. `details` as for `COMPILE_FAILED`, plus `retryAfterMs` when known. | Wait `retryAfterMs`, or a little while, then compile once more. | <!-- md:version 0.6.0 --> |
| `COMPILE_UNAVAILABLE` | Overleaf's compile service is down for maintenance or unavailable. | Try again later. | <!-- md:version 0.6.0 --> |
| `COMPILE_TIMEOUT` | The build reached Overleaf's time limit for the account. `details.buildRef`, when present, reaches its partial log. | Do not just compile again: try `draft` or `stopOnFirstError`, or simplify the document. | <!-- md:version 0.6.0 --> |
| `NO_BUILD` | `get_compile_log`, `download_compile_output`, or a compile output resource was called without a `buildRef`, and this process has not compiled the project. Each command line call is a new process. | Call `compile_project` first, or pass the `buildRef` an earlier compile returned; on the command line, `--build-ref`. | <!-- md:version 0.6.0 --> |
| `BUILD_NOT_FOUND` | Overleaf no longer keeps the build's output (`details.buildId`, `details.file`). | Compile again. | <!-- md:version 0.6.0 --> |
| `PARTIAL_CLEANUP` | A multi-step operation applied some steps and could not undo them all. `details` says what remains. | Inspect the project and finish the cleanup by hand. | <!-- md:version 0.1.0 --> |
| `INVALID_ARGUMENT` | The call was malformed, a path was invalid, an entity had the wrong type, Overleaf rejected a name, an id held a character that is not path-safe (`details.parameter`), an upload would replace a text document without `uncheckedDocumentReplace: true` (`details.missing`), a name is already used in the target folder or a folder would move into itself, a local file cannot be read or written (`details.errno`, such as `EISDIR` or `EACCES`), or a tracked-change decision names an id twice (`details.duplicateChangeIds`) or would leave out a change that overlaps a chosen one (`details.overlappingChangeIds`; nothing was sent), or `write_section` with `followIncludes: true` names a section that spans files (`details.kind: "spans_files"`, `details.files`; nothing was sent), or text written to a ShareJS (legacy editor) document adds a character outside the Basic Multilingual Plane, such as an emoji, adds another copy of one the document holds, or changes their order (`details.line`, the 1-based line of the first added one; Overleaf would store each as U+FFFD; nothing was sent). `details.overleafError` may carry Overleaf's short reason code. | Fix the arguments; to replace a document, prefer `write_file` with `localPath`. Replace characters outside the Basic Multilingual Plane, for example with a LaTeX command. | <!-- md:version 0.1.0 --> |
| `CONFIRMATION_MISMATCH` | A confirm-by-value parameter (`confirmPath`, `confirmName`, `confirmCount`, `confirmDeleteCount`) did not equal the value it must repeat exactly, or mirror mode was called without `confirmDeleteCount`, or `download_project_zip` or `download_compile_output` found a file at `localPath` without `overwrite: true`, or `upload_file` was given `overwrite: false` for a path that holds a document or binary file, or would replace a binary without `overwrite: true` or `expectedHash`, or `batch_upload` found taken destinations with `onConflict` left at `fail`, or `sync_directory` had no `planToken` (`details.missing` names the parameter to pass), or `manage_tracked_changes` had no `confirmCount`. Nothing was changed. | Re-read the path, name, or plan and pass the value back verbatim, after confirming with the user. | <!-- md:version 0.2.0 --> |
| `RATE_LIMITED` | Overleaf answered HTTP 429, most often on project creation, zip import, project download, or uploads, or refused to join the project (`details.reason: "join_rate_limited"`, about 45 joins a minute for one account on one project, or `rate_limited`). A rate-limited request is never retried automatically. `details.retryAfterMs` carries Overleaf's hint when it sent one; the project download and the join send none. Nothing was applied by that request, and `batch_upload` and `sync_directory` stop there. | Wait at least `retryAfterMs`, or a minute when it is absent (uploads are counted over 15 minutes, so a batch may need longer), then try once more. | <!-- md:version 0.2.0 --> |
| `REMOTE_DRIFT` | The project, or the local folder, changed since the `planToken` was issued (`details.changed` is `remote`, `local`, or `both`), or an entity planned for deletion, or a path a sync was about to upload to, changed just before, or an upload's `expectedHash` no longer matches. Nothing was changed by that step. | Run `plan_sync` again, or read `get_project_tree` again, and review the change with the user. | <!-- md:version 0.4.0 --> |
| `PATH_OUTSIDE_ROOT` | A local path is outside what the server may touch, nothing done. `details.kind` says why: `outside_folder` for a symbolic link or `.olignore` in `localFolderPath` that leads outside it, `outside_read_roots` or `outside_write_roots` for a path outside `OVERLEAF_LOCAL_READ_ROOTS` or `OVERLEAF_LOCAL_WRITE_ROOTS`, and `session_files` for a download onto the saved session. | Use a path inside the allowed folders, remove the link, or exclude it with an `ignore` pattern. | <!-- md:version 0.4.0 --> |
| `POLICY_DENIED` | The access policy does not allow this project (`OVERLEAF_ALLOWED_PROJECTS`, `details.parameter`) or this effect (`OVERLEAF_ALLOWED_EFFECTS`, `details.effect`). Nothing was sent. | Do not work around it; ask the person who configured the server. | <!-- md:version 0.5.0 --> |
| `REVIEW_UNSUPPORTED` | Tracked changes cannot be decided here, and nothing was changed. `details.kind` says why: `feature_disabled` when the project's owner's plan or the deployment does not offer track changes, `route_unavailable` when this Overleaf has no route to accept them, and `document_protocol` when Overleaf refused to accept changes in the document's protocol. | Do not retry; decide the changes in the Overleaf editor, or ask the project's owner. The command line exits 3. | <!-- md:version 0.8.0 --> |
| `INCLUDE_CYCLE` | Following the include directives of a document (`get_full_document`, or a section tool with `followIncludes: true`) led back to a file already being followed. `details.chain` lists the files, the repeated one first and last. Nothing was changed. | Fix the directive that closes the cycle, or work on the files one at a time without `followIncludes`. The command line exits 1. | <!-- md:version 0.9.0 --> |
| `INCLUDE_DEPTH_EXCEEDED` | Include directives nest deeper than `maxDepth` (10 by default). `details.maxDepth` and `details.chain` say where. Nothing was changed. | Pass a larger `maxDepth` to `get_full_document`, up to 32, or start from a file further down. The command line exits 1. | <!-- md:version 0.9.0 --> |
| `TRANSIENT_FAILURE` | A read kept failing for a reason that passes: a network failure, a cut-off answer, or HTTP 5xx on every attempt (`details.attempts`, `details.lastCode`, `details.status`, `details.path`), or a project join kept failing before Overleaf answered it (`details.event: "joinProject"`, `details.reason` such as `disconnected`, `connection_error`, `realtime_error`, or `not_handshaken`), or Overleaf refused a join with `retry`, as while restarting (`details.reason: "retry"`). The failed read changed nothing, and no update is ever sent twice. A tool that writes can still return it after its change was sent, when reading the result back failed: then `retryable` is `false` and `details.created` or `details.applied` says what was changed, where the tool knows. | From a read-only tool, wait a little and call it again; the command line exits 7. From a tool that writes, read the document or the tree first and never repeat the write blindly; the command line exits 5, or 4 when `details.created` or `details.applied` is set. | <!-- md:version 1.0.0 --> |
| `REMOTE_ERROR` | Anything else Overleaf returned or a network failure (`details.kind: "network"`), including a project download cut short before its zip end record, or a redirect answering a request that changes something. `details.status` carries the HTTP status when there is one, and `details.reason` an identifier for a socket error: `not_connected` when the project socket was already closed and nothing was sent, `disconnected` when it closed before answering a read or during the project join (both `retryable: true`), `connection_error` or `realtime_error` when Overleaf's real-time service failed the join (`retryable: true`), `not_handshaken` for a Socket.IO error packet advising a reconnect (`retryable: true`), and `unrecognized` for a join refusal this release does not know (`retryable: false`). A join is retried first, so these reach a caller as `REMOTE_ERROR` only with `OVERLEAF_READ_ATTEMPTS=1`; otherwise a join that kept failing is `TRANSIENT_FAILURE`. After a write whose socket closed or failed once the update was sent, `details.outcome: "not_applied"` (with `retryable: false`) means the original revision stayed live throughout the recovery window. Local file-system failures are never `REMOTE_ERROR`. | Retry once if `retryable` is `true`; otherwise report it. | <!-- md:version 0.1.0 --> |

## What changed in 0.6.0

0.5.x announced each of these with a `deprecations` entry `{ parameter, message, enforcedIn:
"0.6.0" }` in the result, and still ran the call. From 0.6.0 the same call is refused with nothing
sent, and no result lists `deprecations`. The command line and the SDK client added in 0.7.0
start with this behaviour.

| Behaviour | 0.5.x | 0.6.0 |
| --- | --- | --- |
| `sync_directory` without `planToken` | runs, `planned: false`, deprecation for `planToken` | `CONFIRMATION_MISMATCH`, `details.missing: "planToken"`, before anything is read; an additive sync may pass `unplanned: true` instead |
| `upload_file` onto a binary, `overwrite` omitted and no `expectedHash` | replaces, deprecation for `overwrite`; an explicit `overwrite: false` already refuses | `CONFIRMATION_MISMATCH`, `details.missing: "overwrite"` |
| `upload_file` onto a text document without `uncheckedDocumentReplace` | replaces, deprecation for `uncheckedDocumentReplace` | `INVALID_ARGUMENT`, naming `write_file` with `localPath` |
| `batch_upload` replacing something with `onConflict` omitted | replaces, deprecation for `onConflict` | `onConflict` defaults to `fail`: the call is refused with `CONFIRMATION_MISMATCH` before any upload |
| `batch_upload` replacing a text document without `uncheckedDocumentReplace` | replaces, deprecation for `uncheckedDocumentReplace` | refused for that file with `INVALID_ARGUMENT` |
| `compile_project` on a LaTeX failure | `COMPILE_FAILED`, the status repeated in a nested detail | a result with the summary; compile error details are only `{ status, rootFilePath, buildId?, buildRef? }` |

## The access policy is not a sandbox

Four environment variables, described in the [configuration guide](configuration.md#access-policy),
limit which projects (`OVERLEAF_ALLOWED_PROJECTS`), which local folders
(`OVERLEAF_LOCAL_READ_ROOTS`, `OVERLEAF_LOCAL_WRITE_ROOTS`), and which kinds of change
(`OVERLEAF_ALLOWED_EFFECTS`) the server may touch. Every operation is checked against them before
anything is sent, through the MCP server, the command line, the SDK client, and the exported
runtime alike. With all four
unset, everything is allowed except four refusals: a download onto the saved session's files, a
local read of them (a folder sync of a folder that holds them included), an `.olignore` that
links outside its folder, and an id that is not path-safe.

The policy stops an assistant, perhaps steered by text it read in a project, from reaching beyond
what it was given. It does not contain a malicious process: a path is checked with `realpath`
and then opened, and a symbolic link swapped in between those two steps is not caught. A project
created by this process joins its allowlist until the process ends; another process does not see
it. Each command line call is a new process, so under `OVERLEAF_ALLOWED_PROJECTS` a project that
`call create_project` made is refused with `POLICY_DENIED` by the next command until its id is
added to the variable.

## Limits

| Limit | Default | Source |
| --- | ---: | --- |
| Document length | 2,097,152 UTF-16 code units | `ol-maxDocLength` advertised by Overleaf, else `OVERLEAF_MAX_DOC_LENGTH` |
| Serialized update | 7,340,032 characters | `OVERLEAF_MAX_UPDATE_CHARS` |
| Compile wait | 120 seconds, maximum 15 minutes | `OVERLEAF_COMPILE_TIMEOUT_MS`, `compile_project.timeoutMs` |
| Project download | 300 seconds for the whole transfer, maximum 15 minutes | `download_project_zip.timeoutMs` |
| Files in one `batch_upload` | 500 | the tool's input schema |
| Uploads per project | about 500 in 15 minutes | Overleaf's own rate limit, for this account |
| Folder creations per project | about 60 a minute | Overleaf's own rate limit, for this account |
| Project downloads per project | about 10 a minute | Overleaf's own rate limit, for this account |
| Project sockets cached | 2, idle for 90 seconds | `OVERLEAF_SOCKET_CACHE_SIZE`, `OVERLEAF_SOCKET_IDLE_TTL_MS` |

The practical ceiling on `write_file` with inline `content` is not any of these but the MCP
client's tool-argument budget. `localPath` exists for that reason.

## What this does not protect against

- **Terms of Service.** This is an unofficial client of private APIs. Overleaf may change them
  without notice or object to automation. Use a disposable project first, keep volume low, and
  read Overleaf's current terms.
- **Blind uploads.** `upload_file` with `uncheckedDocumentReplace`, and `batch_upload` with
  `onConflict: "overwrite"` and `uncheckedDocumentReplace`, overwrite a collaborator's concurrent
  edits; use `write_file` for text when others may be editing.
  `expectedHash` narrows the window for a binary but does not close it. `sync_directory` writes documents with revision checks,
  but replaces binaries by upload: its only protection for those is the `planToken` check before
  it starts. An additive sync run with `unplanned: true` has no such check.
- **Files Overleaf leaves out of an archive.** `download_project_zip` checks that the archive
  arrived whole, not that it holds every file. Overleaf builds the archive while sending it, and
  a file it fails to read is left out of an otherwise well-formed archive, logged only on
  Overleaf's side. For a backup that must be complete, compare the archive's contents with
  `get_project_tree`.
- **Deletes between the last check and the request.** `sync_directory` compares a document's
  content when the sync starts and checks each entity's identity just before deleting it, but
  does not re-read a document's text right before deleting it. Overleaf keeps deleted documents
  in the project history, where they can be restored.
- **Concurrent commands.** Nothing is serialized across processes: two command line calls, or a
  command and a running server, do not wait for each other. Revision checks and plan tokens are
  what protect them, as they protect two collaborators, so a write against a document another
  process changed fails with `REVISION_CONFLICT` rather than overwriting it.
- **Requests in the process list.** `call --json` puts its request in the command's arguments,
  which process listings and shell history show. Pass document and comment text through
  `--request <file>`, `--request -`, `files write --content-file`, or `files write --stdin`.
- **A compromised machine.** The cookie jar is a credential. Anyone who can read your user's files
  can act as you on Overleaf until the session expires.
