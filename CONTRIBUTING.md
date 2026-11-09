# Contributing

Thank you for helping with Overleaf Web MCP. Bug reports, feedback, documentation fixes, and code
are all welcome. This page explains how to report a problem without exposing your account or your
manuscripts, and how to get a pull request merged.

## Ask a question or share feedback

Use [GitHub Discussions](https://github.com/mhmdaskari/overleaf-web-mcp/discussions) for questions,
ideas, and reports of how the tools worked for you, good or bad. Feedback from real review and
writing sessions shapes the [roadmap](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/ROADMAP.md),
so say what you were trying to do, not only what went wrong.

## Report a bug

Open an [issue](https://github.com/mhmdaskari/overleaf-web-mcp/issues/new) and include:

- the package version (`npm ls overleaf-web-mcp`, or `npm ls -g overleaf-web-mcp` for a global
  install; `npx -y overleaf-web-mcp` runs the latest release) and `node --version`;
- how you ran it: which MCP client and its version, the command line, or the TypeScript SDK;
- whether you use `www.overleaf.com` or a self-hosted Overleaf, with its edition and version;
- the tool or command and the arguments you passed, and what you expected to happen;
- the error object, `{ code, message, retryable, details }`, and for the command line its exit
  code. Errors are built to be shareable: they never carry cookies, document text, or Overleaf's
  responses, though they can name a local path you passed.

**Never paste** your `cookies.txt` or any cookie value, document or manuscript text, review
comments, or collaborators' names and email addresses. Replace project, document, and user IDs
with placeholders such as `<projectId>`. If a bug only shows up with particular text, reproduce it
in a new, disposable project and describe that text instead.

If Overleaf changed a private endpoint and something that used to work stopped, say when it last
worked. The endpoints this project depends on are listed in the
[private API catalogue](https://mhmdaskari.github.io/overleaf-web-mcp/private-api/).

### Security problems

Do not open a public issue for anything that could expose a session, a document, or a way around
the access policy or the confirmation checks. Report it privately through the repository's
[security advisories](https://github.com/mhmdaskari/overleaf-web-mcp/security/advisories/new).

## Propose a change

For anything larger than a small fix, open an issue or a discussion first, so we can agree on the
design before you write the code. A new tool in particular costs every MCP client context on every
turn, so we look for a way to extend an existing one first.

### Set up

You need Node.js 20 or newer.

```bash
git clone https://github.com/mhmdaskari/overleaf-web-mcp.git
cd overleaf-web-mcp
npm install
npm run check          # tsc --noEmit
npm run lint           # eslint
npm run format:check   # prettier; npm run format rewrites the files
npm test               # vitest, no network needed
npm run build          # emits dist/
```

CI runs these on Node 20 and 24 for every pull request. The
[development guide](https://mhmdaskari.github.io/overleaf-web-mcp/development/) covers the test
suites, the live tests, and the documentation site in more detail.

### Where code goes

Every operation is defined once, in `src/contracts/operations.ts`: its input and output schemas,
description, annotations, and effects. `src/service/operations.ts` shapes the arguments, and the
domain engine under `src/overleaf/`, `src/protocol/`, and `src/http/` talks to Overleaf. The MCP
server (`src/mcp/`), the command line (`src/cli/`), and the TypeScript SDK (`src/client.ts`) are
thin adapters over that one service, so a new or changed operation reaches all three without
adapter code. [`AGENTS.md`](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/AGENTS.md)
describes the layout and lists the rules that must keep holding, and
[Internals](https://mhmdaskari.github.io/overleaf-web-mcp/internals/) explains the protocol.

The rules that most often catch a first pull request:

- **Nothing private leaves the process.** No cookies, document text, diffs, filenames, or review
  comment bodies in logs, errors, or results, and no quoted Overleaf responses in error messages.
- **Writes are never retried.** A write that timed out is observed and reported, never sent again.
- **Destructive actions are confirmed by value** (a path, a name, a count, a revision, or a plan
  token), never by a flag like `--yes`.
- **The public contract is stable.** Tool names, input schemas, result shapes, error codes, and
  the command line's commands, flags, output, and exit codes are public. Any change to them is
  listed in `CHANGELOG.md` under the next version, and a stricter safety default is announced one
  minor version before it is enforced.
- **Write independent code.** This package is MIT-licensed. Overleaf itself and some other Overleaf
  MCP servers are AGPL-3.0, so read them to understand the protocol, but do not copy their code.

### Tests

- Unit tests run offline. Add or update tests with every change, and run `npm test` before you
  push.
- Protocol fixtures under `test/fixtures/` must be sanitized: no cookies, real IDs, user data, or
  document content.
- Update a snapshot (`npx vitest run -u`) only for a change you also list in `CHANGELOG.md`.
- Live tests are opt-in (`RUN_OVERLEAF_LIVE_TESTS=1`) and must only ever target a disposable
  project you own. Never point them at a real manuscript.

### Pull requests

1. Branch from `main` with a name that describes the work: `feat/`, `fix/`, `docs/`, or `chore/`
   plus a short topic, for example `fix/compile-root-resolution`.
2. Keep each pull request to one change. Commit subjects use a conventional prefix (`feat:`,
   `fix:`, `docs:`, `ci:`, `chore:`) and plain wording.
3. Run every command under **Set up**, and `npx tsx scripts/check-pack.ts` after a build if you changed what is published.
4. Add a `CHANGELOG.md` entry for anything a user would notice, and update the documentation in
   `docs/` and the README when behaviour changes. Edit `ROADMAP.md` and `CHANGELOG.md` at the
   repository root; the documentation site includes them.
5. In the description, say what changed, why, and how you tested it. If you ran live tests, say
   so, and against which kind of Overleaf.

By contributing, you agree that your contribution is licensed under the project's
[MIT License](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/LICENSE).
