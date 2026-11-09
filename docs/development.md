# Development

## Local verification

```bash
npm install
npm run check        # tsc --noEmit
npm run lint         # eslint
npm run format:check # prettier; npm run format rewrites the files
npm test             # vitest, no network needed
npm run build        # emits dist/
npx tsx scripts/check-pack.ts  # after a build: checks the published file list
```

Every push and pull request runs the same steps in CI on Node 20 and 24. Releases run them again
before publishing.

Unit and deterministic integration tests cover revision identity, Unicode positions, section
parsing, tracked and untracked OT operations, history normalization, update limits, queue and
cache behaviour, Socket.IO frames, timeout recovery, comment attachment, file-tree events, MCP
registration, progress notifications, and the server instructions on both MCP protocol eras. The
command line is tested for argument parsing, the exit code of every error code from a read and
from a write, output framing, and refusal of unknown request keys before any request; the SDK
client for one method per tool and strict input. `test/parity.test.ts` runs every tool through
an MCP client, which checks each `structuredContent` against the advertised `outputSchema` and
refuses an undeclared key, through the command line, and through the SDK client, and expects the
same result and the same error from each.
Folder sync is tested against an in-memory project: git blob hashes against `git hash-object`
values, ignore rules and symbolic links, plan comparison and folder collapsing, an upload failing
midway (no delete runs, and the returned token resumes), a remote or local change between plan and
sync (`REMOTE_DRIFT`, nothing applied), and a collaborator's edit during the sync
(`REVISION_CONFLICT` for that file only).

Other tests guard the shape of the code. `test/server.test.ts` compares `tools/list` with the
committed snapshot in `test/__snapshots__/list-tools.json`, so a change to a tool's name,
description, schema, or annotations shows up in review. The golden tests in `test/golden/`
(with `test/helpers/golden.ts`) record tool results taken through the real domain classes. Update
either snapshot with `npx vitest run -u` only for a change listed in `CHANGELOG.md`.
`test/contracts/operations.test.ts` checks every operation's annotations against its effects.
`test/cli/docs.test.ts` checks that [the command line page](cli.md) shows every command the help
prints and every exit code, and that [the SDK page](sdk.md) lists only names the package exports.
`test/skills.test.ts` parses every command in `skills/*/SKILL.md` against the help, one command
per line, checks every request example against its tool's input schema and every helper by
running it, refuses a project path on a command line or a double-quoted value, and refuses any
mention of the MCP SDK, `src/`, or the cookie jar. The access policy is tested through a real
runtime over an injected fetcher and connection factory, counting requests, and error
sanitization by feeding a sentinel string through every upstream channel and checking no
serialized error holds it.

## Layout and boundaries

`src/contracts/` defines every operation once, `src/service/` shapes arguments for the domain
engine in `src/overleaf/`, `src/protocol/`, and `src/http/`, and three adapters sit over the
service: `src/mcp/`, the command line in `src/cli/`, and `createOverleafClient` in
`src/client.ts`; the [internals page](internals.md#layers) describes the layers. ESLint enforces
the boundary: only `src/mcp/`, `src/server.ts`, `src/cli.ts`, and `src/index.ts` may import the MCP
SDK or the adapter, type imports included, so `src/cli/` and `src/sdk.ts`, the
`overleaf-web-mcp/core` entry, work without it. `src/cli.ts` imports `src/server.ts` only for
`serve`, so an operation command never loads the MCP SDK. `console` is refused everywhere in
`src/`, and `process.stdout` and `process.stderr` outside `src/cli.ts` and `src/server.ts`;
`src/cli/` writes through the `CliIo` streams `src/cli.ts` hands it. CI imports both built entry
points by package name after the build.

## Live tests

Live tests are disabled by default and must target a disposable project you own:

```bash
RUN_OVERLEAF_LIVE_TESTS=1 \
OVERLEAF_LIVE_TEST_PROJECT_ID=0123456789abcdef01234567 \
npm test -- test/live
```

Add `RUN_OVERLEAF_LIVE_REVIEW_TESTS=1` for review reads,
`RUN_OVERLEAF_LIVE_TRACKED_WRITE_TESTS=1` for a disposable tracked file create and delete,
`RUN_OVERLEAF_LIVE_HISTORY_TESTS=1` for read-only history normalization, or
`RUN_OVERLEAF_LIVE_LIFECYCLE_TESTS=1` to create a throwaway project named `mcp-lifecycle-<time>`,
set its root document, compile it once, and trash it, or
`RUN_OVERLEAF_LIVE_SYNC_TESTS=1` to create a throwaway project named `mcp-sync-<time>`, mirror a
temporary local folder into it with `plan_sync` and `sync_directory`, check that a second plan
finds nothing to do, and trash it.

`RUN_OVERLEAF_LIVE_TRACKED_REVIEW_TESTS=1`, with `RUN_OVERLEAF_LIVE_TESTS=1`, needs no project id:
it runs `test/live/tracked-review-live.test.ts` on a throwaway project it creates, named
`mcp-tracked-review-<time>`, and trashes afterwards. It writes tracked changes and checks that
`list_tracked_changes` lists them with the account's own user id as `authorId`; that rejecting an
insert restores the original text; that accepting a tracked replacement in a second file keeps the
new text and empties the listing; that both halves of a tracked replacement, on non-ASCII text, are
listed as a pair and rejected in one call; that a tracked write changing two separated words in
one line lists two inserts and two deletes, each insert paired with its delete, and that
rejecting all four restores the original; that `add_comment` on non-ASCII text verifies and
`list_comments` quotes it exactly; that a comment keeps its whole words through a tracked and then
an untracked typo fix inside them, the tracked fix recorded as only the swapped letters; and that a
tracked word change inside the account's own tracked sentence merges into that one insertion, which
rejecting removes. New documents in a new project use ShareJS today, so history-OT
decisions run only if Overleaf created the documents as history-OT; otherwise that test is skipped.
It never looks at any other project.

```bash
RUN_OVERLEAF_LIVE_TESTS=1 RUN_OVERLEAF_LIVE_TRACKED_REVIEW_TESTS=1 \
npm test -- test/live/tracked-review-live.test.ts
```

Two more live files drive the built package, so run `npm run build` first, and run each on its own
path:

```bash
npm run build
RUN_OVERLEAF_LIVE_TESTS=1 RUN_OVERLEAF_LIVE_CLI_TESTS=1 npm test -- test/live/cli-live.test.ts
RUN_OVERLEAF_LIVE_TESTS=1 RUN_OVERLEAF_LIVE_COMPARE_TESTS=1 npm test -- test/live/compare-interfaces.test.ts
```

`test/live/cli-live.test.ts` drives `node dist/cli.js` alone, from `call create_project` through
`files write`, `sync apply --plan-token`, and `compile run`, to a trash of the throwaway project it
named `mcp-cli-<time>`. `test/live/compare-interfaces.test.ts` creates a throwaway project named
`mcp-compare-<time>`, runs four tasks on it (revise one section, sync figures and sources, diagnose
a failed build, and resolve a review task: a comment thread, then a tracked change written and
rejected) through a spawned `serve`, `node dist/cli.js`, and the SDK, each cold and warm, then
trashes it. Every task must succeed through every interface, with the same outcome. Before each
interface's runs it waits a minute, untimed, because Overleaf allows one account 45 joins of one
project a minute, so the whole suite takes about a quarter of an hour. It writes a JSON report to
`OVERLEAF_LIVE_COMPARE_REPORT`, by default a file in the system temp folder whose path the test
prints.

None of these tests deletes a project permanently; remove the trashed project by hand from the
web UI's Trashed view. Feature availability depends on the deployment and account. Keep request
volume low and treat cleanup failures as test failures.

## Documentation site

The site is built with [MkDocs Material](https://squidfunk.github.io/mkdocs-material/) from
`docs/` and deployed to GitHub Pages by the `Docs` workflow on every push to `main` that touches
the docs, `CHANGELOG.md`, or `CONTRIBUTING.md`.

```bash
pip install mkdocs-material
mkdocs serve          # live preview at http://127.0.0.1:8000
mkdocs build --strict # what CI runs; broken links fail the build
```

`docs/changelog.md` and `docs/contributing.md` include the root `CHANGELOG.md` and
`CONTRIBUTING.md` through snippets, so edit the root files. Use absolute URLs for cross-links inside them so they
work on GitHub, npm, and the site alike.

## Download badge

The npm count badge (labelled `installs`) in the README and on the site's home page reads `npm-downloads.json` from
the `badges` branch through a shields.io endpoint badge. The `Download count` workflow
(`.github/workflows/download-count.yml`) refreshes it every day and can be run by hand: it runs
`scripts/npm-downloads.ts`, which sums the package's all-time downloads from npm's downloads API,
and replaces the branch's only commit when the number changed. npm cuts any range longer than 18
months to its last 18 months without saying so, so the script asks for one year at a time from
the day the package was created and fails, leaving the badge as it was, if an answer covers less
than it asked for. Never commit to the `badges` branch by hand; the next run replaces it.

```bash
node scripts/npm-downloads.ts /tmp/npm-downloads.json   # Node 22.18 or newer runs it directly
```

## Releasing

1. Update `CHANGELOG.md`. Set the same version in `package.json` and `package-lock.json`, for
   example with `npm version X.Y.Z --no-git-tag-version`, in `SERVER_VERSION` in
   `src/version.ts`, and in both `version` fields of `server.json`. A minor release also moves the
   `npx --yes overleaf-web-mcp@X.Y` pin in `skills/*/SKILL.md`, `docs/cli.md`, and
   `test/skills.test.ts`, which fails until it matches.
2. Merge to `main` with CI green.
3. Publish, in either of two ways. Both run the `Publish to npm` workflow, which checks that the
   tag equals the package version and that `CHANGELOG.md` has a section for it, re-runs check,
   lint, the format check, test, and build, checks the packed file list, and publishes to npm with trusted publishing. No npm token is stored in
   the repository.
    - **From the Actions tab:** run `Publish to npm` on `main` with the version, for example
      `0.4.0` (or `gh workflow run publish.yml --ref main -f version=0.4.0`). After publishing, it
      creates the `vX.Y.Z` tag on the published commit and the GitHub Release, titled `vX.Y.Z`,
      with that version's `CHANGELOG.md` section as its notes.
    - **From a GitHub Release:** create a Release with tag `vX.Y.Z` yourself; publishing it starts
      the workflow on that tag.

    Once the package is on npm, the workflow also publishes `server.json` to the
    [MCP Registry](https://registry.modelcontextprotocol.io), signing in with GitHub OIDC.

    Re-running a publish that already reached npm skips the upload, and one already in the MCP
    Registry skips that too, so a run that failed after publishing can be re-run to create
    whatever is missing.

## For coding agents

[`AGENTS.md`](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/AGENTS.md) in the
repository root states the rules that must keep holding, the test expectations, and the release
steps in a form meant for an agent working on the code. `CLAUDE.md` imports it for Claude Code.
The Agent Skills in `skills/` are a different audience: they are for agents using the published
package, and ship in it.

## Current exclusions

Git workflows, collaborator and sharing administration, account and billing settings, chat,
background history watching, backward history pagination, version diffs and restoration, label
mutation, and editing or deleting individual comment messages are outside the current release. Private API
compatibility is version-specific and maintained on a best-effort basis. Planned work is tracked
in [GitHub issues](https://github.com/mhmdaskari/overleaf-web-mcp/issues).
