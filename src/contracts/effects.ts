/**
 * What an operation can do, declared once per operation and checked against the access policy
 * before any work starts. `readOnlyHint` holds exactly when every effect is a read.
 *
 * - `overleaf-read`: reads project data.
 * - `overleaf-write`: changes project content or comments without removing an entity.
 * - `overleaf-delete`: removes an entity or a tag, or permanently deletes a project.
 * - `project-lifecycle`: creates, renames, trashes, archives, tags, or configures a project.
 * - `compile`: starts or stops a compile, spending the account's compile allowance.
 * - `local-read`: reads a file or folder on the server's own disk.
 * - `local-write`: creates or replaces a file on the server's own disk.
 * - `unchecked-replace`: replaces a text document with no revision check.
 */
export const EFFECTS = [
  'overleaf-read',
  'overleaf-write',
  'overleaf-delete',
  'project-lifecycle',
  'compile',
  'local-read',
  'local-write',
  'unchecked-replace',
] as const

export type Effect = (typeof EFFECTS)[number]

/** Effects that leave Overleaf and the local disk unchanged. */
export const READ_EFFECTS: readonly Effect[] = ['overleaf-read', 'local-read']
