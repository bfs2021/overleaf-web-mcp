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
  `--progress` asked for JSON progress lines. `login` keeps its plain-text status lines on stderr.
  Diagnostics go to stderr as JSON, and only `src/cli.ts` writes them: `src/cli/` writes through
  the `CliIo` streams it is handed.
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
- A tightened safety default is announced one minor version ahead and enforced in the next: the
  announcing minor keeps the old behaviour, adds a `deprecations` entry
  `{ parameter, message, enforcedIn }` to the result and a `Deprecated` entry to `CHANGELOG.md`
  naming the enforcing version, and the next minor enforces it under `Changed`. New interfaces
  start strict.
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
  `overleaf-web-mcp/core` surface `docs/sdk.md` lists as stable. Any change is listed in
  `CHANGELOG.md` under the next version.
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
- `test/skills.test.ts` parses every command line in `skills/*/SKILL.md` against the CLI parser
  and refuses any mention of `@modelcontextprotocol`, `src/`, or the cookie jar.

## Documentation

- `README.md` is for people. Keep it short and plain, and link to the site for detail.
- Reference material lives in `docs/*.md`. `docs/roadmap.md`, `docs/changelog.md`, and
  `docs/contributing.md` include the root `ROADMAP.md`, `CHANGELOG.md`, and `CONTRIBUTING.md`
  through snippets; edit the root files, and use absolute
  URLs for cross-links inside them so they work on GitHub, npm, and the site.
- Tool descriptions in `src/contracts/operations.ts` must be self-sufficient. That text, plus
  `src/mcp/instructions.ts`, is what an agent actually reads at runtime.
- `docs/cli.md` lists every command `renderHelp` prints, and `docs/sdk.md` names the stable
  `overleaf-web-mcp/core` surface; a test holds both.
- `skills/*/SKILL.md` use only commands `renderHelp` lists and name no assistant or model.

## Releasing

1. Update `CHANGELOG.md`. Set the same version in `package.json` (and `package-lock.json`, for
   example with `npm version X.Y.Z --no-git-tag-version`), `SERVER_VERSION` in
   `src/version.ts`, and both `version` fields of `server.json`. A minor release also moves the
   `npx --yes overleaf-web-mcp@X.Y` pin in `skills/*/SKILL.md`, `docs/cli.md`, and
   `test/skills.test.ts`, which fails until it matches.
2. Merge to `main` with CI green.
3. Run the `Publish to npm` workflow on `main` with the version (`workflow_dispatch`). It checks
   that the version matches `package.json` and has a `CHANGELOG.md` section, re-runs the checks
   and the packed file list check,
   publishes to npm with trusted publishing, lists the version in the MCP Registry from
   `server.json` with GitHub OIDC, then creates the `vX.Y.Z` tag and the GitHub Release with that
   section as its notes. Publishing a GitHub Release with tag `vX.Y.Z` by hand still
   works and runs the same checks and publish.
4. The docs site redeploys on its own from `main`.

## Style

- Commit subjects use a conventional prefix (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`) and plain
  wording. No attribution trailers.
- Prettier formats the TypeScript and JavaScript (`.prettierrc.json`); run `npm run format` before
  committing. A pure reformat is listed in `.git-blame-ignore-revs`.
- Prefer small, verified changes. Comment the reason for a decision only where the code alone
  does not make it obvious.
