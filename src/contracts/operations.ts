import { z } from 'zod'

import { DEFAULT_PROJECT_LIMIT, MAX_PROJECT_LIMIT } from '../overleaf/account.js'
import { DEFAULT_LOG_TAIL, MAX_ERROR_LINES, MAX_LOG_CHARS, MAX_LOG_TAIL } from '../overleaf/compile.js'
import { MAX_LOG_ENTRIES, MAX_MESSAGE_LENGTH } from '../overleaf/compile-log.js'
import { DEFAULT_INCLUDE_DEPTH, MAX_FLATTENED_LENGTH, MAX_INCLUDE_DEPTH } from '../core/includes.js'
import { SECTION_COMMANDS } from '../core/sections.js'
import { COMPILERS, DEFAULT_ZIP_DOWNLOAD_TIMEOUT_MS } from '../overleaf/projects.js'
import { BATCH_UPLOAD_LIMIT } from '../overleaf/sync.js'
import {
  DEFAULT_EXCERPT_CHARS,
  DEFAULT_TRACKED_CHANGE_LIMIT,
  MAX_CHANGE_IDS,
  MAX_EXCERPT_CHARS,
  MAX_TRACKED_CHANGE_LIMIT,
} from '../overleaf/tracked-changes.js'
import type { Effect } from './effects.js'
import { ERROR_CODES } from './error-codes.js'

/**
 * Operation ids, in registration order. They are the MCP tool names and, from v0.7.0, the CLI
 * and SDK names.
 */
export const OPERATION_NAMES = [
  'auth_status',
  'list_projects',
  'create_project',
  'clone_project',
  'import_project_zip',
  'manage_project',
  'update_project_settings',
  'get_project_tree',
  'read_file',
  'write_file',
  'create_file',
  'manage_entity',
  'upload_file',
  'batch_upload',
  'download_file',
  'download_project_zip',
  'plan_sync',
  'sync_directory',
  'delete_entities',
  'get_full_document',
  'get_sections',
  'get_section_content',
  'write_section',
  'compile_project',
  'stop_compile',
  'get_compile_log',
  'download_compile_output',
  'list_comments',
  'reply_to_comment',
  'add_comment',
  'set_comment_status',
  'list_tracked_changes',
  'manage_tracked_changes',
  'monitor_project_history',
] as const

export type OperationName = (typeof OPERATION_NAMES)[number]

/** MCP tool annotations. `readOnlyHint` means nothing changes on Overleaf and nothing is written locally. */
export interface OperationAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
}

/** One operation, defined once for every interface. */
export interface OperationContract {
  /** Self-sufficient: it, plus the server instructions, is what an agent reads at runtime. */
  description: string
  /** Absent for an operation without parameters. */
  inputSchema?: z.ZodObject
  /** The result, returned as structured content; MCP clients may validate it, and read-only results are checked. */
  outputSchema: z.ZodObject
  annotations: OperationAnnotations
  /** Everything the operation can do; the access policy refuses it before any work otherwise. */
  effects: readonly Effect[]
}

const projectId = z.string().min(1).describe('Overleaf project ID')
const filePath = z.string().min(1).describe('Project-relative path using forward slashes')
const revision = z.string().min(1).describe('Opaque revision returned by a prior read or write')
const writeModeSchema = z.enum(['untracked', 'tracked'])
const writeMode = writeModeSchema
  .default('untracked')
  .describe('Use tracked to record inserted and deleted text as Overleaf tracked changes; defaults to untracked')
const position = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
})

const localFolderPath = z.string().min(1).describe("Local folder on the server's own disk, synced as a whole")
const destinationFolderPath = z
  .string()
  .default('')
  .describe('Project folder the local folder corresponds to; "" (the default) is the project root')
const ignorePatterns = z
  .array(z.string().min(1).max(500))
  .max(200)
  .optional()
  .describe(
    'Extra gitignore-style patterns, applied after the defaults (hidden files and folders, __MACOSX/, and LaTeX build output: *.aux, *.log, *.bbl, *.blg, *.out, *.toc, *.synctex.gz, *.fdb_latexmk, *.fls) and after any .olignore file in the folder; "!pattern" re-includes, for example "!.latexmkrc". Ignored paths are never uploaded, compared, or deleted, on either side.'
  )
const entityTypeSchema = z.enum(['doc', 'file', 'folder'])
const entityActionSchema = z.enum(['create_folder', 'rename', 'move', 'delete'])
const syncActionSchema = z.enum(['create_folder', 'upload', 'write', 'create', 'delete'])
const errorCodeSchema = z.enum(ERROR_CODES)
const batchUploadActionSchema = z.enum(['create_folder', 'upload'])
const uncheckedDocumentReplace = z
  .boolean()
  .optional()
  .describe(
    'Allow replacing a text document, a blind write with no revision check; prefer write_file with localPath when a collaborator may be editing'
  )

const otProtocolSchema = z.enum(['sharejs', 'history-ot'])

/** What every revision-checked text write returns: write_file, create_file, and write_section. */
const documentWriteSchema = z.object({
  revision: z.string(),
  protocol: otProtocolSchema,
  trackChangesActive: z.boolean(),
  writeMode: writeModeSchema,
  recoveredAfterTimeout: z.literal(true).optional(),
})

const projectEntitySchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  type: entityTypeSchema,
  parentFolderId: z.string(),
  hash: z.string().optional(),
})

const latexSectionSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  command: z.enum(SECTION_COMMANDS),
  level: z.number().int().nonnegative(),
  starred: z.boolean(),
  title: z.string(),
  shortTitle: z.string().optional(),
  start: z.number().int().nonnegative(),
  headingEnd: z.number().int().nonnegative(),
  bodyStart: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
})

/** A section of a flattened document: offsets into the flattened text, plus the file holding its heading. */
const includedSectionSchema = latexSectionSchema.extend({
  filePath: z.string(),
  revision: z.string(),
  spansFiles: z.boolean(),
})

const unresolvedIncludeSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  target: z.string(),
  reason: z.enum(['missing', 'binary_file', 'macro_argument', 'excluded_by_includeonly']),
})

const followIncludes = z
  .boolean()
  .default(false)
  .describe(
    'Follow \\input, \\include, \\subfile, and \\import directives from filePath down, as get_full_document does; defaults to false, one file only'
  )

const logEntrySchema = z.object({
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  message: z.string(),
})

const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  accessLevel: z.string(),
  lastUpdated: z.string().optional(),
  archived: z.boolean(),
  trashed: z.boolean(),
})

const projectName = z.string().min(1).max(150).describe('Project name, 1 to 150 characters without slashes')

const createdProjectSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  url: z.string(),
})

const commentAuthorSchema = z.object({ id: z.string(), displayName: z.string() })

const commentMessageSchema = z.object({
  id: z.string().optional(),
  author: commentAuthorSchema.nullable(),
  content: z.string(),
  timestamp: z.string().optional(),
})

const commentThreadSchema = z.object({
  id: z.string(),
  status: z.enum(['open', 'resolved']),
  messages: z.array(commentMessageSchema),
  resolvedAt: z.string().optional(),
  resolvedBy: commentAuthorSchema.optional(),
})

const trackedChangeTypeSchema = z.enum(['insert', 'delete'])

const trackedChangeSchema = z.object({
  changeId: z.string(),
  type: trackedChangeTypeSchema,
  start: position,
  end: position,
  length: z.number().int().positive(),
  excerpt: z.string().optional(),
  excerptTruncated: z.boolean(),
  authorId: z.string().nullable(),
  timestamp: z.string().optional(),
  pairedChangeId: z.string().optional(),
})

const projectActionSchema = z.enum(['rename', 'trash', 'restore', 'archive', 'unarchive', 'delete'])

const historyVersion = z.number().int().nonnegative()

const historyProjectOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add'), atVersion: historyVersion, path: z.string() }),
  z.object({ type: z.literal('rename'), atVersion: historyVersion, path: z.string(), newPath: z.string() }),
  z.object({ type: z.literal('remove'), atVersion: historyVersion, path: z.string() }),
])

const historyUpdateSchema = z.object({
  fromVersion: historyVersion,
  toVersion: historyVersion,
  startedAt: z.string(),
  endedAt: z.string(),
  authors: z.array(commentAuthorSchema.nullable()),
  paths: z.array(z.string()),
  projectOperations: z.array(historyProjectOperationSchema),
  labels: z.array(
    z.object({
      id: z.string(),
      comment: z.string(),
      version: historyVersion,
      createdAt: z.string(),
      userId: z.string().nullable(),
      userDisplayName: z.string().nullable(),
    })
  ),
  origin: z
    .object({
      kind: z.string(),
      path: z.string().optional(),
      timestamp: z.string().optional(),
      version: historyVersion.optional(),
    })
    .nullable(),
})

export const OPERATIONS = {
  auth_status: {
    description:
      'Verify the saved Overleaf web session without exposing cookies. sessionExpiresAt is when the session lapses unless a request refreshes it first; Overleaf sessions last five days from their last use, and the CLI command `overleaf-web-mcp keepalive` can be scheduled to refresh them.',
    outputSchema: z.object({
      authenticated: z.literal(true),
      baseUrl: z.string(),
      userId: z.string().optional(),
      projectCount: z.number().int().nonnegative(),
      sessionExpiresAt: z.string().optional(),
      permissionsUnchecked: z.boolean(),
      warning: z.string().optional(),
      socketPresenceNotice: z.string(),
    }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
  list_projects: {
    description:
      'List the projects the account can access, newest first by default. Archived and trashed projects are hidden unless includeArchived or includeTrashed is set. Returns projects with id, name, accessLevel, lastUpdated, archived, and trashed, plus totalMatched (before limit) and totalProjects (everything the account can access).',
    inputSchema: z.object({
      query: z.string().min(1).optional().describe('Case-insensitive substring of the project name'),
      includeArchived: z.boolean().default(false),
      includeTrashed: z.boolean().default(false),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_PROJECT_LIMIT)
        .default(DEFAULT_PROJECT_LIMIT)
        .describe(`Maximum projects returned, at most ${MAX_PROJECT_LIMIT}`),
      sort: z
        .enum(['lastUpdated', 'name'])
        .default('lastUpdated')
        .describe('lastUpdated is newest first; name is alphabetical'),
    }),
    outputSchema: z.object({
      projects: z.array(projectSummarySchema),
      totalMatched: z.number().int(),
      totalProjects: z.number().int(),
    }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
  create_project: {
    description:
      'Create a new Overleaf project and return its projectId, url, and rootDocPath. A "blank" project still contains Overleaf\'s stub main.tex as its root document; after importing your own manuscript, point the project at it with update_project_settings or delete the stub with manage_entity. "example" seeds Overleaf\'s example paper.',
    inputSchema: z.object({
      name: projectName,
      template: z.enum(['blank', 'example']).default('blank'),
    }),
    outputSchema: createdProjectSchema.extend({ rootDocPath: z.string().optional() }),
    annotations: { destructiveHint: false, idempotentHint: false },
    effects: ['project-lifecycle', 'overleaf-read'],
  },
  clone_project: {
    description:
      "Copy an existing project, its files, root document, and compiler included, into a new project with the given name. Overleaf gives the copy the account's default TeX Live image and spell-check language; set them with update_project_settings when they matter. Use it to start from a lab or journal template project.",
    inputSchema: z.object({ sourceProjectId: projectId.describe('Project to copy'), name: projectName }),
    outputSchema: createdProjectSchema,
    annotations: { destructiveHint: false, idempotentHint: false },
    effects: ['project-lifecycle'],
  },
  import_project_zip: {
    description:
      'Create a new project from a local .zip archive of LaTeX sources. name defaults to the archive file name. The returned name is the one Overleaf stored, which can differ: Overleaf uses the root document\'s \\title when present and adds " (n)" when the name is already taken; use it as confirmName. If the project was imported but its name could not be read back, the error (AUTH_EXPIRED, POLICY_DENIED, or TIMEOUT from that read, else REMOTE_ERROR) is never retryable and carries the new projectId in details; do not import again. Overleaf caps archives at about 50 MB and rate-limits this route: RATE_LIMITED means wait details.retryAfterMs before trying again, and nothing was created. Set the root document afterwards with update_project_settings if the archive has more than one .tex file at the top level.',
    inputSchema: z.object({
      localZipPath: z.string().min(1).describe('Local path of a .zip archive'),
      name: projectName.optional(),
    }),
    outputSchema: createdProjectSchema,
    annotations: { destructiveHint: false, idempotentHint: false },
    effects: ['local-read', 'project-lifecycle', 'overleaf-read'],
  },
  manage_project: {
    description:
      'Rename, trash, restore, archive, unarchive, or permanently delete a project. trash, archive, and delete require confirmName to equal the current project name exactly, else CONFIRMATION_MISMATCH and nothing changes. trash is the normal way to remove a project and is reversible with restore or in the web UI. delete is permanent and only succeeds on a project that is already trashed. Confirm with the user before trashing or deleting.',
    inputSchema: z.object({
      projectId,
      action: projectActionSchema,
      newName: projectName.optional().describe('New name, for rename'),
      confirmName: z
        .string()
        .optional()
        .describe('Current project name, repeated exactly, for trash, archive, and delete'),
    }),
    outputSchema: z.object({
      action: projectActionSchema,
      projectId: z.string(),
      name: z.string(),
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
    effects: ['project-lifecycle', 'overleaf-read', 'overleaf-delete'],
  },
  update_project_settings: {
    description:
      "Persist the project's root document, TeX engine, TeX Live image, or spell-check language in Overleaf's own project settings, so the web UI's Recompile follows the change. rootFilePath must name an existing .tex, .ltx, .Rtex, or .Rnw document; any other extension is INVALID_ARGUMENT before any request. Settings are applied one request at a time; if one fails, the error keeps its code, lists the settings already stored in details.applied and the failed one in details.failed, and no later setting is sent. Returns the settings as re-read from the project. Provide at least one field.",
    inputSchema: z.object({
      projectId,
      rootFilePath: filePath
        .optional()
        .describe('Document Overleaf should compile by default: .tex, .ltx, .Rtex, or .Rnw'),
      compiler: z.enum(COMPILERS).optional(),
      imageName: z.string().min(1).optional().describe("TeX Live image, as shown in Overleaf's menu"),
      spellCheckLanguage: z
        .string()
        .optional()
        .describe('Overleaf language code such as en or de; an empty string turns spell checking off'),
    }),
    outputSchema: z.object({
      projectId: z.string(),
      rootDocPath: z.string().optional(),
      compiler: z.string().optional(),
      imageName: z.string().optional(),
      spellCheckLanguage: z.string().optional(),
    }),
    annotations: { destructiveHint: false, idempotentHint: true },
    effects: ['project-lifecycle', 'overleaf-read'],
  },
  get_project_tree: {
    description:
      'Return the project file/folder tree with entity IDs and paths, plus the root document, compiler, TeX Live image, and spell-check language Overleaf uses. Each binary file entity carries hash, a git blob hash equal to `git hash-object <file>`; text documents have no hash and must be compared by reading their content.',
    inputSchema: z.object({ projectId }),
    outputSchema: z.object({
      entities: z.array(projectEntitySchema),
      rootDocPath: z.string().optional(),
      compiler: z.string().optional(),
      imageName: z.string().optional(),
      spellCheckLanguage: z.string().optional(),
      trackChangesActive: z.boolean(),
      hashNote: z.string(),
    }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
  read_file: {
    description:
      'Read a text document as LF-normalized content and return its opaque revision. Returns content, revision (pass it unchanged to write_file or write_section), newline "LF", protocol ("sharejs" or "history-ot"), and trackChangesActive.',
    inputSchema: z.object({ projectId, filePath }),
    outputSchema: z.object({
      content: z.string(),
      revision: z.string(),
      newline: z.literal('LF'),
      protocol: otProtocolSchema,
      trackChangesActive: z.boolean(),
    }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
  write_file: {
    description:
      'Replace a text document with a verified OT update that changes only the words that differ, optionally recorded as tracked changes, one per changed group of words; where a changed word touches a comment or tracked change, the update is one edit from the first change to the last instead. Supply the new text either inline through content or from disk through localPath, never both; localPath keeps a whole-file replacement revision-checked without sending the file through the tool call. A write that hit a timeout, a lost socket, or an error Overleaf reported on the document after the update was sent is never resent: the live document is observed instead, and recoveredAfterTimeout: true means the intended text was confirmed. An update Overleaf refused as too large is UPDATE_TOO_LARGE with details.outcome not_applied: nothing was stored. On a ShareJS (legacy editor) document, text that adds a character outside the Basic Multilingual Plane, such as an emoji, adds another copy of one the document holds, or changes their order is INVALID_ARGUMENT with details.line (1-based) and nothing is sent, because Overleaf would store it as U+FFFD; editing text on either side of one the document already holds is fine. With writeMode tracked, a write Overleaf applied without recording it as tracked changes by this account is PROTOCOL_UNSUPPORTED with details.kind applied_untracked and details.liveRevision: it is live and not reverted, so read the file before writing again; if another update followed the write before that check, it is REVISION_CONFLICT with details.outcome unknown instead. A review-only collaborator can write only with writeMode tracked, and a read-only one cannot write: either is PERMISSION_DENIED before anything is sent.',
    inputSchema: z.object({
      projectId,
      filePath,
      revision,
      content: z.string().optional().describe('Complete replacement text, mutually exclusive with localPath'),
      localPath: z
        .string()
        .min(1)
        .optional()
        .describe('Local UTF-8 text file holding the complete replacement, mutually exclusive with content'),
      writeMode,
    }),
    outputSchema: documentWriteSchema,
    annotations: { destructiveHint: true, idempotentHint: false },
    effects: ['local-read', 'overleaf-write'],
  },
  create_file: {
    description:
      'Create a text document and optionally record non-empty initial content as tracked changes. The content is written as by write_file once the empty document exists, so on a ShareJS (legacy editor) document, content that adds an emoji or other character outside the Basic Multilingual Plane is refused with INVALID_ARGUMENT; a timeout, a lost socket, or an Overleaf error after sending is observed, never resent; content the account may not write, such as untracked content from a review-only collaborator, is PERMISSION_DENIED before it is sent; and tracked content Overleaf applied without recording it as tracked changes by this account is PROTOCOL_UNSUPPORTED with details.kind applied_untracked, live and not reverted. If reading back or writing the content fails after the document was created, the error keeps its code and adds details.created: true; the document then exists, possibly empty, so do not create it again: read it with read_file and write the content with write_file.',
    inputSchema: z.object({ projectId, filePath, content: z.string().optional(), writeMode }),
    outputSchema: documentWriteSchema,
    annotations: { destructiveHint: false, idempotentHint: false },
    effects: ['overleaf-write', 'overleaf-read'],
  },
  manage_entity: {
    description:
      "Create a folder, rename, move, or delete an entity. Deletion requires confirmPath to exactly equal path. A name already used in the target folder (the entity's own included), and a folder moved into itself or one of its subfolders, are INVALID_ARGUMENT before anything is sent.",
    inputSchema: z.object({
      projectId,
      action: entityActionSchema,
      path: filePath,
      newName: z.string().min(1).optional(),
      destinationFolderPath: z.string().optional(),
      confirmPath: z.string().optional(),
    }),
    outputSchema: z.object({
      action: entityActionSchema,
      id: z.string().optional(),
      created: z.object({ _id: z.string(), name: z.string() }).optional(),
      trackChangesActive: z.boolean(),
      writeMode: z.literal('untracked'),
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
    effects: ['overleaf-write', 'overleaf-delete'],
  },
  upload_file: {
    description:
      'Upload a local file into a project folder. Overleaf decides whether it becomes a text document or a binary file, by extension and UTF-8 validity. Something already at the path is replaced only when asked for, and otherwise nothing is sent. Replacing a binary needs overwrite: true, or expectedHash equal to its hash from get_project_tree; without either it is CONFIRMATION_MISMATCH, and a different hash is REMOTE_DRIFT. expectedHash is checked just before the upload, not atomically with it. Replacing a text document is a blind write with no revision check, so it needs uncheckedDocumentReplace: true, else INVALID_ARGUMENT: prefer read_file then write_file with localPath, and pass uncheckedDocumentReplace only when nobody else is editing it. overwrite: false refuses any replacement with CONFIRMATION_MISMATCH. A replaced text document keeps its entity ID; a replaced binary file may get a new one. writeMode in the result is tracked when Overleaf records a document replacement as tracked changes, because track changes is on for this account.',
    inputSchema: z.object({
      projectId,
      localPath: z.string().min(1),
      destinationFolderPath: z.string().default(''),
      destinationName: z
        .string()
        .min(1)
        .optional()
        .describe('Name to store the file under; defaults to the local file name'),
      overwrite: z
        .boolean()
        .optional()
        .describe(
          'true allows replacing a binary file at the path; false refuses to replace anything; omitted, replacing a binary needs expectedHash'
        ),
      expectedHash: z
        .string()
        .regex(/^[0-9a-f]{40}$/u)
        .optional()
        .describe(
          'The hash get_project_tree reported for the binary file being replaced; a different one is REMOTE_DRIFT'
        ),
      uncheckedDocumentReplace,
    }),
    outputSchema: z.object({
      entityId: z.string().optional(),
      entityType: z.enum(['doc', 'file']).optional(),
      path: z.string(),
      replaced: z.boolean(),
      hash: z.string().optional(),
      trackChangesActive: z.boolean(),
      writeMode: writeModeSchema,
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
    effects: ['local-read', 'overleaf-write', 'unchecked-replace'],
  },
  batch_upload: {
    description:
      'Upload a list of local files to explicit project paths in one call, instead of one upload_file call per file. Each destinationPath is the full project path including the file name; missing folders are created. onConflict decides what happens when a document or file is already at a destination path: "fail", the default, refuses the whole call with CONFIRMATION_MISMATCH listing those paths, before anything is uploaded; "skip" leaves them untouched and lists them in skipped; "overwrite" replaces a binary file. Replacing a text document has no revision check, so with "overwrite" each one also needs uncheckedDocumentReplace: true, else that file fails with INVALID_ARGUMENT; use write_file or sync_directory for documents a collaborator may be editing. A folder at a destination path, or a file where a folder is needed, fails that file in any mode. Every path is checked before anything is sent: a duplicate destination or a missing local file fails the call with nothing uploaded. Failures are per file and nothing is retried: the call continues past a failure unless stopOnError, and stops at RATE_LIMITED (Overleaf allows about 500 uploads per project in 15 minutes). It returns status, completed (with replaced per upload), skipped, failed, remaining, and verified, which is true when the tree read back afterwards confirmed every completed entry. A timed-out upload is classified from that read-back, never resubmitted: recoveredAfterTimeout when the path holds the local bytes, OUTCOME_UNKNOWN when the tree cannot tell. It saves tool calls, not time. Confirm overwrites with the user first.',
    inputSchema: z.object({
      projectId,
      files: z
        .array(
          z.object({
            localPath: z.string().min(1).describe("File on the server's own disk"),
            destinationPath: filePath.describe('Project path to upload to, including the file name'),
          })
        )
        .min(1)
        .max(BATCH_UPLOAD_LIMIT)
        .describe(`Files to upload, in order; at most ${BATCH_UPLOAD_LIMIT}`),
      onConflict: z
        .enum(['fail', 'skip', 'overwrite'])
        .default('fail')
        .describe(
          'What to do when a document or file is already at a destination path; fail (the default) uploads nothing'
        ),
      uncheckedDocumentReplace,
      stopOnError: z.boolean().default(false).describe('Stop at the first failure instead of continuing'),
    }),
    outputSchema: z.object({
      status: z.enum(['complete', 'partial']),
      onConflict: z.enum(['fail', 'skip', 'overwrite']),
      completed: z.array(
        z.object({
          destinationPath: z.string(),
          action: batchUploadActionSchema,
          entityId: z.string().optional(),
          entityType: z.enum(['doc', 'file']).optional(),
          replaced: z.boolean().optional(),
          recoveredAfterTimeout: z.literal(true).optional(),
        })
      ),
      skipped: z.array(
        z.object({ destinationPath: z.string(), localPath: z.string(), entityType: z.enum(['doc', 'file']) })
      ),
      failed: z.array(
        z.object({
          destinationPath: z.string(),
          action: batchUploadActionSchema,
          errorCode: errorCodeSchema,
          message: z.string(),
        })
      ),
      remaining: z.array(z.object({ destinationPath: z.string(), action: batchUploadActionSchema })),
      verified: z.boolean(),
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
    effects: ['local-read', 'overleaf-read', 'overleaf-write', 'unchecked-replace'],
  },
  download_file: {
    description:
      'Download one Overleaf document or binary file to an explicit local path. Refuses to replace an existing local file unless overwrite is set. The local path is checked before anything is fetched: an existing file without overwrite, or a folder (or a link to one) at localPath, is INVALID_ARGUMENT, a missing parent folder is NOT_FOUND, and a folder that cannot be written is INVALID_ARGUMENT with details.errno. With overwrite, an existing file is replaced atomically, keeping its permissions, so its folder must be writable.',
    inputSchema: z.object({
      projectId,
      filePath,
      localPath: z.string().min(1),
      overwrite: z.boolean().default(false).describe('Replace localPath if it already exists'),
    }),
    outputSchema: z.object({ bytes: z.number().int().nonnegative(), localPath: z.string() }),
    // It writes a local file and can replace one, so it is not read-only.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    effects: ['overleaf-read', 'local-write'],
  },
  download_project_zip: {
    description:
      'Download the whole project, sources and binaries, as one zip archive (Overleaf\'s "Download as zip") to a local path on the server\'s own disk. The folder must exist. An existing file is replaced only when overwrite is true, else CONFIRMATION_MISMATCH and nothing is downloaded; a replacement is atomic, so a failed or incomplete download leaves the old file intact. Offer it as a backup before a mirror sync_directory or an overwriting batch_upload. Overleaf allows about 10 downloads per project a minute, so on RATE_LIMITED wait a minute. PERMISSION_DENIED here can also mean the session expired; check auth_status. Returns the absolute localPath, bytes, and replaced.',
    inputSchema: z.object({
      projectId,
      localPath: z.string().min(1).describe('Local file to write the archive to, for example backup.zip'),
      overwrite: z.boolean().default(false).describe('Replace localPath if it already exists'),
      timeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(15 * 60_000)
        .optional()
        .describe(`Limit for the whole download; defaults to ${DEFAULT_ZIP_DOWNLOAD_TIMEOUT_MS / 60_000} minutes`),
    }),
    outputSchema: z.object({
      projectId: z.string(),
      localPath: z.string(),
      bytes: z.number().int().nonnegative(),
      replaced: z.boolean(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    effects: ['overleaf-read', 'local-write'],
  },
  plan_sync: {
    description:
      "Compare a local folder with a project folder and report what sync_directory would do, changing nothing. Binary files compare by git blob hash at no cost; each text document with a local counterpart, or present only in the project, is read once through the project's queue, so this suits tens of documents, not thousands. Returns toUpload (new or changed), identical (a count and the first 25 paths unless verbose), remoteOnly (what mirror mode would delete, each folder collapsed to one entry that includes its contents), conflicts (a file where the other side has a folder, or non-UTF-8 text where the project has a document; sync_directory cannot apply these), ignored, and planToken. Show the plan to the user before syncing. localFolderPath is on the server's disk; a symbolic link that leads outside it fails with PATH_OUTSIDE_ROOT.",
    inputSchema: z.object({
      projectId,
      localFolderPath,
      destinationFolderPath,
      ignore: ignorePatterns,
      verbose: z
        .boolean()
        .default(false)
        .describe('List every identical path and ignored entry instead of the first 25'),
    }),
    outputSchema: z.object({
      planToken: z.string(),
      localFolderPath: z.string(),
      destinationFolderPath: z.string(),
      toUpload: z.array(
        z.object({
          localPath: z.string(),
          destinationPath: z.string(),
          reason: z.enum(['new', 'changed']),
          comparedBy: z.enum(['hash', 'content']).optional(),
          remoteType: z.enum(['doc', 'file']).optional(),
        })
      ),
      identical: z.object({ count: z.number().int(), paths: z.array(z.string()) }),
      remoteOnly: z.array(
        z.object({
          destinationPath: z.string(),
          entityId: z.string(),
          type: entityTypeSchema,
          contains: z.number().int().optional(),
        })
      ),
      conflicts: z.array(
        z.object({
          localPath: z.string(),
          destinationPath: z.string(),
          reason: z.enum(['local_file_remote_folder', 'local_folder_remote_file', 'not_utf8_text']),
          message: z.string(),
        })
      ),
      ignored: z.object({
        count: z.number().int(),
        entries: z.array(
          z.object({
            localPath: z.string(),
            matchedPattern: z.string().optional(),
            reason: z.string().optional(),
          })
        ),
      }),
    }),
    annotations: { readOnlyHint: true },
    effects: ['local-read', 'overleaf-read'],
  },
  sync_directory: {
    description:
      "Make a project folder match a local folder: upload new and changed files, and in mirror mode also delete what exists only in the project. Call plan_sync first, confirm the plan with the user, and pass its planToken; if the project or the folder changed since, REMOTE_DRIFT is returned and nothing changes. A planToken is required: without one the call is refused with CONFIRMATION_MISMATCH before anything is read, unless an additive sync passes unplanned: true to run without a plan on purpose (planned is then false); a mirror sync always needs one. Changed text documents are replaced through revision-checked write_file edits, recorded as tracked changes when writeMode is tracked, so a concurrent edit fails that file with REVISION_CONFLICT rather than being overwritten. Binaries and new files are uploaded, and one whose path changed since the plan fails with REMOTE_DRIFT; with writeMode tracked, new .tex, .bib, and similar text files are created with tracked content instead. Missing folders are created. Uploads and writes run first. Deletes run only in mirror mode, only when confirmDeleteCount equals the number of remoteOnly entries, else CONFIRMATION_MISMATCH, and never after any upload or write failed. Failures are per file and nothing is retried: the call continues unless stopOnError, then returns status, completed, failed, remaining, and a planToken to resume with. Each failed entry carries the step's error details, and kind: applied_untracked when a tracked step applied without being recorded as tracked changes (it is live, not reverted); a create that failed with details.created left its document behind, and resuming with the planToken writes it while it is still empty or holds the local text. On a ShareJS (legacy editor) document, text that adds an emoji or another character outside the Basic Multilingual Plane, or reorders existing ones, fails that file with INVALID_ARGUMENT. It saves tool calls, not time.",
    inputSchema: z.object({
      projectId,
      localFolderPath,
      mode: z
        .enum(['additive', 'mirror'])
        .describe('additive only uploads and writes; mirror also deletes what exists only in the project'),
      destinationFolderPath,
      planToken: z
        .string()
        .min(1)
        .optional()
        .describe(
          'From plan_sync, or from a partial sync_directory to resume it; required unless an additive sync passes unplanned'
        ),
      unplanned: z
        .boolean()
        .optional()
        .describe('Run an additive sync without a planToken on purpose; never with a planToken or in mirror mode'),
      confirmDeleteCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Required in mirror mode: the number of entries in plan_sync's remoteOnly, each folder counting once"
        ),
      ignore: ignorePatterns,
      writeMode,
      stopOnError: z.boolean().default(false).describe('Stop at the first failure instead of continuing'),
    }),
    outputSchema: z.object({
      status: z.enum(['complete', 'partial']),
      mode: z.enum(['additive', 'mirror']),
      completed: z.array(
        z.object({ destinationPath: z.string(), action: syncActionSchema, entityId: z.string().optional() })
      ),
      failed: z.array(
        z.object({
          destinationPath: z.string(),
          action: syncActionSchema,
          errorCode: errorCodeSchema,
          message: z.string(),
          details: z.record(z.string(), z.unknown()).optional(),
          kind: z
            .enum(['applied_untracked'])
            .optional()
            .describe(
              'applied_untracked: the tracked step applied but was not recorded as tracked changes; it is live, not reverted'
            ),
        })
      ),
      remaining: z.array(z.object({ destinationPath: z.string(), action: syncActionSchema })),
      identicalCount: z.number().int(),
      planToken: z.string().optional(),
      planned: z.boolean(),
    }),
    annotations: { destructiveHint: true, idempotentHint: true },
    effects: ['local-read', 'overleaf-read', 'overleaf-write', 'overleaf-delete'],
  },
  delete_entities: {
    description:
      'Delete several documents, files, or folders in one call. confirmCount must equal the number of paths, else CONFIRMATION_MISMATCH. Every path is resolved before anything is deleted, so a missing one fails the call with NOT_FOUND and changes nothing. Deleting a folder removes everything inside it, so list the folder alone, not its contents too. Continues past a failed delete unless stopOnError, and returns status, completed, failed, and remaining. Confirm the list with the user first.',
    inputSchema: z.object({
      projectId,
      paths: z.array(filePath).min(1).max(500).describe('Project paths to delete'),
      confirmCount: z
        .number()
        .int()
        .positive()
        .describe('The number of paths, repeated after confirming the list with the user'),
      stopOnError: z.boolean().default(false).describe('Stop at the first failure instead of continuing'),
    }),
    outputSchema: z.object({
      status: z.enum(['complete', 'partial']),
      completed: z.array(z.object({ path: z.string(), type: entityTypeSchema, entityId: z.string() })),
      failed: z.array(z.object({ path: z.string(), errorCode: errorCodeSchema, message: z.string() })),
      remaining: z.array(z.object({ path: z.string() })),
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
    effects: ['overleaf-read', 'overleaf-delete'],
  },
  get_full_document: {
    description: `Flatten a LaTeX document latexpand-style: starting from rootFilePath, or from the project's root document when it is left out, every \\input, \\include, \\subfile, and \\import (also \\subimport, \\inputfrom, \\subinputfrom, \\includefrom, \\subincludefrom) is replaced by the text of the file it names, recursively, and the rest of the text is kept exactly. Directives inside % comments and verbatim text are skipped. A path resolves relative to the project root first and then to the including file's folder (the other way round for \\subimport and its relatives); \\input and \\subfile try the name as written and then with .tex, \\include always means .tex, and \\subfile takes in only the named file's document body. \\include does not add its page breaks to the text. A directive that cannot be followed stays as written and is listed in unresolved with file, line (1-based), target, and reason: missing (no document at any candidate path), binary_file (the path is an uploaded file, not a text document), macro_argument (the path uses a macro or parameter), or excluded_by_includeonly (an \\include an \\includeonly list leaves out; includeOnly lists it). Returns rootFilePath, text, files (every file visited, each once, in order), unresolved, includeOnly when a file sets it, and sourceMap: one entry per run of text copied from one file, { flattenedStart, flattenedEnd, filePath, docId, originalStart, originalEnd, revision }, offsets in UTF-16 code units, half-open, into text and into that file's LF-normalized content. revision is the file's revision as read_file returns it: route an edit decided on in the flattened view back with write_file or write_section on that file, with that revision, never by writing the flattened text anywhere. Each file is read separately, so files can change between reads; each revision matches the text it was read with. An include cycle is INCLUDE_CYCLE with details.chain; nesting deeper than maxDepth is INCLUDE_DEPTH_EXCEEDED; a result longer than ${MAX_FLATTENED_LENGTH} code units is DOC_TOO_LARGE.`,
    inputSchema: z.object({
      projectId,
      rootFilePath: filePath
        .optional()
        .describe('Document to start from; defaults to the root document configured in Overleaf'),
      maxDepth: z
        .number()
        .int()
        .min(1)
        .max(MAX_INCLUDE_DEPTH)
        .default(DEFAULT_INCLUDE_DEPTH)
        .describe(
          `Levels of includes to follow below the root document, 1 to ${MAX_INCLUDE_DEPTH}; default ${DEFAULT_INCLUDE_DEPTH}`
        ),
    }),
    outputSchema: z.object({
      rootFilePath: z.string(),
      text: z.string(),
      sourceMap: z.array(
        z.object({
          flattenedStart: z.number().int().nonnegative(),
          flattenedEnd: z.number().int().nonnegative(),
          filePath: z.string(),
          docId: z.string(),
          originalStart: z.number().int().nonnegative(),
          originalEnd: z.number().int().nonnegative(),
          revision: z.string(),
        })
      ),
      files: z.array(z.string()),
      unresolved: z.array(unresolvedIncludeSchema),
      includeOnly: z.array(z.string()).optional(),
    }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
  get_sections: {
    description:
      "Parse LaTeX section headings. By default this reads one file only and never follows input/include directives: singleFileOnly is true and offsets are into that file. With followIncludes: true, filePath is the document to start from (usually the root document), the headings are parsed in the text get_full_document returns for it, and singleFileOnly is false: start, headingEnd, bodyStart, and end are offsets into that flattened text, and each section adds filePath (the file holding its heading), revision (that file's revision, for write_section), and spansFiles (true when text from another file, other than white space, falls inside the section, so write_section refuses it). The section id then names its file, as path#command:offset, so pass followIncludes: true to get_section_content and write_section with it. unresolved lists the directives that could not be followed, as in get_full_document. revision is always filePath's own.",
    inputSchema: z.object({ projectId, filePath, followIncludes }),
    outputSchema: z.object({
      sections: z.array(z.union([includedSectionSchema, latexSectionSchema])),
      revision: z.string(),
      singleFileOnly: z.boolean(),
      unresolved: z.array(unresolvedIncludeSchema).optional(),
    }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
  get_section_content: {
    description:
      "Read one parsed section body. The body runs from after the heading to the next heading at the same or a higher level, so it includes nested subsections, and the last section runs to the end of the file, including \\end{document}. By default this reads a single file. With followIncludes: true, filePath is the document get_sections started from and sectionId comes from that call; a section that lies in one file is read as that file holds it, include directives included, which is exactly what write_section replaces, and revision is that file's revision. A section with spansFiles: true reads as flattened text across files, for reading only.",
    inputSchema: z.object({ projectId, filePath, sectionId: z.string().min(1), followIncludes }),
    outputSchema: z.object({
      content: z.string(),
      section: z.union([includedSectionSchema, latexSectionSchema]),
      revision: z.string(),
    }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
  write_section: {
    description:
      "Replace one section body in a single file using a revision-checked write, optionally recorded as tracked changes. By default included files are not traversed. With followIncludes: true, filePath is the document get_sections started from, sectionId comes from that call, and revision is the section's revision from it: the body is replaced in the file holding the heading, through the same revision-checked write, and filePath in the result names that file. A section with spansFiles: true is refused with INVALID_ARGUMENT, details.kind spans_files, before anything is sent; edit each file with write_file instead. content replaces the whole body as get_section_content returns it, including nested subsections and, for the last section, \\end{document}, so read it first and keep what should survive. The write is made as by write_file: on a ShareJS (legacy editor) document, content that adds an emoji or other character outside the Basic Multilingual Plane, or reorders existing ones, is refused with INVALID_ARGUMENT; a timeout, a lost socket, or an Overleaf error after sending is observed, never resent; a review-only collaborator can write only with writeMode tracked and a read-only one cannot write, either being PERMISSION_DENIED before anything is sent; and a tracked write Overleaf applied without recording it as tracked changes by this account is PROTOCOL_UNSUPPORTED with details.kind applied_untracked, live and not reverted.",
    inputSchema: z.object({
      projectId,
      filePath,
      revision,
      sectionId: z.string().min(1),
      content: z.string(),
      writeMode,
      followIncludes,
    }),
    outputSchema: documentWriteSchema.extend({ filePath: z.string().optional() }),
    annotations: { destructiveHint: true, idempotentHint: false },
    effects: ['overleaf-read', 'overleaf-write'],
  },
  compile_project: {
    description: `Compile a project and report on the build from its logs. Omit rootFilePath to build the root document configured in Overleaf, which is what the web UI's Recompile button uses; pass it to build a different document for this call only. Check summary.builtCleanly, not status: Overleaf reports status "success" whenever a PDF came out, even when LaTeX hit errors along the way. builtCleanly is true only when a PDF was produced, output.log was read, and it reports no error. summary lists the first ${MAX_LOG_ENTRIES} errors and warnings as { file?, line?, message } (errorCount and warningCount count all of them), undefined references and citations, missing files, pageCount, and pdfSizeBytes; messages never quote the document. A LaTeX error that stopped the build returns status "failure" with the same summary rather than an error. outputFiles is Overleaf's listing, less an output.blg and output.bbl left over from an earlier build when BibTeX did not run for this one. buildRef names this build to get_compile_log and download_compile_output, also in a later process. stopOnFirstError gives a short log holding the one error that matters; draft skips images for faster text-only builds. Compiles spend the account's compile allowance, so read the summary instead of recompiling. Errors: COMPILE_RATE_LIMITED (Overleaf ran nothing; wait details.retryAfterMs when given, then compile once more), COMPILE_UNAVAILABLE (try later), COMPILE_TIMEOUT (the build hit the time limit; details.buildRef, when present, reaches its partial log), COMPILE_FAILED (no build to report on), and TIMEOUT (the request timed out while Overleaf may still be compiling; it is not retried).`,
    inputSchema: z.object({
      projectId,
      rootFilePath: filePath.optional(),
      timeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(15 * 60_000)
        .optional(),
      stopOnFirstError: z.boolean().optional().describe('Stop at the first LaTeX error, for a short log'),
      draft: z.boolean().optional().describe('Draft mode: images become boxes, for faster text-only builds'),
    }),
    outputSchema: z.object({
      status: z.string(),
      outputFiles: z.array(z.object({ path: z.string(), type: z.string(), build: z.string().optional() })),
      stats: z.record(z.string(), z.number()),
      buildId: z.string().optional(),
      clsiServerId: z.string().optional(),
      rootFilePath: z.string(),
      buildRef: z.string().optional(),
      summary: z.object({
        status: z.string(),
        builtCleanly: z.boolean(),
        pdfProduced: z.boolean(),
        logRead: z.boolean(),
        errorCount: z.number().int().nonnegative(),
        warningCount: z.number().int().nonnegative(),
        errors: z.array(logEntrySchema),
        warnings: z.array(logEntrySchema),
        undefinedReferences: z.array(z.string()),
        undefinedCitations: z.array(z.string()),
        missingFiles: z.array(z.string()),
        pageCount: z.number().int().nonnegative().optional(),
        pdfSizeBytes: z.number().int().nonnegative().optional(),
      }),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
    effects: ['compile', 'overleaf-read'],
  },
  stop_compile: {
    description: 'Stop the active Overleaf compile for a project. Returns { stopped: true }.',
    inputSchema: z.object({ projectId }),
    outputSchema: z.object({ stopped: z.literal(true) }),
    annotations: { destructiveHint: true, idempotentHint: true },
    effects: ['compile'],
  },
  get_compile_log: {
    description: `Read a build's LaTeX log (output.log) or BibTeX log (kind "bibtex", the .blg file), without compiling again. kind "bibtex" is NOT_FOUND when BibTeX did not run for the build, even if Overleaf still lists an output.blg left over from an earlier build. Without buildRef it reads the latest build compile_project made in this server process, else NO_BUILD; Overleaf keeps build output only for a while, and an expired build is BUILD_NOT_FOUND. At most 1 MB of the log is read, from its start, and the last tail lines are returned (default ${DEFAULT_LOG_TAIL}, at most ${MAX_LOG_TAIL}, and at most ${MAX_LOG_CHARS} characters). format "errors-only" returns only the lines that start an error. errorLines lists the first ${MAX_ERROR_LINES} error lines with their 1-based line numbers, each cut to ${MAX_MESSAGE_LENGTH} characters. truncated says whether anything of the log was left out. The log quotes source lines near each error; prefer compile_project's summary when that is enough.`,
    inputSchema: z.object({
      projectId,
      buildRef: z
        .string()
        .min(1)
        .optional()
        .describe('From compile_project; defaults to the latest build in this process'),
      kind: z.enum(['latex', 'bibtex']).default('latex'),
      format: z.enum(['raw', 'errors-only']).default('raw'),
      tail: z
        .number()
        .int()
        .min(1)
        .max(MAX_LOG_TAIL)
        .default(DEFAULT_LOG_TAIL)
        .describe('How many lines to return, from the end'),
    }),
    outputSchema: z.object({
      buildId: z.string(),
      file: z.string(),
      log: z.string(),
      truncated: z.boolean(),
      errorLines: z.array(z.object({ line: z.number().int().positive(), text: z.string() })),
    }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
  download_compile_output: {
    description:
      'Save a build\'s compiled PDF, or another output file such as output.log, output.blg, or output.synctex.gz, to a local path on the server\'s own disk, in one call. file defaults to output.pdf and must be a relative output path without "..". Without buildRef it uses the latest build compile_project made in this server process, else NO_BUILD; a file the build did not produce, an output.blg or output.bbl left over from an earlier build included, is NOT_FOUND, and an expired build is BUILD_NOT_FOUND. The folder must exist. An existing file is replaced only when overwrite is true, else CONFIRMATION_MISMATCH and nothing is downloaded; a replacement is atomic. A .pdf that does not start with %PDF- is PROTOCOL_UNSUPPORTED and nothing is written. Returns the absolute localPath, file, sizeBytes, buildId, and replaced.',
    inputSchema: z.object({
      projectId,
      localPath: z.string().min(1).describe('Local file to write, for example paper.pdf'),
      file: z.string().min(1).max(255).optional().describe('Output file of the build; defaults to output.pdf'),
      buildRef: z
        .string()
        .min(1)
        .optional()
        .describe('From compile_project; defaults to the latest build in this process'),
      overwrite: z.boolean().default(false).describe('Replace localPath if it already exists'),
    }),
    outputSchema: z.object({
      localPath: z.string(),
      file: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      buildId: z.string(),
      replaced: z.boolean(),
    }),
    // It writes a local file and can replace one, so it is not read-only.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    effects: ['overleaf-read', 'local-write'],
  },
  list_comments: {
    description:
      'List review comment threads and lazily resolve their document positions. Defaults to open threads. author keeps threads with a message whose author display name contains it (case-insensitive) or whose author id equals it. Returns threads, each with id, status, messages (id, author { id, displayName } or null, content, ISO timestamp), resolvedAt and resolvedBy when resolved, and when located filePath, start, end (1-based line, UTF-16 column), and quotedText; a thread without a document range has unlocated: true. Without filePath, positionsUnavailable: true means the deployment has no project-wide range index and every thread is unlocated.',
    inputSchema: z.object({
      projectId,
      filePath: z.string().min(1).optional().describe('Only threads anchored in this document'),
      status: z.enum(['open', 'resolved', 'all']).default('open'),
      author: z.string().min(1).optional().describe('Author display name substring, or exact author id'),
    }),
    outputSchema: z.object({
      threads: z.array(
        commentThreadSchema.extend({
          filePath: z.string().optional(),
          start: position.optional(),
          end: position.optional(),
          quotedText: z.string().optional(),
          unlocated: z.literal(true).optional(),
        })
      ),
      positionsUnavailable: z.boolean(),
    }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
  reply_to_comment: {
    description:
      'Reply to an existing review thread. An unknown threadId fails with NOT_FOUND and posts nothing. Returns threadId and the created message (id, author { id, displayName }, content, ISO timestamp), plus trackChangesActive and writeMode. A timed-out reply is never resubmitted: it returns recoveredAfterTimeout when the thread shows exactly one new matching message from this account, else OUTCOME_UNKNOWN; do not retry it blindly.',
    inputSchema: z.object({
      projectId,
      threadId: z.string().min(1).describe('Existing thread id from list_comments'),
      content: z.string().min(1),
    }),
    outputSchema: z.object({
      threadId: z.string(),
      message: commentMessageSchema,
      trackChangesActive: z.boolean(),
      writeMode: z.literal('untracked'),
      recoveredAfterTimeout: z.literal(true).optional(),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
    effects: ['overleaf-write', 'overleaf-read'],
  },
  add_comment: {
    description:
      'Add and verify an anchored review comment using UTF-16 positions and expectedText. Returns threadId, the created thread (id, status, messages with author { id, displayName }, content, and ISO timestamp) when it could be read back, the resulting document revision and protocol, trackChangesActive, writeMode, and recoveredAfterTimeout when an attachment that timed out, lost its socket, or could not be read back was confirmed by observation.',
    inputSchema: z.object({
      projectId,
      filePath,
      revision,
      start: position,
      end: position,
      expectedText: z.string().min(1),
      content: z.string().min(1),
    }),
    outputSchema: z.object({
      threadId: z.string(),
      thread: commentThreadSchema.optional(),
      revision: z.string(),
      protocol: otProtocolSchema,
      trackChangesActive: z.boolean(),
      writeMode: z.literal('untracked'),
      recoveredAfterTimeout: z.literal(true).optional(),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
    effects: ['overleaf-write', 'overleaf-read'],
  },
  set_comment_status: {
    description:
      'Resolve or reopen a review thread and verify its resulting document revision. filePath must be the document the thread is anchored in, as list_comments reports it; a thread not anchored there fails with NOT_FOUND and nothing changes. On a history-OT document a status change needs owner or edit access: review-only or read-only access is PERMISSION_DENIED before anything is sent. Returns threadId, status, the resulting revision, trackChangesActive, writeMode, and recoveredAfterTimeout when a change that timed out, lost its socket, or could not be read back was confirmed by observation.',
    inputSchema: z.object({
      projectId,
      filePath,
      revision,
      threadId: z.string().min(1),
      status: z.enum(['open', 'resolved']),
    }),
    outputSchema: z.object({
      threadId: z.string(),
      status: z.enum(['open', 'resolved']),
      revision: z.string(),
      trackChangesActive: z.boolean(),
      writeMode: z.literal('untracked'),
      recoveredAfterTimeout: z.literal(true).optional(),
    }),
    annotations: { destructiveHint: true, idempotentHint: true },
    effects: ['overleaf-write', 'overleaf-read'],
  },
  list_tracked_changes: {
    description: `List tracked changes (suggestions) and where they are, so they can be accepted or rejected with manage_tracked_changes. With filePath, that document is read and its list is authoritative. Without it, Overleaf's project range index only chooses which documents to read: just the documents it lists with changes are read, its change ids are never used, and it may lag or leave a document out, so name a document with filePath for an authoritative list (this matters most for history-OT documents, whose index ids are never valid). indexUnavailable: true means the deployment has no index and no document was read. type and authorId keep only matching changes; limit (default ${DEFAULT_TRACKED_CHANGE_LIMIT}, at most ${MAX_TRACKED_CHANGE_LIMIT}) caps the changes returned across all documents, totalMatched counts every match, and truncated says some were left out. Returns documents, each with filePath, revision (pass it to manage_tracked_changes), protocol, totalChanges (every tracked change in the document, unfiltered), undecidableChanges when some changes carry no id and cannot be decided by this server, and changes: changeId, type (insert: suggested text that is visible; delete: suggested removal of text that is no longer visible), start and end (1-based line and UTF-16 column in the text read_file returns; a delete is a point, so its start equals its end), length in UTF-16 units, excerpt of the inserted or deleted text (at most excerptChars UTF-16 units, default ${DEFAULT_EXCERPT_CHARS}, 0 for none) with excerptTruncated, authorId (an Overleaf user id, or null), an ISO timestamp, and pairedChangeId linking the insert and the delete of one replacement. Also returns trackChangesActive. Ids merge and split as the document is edited, and history-OT ids are valid only with the revision they were listed with, so list again before deciding.`,
    inputSchema: z.object({
      projectId,
      filePath: z
        .string()
        .min(1)
        .optional()
        .describe('Only this document, read directly rather than through the index'),
      type: trackedChangeTypeSchema.optional().describe('Only inserts or only deletes'),
      authorId: z.string().min(1).optional().describe('Only changes by this Overleaf user id'),
      excerptChars: z
        .number()
        .int()
        .min(0)
        .max(MAX_EXCERPT_CHARS)
        .default(DEFAULT_EXCERPT_CHARS)
        .describe('Longest excerpt of each change, in UTF-16 units; 0 for none'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_TRACKED_CHANGE_LIMIT)
        .default(DEFAULT_TRACKED_CHANGE_LIMIT)
        .describe('Most changes returned across all documents'),
    }),
    outputSchema: z.object({
      documents: z.array(
        z.object({
          filePath: z.string(),
          revision: z.string(),
          protocol: otProtocolSchema,
          totalChanges: z.number().int().nonnegative(),
          undecidableChanges: z.number().int().positive().optional(),
          changes: z.array(trackedChangeSchema),
        })
      ),
      totalMatched: z.number().int().nonnegative(),
      truncated: z.boolean(),
      trackChangesActive: z.boolean(),
      indexUnavailable: z.literal(true).optional(),
    }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
  manage_tracked_changes: {
    description: `Accept or reject tracked changes in one document. First list them with list_tracked_changes and confirm them with the user, then pass that document's filePath and revision, the changeIds (1 to ${MAX_CHANGE_IDS}, each once), and confirmCount equal to the number of changeIds; a missing or different confirmCount is CONFIRMATION_MISMATCH and nothing is sent. Accepting an insert keeps its text and accepting a delete removes it; rejecting an insert removes its text and rejecting a delete restores it. A tracked replacement is an insert and a delete linked by pairedChangeId: pass both ids. Checked in this order before anything is sent: access (only the owner and collaborators who can edit may decide; review-only and read-only access is PERMISSION_DENIED), whether track changes is available for the project (REVIEW_UNSUPPORTED, details.kind "feature_disabled"; review may need a plan that includes it), the revision (REVISION_CONFLICT), that every id is a tracked change in this document (NOT_FOUND, details.missingChangeIds), and that no change left out overlaps a chosen one (INVALID_ARGUMENT, details.overlappingChangeIds). REVIEW_UNSUPPORTED with details.kind "route_unavailable" or "document_protocol" means this Overleaf cannot decide changes this way. The decision is sent once and verified on a fresh read of the document. One that timed out is observed, never resent: recoveredAfterTimeout: true when it applied, TIMEOUT or REMOTE_ERROR with details.outcome "not_applied" when it did not, REVISION_CONFLICT with details.outcome "unknown" when the document changed meanwhile, and OUTCOME_UNKNOWN when it could not be observed. A repeated decision changes nothing: it fails with REVISION_CONFLICT when the first one changed the document's revision, as every reject and every history-OT decision does, or with NOT_FOUND when it did not, as after an accept on a ShareJS document, which leaves the revision as it was. Rejecting on a ShareJS (legacy editor) document may notify the change's author; on a history-OT document it does not. Returns action, filePath, changeIds, the resulting revision and protocol, remainingChangeCount (tracked changes left in the document), trackChangesActive, and recoveredAfterTimeout. List again after every decision and after REVISION_CONFLICT or NOT_FOUND: ids merge and split, and history-OT ids are valid only with the revision they were listed with.`,
    inputSchema: z.object({
      projectId,
      filePath,
      revision: z.string().min(1).describe('The revision list_tracked_changes returned for this document'),
      action: z.enum(['accept', 'reject']),
      changeIds: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_CHANGE_IDS)
        .describe('changeId values from list_tracked_changes, all in this document, each once'),
      confirmCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Must equal the number of changeIds, after the user has confirmed them'),
    }),
    outputSchema: z.object({
      action: z.enum(['accept', 'reject']),
      filePath: z.string(),
      changeIds: z.array(z.string()),
      revision: z.string(),
      protocol: otProtocolSchema,
      remainingChangeCount: z.number().int().nonnegative(),
      trackChangesActive: z.boolean(),
      recoveredAfterTimeout: z.literal(true).optional(),
    }),
    annotations: { destructiveHint: true, idempotentHint: true },
    effects: ['overleaf-write', 'overleaf-read'],
  },
  monitor_project_history: {
    description:
      'Poll one recent project-history window and return updates newer than an optional version cursor. In a group that starts before the cursor, only project operations at or after it are listed. Returns projectId, currentVersion (null when the window is empty), nextSinceVersion (pass it back as sinceVersion; on an empty window it repeats sinceVersion, or is null without one), hasEarlierHistory, gapDetected, and updates, newest first. Each update has fromVersion, toVersion, ISO startedAt and endedAt, authors ({ id, displayName } or null), paths, projectOperations (add, rename with newPath, remove, each with atVersion), labels, and origin ({ kind, path?, timestamp?, version? } or null).',
    inputSchema: z.object({
      projectId,
      sinceVersion: z.number().int().nonnegative().optional(),
    }),
    outputSchema: z.object({
      projectId: z.string(),
      currentVersion: historyVersion.nullable(),
      nextSinceVersion: historyVersion.nullable(),
      hasEarlierHistory: z.boolean(),
      gapDetected: z.boolean(),
      updates: z.array(historyUpdateSchema),
    }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
} as const satisfies Record<OperationName, OperationContract>

type Operations = typeof OPERATIONS

/** What an operation accepts: its input schema's input type, so defaulted fields may be left out. */
export type OperationInput<N extends OperationName> = Operations[N] extends { inputSchema: infer S extends z.ZodType }
  ? z.input<S>
  : Record<string, never>

/** What an operation resolves with: its output schema's type. */
export type OperationOutput<N extends OperationName> = z.output<Operations[N]['outputSchema']>

/** The contract entry for an operation, typed as the general shape. */
export function operationContract(name: OperationName): OperationContract {
  return OPERATIONS[name]
}
