# Tool reference

The server registers 34 tools. Names are `snake_case`. Each tool is also
`overleaf-web-mcp call <name>` on the [command line](cli.md) and a camelCase method of
`createOverleafClient` in the [TypeScript SDK](sdk.md), with the same parameters, results, and
errors. Every tool except `auth_status`,
`list_projects`, `create_project`, and `import_project_zip` takes a `projectId` from
`list_projects` or from one of the tools that create a project. An id never contains `/`, `\`,
`.`, `?`, `#`, or `%`; one that does is refused with `INVALID_ARGUMENT` before anything is sent.
Every tool declares an `outputSchema` and returns its result as `structuredContent`, mirrored as
a JSON text block for clients that read only text; `overleaf-web-mcp schema <name> --output`
prints the schema. A result never carries a key its schema does not list. The result of a
read-only tool is checked against its schema before it is returned, and one that does not match,
because Overleaf answered in a shape this release does not understand, fails with
`PROTOCOL_UNSUPPORTED` and `details: { kind: "response_shape", paths }`. Failures are JSON with
`code`, `message`, `retryable`, and optional `details`; the codes are listed in the
[safety model](safety.md#error-codes). The Overleaf routes behind each tool are catalogued in the
[private API page](private-api.md).

Each tool declares MCP annotations: **read-only** tools change nothing on Overleaf and write
nothing locally; **destructive** tools can replace or remove existing content, on Overleaf or on
the server's disk. Clients may use these to decide when to ask the user. When the
[access policy](configuration.md#access-policy) is configured, any tool can be refused with
`POLICY_DENIED` or `PATH_OUTSIDE_ROOT` before anything is sent.

**Replacements must be asked for.** Since 0.6.0 an upload that would replace something, a folder
sync without a `planToken`, and a `batch_upload` onto taken paths are refused with nothing sent
unless the call says so: `overwrite` or `expectedHash` for a binary, `uncheckedDocumentReplace`
for a text document, `onConflict` for a batch, and `planToken` or `unplanned` for a sync. 0.5.x
announced these with a `deprecations` list in the result; the
[safety model](safety.md#what-changed-in-060) lists what changed.

## Account and projects

### `auth_status` <small>read-only</small>

Verify the saved web session without exposing cookies.

No parameters.

Returns `authenticated: true`, `baseUrl`, the account's `userId` when known, `projectCount`,
`sessionExpiresAt` (ISO 8601, when the session lapses unless a request refreshes it first;
absent when no cookie carries a deadline), `permissionsUnchecked` (true on filesystems without
POSIX modes), an optional `warning`, and `socketPresenceNotice` explaining that an open project
connection can show the account as online. A missing or expired session fails with
`AUTH_EXPIRED`.

### `list_projects` <small>read-only</small>

List the projects the account can access, newest first by default.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `query` | no | Case-insensitive substring of the project name |
| `includeArchived` | no | Include archived projects; default `false` |
| `includeTrashed` | no | Include trashed projects; default `false` |
| `limit` | no | Maximum projects returned; default 50, at most 200 |
| `sort` | no | `lastUpdated` (newest first, the default) or `name` |

Returns `projects`, an array of `{ id, name, accessLevel, lastUpdated, archived, trashed }`,
plus `totalMatched` (how many passed the filters before `limit`) and `totalProjects` (everything
the account can access, archived and trashed included). Overleaf returns the whole list in one
response, so filtering and `limit` happen in the server; there is no server-side pagination to
expose.

## Project lifecycle

### `create_project`

Create a new project and return its id.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `name` | yes | Project name, 1 to 150 characters without slashes |
| `template` | no | `blank` (default) or `example`, Overleaf's example paper |

Returns `projectId`, `name`, `url`, and `rootDocPath`. A blank project still contains Overleaf's
stub `main.tex` as its root document. After adding the real manuscript, point the project at it
with `update_project_settings` or delete the stub with `manage_entity`; otherwise Recompile builds
the stub. If the project was created but its tree could not be read, the error carries the new
`projectId` in `details` so the assistant does not create a duplicate.

### `clone_project`

Copy an existing project, its files, root document, and compiler included, into a new one.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `sourceProjectId` | yes | Project to copy |
| `name` | yes | Name of the copy |

Returns `projectId`, `name`, and `url`. Overleaf does not copy the TeX Live image or the
spell-check language: the copy gets the account's defaults. Set them with
`update_project_settings` when they matter.

### `import_project_zip`

Create a new project from a local `.zip` archive of LaTeX sources.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `localZipPath` | yes | Local path of a `.zip` archive |
| `name` | no | Project name; defaults to the archive's file name without `.zip` |

Returns `projectId`, `url`, and `name`, the name Overleaf stored. It can differ from the one
requested: Overleaf uses the root document's `\title` when there is one, and adds a suffix such as
`(1)` when the account already has a project with that name. Use this name as `confirmName`. The
read-back needs the `overleaf-read` effect. If the project was imported but its name could not be
read back, the error keeps the read's code when it is `AUTH_EXPIRED`, `POLICY_DENIED`, or
`TIMEOUT`, and is `REMOTE_ERROR` otherwise. It is never retryable and carries the new `projectId`
in `details`: the project exists, so do not import again.

Overleaf caps archives at about 50 MB (`UPDATE_TOO_LARGE`) and rate-limits this route:
`RATE_LIMITED` means nothing was created and `details.retryAfterMs`, when present, says how long
to wait. Overleaf's rejections of an archive surface as `INVALID_ARGUMENT`. `details.overleafError`
(`invalid_zip_file`, `empty_zip_file`, `zip_contents_too_large`, `invalid_filename`) appears only
when Overleaf answers with such a machine-readable code; overleaf.com answers with a translated
sentence, which is never quoted, so there is usually none. If the archive has several top-level
`.tex` files, set the root with `update_project_settings` afterwards.

### `manage_project` <small>destructive</small>

Rename, trash, restore, archive, unarchive, or permanently delete a project.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `action` | yes | `rename`, `trash`, `restore`, `archive`, `unarchive`, or `delete` |
| `newName` | for `rename` | New name, 1 to 150 characters without slashes |
| `confirmName` | for `trash`, `archive`, `delete` | Must equal the current project name exactly, else `CONFIRMATION_MISMATCH` |

Returns `action`, `projectId`, and the project's `name` after the action. `trash` is the normal
way to remove a project: it is reversible with `restore` or from the web UI's Trashed view.
`delete` is permanent and only succeeds on a project that is already trashed; on a live project it
fails with `INVALID_ARGUMENT` and changes nothing. The current name is read from Overleaf first
to compare, and the name check happens before any change is sent, so a wrong `confirmName`
changes nothing. Trashed and archived projects disappear from `list_projects` unless
`includeTrashed` or `includeArchived` is set.

### `update_project_settings`

Persist compile and editor settings in the project itself, so the web UI follows them too.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `rootFilePath` | one of | Document Overleaf should compile by default: an existing `.tex`, `.ltx`, `.Rtex`, or `.Rnw` document (any case); any other extension fails with `INVALID_ARGUMENT` before any request |
| `compiler` | one of | `pdflatex`, `latex`, `xelatex`, or `lualatex` |
| `imageName` | one of | TeX Live image name, as shown in Overleaf's menu |
| `spellCheckLanguage` | one of | Overleaf language code such as `en` or `de`; `""` turns spell checking off |

At least one setting is required. Returns `projectId`, `rootDocPath`, `compiler`, `imageName`,
and `spellCheckLanguage` (only when spell checking is on; absent when it is off) as re-read from
a fresh project join, so the result reflects what Overleaf actually stored. A `rootFilePath` that
does not exist fails with `NOT_FOUND`; one that names a folder or binary file fails with
`INVALID_ARGUMENT`. Both checks run before any setting is sent.

Settings are sent one request each, in the order Overleaf applies them: `compiler`, `imageName`,
`spellCheckLanguage`, then the root document. If one fails, the error keeps its code and
`retryable` and adds `details.applied` (the settings already stored) and `details.failed` (the
setting whose request failed); nothing after it was sent. After a `TIMEOUT` the failed setting
itself may or may not have been stored. Call `get_project_tree` to see the stored values.

## Projects and files

### `get_project_tree` <small>read-only</small>

Return the file and folder tree together with the project's compile settings.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |

Returns `entities`, an array of `{ id, name, path, type, parentFolderId, hash? }` where `type` is
`doc` (text), `file` (binary), or `folder`, plus `rootDocPath` (the document Overleaf compiles by
default), `compiler`, `imageName` (the TeX Live image), `spellCheckLanguage` when spell checking
is on, `trackChangesActive`, and `hashNote`. `rootDocPath`, `compiler`, and `imageName` are absent
when the project has none, for example a project without a root document.

`hash` is present only on binary `file` entities and is a git blob hash:
`sha1("blob " + byteLength + "\0" + content)`, exactly what `git hash-object <file>` prints. Plain
`sha1sum` never matches. Text documents have no hash and must be compared by reading them.

### `read_file` <small>read-only</small>

Read a text document.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Project-relative path with forward slashes |

Returns `content` with line endings normalized to LF, the opaque `revision` needed for any write,
`newline: "LF"`, the document's OT `protocol` (`sharejs` or `history-ot`), and
`trackChangesActive`.

### `write_file` <small>destructive</small>

Replace a text document with a revision-checked, verified edit of only the words that differ.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Document path |
| `revision` | yes | The revision from a prior `read_file` or write of this document |
| `content` | one of | Complete replacement text |
| `localPath` | one of | Local UTF-8 file holding the complete replacement. Non-UTF-8 content is rejected; a leading byte order mark is stripped |
| `writeMode` | no | `untracked` (default) or `tracked` to record the edit as Overleaf tracked changes |

Exactly one of `content` and `localPath` must be given. Returns the new `revision`, `protocol`,
`trackChangesActive`, `writeMode`, and `recoveredAfterTimeout: true` when the write was confirmed
during the recovery window after a timeout or a lost socket. A no-op write succeeds and records
nothing. Fails with `REVISION_CONFLICT` if the document changed since the revision was read.

The update changes only the words that differ, so text between two edits, and any comment or
tracked change on it, is left alone. Word edits are sent only when none of them touches a comment
or a tracked change; an edit that would is first cut down to the characters that differ, or moved
along repeated text to a place clear of every range. With `writeMode: "tracked"`, each changed
group of words becomes its own tracked change, or a deletion and an insertion side by side for a
replacement, so a reviewer can accept or reject each one. Words one space apart count as one
group. A write where an edit still touches a comment or a tracked change, or whose tracked
changes would take the document past Overleaf's limit of 2,000, sends one edit per changed run of
lines instead, or failing that one edit from the first change to the last, as before, as does a
write too large to compare word by word, an untracked legacy-editor write to a document holding
tracked deletions that share a point, or touching insertions by one author, which Overleaf merges
after any untracked deletion, and a write whose word edits would have to send again a
character outside the Basic Multilingual Plane the document holds, such as an emoji (that span is
split around those characters).

The account's access level is checked before the update is sent: a review-only collaborator can
write only with `writeMode: "tracked"`, and a read-only one cannot write; either is
`PERMISSION_DENIED` (`details.accessLevel`, `details.required`) with nothing sent. If Overleaf
reports an error on the document after the update was sent, the write is observed on a fresh
connection like a timed-out one, except `update is too large`, which is `UPDATE_TOO_LARGE` with
`details.outcome: "not_applied"`. A tracked write is checked after it verifies: every span it
inserted or deleted must be held by tracked changes by this account (text that was itself a
tracked insert can simply be deleted). Otherwise it fails with `PROTOCOL_UNSUPPORTED`,
`details.kind: "applied_untracked"`, and `details.liveRevision`. That write is live and is not
reverted: read the file and review it before writing again. If another update followed the write
before the check, such as a decision on its tracked changes, whether it was tracked can no longer
be told: the write is live, and the result is `REVISION_CONFLICT` with
`details.outcome: "unknown"` and `details.liveRevision`.

On a ShareJS document (`protocol: "sharejs"`, Overleaf's legacy editor), characters outside the
Basic Multilingual Plane, such as emoji, cannot be sent: the legacy editor would store each as
U+FFFD. Text that adds such a character, adds another copy of one the document already holds, or
changes their order fails with `INVALID_ARGUMENT` (`details.line`, the 1-based line of the first
added one) and nothing is sent. Replace them, for example with a LaTeX command. Editing text on
either side of one the document already holds is fine: the change is sent as several edits that
step around it, as one span from the first change to the last if the word edits would move it.
History-OT documents are not affected.

### `create_file`

Create a text document, optionally with initial content.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Path of the new document; parent folders must exist |
| `content` | no | Initial text |
| `writeMode` | no | `untracked` (default) or `tracked`; tracked requires non-empty `content` |

Returns the document's `revision`, `protocol`, `trackChangesActive`, and `writeMode`, the same
fields as `write_file`, with `recoveredAfterTimeout: true` when the initial content's write was
confirmed after a timeout or a lost socket. Without content, `writeMode` is `untracked`. Creating
the entity itself is always an ordinary project-tree operation; only the initial content can be
tracked.

Creating the document and writing its content are separate steps, and the content is written as
by `write_file`, so on a ShareJS document content that adds a character outside the Basic
Multilingual Plane is refused. If reading the new document back or writing its content fails after the
document was created, that refusal included, the error keeps its code and its `details` (such as
`outcome`), adds `details.created: true`, and is not retryable: the document now exists at
`filePath`, possibly still empty, and is not deleted for you. Do not call `create_file` again;
read it with `read_file` and write the content with `write_file`.

### `manage_entity` <small>destructive</small>

Create a folder, or rename, move, or delete an existing document, file, or folder.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `action` | yes | `create_folder`, `rename`, `move`, or `delete` |
| `path` | yes | For `create_folder`, the folder to create; otherwise the entity to act on |
| `newName` | for `rename` | New name without slashes |
| `destinationFolderPath` | for `move` | Target folder; `""` is the project root |
| `confirmPath` | for `delete` | Must equal `path` exactly, else `CONFIRMATION_MISMATCH` |

Returns the `action`, `trackChangesActive`, and `writeMode`, which is always `untracked` because
tree operations are never tracked changes. A `rename`, `move`, or `delete` also returns the
affected entity's `id`. A `create_folder` returns the new folder as `created: { _id, name }` when
Overleaf's answer named both, and otherwise neither `id` nor `created`; read the tree to find the
folder's id then. Deleting a folder removes everything inside it.

A name already used in the target folder (by `create_folder`, with or without a trailing slash;
by a `rename`, including to the entity's own name; or by a `move`, including into the folder that
already holds it) and moving a folder into itself or one of its subfolders fail with `INVALID_ARGUMENT` before anything is sent.
Names are compared exactly, as Overleaf compares them.

### `upload_file` <small>destructive</small>

Upload a local file into a project folder.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `localPath` | yes | Local file to upload |
| `destinationFolderPath` | no | Target folder; default `""`, the project root |
| `destinationName` | no | Name to store the file under; defaults to the local file name |
| `overwrite` | no | `true` allows replacing a binary file at the path; `false` refuses to replace anything. Omitted, replacing a binary needs `expectedHash`; a document is governed by `uncheckedDocumentReplace` |
| `expectedHash` | no | The `hash` `get_project_tree` reported for the binary file being replaced, 40 lowercase hex characters |
| `uncheckedDocumentReplace` | no | Allow replacing a text document, which has no revision check |

If an entity already exists at the destination path and the call asks for it to be replaced,
Overleaf replaces it; otherwise a new entity is created. A text document replaced by a text document keeps its entity id. A replaced binary
file may get a new one, as may a document replaced by a binary or the reverse (Overleaf's source
creates a new entity in those cases), so look the id up again in `get_project_tree` rather than
reusing the old one. Overleaf, not the caller, decides whether the result is a text `doc` or a
binary `file`, by extension and UTF-8 validity, so this is a valid way to replace `.tex`, `.bib`,
and `.bst` documents from disk.

What is at the path decides what the call needs, and every check runs inside the upload's queue
job, after a fresh look at the tree and before anything is sent:

| At the path | Result |
| --- | --- |
| nothing | uploaded |
| a binary file, with `overwrite: true` or a matching `expectedHash` | replaced |
| a binary file, with neither | `CONFIRMATION_MISMATCH` (`details.missing: "overwrite"`), nothing sent |
| a text document, with `uncheckedDocumentReplace: true` | replaced |
| a text document, without it | `INVALID_ARGUMENT` (`details.missing: "uncheckedDocumentReplace"`), naming `write_file` with `localPath`, nothing sent |
| a text document or binary file, with `overwrite: false` | `CONFIRMATION_MISMATCH`, nothing sent |

In 0.5.x the two refused rows still replaced the file and listed a `deprecations` entry.

An `expectedHash` that does not match what is at the path, nothing and a text document included,
fails with `REMOTE_DRIFT` and nothing is sent. It is a preflight, not a compare-and-swap: the
upload route accepts no expected state, so a replacement that lands between the check and the
upload is lost. Replacing a text document also needs the `unchecked-replace` effect when the
access policy limits effects.

Replacing a document this way is a blind write with no revision check. Overleaf compares the new
text with the old and applies the difference, and records it as tracked changes when track
changes is already on for this account; otherwise it is untracked. The caller cannot choose
either way. A new file created by upload is never tracked content. A folder of the same name in
the destination folder fails the upload with `INVALID_ARGUMENT` (`details.overleafError:
"duplicate_file_name"`).

A `localPath` that cannot be read fails before anything is sent: `NOT_FOUND` when it does not
exist, `INVALID_ARGUMENT` otherwise (a folder, for example), with the errno code in
`details.errno`.

Returns `entityId`, `entityType`, `path`, `replaced` (whether something existed at that path),
for binary files `hash`, computed locally so it can be checked against `get_project_tree` later,
`trackChangesActive`, and `writeMode`. `writeMode` is `tracked` when a text document replaced a text document while track
changes is on for this account, because Overleaf then records the difference as tracked changes,
and `untracked` otherwise: for a binary, a new file, or with track changes off.

### `batch_upload` <small>destructive</small>

Upload a list of local files, each to its own project path, in one call.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `files` | yes | 1 to 500 entries `{ localPath, destinationPath }`. `destinationPath` is the full project path, file name included, such as `figures/fig1.pdf` |
| `onConflict` | no | What to do when a document or binary file is already at a destination path. `fail`, the default, refuses the whole call before anything is uploaded; `skip` leaves what is there alone and lists it under `skipped`; `overwrite` replaces a binary file, as `upload_file` with `overwrite: true` does |
| `uncheckedDocumentReplace` | no | Allow replacing text documents, which has no revision check |
| `stopOnError` | no | Stop at the first failure instead of continuing; default `false` |

It is a composition of `upload_file` and `manage_entity`'s `create_folder`, like the
[folder sync tools](#folder-sync-and-bulk-delete), and saves tool calls, not time. What happens,
in order:

1. Every entry is checked before anything is sent. The project root, a path ending in `/` or `.`,
   one with a `..` segment, a `destinationPath` listed twice, and one that is the parent folder of another
   listed path are `INVALID_ARGUMENT`; a `localPath` that does not exist is `NOT_FOUND`, and one
   that is a folder is `INVALID_ARGUMENT`. Any of these fails the whole call with nothing changed.
2. The project tree is read once. With `onConflict: "fail"`, the default, any destination path
   that holds a document or binary file fails the whole call with `CONFIRMATION_MISMATCH`
   (`details.missing: "onConflict"`, `details.count`, and up to 25 `details.paths`) and nothing
   is uploaded. A file whose path runs through a document or binary file, or whose path is a
   folder, fails with `INVALID_ARGUMENT` in any mode. A file whose path holds a document or binary
   file is skipped with `onConflict: "skip"`, and replaced with `"overwrite"`, as by
   `upload_file`: a replaced document keeps its entity id, a replaced binary may get a new one.
3. Files are handled in the order given, one at a time through the project's queue. Just before a
   file is uploaded, its missing parent folders are created, parents first, each once, and listed
   in `completed` as `create_folder`. A folder that could not be created is not tried again, and
   every file under it fails with the folder's error code. With
   `onConflict: "skip"` the path is checked again just before each upload, so a file someone added
   in the meantime is skipped rather than replaced. Failures are per file; the rest continue unless
   `stopOnError`, after which every file not attempted is in `remaining`. The call also stops at
   the first `RATE_LIMITED`, with or without `stopOnError`, since Overleaf would refuse the rest
   too: that file is in `failed`, the rest in `remaining`, and nothing more is sent. Overleaf
   allows about 500 uploads per project in 15 minutes, as many as one call can list, so a second
   large batch soon after the first can hit it. A `RATE_LIMITED` folder creation stops the call
   the same way.
4. The tree is read back once. An upload that is not there, or a binary whose hash differs from
   the local file, moves to `failed` with `REMOTE_ERROR`. An upload that timed out is classified,
   never sent again: a binary now in the tree with the local file's hash moves to `completed`
   with `recoveredAfterTimeout: true`, since the path holds what was asked for whether or not
   this upload put it there. A path that was empty before and after, or holds the same binary
   with the same hash as before, stays failed with `TIMEOUT`: it had not landed when the tree was
   read, though it could still land late. Anything else, a document for example, since documents
   have no hash, stays failed with `OUTCOME_UNKNOWN`. Check `get_project_tree` before uploading
   that file again.

Overleaf decides whether each file becomes a text `doc` or a binary `file`, as for `upload_file`.
Replacing a document this way is a blind write with no revision check, so a collaborator's
concurrent edit is lost; Overleaf records the replacement as tracked changes only when track
changes is already on for this account. For documents someone may be editing, use `write_file`
with `localPath`, or `plan_sync` and `sync_directory`. Each file goes through `upload_file`'s
checks: with `onConflict: "overwrite"`, a document is replaced only with
`uncheckedDocumentReplace: true`, and otherwise that file fails with `INVALID_ARGUMENT` and
nothing is sent for it. In 0.5.x an omitted `onConflict` overwrote, and the result listed
`deprecations`.

Returns:

- `status`: `complete`, or `partial` when anything failed or was not attempted. Skipped files do
  not make it partial.
- `onConflict`, as applied.
- `completed`: `{ destinationPath, action, entityId?, entityType?, replaced?, recoveredAfterTimeout? }`,
  where `action` is `create_folder` or `upload`, and `replaced` says whether something was at the
  path before an upload.
- `skipped`: `{ destinationPath, localPath, entityType }`, with `onConflict: "skip"` only.
- `failed`: `{ destinationPath, action, errorCode, message }`, where `errorCode` is one of the
  codes in the [safety model](safety.md#error-codes).
- `remaining`: `{ destinationPath, action }`, what was not attempted after `stopOnError` or
  `RATE_LIMITED` stopped the call.
- `verified`: `true` when the tree was read back and every completed upload was confirmed in it,
  or when nothing was attempted; `false` when the read-back failed, in which case the entries are
  as the uploads reported them.

No upload is sent twice. A client that sends a progress token receives `notifications/progress` as
each file is uploaded; on the command line, `--progress` writes the same steps to stderr as JSON
lines.

### `download_file` <small>destructive</small>

Save one document or binary file to a local path. It changes nothing on Overleaf; it is annotated
destructive, not read-only, because it writes a local file and can replace one.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Entity to download; folders are refused |
| `localPath` | yes | Where to write it |
| `overwrite` | no | Replace `localPath` if it exists; default `false` |

Returns `bytes` and `localPath`, as it was given rather than resolved. Fails with
`INVALID_ARGUMENT` when the local file exists and
`overwrite` is not `true`. The local checks all run before anything is requested from Overleaf:
that one, a folder or a symbolic link to a folder at `localPath` (`INVALID_ARGUMENT` whatever
`overwrite` is), and the parent folder, which must exist (else `NOT_FOUND`) and be writable (else
`INVALID_ARGUMENT` with `details.errno`, such as `EACCES`), with `overwrite: true` too. With
`overwrite: true` an existing file is replaced atomically: the download is written to a temporary
file in the same folder and renamed over it, so a failed write leaves the old file whole. The new
file keeps the old one's permission bits, and a symbolic link to a file is kept while the file it
leads to is replaced. A local write that fails after the download is `NOT_FOUND` for a missing
folder and `INVALID_ARGUMENT` otherwise, with the errno code in `details.errno`. A `localPath`
that is the saved session's cookie jar or browser profile, or lies outside
`OVERLEAF_LOCAL_WRITE_ROOTS` when that is set, fails with `PATH_OUTSIDE_ROOT` before anything is
downloaded. The same goes for a `localPath` that leads there through a symbolic link, or through
a `..` after one.

### `download_project_zip` <small>destructive</small>

Save the whole project, sources and binaries, as one zip archive on the server's disk: the same
archive as Overleaf's "Download as zip".

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `localPath` | yes | Where to write the archive; its folder must exist |
| `overwrite` | no | Replace `localPath` if it exists; default `false` |
| `timeoutMs` | no | How long the whole transfer may take, 1 second to 15 minutes; default 5 minutes |

The local checks run before anything is requested: the saved session's files, and a path outside
`OVERLEAF_LOCAL_WRITE_ROOTS` when that is set, are `PATH_OUTSIDE_ROOT`, a missing parent folder is
`NOT_FOUND`, a folder at `localPath` is `INVALID_ARGUMENT`, and an existing file without
`overwrite: true` is `CONFIRMATION_MISMATCH` (where `download_file`, which also checks before the
request, answers `INVALID_ARGUMENT`). The temporary file the archive is streamed to is created in
the same folder at this point too, so a folder that cannot be written fails with `INVALID_ARGUMENT` (`details.errno`, such as `EACCES`) before the request uses
up any of Overleaf's allowance. The archive must start with a zip signature, else the call fails
with `PROTOCOL_UNSUPPORTED`, and end with a complete zip end record. Overleaf builds the archive
while it sends it, so a transfer cut short still arrives with HTTP 200; one without that end
record, or one that stops before its first four bytes, fails with `REMOTE_ERROR`,
`retryable: true`. Either way nothing is written. Only
a complete archive is moved into place. With `overwrite: true` the existing file is replaced in
one step, so a failed download leaves it intact; without it, a file that appeared at `localPath`
in the meantime is not replaced (`CONFIRMATION_MISMATCH`). The temporary file is removed on every
failure.

The end check catches a truncated transfer, not a missing file: if Overleaf fails to read one
file while building the archive, it leaves that file out of an otherwise well-formed archive and
reports no error. For a backup that must be complete, compare the archive's contents with
`get_project_tree`.

Overleaf allows about 10 downloads per project a minute. It sends no `Retry-After`, so
`RATE_LIMITED` normally has no `details.retryAfterMs`: wait a minute before trying again. Nothing
is written. Overleaf checks this route's project access rather than the login, so an expired
session shows up as `PERMISSION_DENIED` rather than `AUTH_EXPIRED`; check `auth_status`.

It changes nothing on Overleaf; it is annotated destructive because it can replace a local file.
Take one as a backup before a mirror `sync_directory` or a large `batch_upload` with
`onConflict: "overwrite"`.

Returns `projectId`, `localPath` resolved to an absolute path, `bytes`, and `replaced` (whether a
file existed at `localPath`).

## Choosing between `write_file` and `upload_file`

| Need | Tool | Revision check | Tracked changes | Content source |
| --- | --- | :---: | :---: | --- |
| Small edit, or collaborators may be editing | `write_file` with `content` | yes | optional | inline |
| Replace a large text file safely | `write_file` with `localPath` | yes | optional | disk |
| Replace a binary, or push text when nobody else is editing | `upload_file` with `overwrite` or `uncheckedDocumentReplace` | no | account setting | disk |
| Upload a list of files to paths you choose | `batch_upload` | no | account setting | disk |
| Bring a whole folder up to date | `plan_sync`, then `sync_directory` | yes, for documents | optional | disk |

"Account setting" means the caller does not choose: replacing an existing document by upload is
recorded as tracked changes when track changes is already on for this account, and untracked
otherwise. A binary, or a new file, is never tracked.

Neither is limited by file size in practice: `DOC_TOO_LARGE` applies at the advertised
`ol-maxDocLength` (2,097,152 UTF-16 code units by default) and `UPDATE_TOO_LARGE` at 7,340,032
serialized characters. A 115 KB document uses about 5% of the document limit. The practical
ceiling on inline `content` is the MCP client's tool-argument budget, which `localPath` avoids.

## Folder sync and bulk delete

`plan_sync` and `sync_directory` compare a local folder with a project folder and make the
project match it; `delete_entities` removes several entities at once. All three are compositions
of the tools above, so they inherit their checks: changed text documents are replaced through
the same revision-checked, verified edit as `write_file`, binaries through the same upload as
`upload_file`, and deletes through `manage_entity`. They save tool calls and context,
not time: every step still runs through the project's one queue, one after another. A client that
sends a progress token receives `notifications/progress` as documents are read and files are
applied; on the command line, `--progress` writes the same steps to stderr as JSON lines.

The usual sequence is `plan_sync`, a look at the plan with the user, then `sync_directory` with
the plan's `planToken`. The reference cleanup this tool was designed from, four changed files
uploaded, twenty stale entities deleted, and nine identical figures left alone, is those two
calls.

### How the two sides are compared

| Local | Project | Compared by | Result |
| --- | --- | --- | --- |
| file | nothing | | `toUpload`, `reason: "new"` |
| file | binary `file` | git blob hash against the tree's `hash`, at no cost | `identical`, or `toUpload` with `comparedBy: "hash"` |
| UTF-8 file | text `doc` | reading the document and comparing LF-normalized text; a leading byte order mark is ignored | `identical`, or `toUpload` with `comparedBy: "content"` |
| non-UTF-8 file | text `doc` | | `conflicts`, `not_utf8_text` |
| file | folder | | `conflicts`, `local_file_remote_folder` |
| folder | `doc` or `file` | | `conflicts`, `local_folder_remote_file`; nothing inside the folder is compared |
| nothing | anything | | `remoteOnly`, collapsed to the highest folder |

Documents carry no hash, so each document with a local counterpart, and each one only the
project has, is read once, one document join through the project's queue. That suits tens of
documents, not thousands. A binary stored without a hash, which only very old projects have,
is listed as changed without `comparedBy`.

**Ignore rules** are gitignore-style and apply to both sides. The defaults are `.git/`,
`.DS_Store`, hidden files and folders (`.*`), `__MACOSX/`, and LaTeX build output: `*.aux`,
`*.log`, `*.bbl`, `*.blg`, `*.out`, `*.toc`, `*.synctex.gz`, `*.fdb_latexmk`, and `*.fls`. A
`.olignore` file at the top of the local folder, the one `overleaf-sync` uses, is applied next,
and the `ignore` parameter last, so `"!.latexmkrc"` re-includes a file a default excludes.
Patterns match case-insensitively, and a folder pattern such as `build/` covers everything
inside. An ignored path is never uploaded, and a project entity an ignore rule matches is
never compared or deleted, so mirror mode cannot remove a file the sync was told to leave
alone. A folder that holds such a protected entity is not deleted as a whole; its other contents
are listed one by one.

**Local paths.** `localFolderPath` is resolved on the disk of the machine the server runs on, so
pass an absolute path: a relative one resolves against the server's working directory, which the
MCP client chooses, or, on the command line, the shell's. `plan_sync` reports the path it
resolved.
Symbolic links are followed only when they resolve inside it; one that leads outside fails the
call with `PATH_OUTSIDE_ROOT` before anything is compared, unless an ignore pattern excludes
it. A linked folder that leads back into one of its own parents is refused as a cycle. The
walk stops with `INVALID_ARGUMENT` above 2,000 files that are not ignored, Overleaf's own limit
for one project, or 20,000 entries in all. Files are hashed as they are read, streaming those
larger than 8 MB.

### `plan_sync` <small>read-only</small>

Compare a local folder with a project folder and report what `sync_directory` would do. Nothing
is changed.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `localFolderPath` | yes | Local folder on the server's disk |
| `destinationFolderPath` | no | Project folder the local folder corresponds to; default `""`, the project root |
| `ignore` | no | Extra gitignore-style patterns, applied after the defaults and `.olignore` |
| `verbose` | no | List every identical path and ignored entry instead of the first 25; default `false` |

Returns:

- `planToken`, to pass to `sync_directory`.
- `localFolderPath`, resolved to an absolute path, and `destinationFolderPath`.
- `toUpload`: `{ localPath, destinationPath, reason, comparedBy?, remoteType? }` for every new or
  changed file. `localPath` is relative to the local folder; `remoteType` says what the project
  holds today for a changed entry, `doc` (replaced with a revision-checked write) or `file`
  (replaced by upload).
- `identical`: `{ count, paths }`, the first 25 paths unless `verbose`.
- `remoteOnly`: `{ destinationPath, entityId, type, contains? }` for what mirror mode would
  delete. A folder the local side does not have is one entry, and `contains` says how many
  entities inside it go with it.
- `conflicts`: `{ localPath, destinationPath, reason, message }` for what a sync cannot apply
  on its own. Resolve these by hand, for example with `delete_entities`, then plan again.
- `ignored`: `{ count, entries }`, each `{ localPath, matchedPattern }`, or `{ localPath, reason }`
  for a broken symbolic link or something that is neither a file nor a folder. An ignored folder
  is one entry ending in `/`; nothing inside it is read.

### `sync_directory` <small>destructive</small>

Make a project folder match a local folder.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `localFolderPath` | yes | Local folder on the server's disk |
| `mode` | yes | `additive` uploads and writes only; `mirror` also deletes what exists only in the project |
| `destinationFolderPath` | no | As for `plan_sync`; default `""` |
| `planToken` | unless `unplanned` | From `plan_sync`, or from a partial `sync_directory` to resume it |
| `unplanned` | no | `true` runs an additive sync without a `planToken` on purpose; refused with a `planToken` or in mirror mode |
| `confirmDeleteCount` | for `mirror` | The number of entries in `plan_sync`'s `remoteOnly`, each folder counting once |
| `ignore` | no | As for `plan_sync`; must match the plan's when a `planToken` is given |
| `writeMode` | no | `untracked` (default) or `tracked` |
| `stopOnError` | no | Stop at the first failure instead of continuing; default `false` |

What happens, in order:

1. Before anything is read: `unplanned: true` with a `planToken`, or in mirror mode, is
   `INVALID_ARGUMENT`, and a call with neither a `planToken` nor `unplanned: true` is
   `CONFIRMATION_MISMATCH` with `details.missing: "planToken"`. The folder and the project are
   then compared again, exactly as `plan_sync` does. With `unplanned: true` there is no plan to
   compare them with, so the additive sync applies what it finds now. With a `planToken`, a sync whose project side or local side differs from the plan fails with
   `REMOTE_DRIFT` and changes nothing; `details.changed` is `remote`, `local`, or `both`. The
   token covers every entity in scope, identical ones included, so a collaborator's edit to a
   file the plan called identical stops the sync instead of being overwritten. A token issued
   for a different project, folder, destination, or ignore list is `INVALID_ARGUMENT`.
2. In mirror mode, `confirmDeleteCount` must equal the number of remote-only entries, else
   `CONFIRMATION_MISMATCH` and nothing changes.
3. Uploads and writes, in path order. Missing folders are created first, each once; a folder
   that could not be created is not tried again for the next file inside it. Only folders that
   hold an uploaded file are created, so an empty local folder is not reproduced. A changed document
   is replaced with `write_file` semantics against the revision just compared, so a concurrent
   edit fails that one file with `REVISION_CONFLICT` and is never overwritten. A changed binary
   and every new file are uploaded, and Overleaf decides whether a new file is a document or a
   binary. The upload checks, just before it is sent, that a new path is still empty and a changed
   binary still has the hash the plan compared; anything else fails that file with `REMOTE_DRIFT`,
   which also withholds every delete. A document write or tracked create follows `write_file`'s
   rules, so on a ShareJS document text that adds a character outside the Basic Multilingual
   Plane, such as an emoji, or reorders existing ones, fails that file with `INVALID_ARGUMENT`.
   With `writeMode: "tracked"`, changed documents are written as tracked changes, and
   new files Overleaf treats as text (`.tex`, `.bib`, `.sty`, `.cls`, `.bst`, `.txt`, and
   similar) are created as documents with tracked content, the way `create_file` does, since a
   new file created by upload is never tracked content; binaries are uploaded as usual.
   Conflicts from the plan are reported as failures.
4. The tree is read back, and an upload that is not there, or whose hash does not match the
   local file, is moved to `failed` with `REMOTE_ERROR`.
5. Deletes, in mirror mode only, and only if nothing so far failed. Just before each delete, the
   entity's id, and for a folder everything inside it, is checked against the plan; anything
   that changed is left in place and reported as `REMOTE_DRIFT`.

No step is retried automatically. Returns `status` (`complete`, or `partial` when anything failed
or was not attempted), `mode`, `completed` (`{ destinationPath, action, entityId? }`), `failed`
(`{ destinationPath, action, errorCode, message, details?, kind? }`, where `errorCode` is one of the codes
in the [safety model](safety.md#error-codes) and `details` is the failed step's own error
details, such as `reason`, `status`, `outcome`, `liveRevision`, or `created`, and `kind:
"applied_untracked"` beside them when a tracked step applied without being recorded as tracked
changes),
`remaining` (`{ destinationPath, action }`, what was not attempted), `identicalCount`,
`planToken`, `planned` (whether the call was checked against a `planToken`; `false` only with
`unplanned: true`).
`action` is `create_folder`, `upload`, `write`, `create`, or `delete`.

The returned `planToken` describes the state this sync left: what it changed as the project now
shows it, and everything else as it was planned. Re-running with it resumes a partial sync, and
still stops with `REMOTE_DRIFT` if someone changed something in between, including a document
whose write failed with `REVISION_CONFLICT`: that one needs a fresh plan and a look at what the
collaborator changed. A `create` that failed after its document was made (its failure has
`details.created: true`) leaves that document in the project. The token counts it as this sync's
change while it is still empty or holds exactly the local text, so resuming writes it through a
revision-checked write, or finds it identical; if someone edited it in between, the resume stops
with `REMOTE_DRIFT`. That failure's message says so: do not create or write the document by hand,
since that moves the revision the token pins and the resume then stops with `REMOTE_DRIFT`. The
token is absent when the project could not be read back after the
changes; plan again before resuming.

### `delete_entities` <small>destructive</small>

Delete several documents, files, or folders in one call.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `paths` | yes | Project paths, 1 to 500 |
| `confirmCount` | yes | Must equal the number of `paths`, else `CONFIRMATION_MISMATCH` |
| `stopOnError` | no | Stop at the first failure instead of continuing; default `false` |

Every path is resolved before anything is deleted, so a missing path fails the whole call with
`NOT_FOUND` and changes nothing. A path listed twice, or one inside a folder that is also listed,
is `INVALID_ARGUMENT`: deleting a folder removes everything inside it, so list the folder alone.
Returns `status`, `completed` (`{ path, type, entityId }`), `failed`
(`{ path, errorCode, message }`, where `errorCode` is one of the codes in the
[safety model](safety.md#error-codes)), and `remaining` (`{ path }`).

## LaTeX sections

Section tools work on one file at a time unless asked to follow includes. They recognize starred
headings and optional titles, ignore `%` comments, the `verbatim`, `verbatim*`, `lstlisting`,
`minted`, and `comment` environments, and inline `\verb`, `\verb*`, and `\lstinline` arguments,
and by default never follow `\input` or `\include`. Inside those environments and arguments, `%`
is literal text. Outside them, `\%` is a literal percent sign, while `\\%` is a line break followed
by a comment. In the same way, `text\\section{X}` is a line break followed by the text
`section{X}`, not a heading: the parity of the run of backslashes before a `%` or a heading name
decides.

### Documents split across files

`get_full_document` flattens a document the way `latexpand` does, and the three section tools
work on that flattened text when called with `followIncludes: true`. These directives are
followed, recursively:

| Directive | Path tried |
| --- | --- |
| `\input{x}`, `\input x` | `x`, then `x.tex` |
| `\include{x}` | `x.tex` only; skipped when an earlier `\includeonly` leaves it out |
| `\subfile{x}` | `x`, then `x.tex`; only the text between its `\begin{document}` and `\end{document}` is taken in |
| `\import{dir}{x}`, `\inputfrom{dir}{x}` | `dir/x`, then `dir/x.tex` |
| `\includefrom{dir}{x}` | `dir/x.tex`, as `\include` |
| `\subimport{dir}{x}`, `\subinputfrom{dir}{x}`, `\subincludefrom{dir}{x}` | as above, with `dir` relative to the including file |

A path is looked up relative to the project root first, as Overleaf compiles from there, and
then relative to the including file's folder; for `\subimport` and its relatives, the including
file's folder comes first. Directives in `%` comments and verbatim text are skipped, as headings
are. `\include` adds no page breaks to the flattened text: every character of it comes from a
file. A directive that cannot be followed is left in the text as written and listed in
`unresolved`, with one of these reasons:

| `reason` | Meaning |
| --- | --- |
| `missing` | No text document at any candidate path, or the path leaves the project |
| `binary_file` | The path names an uploaded binary file, not a text document |
| `macro_argument` | The path uses a macro or a parameter such as `#1`, braced or not (`\input\chapterfile`, on the same line), so it cannot be read from the source. `\input` used as a token, as in `\let\oldinput\input`, is no directive |
| `excluded_by_includeonly` | An `\include` that the `\includeonly` list leaves out, as LaTeX would |

A cycle of includes fails with `INCLUDE_CYCLE`, and `details.chain` lists the files in it.
Includes nested deeper than `maxDepth` fail with `INCLUDE_DEPTH_EXCEEDED`; `maxDepth` is a limit,
never a cut-off, so it cannot make a result shorter. Two limits bound the work, and both fail
with `DOC_TOO_LARGE`: a flattened text longer than 8,388,608 UTF-16 code units
(`details.kind: "flattened"`), and include directives that take in files more than 10,000 times
in all, counting a file once for each time it is included (`details.kind: "includes"`). For
either, start from a file further down the includes, or read the files one at a time with
`read_file`.

The flattened text joins each file's text to whatever follows its directive, with nothing in
between, exactly as the files hold it. A `%` comment on the last line of a file that does not end
with a line break therefore reads on into the following text if the flattened text is compiled as
it is. TeX ends the comment with the file, and the section tools do the same: they read comments
and verbatim text file by file, so such a comment never hides a heading after the directive.

### `get_full_document` <small>read-only</small>

Read a document with every file it includes put in place of its include directive.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `rootFilePath` | no | Document to start from; defaults to the root document configured in Overleaf |
| `maxDepth` | no | Levels of includes to follow below the root, 1 to 32; default 10 |

Returns `rootFilePath`, `text`, `files` (every file visited, each once, in the order first
visited), `unresolved` (`{ file, line, target, reason }`, `line` 1-based), `includeOnly` when a
file sets an `\includeonly` list, and `sourceMap`. Each source-map entry is one run of `text`
copied unchanged from one file:
`{ flattenedStart, flattenedEnd, filePath, docId, originalStart, originalEnd, revision }`. The
offsets are UTF-16 code units, half-open, into `text` and into the file's LF-normalized content.
`revision` is the file's revision, as `read_file` returns it. To change something seen in the
flattened text, find its entry, then write that file with `write_file`, or its section with
`write_section`, against that revision. The flattened text is never written back anywhere. Each
file is read on its own, so a file can change between two reads; every revision matches the text
it was read with.

### `get_sections` <small>read-only</small>

Parse the section headings of one file, or of a document across its included files.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Document to parse; with `followIncludes`, the document to start from |
| `followIncludes` | no | Follow include directives as `get_full_document` does; default `false` |

Returns `sections`, `revision` (that of `filePath`), and `singleFileOnly`. Each section has an
`id` to pass to the other two section tools, its `index` (its position among the headings, from
0), its `command` (`part`, `chapter`, `section`, `subsection`, `subsubsection`, `paragraph`, or
`subparagraph`), `level`, `starred`, `title`, optional `shortTitle`, and character offsets
`start`, `headingEnd`, `bodyStart`, and `end`.

By default `singleFileOnly` is `true` and the offsets are into the file's LF-normalized content.
With `followIncludes: true`, `singleFileOnly` is `false`, the offsets are into the flattened text
`get_full_document` returns, `unresolved` lists the directives that could not be followed, and
each section adds:

- `filePath`, the file that holds its heading;
- `revision`, that file's revision, to pass to `write_section`;
- `spansFiles`, `true` when text from another file falls inside the section. White space alone,
  such as the line break after an `\input` line, does not count. A heading with an include
  directive inside it, or one its file ends in the middle of, also spans files, even when the
  included file is empty.

Its `id` then names the file, as `path#command:offset`, with the heading's offset in that file. A
section whose heading is in an included file ends, at the latest, where that file ends: the
including file's text after the directive, such as `\bibliography` or `\end{document}`, is part
of no section.

### `get_section_content` <small>read-only</small>

Read one section's body.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Document; with `followIncludes`, the one `get_sections` started from |
| `sectionId` | yes | From `get_sections` |
| `followIncludes` | no | Pass `true` for an id from `get_sections` with `followIncludes: true`; default `false` |

Returns `content` (the body text), the matching `section` record, and the `revision` of the file
the section is in. A section's body runs from the line after its heading to the next heading at
the same or a higher level. It therefore includes any nested subsections, and the last section's
body runs to the end of the file, including `\end{document}`.

With `followIncludes: true`, a section that lies in one file is read as that file holds it, with
any include directive in its body kept as written: exactly the text `write_section` replaces. A
section with `spansFiles: true` is read as flattened text across its files, for reading only. An
id that names a file, given without `followIncludes: true`, is `NOT_FOUND`, and so is a
single-file id such as `section:17` given with it: the two modes end a body in different places,
so a body read in one mode and written in the other could drop or repeat an include directive.

### `write_section` <small>destructive</small>

Replace one section's body with a revision-checked write. `content` replaces the whole body as
`get_section_content` returns it, including nested subsections and, for the last section,
everything up to the end of the file such as `\end{document}`. Read the body with
`get_section_content` first and keep whatever should survive. End `content` with a newline so
that the next heading starts its own line.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Document; with `followIncludes`, the one `get_sections` started from |
| `revision` | yes | From `get_sections`, `get_section_content`, or `read_file`; with `followIncludes`, the section's `revision` |
| `sectionId` | yes | Section to replace |
| `content` | yes | New body |
| `writeMode` | no | `untracked` (default) or `tracked` |
| `followIncludes` | no | Pass `true` for an id from `get_sections` with `followIncludes: true`; default `false` |

Returns the same fields as `write_file`. Fails with `REVISION_CONFLICT` if the document changed.
The write follows `write_file`'s rules, including the refusal of content that adds a character
outside the Basic Multilingual Plane on a ShareJS document and the recovery after a timeout or a
lost socket.

With `followIncludes: true`, the body is replaced in the one file that holds the section, through
the same revision-checked write, and `filePath` in the result names that file; no other file is
touched. The revision is checked against that file before the section is looked up, so a file
changed since the sections were listed is `REVISION_CONFLICT` with `details.filePath` and
`details.liveRevision`, and nothing is sent; a token that is not a revision at all is
`INVALID_ARGUMENT`, as without `followIncludes`. Do not add the including file's `\end{document}`
to the body of a section in an included file: it is not part of that section. A section with `spansFiles: true` is refused with `INVALID_ARGUMENT`,
`details.kind: "spans_files"`, and `details.files`, before anything is sent: change each of its
files with `write_file` instead.

## Compilation

### `compile_project`

Compile the project and report on the build from its logs.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `rootFilePath` | no | Document to compile for this call only. Omitted, the root document configured in Overleaf is used, the same one the web editor's Recompile button builds |
| `timeoutMs` | no | How long to wait, 1 second to 15 minutes; default 120 seconds |
| `stopOnFirstError` | no | Stop at the first LaTeX error, for a short log holding the one error that matters |
| `draft` | no | Draft mode: images become boxes, for faster text-only builds |

Check `summary.builtCleanly`, not `status`. Overleaf compiles in nonstopmode and reports `success`
whenever a PDF came out, even when LaTeX hit errors on the way. `builtCleanly` is `true` only when
a PDF was produced, `output.log` was read, and it reports no error. After the build the server
reads the log, at most 1 MB of it, and any `.blg` BibTeX logs. Overleaf keeps an earlier build's
`output.blg` and `output.bbl` and lists them again, so `output.blg` is read only when this
build's `output.aux` makes BibTeX or Biber run (a `\bibdata`, biblatex record, or `\@input`
line), or when `output.aux` cannot be read in full. A `\citation` line alone does not count, since
`\cite` without `\bibliography` writes one and BibTeX does not run. The aux files an `\@input`
line names are not read, so a root that uses `\include` keeps the log. It returns:

- `status`: Overleaf's own, `success`, `failure` (LaTeX stopped without a PDF), or
  `stopped-on-first-error`.
- `outputFiles`: `{ path, type, build? }` for each output; the URLs Overleaf sends are dropped,
  since every output is fetched from the project's own route. It is Overleaf's own listing,
  except that on a build in which BibTeX did not run, an `output.blg` and `output.bbl` left over
  from an earlier build are left out, as the output tools treat them as not produced by this
  build.
- `stats`: Overleaf's counters, numbers only. `buildId` and `clsiServerId` when Overleaf sent them.
- `rootFilePath`: the document actually compiled.
- `buildRef`: an opaque token naming this build to `get_compile_log` and
  `download_compile_output`, in this process or a later one. Each command line call is a new
  process, so pass it on as `--build-ref`.
- `summary`: `{ status, builtCleanly, pdfProduced, logRead, errorCount, warningCount, errors,
  warnings, undefinedReferences, undefinedCitations, missingFiles, pageCount?, pdfSizeBytes? }`.
  `errors` and `warnings` hold the first 20 as `{ file?, line?, message }`; the counts cover all
  of them. A message is the error or warning line alone, cut to 240 characters, and never the
  source excerpt TeX prints after `l.<n>`. `logRead` is `false` when the build left no log or it
  could not be read, and `builtCleanly` is then `false` too.

A build that ran, `failure` included, is a result, not an error. A compile that produced no build
to report on fails, with `details` exactly `{ status, rootFilePath, buildId?, buildRef? }`
(plus `retryAfterMs` for `COMPILE_RATE_LIMITED` when known); a status that is not a short
lowercase identifier is reported as `unrecognized`:

| Overleaf status | Code | Retryable |
| --- | --- | :---: |
| `too-recently-compiled`, `rate-limited`, `autocompile-backoff`, `compile-in-progress`, or HTTP 429 | `COMPILE_RATE_LIMITED` | yes |
| `clsi-maintenance`, `unavailable` | `COMPILE_UNAVAILABLE` | yes |
| `timedout` | `COMPILE_TIMEOUT` | no |
| anything else, `terminated`, `exited`, `project-too-large`, and `validation-problems` included | `COMPILE_FAILED` | no |

A build that timed out or was terminated can still have left a log; its `details.buildRef` then
reaches it through `get_compile_log`. A `TIMEOUT` on the compile request itself is not retryable,
because Overleaf may still be compiling; wait, or call `stop_compile`, before compiling again. A
response without a `status`, or with malformed `outputFiles`, is `PROTOCOL_UNSUPPORTED` with
`details` `{ endpoint: "compile", expectedKeys, receivedKeys }`. A project with no configured root
and no `rootFilePath` fails with `INVALID_ARGUMENT`. Compiles use the account's compile
allowance; `timeoutMs` bounds only the wait.

### `stop_compile` <small>destructive</small>

Stop the active compile for a project.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |

Returns `stopped: true`.

### `get_compile_log` <small>read-only</small>

Read a build's LaTeX or BibTeX log without compiling again.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `buildRef` | no | From `compile_project`; default, the latest build `compile_project` made in this process. A command line call is a new process, so give it the `buildRef` |
| `kind` | no | `latex` (default), `output.log`; or `bibtex`, the build's `.blg` file, `NOT_FOUND` when BibTeX did not run for this build |
| `format` | no | `raw` (default), or `errors-only` for only the lines that start an error |
| `tail` | no | How many lines to return, from the end; default 200, at most 2,000 |

At most 1 MB of the log is read, from its start, as Overleaf's own editor does, and at most
100,000 characters are returned. Returns `buildId`, `file`, `log`, `truncated` (whether anything
of the log was left out), and `errorLines`, the first 100 lines that start an error as
`{ line, text }` with 1-based line numbers, each cut to 240 characters. The log quotes source
lines near each error; prefer `compile_project`'s `summary` when it is enough.

Without a `buildRef` and with no compile in this process the call fails with `NO_BUILD`. A
`buildRef` for another project is `INVALID_ARGUMENT`. A log the build did not produce is
`NOT_FOUND`, and a build Overleaf no longer keeps is `BUILD_NOT_FOUND`: compile again. With
`kind: "bibtex"`, a build in which BibTeX did not run is `NOT_FOUND` through its `buildRef` too,
and also when the build had more than 100 outputs. One known limit: the `buildRef` of a build
that timed out or was terminated is not checked this way, since its `output.aux` may be half
written, so its `.blg` can still be one left over from an earlier build.

### `download_compile_output` <small>destructive</small>

Save a build's PDF, or another output file, to a local path on the server's disk.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `localPath` | yes | Local file to write; its folder must exist |
| `file` | no | Output path in the build, such as `output.log`, `output.blg`, or `output.synctex.gz`; default `output.pdf` |
| `buildRef` | no | From `compile_project`; default, the latest build in this process. A command line call is a new process, so give it the `buildRef` |
| `overwrite` | no | Replace `localPath` if it already exists; default `false` |

`file` must be a relative path without `..`, `\`, or control characters, else `INVALID_ARGUMENT`
before anything is requested. It is requested only from the project's own route,
`/project/<projectId>/build/<buildId>/output/<file>` (with `/user/<userId>` after the project on a
per-user compile, as Overleaf CE and Server Pro do by default), never from a URL in Overleaf's
response. An
existing `localPath` without `overwrite: true` is `CONFIRMATION_MISMATCH` and nothing is
downloaded; a replacement is atomic, so a failed download leaves the old file. A `.pdf` that does
not start with `%PDF-` is `PROTOCOL_UNSUPPORTED` and nothing is written. `NO_BUILD`, `NOT_FOUND`,
and `BUILD_NOT_FOUND` are as for `get_compile_log`; an `output.blg` or `output.bbl` left over from
an earlier build is `NOT_FOUND`, like any file the build did not produce. Returns the absolute
`localPath`, `file`, `sizeBytes`, `buildId`, and `replaced`.

### Compile output resources

The server also offers two read-only MCP resources for the latest build of a project in this
process: `overleaf://project/{projectId}/output/output.log` (text, the first 1 MB) and
`overleaf://project/{projectId}/output/output.pdf` (a PDF of at most 16 MB; use
`download_compile_output` for a larger one). Reading one before the project was compiled fails
with `NO_BUILD`.

## Review

Review comments and tracked changes need an Overleaf deployment and plan that support them.
Positions use 1-based lines and UTF-16 columns.

### `list_comments` <small>read-only</small>

List comment threads, resolving their document positions lazily.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | no | Only threads anchored in this document |
| `status` | no | `open` (default), `resolved`, or `all` |
| `author` | no | Only threads with a message whose author display name contains this (case-insensitive), or whose author id equals it |

Returns `threads`, each with `id`, `status`, `messages` (each `id`, `author` as
`{ id, displayName }` or `null` when Overleaf names no user, `content`, and an ISO `timestamp`),
`resolvedAt` and `resolvedBy` (`{ id, displayName }`) on a resolved thread when Overleaf reports
them, and when located `filePath`, `start`, `end`, and `quotedText`. No email address is ever
returned. A thread without a document range has `unlocated: true`. If the deployment offers no
project-wide range index and no `filePath` was given, the result has `positionsUnavailable: true`
rather than scanning every document.

### `reply_to_comment`

Reply in an existing thread.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `threadId` | yes | From `list_comments` |
| `content` | yes | Message text |

A `threadId` that names no existing thread fails with `NOT_FOUND` and nothing is posted. The
project's track-changes state is read before the reply is posted, so a project join that fails
leaves nothing posted and is safe to retry. Returns
`threadId` and the created `message` (`id`, `author` `{ id, displayName }`, `content`,
`timestamp`), plus `trackChangesActive`, `writeMode`, and `recoveredAfterTimeout: true` when a
timed-out reply was confirmed. The created message is the one message that was not in the thread
before the reply, from this account, with this content. A reply that timed out is accepted only
when the refreshed thread shows exactly one such new message within the request window, so no
reply is posted twice. If Overleaf accepted the reply but it cannot be singled out when read
back, the call fails with `OUTCOME_UNKNOWN`; do not retry it.

### `add_comment`

Create a thread anchored to exact text.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Document |
| `revision` | yes | From a fresh `read_file` |
| `start`, `end` | yes | `{ line, column }`, 1-based, UTF-16 columns |
| `expectedText` | yes | Must equal the normalized text in that range exactly |
| `content` | yes | Comment text |

Returns `threadId`, the created `thread` in the same shape as `list_comments` (without position
fields) when it could be read back, and verification details: `revision`, `protocol`,
`trackChangesActive`, `writeMode`, and `recoveredAfterTimeout`. The thread is created and then
attached to the range through OT. An attachment that timed out, lost its socket after it was
sent, or whose verification read failed is never resent: the document is observed for a bounded
window. `recoveredAfterTimeout: true` means the range was found; `OUTCOME_UNKNOWN` with
`details.threadId` means it could not be settled. Only when the unchanged document proves the
attachment never applied is the orphaned thread removed, and the error is `TIMEOUT`, or
`REMOTE_ERROR` after a lost socket, with `details.outcome: "not_applied"` and `retryable: false`.
An attachment Overleaf acknowledged is never removed.

### `set_comment_status` <small>destructive</small>

Resolve or reopen a thread.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Document the thread is anchored in |
| `revision` | yes | Latest revision of that document |
| `threadId` | yes | Thread to change |
| `status` | yes | `open` or `resolved` |

A thread not anchored in `filePath` fails with `NOT_FOUND` and nothing changes. Returns
`threadId`, the verified `status`, the resulting `revision`, `trackChangesActive`,
`writeMode: "untracked"`, and `recoveredAfterTimeout: true` when the change was confirmed by
observation. On a history-OT document the status is verified from the
document snapshot, also for a comment whose anchored text was deleted. A change that timed out,
lost its socket, or whose verification read failed is never resent but observed:
`recoveredAfterTimeout: true` when the requested status is live, `TIMEOUT`, or `REMOTE_ERROR`
after a lost socket, with `details.outcome: "not_applied"` and `retryable: false` when it never
appeared, and `OUTCOME_UNKNOWN` when it cannot be observed, or when Overleaf accepted the change
but the requested status was not seen.

### `list_tracked_changes` <small>read-only</small>

List tracked changes (suggestions) and where they are.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | no | Only this document, read directly rather than through the range index |
| `type` | no | `insert` or `delete` |
| `authorId` | no | Only changes by this Overleaf user id |
| `excerptChars` | no | Longest excerpt of each change in UTF-16 units, 0 to 500, default 120; 0 for none |
| `limit` | no | Most changes returned across all documents, 1 to 500, default 100 |

Returns `documents`, `totalMatched` (every change that matched, before `limit`), `truncated`,
and `trackChangesActive`. Each document has `filePath`, `revision` (pass it to
`manage_tracked_changes`), `protocol`, `totalChanges` (every tracked change in the document,
unfiltered), `undecidableChanges` when Overleaf stored some changes without an id, which cannot
be decided here, and `changes`. Each change has `changeId`, `type`, `start` and `end` (1-based
line and UTF-16 column in the text `read_file` returns; a delete is a point, so its `start`
equals its `end`), `length` in UTF-16 units, `excerpt` (the inserted or deleted text, cut to
`excerptChars` without splitting a surrogate pair) with `excerptTruncated`, `authorId` (an
Overleaf user id, or `null`), an ISO `timestamp`, and `pairedChangeId` linking the insert and the
delete of one replacement. No email address is ever returned.

With `filePath`, that document is read and its list is authoritative. Without it, Overleaf's
project range index only chooses which documents to read: just the documents it lists with
changes are read, never every document, and its change ids are never used. The index may lag or
leave a document out, so name a document with `filePath` for an authoritative list; this matters
most for history-OT documents, whose index ids are never valid. When the deployment has no
index, the result has `indexUnavailable: true` and no document is read. Ids merge and split as the
document is edited, and history-OT ids are made up by this server from the change itself, valid
only with the revision they were listed with, so list again before deciding.

### `manage_tracked_changes` <small>destructive</small>

Accept or reject tracked changes in one document.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | The document the changes are in |
| `revision` | yes | The revision `list_tracked_changes` returned for that document |
| `action` | yes | `accept` or `reject` |
| `changeIds` | yes | 1 to 500 `changeId` values, each once |
| `confirmCount` | yes, in practice | Must equal the number of `changeIds`, after the user has confirmed them |

Accepting an insert keeps its text and accepting a delete removes it; rejecting an insert removes
its text and rejecting a delete restores it. A tracked replacement is an insert and a delete
linked by `pairedChangeId`: pass both ids. Before anything is sent, in this order: a missing or
different `confirmCount` is `CONFIRMATION_MISMATCH`; access other than owner or edit (a
review-only or read-only collaborator) is `PERMISSION_DENIED`; a project whose owner's plan or
whose deployment does not offer track changes is `REVIEW_UNSUPPORTED` with
`details.kind: "feature_disabled"`; a stale revision is `REVISION_CONFLICT`; an id that is not a
tracked change in the document is `NOT_FOUND` with `details.missingChangeIds`; and a change left
out that overlaps a chosen one is `INVALID_ARGUMENT` with `details.overlappingChangeIds`.
`REVIEW_UNSUPPORTED` with `details.kind` `route_unavailable` or `document_protocol` means this
Overleaf cannot decide changes that way.

On a ShareJS (legacy editor) document an accept goes through Overleaf's accept route and a reject
is one untracked edit that undoes the changes; on a history-OT document both are one untracked
edit. Rejecting on a ShareJS document may notify the change's author; on a history-OT document it
does not. The decision is sent once and verified on a fresh read. One that timed out is observed,
never resent: `recoveredAfterTimeout: true` when it applied, `TIMEOUT`, or `REMOTE_ERROR` after a
lost socket or a server error, with `details.outcome: "not_applied"` when the changes stayed as
they were, `REVISION_CONFLICT` with `details.outcome: "unknown"` when the document changed
meanwhile, and `OUTCOME_UNKNOWN` when it could not be observed. A repeated decision changes
nothing: it fails with `REVISION_CONFLICT` when the first one changed the document's revision, as
every reject and every history-OT decision does, or with `NOT_FOUND` when it did not, as after an
accept on a ShareJS document, which leaves the revision as it was.

Returns `action`, `filePath`, `changeIds`, the resulting `revision` and `protocol`,
`remainingChangeCount` (tracked changes left in the document), `trackChangesActive`, and
`recoveredAfterTimeout`. List again after every decision.

## History

### `monitor_project_history` <small>read-only</small>

Poll one recent window of project history.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `sinceVersion` | no | Return only update groups newer than this version, and in them only project operations at or after it |

Returns `projectId`, `currentVersion` (`null` when the window is empty), `nextSinceVersion` to
pass on the next poll (on an empty window, the `sinceVersion` you passed, or `null` without one),
`hasEarlierHistory`, `gapDetected` (true when the cursor predates the
single window returned), and `updates`, newest first. Each update has:

- `fromVersion`, `toVersion`, and ISO `startedAt` and `endedAt`.
- `authors`: `{ id, displayName }`, or `null` for an author Overleaf does not name. Emails are
  stripped.
- `paths`: the documents and files the update touched.
- `projectOperations`: `{ type, atVersion, path }`, where `type` is `add`, `rename` (with
  `newPath`), or `remove`.
- `labels`: `{ id, comment, version, createdAt, userId, userDisplayName }`, where `userId` and
  `userDisplayName` can be `null`.
- `origin`: `{ kind, path?, timestamp?, version? }`, or `null`.

Overleaf can merge new changes into an update group between polls, so a group may start before
`sinceVersion`. Such a group keeps its full `fromVersion`, `startedAt`, `paths`, and `labels`, but
its `projectOperations` list only operations with `atVersion` at or after `sinceVersion`. An
operation at `atVersion` produces version `atVersion + 1`, so passing `nextSinceVersion` back
never skips an operation and never repeats one. This is stateless polling, not a background
watcher, and it never pages backward or computes diffs.
