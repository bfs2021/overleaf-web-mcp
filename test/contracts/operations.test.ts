import { describe, expect, test } from 'vitest'

import { EFFECTS, READ_EFFECTS } from '../../src/contracts/effects.js'
import { ERROR_CODES } from '../../src/contracts/error-codes.js'
import { OPERATION_NAMES, OPERATIONS, operationContract } from '../../src/contracts/operations.js'

/** Parameters that confirm a destructive call by value or by expected state. */
const CONFIRMATIONS = [
  'confirmPath',
  'confirmName',
  'confirmCount',
  'confirmDeleteCount',
  'overwrite',
  'onConflict',
  'revision',
  'planToken',
]

function shape(name: (typeof OPERATION_NAMES)[number]): Record<string, unknown> {
  return operationContract(name).inputSchema?.shape ?? {}
}

describe('operation contracts', () => {
  test('declare only known effects, at least one each', () => {
    for (const name of OPERATION_NAMES) {
      const { effects } = operationContract(name)
      expect(effects.length, name).toBeGreaterThan(0)
      for (const effect of effects) expect(EFFECTS, name).toContain(effect)
    }
  })

  test('are read-only exactly when every effect is a read', () => {
    for (const name of OPERATION_NAMES) {
      const { annotations, effects } = operationContract(name)
      const readsOnly = effects.every(effect => READ_EFFECTS.includes(effect))
      expect(annotations.readOnlyHint === true, name).toBe(readsOnly)
      // Everything else says whether it is destructive, so clients need not guess.
      if (!readsOnly) expect(typeof annotations.destructiveHint, name).toBe('boolean')
    }
  })

  test('are destructive whenever they can delete, write locally, or replace a document unchecked', () => {
    for (const name of OPERATION_NAMES) {
      const { annotations, effects } = operationContract(name)
      if (effects.some(effect => ['overleaf-delete', 'local-write', 'unchecked-replace'].includes(effect))) {
        expect(annotations.destructiveHint, name).toBe(true)
      }
    }
  })

  test('confirm every destructive operation by value or expected state, except stop_compile', () => {
    const unconfirmed = OPERATION_NAMES.filter(
      name =>
        operationContract(name).annotations.destructiveHint === true &&
        !CONFIRMATIONS.some(parameter => parameter in shape(name))
    )
    expect(unconfirmed).toEqual(['stop_compile'])
  })

  test('mark download_file as a local write that can replace a file', () => {
    expect(OPERATIONS.download_file.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    })
    expect(OPERATIONS.download_file.effects).toContain('local-write')
  })

  test('register get_full_document read-only, ahead of the section tools, with followIncludes on each of them', () => {
    const at = OPERATION_NAMES.indexOf('get_full_document')
    expect(OPERATION_NAMES.slice(at - 1, at + 4)).toEqual([
      'delete_entities',
      'get_full_document',
      'get_sections',
      'get_section_content',
      'write_section',
    ])
    expect(OPERATIONS.get_full_document.annotations).toStrictEqual({ readOnlyHint: true })
    expect(OPERATIONS.get_full_document.effects).toEqual(['overleaf-read'])
    expect(OPERATIONS.get_full_document.outputSchema.shape.sourceMap).toBeDefined()
    for (const name of ['get_sections', 'get_section_content', 'write_section'] as const) {
      // Off by default, so a call that leaves it out keeps the single-file behaviour.
      expect(OPERATIONS[name].inputSchema.shape.followIncludes.parse(undefined), name).toBe(false)
    }
    expect(OPERATIONS.get_full_document.inputSchema.parse({ projectId: 'p' })).toEqual({ projectId: 'p', maxDepth: 10 })
  })

  test('register manage_tags after update_project_settings, destructive and confirmed by name', () => {
    const at = OPERATION_NAMES.indexOf('update_project_settings')
    expect(OPERATION_NAMES[at + 1]).toBe('manage_tags')
    expect(OPERATIONS.manage_tags.annotations).toStrictEqual({ destructiveHint: true, idempotentHint: false })
    expect(OPERATIONS.manage_tags.effects).toEqual(['project-lifecycle', 'overleaf-read', 'overleaf-delete'])
    const input = operationContract('manage_tags').inputSchema!
    expect(input.safeParse({ action: 'create', name: 'Thesis', color: '#336699' }).success).toBe(true)
    expect(input.safeParse({ action: 'create', name: 'x'.repeat(51) }).success).toBe(false)
    expect(input.safeParse({ action: 'create', name: 'Thesis', color: 'red' }).success).toBe(false)
    expect(input.safeParse({ action: 'create', name: 'Thesis', color: 'hsl(120, 70%, 45%)' }).success).toBe(true)
    expect(input.safeParse({ action: 'add_projects', tagId: 't', projectIds: [] }).success).toBe(false)
  })

  test('register the two tracked-change operations after set_comment_status, annotated exactly', () => {
    const at = OPERATION_NAMES.indexOf('set_comment_status')
    expect(OPERATION_NAMES.slice(at + 1, at + 3)).toEqual(['list_tracked_changes', 'manage_tracked_changes'])
    expect(OPERATION_NAMES).toHaveLength(35)
    expect(OPERATIONS.list_tracked_changes.annotations).toStrictEqual({ readOnlyHint: true })
    expect(OPERATIONS.list_tracked_changes.effects).toEqual(['overleaf-read'])
    expect(OPERATIONS.manage_tracked_changes.annotations).toStrictEqual({ destructiveHint: true, idempotentHint: true })
    expect(OPERATIONS.manage_tracked_changes.effects).toEqual(['overleaf-write', 'overleaf-read'])
    for (const name of ['list_tracked_changes', 'manage_tracked_changes'] as const) {
      expect(operationContract(name).outputSchema, name).toBeDefined()
    }
    // confirmCount is checked by the operation, so a missing one is CONFIRMATION_MISMATCH, not a schema error.
    const input = operationContract('manage_tracked_changes').inputSchema!
    const base = { projectId: 'p', filePath: 'main.tex', revision: 'r', action: 'accept', changeIds: ['c'] }
    expect(input.safeParse(base).success).toBe(true)
    expect(input.safeParse({ ...base, changeIds: [] }).success).toBe(false)
    expect(
      input.safeParse({ ...base, changeIds: Array.from({ length: 501 }, (_, index) => `c${index}`) }).success
    ).toBe(false)
    const list = operationContract('list_tracked_changes').inputSchema!
    expect(list.safeParse({ projectId: 'p', excerptChars: 501 }).success).toBe(false)
    expect(list.safeParse({ projectId: 'p', limit: 0 }).success).toBe(false)
    expect(list.parse({ projectId: 'p' })).toEqual({ projectId: 'p', excerptChars: 120, limit: 100 })
  })

  test('list every error code once, POLICY_DENIED included', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
    expect(ERROR_CODES).toContain('POLICY_DENIED')
  })

  test('accept only lowercase 40-character hashes for expectedHash', () => {
    const expectedHash = shape('upload_file').expectedHash as { safeParse(value: unknown): { success: boolean } }
    expect(expectedHash.safeParse('a'.repeat(40)).success).toBe(true)
    expect(expectedHash.safeParse('A'.repeat(40)).success).toBe(false)
    expect(expectedHash.safeParse('a'.repeat(39)).success).toBe(false)
  })
})
