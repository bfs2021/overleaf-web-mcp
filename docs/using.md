# Using it

Through an assistant, you do not call tools yourself. You describe what you want, and the
assistant chooses tools and sequences them. This page shows what to ask for and what happens
underneath, so you can predict and check the assistant's behaviour. From a shell or a program you
can call the same operations directly, with the [command line](cli.md) or the
[TypeScript SDK](sdk.md).

## Example prompts

**Projects**

- "Create a new Overleaf project called *Grant renewal* and make `proposal.tex` its root document."
- "Start a project from the zip in `~/papers/manuscript.zip`."
- "Clone the *Lab template* project as *Smith 2026*."
- "Trash the *Old draft* project." The assistant will confirm the project name with you first.

**Finding things**

- "List my ten most recently updated Overleaf projects."
- "Find the projects with *Thesis* in the name, including archived ones."
- "Show me the file tree of the *Thesis* project. Which file is the root document?"
- "Read the abstract from `main.tex`."

**Editing**

- "Fix the typos in the introduction of `main.tex`."
- "Replace the Methods section with the text in `~/drafts/methods.tex`, as a tracked change."
- "Create `sections/limitations.tex` with a short limitations paragraph."

**Files and figures**

- "Upload `figures/fig3.pdf` into the project's `figures` folder."
- "Upload `fig1.pdf`, `fig2.pdf`, and `refs.bib` from `~/drafts` to `figures/` and `bib/`, but
  leave anything that is already there." One call, skipping existing files.
- "Which figures in `./figures` differ from the ones in the project? Upload only those."
- "Download `references.bib` to my desktop."
- "Download the whole project as a zip to `~/backups/thesis.zip`."
- "Delete `old_draft.tex`." The assistant will confirm the path with you first.
- "Delete the twenty `old-*.png` figures." One call, with the count confirmed.

**Syncing a folder**

- "Compare `~/papers/thesis` with the project. What would change?"
- "Upload everything that changed in `~/papers/thesis`, as tracked changes."
- "Make the project's `figures` folder match `./figures`, deleting what I removed locally." The
  assistant will show you what would be deleted and confirm the count first, and can save the
  project as a zip beforehand.

**Compiling**

- "Compile the paper." Builds the root document configured in Overleaf.
- "Compile with `report.tex` as the root instead."

**Review**

- "List the open comments and summarize them."
- "Reply to the comment about Figure 2 saying the caption is fixed."
- "Add a comment on the sentence starting 'We assume independence' asking for a citation."
- "List the tracked changes in `main.tex`, show me each one, and accept the ones I approve." The
  assistant will confirm which changes, and how many, before deciding them.
- "Reject the suggested deletions in the abstract."

**History**

- "What changed in the project since yesterday, and who changed it?"

## What happens underneath

### From nothing to a compiled PDF

Everything below happens through MCP tools, or the same operations as commands and SDK methods;
no step needs the web UI.

1. `create_project` with a name returns `projectId`, `url`, and `rootDocPath: "main.tex"`, the
   stub Overleaf puts in every blank project. `import_project_zip` does the same from a local
   archive, and `clone_project` copies an existing project.
2. `create_file` or `upload_file` adds the real manuscript, for example `paper.tex`, and any
   figures and bibliography files.
3. `update_project_settings` with `rootFilePath: "paper.tex"` makes it the root document, so both
   `compile_project` and the web editor's Recompile build it. The same call can set the `compiler`
   and TeX Live `imageName`.
4. `compile_project` with no `rootFilePath` builds the configured root.
5. When the project is no longer needed, `manage_project` with `action: "trash"` and
   `confirmName` equal to the project's name moves it to the trash, where it can be restored.
   Permanent deletion is a separate `delete` action that only works on an already-trashed project.

### Browsing and organizing

1. `list_projects` returns projects newest first with their ids, hiding archived and trashed
   projects unless asked. `query` narrows by name and `limit` caps the page.
2. `get_project_tree` returns every file and folder with its path, plus `rootDocPath`,
   `compiler`, `imageName`, and `spellCheckLanguage` for the project.
3. `create_file` creates a text document; `manage_entity` creates folders and renames, moves, or
   deletes entities; `upload_file` sends a local file and `batch_upload` a list of them, each to
   its own path, creating missing folders; `download_file` saves one file locally and
   `download_project_zip` the whole project as one archive.

### Making a safe edit

1. `read_file` returns the LF-normalized content and an opaque `revision`.
2. The assistant edits the content.
3. `write_file` sends the complete replacement with the unchanged `revision` and a `writeMode`.

```json
{
  "projectId": "0123456789abcdef01234567",
  "filePath": "main.tex",
  "revision": "opaque-revision-from-read-file",
  "content": "\\section{Introduction}\nRevised text.\n",
  "writeMode": "tracked"
}
```

If the document changed in the meantime, the result is `REVISION_CONFLICT` and the assistant must
read again and reconcile. It never reuses a stale revision. `write_section` and `create_file`
follow the same pattern, and a write that changes nothing returns successfully without creating a
tracked record.

For a large replacement that already exists on disk, `write_file` accepts `localPath` instead of
`content`. That keeps the revision check and optional tracked changes while avoiding the client's
tool-argument budget. See [choosing between write_file and upload_file](tools.md#choosing-between-write_file-and-upload_file).

### Working by section

`get_sections` parses the headings of one file and returns section ids; `get_section_content`
reads one body; `write_section` replaces one body with the same revision check as `write_file`.
By default, section parsing never follows `\input` or `\include`.

For a manuscript split across files, pass `followIncludes: true` to all three, with `filePath` set
to the root document. The headings of every included file are then listed in reading order, each
with the file that holds it and that file's revision, and a write goes to that one file only. A
section that runs across a file boundary is listed with `spansFiles: true` and can be read but not
written; edit its files with `write_file`. To read the whole manuscript at once, call
`get_full_document`: it returns the flattened text, a source map from each run of it back to its
file and revision, and the include directives it could not follow.

### Syncing a local folder

Two calls replace a hand-rolled comparison and one call per file.

1. `plan_sync` with `localFolderPath` (and `destinationFolderPath` when the folder corresponds to
   a project subfolder, for example `figures`) compares both sides and changes nothing. Binaries
   compare by the git blob hash already in the tree; text documents are read and compared by
   content. The plan lists `toUpload`, how many files are `identical`, what exists only in the
   project (`remoteOnly`), `conflicts`, and what the ignore rules skipped.
2. The assistant shows you the plan, in particular `remoteOnly`, which is what mirror mode deletes.
   Before a mirror sync it can take a backup with `download_project_zip`, which saves the whole
   project to a local zip and never replaces an existing file unless asked. Overleaf allows about
   10 downloads per project a minute.
3. `sync_directory` with the plan's `planToken` applies it. `mode: "additive"` only uploads and
   writes; `mode: "mirror"` also deletes, and needs `confirmDeleteCount` equal to the number of
   `remoteOnly` entries you agreed to.

```json
{
  "projectId": "0123456789abcdef01234567",
  "localFolderPath": "/Users/me/papers/thesis",
  "mode": "mirror",
  "planToken": "opaque-token-from-plan-sync",
  "confirmDeleteCount": 20
}
```

If anything changed on either side since the plan, the result is `REMOTE_DRIFT` and nothing
happens; the assistant plans again. Changed documents are written with the same revision check
as `write_file`, so a collaborator's edit made during the sync fails that one file with
`REVISION_CONFLICT` instead of being overwritten. If some files fail, the result is
`status: "partial"` with `completed`, `failed`, and `remaining`; nothing was deleted, and calling
`sync_directory` again with the returned `planToken` finishes the job without repeating what
already succeeded.

To remove several entities without a sync, `delete_entities` takes a list of paths and
`confirmCount` equal to its length.

To upload a list of files to paths you choose, without comparing folders, `batch_upload` takes
`{ localPath, destinationPath }` pairs, where `destinationPath` includes the file name. It checks
every entry before sending anything and creates missing folders. `onConflict` says what to do
when a path is taken: `"fail"`, the default, refuses the whole call before anything is uploaded,
`"overwrite"` replaces a binary file at a path, and `"skip"` leaves existing files alone. Replacing a text document this way has no revision check and also needs
`uncheckedDocumentReplace: true`, so for documents a collaborator may be editing, a sync or
`write_file` is the safer route. `upload_file` follows the same rules for one file, with
`overwrite: true`, or `expectedHash` from `get_project_tree`, for a binary. A file that fails does not undo the ones before it; the
result lists `completed`, `skipped`, `failed`, and `remaining`. Overleaf allows about 500 uploads
per project in 15 minutes, and the call stops at the first `RATE_LIMITED` rather than send the
rest.

The hash in `get_project_tree` is still there for a quick manual check of one binary: it equals
`git hash-object <file>`. Text documents have no hash; compare those with `read_file`.

### Compiling

`compile_project` with no `rootFilePath` builds the root document configured in the project,
which is what the web editor's Recompile button builds. Passing `rootFilePath` overrides the root
for that call only. The result's `summary` says whether the paper built cleanly and lists the
first errors and warnings by file and line, with undefined references and citations and missing
files. Overleaf reports `status: "success"` whenever a PDF came out, even when LaTeX hit errors,
so `summary.builtCleanly` is the answer to "did it build?".

```json
{
  "status": "success",
  "buildRef": "opaque-token-naming-this-build",
  "summary": {
    "builtCleanly": false,
    "errorCount": 1,
    "errors": [{ "file": "main.tex", "line": 5, "message": "Undefined control sequence." }],
    "undefinedCitations": ["knuth84"],
    "pageCount": 12
  }
}
```

For more context, `get_compile_log` returns the end of the LaTeX log, or only its error lines,
without compiling again, and `download_compile_output` saves the PDF, or any other output such as
`output.synctex.gz`, to a local path. Both take the `buildRef` and default to the latest build in
this process. Each command line call is a new process with no latest build, so there
`compile log` and `compile download` require `--build-ref`, `call get_compile_log` without a
`buildRef` fails with `NO_BUILD`, and `compile run --download` compiles and saves the PDF in one
process. `stopOnFirstError` gives a short log with the one error that matters, and
`draft` skips images for faster text-only builds. `stop_compile` stops a running build. Compiles
use your account's compile allowance, so the assistant should read the summary rather than
compile in a loop.

### Reviewing comments

1. `list_comments` returns open threads by default, with file, status, and author filters.
2. `reply_to_comment` adds to an existing thread.
3. `add_comment` anchors a new thread to exact text: it needs a fresh revision, 1-based line and
   UTF-16 column positions, and `expectedText` equal to the selected text.
4. `set_comment_status` resolves or reopens a thread using the latest revision.

### Reviewing tracked changes

1. `list_tracked_changes` with `filePath` lists a document's tracked changes: each with its
   `changeId`, `type` (`insert` or `delete`), position, an excerpt, its `authorId`, and its
   timestamp, plus the document's `revision`. A replacement is an insert and a delete linked by
   `pairedChangeId`. Without `filePath` it lists the documents Overleaf's range index says have
   changes; `authorId` and `type` filter the list.
2. The assistant shows you the changes and asks which to accept or reject.
3. `manage_tracked_changes` with `action` `accept` or `reject`, that `filePath` and `revision`, the
   chosen `changeIds`, and `confirmCount` equal to their number decides them in one call. Accepting
   an insert keeps its text and accepting a delete removes it; rejecting does the opposite.
   Nothing is sent if the count is wrong, the document changed, an id is no longer a tracked
   change, or a change left out overlaps a chosen one.
4. List again before the next decision: ids merge and split as the document changes.

Accepting and rejecting needs owner or edit access to the project; a review-only collaborator can
suggest changes with `writeMode: "tracked"` but not decide them here.

Review comments and tracked changes require an Overleaf plan and deployment that support them.

### Following history

Call `monitor_project_history` without a cursor to establish the current window, then pass the
returned `nextSinceVersion` on later polls. Only update groups newer than the cursor come back.
If `gapDetected` is true, the cursor predates the single window returned; the tool does not page
backward or compute diffs.

### From a shell

The same workflows run as commands, each printing one JSON result: `files read`, then
`files write` with the `revision` it returned; `sync plan`, then `sync apply` with the plan's
`planToken`; `compile run`, then `compile log` with its `buildRef`. The
[command line guide](cli.md#examples) shows each one, and its exit codes say whether to read
again, plan again, or wait.
