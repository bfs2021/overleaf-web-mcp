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
npm test -- test/live/overleaf-live.test.ts
```

Run each file in its own `npm test` run, and wait a minute between files: Overleaf allows one
account 45 joins of one project a minute. Run `npm run build` first, so the files that drive the
built package test the current code. `OVERLEAF_LIVE_TEST_PROJECT_ID` is needed only by
`overleaf-live.test.ts`; a project made for it with `call create_project` and trashed afterwards
will do.

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

## Planning and versioning

Planned work is tracked in [GitHub issues](https://github.com/mhmdaskari/overleaf-web-mcp/issues),
one per change, each with acceptance criteria that can be checked mechanically: a test that
passes, a command whose output or exit code is stated, or a live suite that runs green. A release
gathers a set of them on one branch named `release/<version>-<theme>` and merges in one pull
request.

From 1.0.0 the project follows [Semantic Versioning](https://semver.org). The public contract is
the tool names, input schemas, result shapes, and error codes; the command line's commands, flags,
request format, output framing, and exit codes; the stable `overleaf-web-mcp/core` surface
[the SDK page](sdk.md) lists; and the `capabilities` report.

| Release | What it may contain |
| --- | --- |
| Major | Anything that can break a caller who followed the docs: a removed or renamed tool, parameter, result key, command, flag, or stable export; a parameter made required or narrowed; a result key's type changed; a failure given a different error code or exit code, including one moved from `REMOTE_ERROR` to a more specific code; changed output framing; an enforced safety default. |
| Minor | Additions a caller can ignore: a tool, an optional parameter, a result key, a new error code for a failure only a new tool, parameter, or command can produce, a `details` key, a command or flag, an environment variable, a stable export, and a deprecation announced. |
| Patch | Fixes that bring behaviour back in line with the docs, documentation, and internal changes. A fix that changes an error code is a patch only when the old code contradicted the docs, and is listed under `Fixed`. |

When in doubt, it is the larger one.

A tightened safety default is announced in a minor release, which keeps the old behaviour, adds a
`deprecations` entry to the affected result (declared in that operation's `outputSchema`) and a
`Deprecated` entry to the changelog naming the enforcing version, and is enforced in the next
major release. [AGENTS.md](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/AGENTS.md)
holds the conventions for new tools, error codes, variables, and commands, and the files each one
touches.

## Releasing

Before starting, check that npm, the latest tag, `package.json`, `SERVER_VERSION`, and
`server.json` agree on the last release, that `npm ls @modelcontextprotocol/sdk` prints
`(empty)`, that the server instructions are still under the length bound `test/server.test.ts`
sets, and that `overleaf-web-mcp doctor <projectId>` passes against a disposable project.

1. Turn the next version's `CHANGELOG.md` section from `Unreleased` into the version and date,
   with the date as `YYYY-MM-DD`, a summary, and the sections that apply: `Added`, `Changed`,
   `Deprecated`, `Removed`, `Fixed`, `Documentation`, `Internal`. The section opens with the first
   change on the release branch as `## [X.Y.Z] - Unreleased`; the publish workflow accepts it
   undated, so check the date yourself. Set the same version in `package.json` and
   `package-lock.json`, for example with `npm version X.Y.Z --no-git-tag-version`, in
   `SERVER_VERSION` in `src/version.ts`, and in both `version` fields of `server.json`. A major or
   minor release also moves the `npx --yes overleaf-web-mcp@X.Y` pin in `skills/*/SKILL.md`,
   `docs/cli.md`, and `test/skills.test.ts`, which fails until it matches.
2. Bring the pages that describe what changed in line with the code: the tool reference, the
   error table in the safety model, the exit codes on the command line page, the configuration
   variables, the private API catalogue, the SDK's stable surface, and every tool count AGENTS.md
   lists. Run every command under [local verification](#local-verification) and
   `mkdocs build --strict`.
3. For a release that changes code under `src/overleaf/`, `src/protocol/`, `src/http/`, `src/auth/`,
   `src/core/`, or `src/service/`, or in `src/runtime.ts`, `src/config.ts`, or `src/cli/doctor.ts`,
   run the [live tests](#live-tests) and empty the Trashed view afterwards. Say in the pull request
   which suites ran and how they went.
4. Merge to `main` with CI green.
5. Publish, in either of two ways. Both run the `Publish to npm` workflow, which checks that the
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

6. Check the result: `npm view overleaf-web-mcp version` shows the new version,
   `npx --yes overleaf-web-mcp@X.Y.Z --help` runs, the tag and the GitHub Release exist, and the
   site shows the new changelog section once the `Docs` workflow has run. Close the issues the
   release shipped and open issues for what it left out.

## For coding agents

[`AGENTS.md`](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/AGENTS.md) in the repository
root states the rules that must keep holding, the conventions for new work and the files each
addition touches, how work is planned and versioned, the test expectations, and the release
checklist, in a form meant for an agent working on the code. `CLAUDE.md` imports it for Claude Code.
The Agent Skills in `skills/` are a different audience: they are for agents using the published
package, and ship in it.

## Current exclusions

Git workflows, collaborator and sharing administration, account and billing settings, chat,
background history watching, backward history pagination, version diffs and restoration, label
mutation, and editing or deleting individual comment messages are outside the current release. Private API
compatibility is version-specific and maintained on a best-effort basis. Planned work is tracked
in [GitHub issues](https://github.com/mhmdaskari/overleaf-web-mcp/issues).
