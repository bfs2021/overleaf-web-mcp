# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, tool schemas, result
shapes, and the command line's commands and exit codes may change in a minor or patch release;
each such change is listed below.

## [1.0.0] - Unreleased

### Added

- **`TRANSIENT_FAILURE`** error code, always `retryable: true`, for a read that kept failing for a
  reason that passes, and for a project join Overleaf refused with `retry`, as while restarting.
  Nothing was changed when it is returned. The command line exits 7 for it.
- **Bounded retry for reads only.** A `GET` that failed on the network or with HTTP 5xx, and a
  project join refused for a passing reason or closed before Overleaf answered, are tried again
  after a short randomized exponential backoff, up to `OVERLEAF_READ_ATTEMPTS` attempts in all
  (default 3, at most 3; 1 turns retries off). Exhausted, the call fails with
  `TRANSIENT_FAILURE`, `details.attempts`, `details.lastCode`, and, when known, `details.status`,
  `details.reason`, and `details.path`. No request that changes something is ever sent twice, and
  no read that timed out, was rate-limited, or was refused is retried.
- **`overleaf-web-mcp doctor [projectId]`**, a command line check of an install, read-only:
  the configuration and access policy, the saved session, the bootstrap page and its CSRF token
  and user, the project list, and with a `projectId` the Socket.IO handshake, `joinProject` and
  its protocol version, and a join and leave of the root document. It prints
  `{ version, checks: [{ id, status, code? }] }` with `status` `ok`, `failed`, `unsupported`, or
  `skipped`, names no project, file, or person, sends no update, and exits 1 when any check failed
  or was unsupported. It is not an MCP tool.
- **`backend` in the `capabilities` report**: `{ kind: "web-session", liveRevisions,
  trackedWrites, review: { list, decide }, comments, compile, history }`. With a `projectId`,
  `review.decide` says whether this account can accept or reject tracked changes there; without
  one it is `"unknown"`. `capabilities <projectId>` now joins the project's socket to find out.
- **`OVERLEAF_MIN_REQUEST_INTERVAL_MS`** (default 0, at most 60000) spaces the starts of REST
  requests from one process.
- A network failure of a REST request is `REMOTE_ERROR` with `details.kind: "network"`, and a
  Socket.IO handshake answered with an HTTP error carries `details.status`, `retryable` for 5xx.

### Changed

- **Socket rejections are classified.** A project join Overleaf refuses is no longer
  `AUTH_EXPIRED` for every reason but the rate limit. `invalid session` stays `AUTH_EXPIRED`;
  `retry` is `TRANSIENT_FAILURE`; `not authorized` is `PERMISSION_DENIED`; `project not found` is
  `NOT_FOUND`; a bad project id is `INVALID_ARGUMENT`; `too many requests` joins the join limiter
  as `RATE_LIMITED`; real-time's own failures are retryable `REMOTE_ERROR`
  (`details.reason: "connection_error"` or `"realtime_error"`); and anything else is
  `REMOTE_ERROR` with `details.reason: "unrecognized"`. An agent is no longer told to sign in again
  for a failure a new login would not fix. The command line's exit code follows the new code.
- **A signed-in project page without a CSRF token** is `PROTOCOL_UNSUPPORTED` with
  `details.kind: "response_shape"` and `details.endpoint: "GET /project"`, not `AUTH_EXPIRED`. A
  page with no signed-in user, or a redirect to `/login`, is still `AUTH_EXPIRED`.
- The tool output schemas that list error codes include `TRANSIENT_FAILURE`.

## [0.9.0] - 2026-11-07

Multi-file documents. A manuscript split across `\input`, `\include`, `\subfile`, and `\import`
can be read as one flattened document with a source map back to every file, and the section tools
can list, read, and replace sections across those files, each write going through the
revision-checked write of the one file that holds the section. The server registers 34 tools, one
more than 0.8.x. Planned in
[ROADMAP.md](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/ROADMAP.md).

### Added

- **`get_full_document`**, read-only: flattens a document latexpand-style from `rootFilePath`, or
  from the project's root document, following `\input`, `\include`, `\subfile`, `\import`,
  `\subimport`, `\inputfrom`, `\subinputfrom`, `\includefrom`, and `\subincludefrom` up to
  `maxDepth` levels (default 10, at most 32). Directives in `%` comments and verbatim text are
  skipped. A path resolves relative to the project root, then to the including file's folder (the
  other way round for `\subimport` and its relatives); `\input` tries the name and then `.tex`,
  `\include` always means `.tex` and honours `\includeonly`, and `\subfile` takes in only the
  file's document body, up to its first `\end{document}`. Returns `rootFilePath`, `text`, `files`,
  `includeOnly` when set, a `sourceMap` of `{ flattenedStart, flattenedEnd, filePath, docId,
  originalStart, originalEnd, revision }` runs, and `unresolved` directives `{ file, line, target,
  reason }`, where `reason` is `missing`, `binary_file`, `macro_argument` (braced or not, as in
  `\input\chapterfile` on one line; `\input` used as a token, as in `\let\oldinput\input`, includes
  nothing), or `excluded_by_includeonly`. A directive that cannot be followed stays in the text as
  written instead of failing the call. The text joins each file to what follows its directive with
  nothing in between, exactly as the files hold it. Each file is read through the same read as
  `read_file`, so each `revision` routes an edit back through `write_file` or `write_section`.
- **`followIncludes`** on `get_sections`, `get_section_content`, and `write_section`, default
  `false`. With it, `filePath` is the document to start from and the headings of every included
  file are listed in reading order. Each section adds `filePath` (the file holding its heading),
  `revision` (that file's), and `spansFiles`, its offsets are into the flattened text, and its `id`
  names the file, as `path#command:offset`; an id from one mode is `NOT_FOUND` in the other, since
  the two modes end a body in different places. `get_sections` also returns `unresolved`. A section
  whose heading is in an included file ends at the latest where that file ends, and the including
  file's text after the directive belongs to no section. Comments and verbatim text are read file
  by file, as TeX reads them, so a `%` comment on the last line of an included file never hides a
  heading after the directive. `write_section` replaces the body in that one file and returns its
  `filePath`; it checks the revision against that file before looking the section up, so a file
  changed since listing is `REVISION_CONFLICT` (`details.filePath`, `details.liveRevision`) with
  nothing sent, and it refuses a section with `spansFiles: true` with `INVALID_ARGUMENT`,
  `details.kind: "spans_files"` and `details.files`, before anything is sent. White space alone
  from another file, such as the line break after an `\input` line, does not make a section span
  files; an include directive inside a heading, or a file that ends inside one, does.
- **`INCLUDE_CYCLE`** (`details.chain`) and **`INCLUDE_DEPTH_EXCEEDED`** (`details.maxDepth`,
  `details.chain`) error codes, from `get_full_document` and the section tools with
  `followIncludes: true`. The command line exits 1 for both. A flattened text longer than 8,388,608
  UTF-16 code units is `DOC_TOO_LARGE` with `details.kind: "flattened"`, and include directives
  that take in files more than 10,000 times in all, counting a file once per inclusion, are
  `DOC_TOO_LARGE` with `details.kind: "includes"`, so an include graph that fans out cannot exhaust
  the server's time or memory.
- On the command line, `overleaf-web-mcp call get_full_document` and `overleaf-web-mcp schema
  get_full_document`, and in the SDK, `client.getFullDocument`.

### Changed

- **`get_sections` result:** `singleFileOnly` is now a boolean, `true` as before unless
  `followIncludes: true` is passed, and `sections` items and `get_section_content`'s `section` may
  carry the three fields above. A call without `followIncludes` returns exactly what it returned in
  0.8.x.
- **`write_section` result** may carry `filePath`, set when `followIncludes: true` was passed.
- **`write_section` checks the `overleaf-write` effect of the access policy before it reads the
  document**, with or without `followIncludes`. Under a policy without `overleaf-write`, 0.8.x
  joined the project and read the document before refusing the write with `POLICY_DENIED`; now
  nothing is sent. The error is the same.
- A section id passed to `get_section_content` or `write_section` that is not found now says how to
  list the sections again, and, for an id that names a file, that `followIncludes: true` is needed.
  The code is still `NOT_FOUND`.

### Documentation

- The tool reference documents the directives followed, how paths resolve, the `unresolved`
  reasons, and the source map; the user guide, safety model, and command line guide list the new
  tool and error codes.
- The three Agent Skills, and the command line page's examples, run
  `npx --yes overleaf-web-mcp@0.9`, pinned to this minor version as they were pinned to 0.8. The
  `overleaf-revise-manuscript` skill gains "Sections across included files", which works by
  section across a manuscript split with `\input` or `\include` through `followIncludes`.

## [0.8.1] - 2026-11-02

A fix to the check after a tracked write. No tool was added or removed, and no result shape
changed; the server still registers 33 tools.

### Fixed

- **A tracked write is no longer reported as untracked on a legacy document whose tracked
  deletions share a point.** A document converted from history-OT to the legacy editor (ShareJS),
  or restored from history, can hold such pairs. When a tracked write to one deleted text on both
  sides of a character outside the Basic Multilingual Plane that it kept, such as an emoji, it was
  sent as two deletes. If the first took in an existing tracked deletion, Overleaf joined each pair
  across the document, in order, before the second took that pair in, and the check after the write
  expected the pair's text the other way round. A write that Overleaf had recorded as tracked
  changes was then `PROTOCOL_UNSUPPORTED` with `details.kind: "applied_untracked"` (exit 4), and a
  tracked `sync_directory` step failed, which also held back a mirror sync's deletes. The check
  now accepts either order. A write that landed untracked is still reported, since an untracked
  delete keeps none of the deleted text. Found by comparing the check with Overleaf's change
  tracker on documents holding such pairs
  ([#33](https://github.com/mhmdaskari/overleaf-web-mcp/issues/33)).

### Documentation

- The release steps say to move the Agent Skills' `npx --yes overleaf-web-mcp@X.Y` pin with a
  minor release; `test/skills.test.ts` fails until it matches the package version.

## [0.8.0] - 2026-10-31

Tracked-change review. Two new tools list a project's tracked changes, with their locations,
authors, and excerpts, and accept or reject them in one document, on both of Overleaf's document
protocols: every decision is checked before anything is sent, sent once, and verified on a fresh
read. The same work makes every document write safer: an OT write the account's access level cannot
make is refused before it is sent, a tracked write is checked for having been recorded as tracked
changes, and Overleaf's `otUpdateError` is classified rather than passed on. A document write now
changes only the words that differ where no comment or tracked change is in the way, so a tracked
write is usually one suggestion per changed group of words. Comments on non-ASCII text are now
located and verified correctly. The server registers 33 tools, two more than 0.7.x. Planned in
[ROADMAP.md](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/ROADMAP.md).

### Added

- **`list_tracked_changes`**, read-only: lists tracked changes with `changeId`, `type`, `start`
  and `end` (1-based line and UTF-16 column in the visible text), `length`, a bounded `excerpt`
  that never splits a surrogate pair, `excerptTruncated`, `authorId`, `timestamp`, and
  `pairedChangeId` for the two halves of a replacement, per document with its `revision`,
  `protocol`, `totalChanges`, and `undecidableChanges` when Overleaf stored a change without an id.
  `type`, `authorId`, `limit` (`totalMatched`, `truncated`), and `excerptChars` shape the result.
  With `filePath` it reads that document; without it, only the documents Overleaf's range index
  lists with changes, and `indexUnavailable: true` when there is no index, never every document.
  History-OT changes carry ids made up from the change itself (`ht_...`), valid only with the
  listed revision.
- **`manage_tracked_changes`**, destructive: accepts or rejects tracked changes in one document,
  given the listed `revision`, the `changeIds`, and `confirmCount` equal to their number. Before
  anything is sent it refuses a missing or different `confirmCount` (`CONFIRMATION_MISMATCH`),
  access below owner or edit (`PERMISSION_DENIED`), a project without track changes
  (`REVIEW_UNSUPPORTED`), a stale revision (`REVISION_CONFLICT`), an id that is not a live change
  (`NOT_FOUND`, `details.missingChangeIds`), a change left out that overlaps a chosen one
  (`INVALID_ARGUMENT`, `details.overlappingChangeIds`), and, for a ShareJS reject, a chosen change
  that does not match the document text (`PROTOCOL_UNSUPPORTED`). A ShareJS accept goes through
  Overleaf's accept route; a ShareJS reject and every history-OT decision is one untracked OT update
  with no tracking metadata. The result is verified on a fresh join, and a decision that timed out
  is observed, never resent. Returns the resulting `revision`, `remainingChangeCount`,
  `trackChangesActive`, and `recoveredAfterTimeout`. The server now registers 33 tools.
- **`REVIEW_UNSUPPORTED`**, a new error code, with `details.kind` `feature_disabled` (the
  project's owner's plan or the deployment has no track changes), `route_unavailable` (Overleaf
  has no accept route), or `document_protocol` (Overleaf refused the document's protocol). The
  command line exits 3 for it, and 4 for `PROTOCOL_UNSUPPORTED` with
  `details.kind: "applied_untracked"`.
- **Command line:** `tracked-changes list`, `tracked-changes accept`, and
  `tracked-changes reject`, shorthand for the two tools.
- **Protocol fixtures for review**: a sanitized live capture of a ShareJS document with tracked
  changes and a comment on non-ASCII text, a history-OT document with tracked changes written from
  Overleaf's source together with the decision operations expected for it, and a test that fails
  on a 24-hex id, an `@`, or a session cookie name in any file under `test/fixtures/protocol`.

### Changed

- **An OT write that the account's access level cannot make is refused before it is sent.**
  Overleaf judges an update by its shape: one that only adds comments needs view access, one that
  only makes tracked changes needs review access, and anything else needs owner or edit access.
  An untracked `write_file`, `write_section`, `create_file`, or `sync_directory` write from a
  review-only collaborator, any write from a read-only one, and a history-OT comment status
  change from either is now `PERMISSION_DENIED` (exit 3) with `details.accessLevel` and
  `details.required`, and nothing is sent. Before, Overleaf answered `not authorized` and
  dropped the socket, which surfaced as `REMOTE_ERROR`. An access level this release does not
  know may add comments only.
- **`otUpdateError` is classified, not passed on.** `update is too large`, matched exactly, which
  Overleaf sends to the sender alone after storing nothing, is now `UPDATE_TOO_LARGE` with
  `details.outcome: "not_applied"`, so the command line exits 4 for it rather than 1. Any other
  `otUpdateError` reaches every client joined to the document and can follow the update being
  applied, so it now leaves the write unconfirmed (`OUTCOME_UNKNOWN` with
  `details.event: "otUpdateError"` from the socket) and the write is observed on a fresh
  connection, never resent, as after a timeout: `write_file`, `write_section`, `create_file`,
  `sync_directory`, `add_comment`, `set_comment_status`, and `manage_tracked_changes` then return
  the verified result with `recoveredAfterTimeout: true`, or `REMOTE_ERROR` with
  `details.outcome: "not_applied"` and the error's `details.reason`, or `REVISION_CONFLICT`, or
  `OUTCOME_UNKNOWN`. Before, every `otUpdateError` was `REMOTE_ERROR` (exit 1) with no
  observation. Overleaf drops the socket after the event, so it is no longer reused.
- **More of Overleaf's fixed socket error messages have a `details.reason`**, matched exactly:
  `realtime_error`, `null_bytes_in_op`, `doc_over_max_size`, `doc_too_large`, `ranges_too_large`,
  `string_too_long`, `ops_not_loaded`, `too_many_ranges`, `unrecognized_op`,
  `conflicting_deletes`, `op_too_old`, `op_at_future_version`, `version_missing`,
  `delete_mismatch`, and `invalid_hash`. Anything else is still `unrecognized`, and no upstream
  text is quoted.
- **A tracked write is checked for being recorded as tracked changes.** After a tracked
  `write_file`, `write_section`, `create_file`, or `sync_directory` write verifies, every span it
  inserted must lie inside tracked inserts by this account, and every span it deleted must be held
  by a tracked delete by this account, unless that text was itself a tracked insert. Otherwise
  the result is `PROTOCOL_UNSUPPORTED` with `details.kind: "applied_untracked"` and
  `details.liveRevision` (exit 4), and no `details.outcome`, because the write applied: it is
  live and never reverted. A tracked delete, of any author, that the deleted text spanned is
  expected inside the merged delete, as Overleaf records it. If another update followed the write
  before the check, such as a decision on its tracked changes, the ranges no longer describe it:
  the result is then `REVISION_CONFLICT` with `details.outcome: "unknown"` and
  `details.liveRevision`, and the text is live. A no-op write is not checked. A `sync_directory`
  failed entry for such a step carries `kind: "applied_untracked"` beside its `details`.
- **A document write changes only the words that differ, away from comments and tracked changes.**
  `write_file`, `write_section`, `create_file` over an existing document, and a `sync_directory`
  replacement used to send one span from the first difference to the last. They now compare the text
  line by line and then word by word and send one update with an edit per changed group of words,
  words one space apart counting as one group. A tracked write therefore records one suggestion per
  changed word group, a deletion and an insertion side by side for a replacement, where two
  separated word changes used to become one long insertion and one long deletion of everything
  between them, and an untracked write no longer deletes and re-inserts the unchanged text between
  edits. Word edits are sent only when none of them touches a comment or a tracked change: an edit
  that would overlap one, or reach an end of one or a tracked deletion's point, is first cut down to
  the characters that differ, and then, where it is the same text inserted or deleted at any of
  several places along repeated text, moved up to 64 characters to a place clear of every range. An
  edit that touches nothing leaves every range as it was, only moved along. If an edit still touches
  a range, the write is one edit per changed run of lines on the same terms, and failing that the
  single span, as before. After an untracked delete on the legacy editor (ShareJS), Overleaf merges
  tracked deletions that share a point, and touching insertions by one author, across the whole
  document. Editing never leaves such a pair, but a document converted from history-OT can, so an
  untracked write to such a document sends the single span. As on ShareJS, a history-OT edit is
  split around a character outside the Basic Multilingual Plane that it would only send again, which
  Overleaf refuses in a history-OT insertion, so the single span on history-OT is split around such
  characters too, where it used to be refused. The operations every write sends change accordingly;
  results do not. A diff past its limits (an edit distance of 2,000 lines or words, a change more
  than 1,000 code units inside one word, about 100 ms of work on a 2 MB document, or placement
  looking at more than 4 million ranges), and a tracked write whose changes, one per deletion and
  one per insertion, would take the document past Overleaf's limit of 2,000 tracked changes, fall
  back to one edit per changed run of lines or to the single span, as before. The `write_file`
  description and the connect-time instructions now say so instead of "a minimal edit", and the
  description says that a change touching a comment or tracked change is sent as one span.
- **ShareJS range text is decoded like the document's lines.** Overleaf sends the text of a
  ShareJS document's comment and tracked-change ranges as the Latin-1 reading of its UTF-8 bytes,
  as it sends the lines; that text is now decoded the same way when the document is joined.
  Positions, ids, and metadata are not encoded and are read as they are, and so is the text of the
  project's range index, which is plain UTF-8.
- The connect-time instructions (445 words) gain the tracked-change review steps, with
  `add_comment` under one Review paragraph, and are tightened elsewhere to stay under 450 words.
- The three Agent Skills, and the command line page's examples, run
  `npx --yes overleaf-web-mcp@0.8`, pinned to this minor version as they were pinned to 0.7.

### Fixed

- **Comments on non-ASCII text are located and verified correctly.** On a ShareJS
  (legacy editor) document, a comment anchored to text with a character outside ASCII, such as
  "naïve café", was read back in its encoded form: `list_comments` reported a wrong `end` and
  `quotedText`, and `add_comment` created the thread and attached it, then failed with
  `OUTCOME_UNKNOWN` because the exact range could not be verified. Comment ranges are now decoded
  as the document's lines are, so both report the range that was selected.
- **An unconfirmed document write is reported as not applied only when the original revision was
  the last thing seen.** When a document write from `write_file`, `write_section`, `create_file`,
  or `sync_directory` timed out or lost its socket after sending, and a recovery read saw the
  original revision but every later read failed until the recovery window ended, the error was
  `TIMEOUT` (exit 4) or `REMOTE_ERROR` (exit 1) with `details.outcome: "not_applied"`, although
  the write could have applied after that sighting. It is now `OUTCOME_UNKNOWN` (exit 5), as
  [the safety page](https://mhmdaskari.github.io/overleaf-web-mcp/safety/) already described
  `not_applied`: the original revision stayed live throughout the recovery window. Comment writes
  already worked this way.
- **A rate-limited project join is `RATE_LIMITED`, not `AUTH_EXPIRED`.** Overleaf allows one
  account about 45 joins of one project a minute, and `sync_directory` joins about once per
  upload, so a sync of a few dozen files could reach it. The refused join was reported as
  `AUTH_EXPIRED` (exit 3), telling the caller to log in again although the session was fine. It is
  now `RATE_LIMITED` (exit 7), retryable, with `details.reason: "join_rate_limited"`; nothing was
  sent. Wait a minute before trying again. Every other refused join is still `AUTH_EXPIRED`.

### Documentation

- The tool reference documents both new tools, the access check before a write, and
  `applied_untracked`; the safety model lists `REVIEW_UNSUPPORTED` and how a decision is checked,
  sent, and verified; the command line page lists the new commands and exit codes; the usage
  guide, internals page, and README cover reviewing tracked changes, and the comparison now marks
  accepting and rejecting them as supported. The private API catalogue records the accept route,
  how a reject is sent, the range encoding, the change shapes of both protocols, the
  track-changes features, and where `otUpdateError` comes from, each marked as read in Overleaf's
  source, confirmed live, or both.
- The roadmap records what checking v0.8.0's ten open protocol questions found.
- `docs/development.md` describes the opt-in live test of tracked-change review,
  `RUN_OVERLEAF_LIVE_TRACKED_REVIEW_TESTS=1`, and the interface comparison's review task now
  rejects a tracked change too.
- **A contributing guide**, `CONTRIBUTING.md`, also on the site and linked from the README: how to
  ask a question, report a bug or a security problem without exposing a session or a manuscript,
  set up, where code goes, the tests, and what a pull request needs.
- The TypeScript and JavaScript sources are formatted with Prettier, and CI checks it with
  `npm run format:check`; `.git-blame-ignore-revs` skips the reformat commit in `git blame`.

## [0.7.1] - 2026-10-25

Compile outputs on self-hosted Overleaf. No tool was added or removed, and no result shape
changed; the server still registers 31 tools.

### Fixed

- **Compile outputs on per-user compiles.** Overleaf Community Edition and Server Pro compile per
  user by default and serve outputs under `/project/<id>/user/<userId>/build/<buildId>/output/`.
  The output tools requested `/project/<id>/build/<buildId>/output/` there and got a 404, so
  `download_compile_output`, `get_compile_log`, and the compile output resources answered
  `BUILD_NOT_FOUND` right after a successful build, and `summary.logRead` was never `true`.
  `url` in the compile response is still never requested or returned: only the user ID is taken
  from it, when every output file that names one names this project, its own build, and the same
  user. The path gains `/user/<userId>` then and is unchanged otherwise, as on overleaf.com.
  `buildRef` carries the user ID to a later process; an old `buildRef` without one still decodes,
  and one whose user ID is not 24 hex digits is `INVALID_ARGUMENT`. Result shapes are unchanged.
  Contributed by [@chek1337](https://github.com/chek1337) in
  [#21](https://github.com/mhmdaskari/overleaf-web-mcp/pull/21).

### Documentation

- The npm description and the README tagline lead with what the package does and name its three
  interfaces: an MCP client, the command line, and TypeScript.

## [0.7.0] - 2026-10-25

The operations without an MCP client. A command line reaches every tool, `call <tool>` with a
JSON request plus shorthand commands for the common ones, and prints one JSON result, with exit
codes that say what is safe to do next. `overleaf-web-mcp/core` gains `createOverleafClient`, one
typed method per tool, and three Agent Skills drive the command line. All three go through the
same service, checks, and safety defaults as the MCP server. Every tool now declares an
`outputSchema`. No tool was added or removed; the server still registers 31 tools. Planned in
[ROADMAP.md](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/ROADMAP.md).

### Added

- **A command line for every operation.** `overleaf-web-mcp call <tool>` runs any tool with a
  JSON request from `--request <file>`, `--request -` (stdin), or `--json <object>`, and prints
  its result. `schema <tool> --input|--output` prints the JSON Schema `tools/list` advertises, and
  `capabilities [projectId]` lists each operation's effects, annotations, the effects the access
  policy refuses, the error codes, and the exit codes, with the project's access level when a
  `projectId` is given. Shorthand commands build the input of the common tools: `projects list`,
  `tree`, `files read`, `files write`, `files download`, `sync plan`, `sync apply`,
  `compile run`, `compile log`, `compile download`, and `comments list`. `overleaf-web-mcp --help`
  lists them all; the [command line page](https://mhmdaskari.github.io/overleaf-web-mcp/cli/)
  documents them.
- **One JSON result per command, and exit codes that say what is safe to do next.** A command
  prints exactly one JSON value on stdout, the object the MCP server returns as
  `structuredContent`. On failure stdout stays empty and stderr gets one line of
  `{ code, message, retryable, details? }`. The exit code is 0 complete, 1 failed, 2 fix the call,
  3 not allowed (`AUTH_EXPIRED`, `PERMISSION_DENIED`, `POLICY_DENIED`), 4 read or plan again, 5
  outcome unknown (a write may have applied: read before acting, never re-run it blindly), 6
  partial (the result is on stdout), and 7 safe to retry later. A `TIMEOUT` exits 7 from a
  read-only tool or while the session is being opened, 4 from a write known not to have applied
  (`details.outcome: "not_applied"`), and 5 from any other write, because a timed-out write may
  have applied. An error that says part of a write applied (`details.created`, or a non-empty
  `details.applied`) exits 4, never 2 or 7, which promise that nothing changed.
- **Strict input.** The command line and the SDK client refuse a key the tool's schema does not
  list, at any depth, with `INVALID_ARGUMENT` and `details.unknownKeys`, before any request; a
  schema violation is `INVALID_ARGUMENT` with `details.issues`. The MCP server, through the MCP
  SDK, still drops unknown keys silently, so a misspelled `writeMode` there falls back to
  `untracked`.
- **No document text in argv.** `files write` takes the text from `--content-file`, read by the
  operation itself so `OVERLEAF_LOCAL_READ_ROOTS` applies, or from `--stdin`; `call` takes any
  request from a file or stdin. `compile log` and `compile download` need `--build-ref`, since a
  new process has no latest build; `compile run --download <localPath>` compiles and saves the
  PDF in one process, and keeps the compile result on stdout with `status: "partial"` and exit 6
  when only the download failed. `--progress` writes progress as JSON lines on stderr.
- **`createOverleafClient`** in `overleaf-web-mcp/core`: one camelCase method per tool
  (`readFile`, `syncDirectory`, `authStatus()`), each resolving with the same object as the MCP
  `structuredContent`, typed by the tool's contract, and rejecting with `McpError` and the codes
  the command line reports, plus `close()`, which lets calls still running finish before it closes the project
  connections. The [SDK page](https://mhmdaskari.github.io/overleaf-web-mcp/sdk/) names
  the stable surface of `overleaf-web-mcp/core`.
- **Three Agent Skills** in the package's `skills/` folder, which drive the command line:
  `overleaf-revise-manuscript`, `overleaf-reviewer-comments`, and `overleaf-sync-sources`. They
  use only public commands, ask before anything destructive, treat manuscript text and reviewer
  comments as data, never instructions, and keep project paths off the shell command line.
- **Output schemas for the last 12 tools**: `get_project_tree`, `read_file`, `write_file`,
  `create_file`, `manage_entity`, `download_file`, `get_sections`, `get_section_content`,
  `write_section`, `stop_compile`, `set_comment_status`, and `monitor_project_history` declare an
  `outputSchema` and return the same object as `structuredContent`, mirrored in the JSON text
  block as before. Every tool now does. The shapes are the ones these tools already returned,
  recorded first as golden results taken through the real domain classes.

### Changed

- **`errorCode` in the `failed` entries of `batch_upload`, `sync_directory`, and
  `delete_entities` is an enum of the error codes** in their output schemas, where it was any
  string.
- **A read-only tool whose result does not match its output schema fails with
  `PROTOCOL_UNSUPPORTED`** and `details: { kind: "response_shape", paths }`, the same way through
  every interface. The MCP SDK used to report such a mismatch as an untyped text error. A tool that
  changes something is never failed this way after the change applied.
- **`createMcpServer`, `serveOverStdio`, and `createOverleafService` take a narrower runtime
  type.** `OverleafServiceRuntime.authStatus`, `createFile`, and `entities.manageEntity` now
  declare the results the `auth_status`, `create_file`, and `manage_entity` contracts describe,
  where they returned `Record<string, unknown>` or `unknown`; `recoveredAfterTimeout` is `true`
  where it was any boolean; `sections.getSections` and `getSectionContent` return sections whose
  `command` is one of `part`, `chapter`, `section`, `subsection`, `subsubsection`, `paragraph`,
  or `subparagraph`, where it was any string; and `entities.uploadFile` has two overloads:
  without `ifExists: "skip"` it resolves with an upload, never a skipped entry. A hand-written
  runtime must return those shapes, and a caller that forwards `options` to `uploadFile` passes a
  defined value.
- **`set_comment_status` reports the status it verified**, not the string it was given; the two
  differ only for a library caller that passed something other than `open` or `resolved`.
- The descriptions of `read_file`, `stop_compile`, and `monitor_project_history` now name the
  fields they return, and those of `add_comment` and `set_comment_status` say that
  `recoveredAfterTimeout` also marks a change confirmed after its read-back failed.

- **`overleaf-web-mcp serve` loads the MCP SDK only when it runs**, so operation commands start
  without it. `help`, `login`, `keepalive`, an unknown command, and `serve` behave as before.

### Fixed

- **A comment change is never reported as safe to retry after it was sent.** When the read-back
  after a posted reply failed, `reply_to_comment` passed that read's error on, for example a
  retryable `RATE_LIMITED`, and posting again duplicated the reply. It is now `OUTCOME_UNKNOWN`
  with `details.threadId`, as is a failed read-back after `add_comment` timed out creating its
  thread and after `set_comment_status` applied a change. When only the final read of the new
  thread fails, `add_comment` returns its result without `thread`, as its description allows.
- **A progress callback that throws never fails the call.** Progress is advisory, but a library
  caller's `onProgress` that threw or rejected failed `batch_upload`, `plan_sync`,
  `sync_directory`, or `delete_entities`, possibly after deletes or writes applied. The MCP server
  already ignored failed progress notifications.
- **Exactly one leading byte order mark is dropped** from a local file's text, as for
  `write_file` with `localPath` and the files `plan_sync` and `sync_directory` compare. A
  zero-width no-break space right after it was dropped too.
- **`get_project_tree` reports `hash` only when it is a string.** A binary file whose `hash` in
  the joined project was `null` or another non-string value was listed with that value, which the
  new output schema, like the documentation, does not allow; the entity now has no `hash`.
- **A heading inside another heading's title is part of that title.** For
  `\section{Outer \section{Inner}}`, `get_sections` listed both, the outer section ending before
  its own body started, and `write_section` on it wrote part of the heading a second time. Section
  tools now read a heading inside a title or a short title as part of it.

### Documentation

- New pages for the [command line](https://mhmdaskari.github.io/overleaf-web-mcp/cli/) and the
  [TypeScript SDK](https://mhmdaskari.github.io/overleaf-web-mcp/sdk/). The README and the
  installation guide describe using the package without an MCP client, the tool reference
  documents the result of every tool, and the safety model and AGENTS.md state the output rule:
  every command but `serve` and `help` prints exactly one JSON result.
- The roadmap records v0.7.0 as shipped, with the commands and exit codes as built.

## [0.6.2] - 2026-10-20

Fixes from a live test run against overleaf.com. No tool was added or removed; the server still
registers 31 tools. Two result shapes change: the comment tools return their own thread shape,
without email addresses, and `sync_directory`'s `failed` entries carry the failed step's error
details. Several failures that used to reach Overleaf, or came back as `REMOTE_ERROR`, are now
refused before anything is sent; Changed lists every contract change.

### Changed

- **Comment tools return their own thread shape, and never an email address.** `list_comments`,
  `add_comment` (its `thread`), and `reply_to_comment` passed Overleaf's thread objects through, so
  every message carried the author's `user { first_name, last_name, email }`, and a resolved thread
  its `resolved_by_user` with an email. A thread is now `{ id, status, messages, resolvedAt?,
  resolvedBy? }`. Each message is `{ id, author, content, timestamp }`, where `author` is `{ id,
  displayName }`, or `null` when Overleaf names no user, and `timestamp` is an ISO string;
  `resolvedBy` is `{ id, displayName }`. Overleaf's other thread and message fields are no longer
  returned. The three tools now declare an `outputSchema` and return the same object as
  `structuredContent`.
- **`reply_to_comment` returns the created message.** As its documentation said, the result is now
  `{ threadId, message, trackChangesActive, writeMode, recoveredAfterTimeout? }` instead of the
  whole thread. The new message is the one message that was not in the thread before the reply, from
  this account, with this content; when the read-back cannot single it out, the call fails with
  `OUTCOME_UNKNOWN` and is not resubmitted. A timed-out reply is likewise recovered only from a
  message that is new since the request, so an identical earlier reply is no longer taken as proof.
- **`list_comments` matches `author` against names and ids only.** It keeps threads with a message
  whose author display name contains `author`, case-insensitive, or whose author id equals it. Email
  addresses are no longer matched.
- **`sync_directory` failures carry their error details.** Each `failed` entry gains an optional
  `details`, the failed step's own error details: `{ destinationPath, action, errorCode, message,
  details? }`. A refused OT update reports `details.reason`, an HTTP failure its `status`, a write
  its `outcome` or `liveRevision`, and a create that left its document behind `created: true`.
- **`create_file` marks an error raised after the document exists.** Such an error keeps its code
  and `details`, adds `details.created: true`, and is never `retryable`.
- **A lost or closed project socket is a retryable `REMOTE_ERROR`.** It was `OUTCOME_UNKNOWN`.
  `details.reason` is `not_connected` when nothing was sent, and `disconnected` when a read lost its
  reply or the socket closed during the project join. `OUTCOME_UNKNOWN` is kept for a write that was
  sent and may have applied. A write proved not applied after a lost socket is `REMOTE_ERROR` with
  `details.outcome: "not_applied"` and `retryable: false`. `add_comment` and `set_comment_status`
  follow the same rule: an attachment or status change whose socket failed after it was sent, and
  that stays absent through the recovery window, is `REMOTE_ERROR` with `details.outcome:
  "not_applied"`, `details.threadId`, and `retryable: false`, where `set_comment_status` reported
  `TIMEOUT`; one that actually timed out still is `TIMEOUT`. A change Overleaf accepted but whose
  requested state is never seen is `OUTCOME_UNKNOWN`, never not applied.
- **Characters outside the Basic Multilingual Plane are never sent to ShareJS documents.** On a
  ShareJS (legacy editor) document, `write_file`, and with it `create_file`, `write_section`, and
  `sync_directory`, refuses text that adds such a character, an emoji for example, or an unpaired
  surrogate, adds another copy of one the document already holds, or changes their order. The error
  is `INVALID_ARGUMENT` with `details.line`, the 1-based line of the first added one, and nothing is
  sent; Overleaf would have replaced each one with U+FFFD. An edit that spans such a character the
  document already holds is sent as several components that step around it, where it used to send
  the character again and Overleaf turned it into U+FFFD. History-OT documents are unaffected.
- **`update_project_settings` names what it stored before a failure.** Its errors keep their code
  and `retryable` and add `details.applied`, the input field names stored before the failure, and
  `details.failed`, the input field name whose request failed. A `rootFilePath` without a `.tex`,
  `.ltx`, `.Rtex`, or `.Rnw` extension is `INVALID_ARGUMENT` before any request.
- **`import_project_zip` reads back the stored name, which needs the `overleaf-read` effect.** Under
  an `OVERLEAF_ALLOWED_EFFECTS` without `overleaf-read`, the call is refused with `POLICY_DENIED`
  before anything is uploaded. When the archive was imported but the read-back fails, an
  `AUTH_EXPIRED`, `POLICY_DENIED`, or `TIMEOUT` from that read keeps its code and `details`; any
  other failure, `NOT_FOUND` and `RATE_LIMITED` included, which for this tool mean nothing was
  created, is `REMOTE_ERROR`. Every such error carries the new project's id in `details.projectId`,
  says the project was imported, and is never `retryable`, since importing again would create a
  second project.
- **Local file-system failures are typed by errno.** In `upload_file`, `batch_upload`, and
  `download_file`, a missing file or folder is `NOT_FOUND` (`details.errno: "ENOENT"`), and any
  other failure, such as `EISDIR` or `EACCES`, is `INVALID_ARGUMENT` with the code in
  `details.errno`. Both used to be `REMOTE_ERROR`.
- **`download_file` checks the local path before any request, and replaces a file atomically.** A
  folder, or a symbolic link to one, at `localPath` is `INVALID_ARGUMENT` whatever `overwrite` is, a
  missing parent folder is `NOT_FOUND`, and a folder that cannot be written is `INVALID_ARGUMENT`
  with `details.errno`, such as `EACCES`. With `overwrite: true` an existing file is replaced by
  writing a temporary file in the same folder and renaming it into place, as `download_project_zip`
  does, so a failed local write no longer leaves the old file truncated. The new file keeps the old
  one's permission bits, and a symbolic link to a file is kept while the file it leads to is
  replaced. The folder must now be writable even when the file exists: a writable file in a
  read-only folder was overwritten in place before and is now refused before anything is fetched.
- **`manage_entity` name collisions are `INVALID_ARGUMENT` before any request.** They were
  `REMOTE_ERROR`. This covers `create_folder` on an existing path, with or without a trailing slash,
  `rename` to a name already in the folder, the entity's own included, `move` into a folder that
  already holds that name, the entity's current folder included, and moving a folder into itself or
  one of its subfolders. Names are compared exactly, as Overleaf compares them.
- **New `NOT_FOUND` refusals.** `reply_to_comment` with a `threadId` that names no existing thread,
  and `set_comment_status` for a thread not anchored in `filePath`, fail with `NOT_FOUND` and
  `details.threadId` before anything is posted or changed. `get_compile_log` with `kind: "bibtex"`,
  and `download_compile_output` of `output.blg` or `output.bbl`, are `NOT_FOUND` on a build in which
  BibTeX did not run. These answers hold through a `buildRef` too, and for a build with more than
  100 outputs. `compile_project`'s `outputFiles` leaves out `output.blg` and `output.bbl` on such a
  build, so the listing matches what the output tools serve; the shape of `outputFiles` is
  unchanged.
- **`monitor_project_history` trims a group that straddles the cursor.** In an update group that
  starts before `sinceVersion`, `projectOperations` lists only operations with `atVersion` at or
  after `sinceVersion`. The group's `fromVersion`, `startedAt`, `paths`, and `labels` still describe
  the whole group.
- **The tool descriptions follow the new behaviour.** Those of `clone_project`,
  `import_project_zip`, `update_project_settings`, `write_file`, `create_file`, `manage_entity`,
  `download_file`, `sync_directory`, `get_section_content`, `write_section`, `compile_project`,
  `get_compile_log`, `download_compile_output`, the four comment tools, and
  `monitor_project_history` are updated, and the connect-time instructions (440 words) note that
  legacy documents refuse added emoji.

### Fixed

- **Project actions and `stop_compile` report success again.** Overleaf now acknowledges rename,
  trash, restore, archive, unarchive, permanent deletion, and compile stop with a plain-text `OK`.
  The server refused that body as not JSON and returned `PROTOCOL_UNSUPPORTED` although Overleaf
  had applied the action. A bare status-text acknowledgement is now accepted wherever an empty
  body already was; any other body that is not JSON is still refused.
- **Tracked writes are accepted on ShareJS documents.** `writeMode: "tracked"` on `create_file`,
  `write_file`, `write_section`, and `sync_directory` sent the user ID as the track-changes id
  seed, which Overleaf refuses as longer than 18 characters, so every tracked write failed with
  `REMOTE_ERROR`. The server now sends an 18-character seed, as the web editor does; Overleaf
  still attributes the change to the signed-in user.
- **`compile_project` builds the `rootFilePath` it is given.** overleaf.com built the project's
  configured root document whatever `rootFilePath` named, while the result reported the requested
  path. The compile request now names the file to build.
- **A project socket Overleaf closed is replaced, not reused.** After Overleaf closed a project
  socket, as it does after refusing an OT update, or a protocol error closed it, the dead socket
  stayed cached: every later document or comment call in the process failed with `OUTCOME_UNKNOWN`,
  and `get_project_tree` returned a frozen tree. The next call now opens a fresh socket. A recovery
  waiting to drop that socket while another call still held it could wait indefinitely once the
  replacement connection failed to open, and a second one on the same project always did. Freeing a
  connection slot now wakes every waiting call, and each checks again whether it can proceed.
- **A Socket.IO event without arguments is accepted.** Socket.IO 0.9 leaves out `args` when Overleaf
  sends an event with none, as in a `reconnectGracefully` during a drain. That frame was rejected as
  `PROTOCOL_UNSUPPORTED`, which closed the project socket and failed any call in flight on it.
- **A write cut off by a lost socket is classified, never resent.** A write whose socket closed or
  failed after the update was sent, or whose verification read then failed, was returned
  unclassified. It is now observed like a timed-out write: `recoveredAfterTimeout: true` when the
  intended text is live, `REVISION_CONFLICT` with `details.outcome: "unknown"` for a third state, or
  `REMOTE_ERROR` with `details.outcome: "not_applied"` (`retryable: false`) when the original
  revision stayed live through the recovery window. `add_comment` and `set_comment_status` are now
  classified the same way. When the socket failed after the update was sent, or the verification
  read after an accepted update failed, they no longer return a retryable `REMOTE_ERROR`, which
  could lead to a duplicate thread, or, for `add_comment`, delete the new thread at once. They
  observe the document instead: `recoveredAfterTimeout: true` when the comment or status is live,
  `OUTCOME_UNKNOWN` with `details.threadId` when it cannot be settled or Overleaf accepted the
  change but the requested state is never seen, and `TIMEOUT` or `REMOTE_ERROR` with
  `details.outcome: "not_applied"` when an unaccepted change stayed absent. `add_comment` removes
  its thread only in that last case.
- **A ShareJS line holding a real U+FFFD reads back exactly.** Overleaf stores an emoji typed into
  its legacy editor as U+FFFD, and such a line came back as latin1 mojibake. `write_file` then
  placed edits below that line at shifted offsets, corrupting the document, and a write that landed
  exactly was reported as `REVISION_CONFLICT`. A leading byte order mark is also kept.
- **`create_file` says when it left a document behind.** Creating the document and writing its
  content are separate steps. When reading back or writing the content failed after the document was
  created, the error did not say that the document now existed, possibly empty. It now keeps its
  code and classification, adds `details.created: true`, and says to write the document with
  `write_file` rather than create it again. Nothing is deleted on your behalf.
- **`sync_directory` resumes after a create that left its document behind.** A create that failed
  once its document existed, a refused tracked create for example, left a `planToken` that did not
  account for that document, so the documented resume failed with `REMOTE_DRIFT`. The token now
  counts it while it is still empty or holds exactly the intended text, and the resumed sync writes
  it through a revision-checked write. A leftover someone edited in between still stops the resume
  with `REMOTE_DRIFT`. The failed entry's message told the agent to read the document with
  `read_file` and write it with `write_file`, advice meant for `create_file`; following it moved the
  revision the `planToken` pins, so the resume failed with `REMOTE_DRIFT`. It now says not to create
  or write the document by hand, but to resume with the returned `planToken`, or to run `plan_sync`
  again if none came back.
- **`update_project_settings` no longer half-applies a change silently.** Overleaf applies a
  settings request field by field and stops at the first failure with a bare HTTP 500, so a call
  that failed partway reported only the 500 while some settings were stored, and the same process
  kept serving the old settings. Each setting is now sent in its own request, in the order Overleaf
  applies them (compiler, imageName, spellCheckLanguage, then the root document); a failure names
  the settings already stored, and no later setting is sent. The cached project snapshot is dropped
  on failure too, so a following `get_project_tree` shows what Overleaf stored.
- **`update_project_settings` refuses a root Overleaf cannot compile before any request.** A
  `rootFilePath` that does not end in `.tex`, `.ltx`, `.Rtex`, or `.Rnw`, in any case, such as a
  `.bib` document, got an opaque HTTP 500 from Overleaf. It is now `INVALID_ARGUMENT`.
- **`import_project_zip` returns the name Overleaf stored.** Overleaf names an imported project
  after the root document's `\title` when there is one and adds a suffix such as `(1)` when the
  account already has a project with that name, so the returned name could differ from the stored
  one, and `manage_project` then rejected it as `confirmName`. The name is now read back after the
  import. If that read fails, the error carries the new `projectId` in `details` and is never
  retryable; see Changed for its code.
- **`compile_project` ignores a BibTeX log left over from an earlier build.** Overleaf's incremental
  build directory keeps an earlier build's `output.blg` and `output.bbl` and lists them again for
  later builds in which BibTeX did not run. Their warnings, undefined citations, missing files, and
  errors were reported as this build's, and a stale BibTeX error could make a clean build of another
  root report `builtCleanly: false`. When `output.blg` is listed, `compile_project` now reads the
  build's `output.aux` (one extra request, made only then) and keeps the BibTeX log only when the
  aux file holds a `\bibdata`, biblatex record, or `\@input` line, or cannot be read in full. A
  `\citation` line alone does not count, since `\cite` without `\bibliography` writes one and BibTeX
  is then never run. The aux files an `\@input` line names are not read, so a root that uses
  `\include` keeps the log. On a build in which BibTeX did not run, `outputFiles` leaves out
  `output.blg` and `output.bbl`, and `get_compile_log` with `kind: "bibtex"` and
  `download_compile_output` of either file answer `NOT_FOUND`, in this process or through
  `buildRef`, also for a build with more than 100 outputs. A build that timed out or was terminated
  is not checked, since its `output.aux` may be half written, so its `buildRef` can still reach a
  leftover `.blg`.
- **Section tools read `%` as LaTeX does.** `get_sections`, `get_section_content`, and
  `write_section` treated `%` after a `\\` line break as escaped, so a heading commented out after
  `\\%` was parsed as a live section and `write_section` cut a body short at that line. Whether a
  `%` is escaped now depends on the whole run of backslashes before it. A `%` inside a `verbatim`,
  `verbatim*`, `lstlisting`, `minted`, or `comment` environment is literal text; one on the same
  line as the environment's `\end{...}` used to hide every later heading, so a `write_section` on
  the section before it could delete the sections after it. Headings inside inline `\verb`, `\verb*`
  (with any delimiter), or `\lstinline` (with a delimiter or braces) are no longer parsed, and `%`
  inside them is text. In the same way, a heading name right after a `\\` line break, as in
  `text\\section{X}`, is plain text to LaTeX. It was parsed as a live heading, so the section before
  it ended between the two backslashes, and a `write_section` on that section dropped the first
  backslash and turned the text into a real `\section` heading.
- **Section offsets stay correct after an emoji in a comment.** A character outside the Basic
  Multilingual Plane inside a comment or a verbatim-like environment shifted every later section by
  one, so `write_section` replaced the wrong range.
- **`get_project_tree` reports each nested folder's own parent.** `parentFolderId` was the project
  root for every folder; it is now the folder that holds it.
- **Local file errors no longer pass the operating system's text through.** `upload_file` and
  `download_file` returned local file-system failures as `REMOTE_ERROR` carrying the operating
  system's message and the resolved path. The new messages carry neither; see Changed for the codes.
  `batch_upload` gets the same codes through `upload_file`.
- **`download_file` checks the local path before it fetches anything.** An existing file without
  `overwrite: true` is refused with the same `INVALID_ARGUMENT` as before, but no longer after a
  wasted download. A folder, or a symbolic link to one, at `localPath` used to suggest `overwrite:
  true`, which then failed after the download. A missing or unwritable parent folder is likewise
  found before the fetch. The exclusive create still refuses a file that appears during the
  download.
- **`manage_entity` refuses a name collision before any request.** A `create_folder`, `rename`, or
  `move` that would put two entities with the same name in one folder, and moving a folder into
  itself or one of its subfolders, failed at Overleaf as `REMOTE_ERROR` with HTTP 400. A
  `create_folder` path with a trailing slash is checked the same way.
- **`monitor_project_history` no longer repeats project operations an earlier poll reported.**
  Overleaf can merge new changes into an update group between polls, so a group may start before
  `sinceVersion`, and its earlier operations were reported again.
- **`list_comments` filters by author name.** `author` compared fields Overleaf does not send
  (`user.name`) and the author's email, so a display name never matched while an email substring
  did.
- **`reply_to_comment` no longer posts a stray or duplicate reply.** Overleaf creates any thread a
  message is posted to, so a mistyped `threadId` silently started a new, unanchored thread that no
  tool can delete, and the call reported success. It also opened the project socket only after
  posting, to read `trackChangesActive`, so a project join that failed then, for example while
  Overleaf was draining, returned a retryable `REMOTE_ERROR` for a posted reply, and a retry posted
  it twice. That state is now read before the reply is posted.
- **`set_comment_status` checks the thread is in `filePath`.** It resolved or reopened the thread by
  id whatever document `filePath` named, and could report a thread anchored elsewhere, or nowhere,
  as verified. On a history-OT document, the new status is now verified from the document snapshot,
  also for a comment whose anchored text was deleted and for an open comment, whose snapshot entry
  leaves `resolved` out. A change that applied is no longer reported as `OUTCOME_UNKNOWN`, or after
  a timeout as not applied.

### Documentation

- `manage_entity` results include `writeMode`, which is always `untracked`, since tree operations
  are never tracked changes.
- The tool reference says that a section's body runs to the next heading at the same or a higher
  level, nested subsections included, and that the last one runs to the end of the file,
  `\end{document}` included; that `clone_project` copies the root document and compiler but not the
  TeX Live image or spell-check language, which Overleaf resets to the account's defaults; that
  `update_project_settings` omits `spellCheckLanguage` when spell checking is off; that
  `manage_project` reads the current name from Overleaf and checks `confirmName` before any change
  is sent; and that `import_project_zip` usually has no `details.overleafError`, since overleaf.com
  answers with a translated sentence rather than a code.
- The safety model's error table and the protocol notes describe the socket, ShareJS, and local file
  codes above, and the roadmap's count of tools still without an `outputSchema` drops to 12.

## [0.6.1] - 2026-10-20

A refreshed README and package description, and a session deadline that no longer drifts. No tool
was added, removed, or changed in schema or result shape; the server still registers 31 tools.

### Changed

- The npm package and the documentation site describe the server by what it does. The note that
  it is an independent project, not affiliated with or endorsed by Overleaf, moves to one line at
  the end of the README, and the site footer keeps its note. The Terms-of-Service and account
  risk caution becomes a short note under Get started and on the site's home page.
- The npm download-count badge, an all-time total refreshed weekly, is labelled `installs`.
- Dependencies are refreshed within their declared ranges, which clears every `npm audit`
  finding; all were in development-only packages, and the published package had none.

### Fixed

- **The session deadline is dated from when Overleaf set the cookie.** Overleaf sets its session
  cookie with `Max-Age`, which the cookie library counted from the cookie's latest use rather than
  from its arrival, so `sessionExpiresAt` in `auth_status` and `keepalive` moved later with every
  request and could report a deadline after the real one. The server now fixes the deadline when
  the cookie arrives, and the jar file and both reports agree to the second.

### Documentation

- The README has a navigation row, one badge style with CI status and the supported clients, and
  a dark-theme version of the hero image, which the site's home page also uses. The tool table,
  the configuration for other clients, and the comparison's notes are collapsible.
- Codex is listed among the supported clients, with its `codex mcp add` command in the README and
  a Codex tab in the installation guide. The README notes that VS Code uses a `servers` key.

## [0.6.0] - 2026-10-19

Compile and build ergonomics. `compile_project` now reads the build's logs and says plainly
whether the paper built cleanly, with errors and warnings by file and line, and two new tools read
a build's log and save its PDF or any other output without compiling again. The three safety
defaults 0.5.0 announced are enforced: a folder sync needs a plan, and an upload or batch upload
replaces nothing unless asked. The server registers 31 tools, two more than 0.5.x. Planned in
[ROADMAP.md](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/ROADMAP.md).

### Added

- **`get_compile_log`** (read-only): a bounded tail of a build's LaTeX log, or with
  `kind: "bibtex"` its `.blg` log, with `format: "errors-only"` and `tail` (default 200 lines, at
  most 2,000). It reads at most 1 MB and returns `{ buildId, file, log, truncated, errorLines }`.
- **`download_compile_output`** (destructive, writes locally): saves `output.pdf`, or any output
  such as `output.log` or `output.synctex.gz`, to a local path in one call, returning
  `{ localPath, file, sizeBytes, buildId, replaced }`. An existing file is replaced only with
  `overwrite: true`, atomically; a `.pdf` that does not start with `%PDF-` is refused.
- **`compile_project` returns a `summary`**: `{ status, builtCleanly, pdfProduced, logRead,
  errorCount, warningCount, errors, warnings, undefinedReferences, undefinedCitations,
  missingFiles, pageCount?, pdfSizeBytes? }`. `builtCleanly` is the field to check, since Overleaf
  reports `success` whenever a PDF came out, even after LaTeX errors. Errors and warnings are
  `{ file?, line?, message }`, the first 20 of each, messages cut to 240 characters and never the
  source excerpt TeX prints after `l.<n>`. The log parser is this package's own, written for MIT
  and tested against fixture logs; it reads both TeX error forms, BibTeX, and Biber.
- **`buildRef`** on `compile_project`'s result, and on a timed-out or terminated build's error
  details: an opaque token naming the build to `get_compile_log` and `download_compile_output`, in
  this process or a later one. Without it, both use the latest build compiled in this process.
- **`stopOnFirstError`** and **`draft`** on `compile_project`, passed to Overleaf's compile
  endpoint.
- **`compile_project` declares an `outputSchema`** and returns `structuredContent`, as do both new
  tools.
- **Read-only MCP resources** `overleaf://project/{projectId}/output/output.log` and
  `overleaf://project/{projectId}/output/output.pdf`, for the latest build in this process (a PDF
  of at most 16 MB).
- **Five error codes:** `COMPILE_RATE_LIMITED` (retryable, with `retryAfterMs` when known),
  `COMPILE_UNAVAILABLE` (retryable), `COMPILE_TIMEOUT`, `NO_BUILD`, and `BUILD_NOT_FOUND`.
- **`batch_upload` `onConflict: "fail"`**, now the default; see Changed.
- `details.missing` on the refusals below, naming the parameter to pass.

### Changed

- **A build that ran is a result, not an error.** `compile_project` with Overleaf status
  `failure` or `stopped-on-first-error` returns the summary instead of throwing `COMPILE_FAILED`.
  A compile with no build to report on fails with a code by status: `too-recently-compiled`,
  `rate-limited`, `autocompile-backoff`, `compile-in-progress`, and HTTP 429 are
  `COMPILE_RATE_LIMITED`; `clsi-maintenance` and `unavailable` are `COMPILE_UNAVAILABLE`;
  `timedout` is `COMPILE_TIMEOUT`; the rest, `validation-problems` included, stay
  `COMPILE_FAILED`.
- **Compile error details are exactly `{ status, rootFilePath, buildId?, buildRef? }`**, plus
  `retryAfterMs` for `COMPILE_RATE_LIMITED` when known. `details.result`, deprecated in 0.5.0, is
  gone.
- **The compile response is validated where it arrives.** `outputFiles` entries are reduced to
  `{ path, type, build? }`, without `url`; `stats` keeps numbers only; `timings`,
  `pdfDownloadDomain`, `validationProblems`, and every other field are dropped. A response without
  a `status`, or with malformed `outputFiles`, is `PROTOCOL_UNSUPPORTED` with
  `{ endpoint: "compile", expectedKeys, receivedKeys }`.
- **A `TIMEOUT` on the compile request is no longer retryable**, because Overleaf may still be
  compiling.
- The compile request adds `?file_line_errors=true`, so TeX names the file of each error, and
  `compile_project` reads `output.log` and any `.blg` log after the build, so it needs the
  `overleaf-read` effect as well as `compile` under an access policy.
- **`sync_directory` requires a `planToken`.** Without one, and without `unplanned: true` for an
  additive sync, it fails with `CONFIRMATION_MISMATCH` and `details.missing: "planToken"` before
  anything is read. A mirror sync always needs one.
- **`upload_file` replaces nothing unless asked.** Onto a binary without `overwrite: true` or
  `expectedHash` it is `CONFIRMATION_MISMATCH` (`details.missing: "overwrite"`); onto a text
  document without `uncheckedDocumentReplace: true` it is `INVALID_ARGUMENT`
  (`details.missing: "uncheckedDocumentReplace"`), naming `write_file` with `localPath`. Nothing
  is sent in either case.
- **`batch_upload` has no default that replaces.** `onConflict` defaults to `"fail"`: when any
  destination holds a document or binary file, the call fails with `CONFIRMATION_MISMATCH`
  (`details.missing: "onConflict"`, `count`, and up to 25 `paths`) before anything is uploaded.
  With `"overwrite"`, a text document is replaced only with `uncheckedDocumentReplace: true`, and
  otherwise that file fails with `INVALID_ARGUMENT`. The result's `onConflict` can be `"fail"`.
- **No result lists `deprecations`**: the field is removed from the `upload_file`,
  `batch_upload`, and `sync_directory` output schemas, since every default it announced is now
  enforced.
- The tool descriptions of `compile_project`, `upload_file`, `batch_upload`, and
  `sync_directory`, and the connect-time instructions (417 words), describe the new behaviour.

### Documentation

- The tool reference documents the summary, the status-to-code table, both new tools, and the
  output resources, and drops the 0.5.x transition tables for the enforced defaults. The safety
  model lists the new codes, the compile output guarantees, and what changed in 0.6.0. The private
  API catalogue documents the output route, `file_line_errors`, `stopOnFirstError`, `draft`, the
  statuses, and the build id and server id formats, and no longer says the response is passed
  through. The README and the site's home page list the new tools, and the comparison now marks
  reading the compile log and errors as supported.

## [0.5.1] - 2026-10-12

Listed in the official MCP Registry. No tool was added, removed, or changed in schema or result
shape; the server still registers 29 tools.

### Added

- **An MCP Registry entry.** The server is published to
  [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io) as
  `io.github.mhmdaskari/overleaf-web-mcp`, which the MCP clients and directories that read the
  registry use to find and install it. `server.json` in the repository root describes the npm
  package, its `serve` argument, and the optional environment variables, and `package.json`
  carries the matching `mcpName` the registry checks against the published package.
- The `Publish to npm` workflow lists each release in the registry once the package is on npm,
  signing in with GitHub OIDC, so no registry token is stored. A test keeps `server.json`'s name
  and versions aligned with `package.json`.

## [0.5.0] - 2026-10-10

Shared core and safety. Every operation is now defined once, in an operation registry the MCP
server is one adapter over, and the engine behind it is published without MCP as
`overleaf-web-mcp/core`. An optional access policy limits which projects, local folders, and
kinds of change the server may touch; ids are checked before they reach a request path; and error
details no longer carry text from Overleaf. Three safety defaults that depended on the caller
picking the safe option are announced here and enforced in 0.6.0: a folder sync without a plan,
an upload that replaces a file without saying so, and `batch_upload`'s overwriting default. No
tool was added or removed; the server still registers 29 tools. Planned in
[ROADMAP.md](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/ROADMAP.md).

### Added

- **`overleaf-web-mcp/core`**, a subpath export that never loads the MCP SDK. It exports
  `OverleafRuntime`, `readConfig`, `createOverleafService`, `McpError` (the same class the root
  exports), `ERROR_CODES`, `SERVER_VERSION`, and the contracts: `OPERATIONS`, `OPERATION_NAMES`,
  `EFFECTS`, and the `OverleafService`, `OverleafServiceRuntime`, `OperationContext`,
  `OperationInput`, and `OperationOutput` types. `createOverleafService(runtime)` returns one
  function per operation, keyed by tool name, that takes the tool's input and resolves with its
  result or rejects with `McpError`. It follows the same 0.5.x defaults and deprecations as the
  MCP server; v0.7.0 documents its stable surface.
- **An access policy**, configured by four environment variables, all unset by default. Every
  operation is checked against it before anything is sent, through the MCP server and the
  exported runtime alike:
  - `OVERLEAF_ALLOWED_PROJECTS`, the project ids any tool may touch. `list_projects` and
    `auth_status` list and count only these, and a project created by this process is allowed
    for the rest of it.
  - `OVERLEAF_LOCAL_READ_ROOTS` and `OVERLEAF_LOCAL_WRITE_ROOTS`, absolute folders separated by
    `:` (`;` on Windows) that local reads (`write_file` and `upload_file` from disk,
    `batch_upload`, `import_project_zip`, `plan_sync`, `sync_directory`) and local writes
    (`download_file`, `download_project_zip`) must stay inside, judged by `realpath`.
  - `OVERLEAF_ALLOWED_EFFECTS`, which of `overleaf-read`, `overleaf-write`, `overleaf-delete`,
    `project-lifecycle`, `compile`, `local-read`, `local-write`, and `unchecked-replace` an
    operation may have. An operation checks every effect it will use before it starts, the reads
    a write makes afterwards included, so a refusal never lands after a change.

  A relative or missing root, an unknown effect, or an unsafe project id stops the server at
  startup with `INVALID_ARGUMENT` naming the variable.
- **`POLICY_DENIED`**, a new error code for a project (`details.parameter`) or effect
  (`details.effect`) the policy does not allow. Nothing is sent.
- **`upload_file` takes `overwrite`, `expectedHash`, and `uncheckedDocumentReplace`**, checked
  inside the upload's queue job after a fresh look at the tree, before anything is sent.
  `overwrite: false` onto a document or binary file is `CONFIRMATION_MISMATCH`; an `expectedHash`
  that does not match what is at the path is `REMOTE_DRIFT`. `overwrite: true` or a matching
  `expectedHash` confirms replacing a binary, and `uncheckedDocumentReplace: true` replacing a text
  document. `expectedHash` is a preflight, not a compare-and-swap: the upload route takes no
  expected state.
- **`upload_file` declares an `outputSchema`** and returns `structuredContent`:
  `{ entityId?, entityType?, path, replaced, hash?, trackChangesActive, writeMode, deprecations? }`.
- **`batch_upload` takes `uncheckedDocumentReplace`**, the same opt-in, per file.
- **`sync_directory` takes `unplanned`**: `true` runs an additive sync without a `planToken` on
  purpose. With a `planToken` or in mirror mode it is `INVALID_ARGUMENT` before anything is read.
  The result gains `planned`, whether a `planToken` checked the call.
- **`deprecations`** in the results of `upload_file`, `batch_upload`, and `sync_directory`:
  `[{ parameter, message, enforcedIn: "0.6.0" }]` when a call relied on a default that 0.6.0
  removes.
- **Diagnostics on stderr.** `serve` writes `{"diagnostic":{"tool":…,"code":…}}` to stderr when a
  call fails (its error code) or relies on a deprecated default (`DEPRECATED`), and nothing else:
  no message, path, or text from Overleaf. Library use: `createMcpServer` and `serveOverStdio`
  take an optional third argument, and `runStdioServer` an option, `onDiagnostic`.
- Tests that guard the contract: `tools/list` against a committed snapshot, every operation's
  annotations against its effects, every destructive operation taking a confirm value or an
  expected state (`stop_compile` excepted), the policy through a real runtime with zero requests
  on refusal, and a sentinel string fed through every upstream channel that no serialized error
  may contain. CI imports both built entry points by package name.

### Deprecated

Each of these still works in 0.5.x and lists a `deprecations` entry in its result. From 0.6.0 it
is refused with nothing sent.

- **`sync_directory` without a `planToken`** (`parameter: "planToken"`). From 0.6.0
  `CONFIRMATION_MISMATCH` with `details.missing: "planToken"`; an additive sync may pass
  `unplanned: true` instead.
- **`upload_file` replacing a binary file without `overwrite: true` or `expectedHash`**
  (`parameter: "overwrite"`). From 0.6.0 that call is `CONFIRMATION_MISMATCH`. A document's
  replacement is governed by `uncheckedDocumentReplace` instead; only an explicit
  `overwrite: false` refuses one.
- **`upload_file` replacing a text document without `uncheckedDocumentReplace: true`**
  (`parameter: "uncheckedDocumentReplace"`). From 0.6.0 `INVALID_ARGUMENT`, naming `write_file`
  with `localPath`.
- **`batch_upload` replacing a file with `onConflict` omitted** (`parameter: "onConflict"`), or a
  text document without `uncheckedDocumentReplace: true`. From 0.6.0 no default replaces anything,
  and the document rule applies to each file.
- **`COMPILE_FAILED`'s `details.result`**, now reduced to `{ status }`. Removed in 0.6.0, when a
  failed build returns a parsed summary instead.

### Changed

- **`download_file` is annotated `{ readOnlyHint: false, destructiveHint: true,
  idempotentHint: false }`** instead of `readOnlyHint: true`: it writes a local file and can
  replace one.
- **`upload_file`'s `writeMode` is `tracked`** when a text document replaced a text document while
  track changes is on for this account, because Overleaf then records the difference as tracked
  changes. It always read `untracked` before. Its description is rewritten for the new parameters.
- **`batch_upload`'s `onConflict` has no schema default**, so an omitted value is told apart from
  an explicit `"overwrite"`. An omitted value still overwrites and is reported as `overwrite` in
  the result; `tools/list` no longer shows `"default": "overwrite"`.
- **Path-safe ids.** A `projectId`, `sourceProjectId`, or `threadId` holding `/`, `\`, `.`, `?`,
  `#`, `%`, or a control character is `INVALID_ARGUMENT` with `details.parameter`, before any
  request. Every id in a request path is URI-encoded, and a created project's id that is not
  path-safe is `PROTOCOL_UNSUPPORTED`.
- **Requests stay on `OVERLEAF_BASE_URL`'s origin.** A request that would leave it is
  `INVALID_ARGUMENT` before it is sent. A request that changes something no longer follows
  redirects, since fetch would carry the CSRF token to another origin: a redirect to `/login` is
  still `AUTH_EXPIRED`, and any other is `REMOTE_ERROR` with `details.status`.
- **Four refusals apply with no policy variable set**: a download onto the cookie jar, its lock
  or temporary files, or the browser profile, and a local read of any of them, a folder sync of a
  folder that holds them included, since an upload or a sync would put the session into a project
  (`PATH_OUTSIDE_ROOT`, `details.kind: "session_files"`); an `.olignore` that links to a file
  outside its folder, whose patterns a plan would echo back (`PATH_OUTSIDE_ROOT`, `details.kind:
  "outside_folder"`); and the unsafe ids above. A local path is judged the way the file system
  resolves it, a symbolic link before the `..` that follows it, and a dangling link by where it
  leads.
- **`PATH_OUTSIDE_ROOT` carries `details.kind`**: `outside_folder`, now also on the existing
  refusal of a symbolic link out of `localFolderPath`, `outside_read_roots`,
  `outside_write_roots`, or `session_files`.
- **A sync upload is checked against the plan.** Just before each upload, `sync_directory` checks
  that a new path is still empty and a changed binary still has the hash the plan compared;
  otherwise that file fails with `REMOTE_DRIFT`, which withholds every delete. It used to replace
  whatever had appeared there.
- **Error details no longer carry text from Overleaf.**
  - `COMPILE_FAILED` details are `{ status, rootFilePath, result: { status } }`, with a status that
    is not a short identifier (`^[a-z][a-z0-9-]{0,63}$`) reported as `unrecognized`. They used to
    carry the whole compile response under `details.result`.
  - Socket rejections (`connectionRejected`, still `AUTH_EXPIRED`), failed `joinDoc`, `leaveDoc`,
    and `applyOtUpdate` acknowledgements, `otUpdateError`, and Socket.IO error packets no longer
    put the upstream payload in the message; `details.reason` is an identifier for a message this
    release knows, or `unrecognized`. `otUpdateError`'s `details.message`, which could quote the
    rejected update, is gone. A raw socket error while joining a project is `REMOTE_ERROR` with a
    fixed message.
  - An upload's or zip import's `error` reaches `details.overleafError` only as a short lowercase
    code.
  - `manage_entity`'s `create_folder` result has `created: { _id, name }`, not Overleaf's raw
    folder object.
  - A response that should be JSON and is not is `PROTOCOL_UNSUPPORTED` with `{ path,
    contentType }`. It used to be a `REMOTE_ERROR` whose message could quote the body.
- **The connect-time instructions** are 392 words, down from 445, leaving headroom for 0.6.0 and
  0.8.0. They now cover confirming replacements, `deprecations`, and `POLICY_DENIED` and
  `PATH_OUTSIDE_ROOT`, and leave out what the tool descriptions already say.
- The `sync_directory` and `batch_upload` descriptions describe the transition.
- Inside the package, tool definitions moved from `src/mcp/tools.ts` to `src/contracts/`, the
  argument shaping to `src/service/`, and `OverleafToolRuntime` became `OverleafServiceRuntime`.
  `McpErrorCode` is derived from `ERROR_CODES`. The move itself left `tools/list` unchanged.

### Documentation

- The configuration guide has an access policy section, with the four variables, the effects, and
  an example. The safety model adds "What changes in 0.6.0", "The access policy is not a
  sandbox", the id, origin, and redirect rules, how upstream text is kept out of errors, and
  `POLICY_DENIED` and the `PATH_OUTSIDE_ROOT` kinds in its error table.
- The tool reference documents the new parameters, a table of what an upload needs by what is at
  the path in 0.5.x and from 0.6.0, `download_file` as destructive, and `deprecations`. The README
  tool table gains a Local effect column, and its safety list mentions the policy.
- The internals page describes the layers (contracts, service, domain engine) and shows
  `overleaf-web-mcp/core` in use; the development guide covers the interface boundary and the
  snapshot and contract tests; the private API catalogue covers redirects, non-JSON bodies, and
  socket error reasons.
- `AGENTS.md` records the one-minor rule for tightening a default, which parameters count as
  confirmation, the policy and boundary rules, and that stdout is reserved under `serve`.
- The roadmap marks v0.5.0 shipped and records how its design settled.

## [0.4.1] - 2026-10-06

The v0.4.x point release. `batch_upload` sends a list of local files to the project paths given,
creating missing folders, in one call, and `download_project_zip` saves the whole project as one
zip archive, the backup step before a mirror sync. The server now runs on the v2 MCP SDK and also
serves clients on MCP 2026-07-28, and the documentation no longer overstates what a folder sync
without a `planToken`, a destructive tool, or an upload that replaces a file guarantees. The
server registers 29 tools. Planned in [ROADMAP.md](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/ROADMAP.md).

### Added

- **`batch_upload`** uploads 1 to 500 `{ localPath, destinationPath }` entries, where
  `destinationPath` is the full project path including the file name. Every entry is checked
  before anything is sent: an invalid or duplicate destination, one that is the parent folder of
  another, a missing local file, or a folder given as one fails the whole call with nothing
  changed. Missing folders are created once each, parents first; a folder that could not be
  created is not tried again, and the files under it fail with its error code. Files upload in the
  order given, one at a time through the project's queue. `onConflict` is `overwrite` by default,
  replacing what is at the path as `upload_file` does, or `skip`, which leaves an existing
  document or file alone and checks again just before each upload. A destination that is a
  folder, or runs through a file, fails that one file. Failures are per file unless
  `stopOnError`, and nothing is retried. The call also stops at the first `RATE_LIMITED`, listing
  the rest in `remaining` and sending nothing more, since Overleaf allows about 500 uploads per
  project in 15 minutes and would refuse them too. Afterwards the tree is read back: an upload
  that is missing, or a binary whose hash differs, moves to `failed` with `REMOTE_ERROR`. A
  timed-out upload is classified from that read-back without being sent again: completed with
  `recoveredAfterTimeout: true` when a binary with the local file's hash is at the path,
  `TIMEOUT` when the path is unchanged (it had not landed, though it could still land late), and
  `OUTCOME_UNKNOWN` otherwise, a document included. The result carries `status`, `onConflict`,
  `completed`, `skipped`, `failed`, `remaining`, and `verified`. It is annotated destructive and
  sends progress notifications per file.
- **`download_project_zip`** saves the whole project, sources and binaries, from
  `GET /Project/:id/download/zip` to `localPath`, with `overwrite` (default `false`) and
  `timeoutMs` (default 5 minutes, at most 15, for the whole transfer). A missing parent folder is
  `NOT_FOUND`, a folder at `localPath` `INVALID_ARGUMENT`, and an existing file without
  `overwrite: true` `CONFIRMATION_MISMATCH`, each before any request. The archive is streamed to a
  temporary file in the same folder, created before the request, so a folder that cannot be
  written fails first with `INVALID_ARGUMENT` and `details.errno`; it is never held in memory. It must begin with a zip signature,
  else `PROTOCOL_UNSUPPORTED`, and end with a zip end-of-central-directory record: Overleaf builds
  the archive while it sends it, so a transfer cut short still arrives with HTTP 200, and that,
  like a body that stops inside the signature, fails with `REMOTE_ERROR`, retryable. Either way nothing is written. A complete archive is then
  renamed into place, so a failed download never destroys an existing file; without
  `overwrite`, a file that appeared in the meantime is not replaced. Overleaf allows about 10
  downloads per project a minute and sends no `Retry-After`, so `RATE_LIMITED` usually has no
  `retryAfterMs` and the description says to wait a minute. The route checks project access
  rather than the login, so an expired session arrives as `PERMISSION_DENIED`; the description
  says to check `auth_status`. The end check cannot tell when Overleaf left out a file it failed
  to read, which it does without an error; the documentation says so. The result is
  `{ projectId, localPath, bytes, replaced }`. It changes nothing on Overleaf and is annotated
  destructive because it can replace a local file.
- **`outputSchema` and `structuredContent`** on both new tools.

### Changed

- **Built on the v2 MCP SDK.** The server now depends on `@modelcontextprotocol/server` 2.3 in
  place of `@modelcontextprotocol/sdk` 1.x, and `serve` answers both protocol eras over stdio.
  Clients on the 2025-era protocol versions (2024-10-07 through 2025-11-25) connect with
  `initialize` exactly as before; clients on MCP 2026-07-28 are served through `server/discover`,
  whose result carries the same usage instructions. The existing tools' names, input fields,
  annotations, and result shapes are unchanged. An install no longer pulls in the v1 SDK's HTTP
  server stack (Express, Hono, and their dependencies), and `npm audit --omit=dev` reports no
  advisories.
- The `inputSchema` and `outputSchema` of each tool in `tools/list` now declare JSON Schema draft
  2020-12, the default dialect since MCP 2025-11-25, instead of draft-07. The schemas themselves
  are unchanged. Tools no longer carry `execution: { taskSupport: "forbidden" }`, which is the
  default when the field is absent.
- Calling a tool name the server does not register now fails with JSON-RPC error `-32602` instead
  of returning an `isError` result.
- `serve` now exits when its client closes stdin, releasing the Overleaf session and sockets,
  instead of waiting for a signal. Tool calls still running at that moment are not answered, as
  the MCP stdio transport specifies, but get up to 1.5 seconds to finish against Overleaf before
  the sockets close, so a multi-step operation such as `create_file` with content is not cut off
  between its steps.
- Library use: `createMcpServer()` returns the `McpServer` class from
  `@modelcontextprotocol/server`. Connecting it by hand with `connect()` serves 2025-era clients
  only; the new `serveOverStdio(runtime, transport?)` serves both eras, as `serve` does, and
  returns a connection with `close()` and `whenIdle(timeoutMs)`.
- **`CONFIRMATION_MISMATCH`** also covers `download_project_zip` called on an existing local file
  without `overwrite: true`. `download_file` keeps `INVALID_ARGUMENT` for the same case.
- **`upload_file`'s description is corrected** after a read of Overleaf's source. It no longer
  says a replacement keeps the entity ID: a replaced text document keeps it, and a replaced binary
  file may get a new one. It no longer says replacing a document is never tracked: Overleaf may
  record it as tracked changes when track changes is already on for this account. The result's
  `writeMode` still reads `untracked` in that case; v0.5.0 resolves it. The tool's behaviour is
  unchanged.
- The `INVALID_ARGUMENT` message for Overleaf's `duplicate_file_name` upload rejection now says an
  entity the upload cannot replace, usually a folder, already has that name. It used to say a text
  document cannot replace a binary or the reverse, which Overleaf in fact allows.
  `details.overleafError` is unchanged.
- The connect-time instructions mention `batch_upload` for a list of files, offer
  `download_project_zip` as a backup before a mirror sync, and no longer say an upload is never
  tracked, within the 450-word bound (445 words).

### Documentation

- **Corrections planned for v0.5.0, shipped early.** The README, the documentation home page, and
  the safety model now make the folder-sync guarantee conditional on a `planToken`: without one,
  `sync_directory` has nothing to compare against. The README's "each one confirms by value" now
  names the destructive tools that do not: `upload_file`, `batch_upload` with its default
  `onConflict`, `stop_compile`, and `sync_directory` in additive mode. The safety model says a
  `planToken` records what `plan_sync` observed rather than a person's approval, and that a
  `failed` entry in a per-item result leaves the earlier `completed` entries applied.
- The tool reference, safety model, usage guide, internals page, and private API catalogue cover
  the two new tools, and the README lists them. The usage guide adds the zip backup before a
  mirror sync.
- The tool reference, safety model, and private API catalogue no longer say an upload keeps a
  binary's entity id or is never tracked, and no longer say uploading over the other kind of
  entity fails. They state Overleaf's upload, folder-creation, and download rate limits, that an
  expired session reaches `download_project_zip` as `PERMISSION_DENIED`, and that Overleaf can
  leave a file it failed to read out of an otherwise complete archive.
- The README and the documentation site show the package's all-time npm downloads. A weekly
  `Download count` workflow sums them from npm's downloads API, one year at a time so npm's
  18-month limit cannot shorten the total, and publishes the badge data to the `badges` branch,
  so the badge stays current on npmjs.com without a release and `main` gets no weekly commits.
- The roadmap gains an "Interfaces beyond MCP" section (one engine behind MCP, a command line,
  and a TypeScript library, with HTTP, Git, WebMCP, and A2A as conditional triggers rather than
  stages) and three new stages: v0.5.0 shared core and safety, v0.7.0 CLI, SDK, and Skills, and
  v0.8.0 tracked-change review (accept and reject). Compile and build ergonomics moves from
  v0.5.0 to v0.6.0 and multi-file documents from v0.6.0 to v0.9.0. v1.0.0 becomes "Hardening and
  compatibility" (a `doctor` command, backend capabilities, and an MCP protocol compatibility
  matrix), and Stage 0 checks the v2 SDK packages.
- The roadmap marks v0.4.0 shipped and records how the point release's design settled: a
  `skipped` list and a `verified` flag, timed-out uploads classified rather than resent,
  `CONFIRMATION_MISMATCH` for an existing local file, a streamed download with an atomic replace
  and an end-record check, and `timeoutMs`. It records what a read of Overleaf's source found
  (replaced binaries may get a new id, replacing a document can be tracked, what
  `duplicate_file_name` means, and the rate limits), corrects its "What already works well" and
  Stage 0 notes to match, and adds a v0.5.0 task to resolve `upload_file`'s `writeMode` when
  track changes is on. Its v0.5.0 documentation-corrections task is marked done.

## [0.4.0] - 2026-09-27

Bulk and sync operations. Bringing one folder up to date used to take a hand-rolled hash
comparison and a tool call per file: the session the roadmap was written from spent 24 calls on
it, 20 of them single deletes. `plan_sync` and `sync_directory` now do it in two, and
`delete_entities` removes a list of entities in one. The server registers 27 tools. Planned in
[ROADMAP.md](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/ROADMAP.md).

### Added

- **`plan_sync`** compares a local folder with the project, or with one project folder through
  `destinationFolderPath`, and changes nothing. Binary files compare by the git blob hash already
  in the tree; text documents are read and compared as LF-normalized text. It returns `toUpload`
  (new or changed, with `comparedBy` and `remoteType`), `identical` (a count and the first 25
  paths unless `verbose`), `remoteOnly` (what mirror mode would delete, each folder collapsed to
  one entry with a `contains` count), `conflicts` (a file where the other side has a folder, or
  non-UTF-8 text where the project has a document), `ignored`, and a `planToken`.
- **`sync_directory`** applies a plan in `additive` or `mirror` mode, which must always be given.
  With a `planToken` it first compares both sides with the plan again and fails with
  `REMOTE_DRIFT`, changing nothing, if either one moved, identical files included. Changed
  documents are replaced through revision-checked `write_file` edits, so an edit made during the
  sync fails that one file with `REVISION_CONFLICT`; binaries and new files are uploaded, and
  missing folders are created. With `writeMode: "tracked"`, changed documents are written as
  tracked changes and new text files are created with tracked content, since an upload is never
  tracked. Uploads and writes run first and are confirmed in the tree; deletes run only in mirror
  mode, only with `confirmDeleteCount` equal to the planned count, never after any upload or write
  failed, and each entity is re-checked just before it is deleted. Failures are per file and
  nothing is retried. The result carries `status`, `completed`, `failed`, `remaining`,
  `identicalCount`, and a `planToken` that resumes a partial run while still stopping for a
  change someone made in between.
- **`delete_entities`** deletes a list of paths once `confirmCount` equals its length. Every path
  is resolved before any is deleted, so a missing one fails the call with `NOT_FOUND` and changes
  nothing; a duplicate, or a path inside a listed folder, is `INVALID_ARGUMENT`.
- **Ignore rules for folder sync.** Gitignore-style patterns: by default `.git/`, `.DS_Store`,
  hidden files and folders, `__MACOSX/`, and LaTeX build output (`*.aux`, `*.log`, `*.bbl`,
  `*.blg`, `*.out`, `*.toc`, `*.synctex.gz`, `*.fdb_latexmk`, `*.fls`), then a `.olignore` file in
  the folder, then the `ignore` parameter, so `!pattern` re-includes. A path an ignore rule
  matches is protected on the project side too and is never compared or deleted.
- **`REMOTE_DRIFT`** for a sync whose plan no longer matches the project or the local folder,
  with `details.changed` set to `remote`, `local`, or `both`, and **`PATH_OUTSIDE_ROOT`** for a
  symbolic link that leads out of `localFolderPath`.
- **Progress notifications.** The three new tools send `notifications/progress` while documents
  are read and files are applied, when the client supplies a progress token.
- **`outputSchema` and `structuredContent`** on the three new tools.
- A gated live test (`RUN_OVERLEAF_LIVE_SYNC_TESTS=1`) that mirrors a temporary folder into a
  throwaway project, checks that a second plan finds nothing to do, and trashes the project.
- New runtime dependency: `ignore`, for gitignore-compatible pattern matching.

### Changed

- **`CONFIRMATION_MISMATCH`** also covers `confirmCount` and `confirmDeleteCount`, including a
  mirror sync called without `confirmDeleteCount`.
- The initialize instructions gain a paragraph on folder sync, and the rest is tightened so the
  whole stays under the 450-word bound the test enforces.
- **Releases can be published from GitHub Actions.** Running the `Publish to npm` workflow on
  `main` with a version checks it against `package.json` and this changelog, runs the checks,
  publishes to npm with trusted publishing, and then creates the `vX.Y.Z` tag and the GitHub
  Release with the changelog section as its notes. Publishing a GitHub Release by hand works as
  before.

### Documentation

- A "Folder sync and bulk delete" section in the tool reference, with the comparison rules, the
  ignore rules, and the order in which a sync applies changes.
- The safety model covers what a plan token guarantees and what it does not, and lists the two
  new error codes. The usage guide's manual hash comparison is replaced by the two-call workflow.
- The README lists the three tools, and its comparison table now marks folder comparison as
  supported, where it was binaries only.
- The tool reference's `auth_status` entry lists `sessionExpiresAt`, added in 0.3.0 but missing
  from that page until now.
- `AGENTS.md` records the sync invariants contributors must keep and the new confirm-by-value
  parameters.
- The roadmap marks the first v0.4.0 release shipped and records how the design changed on the
  way: a stateless plan token that covers both sides, `destinationFolderPath`, a `conflicts`
  list, and no `onConflict` option. `batch_upload` and `download_project_zip` follow in a point
  release.

## [0.3.2] - 2026-09-22

Documentation only. No tool was added, removed, or changed in schema or result shape; the server
still registers 24 tools.

### Documentation

- **"How it compares" in the README**: a capability table comparing this server with the three
  most-starred Overleaf MCP servers and the two closest in design, each checked against its own
  source code, with numbered notes for every partial entry. The related-projects table in the
  internals page now lists `olcli` and describes `overleaf-mcp-rt` correctly.
- An updated workflow illustration in the README and the package.

## [0.3.1] - 2026-09-22

Proxy support. On a network that allows outbound traffic only through an HTTP proxy, listing
projects could work while every project tool failed with `ENOTFOUND`, because the collaboration
WebSocket never used the proxy. Reported, diagnosed, and first fixed by
[@Yusuf00Aras](https://github.com/Yusuf00Aras) in
[#6](https://github.com/mhmdaskari/overleaf-web-mcp/pull/6). No tool was added or removed, and no
schema or result shape changed; the server still registers 24 tools.

### Fixed

- **REST requests, the Socket.IO handshake, and the collaboration WebSocket all honour
  `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY`, and always take the same route.** The server
  resolves one proxy for `OVERLEAF_BASE_URL` at startup and applies it to every connection.
  Previously REST requests used a proxy only on recent Node releases with `NODE_USE_ENV_PROXY=1`,
  and the WebSocket never did. The variable follows the base URL's scheme, lowercase names take
  precedence, a bare `host:port` means an HTTP proxy, and `NO_PROXY` matches a host and its
  subdomains, optionally by port. This now works on Node 20, with no `NODE_USE_ENV_PROXY` needed.
- **An unusable proxy value fails at startup** with `INVALID_ARGUMENT` naming the variable, for
  example a SOCKS URL or one that does not parse. The message never includes the value, which can
  hold credentials, and proxy credentials are never printed.

### Changed

- A proxy variable set in the server's environment now takes effect on every supported Node
  version. If Overleaf is reachable directly while such a variable is set for other tools, list
  its host in `NO_PROXY`.
- New runtime dependencies: `undici` for proxied REST requests and `https-proxy-agent` for the
  proxied WebSocket.

### Documentation

- "Behind a proxy" in the configuration guide, the proxy variables in its reference table, and a
  troubleshooting entry for networks that require a proxy.

## [0.3.0] - 2026-09-14

Session keepalive. Overleaf's web session lasts five days from its last use and is refreshed by
every request, so a saved session that went unused for five days made the server exit at startup
with `AUTH_EXPIRED` on stderr, which MCP clients surface only as "Connection closed". No tool was
added or removed; the server still registers 24 tools.

### Added

- **`overleaf-web-mcp keepalive`**, a CLI command that runs the server's startup bootstrap, merges
  the refreshed session cookie into the jar, prints `refreshed`, `baseUrl`, `sessionExpiresAt`,
  and `userId`, and exits. Against a dead session it exits with status 1 and the `AUTH_EXPIRED`
  error on stderr, so a scheduler can alert on it. Daily scheduling with `launchd`, `cron`, and
  Task Scheduler is documented in the configuration guide.
- **`auth_status` reports `sessionExpiresAt`**, the earliest deadline among the cookies sent to
  Overleaf, as ISO 8601. The field is absent when no cookie carries a deadline. `auth_status` now
  declares an `outputSchema` and returns `structuredContent`; its other fields are unchanged.
- **A table of all 24 tools in the README**, grouped as in the tool reference, with a test that
  fails if a registered tool is missing from it.

### Fixed

- **The cookie jar now persists the session deadline.** The Netscape serializer read `expires`,
  which tough-cookie leaves unset for a `Max-Age` cookie, so the session cookie was written with
  expiry `0` and its five-day deadline was lost on every save. It now uses `expiryTime()`, which
  accounts for `Max-Age`. Behaviour was otherwise unaffected, since a cookie without an expiry is
  still sent; what was missing was any way to persist or report the deadline.
- **Domain cookies are written with the include-subdomains flag set and a leading dot**, derived
  from tough-cookie's `hostOnly` rather than from a leading dot it had already stripped. The
  server read its own jar correctly either way; other Netscape readers, `curl` included, treated
  the session cookie as host-only and did not send it to `www.overleaf.com`. Jars written by
  earlier releases keep loading exactly as before.

### Changed

- The initialize instructions mention `sessionExpiresAt` and the keepalive command.

### Documentation

- "Keeping the session alive" in the configuration guide, a troubleshooting entry for a client
  that reports only "Connection closed" at startup, and a note on the five-day limit in the
  README's sign-in step.
- The roadmap makes session keepalive its own shipped stage, moves bulk sync to v0.4.0 with
  `plan_sync`, `sync_directory`, and `delete_entities` first, and renumbers the later stages.

## [0.2.1] - 2026-09-10

Documentation only. No tool was added, removed, or changed in schema or result shape; the server
still registers 24 tools.

### Changed

- The example project names in the README, the documentation site, and the roadmap are now generic
  placeholders, consistent with the other examples around them. They previously named a real
  project.

## [0.2.0] - 2026-09-10

Project lifecycle. Until now every tool took an existing `projectId`, so an agent could not create,
rename, trash, or configure a project without a person doing it in the web UI. The server now
registers 24 tools. Planned in [ROADMAP.md](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/ROADMAP.md),
which this release also merges with a second draft into one document with per-stage tasks and
acceptance criteria.

### Added

- **`create_project`**, **`clone_project`**, and **`import_project_zip`** create a project from a
  name, an existing project, or a local `.zip` archive, and return `projectId`, `name`, `url`, and
  (for `create_project`) `rootDocPath`. A blank project still holds Overleaf's stub `main.tex`;
  the descriptions say so and point at `update_project_settings`.
- **`manage_project`** renames, trashes, restores, archives, unarchives, or permanently deletes a
  project. `trash`, `archive`, and `delete` require `confirmName` to equal the current project
  name exactly, and `delete` only succeeds on a project that is already trashed, following
  Overleaf's own trash-first model.
- **`update_project_settings`** persists the root document (`rootFilePath`, which must resolve to
  a text document), `compiler`, TeX Live `imageName`, or `spellCheckLanguage` in the project, so
  the web editor's Recompile follows the change. It returns the settings as re-read from a fresh
  project join.
- **`list_projects` filters**: `query` (case-insensitive substring), `includeArchived`,
  `includeTrashed` (both default `false`), `limit` (default 50, at most 200), and `sort`
  (`lastUpdated`, newest first, or `name`).
- **`RATE_LIMITED`** error code for HTTP 429, retryable, with `details.retryAfterMs` parsed from
  `Retry-After` when Overleaf sends it. Zip import and project creation are the routes Overleaf
  throttles first.
- **`CONFIRMATION_MISMATCH`** error code for every confirm-by-value failure (`confirmPath`,
  `confirmName`). Nothing is changed when it is returned.
- **`outputSchema` and `structuredContent`** on the five new tools and on `list_projects`. The
  JSON text block is still returned for clients that do not read structured results.
- **`get_project_tree` reports `spellCheckLanguage`** alongside `compiler` and `imageName`.
- **[`docs/private-api.md`](https://mhmdaskari.github.io/overleaf-web-mcp/private-api/)**
  catalogues every Overleaf route the server calls, the fields it sends and reads, and the error
  code each failure maps to.
- A gated live test (`RUN_OVERLEAF_LIVE_LIFECYCLE_TESTS=1`) that creates a disposable project,
  sets its root document, compiles it, and trashes it. It never deletes permanently.
- **Usage instructions in the MCP initialize response.** The server now sets the MCP
  `instructions` field, so clients that surface it (Claude Code among them) give the model the
  safety contract, read before write, revision handling, `upload_file` semantics, confirmations,
  compile allowance, and what to do on `AUTH_EXPIRED`, without anyone pasting the README into a
  prompt. Exported as `SERVER_INSTRUCTIONS`; a test keeps it under 450 words.
- **Documentation site** at <https://mhmdaskari.github.io/overleaf-web-mcp/>, built with MkDocs
  Material from `docs/` and deployed by GitHub Actions on every push to `main`. It holds the full
  tool reference, safety model, configuration, internals, development guide, roadmap, and this
  changelog.
- **`AGENTS.md`** for coding agents contributing to the repository, with the rules that must keep
  holding, test expectations, and the release steps. `CLAUDE.md` imports it for Claude Code.

### Changed

- **`list_projects` returns an object instead of a bare array**: `{ projects, totalMatched,
  totalProjects }`, where each project carries `id`, `name`, `accessLevel`, `lastUpdated`,
  `archived`, and `trashed`. Archived and trashed projects are hidden by default, and the default
  order is newest first rather than by name. The list now comes from the dashboard endpoint
  (`POST /api/project`) instead of the legacy `GET /user/projects`, and its shape is validated;
  an unexpected shape surfaces as `PROTOCOL_UNSUPPORTED`.
- **`auth_status.projectCount`** counts every project the account can access, archived and
  trashed included, through the same endpoint.
- **`manage_entity` with a wrong `confirmPath` now fails with `CONFIRMATION_MISMATCH`** instead of
  `INVALID_ARGUMENT`. The message is unchanged.
- The initialize instructions gain a paragraph on project lifecycle and `confirmName`; they
  remain under the 450-word bound the test enforces.
- **README rewritten for people.** It now leads with what you can say to an assistant, a
  three-step install, what the server can do, and how it keeps a project safe, in plain language,
  and links to the site for everything else. The tool tables, the configuration table, the
  protocol notes, and the step-by-step workflows moved to the documentation site.
- The tool-count test now checks the README badge and the docs tool reference instead of two
  places in the README.

### Documentation

- A "from nothing to a compiled PDF" walkthrough in the usage guide that needs no web-UI step.
- The README and site list the lifecycle tools, and the related-projects section states that
  web-session peers also offer tracked changes while Git-bridge servers need a paid plan and
  bypass tracked changes.
- The roadmap is one merged document with a Stage 0 verification checklist, conventions, tool
  signatures, tasks, acceptance criteria, an error taxonomy, and a competitive table.

## [0.1.3] - 2026-09-01

Documentation, metadata, and small additive fixes. No tools were added or removed; the server
still registers 19 tools. Planned in [ROADMAP.md](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/ROADMAP.md).

### Changed

- **`get_project_tree` now returns an object instead of a bare array.** The entities are under
  `entities`, alongside `rootDocPath`, `compiler`, `imageName`, `trackChangesActive`, and a
  `hashNote` describing the hash format. Callers that iterated the result directly must now
  iterate `result.entities`. This is the only response-shape change in this release.
- **`compile_project.rootFilePath` is now optional.** Omitted, it compiles the root document
  configured in Overleaf itself, matching the web UI's Recompile button. A project with no
  configured root and no `rootFilePath` returns `INVALID_ARGUMENT` instead of failing to
  resolve a path. Its description no longer leaks the internal `rootDoc_id` parameter name.
- **`upload_file` is annotated `destructiveHint: true`.** It replaces an existing entity at the
  destination path in place, so the previous `destructiveHint: false` misdescribed it.
- **`upload_file` returns a normalized result**: `entityId`, `entityType`, `path`, `replaced`,
  and, for binary files, `hash`. Overleaf's raw response is no longer passed through under an
  `upload` key.
- **`compile_project` results now include `rootFilePath`**, the document actually compiled.
- **`download_file` no longer silently overwrites a local file.** It fails with
  `INVALID_ARGUMENT` unless the new `overwrite` parameter is `true`, and returns `localPath`
  alongside `bytes`.

### Added

- **`write_file` accepts `localPath`** as an alternative to `content`, mutually exclusive with
  it. This keeps a whole-file replacement revision-checked and optionally tracked without
  sending the file through the MCP client's tool-argument budget. Non-UTF-8 content is rejected
  rather than written as replacement characters, and a leading byte order mark is stripped.
- **`upload_file` accepts `destinationName`**, so a local file can be stored under a different
  name in the project.
- **Overleaf's upload rejections are translated into actionable errors.** Overleaf reports
  `duplicate_file_name`, `invalid_filename`, `project_has_too_many_files`, and
  `folder_not_found` as HTTP 422; these now surface as `INVALID_ARGUMENT` with an explanation
  and the original code in `details.overleafError`, instead of a bare `REMOTE_ERROR`. Only a
  short lowercase identifier is ever propagated, so no response content can leak through an
  error.
- **Continuous integration on pushes and pull requests** running type-check, lint, tests,
  build, and the packed-file check. Previously these ran only when a release was published.
- **[ROADMAP.md](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/ROADMAP.md)** describing the planned path from 0.1.3 to 1.0.0.
- **This changelog.**

### Documentation

- The `hash` field is documented as a git blob hash, `sha1("blob " + byteLength + "\0" + content)`,
  identical to `git hash-object <file>`. Plain `sha1sum` never matches. The hash is present only
  on binary `file` entities; Overleaf stores no content hash for `doc` entities.
- `upload_file`'s upsert semantics are documented, including that Overleaf decides `doc` versus
  `file` by extension and UTF-8 validity, that it is a valid way to replace `.tex`, `.bib`, and
  `.bst` documents from disk, and that replacing a document this way is a blind, untracked write.
- A decision table for `write_file` versus `upload_file`, and the real document and update size
  limits, so callers no longer have to guess a size threshold.
- A worked example of the hash-comparison workflow for uploading only changed binaries.
- A test asserts the README's tool count matches the registered tool list, so the badge cannot
  drift.

## [0.1.2] - 2026-07-20

- Project history monitoring through `monitor_project_history`.
- Tracked document writes through `writeMode` on `write_file`, `create_file`, and
  `write_section`.

## [0.1.1] - 2026-07-16

- Documentation and packaging corrections.

## [0.1.0] - 2026-07-15

- First release: browser-assisted session capture, project and file management, revision-checked
  and section-level writing, compilation, and review comments.

[0.9.0]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.9.0
[0.8.1]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.8.1
[0.8.0]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.8.0
[0.7.1]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.7.1
[0.7.0]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.7.0
[0.6.2]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.6.2
[0.6.1]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.6.1
[0.6.0]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.6.0
[0.5.1]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.5.1
[0.5.0]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.5.0
[0.4.1]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.4.1
[0.4.0]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.4.0
[0.3.2]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.3.2
[0.3.1]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.3.1
[0.3.0]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.3.0
[0.2.1]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.2.1
[0.2.0]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.2.0
[0.1.3]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.1.3
[0.1.2]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.1.2
[0.1.1]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.1.0
