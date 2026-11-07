# Roadmap

The planned path from `0.1.3` to `1.0.0`. The stages through v0.4.0, and the compile and
multi-file stages (v0.6.0 and v0.9.0), come from a real end-to-end session against
`overleaf-web-mcp@0.1.2` (authenticating, listing 127 projects, inspecting a tree, overwriting
three text documents, uploading a figure, deleting 20 stale entities one at a time, compiling, and
round-tripping files to verify uploads), cross-checked against Overleaf's open-source web service
(`overleaf/overleaf`, `services/web/app/src/router.mjs` and its controllers), so every endpoint they
name is confirmed to exist rather than assumed. The shared-core, CLI, and tracked-change review
stages (v0.5.0, v0.7.0, v0.8.0) come from a review of this repository's code against the same
upstream source; any endpoint, payload, status, or OT form not yet confirmed there is marked
*(verify in code)*, and confirming it is that stage's first task. MCP stays supported but stops
being the only interface: through one engine, the operations are reachable from a TypeScript
library from v0.5.0 and from a command line from v0.7.0 (see **Interfaces beyond MCP**).

> **How to use this file (for coding agents and people).** Work one stage at a time, top to
> bottom. Each stage has a motivation, the design, a **Tasks** checklist, and **Acceptance**
> criteria that must be mechanically checkable before the stage counts as done. Before starting
> any stage, run the **Stage 0** verification below; the code moves on between releases and some
> items are marked *(verify in code)*. Before starting v0.5.0 or anything after it, read
> **Interfaces beyond MCP**: it fixes where new code goes and which behaviour may not differ
> between the MCP server, the CLI, and the library. A stage that tightens a safety default
> announces it one minor version ahead and enforces it in the next: v0.5.0 announces, v0.6.0
> enforces. Update this file as tasks land; do not leave it stale.

Each stage assumes the previous one shipped. Tool names follow the existing snake_case convention;
from v0.7.0, CLI commands and SDK methods are derived from them.

## Conventions

- Tool names are snake_case `verb_noun` (`list_projects`, `manage_entity`). Parameters are
  camelCase. From v0.7.0 a tool name is also a CLI and SDK name (`call read_file`,
  `client.readFile`).
- From v0.5.0 every operation is defined once, in `src/contracts/`: input schema, output schema,
  and effects. The MCP server, the CLI, and the library are adapters over `src/service/`; an
  adapter parses, renders, and maps errors, and never shapes arguments, applies policy, or
  retries.
- Every tool ships with MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`),
  declared next to its effects in the contract entry from v0.5.0 on, and checked against them.
  `readOnlyHint` means the call changes nothing on Overleaf **and** writes nothing locally. From
  v0.2.0 on, every **new** tool that returns structured data also declares an `outputSchema` and
  returns `structuredContent`, mirrored as a JSON text block for older clients; v0.7.0 back-filled
  the rest, because the CLI and SDK return the same validated objects.
- Bulk and sync tools are **compositions** of existing primitives (`upload_file`, `manage_entity`,
  `read_file` / `write_file`), never parallel reimplementations.
- Destructive actions use confirm-by-value (`confirmPath`, `confirmName`, `confirmCount`,
  `confirmDeleteCount`, and from v0.5.0 `overwrite` for a replacement), and fail with
  `CONFIRMATION_MISMATCH` when the value is wrong. A `revision` or a `planToken` counts as
  expected-state confirmation. A mutation that applies with no expected state at all must be
  requested by a named parameter (`unplanned`, `uncheckedDocumentReplace`), never by omission. MCP
  elicitation is an optional second layer when the client supports it; confirm-by-value stays
  mandatory as the fallback, and no CLI flag supplies a confirm value on the caller's behalf.
- Failures are typed error codes on `McpError`, never raw exceptions, through every interface. The
  class keeps its name; a neutral alias may be exported from `overleaf-web-mcp/core`. New codes are
  introduced per stage, listed in `ERROR_CODES` from v0.5.0, and collected in the v1.0.0 taxonomy
  table. Error `details` are allowlisted: status codes, short identifiers, counts, and values the
  caller supplied, never response bodies or upstream free text.
- Ambiguous writes are never retried automatically, by any interface. Bounded backoff is only for
  clearly transient transport failures on reads.
- A tightened safety default is announced one minor version ahead (a CHANGELOG `Deprecated` entry
  naming the enforcing version, and a `deprecations` entry in the affected result), then enforced
  in the next minor under `Changed`. New interfaces start strict, with one exception:
  `overleaf-web-mcp/core` in v0.5.0 exposes the same service as the MCP server during the
  announce minor, and since v0.7.0 `docs/sdk.md` names the parts of it that are stable.

## Stages

| Stage | Theme | New tools | Effort | The thing it fixes |
| --- | --- | :---: | :---: | --- |
| v0.1.3 | Documentation, metadata, small additive fixes | 0 | shipped | Behaviour that had to be reverse-engineered |
| v0.2.0 | Project lifecycle | 5 | shipped | No way to create, rename, trash, or configure a project |
| v0.3.0 | Session keepalive | 0 | shipped | A saved session that dies after five idle days and presents as a dead server |
| v0.4.0 | Bulk and sync | 3, then 2 | shipped | 24 one-at-a-time calls to sync one folder |
| v0.5.0 | Shared core and safety | 0 | shipped | Operations reachable only through MCP; safety that depends on the caller picking the safe option |
| v0.6.0 | Compile and build ergonomics | 2 | shipped | Success inferred from counters; no PDF or log access. Also enforces the safety defaults v0.5.0 announced |
| v0.7.0 | CLI, SDK, and Skills | 0 | shipped | Every Overleaf operation needs an MCP client |
| v0.8.0 | Tracked-change review: accept and reject | 2 | shipped | Tracked changes can be written but not listed, accepted, or rejected |
| v0.9.0 | Multi-file documents | 1 | shipped | Section tools stop at `\input` boundaries |
| v1.0.0 | Hardening and compatibility | 0 | M | Failure modes that are not yet legible; no way to check an install before relying on it |

Effort is a relative size (S, M, L) of the work still open in a stage, not a date.

**v0.1.3 shipped on 1 September 2026**, followed the same day by **v0.1.4**, a documentation release: a human-first README, the documentation site at <https://mhmdaskari.github.io/overleaf-web-mcp/>, and usage instructions sent to MCP clients at connect time. **v0.2.0 shipped on 10 September 2026** with the five project lifecycle tools, filtered `list_projects`, and the `RATE_LIMITED` and `CONFIRMATION_MISMATCH` error codes, followed the same day by **v0.2.1**, a documentation patch. **v0.3.0 shipped on 14 September 2026** with the `keepalive` command, `sessionExpiresAt` on `auth_status`, and a cookie-jar fix that persists the session deadline, followed on 22 September by **v0.3.1** (proxy support) and **v0.3.2** (documentation). **v0.4.0 shipped on 27 September 2026** with `plan_sync`, `sync_directory`, and `delete_entities`, ignore rules, progress notifications, and the `REMOTE_DRIFT` and `PATH_OUTSIDE_ROOT` error codes. **v0.4.1 shipped on 6 October 2026**, the stage's point release, with `batch_upload` and `download_project_zip`, the move to the v2 MCP SDK, and the documentation corrections planned for v0.5.0. **v0.5.0 shipped on 10 October 2026** with the operation registry under `src/contracts/`, `createOverleafService`, the `overleaf-web-mcp/core` export, the access policy and `POLICY_DENIED`, path-safe ids, sanitized error details, and the announced plan and replacement defaults that v0.6.0 enforces, followed on 12 October by **v0.5.1**, the MCP Registry listing. **v0.6.0 shipped on 19 October 2026** with a parsed compile `summary` and `builtCleanly`, `buildRef`, `get_compile_log`, `download_compile_output`, the compile output resources, five compile error codes, and the plan and replacement defaults enforced, followed on 20 October by **v0.6.1**, a README and dependency refresh, and **v0.6.2**, fixes from a live test run. **v0.7.0 shipped on 25 October 2026** with the command line (`call`, `schema`, `capabilities`, and shorthand commands, with exit codes that say what is safe to do next), `createOverleafClient` in `overleaf-web-mcp/core`, three Agent Skills, and an `outputSchema` on every tool, followed the same day by **v0.7.1**, compile outputs on self-hosted Overleaf's per-user compiles. **v0.8.0 shipped on 31 October 2026** with `list_tracked_changes` and `manage_tracked_changes` on both document protocols, the `tracked-changes` commands, the `REVIEW_UNSUPPORTED` error code, an access check before every OT write, classified `otUpdateError`, a check that tracked writes were recorded as tracked changes, and document writes that change only the words that differ where no comment or tracked change is in the way, followed on 2 November by **v0.8.1**, a fix to the check after a tracked write on legacy documents whose tracked deletions share a point. **v0.9.0 shipped on 7 November 2026** with `get_full_document`, which flattens `\input`, `\include`, `\subfile`, and `\import` with a source map back to each file and its revision, `followIncludes` on the three section tools with writes routed to the one file that holds a section, and the `INCLUDE_CYCLE` and `INCLUDE_DEPTH_EXCEEDED` error codes. See the [changelog](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/CHANGELOG.md) for what landed.

**The MCP SDK (v0.4.1):** the server moved from `@modelcontextprotocol/sdk` 1.29 to `@modelcontextprotocol/server` 2.3, the v2 SDK, and `serve` answers both protocol eras over stdio. Protocol 2026-07-28 removes the `initialize` handshake (each request carries its protocol version and client capabilities in `_meta`) and adds `server/discover`, which servers must implement and clients may call, and whose result carries the server instructions; clients on the 2025-era versions still receive them in the `initialize` result. A 2026-07-28 client that never calls `server/discover` never sees the instructions, so tool descriptions must stay self-sufficient. The existing tools' names, inputs, and result shapes did not change.

The server registers 34 tools, the number planned for v1.0.0: the two the v0.4.1 point release added, `batch_upload` and `download_project_zip`, the two v0.6.0 added, `download_compile_output` and `get_compile_log`, the two v0.8.0 added, `list_tracked_changes` and `manage_tracked_changes`, and the one v0.9.0 added, `get_full_document`. v1.0.0 adds none. Every tool description costs the MCP client context on every turn, so the lifecycle and tracked-change review stages deliberately reuse the `manage_entity` action-enum pattern instead of adding one tool per verb, and checks that need no agent (`doctor`, `capabilities`) are CLI commands, not tools.

## What already works well (keep these patterns)

- **`manage_entity`'s `confirmPath === path` requirement on delete.** It caught nothing dangerous in the session, but it is the right shape for a destructive action, and later stages reuse it (`confirmName` on project trash/delete, a delete-count confirmation on mirror sync).
- **`upload_file` overwrites by path.** This is what made replacing `main.tex` wholesale possible without a `read_file` → revision → `write_file` round trip, and a text document replaced this way keeps its `entity_id`. A replaced binary may not: Overleaf's source (`ProjectEntityMongoUpdateHandler.replaceFileWithNew`) gives it a new id, as it does a document replaced by a binary or the reverse, so callers look ids up again after a replacement (read in the source while building 0.4.1, not yet confirmed live). Since v0.6.0 (announced in v0.5.0) a replacement must be asked for (`overwrite`, or `uncheckedDocumentReplace` for a document).
- **`get_sections` is honest about its own limits.** Its description states outright that it never follows `\input`/`\include`. Keep this practice when multi-file support lands in v0.9.0.
- **`write_file` requiring a `revision` from a prior `read_file`** is the right default against blind clobbers of text a human might be editing concurrently.
- **the error model already exists.** `McpError` carries a typed `code`, a `retryable` flag, and structured `details`. v1.0.0 should extend this, not replace it. The CLI and SDK (v0.7.0) report failures with the same class and codes.
- **writes are never retried automatically.** The README documents that a timed-out write is observed, never re-submitted. Every bulk tool below must inherit that invariant, and the CLI and SDK add no retry of their own.
- **all project mutations run through one per-project FIFO.** Bulk tools are compositions over that queue; they reduce tool calls and context, not wall-clock time. Say so in their descriptions. The queue is per process: two CLI processes working on one project are not serialized against each other, and revision checks and plan tokens are what protect them.
- **the adapter sits on one runtime interface.** `src/mcp/tools.ts` reached Overleaf only through the `OverleafToolRuntime` interface it declared; outcome classification lives below it, and the adapter has no retry. v0.5.0 moved that interface out of the MCP folder, as `OverleafServiceRuntime` in `src/contracts/service.ts`, and the argument shaping into `createOverleafService`, rather than adding a layer.
- **tokens are self-contained.** Revision tokens (`createRevision` in `src/core/revision.ts`) and plan tokens carry everything a later call needs, so read-then-write and plan-then-apply work across processes with no daemon or state file; v0.6.0's `buildRef` follows suit.

## Interfaces beyond MCP

**Decision: keep MCP, with one engine behind several interfaces.** What this project offers is Overleaf operations that stay correct under concurrent editing: revision-checked writes verified against a fresh join, tracked writes that never fall back, timed-out writes observed and never replayed, and syncs that stop when either side drifted from the plan. None of that depends on MCP; access did. Until v0.5.0, `parseCliCommand` (`src/cli-command.ts`) accepted only `serve`, `login`, `keepalive`, and `help`, and the package's one entry loaded the MCP SDK and exposed the engine only as the undocumented `OverleafRuntime`, whose domain classes skip the tool handlers' argument shaping: a CI step or a shell-driven coding agent needed an MCP client to reach anything, and a TypeScript program had no supported API. v0.5.0 added `overleaf-web-mcp/core`, and v0.7.0 the command line and `createOverleafClient`. MCP itself is still developing (protocol 2026-07-28 changed how clients connect), so the plan adds interfaces rather than swapping one.

**Two boundaries.** The caller-facing one (MCP, the CLI, the library, Skills, perhaps HTTP) decides how an operation is invoked, confirmed, and rendered, and is replaceable. The Overleaf-facing one, private REST routes and Socket.IO 0.9 OT through a saved web session (the [private API catalogue](https://mhmdaskari.github.io/overleaf-web-mcp/private-api/)), carries the maintenance risk, which only boundary validation, sanitized fixtures, `doctor` (v1.0.0), and a future official-API backend reduce.

**Architecture.** Each layer calls only the one below it.

- **Adapters.** `src/mcp/`; `src/cli/` (v0.7.0); `src/sdk.ts`, published as `overleaf-web-mcp/core` from v0.5.0 with a client facade from v0.7.0; Skills (v0.7.0), which call only the public CLI; HTTP only if a trigger below fires.
- **Contracts and service (v0.5.0).** `src/contracts/` holds operation schemas, effects, error codes, and capability types. `src/service/` holds one function per operation with its argument shaping, and checks the project the call names against the access policy in `src/core/policy.ts` before any work starts; the domain engine checks each effect before the request that has it.
- **Domain engine.** `src/overleaf/`, `src/protocol/`, `src/http/`, `src/auth/`. The domain APIs check every effect they perform against the same policy, so a direct call through the exported runtime is covered. Plan and apply stay in `SyncApi` (`src/overleaf/sync.ts`), with the per-project queue and every verification rule.
- **Backends.** One today, the web session. An official-API or Git backend would advertise its own capabilities (v1.0.0) and never be substituted silently; a Git backend cannot make tracked changes or revision-checked live edits, and Overleaf's Git integration is paid.

**Rules the shared layer keeps for every interface.**

- Operation ids are the tool names; schemas are versioned with the package.
- Effects come from one enum: `overleaf-read`, `overleaf-write`, `overleaf-delete`, `project-lifecycle`, `compile`, `local-read`, `local-write`, `unchecked-replace`. Comment writes and, from v0.8.0, tracked-change decisions are `overleaf-write`.
- Outcomes use the existing `details.outcome` values `not_applied` and `unknown`; a write that applied resolves, with `recoveredAfterTimeout` when observed after a timeout. New failure kinds go in `details.kind`.
- Progress, cancellation, and diagnostics go through a neutral `OperationContext { onProgress?, signal?, onDiagnostic? }`; cancelling never aborts a submitted write.
- Large outputs (logs, PDFs, zips) go to caller-named local paths under the local-write policy; a remote service would return scoped artifact references.
- One policy path for every public mutation, exported runtime methods included.
- No promise of cross-process serialization; revision checks and plan tokens protect separate processes.
- No code-execution surface: nothing runs caller-supplied code with access to the saved session.

**Packaging.** One package. `overleaf-web-mcp/core` is a subpath export from v0.5.0; the root stays the MCP entry with every current export, so no `./mcp` subpath is needed. Split packages only on demand. The binary stays `overleaf-web-mcp`; a neutral alias is a later, separate decision, and no name for it has been checked.

**What would change the plan.** Conditions, not stages.

| If | Then | Not before |
| --- | --- | --- |
| MCP stays in wide use by the clients served | Keep the adapter first-class; follow protocol revisions and the v1.0.0 compatibility matrix | now |
| Coding agents favour shell commands and Skills | Make the CLI their first install path; keep MCP | v0.7.0 |
| Applications call the library directly | Freeze its contract under SemVer; consider a separate `core` package | v0.7.0 |
| A remote integration needs HTTP | A scoped HTTP service with an OpenAPI description generated from `src/contracts/`, its own authentication, artifact references, and the session never exposed | a named consumer |
| Browser-native tool interfaces (WebMCP) become practical on Overleaf's pages | An adapter experiment outside the stages | its status re-checked |
| Another tool protocol gains adoption | A thin adapter over `src/service/` | a named client |
| Overleaf changes a private endpoint | Repair the web-session backend, its validation, and fixtures | any time |
| An official Overleaf API covers these operations | A new backend; the web session stays until it covers revision checks and tracked edits | it exists |
| Someone needs Git-based sync | An optional backend with its own capabilities, chosen explicitly | a recorded need |
| The product becomes an agent other agents delegate to | Consider an agent-to-agent (A2A) interface | not planned |

**How the change is judged.** v0.7.0 added an opt-in comparison on disposable projects that runs four tasks through MCP, the CLI, and the library, and records per task:

- **revise one section:** success, bytes an agent reads, round trips, conflict outcome;
- **sync figures and sources:** skips, upstream requests and bytes, drift, partial failure;
- **diagnose a failed build:** errors located by file and line, output size, artifacts, unneeded recompiles;
- **resolve a review task:** anchoring, action scope, accidental mutations (expected zero); tracked changes join in v0.8.0.

Start-up and Overleaf time are reported separately, cold and warm, never asserted; when an agent runs the tasks, model latency is reported apart from both. Through every interface, tests keep proving that a stale revision fails without overwriting, a timed-out write is never replayed, a tracked write never falls back, a required plan is enforced in the service, preflight drift changes nothing, a mid-sync failure reports what completed, a failed upload prevents every delete, one policy refuses the same call everywhere, local-root checks cover every file operation, and logs never contain cookies, document content, review message bodies, or raw upstream responses.

---

## Stage 0 — Verify the baseline (do this first, every time)

The code moves on between releases. Confirm the following before touching anything, and record
what you find:

- [ ] `npm view overleaf-web-mcp version` and `git tag` agree with `package.json` and
      `SERVER_VERSION` in `src/version.ts`. Current release: `0.9.0`.
- [ ] `TOOL_NAMES` in `src/mcp/tools.ts` lists the 34 registered tools: `auth_status`,
      `list_projects`, `create_project`, `clone_project`, `import_project_zip`, `manage_project`,
      `update_project_settings`, `get_project_tree`, `read_file`, `write_file`, `create_file`,
      `manage_entity`, `upload_file`, `batch_upload`, `download_file`, `download_project_zip`,
      `plan_sync`, `sync_directory`, `delete_entities`, `get_full_document`, `get_sections`,
      `get_section_content`, `write_section`, `compile_project`, `stop_compile`, `get_compile_log`,
      `download_compile_output`, `list_comments`, `reply_to_comment`, `add_comment`,
      `set_comment_status`, `list_tracked_changes`, `manage_tracked_changes`,
      `monitor_project_history`. The README badge and
      `docs/tools.md` must agree (`test/mcp/tools.test.ts` enforces it). Since v0.5.0, every name
      is an entry in the operation registry, `OPERATIONS` in `src/contracts/operations.ts`, and
      `tools/list` matches `test/__snapshots__/list-tools.json`. Since v0.7.0 every entry declares an
      `outputSchema`, and the golden results under `test/golden/` still validate against it.
- [ ] The MCP SDK is v2: `@modelcontextprotocol/server` 2.x in `dependencies`,
      `@modelcontextprotocol/client` 2.x in `devDependencies` (tests only),
      `npm ls @modelcontextprotocol/sdk` prints `(empty)`, and
      `npm ls zod @modelcontextprotocol/core` shows one copy of each. Record the protocol
      versions answered (when this was written, 2024-10-07 through 2025-11-25 with an
      `initialize` handshake, each covered by the protocol-era tests, and 2026-07-28 without
      one) and that `describe('protocol eras')` in
      `test/server.test.ts` still finds `SERVER_INSTRUCTIONS` in the `initialize` and
      `server/discover` results.
- [ ] `SERVER_INSTRUCTIONS` stays under the 450-word bound in `test/server.test.ts` (444 words at
      0.4.0, 445 at 0.4.1, 392 at 0.5.0, which brought it under 400 once so v0.6.0 and v0.8.0 can
      spend the headroom, 417 at 0.6.0, 440 at 0.6.2 and 0.7.0, 445 at 0.8.0); after that, a stage
      that adds guidance trims elsewhere.
- [ ] The limits and their environment variables still hold: `OVERLEAF_MAX_DOC_LENGTH` (fallback
      2,097,152 UTF-16 code units → `DOC_TOO_LARGE`) and `OVERLEAF_MAX_UPDATE_CHARS` (7,340,032
      serialized characters → `UPDATE_TOO_LARGE`).
- [ ] *(verify live)* `upload_file` to an existing path replaces it and reports `replaced: true`.
      Record the `entity_id` before and after: a replaced text document keeps it, and a replaced
      binary may get a new one, which Overleaf's source (`replaceFileWithNew`) says but no live
      run has confirmed. With track changes on for the account, record whether replacing a
      document shows up as tracked changes (`upsertDoc` → `DocumentUpdaterHandler.setDocument`
      passes the uploader's setting) while the result still says `writeMode: "untracked"`.
      Check it with `overwrite: true` (or `uncheckedDocumentReplace: true` for a document), which
      v0.6.0 requires.
- [ ] `get_project_tree` `hash` equals `git hash-object <file>` for at least one binary entity.
- [ ] The gated live tests (`RUN_OVERLEAF_LIVE_TESTS=1`, `test/live/`, with
      `RUN_OVERLEAF_LIVE_CLI_TESTS=1` and `RUN_OVERLEAF_LIVE_COMPARE_TESTS=1` since v0.7.0) and the CI workflows under
      `.github/workflows` (`ci.yml`, `publish.yml`, `docs.yml`, `download-count.yml`) are as
      described in `docs/development.md`. From v0.7.0, every command `renderHelp` prints appears
      in `docs/cli.md`.

---

## v0.1.3 — Documentation, metadata, and small additive fixes (shipped)

**Motivation:** a meaningful fraction of the session went into reverse-engineering behaviour that should have been documented, most expensively the hash format (nine false "differs" out of nine real matches from comparing against plain `sha1sum`). Two of the items below are one-line code changes with outsized payoff; ship them even if the documentation pass takes longer.

1. **Document the hash field format precisely.** Comparing `get_project_tree`'s `hash` against plain `sha1sum` produced 9 false "differs" out of 9 real matches. The actual format is a **git blob hash**: `sha1("blob " + byteLength + "\0" + content)`, i.e. exactly `git hash-object <file>`. This is confirmed in Overleaf's `FileHashManager.mjs`. State the formula wherever a `hash` field appears.

   `hash` exists **only on binary `file` entities** (Overleaf's `fileRefs`). `src/overleaf/tree.ts` copies it for `fileRefs` and for nothing else, and Overleaf does not store a content hash for `doc` entities in the tree at all. So the hash workflow covers figures, PDFs, and other binaries; `.tex`, `.bib`, and `.bst` documents can only be compared by reading their content. Document this alongside the formula, because it changes the design of `plan_sync` in v0.4.0.

2. **Document `upload_file`'s overwrite semantics, and fix its annotation.** The current description ("Upload a local binary file into an Overleaf project folder") undersells what it does. Overleaf's upload handler (`FileSystemImportManager.addEntity` → `upsertDoc` / `upsertFile`) replaces an existing entity at the same path in place; otherwise it creates one. Document:

   - **Type is decided by Overleaf, not by the caller.** `FileTypeManager` classifies by extension list and valid UTF-8; text files larger than three times the document limit are stored as binary `file` entities. a same-named entity of the *other* type (uploading text where a binary already exists, or vice versa) is expected to fail with Overleaf's `duplicate_file_name` error rather than replace; map that to `INVALID_ARGUMENT` with a clear message.
   - **Doc replacement is blind and untracked.** Upserting a `doc` goes through the document updater with no revision check and never as tracked changes. A collaborator's concurrent edit is overwritten. This is the trade-off against `write_file`.
   - the tool is registered with `destructiveHint: false`, which is wrong for an in-place overwrite. Set `destructiveHint: true`.
   - the remote name is always `basename(localPath)`; there is no way to upload `fig_v3.png` as `figures/fig.png`. Add an optional `destinationName`.
   - normalise the response. Today it passes Overleaf's raw `{ success, entity_id, entity_type }` through under `upload`. Return `{ entityId, entityType, path, replaced, hash }`, where `replaced` comes from a tree lookup before the upload and `hash` is the git blob hash computed locally from the bytes sent, so callers can verify against `get_project_tree` later without a round trip.

   *Corrected in 0.4.1, after a closer read of Overleaf's source:* a replacement is in place only for a text document replacing a text document; a replaced binary, or a change of type, may get a new entity and id (seen in the source, not yet live). Uploading over the other type replaces it; `duplicate_file_name` comes from a folder of the same name. And replacing a document is recorded as tracked changes when track changes is on for the uploading user, so "never tracked" holds only when it is off.

3. **Document that `upload_file` works for text documents, not just binaries.** `main.tex`, `ref.bib`, and `elsarticle-num.bst` (all `doc` entities) were replaced successfully via `localPath`. Fold this into item 2's "type is decided by Overleaf" paragraph and keep the concrete example.

4. **State a practical size guideline for `write_file`'s `content` vs `upload_file`'s `localPath`.** The session self-imposed "115 KB is too large for a tool parameter" with no number to go on.

   the server-side limits are already in the code and are far away: `DOC_TOO_LARGE` at the advertised `ol-maxDocLength` (fallback 2,097,152 UTF-16 code units) and `UPDATE_TOO_LARGE` at 7,340,032 serialised characters. A 115 KB file is roughly 5% of the document limit. The real ceiling is the MCP client's tool-argument budget and the token cost of echoing a whole file through the model. Document that plainly.

   accept `localPath` as an alternative to `content` on `write_file` (mutually exclusive, same revision check, same `writeMode`). That gives the one combination neither tool offers today: a revision-checked, optionally tracked, whole-file replacement from disk. It is a parameter addition, not a new tool, so it fits this stage.

5. **Add a decision table to the README.** Three rows instead of two once item 4 lands:

   | Need | Tool | Revision check | Tracked changes | Content source |
   | --- | --- | :---: | :---: | --- |
   | Small edit, or concurrent humans possible | `write_file` with `content` | yes | optional | inline |
   | Replace a large text file safely | `write_file` with `localPath` | yes | optional | disk |
   | Replace a binary, or push text when nobody else is editing | `upload_file` | no | never | disk |

6. **Include a worked example of the hash-comparison workflow** (loop local files → `git hash-object` → compare to `get_project_tree` `hash` → upload only what differs), with the caveat from item 1 that it applies to binaries only. `plan_sync` formalises this in v0.4.0; until then, document the manual version.

7. **expose the project's root document now.** The `joinProject` payload the server already receives declares `rootDoc_id` (see `JoinProjectData` in `src/protocol/project-connection.ts`); Overleaf also sends `compiler`, `imageName`, and `spellCheckLanguage` in the same payload. The server discards all of them. Surface `rootDocPath`, `compiler`, and `imageName` in `get_project_tree`'s result, and make `compile_project.rootFilePath` optional, defaulting to the project's root doc and failing with `INVALID_ARGUMENT` only when neither is set. In the session the real manuscript lived in `0_main.tex` while Overleaf's root was a 13-line stub `main.tex`; one field in the tree response would have shown that on the first call. Also reword `compile_project`'s description, which currently leaks the internal parameter name `rootDoc_id`.

8. **`download_file` overwrites the local path silently** (`writeFile(localPath, bytes)`). Either document it or add `overwrite` defaulting to `false`.

9. **repository hygiene.** `publish.yml` runs check/lint/test only when a release is published; nothing runs on pushes or pull requests. Add a `ci.yml` that runs the same three steps plus `npm pack --dry-run`. Commit this file as `ROADMAP.md`, start a `CHANGELOG.md`, and turn each numbered item here into a GitHub issue under a milestone per stage (the repository currently has zero issues, so contributors have nothing to pick up). The "19 tools" badge and sentence in the README will drift with each stage; assert the count in `test/mcp/tools.test.ts` or generate it.

### Tasks

- [x] Hash format documented everywhere a `hash` field appears, with the `git hash-object` one-liner.
- [x] `upload_file` overwrite semantics, `destructiveHint: true`, `destinationName`, normalised result.
- [x] Size thresholds (`DOC_TOO_LARGE`, `UPDATE_TOO_LARGE`) and their env vars documented next to `write_file` / `upload_file`.
- [x] README decision table (`write_file` vs `upload_file`).
- [x] Worked example: manual hash-diff loop, labelled as the manual precursor to `plan_sync`.
- [x] `rootDocPath`, `compiler`, `imageName` in `get_project_tree`; `compile_project.rootFilePath` optional.
- [x] `download_file` `overwrite` parameter.
- [x] `ci.yml`, `CHANGELOG.md`, tool-count assertion.
- [x] MCP tool annotations on all existing tools.
- [x] **Ecosystem section.** Correct the README's positioning: `@netique/overleaf-mcp` is also a web-session/OT client with tracked changes; git-bridge MCP servers require a paid Overleaf plan and bypass tracked changes entirely. *(Carried into v0.2.0 and shipped there.)*

### Acceptance

- A reader using only the README predicts a file's tree `hash` with `git hash-object` and gets a byte-identical match.
- The README states, without reading tool descriptions, which tool overwrites with and without a revision check.
- The README names the exact thresholds for `DOC_TOO_LARGE` and `UPDATE_TOO_LARGE`.
- `tools/list` shows annotations on every tool.
- `get_project_tree` shows which file Overleaf compiles by default; pull requests run the test suite.

---

## v0.2.0 — Project lifecycle (shipped)

**Motivation:** the hard blocker of the session. Every one of the 19 tools then registered took an existing `projectId`; there was no way to create a project through the MCP at all. A human had to create a blank project in the web UI and paste back its URL before anything else could happen. There was also no rename, no trash, no search over 127 projects, and no way to persist the root document (the real manuscript lived in `0_main.tex` while Overleaf's root was the 13-line stub `main.tex`).

**the endpoints exist and are confirmed in Overleaf's router.** All are ordinary browser-facing routes protected by the same session cookie and CSRF token the server already uses. They are catalogued, with every other route the server uses, in [`docs/private-api.md`](https://mhmdaskari.github.io/overleaf-web-mcp/private-api/).

| Operation | Route | Body / result |
| --- | --- | --- |
| Create | `POST /project/new` | `{ projectName, template }`; `template: "example"` seeds the example project, anything else creates the basic project with Overleaf's stub `main.tex`. Returns `{ project_id }`. |
| Clone | `POST /Project/:id/clone` | `{ projectName }` → `{ project_id }` |
| Import zip | `POST /project/new/upload` | multipart `qqfile` + `name` → `{ project_id }`; rate-limited server-side |
| Rename | `POST /project/:id/rename` | `{ newProjectName }` |
| Settings | `POST /project/:id/settings` | any of `rootDocId`, `compiler`, `imageName`, `spellCheckLanguage` |
| Trash / restore | `POST` / `DELETE /project/:id/trash` | recoverable, matches the web UI |
| Archive / unarchive | `POST` / `DELETE /Project/:id/archive` | |
| Permanent delete | `DELETE /Project/:id` | the web UI only offers this from the Trashed view |
| List | `POST /api/project` | `{ totalSize, projects: [{ name, lastUpdated, archived, trashed, accessLevel, owner_ref, … }] }`; this is what the current project dashboard calls, `GET /user/projects` (used before) is the legacy list |

### Tools

```ts
create_project({ name: string, template?: "blank" | "example" })
  → { projectId, name, url, rootDocPath? }
  // "blank" still contains Overleaf's stub main.tex as the root. Callers who import their own
  // root should follow up with update_project_settings or delete the stub with manage_entity.
  // annotations: destructiveHint false, idempotentHint false

clone_project({ sourceProjectId: string, name: string })
  → { projectId, name, url }
  // Starting from a lab or journal template project is the most common way real projects begin.

import_project_zip({ localZipPath: string, name?: string })
  → { projectId, name, url }
  // One call from "folder on disk" to "project on Overleaf"; v0.4.0's sync covers later updates.
  // Overleaf rate-limits this endpoint: HTTP 429 surfaces as RATE_LIMITED with retryAfterMs.

manage_project({ projectId: string,
                 action: "rename" | "trash" | "restore" | "archive" | "unarchive" | "delete",
                 newName?: string, confirmName?: string })
  → { action, projectId, name }
  // trash, archive, and delete require confirmName to equal the current project name exactly,
  // else CONFIRMATION_MISMATCH and nothing changes. delete is permanent and succeeds only when
  // the project is already trashed; trash is the normal path and is reversible in the UI.
  // annotations: destructiveHint true. Use elicitation when the client advertises it (v1.0.0).

update_project_settings({ projectId: string, rootFilePath?: string,
                          compiler?: "pdflatex" | "latex" | "xelatex" | "lualatex",
                          imageName?: string, spellCheckLanguage?: string })
  → { projectId, rootDocPath?, compiler?, imageName?, spellCheckLanguage? }
  // Persists in the project's own settings, so the web UI's Recompile uses it too.
  // rootFilePath must resolve to a doc entity, else NOT_FOUND / INVALID_ARGUMENT.
  // annotations: idempotentHint true
```

**Design decisions, and why the first draft changed:**

- **`manage_project` instead of `rename_project` + `delete_project`.** Mirrors `manage_entity`'s action enum so six verbs cost one tool description. The first draft proposed `delete_project({ mode: "trash" | "delete" })` as the destructive primitive. Overleaf's own model is trash first, permanent delete only from the trash. Follow it: `delete` succeeds only when the project is already trashed, and the description points callers at `trash` as the normal path. Trash is recoverable, which matters when the caller is an agent, and it is what makes v1.0.0's automated smoke test safe to run.
- **`update_project_settings` instead of `set_root_document`.** `rootFilePath` is resolved through the tree and must be a `doc`; the change persists in the project's own settings. `compiler` and the TeX Live `imageName` are exactly the two settings an agent needs when a compile fails on a font or engine mismatch; they ride on the same endpoint for free.
- **filter `list_projects` instead of adding `search_projects`.** Switch to `POST /api/project`, add `query` (case-insensitive substring on name), `includeArchived` and `includeTrashed` (default `false`), `limit` (default 50, max 200) and `sort: "lastUpdated" | "name"` (default `lastUpdated`, newest first), and return `{ projects, totalMatched, totalProjects }` with `lastUpdated`, `archived`, and `trashed` per project. Fewer tools, and it matches what `@netique/overleaf-mcp` and `overleaf-sync` already do (`olcli` lists without search). `auth_status` counts projects through the same endpoint's `totalSize`.
- **`CONFIRMATION_MISMATCH`** is a new error code for every confirm-by-value failure, including `manage_entity`'s `confirmPath`, which previously returned `INVALID_ARGUMENT`. The first draft's `ENTITY_NOT_FOUND` and `NOT_A_DOC` are covered by the existing `NOT_FOUND` and `INVALID_ARGUMENT` that `resolveProjectPath` already throws; no duplicate codes.
- **`RATE_LIMITED`** was pulled forward from v1.0.0 because zip import and project creation are the first endpoints Overleaf throttles in practice.

### Tasks

- [x] Wrap the private endpoints for create / clone / import / rename / trash / restore / archive / unarchive / delete / settings. Record each endpoint and payload shape in `docs/private-api.md` so v1.0.0's `API_SHAPE_CHANGED` has something to check against.
- [x] Implement the five tools with annotations and `outputSchema` + `structuredContent`.
- [x] `query` / `includeArchived` / `includeTrashed` / `limit` / `sort` on `list_projects`; `outputSchema` on its new result shape.
- [x] `CONFIRMATION_MISMATCH` and `RATE_LIMITED` (`details.retryAfterMs` from `Retry-After`).
- [x] `spellCheckLanguage` surfaced alongside `compiler` and `imageName` in `get_project_tree`.
- [x] Extend the gated live test: create → set root → compile → trash (never permanent delete in the automated path).
- [x] Documentation: "from nothing to a compiled PDF" walkthrough using only MCP tools; README ecosystem correction carried from v0.1.3.

### Acceptance

- From an account with zero projects, an agent reaches a compiled project using only MCP tools, with **no web-UI step**, and never has to guess which file is the root.
- After `update_project_settings({ rootFilePath })`, reopening the project in the web UI shows the chosen file as root and "Recompile" builds it.
- `list_projects({ query: "Thesis" })` returns only matching projects; the default call returns at most 50 and hides archived and trashed projects.
- `manage_project` with a wrong `confirmName` returns `CONFIRMATION_MISMATCH` and changes nothing; `delete` on a project that is not trashed returns `INVALID_ARGUMENT` and changes nothing.

---

## v0.3.0 — Session keepalive (shipped)

**Motivation:** on 10 September 2026 the server failed to start in Claude Code with nothing more than "Connection closed". The saved session had expired: `serve` bootstraps `GET /project` before it answers `initialize`, so an expired session exits with `AUTH_EXPIRED` on stderr and the client reports a dead process, not an error a person can read. Checked the same day against `www.overleaf.com`: `overleaf_session2` is issued with `Max-Age=432000`, five days (Overleaf's default `cookieSessionLength`, which is also how long the server keeps the session), and **every response re-issues the cookie with a fresh five-day expiry** (express-session's `rolling` option). The HTTP client already merges refreshed `Set-Cookie` headers into the jar through `CookieStore.mergeSetCookies`, so a session used at least once every five days never expires, and one left alone for five days is gone. Nothing client-side can lengthen that: editing the expiry in `cookies.txt` only keeps sending a cookie the server has already forgotten. The problem is the gap between two uses, and a scheduled request closes it.

```bash
overleaf-web-mcp keepalive
# stdout, exit 0:  { "refreshed": true, "baseUrl": "...", "sessionExpiresAt": "<ISO 8601>", "userId"?: "..." }
# stderr, exit 1:  the normalized McpError JSON (AUTH_EXPIRED when the session is already dead)
```

**Design decisions:**

- **A CLI subcommand, not an MCP tool.** A tool runs only while a client has the server open, which is exactly when the session is already being refreshed. `keepalive` runs the existing startup bootstrap (`OverleafRuntime.create`: `GET /project`, CSRF check, cookie merge), reports, and exits. It reuses the `main().catch` error path in `src/cli.ts`, so `AUTH_EXPIRED` lands on stderr as JSON and the exit code is non-zero for a scheduler to alert on. On that path Overleaf's redirect hands out an anonymous session that replaces the dead cookie in the jar; that is harmless, the old one was already rejected, but it must never be reported as `refreshed: true`.
- **`sessionExpiresAt` is read from the jar after the merge, never from a cookie value.** Report the earliest finite expiry among the cookies the jar would send with `GET /project`; the session cookie is `overleaf_session2` on `www.overleaf.com` and `overleaf.sid` on Community Edition, so do not hardcode a name. Add the same field to `auth_status` so an agent can tell the user how long the session has left. That is a result-shape change: `outputSchema` per the Conventions, and a CHANGELOG entry.
- **Scheduling belongs to the operating system.** Document a daily `launchd` agent (macOS), `cron` entry (Linux), and Task Scheduler task (Windows) in `docs/configuration.md`. The examples must use the absolute path to a Node 20+ binary: schedulers do not source login shells, and the maintainer's own machine has a v16 default `node`. Any interval under five days works; daily leaves four days of slack for a laptop that was asleep. A keepalive cannot resurrect a session that has already lapsed, so the documentation says plainly that a machine that is off for more than five days still needs `login`.
- **Concurrency with a running server is already safe.** `mergeSetCookies` reloads the jar under the advisory lock before writing, so a keepalive that fires while a client has the server open cannot clobber a refresh in either direction. Say so in the docs rather than adding a mutex.
- **Fix the Netscape serializer while here.** `cookieToNetscape` in `src/http/cookies.ts` derives the include-subdomains column from a leading dot that tough-cookie has already stripped, so it always writes `FALSE`. `parseNetscapeCookies` ignores that column and tough-cookie treats any cookie with a `domain` as a domain cookie, which is why the server itself works, but curl and every other Netscape reader treat the cookie as host-only and will not send it to `www.overleaf.com`. Derive the column from `cookie.hostOnly` instead. Implementation found a second defect in the same function: the expires column came from `cookie.expires`, which tough-cookie leaves as `Infinity` for a `Max-Age` cookie, so the session cookie was written with expiry `0` and its five-day deadline was discarded on every save; the column now comes from `expiryTime()`, which folds in `Max-Age`, and `sessionExpiresAt` reads the same method. The parser deliberately keeps ignoring the include-subdomains column: every jar written before 0.3.0 recorded `FALSE` for the session cookie, and honouring it would load that cookie as host-only and stop sending it to `www.overleaf.com`, breaking existing installs. Those jars load exactly as before and are rewritten correctly on the first refreshed response.

This stage was split out of the bulk-sync work, now v0.4.0, so the fix could ship first: it is CLI-only with no tool surface, and it removes the one failure that presents as a dead server instead of a typed error.

### Tasks

- [x] `keepalive` in `src/cli-command.ts` and `src/cli.ts`: bootstrap through `OverleafRuntime.create`, print `{ refreshed, baseUrl, sessionExpiresAt, userId? }`, exit 1 with the normalized error on `AUTH_EXPIRED`; `renderHelp` lists it.
- [x] `sessionExpiresAt` on `auth_status`, with `outputSchema`, from the earliest finite expiry among the cookies sent with `GET /project`.
- [x] `cookieToNetscape` include-subdomains column from `hostOnly`; round-trip test in `test/http/cookies.test.ts`: a `Set-Cookie` with `Domain=.overleaf.test` serializes with `TRUE` and loads back as a cookie that `getCookieString` sends to `www.overleaf.test`.
- [x] Command tests with a fake fetcher: a 200 carrying a rolled `Set-Cookie` prints `sessionExpiresAt` equal to the new expiry and the jar on disk carries it; a redirect to `/login` exits 1 with `AUTH_EXPIRED` JSON on stderr and nothing on stdout; a 200 without the CSRF meta tag is `AUTH_EXPIRED` as well.
- [x] Documentation: a "Keeping the session alive" section in `docs/configuration.md` (the five-day rolling behaviour, scheduler examples with an absolute Node path); a `docs/install.md` troubleshooting entry that a client reporting only "Connection closed" or "server exited" at startup usually means an expired session; the README's "Sign in once" step qualified as once, plus again after any five idle days unless a keepalive is scheduled.

### Acceptance

- With a valid session and a daily keepalive scheduled, fourteen days without any MCP use end with no `login` required, and each run's `sessionExpiresAt` lies about five days after that run.
- `keepalive` against a dead session exits 1 with `AUTH_EXPIRED` on stderr and prints nothing on stdout; against a live session it exits 0 and `auth_status` reports the same `sessionExpiresAt`.
- `curl -b <jar> https://www.overleaf.com/project` returns 200 with a jar written by this release, where a jar written by 0.2.1 redirects to `/login`.

---

## v0.4.0 — Bulk and sync operations (shipped)

**Motivation:** almost everything after authentication in the session was one-file-at-a-time: 3 text overwrites, 1 binary upload, and **20 individual `manage_entity` delete calls**, each needing its own `confirmPath`. Before that, a hand-rolled diff over 9 local figures established that none of them needed re-uploading. That comparison is generically useful and should not be reinvented per caller.

**design constraints the first draft did not account for.**

- **Two comparison paths.** Binary files compare by the git blob hash already in the tree, at zero cost. Documents have no remote hash (v0.1.3 item 1), so `plan_sync` must `read_file` each remote doc and compare LF-normalised content against the local file with the same normalisation. Report `comparedBy: "hash" | "content"` per entry. Each doc comparison is one document join through the per-project FIFO; that is fine for tens of documents and should be stated in the description.
- **Documents sync through revision-checked writes, not uploads.** `sync_directory` should replace a changed `doc` with `write_file` semantics (using `localPath` from v0.1.3 item 4), passing the revision `plan_sync` observed, and upload only binaries. A collaborator's edit between plan and sync then yields a per-file `REVISION_CONFLICT` instead of a silently lost edit, and `writeMode: "tracked"` becomes available for projects in review mode. New documents go through the upload path, where Overleaf classifies them as docs by extension.
- **Ignore rules.** Ship a default ignore list (`.git/`, `.DS_Store`, `__MACOSX/`, hidden files, `*.aux`, `*.log`, `*.bbl`, `*.blg`, `*.out`, `*.toc`, `*.synctex.gz`, `*.fdb_latexmk`, `*.fls`) plus an `ignore: string[]` of gitignore-style globs, merged with any `.olignore` in the folder for `overleaf-sync` users. Overleaf enforces a 150-character name limit and its own reserved names (`FileTypeManager.shouldIgnore`); map its `invalid_filename` to `INVALID_ARGUMENT`.
- **Folder deletes are recursive.** `DELETE /project/:id/folder/:id` removes a subtree in one request. Mirror mode should collapse `remoteOnly` entries to their highest remote-only ancestor, present that collapsed list, and count `confirmDeleteCount` against it. State which count the caller is confirming.
- **Partial failure is the normal case.** Return per-file outcomes `{ path, action: "uploaded" | "written" | "created" | "deleted" | "skipped" | "failed", entityId?, error? }` and continue past individual failures unless `stopOnError` is set. The existing `PARTIAL_CLEANUP` code shows the pattern.
- **Bound the response.** `identical` on a real project can be hundreds of paths. Return counts plus the first N, with `verbose` to get everything.

**Design decisions made while building the first release, and why the draft above changed:**

- **The plan token is stateless and covers both sides.** It is a small base64url object with three truncated SHA-256 digests: of the arguments that decide the scope (project, resolved folder, destination, ignore list), of every project entity in scope (path, type, id, and binary hash or document version and content hash), and of every included local file's blob hash and folder. Nothing is stored between calls, so a token survives a server restart, and it stays short enough to pass through a model's context. It covers *identical* entries too: a collaborator's edit to a file the plan called identical would otherwise be overwritten by the sync without anyone having seen it. A local change that alters the plan is also `REMOTE_DRIFT`, with `details.changed: "local"`, rather than a separate code: in both cases the plan the user approved is stale.
- **The token a sync returns describes what that sync left**: what it changed as the tree shows it afterwards, everything else as planned. That makes a partial run resumable while a change someone made during the pause still stops it. The first draft's alternative, re-planning from scratch, would silently absorb that change into the new token.
- **No `onConflict`.** With a token, any moved revision is already `REMOTE_DRIFT`; during the sync, a moved revision fails that file with `REVISION_CONFLICT`. An `overwrite` option could only mean discarding a collaborator's edit, which the acceptance criteria rule out.
- **`destinationFolderPath`** (default `""`, the project root) was added, so `./figures` can be synced against the project's `figures/` without mirroring the whole project.
- **A `conflicts` list.** A local file where the project has a folder, a local folder where it has a file, and non-UTF-8 text where it has a document cannot be applied without a person deciding. `plan_sync` lists them; `sync_directory` reports them as failures, so they also block deletes.
- **Ignore rules protect the project side.** A remote entity an ignore rule matches is never compared or deleted, the way rsync treats excluded files, so mirror mode cannot remove the `.latexmkrc` it was told to ignore. A remote-only folder that holds such an entity is not collapsed; its other contents are listed individually. Patterns are applied in the order defaults, `.olignore`, `ignore`, so `!pattern` re-includes, using the `ignore` package, and match case-insensitively.
- **Tracked mode covers new text files.** A new file created by upload is never tracked content, so with `writeMode: "tracked"` new files Overleaf treats as text are created the way `create_file` does, as an empty document followed by a tracked write; binaries are uploaded as usual. (An upload that *replaces* a document can be tracked, when track changes is on for the account, as 0.4.1 found in Overleaf's source; `sync_directory` never replaces a document by upload, so this does not change it.)
- **Uploads are confirmed before deletes.** After the upload phase the tree is read back; an upload that is missing or whose hash differs from the local file counts as a failure, which withholds every delete. Each delete re-checks the entity's id, and for a folder its contents, against the plan first.
- **Empty folders.** A remote folder with no local counterpart is deleted whole, which is how required semantic 4's "remove folders left empty" is met. A remote folder whose local counterpart exists is kept even when the sync empties it, because mirror mode reproduces the local side, and only folders needed to hold uploaded files are created, so an empty local folder is not reproduced.
- **`mode` is required.** There is no default that could delete.
- **Walk limits.** More than 2,000 included files (Overleaf's own per-project limit) or 20,000 scanned entries fail fast with `INVALID_ARGUMENT`, so a mistaken `localFolderPath` does not hash a home folder.
- **Only `identical` and `ignored` are bounded** (25 unless `verbose`). `toUpload`, `remoteOnly`, and `conflicts` are what the user is approving, so they are always complete.

**Design decisions made while building the point release (0.4.1):**

- **`batch_upload` keeps `onConflict`, defaulting to `"overwrite"`.** Unlike `sync_directory` it has no plan and no revision to protect, so its default matches `upload_file`, which a batch replaces call for call; `"skip"` is the conservative choice. Replacing a document this way is a blind write with no revision check, recorded as tracked changes only when track changes is already on for the account, and the description says to prefer `write_file` or `sync_directory` for documents a collaborator may edit. The default joins the v0.5.0 transition with `upload_file`'s.
- **`destinationPath` is a full path, file name included**, so one call can send `fig_v3.png` to `figures/fig.png` and files to several folders.
- **Everything that can be checked locally is checked first.** Invalid, duplicate, or nested destinations and missing or non-file local paths fail the whole call before any request. Problems only the project tree shows (a folder at the destination, or a file where a parent folder should be) fail that one file, in both modes, because a fresh tree is read once and a batch should not stop for one bad path.
- **A `skipped` list.** In skip mode an existing document or file is reported under `skipped`, which does not make the call `partial`, and the check is repeated inside the upload's queue job right before the request (an `ifExists` option on `EntitiesApi.uploadFile`, defaulting to `replace`, so `upload_file` is unchanged). A path a collaborator filled in between is skipped, not replaced.
- **Folder creation is shared with `sync_directory`.** Missing folders are created parents first, each once; a folder that failed is not tried again, and every file under it fails with the folder's code and a message naming it.
- **A `verified` flag.** After any attempt the tree is read back once, as sync's verification does: an upload that is missing, or a binary whose hash differs from the local file's (computed before the upload), moves to `failed` with `REMOTE_ERROR`. If the read-back itself fails, `verified` is `false` and the entries stand as reported.
- **Timed-out uploads are classified, never resent.** A binary now in the tree with the local hash becomes `completed` with `recoveredAfterTimeout: true`, whether this upload put the bytes there or they were already identical, since the requested outcome holds either way; a path absent before and after, or the same entity with the same hash as before, stays `TIMEOUT`, with a message that it had not landed when read back but could still land late; anything else, a document included since documents carry no hash, is `OUTCOME_UNKNOWN`, with a message to check `get_project_tree` before uploading again.
- **`download_project_zip` uses `CONFIRMATION_MISMATCH`** for an existing `localPath` without `overwrite: true`, checked before any request, as new tools should; `download_file`'s `INVALID_ARGUMENT` stays the one recorded exception. A missing parent folder is `NOT_FOUND`, a folder at `localPath` `INVALID_ARGUMENT`.
- **Streaming and atomic replace.** The archive is streamed through a streaming GET on the same HTTP client path (authentication, status mapping, and the timeout all apply) to a temporary file in the target folder, created before the request so an unwritable folder fails without spending one of Overleaf's downloads, and never buffered whole. It must start with a zip signature, else `PROTOCOL_UNSUPPORTED`, with only a MIME-shaped `contentType` in `details`, and end with a zip end-of-central-directory record whose comment length accounts for the bytes after it, else `REMOTE_ERROR`, retryable, with nothing written. With `overwrite` it is renamed over the target, so a failed download never destroys the existing file; without it, it is hard-linked into place so a file that appeared meanwhile is not replaced, falling back to an exclusive copy where links are unsupported. The temporary file is removed on every failure path.
- **`timeoutMs`** (1 second to 15 minutes, default 5 minutes) bounds the whole transfer, because a large project's archive can take longer than a default request timeout. No project socket and no queue: it is one HTTP request.
- **Annotations.** `batch_upload` is `{ destructiveHint: true, idempotentHint: false }`, since it composes `upload_file` and never retries; `download_project_zip` is `{ readOnlyHint: false, destructiveHint: true, idempotentHint: false }`, because it writes locally.

**Checked against Overleaf's source before 0.4.1 shipped** (`overleaf/overleaf`, `services/web`). The read corrected earlier assumptions, and the code and documentation follow it. These are read from the source, not yet confirmed live; Stage 0 records them.

- **Replaced binaries may get a new entity id.** Only a text document replacing a text document keeps its id. A binary replacing a binary goes through `ProjectEntityMongoUpdateHandler.replaceFileWithNew`, and a document replaced by a binary or the reverse is a new entity too. `upload_file`'s description now says a replaced binary "may get a new one", and nothing promises a kept id for binaries.
- **Replacing a document by upload can be tracked.** `upsertDoc` hands the new text to `DocumentUpdaterHandler.setDocument`, which diffs it and records tracked changes when track changes is on for the uploading user. The descriptions and connect-time instructions no longer say "never tracked". New text files created by upload are still untracked content, so `sync_directory`'s tracked mode is unaffected. `upload_file`'s result still reports `writeMode: "untracked"`; changing the result shape is left to v0.5.0.
- **`duplicate_file_name` means a folder is in the way.** Overleaf replaces a document with a binary, or the reverse, without complaint; the code comes from a folder of the same name. The error message was corrected.
- **The zip route.** Its rate limiter (`zip-download`) allows 10 requests a minute per project and user and answers 429 with no `Retry-After`, so `details.retryAfterMs` is normally absent and the description says to wait a minute. The route has no login check of its own, so an expired session is a 403, `PERMISSION_DENIED`, not `AUTH_EXPIRED`; the description says so. The archive is built while it is sent, chunked with no `Content-Length`, so a transfer cut short still ends with HTTP 200: hence the end-record check. A file Overleaf fails to read is left out of an otherwise well-formed archive and only logged upstream, which the documentation states rather than hides.
- **Upload rate limits.** `file-upload` allows 500 uploads per 15 minutes per project and user, the same as `batch_upload`'s cap, and folder creation 60 a minute. Since every later upload would be refused too, `batch_upload` stops at the first `RATE_LIMITED`, even without `stopOnError`, and lists the rest in `remaining` with nothing more sent.
- **Timeout classification, simplified.** The read-back now settles a timed-out upload in one of three ways, as recorded above: the local bytes at the path (recovered), the path unchanged (`TIMEOUT`), or anything else (`OUTCOME_UNKNOWN`).

### Tools

```ts
// Shipped in 0.4.0.
plan_sync({ projectId: string, localFolderPath: string, destinationFolderPath?: string,
            ignore?: string[], verbose?: boolean })
  → {
      planToken: string,       // opaque; digests of the scope, the project side, and the local side
      localFolderPath, destinationFolderPath,
      toUpload:  [{ localPath, destinationPath, reason: "new" | "changed",
                    comparedBy?: "hash" | "content", remoteType?: "doc" | "file" }],
      identical: { count, paths },                  // first 25 unless verbose
      remoteOnly:[{ destinationPath, entityId, type: "doc" | "file" | "folder", contains? }],  // collapsed
      conflicts: [{ localPath, destinationPath, reason, message }],
      ignored:   { count, entries: [{ localPath, matchedPattern? , reason? }] }
    }
  // Side-effect free. annotations: readOnlyHint true

sync_directory({
  projectId: string,
  localFolderPath: string,
  mode: "additive" | "mirror",  // required
  destinationFolderPath?: string,
  planToken?: string,           // if given, REMOTE_DRIFT when either side no longer matches it
  confirmDeleteCount?: number,  // REQUIRED in mirror mode; must equal remoteOnly.length, else CONFIRMATION_MISMATCH
  ignore?: string[],
  writeMode?: "untracked" | "tracked",
  stopOnError?: boolean
})
  → {
      status: "complete" | "partial",
      mode,
      completed: [{ destinationPath, action, entityId? }],
      failed:    [{ destinationPath, action, errorCode, message }],
      remaining: [{ destinationPath, action }],
      identicalCount: number,
      planToken?: string        // re-run with this to resume; absent if the result could not be re-read
    }
  // action: "create_folder" | "upload" | "write" | "create" | "delete"
  // annotations: destructiveHint true, idempotentHint true

delete_entities({ projectId: string, paths: string[], confirmCount: number, stopOnError?: boolean })
  → { status, completed: [{ path, type, entityId }], failed: [{ path, errorCode, message }], remaining: [{ path }] }
  // Composes manage_entity's delete; collapses the session's 20 calls into one.
  // annotations: destructiveHint true

// Shipped in 0.4.1.
batch_upload({ projectId: string,
               files: [{ localPath: string, destinationPath: string }],  // 1..500; destinationPath includes the file name
               onConflict?: "skip" | "overwrite",   // default "overwrite", matching upload_file
               stopOnError?: boolean })
  → {
      status: "complete" | "partial",   // skipped entries do not make it partial
      onConflict,
      completed: [{ destinationPath, action: "create_folder" | "upload", entityId?,
                    entityType?: "doc" | "file", replaced?, recoveredAfterTimeout?: true }],
      skipped:   [{ destinationPath, localPath, entityType }],   // onConflict "skip" only
      failed:    [{ destinationPath, action, errorCode, message }],
      remaining: [{ destinationPath, action }],   // after stopOnError, or the first RATE_LIMITED
      verified: boolean                 // the tree was read back and every completed entry confirmed
    }
  // annotations: destructiveHint true, idempotentHint false

download_project_zip({ projectId: string, localPath: string, overwrite?: boolean,
                       timeoutMs?: number })   // 1,000..900,000, default 300,000
  → { projectId, localPath, bytes, replaced }
  // GET /Project/:id/download/zip. The reverse direction of sync; recommended as the backup
  // step before any mirror sync. annotations: readOnlyHint false, destructiveHint true,
  // idempotentHint false
```

### Required semantics (write these into the tool descriptions)

1. **Order:** all uploads and writes first, then deletes. **Never delete if any upload failed.**
2. **Partial failure:** continue past individual failures (or stop at the first with `stopOnError`), return `status: "partial"` with `completed` / `failed` / `remaining`; the call is resumable by re-running with the same `planToken`.
3. **Concurrency:** if `planToken` is supplied and any entity in `toUpload` / `remoteOnly` has a different live `hash` or revision than the snapshot → `REMOTE_DRIFT`, nothing changed. This, plus per-doc `REVISION_CONFLICT`, is the only protection for human co-editors, because `upload_file` has no revision check; say so in the docs.
4. **Folders:** auto-create missing parent folders (via `manage_entity`); in mirror mode, remove folders left empty.
5. **Paths:** `localFolderPath` is resolved on the **server's** filesystem; reject `..` segments and symlinks that escape the folder (`PATH_OUTSIDE_ROOT`).
6. **Hashing:** git blob hash over raw bytes; stream files larger than 8 MB rather than buffering.

Keep `manage_entity` and `upload_file` exactly as they are underneath; every tool here is a composition of existing primitives.

### Scope of the releases

The first release of this stage, 0.4.0, shipped `plan_sync`, `sync_directory`, and `delete_entities`: the two-call workflow the acceptance criteria name, plus the batched delete that collapses the session's 20 calls into one. `batch_upload` and `download_project_zip` followed in the 0.4.1 point release, once the planner and its ignore rules had had real-world use.

### Tasks

- [x] Streaming `gitBlobHash` helper plus unit tests against `git hash-object` fixtures (text, binary, empty file).
- [x] Ignore-pattern matcher (reuse a gitignore-compatible library; support `.olignore`).
- [x] `plan_sync`, `sync_directory`, and `delete_entities` composed from existing primitives.
- [x] `batch_upload` and `download_project_zip`, in the 0.4.1 point release.
- [x] Fault-injection tests: fail upload N of M; assert no deletes ran and `remaining` is correct; assert resume completes.
- [x] Drift test: mutate a remote doc between `plan_sync` and `sync_directory`; assert `REMOTE_DRIFT`.
- [x] Progress notifications (`notifications/progress`) per file when the client supplies a progress token.

### Acceptance

- The reference cleanup (upload 4 changed, delete 20 stale, leave 9 identical figures untouched) is **2 calls** (`plan_sync` → `sync_directory`) and the 9 identical files are never re-uploaded.
- An induced mid-sync failure never deletes and is resumable with the same `planToken`.
- A concurrent web-UI edit between plan and sync yields `REMOTE_DRIFT` (or one file's `REVISION_CONFLICT`) with zero changes applied and never lost text.
- `mirror` without a correct `confirmDeleteCount` returns `CONFIRMATION_MISMATCH`.

---

## v0.5.0 — Shared core and safety (shipped)

**Motivation:** two problems with one root. First, every operation, as a tool defines it, is reachable only through the MCP adapter: `OverleafToolRuntime` is declared in `src/mcp/tools.ts`, the argument shaping for `manage_project`, `write_file`, `manage_entity`, and `list_comments` lives in its handlers, and the exported `OverleafRuntime` reaches the domain classes but not that shaping. A CLI or library built on that would copy the shaping, and copies are where safety rules drift apart. Second, safety holds only when the caller picks the safe option, and error details carry what AGENTS.md forbids:

- `sync_directory` checks drift only when given a `planToken`; without one, mirror mode counts `confirmDeleteCount` against a delete set nobody reviewed, while the README, `docs/index.md`, and the `docs/safety.md` heading stated the guarantee unconditionally until 0.4.1.
- `upload_file` replaces whatever is at the path, documents included, with no revision check and no confirm value, and so does `batch_upload` (0.4.1) with its default `onConflict: "overwrite"`.
- Local paths are read and written wherever the process can reach, and `download_file` writes locally while annotated `readOnlyHint: true`.
- Ids reach request paths unencoded, and `new URL(path, base)` in `OverleafHttpClient.request` honours `..` and `?`, so a crafted `projectId` or `threadId` can retarget a POST that carries the CSRF token.
- `COMPILE_FAILED` carries the whole compile response in `details.result`, the protocol layer stringifies upstream socket payloads into messages, and a non-JSON 200 body is quoted in a `REMOTE_ERROR`.

This stage fixes both before any new interface exists, and adds no MCP tool.

**What changes for existing callers, and when.** These change an agent's usual call, so they follow the one-minor rule even before 1.0; this table changes the shipped behaviour the v0.4.0 section records.

| Behaviour | v0.5.0 (announce) | v0.6.0 (enforce) |
| --- | --- | --- |
| `sync_directory` without `planToken` | Runs; result has `planned: false` and a `deprecations` entry | `CONFIRMATION_MISMATCH`, `details.missing: "planToken"`; additive may pass `unplanned: true` instead |
| `upload_file` onto an existing binary, `overwrite` omitted | Replaces, with a `deprecations` entry; an explicit `overwrite: false` refuses now | `CONFIRMATION_MISMATCH`, nothing sent |
| `upload_file` onto an existing document | Replaces, with a `deprecations` entry | `INVALID_ARGUMENT` naming `write_file` with `localPath`, unless `uncheckedDocumentReplace: true` |
| `COMPILE_FAILED` `details.result` | Reduced to `{ status }`, deprecated | Removed |

There is no compatibility switch: `overleaf-web-mcp/core` follows the table, and the SDK facade arrives in v0.7.0, after enforcement, so it starts strict.

**Design decisions:**

- **Move first, with no public change.** `src/contracts/` takes the schemas verbatim from `src/mcp/tools.ts`, plus effects, each entry's annotations (checked against its effects), `ERROR_CODES`, `OperationContext`, and `OverleafService` (today's `OverleafToolRuntime`); `createOverleafService(runtime)` in `src/service/operations.ts` takes the shaping, so each MCP handler becomes one call.
- **`overleaf-web-mcp/core`** is a subpath of this package with entry `src/sdk.ts` (`src/core/` stays the internal utilities folder). It never imports `@modelcontextprotocol/*`, does not export `ProjectConnection`, and keeps `connectionFactory` a test seam.
- **Expected state by default.** Single-entity writes use a revision, an `expectedHash`, or entity ids, and a mutation with none must be asked for by name. A `planToken` records what `plan_sync` observed, not that a person reviewed it; confirm-by-value and elicitation (v1.0.0) are the approval layer.
- **`uncheckedDocumentReplace` keeps a recorded workflow.** The v0.1.3 decision table recommends `upload_file` to "push text when nobody else is editing", and the checked route through `read_file` costs the whole document in the model's context.
- **`overwrite` has no default until v0.6.0**, so an omitted value (deprecated) differs from an explicit `false` (refused). `download_file`'s `INVALID_ARGUMENT` for the same case stays, as the one recorded exception. **`expectedHash` is a preflight, not a compare-and-swap**: the upload route takes only `qqfile` and `name`, so a replacement landing between check and upload is lost, and the docs say so.
- **`upload_file`'s `writeMode: "untracked"` is inaccurate when track changes is on.** Since 0.4.1 the description says a replaced document is recorded as tracked changes when track changes is on for the account, but the result still reports `writeMode: "untracked"`. Resolve it with the `outputSchema` this stage gives `upload_file`: report what Overleaf will record (from the account's track-changes state observed on join, `"untracked"` for a binary or a new file), or drop the field. Either is a result-shape change listed in the changelog, and `batch_upload`'s entries follow the same rule if they gain the field.
- **The access policy is not a sandbox.** `src/core/policy.ts` decides allowed projects, local read and write roots, and allowed effects. With every new variable unset, only three refusals are new: local writes to the cookie jar or browser profile, a `.olignore` that resolves outside its folder, and ids that are not path-safe. It cannot close the gap between the realpath check and the open or contain a malicious local process; it stops an agent, possibly steered by text it read in a project, from reaching outside what it was given. Projects created in a process join its allowlist in memory, so a later CLI process (v0.7.0) does not see them.

```ts
sync_directory({ ...existing, unplanned?: boolean })
  → { ...existing, planned: boolean,
      deprecations?: [{ parameter: string, message: string, enforcedIn: string }] }
  // unplanned: additive only, never deletes; INVALID_ARGUMENT with a planToken or mode "mirror"

upload_file({ ...existing, overwrite?: boolean,        // no default until v0.6.0, then false
              expectedHash?: string,                   // 40 hex characters, from get_project_tree
              uncheckedDocumentReplace?: boolean })    // blind; tracked only if the account has it on; effect-gated
  → { ...existing, deprecations?: [...] }              // gains an outputSchema; still destructiveHint true

download_file  // annotations become { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
```

New error code `POLICY_DENIED`; new variables `OVERLEAF_ALLOWED_PROJECTS`, `OVERLEAF_LOCAL_READ_ROOTS`, `OVERLEAF_LOCAL_WRITE_ROOTS`, `OVERLEAF_ALLOWED_EFFECTS`.

### Tasks

- [x] **Documentation corrections** (shipped in 0.4.1). Make the sync guarantee conditional on a `planToken` in the README, `docs/index.md`, and `docs/safety.md`, and qualify the README's "each one confirms by value", false for `upload_file`, `stop_compile`, and additive `sync_directory`. `docs/safety.md` says a `planToken` is not human approval and that a per-item `failed[]` entry leaves earlier `completed[]` items applied.
- [x] **AGENTS.md.** Add the one-minor rule. Amend the confirm-by-value rule: `stop_compile` is the one destructive tool without a confirm value, a `revision` or `planToken` counts as expected-state confirmation, and `unplanned` and `uncheckedDocumentReplace` are the only named unchecked opt-ins. Rescope "stdout is reserved for MCP protocol frames" to `serve`, since `help`, `login`, and `keepalive` already print to stdout.
- [x] **Contracts and service** as designed, with the `listTools()` golden snapshot in `test/server.test.ts`; `McpErrorCode` is derived from `ERROR_CODES`; no write path receives a request's abort signal.
- [x] **Lint boundary.** `no-restricted-imports` forbidding `**/mcp/**`, `**/server.js`, and `@modelcontextprotocol/*`, type imports included, outside `src/mcp/`, `src/server.ts`, `src/cli.ts`, and `src/index.ts`; `no-console`; and no `process.stdout` or `process.stderr` outside `src/cli.ts` and `src/server.ts` (whose `runStdioServer` defaults the stdio transport to `process.stdin` and `process.stdout`). Only `src/cli.ts` writes `OperationContext.onDiagnostic` notices (`{ tool, code }`) to stderr.
- [x] **`./core` export.** `src/sdk.ts` exports `OverleafRuntime`, `readConfig`, `McpError`, `ERROR_CODES`, `createOverleafService`, and the contract types; `package.json` `exports` gains `"./core"`; a CI step after Build imports it by package self-reference.
- [x] **Announce phase.** The new fields, with upload checks inside the queue job before `postForm`. Sync's `#applyUpload` passes `overwrite: false` for new paths and `overwrite: true` with `expectedHash` for changed binaries, so a refusal becomes a per-item `REMOTE_DRIFT`, which already withholds deletes. `batch_upload`, which shipped in 0.4.1 with `onConflict` defaulting to `"overwrite"`, joins the transition through the same `uploadFile` checks, per file.
- [x] **Tests.** Every operation with a destructive effect has one of `confirmPath`, `confirmName`, `confirmCount`, `confirmDeleteCount`, `overwrite`, `onConflict` (for `batch_upload`), `revision`, or `planToken`, with an allowlist of exactly `['stop_compile']`. In `test/overleaf/sync.test.ts`, tokenless call sites plan first or pass `unplanned`, and `FakeProject` counts reads and mutations.
- [x] **Access policy.** `assertProject`, `resolveLocalRead`, `resolveLocalWrite`, and `assertEffect`, with roots resolved by `realpath` in `OverleafRuntime.create`. Reads: `resolveTextContent`, `EntitiesApi.uploadFile` and `batch_upload`'s local checks, `ProjectsApi.importProjectZip`, the `scanLocalFolder` root, and `.olignore` (refused outside the folder, since its patterns are echoed back). Writes: `EntitiesApi.downloadFile`, `ProjectsApi.downloadProjectZip` (0.4.1), and later `download_compile_output`. Refusals are `PATH_OUTSIDE_ROOT` with `details.kind`. Projects are checked in `ProjectConnectionCache.withConnection` and every HTTP-only path, and `list_projects` shows only allowed ones.
- [x] **Path-safe ids.** Reject `/`, `\`, `.`, `?`, `#`, and `%` in `projectId`, `sourceProjectId`, and `threadId` (check Community Edition id formats before narrowing to 24 hex); `encodeURIComponent` at every interpolation in `src/overleaf/`; `OverleafHttpClient.request` asserts the resolved origin equals `baseUrl`'s, and mutating requests use `redirect: "manual"` if a cross-origin redirect would keep `x-csrf-token`.
- [x] **Allowlisted error details.** `COMPILE_FAILED` details become `{ status, rootFilePath, result: { status } }`, with `status` echoed only when it matches `^[a-z][a-z0-9-]{0,63}$`, else `"unrecognized"`; known upstream socket messages, which contain spaces, map to identifiers, and a raw socket `Error` in `openProjectConnection` no longer supplies the message; the upload body's `error` must pass the short-code check; `create_folder`'s `created` becomes `{ _id, name }`; JSON parse failures become `PROTOCOL_UNSUPPORTED` with `{ path, contentType }`.
- [x] Instructions are delivered on both protocol eras (`initialize` and `server/discover`), tested in memory (done with the SDK move).
- [x] **Instructions, counts, docs.** `SERVER_INSTRUCTIONS` to at most 400 words once; `test/mcp/tools.test.ts` also checks every "All N tools" in the README (the tool-list sentence and the Documentation table row) and the comparison "Tools" cell; a "Local effect" column in the tool tables, a policy section in `docs/configuration.md`, and "The access policy is not a sandbox" in `docs/safety.md`, which with the `upload_file` description also says `expectedHash` is a preflight, not a compare-and-swap.
- [x] **Upload `writeMode`.** Resolve `upload_file`'s `writeMode: "untracked"`, inaccurate since 0.4.1 found that replacing a document is tracked when track changes is on for the account, as designed above, with a test for each state.
- [x] **CHANGELOG 0.5.0:** `Added`, `Deprecated` (each announced default, naming 0.6.0), and `Changed` (annotations, path-safe ids, `.olignore` refusal, sanitized details, the `create_folder` result).

**Design decisions made while building 0.5.0, and why the draft above changed:**

- **`OverleafService` is keyed by operation.** `createOverleafService(runtime)` returns one function per tool name, taking the tool's input and resolving with its result; the interface the runtime implements, today's `OverleafToolRuntime`, is `OverleafServiceRuntime`. Naming both `OverleafService` would have given the factory and its argument the same name.
- **The service takes input as the interface parsed it.** The MCP SDK validates against the contract's schema before the handler runs, and `test/mcp/tools.test.ts` pins the exact arguments each handler forwards, so the service shapes arguments without parsing again; a library caller is held to the input type. The CLI (v0.7.0) parses with the same schemas.
- **Effects are checked where they are known.** A contract lists every effect an operation can have, but which ones a call has depends on its input (`manage_entity` deletes only with `delete`) or on what Overleaf holds (an upload replaces a document only if one is there, seen inside the queue job). So the domain APIs check each effect they actually perform, before any request, and the service checks the project first, before any local read. A direct call through the exported runtime is covered either way.
- **An allowlist hides the rest.** With `OVERLEAF_ALLOWED_PROJECTS` set, `list_projects` reports `totalProjects`, and `auth_status` `projectCount`, over the allowed projects only, so nothing outside it is listed or counted. Roots must be absolute, and an empty variable counts as unset.
- **`expectedHash` alone confirms a binary replacement**, as a `revision` or a `planToken` confirms by expected state; `overwrite: true` confirms by value. An explicit `overwrite: false` refuses even with a matching hash. A document has no hash, so `expectedHash` for a path that holds one is `REMOTE_DRIFT`.
- **`batch_upload` gains `uncheckedDocumentReplace`, and `onConflict` loses its schema default.** v0.6.0 applies the document rule per file, so callers need the opt-in before then; and an omitted `onConflict` can only be announced as deprecated if it differs from an explicit `"overwrite"`. A deprecation is listed once per parameter per call, and only when a replacement relied on the default.
- **`writeMode` reports, it is not dropped.** `upload_file`'s result says `tracked` exactly when a document replaced a document while the account's track-changes state, observed on join, is on.
- **Diagnostics are `{ tool, code }`.** The service reports a failed call with its error code and a deprecated default with `DEPRECATED`; `serve` writes them to stderr as `{"diagnostic":…}`. `OperationContext.signal` is defined, and nothing yet passes it on, which keeps every write path free of it.
- **Only mutations stop following redirects.** fetch drops `cookie` and `authorization` on a cross-origin redirect but keeps `x-csrf-token`, so a request that changes something uses `redirect: "manual"` (a redirect to `/login` is still `AUTH_EXPIRED`), while reads keep following, since a binary download may be redirected to storage on another host.
- **Socket messages map through a short table.** A known message becomes an identifier in `details.reason`; anything else is `unrecognized`, even when it looks like an identifier, so no upstream text is echoed.
- **The saved session is never read either.** A review of the branch found that `write_file` or `upload_file` with `localPath` set to the cookie jar would put the cookies into a project, and a sync of a folder holding it would upload it. So the session files are refused for local reads as well as writes, and a folder that holds them cannot be synced: a fourth refusal with every variable unset, beyond the three the draft named.
- **Paths are judged the way the file system resolves them.** Normalizing `link/../x` as text names a different file than the one the file system opens, which let a `..` through a symbolic link reach the cookie jar past the check. The policy resolves a path component by component, links before the `..` after them and a dangling link by where it would create a file, and the caller opens exactly the path that was checked.
- **`overwrite: false` refuses anything; an omitted `overwrite` concerns binaries.** From v0.6.0 an omitted `overwrite` refuses replacing a binary, and `uncheckedDocumentReplace` alone governs a document, so a document replacement that passes it keeps working.
- **The snapshot came first.** `test/__snapshots__/list-tools.json` was committed on the 0.4.1 surface before the move, so the move's commit shows `tools/list` unchanged and every later change to it shows up in review.

### Acceptance

- After the move the committed `listTools()` snapshot is unchanged, and `test/mcp/tools.test.ts` and `test/server.test.ts` pass with only import-path changes.
- `grep -rnE "from '(\.\./)*\.?/?mcp/|@modelcontextprotocol" src` matches only `src/mcp/`, `src/server.ts`, and `src/cli.ts`, and a lint fixture importing `./mcp/tools.js` from `src/runtime.ts` fails.
- With every `@modelcontextprotocol/*` module and `src/mcp/tools.js` mocked to throw on load, `src/sdk.js` performs `read_file` through injected fakes. The built `overleaf-web-mcp/core` exposes `createOverleafService` and a `McpError` strictly equal to the root's, not `ProjectConnection`, and the root still exports every 0.4.1 name.
- Tokenless `sync_directory` resolves with `planned === false` and a `deprecations` entry `{ parameter: "planToken", enforcedIn: "0.6.0" }`; `unplanned: true` with a `planToken` or `mode: "mirror"` rejects with `INVALID_ARGUMENT` before any read.
- `upload_file` onto an existing binary: `overwrite: false` gives `CONFIRMATION_MISMATCH` and a wrong `expectedHash` gives `REMOTE_DRIFT`, each with 0 `postForm` calls; the matching hash gives `replaced: true`; an omitted `overwrite` resolves with a `deprecations` entry.
- `download_file` annotations equal the block above; no `readOnlyHint: true` operation has an effect other than `overleaf-read` or `local-read`; the destructive-tools test passes; `grep -n "one minor" AGENTS.md` matches; `grep -nE "plan you reviewed|what you reviewed" README.md docs/*.md | grep -v planToken` prints nothing.
- Policy refusals make zero fetches: `write_file` with `localPath`, `upload_file`, `import_project_zip`, and `plan_sync` outside `OVERLEAF_LOCAL_READ_ROOTS`, or through a symbolic link that leaves it, reject with `PATH_OUTSIDE_ROOT` with 0 fetcher and connection-factory calls after `OverleafRuntime.create()`; `download_file` onto the cookie jar is refused with no roots set.
- With `OVERLEAF_ALLOWED_PROJECTS=a`, every operation taking `projectId` or `sourceProjectId` rejects `b` with `POLICY_DENIED` and 0 fetches, a project created in the same process is accepted, and `list_projects` hides everything else. With `OVERLEAF_ALLOWED_EFFECTS` excluding `overleaf-write`, a direct `runtime.documents.writeFile` rejects with `POLICY_DENIED` and 0 `submitUpdate` calls.
- `stop_compile` with `projectId: "../x?"` and `reply_to_comment` with `threadId: "../x?"` reject with `INVALID_ARGUMENT` before any fetch; `OverleafHttpClient.request("POST", "https://other.example/x")` throws before fetching.
- No serialized error or result contains the sentinel or `<!DOCTYPE` for an `otUpdateError` quoting document text, `connectionRejected` `{ message: "SENTINEL" }`, an upload body `{ success: false, error: "Free <b>SENTINEL</b> text" }`, an HTML 200 body on `getJson`, or a compile status `"SENTINEL free text"` (which yields `details.status === "unrecognized"`).
- The protocol-era tests pass after the trim, a one-time check finds `SERVER_INSTRUCTIONS` at 400 words or fewer, and the tool-count test fails when any README count disagrees with `TOOL_NAMES.length`.

---

## v0.6.0 — Compile and build ergonomics (shipped)

**Motivation:** `compile_project` returns a large JSON blob of build-artifact URLs plus a `stats` object. The session concluded success from `stats["latexmk-errors"] === 0`, never fetched `output.log`, and had no tool to do so. There is also no way to pull the compiled PDF to a local path; `download_file` is for project source entities only. This closes the README comparison gap "Reads the compile log and errors". It was v0.5.0 in earlier versions of this file; it now goes through the v0.5.0 contracts, so the CLI and SDK get both tools for free, and it enforces the safety defaults v0.5.0 announced.

**what the code does today, and why the failure path matters more than the success path.** `src/overleaf/compile.ts` throws `COMPILE_FAILED` for **every** non-`success` status and, until v0.5.0, buried the whole response, including the `output.log` URL, under `details.result`. So on the most common failure, a LaTeX error, the caller receives an error object with the evidence hidden inside it. On success it spreads the raw, unvalidated response into the result. Overleaf's web client distinguishes these non-success statuses: `failure`, `timedout`, `terminated`, `too-recently-compiled`, `rate-limited`, `autocompile-backoff`, `compile-in-progress`, `project-too-large`, `validation-problems`, `clsi-maintenance`, `clsi-unavailable`. It may also handle `stopped-on-first-error`, `exited`, and `unavailable` (`clsi-unavailable` being only a UI key), put the build id only on `outputFiles[].build`, and keep output for `timedout` and `terminated` builds *(verify in code: `local-compile-context.tsx`, `CompileController.mjs`)*. Output files are served at `/project/:id/build/:buildId/output/:file`, adding `clsiserverid` as a query parameter when the response includes one; the server builds that path from the build id and a validated file name and never follows a `url` from the response.

### Changes to `compile_project`

```ts
compile_project(...)  // existing params, plus stopOnFirstError?: boolean, draft?: boolean
  → {
      ...existing fields (outputFiles, stats, buildId, clsiServerId, rootFilePath), validated,
      buildRef?: string,         // opaque; pass to get_compile_log / download_compile_output
      summary: {
        status: "success" | "failure" | "stopped-on-first-error",   // Overleaf's own status
        builtCleanly: boolean,   // === pdfProduced && errorCount === 0
        errorCount: number,      // total; the lists below hold the first 20
        errors:   [{ file?: string, line?: number, message: string }],
        warnings: [{ file?: string, line?: number, message: string }],
        undefinedReferences: string[], undefinedCitations: string[], missingFiles: string[],
        pageCount?: number, pdfSizeBytes?: number
      }
    }
  // IMPORTANT: Overleaf reports status "success" under nonstopmode even when LaTeX errors
  // occurred. builtCleanly is the field callers should assert on.
```

- **Return a parsed summary on success and on `failure` alike.** Throw only when there is no build output: `too-recently-compiled`, `rate-limited`, `autocompile-backoff`, `compile-in-progress`, and HTTP 429 → `COMPILE_RATE_LIMITED` (retryable, with `retryAfterMs`); `clsi-maintenance` and `unavailable` → `COMPILE_UNAVAILABLE` (retryable); `timedout` → `COMPILE_TIMEOUT`; the rest, `validation-problems` included, → `COMPILE_FAILED`.
- **Error details are exactly `{ status, rootFilePath, buildId?, buildRef? }`**; `details.result` is gone. A build id is recorded before the throw, so a timed-out build's log stays reachable. A `TIMEOUT` on the compile POST is `retryable: false`, because the compile may still be running.
- **Validate the response at the boundary**: `status` required, `outputFiles` defaulting to `[]` with each entry reduced to `{ path, type, build? }` (no `url`), `stats` reduced to finite numbers. Anything else malformed is `PROTOCOL_UNSUPPORTED` with `{ endpoint: "compile", expectedKeys, receivedKeys }`.
- **A stateless `buildRef`**, base64url like `planToken`, carries the project id, build id, and routing values, so a CLI call in a new process can fetch an earlier compile's output; within one process the tools default to the latest build.
- **licence constraint on the log parser.** Overleaf's `latex-log-parser.ts` and `bib-log-parser.ts` are AGPL-3.0 and this package is MIT, so write an independent, pure parser for the patterns that matter (`! ` errors with `l.<n>`, undefined references and citations, missing files, `Output written on output.pdf (N pages, M bytes)`, `.blg` "I didn't find a database entry"), tested against fixture logs. A message is the `!` or warning line cut to 240 characters, without the source excerpt after `l.<n>`, which quotes the document.
- **expose `stopOnFirstError` and `draft`**, which Overleaf's compile endpoint already accepts: the first gives a short log with the one error that matters, the second speeds up text-only iteration.

### New tools

```ts
download_compile_output({ projectId: string, localPath: string, file?: string, buildRef?: string, overwrite?: boolean })
  → { localPath, file, sizeBytes, buildId }
  // file defaults to "output.pdf" and accepts any output path (output.log, output.blg,
  // output.synctex.gz). Without buildRef, the latest build known to this process, else NO_BUILD;
  // an evicted build is BUILD_NOT_FOUND. Writes through the local-write policy; an existing
  // localPath without overwrite: true is CONFIRMATION_MISMATCH, nothing written.
  // annotations: as download_file (readOnlyHint false, destructiveHint true, idempotentHint false)

get_compile_log({ projectId: string, buildRef?: string, kind?: "latex" | "bibtex",
                  format?: "raw" | "errors-only", tail?: number })
  → { buildId, log: string, truncated: boolean, errorLines: [{ line: number, text: string }] }
  // Reads at most 1 MB and returns a bounded tail. annotations: readOnlyHint true
```

### Tasks

- [x] Log parser with fixture tests under `test/fixtures/compile/` (clean, errors under nonstopmode, missing bib, 500 errors).
- [x] Response schema, status mapping, error details, `buildRef`, a bounded body reader, and the parser wired into `compile_project`, all as contract entries with `outputSchema`.
- [x] Both new tools; `TOOL_NAMES`, the README counts, the tool table, the comparison row, `docs/tools.md`, and `docs/private-api.md` (output route, `stopOnFirstError` and `draft`, "passed through" removed).
- [x] The five new codes in `ERROR_CODES` and `docs/safety.md`; the Compiling paragraph of `src/mcp/instructions.ts`.
- [x] Read-only MCP **resources** `overleaf://project/{id}/output/output.log` and `.../output.pdf`; the live test asserts `summary.builtCleanly === true` and PDF magic bytes `%PDF-`.
- [x] **CHANGELOG 0.6.0:** `Added` (both tools, `summary`, `buildRef`, `stopOnFirstError`, `draft`, the output resources, the five codes); `Changed` (`failure` returns a summary, compile error details reduced to four keys, `outputFiles` entries without `url`, a compile-POST `TIMEOUT` not retryable).

**Safety defaults flip (announced in v0.5.0)**

- [x] `sync_directory`: a `planToken` presence check before any read; mirror without a token, or additive with neither a token nor `unplanned: true`, fails with `CONFIRMATION_MISMATCH` and `details.missing: "planToken"`.
- [x] `upload_file`: `overwrite` defaults to `false`; an existing document without `uncheckedDocumentReplace` fails with `INVALID_ARGUMENT` naming `write_file` with `localPath`; `batch_upload`, shipped in 0.4.1 with `onConflict` defaulting to `"overwrite"`, flips with it: no default that replaces, and the same document rule per file.
- [x] Wording in `src/mcp/instructions.ts`, the `sync_directory` description ("required in mirror mode"), `docs/tools.md`, AGENTS.md, and `docs/safety.md`; CHANGELOG 0.6.0 `Changed` names each flipped default.

**How the design settled (recorded while building 0.6.0).** Read against `overleaf/overleaf`
(`CompileController.mjs`, `CompileManager.mjs`, `ClsiManager.mjs`, `local-compile-context.tsx`,
`output-files.ts`, and `libraries/validation-tools`):

- The compile response has no top-level build id; it is `outputFiles[].build`, validated as
  Overleaf validates it (`^[0-9a-f]+-[0-9a-f]+$`), with `clsiServerId` as `^[a-z0-9-]+$`. The
  statuses are those listed above plus `exited`; `clsi-unavailable` is only a UI key, and is
  mapped to `COMPILE_UNAVAILABLE` anyway. `too-recently-compiled` comes from a one-second
  `COMPILE_DELAY`, so it carries `retryAfterMs: 1000`; a `COMPILE_RATE_LIMITED` adds
  `retryAfterMs` to the four detail keys when it is known, and nothing else does.
- The compile is posted with `?file_line_errors=true` (`-file-line-error`), so errors name their
  file; the parser also reads the classic `! ` form, undoes TeX's 79-column wrapping before
  cutting a message, and reads BibTeX and Biber `.blg` logs.
- The summary adds `pdfProduced`, `logRead`, and `warningCount` to the planned fields, and
  `builtCleanly` also needs `logRead`, so a log that could not be read is never reported clean.
  Every list, references, citations, and missing files included, holds at most 20 entries.
- `stats` keeps every key that is a short identifier with a finite number. An output file the
  server would refuse to request (absolute, `..`, control characters) is left out of
  `outputFiles` rather than failing the call; an entry without a string `path` is
  `PROTOCOL_UNSUPPORTED`.
- `buildRef` also lists the build's output paths (up to 100), so a file the build did not produce
  is `NOT_FOUND` with no request, and only a 404 for a listed file is `BUILD_NOT_FOUND`.
  `get_compile_log` reads the first 1 MB, as Overleaf's editor does, returns the last `tail`
  lines (default 200, at most 2,000, and at most 100,000 characters), and lists the first 100
  `errorLines`. The PDF resource stops at 16 MB.
- `batch_upload`'s new default is an explicit `onConflict: "fail"`: a taken destination refuses
  the whole call before any upload, with `details.missing: "onConflict"` and the paths, rather
  than skipping silently. `upload_file`'s refusals carry `details.missing` too. The `deprecations`
  field is gone from the three results; the mechanism (`src/contracts/deprecations.ts`, the
  `DEPRECATED` diagnostic) stays for the next announcement.

### Acceptance

- A project with a deliberate `\undefined` command yields Overleaf `status: "success"` but `builtCleanly: false` and `errorCount ≥ 1`; the test must exercise exactly this case.
- A clean project yields `builtCleanly: true`, `errorCount: 0`, correct `pageCount`.
- `download_compile_output` writes a file starting with `%PDF-` in one call, no separate log fetch needed.
- A failed compile returns structured `{ file, line, message }` errors instead of an opaque `COMPILE_FAILED`.
- A table-driven test maps every listed status to its code and `retryable`; HTTP 429 gives `COMPILE_RATE_LIMITED`; an empty 200 body gives `PROTOCOL_UNSUPPORTED`.
- Sentinels in `timings`, `outputFiles[].url`, `pdfDownloadDomain`, an unknown key, and a non-numeric `stats` value never reach the serialized error or result, and error details have no keys beyond the four above.
- A `timedout` response with build `B` rejects with `COMPILE_TIMEOUT`, `details.buildId === "B"`, and a `buildRef` with which a second runtime instance requests build B's log.
- The 500-error fixture gives 20 `errors` and `errorCount === 500`, with no message over 240 characters or matching `/^l\.\d+ /`.
- `download_compile_output` requests only paths under `/project/<projectId>/`, never a fixture URL on another origin, and `file: "../x"` is `INVALID_ARGUMENT` with zero requests.
- `TOOL_NAMES` grows by exactly two, and `grep -n "details.result" docs/safety.md docs/tools.md src/mcp/instructions.ts` prints nothing.
- Tokenless mirror rejects with `details.missing: "planToken"` and no read or mutation; `unplanned: true` resolves with `planned === false` and no delete; `upload_file` onto an existing document without `uncheckedDocumentReplace`, or onto an existing binary without `overwrite`, fails with 0 `postForm` calls.

---

## v0.7.0 — CLI, SDK, and Skills (shipped)

**Motivation:** the first complete Overleaf workflow that needs no MCP client. Before v0.7.0 the command line reached no operation, and a TypeScript program had only the `./core` runtime. Since v0.5.0 every operation is one service function with one contract, so a CLI and an SDK are thin adapters, and multi-process use needs no new state, because revision tokens, plan tokens, and `buildRef` are self-contained. `keepalive` already showed the output convention (`main` in `src/cli.ts`). One gap remained: 17 tools at 0.4.0 returned only a JSON text block; `upload_file` and `compile_project` gained an `outputSchema` in v0.5.0 and v0.6.0, `list_comments`, `reply_to_comment`, and `add_comment` in v0.6.2, and the other 12 in v0.7.0.

**Design decisions:**

- **One generic command, plus aliases.** `call <tool_name>` reaches every operation; aliases only build its input. Input is validated with the operation's contract, so defaults equal MCP's. An unknown key is refused (`INVALID_ARGUMENT`), because a misspelled `writeMode` would otherwise write untracked. The v2 SDK parses MCP input with the zod schema, and `z.object` drops an unknown key without failing, so MCP silently falls back to the default; `docs/cli.md` states the difference.
- **Output framing.** An operation command prints exactly one JSON value on stdout, the tool's `structuredContent`. On failure stdout stays empty and stderr gets one line of `{ code, message, retryable, details? }`, which may contain local paths the caller supplied. Progress goes to stderr as JSON lines only with `--progress`. `serve`, `login`, `keepalive`, and an unknown command keep their output and exit 1 on any failure.
- **Exit codes say what is safe to do next.** The HTTP client marks every timeout `retryable: true`, uploads and deletes included, so the code depends on whether the operation is read-only and on `details.outcome`; a wrapper that re-runs on "retry later" must never resubmit a write that may have applied.
- **Noninteractive and strict.** No browser, no terminal input, no confirm value supplied, no `--yes` or `--force`, no retry, and the defaults v0.6.0 enforced.
- **Each invocation is a session.** Every run bootstraps `GET /project` and may open a project socket, so the account can appear online and a shell loop multiplies requests; neither the per-project queue nor the in-memory allowlist reaches across processes. `docs/cli.md` points loops at `sync_directory`, `batch_upload`, and `delete_entities`.
- **Build references cross processes explicitly.** `compile log` and `compile download` require `--build-ref`, since a new process has no latest build; `compile run --download` does both in one process.
- **No document text in argv**, which process listings and shell history show: content goes through `--content-file`, `--stdin`, or `--request <file>`.
- **The SDK is a client facade over the same service.** `createOverleafClient(options?)` returns one camelCase method per operation plus `close()`, generated from the registry; each returns the contract output as a plain object and throws `McpError` with the same codes.
- **Output contracts for every tool.** Since v0.6.2 the comment tools rebuild their threads, so nothing stays loose. The service checks read-only results against their schema at run time; it only types mutating ones, because an error after a write applied invites a resubmission. The MCP SDK, though, validates every result it returns, writes included, so each schema must hold on every return path; golden results through the real domain classes pin that.
- **Skills come after the CLI**: revise a manuscript, handle reviewer comments, sync figures and sources, each a folder with a `SKILL.md` in the open Agent Skills format (`name`, `description`, `license`, `compatibility`; no `allowed-tools`, so no destructive command is pre-approved). They call only public CLI commands, duplicate no authentication or OT logic, and treat manuscript text and reviewer comments as data, never instructions.

### Commands

```text
overleaf-web-mcp call <tool_name> [--request <file> | --request - | --json <object>] [--progress]
overleaf-web-mcp schema <tool_name> (--input | --output)
overleaf-web-mcp capabilities [projectId]

overleaf-web-mcp projects list [--query <q>] [--limit <n>] [--sort lastUpdated|name] [--include-archived] [--include-trashed]
overleaf-web-mcp tree <projectId>
overleaf-web-mcp files read <projectId> <path>
overleaf-web-mcp files write <projectId> <path> --revision <r> (--content-file <f> | --stdin) [--tracked]
overleaf-web-mcp files download <projectId> <path> <localPath> [--overwrite]
overleaf-web-mcp sync plan <projectId> <localFolder> [--destination <path>] [--ignore <glob>]... [--verbose] [--progress]
overleaf-web-mcp sync apply <projectId> <localFolder> --mode additive|mirror (--plan-token <t> | --unplanned)
                 [--destination <path>] [--ignore <glob>]... [--confirm-delete-count <n>] [--tracked]
                 [--stop-on-error] [--progress]
overleaf-web-mcp compile run <projectId> [--root <path>] [--draft] [--stop-on-first-error] [--download <localPath>] [--overwrite]
overleaf-web-mcp compile log <projectId> --build-ref <r> [--tail <n>] [--kind latex|bibtex] [--errors-only]
overleaf-web-mcp compile download <projectId> <localPath> --build-ref <r> [--file <f>] [--overwrite]
overleaf-web-mcp comments list <projectId> [--status open|resolved|all] [--file <path>] [--author <a>]
```

Every other operation is reached through `call`. Exit codes apply to operation commands only:

| Exit | Meaning | Codes |
| :---: | --- | --- |
| 0 | Complete | |
| 1 | Anything else | |
| 2 | Fix the call | usage errors, `INVALID_ARGUMENT`, `CONFIRMATION_MISMATCH`, `PATH_OUTSIDE_ROOT` |
| 3 | Not allowed or not available; do not retry | `AUTH_EXPIRED`, `PERMISSION_DENIED`, `POLICY_DENIED` |
| 4 | Read or plan again, then decide | `REVISION_CONFLICT`, `REMOTE_DRIFT`; any error with `details.outcome: "not_applied"` from an operation that is not read-only, `TIMEOUT` included; any error from one that says part of it applied (`details.created`, a non-empty `details.applied`), unless its code exits 3 |
| 5 | Outcome unknown; read before acting, never re-run blindly | `OUTCOME_UNKNOWN`; any error with `details.outcome: "unknown"`, which wins over every other rule; `TIMEOUT` from an operation that is not read-only, unless `details.outcome` is `not_applied` (exit 4) |
| 6 | `status: "partial"`; the result is still on stdout | |
| 7 | Safe to retry later | `RATE_LIMITED`, `COMPILE_RATE_LIMITED`, `COMPILE_UNAVAILABLE`; `TIMEOUT` or any other `retryable` error from a read-only operation, or while the session is being opened |

### Tasks

- [x] **Output contracts** for the 12 remaining tools, with golden results taken first through the real domain classes over an injected fetcher and connection factory (`test/golden/`). Every tool registers with an `outputSchema` and a byte-identical text block, and the adapter's text-only branch is gone. `errorCodeSchema` became `z.enum(ERROR_CODES)`; the narrower runtime type of `createMcpServer` and `createOverleafService` is listed under `Changed`.
- [x] **CLI.** `src/cli/parse.ts` on `node:util` `parseArgs`, delegating anything else to the untouched `parseCliCommand`; `call`, `schema`, `capabilities` (effects and annotations from the contract entry, error and exit codes; with a `projectId`, project-level fields, else `unknown`), the aliases, `src/cli/exit-codes.ts`, and `runtime.close()` in `finally`.
- [x] **Docs.** AGENTS.md and `docs/safety.md`: every command but `serve` and `help` prints exactly one JSON result. `docs/cli.md` in the `mkdocs.yml` nav: commands, request format, exit codes (never re-run on 5), no cross-process serialization or allowlist, presence and request volume, and the Skills. README: a "Without an MCP client" section and a lead sentence naming MCP, the CLI, and the SDK; `docs/install.md`: a CLI-only path.
- [x] **SDK.** `createOverleafClient` in `overleaf-web-mcp/core` (`src/client.ts`); `docs/sdk.md` in the nav names the stable surface (`createOverleafClient`, `createOverleafService`, the contract types, `McpError`, `ERROR_CODES`, `readConfig`, `OverleafRuntime.create` and `close`), marks runtime fields and `connectionFactory` internal, and shows a minimal program.
- [x] **Skills** under `skills/`, using only commands `renderHelp` lists, and `skills` in `package.json` `files`; a test parses every command line in them and rejects any mention of `@modelcontextprotocol`, `src/`, or the cookie jar.
- [x] **Comparison.** `test/live/compare-interfaces.test.ts`, gated by `RUN_OVERLEAF_LIVE_TESTS=1` and `RUN_OVERLEAF_LIVE_COMPARE_TESTS=1` on a throwaway project it creates and trashes, runs the four tasks in **Interfaces beyond MCP** (review on comment threads) through a spawned `serve`, `node dist/cli.js`, and the SDK, and writes a JSON report of those metrics plus round trips, upstream requests and bytes, bytes an agent would read, and start-up versus Overleaf time, for a cold and a warm run of each task.
- [x] **Live CLI test** (`RUN_OVERLEAF_LIVE_TESTS=1` and `RUN_OVERLEAF_LIVE_CLI_TESTS=1`): `node dist/cli.js` alone, from `call create_project` through `files write`, `sync apply --plan-token`, and `compile run` to a trash of that throwaway project.
- [x] **CHANGELOG 0.7.0:** `Added` (commands, exit codes, `createOverleafClient`, Skills, 12 output schemas); `Changed` (`errorCode` enum, the runtime parameter type, read-only result checks).

### Acceptance

- `test/cli-command.test.ts` is unchanged and passes; `overleaf-web-mcp unknown` exits 1; the keepalive dead-session test still passes.
- For every `TOOL_NAMES` entry, `schema <name> --input` prints a JSON Schema with `"type": "object"`, and `call <name> --request <fixture>` reaches the fake service with arguments deep-equal to those the MCP handler passes.
- A table-driven test over every error code: success writes one JSON value to stdout and exits 0; an injected `McpError` leaves stdout empty, writes exactly one stderr line parsing to `{ code, message, retryable, details? }`, and exits with the table's code.
- `TIMEOUT` from `write_file`, `upload_file`, or `create_project` exits 5; `TIMEOUT` from `read_file` exits 7; `TIMEOUT` with `details.outcome: "not_applied"` from `write_file` exits 4; `REVISION_CONFLICT` with `details.outcome: "unknown"` exits 5; `status: "partial"` exits 6 with the result on stdout.
- `files write` with a stale revision against the real `DocumentsApi` exits 4 with zero `submitUpdate` calls; `manage_entity` delete without `confirmPath` and mirror `sync apply` without `--confirm-delete-count` exit 2 with zero DELETE requests; an unknown request key exits 2 and never calls the service.
- `captureBrowserSession` is never called by an operation command; stderr is empty after a successful `sync apply` without `--progress`; and across every CLI test stderr never contains a seeded cookie-jar value or a comment-body sentinel.
- Parity: for every tool, MCP `structuredContent`, the MCP text block, CLI stdout, and the SDK return value are deep-equal, and an injected `McpError` gives an identical `{ code, message, retryable, details }` through all three. A real `PATH_OUTSIDE_ROOT` (`download_file` outside `OVERLEAF_LOCAL_WRITE_ROOTS`) and a real `POLICY_DENIED` (`OVERLEAF_ALLOWED_PROJECTS`) give the same error through all three with 0 fetches.
- Every tool has an `outputSchema` its `structuredContent` validates against over the in-memory transport, `grep -n "handler(async" src/mcp/tools.ts` prints nothing, and the 12 tools' golden results are unchanged.
- `createOverleafClient` over injected fakes has a method per `TOOL_NAMES` entry, performs `readFile`, `writeFile` with the returned revision, and `close()`, and throws `McpError` with `REVISION_CONFLICT` on a stale revision.
- `capabilities` lists every tool, reports `download_file` with a `local-write` effect, and without a `projectId` reports project-level fields as `unknown`; every `renderHelp` command appears in `docs/cli.md`.
- `npm pack --dry-run` lists the three `SKILL.md` files, and the comparison, with its flags set, reports every task and interface with the same outcome through all three.

**How the design settled (recorded while building 0.7.0).**

- The aliases gained flags the plan left out because the contract already takes them: `--sort`, `--include-archived`, and `--include-trashed` on `projects list`; `--draft` and `--stop-on-first-error` on `compile run`; `--kind` and `--errors-only` on `compile log`; `--author` on `comments list`; and `--progress` on `sync plan`. `sync apply` takes `--destination` and `--ignore`, because a `planToken` is bound to the folder, the destination, and the ignore list. `call` without a request sends `{}`.
- `files write --content-file` becomes `write_file`'s `localPath`, so the operation reads the file and `OVERLEAF_LOCAL_READ_ROOTS` applies; `--stdin` is decoded as UTF-8 like a file, a leading byte order mark dropped. A terminal on stdin is refused.
- `compile run --download` prints `{ status, compile, download }`. When the download fails after the compile, the compile result stays on stdout with `status: "partial"`, `download: null`, and the download's error as `downloadError`, and the command exits 6, so the build reference the compile spent its allowance on is never lost.
- Input is parsed strictly before any session opens, by one function the CLI and the SDK client share (`parseOperationInput` in `src/contracts/parse.ts`), so a refused call sends nothing, not even the bootstrap. Usage and parse messages name options and paths, never values.
- Four exit rules extend the table: a write whose error says `details.outcome: "not_applied"`, such as `REMOTE_ERROR` after a lost socket (0.6.2), exits 4 like a stale revision; a write whose error says part of it applied (`create_file` with `details.created`, `update_project_settings` with `details.applied`) exits 4, since exits 2 and 7 promise that nothing changed; any `retryable` failure of a read-only operation exits 7; and a failure while the session is being opened exits as a read's would. `details.outcome: "unknown"` is checked first. Reviewing the release against these promises found that a failed read-back after a posted reply escaped as a retryable `RATE_LIMITED` (exit 7), inviting a duplicate reply; the comment tools now report `OUTCOME_UNKNOWN` there.
- `capabilities` without a `projectId` opens no session. With one, the project lookup is the account's project list (one request), a project outside `OVERLEAF_ALLOWED_PROJECTS` is reported `allowedByPolicy: false` without a request, and each operation lists the `blockedEffects` the access policy refuses; an operation fails only when a call needs one of them.
- The Skills keep strings chosen by collaborators off the shell: a project path goes into a request file for `call`, never into a command line, and every other value is single-quoted. Their test parses every command, one per line, checks each request example against its schema, and runs each helper.
- `serve` imports the MCP server lazily, so no operation command loads the MCP SDK, and `src/cli/` writes through injected streams, so only `src/cli.ts` touches the process streams.
- Typing the service by contract surfaced three gaps the SDK would have turned into failed calls: `upload_file`'s declared result admitted a skipped upload only `batch_upload` can produce, and three comment results declared `recoveredAfterTimeout` as a boolean; both were narrowed. Deriving the schemas found a tree `hash` passed through unvalidated and a heading nested in a heading title that made `write_section` write part of the heading twice; both were fixed.

---

## v0.8.0 — Tracked-change review: accept and reject (shipped)

**Motivation:** before v0.8.0, tracked changes could be written (`writeMode: "tracked"`) but not listed, accepted, or rejected, the second gap in the README comparison ("Accepts or rejects tracked changes"), which a web-session peer already covered. history-ot `trackedChanges` were read only to strip tracked deletions from visible content (`historyVisibleContent` in `src/protocol/ot.ts`), and ShareJS `ranges.changes` was never read. The same blind spot weakened tracked writes: `DocumentsApi.writeFile` verified only the visible content hash, so a tracked insert that Overleaf recorded untracked passed verification. The range parsers this stage needed closed that gap too.

**Verify first.** Before this stage, no captured frame here held a non-empty change (the fixtures under `test/fixtures/protocol` show `"changes":[]` and `"trackedChanges":[]`), and no accept or reject route is in `docs/private-api.md`. Confirm each item in `overleaf/overleaf` at the commit the release targets, record it in `docs/private-api.md`, and gate anything unconfirmed with `REVIEW_UNSUPPORTED` rather than guessing (`details.kind: "document_protocol"` for a document protocol with no confirmed mechanism). All ten were checked against `overleaf/overleaf` e039ad2 and, where a disposable project allowed it, live on `www.overleaf.com` on 2026-10-30; what was found follows each item, and the details are in `docs/private-api.md`:

1. The accept route, believed to be `POST /project/:project_id/doc/:doc_id/changes/accept` with `{ change_ids }`: authorization, version bump, and history-ot support. **Not in public source; confirmed live.** The web handler is private, so its authorization is unknown (the editor offers Accept only to users who can write). Live: 204 with an empty body, no version bump, content unchanged, ids gone; unknown, already accepted, or no ids also give 204, so ids are checked locally first; a non-ObjectId id gives 400, an unknown document 500, an unknown route 404. document-updater refuses a history-ot document with 422, so REST accept is for ShareJS only.
2. How the editor rejects: a reject route, or an untracked inverse OT operation (for ShareJS, an insert with an undo flag that cancels a delete change). **Confirmed, changed.** No client route: `/changes/reject` is a private notification route document-updater calls. A ShareJS reject is one untracked update with `u: true` on every component, a reject insert `{ p, d, u: true }` as well as a reject delete `{ p, i, u: true }`, in ascending order with cumulative shifts and `d` before `i` at equal `p`. Live-verified for a delete, an insert, and a replacement pair in one update.
3. The ShareJS change shape `{ id, op: { p, i } | { p, d }, metadata: { user_id, ts } }`. **Confirmed, with tolerances**, in source and live: `ts` is an ISO string, `user_id` an opaque string (it can be `anonymous-user` or null), `id` can be missing after a history restore, and `op` can carry other keys. Same-user touching inserts merge and keep the first id; a replacement is an insert at `p` plus a delete at `p` plus the insert's length.
4. Whether `joinDoc` with `encodeRanges: true` encodes range text as it encodes lines. **Confirmed**, in source and live: `op.i`, `op.d`, and `op.c` of a ShareJS document are Latin-1-read UTF-8 like the lines; `p`, ids, and metadata are not encoded, and `/ranges` text is plain UTF-8. 0.7.1 does not decode `op.c`, so non-ASCII comment ranges are wrong there; this stage fixes it.
5. The raw history-ot `trackedChanges` form (see `HistorySnapshot` in `src/protocol/ot.ts`): no ids, adjacent-range merging, and the `TextOperation` forms that clear tracking or delete. **Confirmed in source, not captured live** (no history-ot document was available): no ids; touching ranges with the same type and user merge, keeping the earliest timestamp, only after a `TextOperation`; empty `comments` and `trackedChanges` keys are left out; the decision forms are in the table below.
6. Whether `GET /project/:id/ranges` returns `changes`, history-ot documents included. **Not in public source; confirmed live** for ShareJS: a top-level array `[{ id, ranges }]` with `changes`, unflushed changes included, plain UTF-8 text, and the joinDoc ids. Its ids for a history-ot document are drawn at random on every flush, so they are never valid.
7. `project.features.trackChanges` in `joinProject`, and the privilege levels `owner`, `readAndWrite`, `review`, `readOnly`. **Confirmed, changed.** The levels are as listed. `features` are the owner's, and `features.trackChanges: true` alone proves nothing: `features.trackChangesVisible` says whether the deployment has the review module (true live, false in the public source).
8. Whether `meta.tc` on a tracked ShareJS update is the author or an id seed. **Confirmed: an 18-hex id seed**, the only key `meta` may hold. Tracking is on when it is present, the author is the session's user, and change ids are `tc` plus a six-hex counter. This server already sends a fresh seed on every tracked write, since 0.6.2.
9. Whether `applyOtUpdate` forces tracking for the `review` privilege. **Confirmed: it does not.** Authorization follows the op's shape (`meta.tc` needs review level, an untracked text change edit level), and an unauthorized update gets `not authorized` and a disconnect, so every OT write gets a local access check before it is sent.
10. The real-time service's `otUpdateError` messages (the too-large case in particular) and which clients receive the event. **Confirmed, changed.** `update is too large` is emitted by real-time to the sender only, after a success ack, then a disconnect, with nothing stored. document-updater errors (`Invalid hash`, `Delete component does not match`, and other fixed strings) are emitted to every socket joined to the document and can follow `otUpdateApplied`: live, a wrong hash was acknowledged, then errored and disconnected, with nothing stored.

### Tools

```ts
list_tracked_changes({ projectId: string, filePath?: string, type?: "insert" | "delete",
                       authorId?: string, excerptChars?: number /* 0..500, default 120 */,
                       limit?: number /* 1..500, default 100 */ })
  → { documents: [{ filePath, revision, protocol: "sharejs" | "history-ot", totalChanges,
                    undecidableChanges?,                 // changes stored without an id
                    changes: [{ changeId, type, start: { line, column }, end: { line, column },
                                length, excerpt?, excerptTruncated, authorId, timestamp?,
                                pairedChangeId? }] }],  // links the two halves of a replacement
      totalMatched, truncated, trackChangesActive, indexUnavailable?: true }
  // positions 1-based in UTF-16 units. annotations: readOnlyHint true

manage_tracked_changes({ projectId: string, filePath: string, revision: string,
                         action: "accept" | "reject",
                         changeIds: string[],                    // 1..500, unique, all in this document
                         confirmCount?: number })                // must equal changeIds.length
  → { action, filePath, changeIds, revision, protocol, remainingChangeCount,
      trackChangesActive, recoveredAfterTimeout?: true }
  // accept insert keeps the text; accept delete removes it; reject insert removes the text;
  // reject delete restores it. A tracked replacement is a delete plus an insert; pass both ids.
  // annotations: destructiveHint true, idempotentHint true (a repeat fails and changes nothing)
```

CLI: `tracked-changes list <projectId> [--file <path>] [--type insert|delete] [--author <id>] [--limit <n>] [--excerpt-chars <n>]` and `tracked-changes accept|reject <projectId> <path> --revision <r> --change <id>... --confirm-count <n>`, where a missing `--confirm-count` is `CONFIRMATION_MISMATCH` (exit 2) from the operation; the SDK methods come from the registry.

**Design decisions:**

- **Two tools.** Listing is read-only and cannot share a tool with a destructive action; decisions reuse the `manage_` action-enum pattern, one document per call, because revisions, the accept route, and OT are per document.
- **`confirmCount` is optional in the schema and checked by `TrackedChangesApi`**, as `sync_directory` checks `confirmDeleteCount`, so a missing value is `CONFIRMATION_MISMATCH`, not a schema error.
- **Listing never scans every document.** Without `filePath` it reads the `/ranges` index `list_comments` already uses and joins only documents with changes, or returns `indexUnavailable: true`. `filePath` is authoritative: index ids are never valid for history-ot documents; the index is a hint for choosing ShareJS documents to join (item 6).
- **Checks before anything is sent:** `confirmCount`; access level (`owner` or `readAndWrite`, else `PERMISSION_DENIED`); `features.trackChanges === false` or `features.trackChangesVisible === false` (`REVIEW_UNSUPPORTED`, `details.kind: "feature_disabled"`); revision; every id live (`NOT_FOUND`); no overlap with a change left out (`INVALID_ARGUMENT`). Then submit once and verify against a fresh join.
- **Mechanisms**, confirmed per the list above and recorded in `docs/private-api.md`. The expected state is computed locally and canonicalized before comparing; size limits are checked first. Reject operations carry no tracking metadata, so they are not tracked writes that fell back.

  | Document | accept insert | accept delete | reject insert | reject delete |
  | --- | --- | --- | --- | --- |
  | ShareJS | REST accept (1), ShareJS only | REST accept (1), ShareJS only | untracked OT `{ p, d, u: true }` (2) | untracked OT `{ p, i, u: true }` at the delete's `p` (2) |
  | history-ot | `{ r: n, tracking: { type: "none" } }` (5) | `-n` (5) | `-n` (5) | `{ r: n, tracking: { type: "none" } }` (5) |

  A ShareJS reject is one update, ascending, with cumulative shifts and `d` before `i` at equal `p`. History-ot decisions for one document are one `TextOperation` in ascending raw position, retaining the gaps and ending with a retain to the raw length; history-ot forms are confirmed in source, not captured live.

- **History-ot ids are synthesized** (`ht_` plus 22 base64url characters of a SHA-256 over document, type, position, length, user, and timestamp), valid only with the listed revision.
- **Timeouts are observed, never resent**, through one recovery helper extracted from `DocumentsApi.writeFile` and the comment writes: target state seen, `recoveredAfterTimeout: true`; original state live through the window, `TIMEOUT` with `"not_applied"`; a third state, `REVISION_CONFLICT` with `"unknown"`; nothing seen, `OUTCOME_UNKNOWN`.
- **The same parsers check tracked writes**, by coverage, so the check already holds for an operation with several components. ShareJS: after the write every inserted span is covered by a tracked insert whose author is the current user, and every deleted span is covered by a tracked delete by the current user or lay inside a tracked insert, of any author, before the write. History-ot: inserted spans are covered by `type: "insert"` with this user's `userId`, and deleted spans by `type: "delete"` with it. A covering change need not be new, since same-user changes merge and keep their first id. Otherwise the write fails with `PROTOCOL_UNSUPPORTED`, `retryable: false`, and `details.kind: "applied_untracked"`, with no `details.outcome`, because it applied; it is never reverted, since a revert is another write.
- **`otUpdateError` is classified, not echoed**: `update is too large`, the exact first argument, which real-time sends to the sender only, is `UPDATE_TOO_LARGE` with `"not_applied"`; anything else goes through observation on a fresh connection, since document-updater errors are broadcast to every client joined to the document and may follow the ack (item 10).
- **Independent code**: the upstream range libraries and the peer server are AGPL-3.0, this package MIT.
- **Plan and edition.** Review may need a paid plan on `www.overleaf.com` *(verify live)* and Server Pro when self-hosted *(verify against the current Community Edition)*; the free-plan positioning does not extend to it.
- **Known limits**, stated in the descriptions: the revision ignores ranges, so per-id checks catch a concurrent accept; after a history-ot decision removes text, re-list; a decision landing after the recovery window is reported `not_applied`, as with `write_file`.

### Tasks

- [x] Confirm items 1–10 into `docs/private-api.md`, and capture sanitized fixtures `test/fixtures/protocol/sharejs-tracked-changes.json` and `history-ot-tracked-changes.json` from a disposable project (an insert, a delete, a replacement pair, non-ASCII text; placeholder ids, users, and timestamps), plus a hygiene test over `test/fixtures/protocol` that fails on 24-hex ids, email addresses, and session cookie names. The history-ot fixture is hand-authored from source, since no history-ot document was available live.
- [x] `src/protocol/tracked-changes.ts` (pure parsers, ids, locations, excerpts, overlap detection, decision planner) with exact-operation tests; the shared recovery helper, with documents and comments moved onto it.
- [x] `TrackedChangesApi` in `src/overleaf/tracked-changes.ts`, inside the per-project queue, reading `features.trackChanges` and `permissionsLevel` from `ProjectConnection`; contract entries (`overleaf-read`, `overleaf-write`) registered after `set_comment_status`; `REVIEW_UNSUPPORTED` in `ERROR_CODES`.
- [x] CLI aliases and `docs/cli.md`; `src/cli/exit-codes.ts` maps `REVIEW_UNSUPPORTED` to 3 and `applied_untracked` to 4.
- [x] The fidelity check in `DocumentsApi.writeFile`, skipping no-op writes, with an optional `kind` on `SyncFailure` (`src/overleaf/sync.ts`); the `otUpdateError` mapping in `ProjectConnection.submitUpdate`.
- [x] Tracked-change decisions join the review task in `test/live/compare-interfaces.test.ts`.
- [x] Tracked-change guidance in `src/mcp/instructions.ts` (a "Review" paragraph shared with `add_comment`) within the 450-word bound: list first, confirm with the user, pass revision, ids, and a matching `confirmCount`, re-list after `REVISION_CONFLICT` or `NOT_FOUND`.
- [x] README (the counts, two Review rows, the comparison row, the plan caveat), `docs/tools.md`, `docs/safety.md`, `docs/internals.md`, `docs/using.md`; an opt-in live test behind `RUN_OVERLEAF_LIVE_TRACKED_REVIEW_TESTS=1`; CHANGELOG 0.8.0 `Added` and `Changed`.
- [x] Added during the stage: document writes send one edit per changed word group instead of one span, kept clear of comments and tracked changes, so a tracked write records one suggestion per changed word group (`src/core/edit-placement.ts`, `planEdits` in `src/overleaf/documents.ts`).

### Acceptance

- `list_tracked_changes` is annotated exactly `{ readOnlyHint: true }` and `manage_tracked_changes` exactly `{ destructiveHint: true, idempotentHint: true }`, both have an `outputSchema`, and `TOOL_NAMES` grows by exactly two over the stage base (33 if earlier stages shipped as planned).
- `confirmCount` missing or not equal to `changeIds.length` gives `CONFIRMATION_MISMATCH` with zero `joinDocument`, `submitUpdate`, and `postJson` calls; a stale revision, an absent id (`details.missingChangeIds`), a `review` or `readOnly` access level, and `features.trackChanges === false` each return their code before `submitUpdate` or `postJson`.
- A ShareJS accept posts once to the confirmed route with exactly the given ids, and a 404 gives `REVIEW_UNSUPPORTED` with `details.kind: "route_unavailable"`; other decisions submit exactly the fixture-derived operation with no tracking metadata; a fresh join that misses the expected state gives `REVISION_CONFLICT` with `"unknown"`.
- After a timeout, with one submission, each of the four recovery outcomes above is produced for both the REST and OT mechanisms.
- Without `filePath`, a `/ranges` 404 returns `indexUnavailable: true` with no join; excerpts never exceed `excerptChars` or split a surrogate pair; no key named `email` appears.
- Both new fixtures parse, and a hygiene test finds no 24-hex string, no `@`, and no cookie name under `test/fixtures/protocol`. The confirmed too-large `otUpdateError` message gives `UPDATE_TOO_LARGE` with `"not_applied"` after one `submitUpdate`.
- A tracked write whose rejoin shows the text but no new tracked ranges for the user rejects with `details.kind: "applied_untracked"` after one `submitUpdate`, and a tracked `sync_directory` step reports that `kind`; `test/overleaf/documents.test.ts` and `comments.test.ts` pass unmodified after the helper extraction.
- `tracked-changes accept` without `--confirm-count` exits 2 with `CONFIRMATION_MISMATCH`; `REVIEW_UNSUPPORTED` exits 3; `applied_untracked` exits 4.
- Live, on a disposable project: a tracked insert is listed with `authorId` equal to `auth_status`'s `userId`; reject restores the original text; accept on a second file keeps it and empties the listing.
- Every route and OT form the code submits is listed in `docs/private-api.md` without a *(verify in code)* mark.

---

## v0.9.0 — Multi-file document support (shipped)

**Motivation:** before v0.9.0, `get_sections` / `get_section_content` / `write_section` were explicitly single-file. The project in the session was, until recently, split across `0_main.tex` plus eight `sec: *.tex` files stitched together with `\input`. Plenty of real Overleaf projects stay organised this way permanently, and section tools that stopped at `\input` boundaries could only partially help with them.

This was v0.6.0 in earlier versions of this file. The design is unchanged, except that `get_full_document` and the `followIncludes` parameters are contract entries (v0.5.0), so the CLI and SDK (v0.7.0) expose them without adapter code.

**resolution rules to decide up front (document them).** `\input{x}` tries `x` then `x.tex`; `\include{x}` always means `x.tex`, implies a page break, and interacts with `\includeonly` (respect it, or at least flag it in the result). Cover `\subfile{}` and `\import{dir}{file}` / `\subimport`, which many multi-file projects use instead. Paths resolve relative to the project root (Overleaf semantics), then relative to the including file. Skip directives inside `%` comments (the section parser already does this; reuse it). Detect cycles (`INCLUDE_CYCLE`, listing the chain) and cap depth (`INCLUDE_DEPTH_EXCEEDED`). A missing target is reported under `unresolved`, not thrown. A target that is a binary `file` rather than a `doc` is skipped and reported.

### Tools

```ts
get_full_document({ projectId: string, rootFilePath?: string, maxDepth?: number /* default 10 */ })
  → {
      text: string,                 // flattened, latexpand-style
      sourceMap: [{ flattenedStart, flattenedEnd, filePath, docId, originalStart, originalEnd, revision }],
      files: string[],              // every file visited, in order
      unresolved: [{ file: string, line: number, target: string }]
    }
  // rootFilePath defaults to the project root doc. Each source-map entry carries the per-file
  // revision so an edit decided on in the flattened view can be routed back through write_file
  // or write_section with the correct revision for that file.
  // annotations: readOnlyHint true
```

- **Extend `get_sections` / `get_section_content` / `write_section` with `followIncludes?: boolean`** (default `false`), built on `get_full_document`. Every section then carries `filePath`, and `sectionId` encodes the file so `write_section` stays single-file underneath. **Writes are always applied per file** through the normal revision-checked `write_file` path using the source map; never write a flattened blob back. A section whose heading and body straddle a file boundary is reported with `spansFiles: true` and refused by `write_section` with a clear `INVALID_ARGUMENT` rather than partially written.

Keep the honesty pattern: update the "never follows `\input`" sentence to say exactly what is and is not followed; do not delete it.

### Tasks

- [x] `\input` / `\include` / `\subfile` / `\import` scanner with comment stripping and cycle detection; unit tests including nested and cyclic fixtures. Landed in `src/core/includes.ts`, reusing the section parser's masking; it also covers the unbraced `\input file`, `\inputfrom`, `\includefrom`, and their `sub` forms, and takes only a `\subfile`'s document body.
- [x] Source-map builder and a `flatRange → (file, fileRange)` lookup helper (`mapFlattenedRange`). Each `unresolved` entry also carries a `reason` (`missing`, `binary_file`, `macro_argument`, `excluded_by_includeonly`), and the result adds `rootFilePath` and, when set, `includeOnly`.
- [x] `followIncludes` plumbing in the three section tools; write-back via `read_file` → `write_file` per touched file. Section ids name the file (`path#command:offset`); a section whose heading is in an included file ends at the latest where that file ends, and the revision is checked against the section's file before the section is looked up.
- [x] Keep `get_sections`' "does not follow `\input` by default" wording; it is still true by default.
- [x] Contract entries for `get_full_document` (`overleaf-read`) and `followIncludes` on the three section operations; `INCLUDE_CYCLE` and `INCLUDE_DEPTH_EXCEEDED` in `ERROR_CODES`; `TOOL_NAMES`, the README counts, the tool table, and `docs/tools.md` updated.

### Acceptance

- A project split across `\input`s is section-browsed and section-edited with `followIncludes: true` exactly like a single-file project.
- An edit chosen in the flattened view lands in the correct `(file, lineRange)` and goes through a revision check (test: concurrently bump the target file's revision → `REVISION_CONFLICT`, nothing written).
- A deliberate `\input` cycle returns `INCLUDE_CYCLE`; a missing target appears in `unresolved`, not as an exception.
- `overleaf-web-mcp schema get_full_document --output` prints a JSON Schema whose properties include `sourceMap`, and `overleaf-web-mcp call get_full_document` prints the same object the tool returns as `structuredContent`.

---

## v1.0.0 — Hardening and compatibility

**Motivation:** this wraps undocumented private endpoints, as the README says. At 1.0 the highest-leverage investment is making failure modes legible and the protocol surface complete, not adding tools. A SemVer commitment also needs a read-only check of an install and an Overleaf instance (`doctor`, backend capabilities) and evidence from real clients on each protocol version answered (a compatibility matrix). And `openProjectConnection` turns every `connectionRejected` but a rate-limited join (`RATE_LIMITED` since v0.8.0) into `AUTH_EXPIRED`, which agents are told to stop on, even for rejections that do not mean an invalid session *(verify in code)*.

### Error taxonomy (complete list; each is a typed `code` on the error, through every interface)

| Code | Introduced | Meaning |
| --- | --- | --- |
| `AUTH_EXPIRED` | 0.1.0 | No saved session, or Overleaf no longer accepts it |
| `PERMISSION_DENIED` | 0.1.0 | HTTP 403, which on the zip download (v0.4.1) can also be an expired session; from v0.8.0 also an access level that cannot decide tracked changes |
| `NOT_FOUND` | 0.1.0 | Project, path, resource, or (v0.8.0) tracked change does not exist (covers the first draft's `ENTITY_NOT_FOUND`) |
| `REVISION_CONFLICT` | 0.1.0 | `write_file` / `write_section` revision no longer matches, or a verified result differs from the intent (`details.outcome: "unknown"`) |
| `PROTOCOL_UNSUPPORTED` | 0.1.0 | Collaboration protocol or response shape this release does not understand; from v0.4.1 a project download that is not a zip archive; from v0.5.0 a body that is not JSON; from v0.8.0 a tracked write that landed untracked (`details.kind: "applied_untracked"`) |
| `DOC_TOO_LARGE` | 0.1.0 | Document would exceed `OVERLEAF_MAX_DOC_LENGTH` |
| `UPDATE_TOO_LARGE` | 0.1.0 | Single update exceeds `OVERLEAF_MAX_UPDATE_CHARS`, or HTTP 413, or (v0.8.0) the matching socket error |
| `TIMEOUT`, `OUTCOME_UNKNOWN` | 0.1.0 | Timed-out request; timed-out write whose outcome could not be observed |
| `COMPILE_FAILED` | 0.1.0 | Compile finished without a usable build; from v0.6.0 `failure` returns a summary instead, and details are `{ status, rootFilePath, buildId?, buildRef? }` only |
| `PARTIAL_CLEANUP` | 0.1.0 | A multi-step operation could not undo every step |
| `INVALID_ARGUMENT` | 0.1.0 | Malformed call, wrong entity type (covers the first draft's `NOT_A_DOC`), rejected name; from v0.5.0 an id that is not path-safe |
| `REMOTE_ERROR` | 0.1.0 | Anything else; from v0.4.1 also a project download cut short before its zip end record (retryable) |
| `CONFIRMATION_MISMATCH` | v0.2.0 | `confirmPath` / `confirmName` / `confirmCount` / `confirmDeleteCount` wrong; from v0.4.1 an existing `localPath` without `overwrite: true` on `download_project_zip`; from v0.5.0 an explicit `overwrite: false` on an existing binary; from v0.6.0 an omitted `overwrite` there, a missing required `planToken` (`details.missing`), or an existing `localPath` without `overwrite: true` on `download_compile_output`; from v0.8.0 a missing `confirmCount` on `manage_tracked_changes` |
| `RATE_LIMITED` | v0.2.0 | HTTP 429; `details.retryAfterMs` when Overleaf said how long; from v0.8.0 also a project join Overleaf refused as rate-limited (`details.reason: "join_rate_limited"`) |
| `REMOTE_DRIFT` | v0.4.0 | The project or the local folder differs from the `planToken` snapshot, or an entity changed just before its delete or, from v0.5.0, its replacement (`expectedHash`) |
| `PATH_OUTSIDE_ROOT` | v0.4.0 | A symbolic link in `localFolderPath` resolves outside it; from v0.5.0 any local path outside the allowed roots (`details.kind`) |
| `POLICY_DENIED` | v0.5.0 | The access policy does not allow this project or effect; nothing was sent |
| `COMPILE_RATE_LIMITED`, `COMPILE_TIMEOUT` | v0.6.0 | Compile throttled by Overleaf; compile timed out |
| `COMPILE_UNAVAILABLE` | v0.6.0 | Overleaf's compile service is unavailable or in maintenance; retryable |
| `NO_BUILD`, `BUILD_NOT_FOUND` | v0.6.0 | No compile known to this process / CLSI output evicted |
| `REVIEW_UNSUPPORTED` | v0.8.0 | Tracked-change review is not available (`details.kind`: `feature_disabled`, `route_unavailable`, `document_protocol`); nothing changed |
| `INCLUDE_CYCLE`, `INCLUDE_DEPTH_EXCEEDED` | v0.9.0 | `\input` graph problems |
| `API_SHAPE_CHANGED` | v1.0.0 | Response no longer matches the `docs/private-api.md` schema (the first draft called this `UNSUPPORTED_API_CHANGE`); subject to the decision task below |
| `TRANSIENT_FAILURE` | v1.0.0 | Network or 5xx after bounded backoff on a read was exhausted, or Overleaf asked the socket to retry |

### Tasks

- [ ] **Validate every private response at the boundary** with zod (compile since v0.6.0, tracked-change ranges since v0.8.0, the rest here), returning the shape-error code with details limited to `{ kind, endpoint, expectedKeys, receivedKeys }`. One route table, `src/overleaf/routes.ts`, is tested to equal `docs/private-api.md` and to send no body key a route does not accept.
- [ ] **Decide the shape-error code.** Prefer `PROTOCOL_UNSUPPORTED` with `details.kind` (`response_shape`, `socket_protocol`, `protocol_version`, `applied_untracked`) and drop `API_SHAPE_CHANGED`: `docs/private-api.md` already promises `PROTOCOL_UNSUPPORTED` for an unexpected shape, and no caller breaks. A separate code is announced one minor ahead.
- [ ] **Classify socket rejections** in `openProjectConnection` by upstream `code`, then message: invalid session → `AUTH_EXPIRED`; retry → `TRANSIENT_FAILURE`; not authorized → `PERMISSION_DENIED`; project not found → `NOT_FOUND`; too many requests → `RATE_LIMITED`; else `REMOTE_ERROR`, retryable for a disconnect before `joinProjectResponse` *(verify in code: the real-time service's codes and messages)*. In `OverleafRuntime.create`, a page with `ol-user_id` but no `ol-csrfToken` is `PROTOCOL_UNSUPPORTED`, not `AUTH_EXPIRED`.
- [ ] **retry with backoff for reads only.** Bounded exponential backoff (max 3 attempts, jitter) on `retryable: true` failures of GET requests and document joins, never on OT submissions, uploads, deletes, or state-changing POSTs, so the "never re-submitted automatically" guarantee survives. Centralise request pacing (configurable minimum interval). Exhausted backoff → `TRANSIENT_FAILURE`, exit 7 in `src/cli/exit-codes.ts` and `docs/cli.md` (`API_SHAPE_CHANGED`, if kept, exit 1).
- [ ] **Sanitized fixtures** under `test/fixtures/protocol` (`connectionRejected` and `otUpdateError` variants, a nested `joinProject`) and `test/fixtures/rest` (compile responses per status, the project list, uploads), fed through the real parsers; the v0.8.0 hygiene test and the AGENTS.md fixture rule extend to all of `test/fixtures`.
- [ ] **`overleaf-web-mcp doctor [projectId]`** (CLI only): read-only checks of the bootstrap meta and `/api/project`, plus, with a `projectId`, the handshake, `joinProject` and its `protocolVersion`, and a `joinDoc`/`leaveDoc` of the root document. It prints `{ checks: [{ id, status, code? }] }` without names or paths, exits 1 on any `unsupported`, never mutates, and its docs say a project check shows the account online.
- [ ] **Backend capabilities** as a `backend` key on the v0.7.0 `capabilities` report (`kind: "web-session"`, `liveRevisions`, `trackedWrites`, `review: { list, decide }`, `comments`, `compile`, `history`); an operation the backend cannot perform fails before any request.
- [ ] **MCP compatibility matrix.** In-memory tests cover both protocol eras, and `describe('stdio lifecycle')` in `test/server.test.ts` already drives `runStdioServer` over piped streams with a fake runtime, checking that stdout carries only JSON-RPC and that the server exits once stdin closes, for a 2025-11-25 client only. Extend it so a 2025-11-25 `initialize` and a 2026-07-28 `server/discover` each return `SERVER_INSTRUCTIONS` over those streams, and list in `docs/install.md` each MCP client checked by hand, with version, negotiated protocol, and date.
- [ ] **do not add cursor pagination to `list_projects`.** `/api/project` returns every project; v0.2.0's `query`, `limit`, `sort`, and `totalMatched` are the reasoned answer to the first draft's `cursor`.
- [ ] **MCP elicitation** for `manage_project` trash/delete, mirror `sync_directory`, and `manage_tracked_changes` when supported; confirm-by-value stays mandatory. On 2026-07-28, read `_meta["io.modelcontextprotocol/clientCapabilities"]` per request *(verify the v2 SDK accessor)*.
- [ ] **Resources** (`overleaf://project/{id}/tree`, `overleaf://project/{id}/file/{path}`, plus the v0.6.0 output resources) and **progress** for `compile_project` and `get_full_document`.
- [x] **Back-fill `outputSchema`** on every tool: moved to v0.7.0, where the CLI and SDK need it; the acceptance below still checks it.
- [ ] **automated smoke test against Community Edition**, never `www.overleaf.com` (the README's Terms-of-Service caution): on a pinned Docker image, `doctor <projectId>`, then `create_project → update_project_settings → plan_sync → sync_directory (with its planToken) → compile_project → download_compile_output → manage_project(trash)` through the MCP server and through `node dist/cli.js` (`sync plan`, then `sync apply --plan-token`), with equal results. Comments and tracked changes may be Server Pro features *(verify against the current Community Edition)*; their live tests stay manual.
- [ ] **README:** security model (cookie-jar permissions, stdout framing, no content logging, the limits of the access policy), ToS posture, and "what breaks when Overleaf changes".
- [ ] **schema stability commitment.** SemVer covers tool names, input schemas, result shapes, and error codes, plus the CLI's commands, flags, request format, output framing, and exit codes, the documented `overleaf-web-mcp/core` surface, and the capability report. Deprecations are announced one minor ahead with both names registered, and `CHANGELOG.md` records every change.
- [ ] **release checks.** Still to add to the publish workflow: the `npm pack --dry-run` file-list check from v0.1.3.

### Acceptance

- Every error surfaced through any interface carries one of the codes above; a mutated fixture (dropped key, wrong type, HTML or empty body) for `joinProject` and every REST route produces the decided shape-error code, never a stack trace.
- `list_projects` over a 127-project account answers "the ten most recently updated" and "anything containing Thesis" in one call each; no uncapped arrays remain.
- CI runs the full smoke path green against Community Edition on every pull request.
- `tools/list` shows annotations and an `outputSchema` on every tool.
- Socket rejections map as listed (a retry is retryable, never `AUTH_EXPIRED`; an early disconnect is never `OUTCOME_UNKNOWN`); a bootstrap page with `ol-user_id` and no `ol-csrfToken` yields `PROTOCOL_UNSUPPORTED`, and a redirect to `/login` still yields `AUTH_EXPIRED`.
- `doctor` with fakes exits 0 when all checks pass and 1 with check `joinProject.protocolVersion` `unsupported` for `protocolVersion` 3, sends no `applyOtUpdate`, and skips socket checks without a `projectId`.
- The sanitization and route-table tests pass, and every file under `test/fixtures` is referenced by a test.
- The stdio lifecycle test also serves a 2026-07-28 client, both eras receive `SERVER_INSTRUCTIONS` over stdio, and `docs/install.md` lists at least one client checked by hand, with its version and date.
- With a fake connection whose `features.trackChanges` is `false`, `capabilities` reports `review.decide: false`, and `manage_tracked_changes` fails with `REVIEW_UNSUPPORTED` before any request.
- An injected `TRANSIENT_FAILURE` exits 7 from an operation command.

---

## Explicitly out of scope (for now)

- A dedicated review of the comment and history tools (`add_comment`, `list_comments`, `reply_to_comment`, `set_comment_status`, `monitor_project_history`): not exercised in the reference session; worth its own pass from someone who has used the review workflow end to end. Listing, accepting, and rejecting tracked changes is not part of this exclusion; it is v0.8.0.
- Collaborator and sharing management, git-bridge parity, version diff and restore, billing, chat, background history watching, backward history pagination, label mutation, and editing or deleting individual comment messages. The "Current exclusions" list in `docs/development.md` stands.
- An HTTP service with an OpenAPI description, a Git backend, a WebMCP adapter, and an agent-to-agent (A2A) interface: triggers in **Interfaces beyond MCP**, not stages.
- Any surface that runs caller-supplied code with access to the saved session; serializing CLI invocations across processes; renaming the package, the repository, or the binary.

## Sequencing rationale

- **v0.1.3 first** because it was zero-risk and unblocked correct use of everything that existed. Two of its items were one-line changes with the best payoff-to-effort ratio in this document: surfacing `rootDocPath` in `get_project_tree` and correcting `upload_file`'s `destructiveHint`.
- **v0.2.0 before v0.4.0** even though sync produced more individual tool calls: the lifecycle gap was a **hard stop** that pulled a human into the loop mid-task, while the sync friction was merely tedious. Fix what blocks autonomous use before what is merely inefficient. The trash-first design is not only safer for agents; it is what lets v1.0.0's smoke test create and dispose of projects without a permanent delete anywhere in the automated path.
- **Session keepalive shipped alone as v0.3.0**, ahead of sync rather than with it or after hardening: it is a CLI-only change with no tool surface, it removes the one failure that presents as a dead server instead of a typed error, and bulk sync driven by a scheduler or a long-running agent is exactly the workload that outlives a five-day session.
- **v0.5.0, shared core and safety (L: contracts M, policy M), before any new interface.** A CLI or library built on today's MCP handlers would copy their shaping and inherit the optional-plan and blind-upload defaults. Moving first means every new interface starts strict, and the registry exists before v0.6.0 writes `compile_project`'s output schema into it.
- **v0.6.0, compile (M), before the CLI.** It closes a comparison gap cheaply, v0.7.0 exposes its tools for free, and it enforces the v0.5.0 defaults exactly one minor later.
- **v0.7.0, CLI, SDK, and Skills (L: CLI M, SDK S to M, Skills S).** The first workflow with no MCP client needs both the contracts and the strict defaults; Skills only call the CLI's public commands.
- **v0.8.0, tracked-change review (L), after the CLI.** Its operations are defined once in the contracts, its upstream verification could take time without blocking anything, and it landed before v1.0.0 so `REVIEW_UNSUPPORTED` and the range shapes join the taxonomy and boundary validation.
- **v0.9.0, multi-file (M), last before 1.0.** `\input` flattening was the most novel item and was self-contained, so it could slip without hurting the core zero-to-PDF story.
- **v1.0.0, hardening and compatibility (M), last**, because `doctor`, backend capabilities, and the compatibility matrix describe every interface.
- **Conditional interfaces are not stages.** An HTTP service (L), a Git backend, WebMCP, or A2A each needs a real consumer first; built speculatively, it adds a surface to keep safe without reducing the upstream risk.
- **Annotations and `outputSchema` are not deferred to 1.0.** Every new tool ships with them, v0.7.0 back-filled the rest, and v1.0.0 adds only the cross-cutting protocol features (elicitation, resources, progress).

## Competitive position this roadmap targets

| Capability | v0.9.0 (today) | After roadmap | `olcli` | `@netique/overleaf-mcp` | Git-bridge MCPs |
| --- | :---: | :---: | :---: | :---: | :---: |
| Works on a free plan | ✅ | ✅ | ✅ | ✅ | ❌ (paid) |
| Create / clone / import / rename / trash project, set root | ✅ | ✅ | create and rename only | ❌ | partial |
| Filtered `list_projects` | ✅ | ✅ | ❌ (lists, no search) | ✅ | ❌ |
| Dry-run diff + safe mirror sync + ignore rules | ✅ | ✅ (plan required since v0.6.0) | folder diff; rest re-check | ❌ | via git |
| Typed compile summary + PDF/log download | ✅ v0.6.0 | ✅ v0.6.0 | compiles, no log; PDF re-check | summary + log, no PDF | varies |
| Full workflow without an MCP client | ✅ v0.7.0 (CLI and library) | ✅ v0.7.0 (CLI and library) | ✅ (CLI and library) | ❌ (login only) | via git |
| Tracked changes as suggestions | ✅ | ✅ | ❌ | ✅ | ❌ (bypassed) |
| Accept or reject tracked changes | ✅ v0.8.0 | ✅ v0.8.0 | partial (accepts; rejects on ShareJS documents only, since 0.15.0) | ✅ | ❌ |
| `\input`/`\include` flattening with source map | ✅ v0.9.0 | ✅ v0.9.0 | re-check | ❌ | ❌ |
| Comments + version history | ✅ | ✅ | comments only | comments only | git log |

The differentiator: **autonomous zero-to-compiled-PDF on a free account, tracked-change- and revision-safe, with safe bulk sync, review decisions, and multi-file awareness, from an MCP client, a shell, or a TypeScript program.** No existing tool covers that combination. A command line alone is not the difference, since `olcli` already has one; the same revision, plan, and policy checks behind every interface are. Review decisions may need a paid plan on `www.overleaf.com` *(verify live)*; the zero-to-PDF workflow does not. Re-check competitors before each release (last done on 25 October 2026 for v0.7.0: `olcli` 0.15 added tracked-change accept and a partial reject, which makes v0.8.0's history-ot reject a difference); if a peer ships sync or PDF download first, lean harder on sync safety and `\input` flattening.
