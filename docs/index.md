---
title: Overleaf MCP Server for Claude, Codex & Cursor
description: Connect Claude, Codex, and Cursor to Overleaf. Read, edit, compile, and review LaTeX projects through your own signed-in web session.
---

# Overleaf MCP Server for AI-Assisted LaTeX Editing

Overleaf Web MCP connects Claude, Codex, Cursor, and other
[Model Context Protocol](https://modelcontextprotocol.io) clients to your Overleaf projects. Read,
edit, compile, and review LaTeX documents through your own signed-in web session, with no Git
integration or premium plan required for the core workflow.

[![npm version](https://img.shields.io/npm/v/overleaf-web-mcp?style=flat-square&logo=npm&label=npm&color=1F6FEB)](https://www.npmjs.com/package/overleaf-web-mcp)
[![Total npm installs](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmhmdaskari%2Foverleaf-web-mcp%2Fbadges%2Fnpm-downloads.json&style=flat-square&label=installs)](https://www.npmjs.com/package/overleaf-web-mcp)

![An MCP client connected through an authenticated web session to an Overleaf workspace](assets/overleaf-web-mcp-workflow.webp#only-light)
![An MCP client connected through an authenticated web session to an Overleaf workspace](assets/overleaf-web-mcp-workflow-dark.webp#only-dark)

Overleaf Web MCP is an MCP server, the `overleaf-web-mcp` [command line](cli.md), and a
[TypeScript library](sdk.md), all over one engine with the same safety checks. It signs in to
Overleaf once through a browser window you control, then lets an AI assistant, a script, or your
own program work on your projects the way you would in the web editor. It uses the same
browser-facing endpoints the Overleaf editor uses, so it needs no Git integration and no premium
plan for the core workflow.

!!! note
    It relies on Overleaf's private web APIs, which can change without notice, and automating
    `www.overleaf.com` may carry Terms-of-Service and account risk. Read
    [what this does not protect against](safety.md#what-this-does-not-protect-against) before
    using an account you care about.

## What you can say

Once connected, you talk to your assistant in plain language. The assistant picks the tools.

- "Create a new project called *Grant renewal* from the folder I zipped, and make `proposal.tex` the root."
- "List my Overleaf projects and open the one called *Thesis*."
- "Rewrite the introduction of `main.tex` for a general audience, as a tracked change."
- "Compile the paper and tell me whether it built cleanly, and where any errors are."
- "Which figures in `./figures` differ from what's in the project? Upload only those."
- "Make the project match `~/papers/thesis`, and show me what would be deleted first."
- "Summarize the open review comments and reply to the one about Table 2."
- "Go through the tracked changes in `main.tex` with me, and accept the ones I approve."

## What it can do

**Start and manage projects.** Create a blank or example project, clone one, or import a zip;
rename, trash, restore, or archive projects with the name confirmed first; set the root document,
TeX engine, and TeX Live image so the web editor's Recompile follows; and organize projects with
your dashboard tags.

**Browse and organize.** List and search projects, read the file tree with the configured root
document and compiler, create folders and files, rename, move, upload one file or a list of them,
download a file or the whole project as a zip, and delete with confirmation.

**Sync a folder.** Compare a local folder with the project without changing anything, then
upload only what changed, and optionally delete what you removed locally, in one confirmed call.

**Write safely.** Replace a whole document or a single section. Every edit is checked against the
revision you read first, so a collaborator's concurrent change is reported instead of overwritten.
Edits can be recorded as Overleaf tracked changes.

**Work by section.** Parse `\section` headings in a file, read one section, and replace one section.
A manuscript split across `\input`, `\include`, `\subfile`, and `\import` can be read as one
flattened document with a map back to each file, and worked on by section across its files.

**Compile.** Build the project's configured root document, or any document you name, and get its
errors and warnings by file and line, with a clear answer on whether it built cleanly. Read the
log, save the PDF or any other output locally, or stop a running compile.

**Review.** List comment threads with their locations, reply, add a comment anchored to exact
text, and resolve or reopen threads. List tracked changes with their authors and locations, and
accept or reject them once you have confirmed which. Accepting or rejecting them needs a project
whose owner's Overleaf plan includes track changes, and on self-hosted Overleaf an edition that
includes it; otherwise the decision is refused with nothing changed.

**Follow history.** Poll recent project history with a version cursor to see who changed what.

## How it keeps your project safe

- Text edits require the revision from a prior read and fail with a conflict if the document
  changed underneath.
- Tracked changes are opt-in and never silently downgraded to plain edits. Accepting or
  rejecting them needs the revision they were listed with and their number confirmed, and is
  verified afterwards.
- Deletes require the path, or the number of entries, to be confirmed; downloads, including a
  whole-project zip, never overwrite a local file unless asked, and never touch the saved session.
- A folder sync needs the `planToken` from `plan_sync`, and stops before changing anything if
  either side changed since the plan. An upload never replaces a file unless that is asked for.
- An optional [access policy](configuration.md#access-policy) limits which projects, local
  folders, and kinds of change the server may touch.
- A write that times out is observed, never resubmitted, so nothing is applied twice.
- Your session cookie stays on your machine in a file only you can read, and is never returned by
  any tool, command, or SDK method.

Details are in the [safety model](safety.md).

## Next steps

- [Install](install.md) the server and connect your client.
- See [example prompts and workflows](using.md).
- Look up any tool in the [reference](tools.md).
- Run the same operations from a shell with the [command line](cli.md), or from TypeScript with
  the [SDK](sdk.md).
