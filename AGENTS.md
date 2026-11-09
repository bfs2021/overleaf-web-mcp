# Working on overleaf-web-mcp

Guidance for coding agents, and people, contributing to this repository. Guidance for agents
*using* the server at runtime lives in `src/mcp/instructions.ts` and is sent to MCP clients when they
connect, in the `initialize` result on 2025-era protocol versions and in the `server/discover`
result on 2026-07-28. Agents using the command line read `overleaf-web-mcp --help` (`renderHelp`
in `src/cli-command.ts`), `docs/cli.md`, and the Agent Skills in `skills/*/SKILL.md`. Do not
duplicate any of it here.

## What this is

An unofficial MCP server, command line, and TypeScript library for Overleaf. Strict TypeScript,
ESM, Node 20 or newer. It talks to
Overleaf's private browser-facing REST endpoints and its Socket.IO 0.9 / OT collaboration protocol
through a saved web session. Source is under `src/`, tests under `test/` (vitest), and the
documentation site under `docs/` (MkDocs Material, deployed to GitHub Pages from `main`).

Every operation is defined once in `src/contracts/operations.ts`: schemas, description,
annotations, and effects. `src/service/operations.ts` shapes arguments for the domain engine
(`src/overleaf/`, `src/protocol/`, `src/http/`), and three adapters sit over that service:
`src/mcp/`; `src/cli/`, which parses arguments and requests with the contract schemas
(`parseOperationInput` in `src/contracts/parse.ts`), refuses unknown keys, renders the result, and
maps errors to exit codes; and `createOverleafClient` in `src/client.ts`. The Agent Skills in
`skills/` call only public CLI commands. `src/sdk.ts` is the `overleaf-web-mcp/core` entry and
must never load the MCP SDK; `src/cli.ts` imports `src/server.ts` lazily, only for `serve`, so an
operation command never loads it either.

## Commands

```bash
npm install
npm run check        # tsc --noEmit
npm run lint         # eslint
npm run format:check # prettier; npm run format rewrites the files
npm test             # vitest, no network needed
npm run build        # emits dist/
npx tsx scripts/check-pack.ts  # after a build: checks the published file list, the three skills/*/SKILL.md included
```

CI runs all of these on Node 20 and 24 for every push and pull request. For the docs site,
`pip install mkdocs-material` then `mkdocs serve` from the repository root.

## Rules that must keep holding

- Never log or return cookies, document content, diffs, filenames, quoted context, or review
  message bodies. Under `serve`, stdout carries MCP protocol frames only. `help` prints plain text.
  Every other command, `login`, `keepalive`, and every operation command, prints exactly one JSON
  value on stdout. A failed operation command leaves stdout empty and writes exactly one stderr
  line, `{ code, message, retryable, details? }`; otherwise its stderr stays empty unless
  `--progress` asked for JSON progress lines. `doctor` is the one exception: its report is its
  result, printed on stdout with stderr empty even when a check fails and it exits 1. `login`
  keeps its plain-text status lines on stderr.
  Diagnostics go to stderr as JSON, and only `src/cli.ts` writes them: `src/cli/` writes through
  the `CliIo` streams it is handed.
- Nothing runs caller-supplied code with access to the saved session: no eval, script, or plugin
  surface, through any interface.
- Writes are never retried automatically, by any interface: the CLI and the SDK add no retry, and
  exit 5 means never re-run. A timed-out write is observed and classified as applied,
  not applied, or conflict. It is never resubmitted.
- Every OT write is verified against a freshly joined document before a revision is returned.
- Explicit tracked writes never fall back to untracked writes.
- Destructive tools take a confirm-by-value parameter (`confirmPath`, `confirmName`,
  `confirmCount`, `confirmDeleteCount`, `overwrite`, `onConflict`) or an expected state (a
  `revision`, a `planToken`, an `expectedHash`), and are annotated `destructiveHint: true`.
  `stop_compile` is the one destructive tool without a confirm value. A mutation that applies
  with no expected state at all is asked for by name, and `unplanned` and
  `uncheckedDocumentReplace` are the only such opt-ins. No CLI flag supplies a confirm value on
  the caller's behalf: there is no `--yes` or `--force`, and no command prompts.
- A tightened safety default is announced before it is enforced. The announcing minor release
  keeps the old behaviour, adds a `deprecations` entry `{ parameter, message, enforcedIn }` to the
  result (`addDeprecation` in `src/contracts/deprecations.ts`) and a `Deprecated` entry to
  `CHANGELOG.md` naming the enforcing version. No `outputSchema` declares `deprecations` today, so
  the announcing release first adds it to that operation's schema as an optional array of
  `{ parameter, message, enforcedIn }`, with the snapshot, golden results, and fixture output to
  match; otherwise MCP clients refuse the result. Once declared, the key stays until a major
  release. Since 1.0.0, refusing a call that used to work is a
  breaking change, so it is enforced in the next major release, under `Changed`; before 1.0.0 it
  was enforced one minor later. New interfaces start strict.
- Every public method of the domain engine checks the access policy (`src/core/policy.ts`) for
  its project and each effect it performs before any request, so the exported runtime is held to
  the same rules as a tool call. Ids interpolated into a request path are path-safe and
  URI-encoded.
- Bulk and sync tools are compositions of the existing primitives, never parallel
  implementations. `sync_directory` runs every upload and write before any delete, never deletes
  after a failure, replaces documents only through revision-checked writes, and with a
  `planToken` changes nothing when either side drifted from the plan.
- Overleaf responses are private API shapes. Error `details` may carry short identifiers from
  them, never response bodies, and messages never quote upstream text: socket errors map to a
  known `details.reason` or `unrecognized`.
- Only `src/mcp/`, `src/server.ts`, `src/cli.ts`, and `src/index.ts` import the MCP SDK or the
  adapter; ESLint enforces it, type imports included.
- Tool names, input schemas, result shapes, and error codes are the public contract, and so are
  the CLI's command names, flags, request format, output framing, and exit codes, and the
  `overleaf-web-mcp/core` surface `docs/sdk.md` lists as stable, and the `capabilities` report.
  Any change is listed in `CHANGELOG.md` under the next version.
- Every result validates against its operation's `outputSchema` on every return path and carries
  no key the schema does not declare. zod drops an undeclared key without failing, so the
  service's check of read-only results does not catch one, yet `tools/list` advertises
  `additionalProperties: false` and an MCP client refuses the result.

## Tests

- Unit tests must pass offline. Protocol fixtures under `test/fixtures/protocol` are sanitized;
  keep them free of cookies, user data, IDs, and document content.
- Live tests are opt-in with `RUN_OVERLEAF_LIVE_TESTS=1` and must target a disposable project
  the maintainer owns. Never point them at a real manuscript.
- `test/mcp/tools.test.ts` asserts the README badge, every "All N tools", the comparison's Tools
  cell, and `docs/tools.md` agree with `TOOL_NAMES`. Update them when adding or removing a tool.
- `test/server.test.ts` compares `tools/list` with `test/__snapshots__/list-tools.json`. Update the
  snapshot (`npx vitest run -u`) only for a change listed in `CHANGELOG.md`.
- The golden tests in `test/golden/` (with `test/helpers/golden.ts`) snapshot tool results taken
  through the real domain classes. Update them only for a result change listed in `CHANGELOG.md`.
- `test/contracts/operations.test.ts` checks annotations against effects and that every
  destructive operation takes a confirm value or an expected state.
- `test/server.test.ts` asserts the server instructions are present, bounded in length, and
  delivered on both protocol eras (`initialize` and `server/discover`).
- `test/overleaf/sync.test.ts` drives folder sync against an in-memory project. Keep its
  fault-injection, drift, and mid-sync edit cases passing when changing sync.
- `test/cli/exit-codes.test.ts` and `test/cli/run.test.ts` hold the exit-code table over every
  error code, from a read and from a write, and the output framing; an unknown request key exits
  2 before any session is opened. `test/cli-command.test.ts` stays unchanged.
- `test/parity.test.ts` runs every tool through MCP, the CLI, and the SDK client and expects the
  same result and the same error object from each.
- `test/cli/docs.test.ts` asserts every `operationCommandUsages()` line and every exit code appear
  in `docs/cli.md`, both new pages are in the `mkdocs.yml` nav, and every name `docs/sdk.md` lists
  as stable is exported from `src/sdk.ts`.
- `test/docs-versions.test.ts` checks that every `<!-- md:version X.Y.Z -->` tag in `docs/*.md`
  names a release with a `## [X.Y.Z]` heading in `CHANGELOG.md`, and that every tool heading,
  command, variable, error code, and stable export carries one.
- `test/skills.test.ts` parses every command line in `skills/*/SKILL.md` against the CLI parser
  and refuses any mention of `@modelcontextprotocol`, `src/`, or the cookie jar.

## Documentation

- `README.md` is for people. Keep it short and plain, and link to the site for detail.
- Reference material lives in `docs/*.md`. `docs/changelog.md` and `docs/contributing.md`
  include the root `CHANGELOG.md` and `CONTRIBUTING.md` through snippets; edit the root files,
  and use absolute
  URLs for cross-links inside them so they work on GitHub, npm, and the site.
- Tool descriptions in `src/contracts/operations.ts` must be self-sufficient. That text, plus
  `src/mcp/instructions.ts`, is what an agent actually reads at runtime.
- `docs/cli.md` lists every command `renderHelp` prints, and `docs/sdk.md` names the stable
  `overleaf-web-mcp/core` surface; a test holds both.
- `skills/*/SKILL.md` use only commands `renderHelp` lists and name no assistant or model.
- Every feature on the site carries a version tag, `<!-- md:version X.Y.Z -->`, which
  `overrides/hooks/shortcodes.py` renders as a badge linking to that release in the changelog;
  `mkdocs build` fails on a version without a `## [X.Y.Z]` heading. The tag goes on the line under
  a tool heading, in the `Since` column of the command, variable, error-code, and stable-export
  tables, and at the end of the Meaning cell for a parameter or value added after its tool
  shipped. `docs/versions.md` lists each release's additions.

## Conventions for new work

These held through every release so far; keep them.

- Tool names are snake_case `verb_noun` (`list_projects`, `manage_entity`), and parameters are
  camelCase. A tool name is also its command line and SDK name (`call read_file`,
  `client.readFile`), so naming one names all three.
- Every tool description costs an MCP client context on every turn. Prefer an `action` enum on an
  existing tool, as `manage_entity`, `manage_project`, and `manage_tracked_changes` do, to one new
  tool per verb. A check that needs no agent, such as `doctor` or `capabilities`, is a command line
  command, not a tool.
- An adapter parses, renders, and maps errors. It never shapes arguments, applies policy, or
  retries; that belongs in `src/service/` and below.
- A new interface (an HTTP service, WebMCP, another tool protocol, agent-to-agent) is a thin
  adapter over `src/service/`, built only for a named consumer recorded in an issue. A new backend
  (an official Overleaf API, Git) reports what it can do in the `backend` key of `capabilities`,
  is chosen explicitly, and is never swapped in silently; the web session stays until a
  replacement covers revision checks and tracked edits. The package, repository, and binary keep
  their names.
- Bulk tools are compositions over the per-project FIFO queue. They save calls and context, not
  wall-clock time; say so in the tool's description. The queue is per process, so revision checks
  and plan tokens, not the queue, protect two processes working on one project.
- Tokens are self-contained: revisions (`createRevision` in `src/core/revision.ts`), plan tokens,
  and `buildRef` carry everything a later call needs, so read-then-write and plan-then-apply work
  across processes with no daemon or state file. A new token follows suit.
- A tool description states its own limits outright, as `get_sections` did about `\input` before
  0.9.0. An agent reads only the description and `src/mcp/instructions.ts`.
- Error `details` hold status codes, short identifiers, counts, and values the caller supplied.
  A new failure kind goes in `details.kind` or `details.reason` on an existing code before it
  earns a new code. Outcomes use `details.outcome` (`not_applied`, `unknown`).
- Only reads are retried, below every interface, by `retryRead` (`src/core/retry.ts`): network
  failures, cut-off answers, and HTTP 5xx on a GET or a POST marked `read`, and project joins
  that failed before Overleaf answered. A new read that goes through POST passes `{ read: true }`.
- Every endpoint or socket message the code relies on is confirmed in Overleaf's own source
  (`overleaf/overleaf`, `services/web` and `services/real-time`) before it is used, and listed in
  `docs/private-api.md`. Anything not yet confirmed is marked *(verify in code)* in the issue or
  pull request until it is.

### Adding to the public surface

Each addition touches several files, and the tests fail until they agree.

- **An operation:** its entry in `src/contracts/operations.ts` (input and output schemas,
  description, annotations, effects) and its shaping in `src/service/operations.ts`. When it needs
  a new call to Overleaf, a domain method in `src/overleaf/` that checks the access policy before
  any request, listed in `OverleafServiceRuntime` (`src/contracts/service.ts`) and mocked in
  `test/helpers/fake-runtime.ts` and in the `fakeRuntime()` of `test/mcp/tools.test.ts` and
  `test/server.test.ts`; `npm run check` type-checks the tests and fails until they match. Then a
  fixture input and output in `test/helpers/operation-inputs.ts` and
  `test/helpers/operation-outputs.ts`, golden results under `test/golden/` (its area's file, or a
  new one), the `tools/list` snapshot, and `docs/tools.md`. Counts: the length in
  `test/contracts/operations.test.ts`; the no-project count in `test/policy-runtime.test.ts` when
  the operation takes no `projectId`; the README badge, both "All N tools", the comparison's Tools
  cell, and `docs/tools.md`, which `test/mcp/tools.test.ts` holds; and, held by no test, the
  README's "N tools in eight groups" and the opening line of `docs/cli.md`. A command line
  shorthand only if scripts will use it often. The SDK client and `call <tool>` derive their names
  from the operation, so they need nothing more.
- **An error code:** `ERROR_CODES` in `src/contracts/error-codes.ts`, its exit code in
  `src/cli/exit-codes.ts`, both exit tables in `test/cli/exit-codes.test.ts` and
  `test/cli/run.test.ts`, the exit-code table in `docs/cli.md`, the error table in
  `docs/safety.md`, and the `tools/list` snapshot.
- **An environment variable:** `readConfig` in `src/config.ts`, a test in
  `test/http/config.test.ts`, and the table in `docs/configuration.md`. A new `AppConfig` field
  is optional, because `AppConfig` is stable and callers build it by hand; the runtime applies the
  same default as `readConfig`.
- **A generic command:** its usage line in `GENERIC_USAGE` and its first word in
  `OPERATION_COMMAND_WORDS` (both in `src/cli/commands.ts`; without the word the command is
  treated as unknown), a parser and a `ParsedCommandLine` kind in `src/cli/parse.ts`, a case in
  `runOperationCommand` in `src/cli/run.ts`, tests in `test/cli/`, and `docs/cli.md`.
- **A shorthand:** an `ALIASES` entry in `src/cli/commands.ts` (usage, options, `build`; the
  parser picks it up), and its usage line and a row of the Commands table in `docs/cli.md`.
  `test/cli/docs.test.ts` holds `docs/cli.md` to the help for both kinds.
- **A `capabilities` field:** `CapabilitiesReport` and `buildCapabilities` in
  `src/cli/capabilities.ts`, the `capabilities` tests in `test/cli/run.test.ts`, and the
  `capabilities` section of `docs/cli.md`.
- **A stable SDK export:** `src/sdk.ts`, the stable table in `docs/sdk.md`, and the `PROMISED`
  list in `test/cli/docs.test.ts`, which is what fails if the export is later removed.

Each addition also gets a version tag with the next version on its page and an entry under that
version in `docs/versions.md` (see **Documentation**). Tagging against the `Unreleased` heading
is right: the anchor is read from `CHANGELOG.md` at build time, so the badge follows the heading
when the release is dated.

Every one of these is listed in `CHANGELOG.md` under the next version. That section opens with the
first change on a release branch, as a line `## [X.Y.Z] - Unreleased` at the top of the file,
under the header paragraph.

## Planning work

Planned work lives in [GitHub issues](https://github.com/mhmdaskari/overleaf-web-mcp/issues), one
per change, not in a roadmap file. An issue says what fails today, the design, and acceptance
criteria that can be checked mechanically: a test that passes, a command whose output or exit code
is stated, a live suite that runs green. A release is a set of those issues, built on one branch
named `release/<version>-<theme>` and merged in one pull request whose description says which
issues it closes, what was tested, and what was left out.

### Choosing the version

From 1.0.0 the project follows [Semantic Versioning](https://semver.org) over the public contract
listed under **Rules that must keep holding**.

- **Major:** anything that can break a caller who followed the docs. Removing or renaming a tool,
  parameter, result key, command, flag, or stable SDK export; making an optional parameter required
  or narrowing what it accepts; changing a result key's type; giving an existing failure a different
  error code or exit code, including moving one from `REMOTE_ERROR` to a more specific code;
  changing the output framing; enforcing a tightened safety default.
- **Minor:** additions a caller can ignore. A new tool, an optional parameter, a new result key, a
  new error code for a failure only a new tool, parameter, or command can produce, a new `details`
  key, a new command or flag, a new environment variable, a new stable export, and announcing a
  deprecation.
- **Patch:** fixes that bring behaviour back in line with the docs, documentation, and internal
  changes. A fix that changes an error code is a patch only when the old code contradicted the
  documentation; list it under `Fixed`.

When in doubt, it is the larger one.

### Before starting a release

The code moves on between releases. Check these before writing anything, and say in the pull
request what you found:

- `npm view overleaf-web-mcp version`, the latest `vX.Y.Z` tag, `package.json`, `SERVER_VERSION`
  in `src/version.ts`, and both `version` fields of `server.json` agree on the last release.
- The MCP SDK is still v2: `@modelcontextprotocol/server` 2.x in `dependencies`,
  `@modelcontextprotocol/client` 2.x in `devDependencies`, `npm ls @modelcontextprotocol/sdk`
  prints `(empty)`, and `npm ls zod @modelcontextprotocol/core` shows one copy of each. Note which
  MCP protocol versions the server answers and whether the SDK added one.
- `SERVER_INSTRUCTIONS` (`src/mcp/instructions.ts`) is under the 450-word bound in
  `test/server.test.ts`; it was 445 words at 1.0.0, so a release that adds guidance trims
  elsewhere.
- Every Overleaf route or socket message the release will touch is still in Overleaf's source as
  `docs/private-api.md` describes it.
- The comparison in the README was checked on the date it states; re-check the projects it names
  if that is more than a release ago.
- `overleaf-web-mcp doctor <projectId>` passes against a disposable project, so a live failure
  later is the release's own.

## Releasing

1. **Changelog.** Turn the next version's section of `CHANGELOG.md` from `Unreleased` into the
   version and date, with a short summary paragraph and the sections that apply, in this order:
   `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Documentation`, `Internal`. Every change
   to the public contract is listed, and each entry says what a caller sees, with codes, keys, and
   exit codes named. Write the date as `YYYY-MM-DD`: the publish workflow only checks that a line
   starting `## [X.Y.Z]` exists, so it accepts a heading still marked `Unreleased`.
2. **Version.** Set the same version in `package.json` and `package-lock.json` (for example
   `npm version X.Y.Z --no-git-tag-version`), `SERVER_VERSION` in `src/version.ts`, and both
   `version` fields of `server.json`. A major or minor release also moves the
   `npx --yes overleaf-web-mcp@X.Y` pin in `skills/*/SKILL.md`, `docs/cli.md`, and
   `test/skills.test.ts`, which fails until it matches.
3. **Documentation.** The pages that describe what changed agree with the code: `docs/tools.md`,
   the error table in `docs/safety.md`, the exit-code table in `docs/cli.md`, the variables in
   `docs/configuration.md`, `docs/private-api.md`, the stable surface in `docs/sdk.md`, and the
   README's tool table and counts. Every addition carries a version tag and is listed in
   `docs/versions.md`. Snapshots and golden results change only with a change the changelog
   lists.
4. **Offline checks.** `npm run check`, `npm run lint`, `npm run format:check`, `npm test`,
   `npm run build`, `npx tsx scripts/check-pack.ts`, and `mkdocs build --strict` all pass.
5. **Live tests.** Any release that changes code under `src/overleaf/`, `src/protocol/`,
   `src/http/`, `src/auth/`, `src/core/`, or `src/service/`, or in `src/runtime.ts`,
   `src/config.ts`, or `src/cli/doctor.ts`, runs the live suites (see `docs/development.md`)
   against a disposable project the maintainer owns: each file in its own run, after
   `npm run build`, with a minute between files for Overleaf's join limit. Check afterwards that
   every throwaway project is in the trash (`projects list --query mcp- --include-trashed`), and
   tell the maintainer to empty it; the suites never delete. A failure that comes from the
   account's plan, such as track changes being off, is reported, not patched around.
6. **Pull request.** The description says what changed, which issues it closes, which live suites
   ran and with what result, and what was left out. Read it back after creating it and remove any
   footer or link a tool added. Merge to `main` with CI green.
7. **Publish.** Run the `Publish to npm` workflow on `main` with the version
   (`workflow_dispatch`). It checks that the version matches `package.json` and has a
   `CHANGELOG.md` section, re-runs the checks and the packed file list check, publishes to npm
   with trusted publishing, lists the version in the MCP Registry from `server.json` with GitHub
   OIDC, then creates the `vX.Y.Z` tag and the GitHub Release with that section as its notes.
   Publishing a GitHub Release with tag `vX.Y.Z` by hand still works and runs the same checks and
   publish. A run that failed after npm can be re-run; it skips what is already published.
8. **After publishing.** `npm view overleaf-web-mcp version` shows the new version,
   `npx --yes overleaf-web-mcp@X.Y.Z --help` runs, the GitHub Release and tag exist, the MCP
   Registry job succeeded, and the docs site, which redeploys on its own from `main`, shows the
   new changelog section. Close the issues the release shipped, and open issues for what it left
   out.

## Style

- Commit subjects use a conventional prefix (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`) and plain
  wording. No attribution trailers.
- Prettier formats the TypeScript and JavaScript (`.prettierrc.json`); run `npm run format` before
  committing. A pure reformat is listed in `.git-blame-ignore-revs`.
- Prefer small, verified changes. Comment the reason for a decision only where the code alone
  does not make it obvious.
