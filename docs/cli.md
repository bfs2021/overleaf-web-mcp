# Command line

Every tool is also a command. `overleaf-web-mcp` reaches the same 34 operations as the MCP
server, through the same service, checks, and safety defaults, and prints one JSON result whose
exit code says what is safe to do next. Use it from a shell, a script, a CI job, or a coding
agent that works in a terminal; no MCP client is involved. Three [Agent Skills](#agent-skills)
build on it.

## Install and sign in

You need Node.js 20 or newer and, once, a Chrome-family browser for the sign-in.

```bash
npx overleaf-web-mcp login
npx overleaf-web-mcp call auth_status
```

`login` opens a browser window and saves the session, as in the
[installation guide](install.md#1-sign-in-once). `call auth_status` then prints the account's
project count and when the session expires, and exits 0. For frequent use, install the package
once with `npm install -g overleaf-web-mcp` and run `overleaf-web-mcp` directly. In a script, pin the version and pass `--yes`, as in
`npx --yes overleaf-web-mcp@1.0 projects list`: without `--yes`, `npx` can print an install
notice on stderr the first time.

Commands read the same environment variables as the server, from the shell they run in; see
[configuration](configuration.md). The session lapses after five idle days unless something uses
it; schedule `overleaf-web-mcp keepalive` to keep it alive
([how](configuration.md#keeping-the-session-alive)).

## Commands

This is the list `overleaf-web-mcp --help` prints:

```text
overleaf-web-mcp serve
overleaf-web-mcp login
overleaf-web-mcp keepalive
overleaf-web-mcp --help

overleaf-web-mcp call <tool_name> [--request <file> | --request - | --json <object>] [--progress]
overleaf-web-mcp schema <tool_name> (--input | --output)
overleaf-web-mcp capabilities [projectId]
overleaf-web-mcp doctor [projectId]

overleaf-web-mcp projects list [--query <q>] [--limit <n>] [--sort lastUpdated|name] [--include-archived] [--include-trashed]
overleaf-web-mcp tree <projectId>
overleaf-web-mcp files read <projectId> <path>
overleaf-web-mcp files write <projectId> <path> --revision <r> (--content-file <f> | --stdin) [--tracked]
overleaf-web-mcp files download <projectId> <path> <localPath> [--overwrite]
overleaf-web-mcp sync plan <projectId> <localFolder> [--destination <path>] [--ignore <glob>]... [--verbose] [--progress]
overleaf-web-mcp sync apply <projectId> <localFolder> --mode additive|mirror (--plan-token <t> | --unplanned) [--destination <path>] [--ignore <glob>]... [--confirm-delete-count <n>] [--tracked] [--stop-on-error] [--progress]
overleaf-web-mcp compile run <projectId> [--root <path>] [--draft] [--stop-on-first-error] [--download <localPath>] [--overwrite]
overleaf-web-mcp compile log <projectId> --build-ref <r> [--tail <n>] [--kind latex|bibtex] [--errors-only]
overleaf-web-mcp compile download <projectId> <localPath> --build-ref <r> [--file <f>] [--overwrite]
overleaf-web-mcp comments list <projectId> [--status open|resolved|all] [--file <path>] [--author <a>]
overleaf-web-mcp tracked-changes list <projectId> [--file <path>] [--type insert|delete] [--author <id>] [--limit <n>] [--excerpt-chars <n>]
overleaf-web-mcp tracked-changes accept <projectId> <path> --revision <r> --change <id>... --confirm-count <n>
overleaf-web-mcp tracked-changes reject <projectId> <path> --revision <r> --change <id>... --confirm-count <n>
```

`serve`, `login`, `keepalive`, and `--help` are the server and session commands; `serve` is the
default when no command is given. Everything else is an **operation command**.

| Command | What it does | Since |
| --- | --- | --- |
| `serve` | Start the MCP stdio server | <!-- md:version 0.1.0 --> |
| `login` | Save an authenticated Overleaf session from a browser sign-in | <!-- md:version 0.1.0 --> |
| `keepalive` | Refresh the saved session so it does not expire | <!-- md:version 0.3.0 --> |
| `--help` | Show the help | <!-- md:version 0.1.0 --> |
| `call` | Run any operation with a JSON request | <!-- md:version 0.7.0 --> |
| `schema` | Print an operation's input or output JSON Schema | <!-- md:version 0.7.0 --> |
| `capabilities` | List operations, effects, the access policy, and exit codes | <!-- md:version 0.7.0 --> |
| `doctor` | Check, read-only, that the session, Overleaf, and a project socket work | <!-- md:version 1.0.0 --> |

`call <tool_name>` reaches every operation; the names are those in the
[tool reference](tools.md). `schema` and `capabilities` describe the operations without calling
them, and `doctor` checks this install against Overleaf. The rest are shorthand: each only builds a tool's input, and its result, errors, and exit
code are those of `call <tool>` with the same input. Anything a shorthand does not cover, such as
`timeoutMs` on a compile, goes through `call`. `--help` or `-h` anywhere in an operation command
prints the help and exits 0.

| Command | Tool | Arguments and flags become | Since |
| --- | --- | --- | --- |
| `projects list` | `list_projects` | `--query` `query`, `--limit` `limit`, `--sort` `sort`, `--include-archived` `includeArchived: true`, `--include-trashed` `includeTrashed: true` | <!-- md:version 0.7.0 --> |
| `tree` | `get_project_tree` | `<projectId>` `projectId` | <!-- md:version 0.7.0 --> |
| `files read` | `read_file` | `<path>` `filePath` | <!-- md:version 0.7.0 --> |
| `files write` | `write_file` | `<path>` `filePath`, `--revision` `revision`, `--content-file` `localPath`, `--stdin` `content`, `--tracked` `writeMode: "tracked"` | <!-- md:version 0.7.0 --> |
| `files download` | `download_file` | `<path>` `filePath`, `<localPath>` `localPath`, `--overwrite` `overwrite: true` | <!-- md:version 0.7.0 --> |
| `sync plan` | `plan_sync` | `<localFolder>` `localFolderPath`, `--destination` `destinationFolderPath`, each `--ignore` one `ignore` pattern, `--verbose` `verbose: true` | <!-- md:version 0.7.0 --> |
| `sync apply` | `sync_directory` | as `sync plan`, plus `--mode` `mode`, `--plan-token` `planToken`, `--unplanned` `unplanned: true`, `--confirm-delete-count` `confirmDeleteCount`, `--tracked` `writeMode: "tracked"`, `--stop-on-error` `stopOnError: true` | <!-- md:version 0.7.0 --> |
| `compile run` | `compile_project` | `--root` `rootFilePath`, `--draft` `draft: true`, `--stop-on-first-error` `stopOnFirstError: true`; `--download` and `--overwrite` are [below](#compiling-across-processes) | <!-- md:version 0.7.0 --> |
| `compile log` | `get_compile_log` | `--build-ref` `buildRef`, `--tail` `tail`, `--kind` `kind`, `--errors-only` `format: "errors-only"` | <!-- md:version 0.7.0 --> |
| `compile download` | `download_compile_output` | `<localPath>` `localPath`, `--build-ref` `buildRef`, `--file` `file`, `--overwrite` `overwrite: true` | <!-- md:version 0.7.0 --> |
| `comments list` | `list_comments` | `--status` `status`, `--file` `filePath`, `--author` `author` | <!-- md:version 0.7.0 --> |
| `tracked-changes list` | `list_tracked_changes` | `--file` `filePath`, `--type` `type`, `--author` `authorId`, `--limit` `limit`, `--excerpt-chars` `excerptChars` | <!-- md:version 0.8.0 --> |
| `tracked-changes accept` | `manage_tracked_changes` | `action: "accept"`, `<path>` `filePath`, `--revision` `revision`, each `--change` one `changeIds` entry, `--confirm-count` `confirmCount` | <!-- md:version 0.8.0 --> |
| `tracked-changes reject` | `manage_tracked_changes` | as `tracked-changes accept`, with `action: "reject"` | <!-- md:version 0.8.0 --> |

A few rules the table does not show:

- `files write` takes exactly one of `--content-file` and `--stdin`. `--content-file` is passed as
  `write_file`'s `localPath`, so the operation reads the file itself and
  `OVERLEAF_LOCAL_READ_ROOTS` applies. `--stdin` reads all of stdin as UTF-8 text; a leading byte
  order mark is dropped and invalid UTF-8 is refused.
- A `planToken` is bound to the local folder, `--destination`, and `--ignore`, so `sync apply`
  needs the same values `sync plan` was given. Mirror mode needs `--confirm-delete-count`.
- `compile log` and `compile download` require `--build-ref`.
- `tracked-changes accept` and `reject` take the `revision` that `tracked-changes list` printed for
  the document, and `--confirm-count` equal to the number of `--change` ids after the user has
  confirmed them; without it the call is refused with `CONFIRMATION_MISMATCH`, exit 2, and
  nothing is sent.
- `--limit`, `--tail`, `--excerpt-chars`, `--confirm-delete-count`, and `--confirm-count` take
  whole numbers.
- An unknown option, a missing value, or the wrong number of arguments is a usage error: exit 2,
  with a message that names the option but never repeats a value.
- Local paths, here and in requests, resolve against the shell's working directory.

## Requests

`call <tool>` takes the tool's input as one JSON object, the same object an MCP client sends as
the tool's arguments:

| Flag | The request comes from |
| --- | --- |
| `--request <file>` | the file |
| `--request -` | stdin |
| `--json '<object>'` | the argument itself |
| none | nothing: the input is `{}`, for a tool without parameters such as `auth_status` |

`--json` puts the request in the process's arguments, which process listings and shell history
show. Keep it for small requests without document text. Document text, and comment text, goes
through `--request <file>`, `--request -`, `files write --content-file`, or `files write --stdin`.
A request that is not valid JSON, or not an object, is `INVALID_ARGUMENT`, and the message says
only that; it never quotes the request. An unreadable request file is `INVALID_ARGUMENT` with
`details.errno`. When stdin is a terminal, a command that would read it is refused with
`INVALID_ARGUMENT`: an operation command never waits for typed input.

### Input is strict

The input is checked against the tool's input schema before any session is opened, so a refused
call sends nothing and exits 2:

- A key the schema does not list, at any depth, is `INVALID_ARGUMENT` with `details.unknownKeys`,
  dotted paths such as `files.0.localpth`.
- A value the schema refuses is `INVALID_ARGUMENT` with `details.issues`, each
  `{ path, message }`.

Defaults are then applied as the MCP server applies them, so the operation receives exactly what
it would through MCP. `overleaf-web-mcp schema <tool> --input` prints the parameters.

The MCP server is more lenient about unknown keys. The MCP SDK checks arguments against the same
schemas but drops a key it does not know without an error, so through MCP a misspelled
`writeMod: "tracked"` is ignored and the edit is written untracked, the default. The command line
and the [TypeScript SDK](sdk.md) refuse it:

```console
$ cat edit.json
{ "projectId": "0123456789abcdef01234567", "filePath": "main.tex", "revision": "opaque-revision-from-files-read",
  "localPath": "main.tex", "writeMod": "tracked" }
$ overleaf-web-mcp call write_file --request edit.json
{"code":"INVALID_ARGUMENT","message":"write_file does not accept the parameter writeMod. Run `overleaf-web-mcp schema write_file --input` for the parameters it takes.","retryable":false,"details":{"unknownKeys":["writeMod"]}}
$ echo $?
2
```

A value the schema refuses differs in form too: the MCP SDK answers it before the server runs the
tool, with its own plain-text error (`Input validation error: Invalid arguments for tool ...`) and
no JSON code, where the command line and the SDK report `INVALID_ARGUMENT` with `details.issues`.

## Output

On success an operation command prints exactly one JSON value on stdout, indented, with a
trailing newline: the tool's result, the same object the MCP server returns as
`structuredContent` and the [SDK](sdk.md) method resolves with. stderr stays empty unless
`--progress` was given.

`doctor` is the exception: it prints its report on stdout whether it exits 0 or 1
([checking an install](#checking-an-install)).

On failure stdout stays empty, and stderr gets exactly one line,
`{ "code", "message", "retryable", "details"? }`, the same error the MCP server returns. Messages
never repeat option values or request content; they can name local paths you supplied. The codes
are listed in the [safety model](safety.md#error-codes).

### Progress

<!-- md:version 0.7.0 -->

With `--progress`, on `call`, `sync plan`, or `sync apply`, operations that report progress write
one JSON line to stderr per step:

```json
{"progress":{"progress":3,"total":12,"message":"Handled 3 of 12 files"}}
```

`plan_sync`, `sync_directory`, `batch_upload`, and `delete_entities` report progress; other
operations write none. Messages hold counts only, never file names. The result still goes to
stdout as one JSON value; on failure the error is the last line on stderr.

### Server and session commands

`serve` writes nothing but MCP protocol frames to stdout, and diagnostic lines naming a tool and
an error code to stderr. `--help` prints plain text. `login` and `keepalive` print one JSON value
on stdout; `login` also writes plain-text status lines to stderr while it waits for the sign-in.
These commands exit 1 on any failure, with the error as one JSON line on stderr; so does an
unknown command. The exit codes below are for operation commands only.

## Exit codes

<!-- md:version 0.7.0 -->

| Exit | Meaning | Error codes |
| :---: | --- | --- |
| 0 | Complete. | |
| 1 | Failed for another reason; read the error code. | for example `NOT_FOUND`, `PROTOCOL_UNSUPPORTED`, `REMOTE_ERROR`, `COMPILE_FAILED`, `COMPILE_TIMEOUT`, `NO_BUILD`, `BUILD_NOT_FOUND`, `DOC_TOO_LARGE`, `UPDATE_TOO_LARGE`, `PARTIAL_CLEANUP` |
| 2 | Fix the call: a usage error, or an argument, confirmation, or local path was refused. Nothing was changed. | usage errors, `INVALID_ARGUMENT`, `CONFIRMATION_MISMATCH`, `PATH_OUTSIDE_ROOT` |
| 3 | Not allowed or not available; do not retry. `AUTH_EXPIRED` means run `overleaf-web-mcp login`. | `AUTH_EXPIRED`, `PERMISSION_DENIED`, `POLICY_DENIED`, `REVIEW_UNSUPPORTED` |
| 4 | Read or plan again, then decide: the document or project changed, a write is known not to have applied, part of it applied, or a tracked write applied untracked. | `REVISION_CONFLICT`, `REMOTE_DRIFT`; `TIMEOUT` with `details.outcome: "not_applied"` from an operation that is not read-only; `PROTOCOL_UNSUPPORTED` with `details.kind: "applied_untracked"`; any error with `details.created: true` or a non-empty `details.applied` from one |
| 5 | Outcome unknown: a write may have applied. Read before acting; never re-run it blindly. | `OUTCOME_UNKNOWN`; `TIMEOUT` from an operation that is not read-only, unless `details.outcome` is `not_applied`; `TRANSIENT_FAILURE` from an operation that is not read-only, since its failed read may have followed the write |
| 6 | Partial: some steps completed. The result is on stdout with `status: "partial"`. | none: a `batch_upload`, `sync_directory`, or `delete_entities` result with `status: "partial"`, or `compile run --download` whose download failed |
| 7 | Safe to retry later: nothing was changed. | `RATE_LIMITED`, `COMPILE_RATE_LIMITED`, `COMPILE_UNAVAILABLE`; `TIMEOUT` and `TRANSIENT_FAILURE` from a read-only operation |

Four rules reach beyond the codes in the table, and one rule overrides everything:

- **`details.outcome: "unknown"` wins.** Any error that carries it exits 5, whatever its code, a
  `REVISION_CONFLICT` included. This is checked first.
- **A write that partly applied exits 4.** An error with `details.created: true`, such as
  `create_file` that created the document but could not write its content, or a non-empty
  `details.applied`, such as `update_project_settings` that stored some settings before one
  failed, exits 4 whatever its code, unless the code exits 3. Exits 2 and 7 promise that nothing
  changed, so they are never used for it. Read what is there, then decide; never re-run the whole
  call.
- **A write known not to have applied exits 4.** Any error with `details.outcome: "not_applied"`
  from an operation that is not read-only exits 4, whatever its code: for example a
  `REMOTE_ERROR` after a write's socket closed and the original revision stayed live throughout
  the recovery window, or `UPDATE_TOO_LARGE` when Overleaf refused the update as too large and
  stored nothing. An `UPDATE_TOO_LARGE` from the local size check, before anything is sent,
  exits 1.
- **A read that failed transiently exits 7.** Any error with `retryable: true` from a read-only
  operation exits 7, a network `REMOTE_ERROR` for example: a read changes nothing, so it can run
  again later.
- **Opening the session is a read.** A failure while the command loads and checks the saved
  session, before its operation starts, exits as a read's would, even for a command that writes:
  a `TIMEOUT` or `TRANSIENT_FAILURE` there exits 7, since nothing of the operation was sent.

The read-only operations are those annotated so in the [tool reference](tools.md): `auth_status`,
`list_projects`, `get_project_tree`, `read_file`, `plan_sync`, `get_full_document`,
`get_sections`, `get_section_content`, `get_compile_log`, `list_comments`, `list_tracked_changes`, and
`monitor_project_history`. `download_file` and `download_compile_output` write a local file, so
they are not; `capabilities <projectId>` exits as `list_projects` would.

`retryable` alone is not a safe signal for a wrapper that re-runs commands: the HTTP client marks
every timeout `retryable: true`, uploads and deletes included. A script may re-run on 7, should
read or plan again on 4, and must never re-run on 5: read the document, the tree, or the thread
first and decide from what is there. `capabilities` prints this table as its `exitCodes`.

## Compiling across processes

`compile run` prints `compile_project`'s result. A LaTeX error that stopped the build is a result,
not an error: `status: "failure"` with `summary.builtCleanly: false`, exit 0. Judge a build by
`summary.builtCleanly`, never by the exit code. A compile that produced no build to report on is
an error: `COMPILE_FAILED` or `COMPILE_TIMEOUT` exits 1, `COMPILE_RATE_LIMITED` and
`COMPILE_UNAVAILABLE` exit 7. A `TIMEOUT` exits 5, because Overleaf may still be compiling.

Each command is a new process, and a new process has no latest build. `compile log` and
`compile download` therefore require `--build-ref`, the `buildRef` from `compile run`'s result.
Through `call`, `get_compile_log` or `download_compile_output` without a `buildRef` fails with
`NO_BUILD`.

`compile run --download <localPath>` does both in one process: it compiles, then saves that same
build's `output.pdf` to `localPath`, replacing an existing file only with `--overwrite`.
`--overwrite` without `--download` is a usage error. The result wraps both:

```json
{ "status": "complete", "compile": { "...": "the compile_project result" }, "download": { "...": "the download_compile_output result" } }
```

If the compile worked but the download failed, a build without a PDF included, the result is
still printed, with exit 6:

```json
{ "status": "partial", "compile": { "...": "the compile_project result" }, "download": null, "downloadError": { "code": "NOT_FOUND", "message": "...", "retryable": false } }
```

The compile result keeps its `buildRef`, so `compile download --build-ref` can fetch the PDF later
without compiling again. A compile that fails is that compile's error, and nothing is downloaded.

## Describing the operations

<!-- md:version 0.7.0 -->

`schema <tool> --input` and `schema <tool> --output` print a tool's JSON Schema exactly as the MCP
server's `tools/list` advertises it: draft 2020-12, with an object at the root. A tool without
parameters has the input schema `{ "type": "object", "properties": {} }`. The input schemas do
not forbid other keys; the command line refuses them anyway, as [above](#input-is-strict).

`capabilities [projectId]` prints what this install can do:

- `version`: the package version.
- `operations`: for each tool, `{ name, effects, annotations, blockedEffects, commands }`.
  `effects` is everything the tool can do; a given call may need less. `blockedEffects` lists the
  effects `OVERLEAF_ALLOWED_EFFECTS` refuses: the tool fails with `POLICY_DENIED` only when a call
  needs one of them. `commands` names its shorthand commands besides `call`.
- `policy`: `{ projectsRestricted, effectsRestricted, localReadRestricted, localWriteRestricted }`,
  which [access policy](configuration.md#access-policy) variables are set.
- `project`: `{ projectId, allowedByPolicy, accessLevel, archived, trashed }`.
- `backend` <!-- md:version 1.0.0 -->: what the backend behind every operation can do, `{ kind, liveRevisions,
  trackedWrites, review: { list, decide }, comments, compile, history }`. The only `kind` is
  `"web-session"`, the saved browser session. `review.decide` says whether this account can
  accept or reject tracked changes in the project: `false` when the project's owner's plan or the
  deployment turns track changes off, or the account is neither owner nor editor, in which case
  `manage_tracked_changes` fails with `REVIEW_UNSUPPORTED` or `PERMISSION_DENIED` before sending
  anything. It is `"unknown"` without a `projectId`.
- `errorCodes` and `exitCodes`: every error code, and the exit-code table as
  `{ exitCode, meaning, errorCodes }`.

Without a `projectId`, every `project` field is `"unknown"` and no session is opened. With one
outside `OVERLEAF_ALLOWED_PROJECTS`, `allowedByPolicy` is `false`, the rest `"unknown"`, and
nothing is sent. Otherwise one project-list request and a join of the project's socket fill in the
rest, and a project the account cannot see is `NOT_FOUND`. The join shows the account online to
collaborators until the command exits. The access policy is resolved first, as every command resolves it, so a
policy every other command would refuse, such as a root folder that does not exist, fails here too
with `INVALID_ARGUMENT` and exit 2.

## Checking an install

<!-- md:version 1.0.0 -->

`doctor [projectId]` checks, read-only, that this install works against its Overleaf, and prints
`{ version, checks: [{ id, status, code? }] }`. It names no project, file, or person: only check
ids, statuses, and error codes. The checks, in order:

| Check | What passes |
| --- | --- |
| `config` | The access policy resolves (each local root folder exists) and allows reading from Overleaf (`overleaf-read` in `OVERLEAF_ALLOWED_EFFECTS`). |
| `session.cookieJar` | A saved session exists and loads. |
| `bootstrap.page` | `GET /project` answers without sending you to the login page. |
| `bootstrap.csrfToken`, `bootstrap.userId` | The project page carries the token and the signed-in user this release reads. |
| `api.projects` | The project list answers in the shape this release reads. |
| `policy.project` | The `projectId` is allowed by `OVERLEAF_ALLOWED_PROJECTS`. |
| `socket.handshake` | The Socket.IO handshake answers and offers the websocket transport. |
| `joinProject`, `joinProject.protocolVersion` | The project joins, in a collaboration protocol version this release speaks (`OVERLEAF_PROTOCOL_VERSIONS`). |
| `joinDoc.rootDocument`, `leaveDoc.rootDocument` | The root document joins and is left again. |

Each `status` is `ok`, `failed` (with the error `code`), `unsupported` (Overleaf answered in a
shape or protocol this release does not understand, `code: "PROTOCOL_UNSUPPORTED"`), or `skipped`
(an earlier check failed, no `projectId` was given, or the project has no root document). Without
a `projectId` every check from `policy.project` on is skipped and no project socket is opened.
`doctor` exits 0 when no check failed or was unsupported, and 1 otherwise. It is the one command
whose report is printed even when it exits 1: the report is its result, so stdout holds it and
stderr stays empty. An environment variable that cannot be read, or a `projectId` with a
character no project id has, fails before any check, as a usage error: no report, the usual one
JSON error line on stderr, and exit 2. A well-formed id of no project fails at `joinProject`.
`doctor` never writes anything: no OT update, upload, or other change is sent. Each request is
tried once, so a passing failure shows as it is, and requests are paced by
`OVERLEAF_MIN_REQUEST_INTERVAL_MS`. Checking a project joins its socket, which shows the account
online to collaborators until `doctor` exits.

## Sessions, presence, and request volume

Each command is its own session. It loads the saved session, makes one `GET /project` to check
it, may open a project connection, and closes everything before it exits; `schema`, and
`capabilities` without a project id, open none, and `doctor` without one opens no project
connection. While it runs, the
account may appear online to collaborators in the editor. Nothing is kept between commands, so a
shell loop over files pays that start-up for every file and multiplies the requests Overleaf
sees. For many files, use one command:

- a folder: `sync plan`, then one `sync apply`;
- a list of files, each to its own project path: `call batch_upload`;
- several deletions: `call delete_entities`.

Keep request volume low. Overleaf rate-limits uploads, project downloads, and compiles per
project, and every compile spends the account's compile allowance.

## Several commands at once

Nothing is serialized across processes. The per-project queue that orders one server's calls
lives inside one process, so two commands running at the same time do not wait for each other.
They are protected the way two collaborators are: a write needs the revision from a read and
fails with `REVISION_CONFLICT` (exit 4) if the document changed in between, and a sync needs the
`planToken` from a plan and stops with `REMOTE_DRIFT` (exit 4) if either side moved. Refreshes of
the saved session are merged under the cookie jar's lock, so concurrent commands do not lose
them.

The access policy is per process as well. Under `OVERLEAF_ALLOWED_PROJECTS`, a project that
`call create_project`, `clone_project`, or `import_project_zip` creates is allowed for the rest of
that command only. The next command refuses it with `POLICY_DENIED` (exit 3) until its id is
added to `OVERLEAF_ALLOWED_PROJECTS`.

## No prompts, no confirmations, no re-runs

An operation command never prompts, never opens a browser (only `login` does), and never re-runs
a write or the command itself. Below it, a read that failed on the network or with HTTP 5xx, and
a project join that failed for a reason that passes, are tried again up to
`OVERLEAF_READ_ATTEMPTS` attempts in all before the command fails with `TRANSIENT_FAILURE`; see
[retries and pacing](configuration.md#retries-and-pacing). No flag supplies a confirm value for you: there is no `--yes` or `--force`. Destructive
tools take the same confirm-by-value parameters or expected state as through MCP, such as
`confirmPath`, `confirmName`, `confirmCount`, `--confirm-delete-count`, `--overwrite`,
`--revision`, or `--plan-token`. A call without one, or with a confirm value that does not match,
fails with exit 2; a stale revision or plan fails with exit 4. Either way nothing changes. The
defaults 0.6.0 enforced apply from the start.

## Examples

The examples use [`jq`](https://jqlang.org) to pick fields out of the JSON results, and `P` for
a project id from `projects list`.

```bash
P=0123456789abcdef01234567
```

### Read, edit, and write with a revision

```bash
overleaf-web-mcp files read "$P" main.tex > read.json
jq -j .content read.json > main.tex        # -j: no newline added
# ... edit main.tex ...
overleaf-web-mcp files write "$P" main.tex \
  --revision "$(jq -r .revision read.json)" --content-file main.tex --tracked
```

Exit 0 prints the new `revision`. Exit 4 is `REVISION_CONFLICT`: someone changed the document
since the read, so read it again, reconcile, and write with the new revision. Exit 5 means the
write may have applied: read the document before doing anything else.

### Plan a sync, then apply it

```bash
overleaf-web-mcp call download_project_zip --json "{\"projectId\":\"$P\",\"localPath\":\"$PWD/backup.zip\"}"
overleaf-web-mcp sync plan "$P" ./paper --ignore 'drafts/' > plan.json
jq '{toUpload, remoteOnly, conflicts}' plan.json      # review what would change and be deleted
overleaf-web-mcp sync apply "$P" ./paper --ignore 'drafts/' --mode mirror \
  --plan-token "$(jq -r .planToken plan.json)" --confirm-delete-count 3
```

`--confirm-delete-count` is the number of `remoteOnly` entries you reviewed, typed back, not
computed. Exit 4 is `REMOTE_DRIFT`: something changed since the plan, so plan again. Exit 6 is a
partial sync: read `completed`, `failed`, and `remaining`, and run `sync apply` again with the
`planToken` it returned to resume.

### Compile and read the log

```bash
overleaf-web-mcp compile run "$P" --download paper.pdf > build.json
jq .compile.summary.builtCleanly build.json
overleaf-web-mcp compile log "$P" --build-ref "$(jq -r .compile.buildRef build.json)" --errors-only
```

`compile log` reads the same build without compiling again. Exit 6 from `compile run` means the
build finished but its PDF could not be saved; `downloadError` says why.

### Review tracked changes

```bash
overleaf-web-mcp tracked-changes list "$P" --file main.tex > changes.json
jq '.documents[0].changes[] | {changeId, type, start, excerpt, authorId, pairedChangeId}' changes.json
# ... decide with the user which changes to reject ...
overleaf-web-mcp tracked-changes reject "$P" main.tex \
  --revision "$(jq -r '.documents[0].revision' changes.json)" \
  --change <changeId> --change <pairedChangeId> --confirm-count 2
```

`--confirm-count` is the number of changes the user confirmed, typed back, not computed. A
replacement is two changes linked by `pairedChangeId`; pass both. Exit 4 is `REVISION_CONFLICT`
and exit 1 with `NOT_FOUND` names ids that are no longer tracked changes: list again before
deciding. Exit 3 with `REVIEW_UNSUPPORTED` means the project or the deployment cannot decide
tracked changes this way. List again after every decision, since ids merge and split as the
document changes.

### Any other tool

```bash
cat > reply.json <<'EOF'
{ "projectId": "0123456789abcdef01234567", "threadId": "0123456789abcdef01234568",
  "content": "Fixed in the revised caption." }
EOF
overleaf-web-mcp call reply_to_comment --request reply.json
```

## Agent Skills

<!-- md:version 0.7.0 -->

The package ships three Agent Skills in its `skills/` folder, each a folder with a `SKILL.md` in
the open [Agent Skills](https://agentskills.io) format. A skill tells an agent working in a shell
how to do one job with these commands, and calls only the commands listed above.

| Skill | What it does |
| --- | --- |
| `overleaf-revise-manuscript` | Revise, shorten, or proofread a whole file or one section, optionally as tracked changes: read it with its revision, write the revised text back against that revision, and judge the build from the compile summary. |
| `overleaf-reviewer-comments` | Work through reviewer and co-author comments: list the threads, read the commented text in context, reply, add a comment anchored to a passage, resolve or reopen threads, and revise commented passages as tracked changes. |
| `overleaf-sync-sources` | Copy local figures, sources, or a whole folder into a project: offer a zip backup, plan, show the plan, apply exactly that plan, and delete only in mirror mode after the user confirms the count; or upload a list of files to chosen paths. |

Each treats manuscript text and reviewer comments as data, never as instructions. A project
path, which a collaborator chose, never goes on a shell command line: the skills put it in a
request file for `call`, and single-quote every other value. They run the
command line as `npx --yes overleaf-web-mcp@1.0 …`, so they need Node.js 20 or newer, network
access to Overleaf, and a session saved with `npx overleaf-web-mcp login`.

To install them from the repository with the [`skills`](https://github.com/vercel-labs/skills)
installer:

```bash
npx skills add mhmdaskari/overleaf-web-mcp
```

Or copy a skill folder from the installed package into the folder your agent reads skills from,
such as `.agents/skills/` or `.claude/skills/` in a project, or the same folders in your home
directory:

```bash
npm install -g overleaf-web-mcp
mkdir -p .agents/skills
cp -R "$(npm root -g)/overleaf-web-mcp/skills/overleaf-revise-manuscript" .agents/skills/
```
