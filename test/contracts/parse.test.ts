import { describe, expect, test } from 'vitest'
import { z } from 'zod'

import { OPERATION_NAMES } from '../../src/contracts/operations.js'
import { parseOperationInput, unknownKeys } from '../../src/contracts/parse.js'
import { INPUTS } from '../helpers/operation-inputs.js'

describe('strict operation input', () => {
  test('refuses a misspelled key instead of falling back to its default', () => {
    const input = { projectId: 'p', filePath: 'main.tex', revision: 'r', content: 'x', writemode: 'tracked' }
    expect(() => parseOperationInput('write_file', input)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', details: { unknownKeys: ['writemode'] } })
    )
  })

  test('names unknown keys at any depth, and only those', () => {
    const input = {
      projectId: 'p',
      files: [
        { localPath: '/a.png', destinationPath: 'a.png' },
        { localPath: '/b.png', destinationpath: 'b.png' },
      ],
    }
    expect(() => parseOperationInput('batch_upload', input)).toThrow(
      expect.objectContaining({ details: { unknownKeys: ['files.1.destinationpath'] } })
    )
    const comment = {
      projectId: 'p',
      filePath: 'f',
      revision: 'r',
      start: { line: 1, column: 1, col: 2 },
      end: { line: 1, column: 2 },
      expectedText: 'a',
      content: 'b',
    }
    expect(() => parseOperationInput('add_comment', comment)).toThrow(
      expect.objectContaining({ details: { unknownKeys: ['start.col'] } })
    )
  })

  test('applies the contract defaults, as the MCP server does', () => {
    expect(parseOperationInput('list_projects', {})).toEqual({
      includeArchived: false,
      includeTrashed: false,
      includeTags: false,
      limit: 50,
      sort: 'lastUpdated',
    })
    expect(
      parseOperationInput('write_file', { projectId: 'p', filePath: 'f', revision: 'r', content: '' })
    ).toMatchObject({
      writeMode: 'untracked',
    })
  })

  test('refuses any key for an operation without parameters, and anything but an object', () => {
    expect(parseOperationInput('auth_status', {})).toEqual({})
    expect(() => parseOperationInput('auth_status', { verbose: true })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', details: { unknownKeys: ['verbose'] } })
    )
    for (const input of [null, [], 'x', 3]) {
      expect(() => parseOperationInput('read_file', input)).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' })
      )
    }
  })

  test('reports schema violations by path without quoting the value', () => {
    const secret = 'manuscript text that must not be echoed'
    let caught: unknown
    try {
      parseOperationInput('write_file', {
        projectId: 'p',
        filePath: 'f',
        revision: 'r',
        content: 'x',
        writeMode: secret,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'INVALID_ARGUMENT', details: { issues: [{ path: 'writeMode' }] } })
    expect(JSON.stringify(caught)).not.toContain(secret)
    expect((caught as Error).message).not.toContain(secret)
  })

  test('reports a key named after an Object.prototype member as unknown, at any depth', () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(() => parseOperationInput('read_file', { projectId: 'p', filePath: 'f', [key]: 1 })).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT', details: { unknownKeys: [key] } })
      )
    }
    const nested = { projectId: 'p', files: [{ localPath: '/a.png', destinationPath: 'a.png', toString: 1 }] }
    expect(() => parseOperationInput('batch_upload', nested)).toThrow(
      expect.objectContaining({ details: { unknownKeys: ['files.0.toString'] } })
    )
    const proto = JSON.parse('{"projectId":"p","filePath":"f","__proto__":{"x":1}}') as unknown
    expect(() => parseOperationInput('read_file', proto)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', details: { unknownKeys: ['__proto__'] } })
    )
  })

  test('accepts every key of a loose object and of a record', () => {
    const schema = z.object({ known: z.object({}).loose(), map: z.record(z.string(), z.object({ a: z.number() })) })
    expect(unknownKeys(schema, { known: { anything: 1 }, map: { x: { a: 1, b: 2 } } })).toEqual(['map.x.b'])
  })

  test('looks inside unions, judging the value by the members it fits', () => {
    const schema = z.object({
      operations: z.array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('add'), path: z.string() }),
          z.object({ type: z.literal('rename'), path: z.string(), newPath: z.string() }),
        ])
      ),
    })
    expect(unknownKeys(schema, { operations: [{ type: 'rename', path: 'a', newPath: 'b' }] })).toEqual([])
    expect(unknownKeys(schema, { operations: [{ type: 'add', path: 'a', newPath: 'b' }] })).toEqual([
      'operations.0.newPath',
    ])
  })

  test("names an unknown key at every object position of every operation's valid input", () => {
    const injected = 'zzUnknown'
    const positions = new Set<string>()
    for (const name of OPERATION_NAMES) {
      for (const path of objectPaths(INPUTS[name])) {
        positions.add(path)
        // Copied as JSON, since INPUTS shares one object between add_comment's start and end.
        const input = JSON.parse(JSON.stringify(INPUTS[name])) as Record<string, unknown>
        objectAt(input, path)[injected] = 1
        expect(() => parseOperationInput(name, input), `${name} at "${path}"`).toThrow(
          expect.objectContaining({ code: 'INVALID_ARGUMENT', details: { unknownKeys: [`${path}${injected}`] } })
        )
      }
    }
    // The walk reaches nested objects, in arrays and out of them, not only the top level.
    expect([...positions]).toEqual(expect.arrayContaining(['', 'files.0.', 'start.', 'end.']))
  })
})

/** The dotted path, ending in a dot, of the value's top-level object and every object inside it. */
function objectPaths(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => objectPaths(item, `${path}${index}.`))
  if (typeof value !== 'object' || value === null) return []
  return [path, ...Object.entries(value).flatMap(([key, item]) => objectPaths(item, `${path}${key}.`))]
}

function objectAt(value: Record<string, unknown>, path: string): Record<string, unknown> {
  return path
    .split('.')
    .filter(key => key !== '')
    .reduce<Record<string, unknown>>((object, key) => object[key] as Record<string, unknown>, value)
}
