import { describe, expect, test } from 'vitest'

import { packProblems, REQUIRED_FILES } from '../../scripts/check-pack.js'

describe('packed file list', () => {
  test('accepts the required files with built output', () => {
    expect(packProblems([...REQUIRED_FILES, 'dist/runtime.js', 'docs/changelog.md'])).toEqual([])
  })

  test('names each missing required file', () => {
    const paths = REQUIRED_FILES.filter(path => path !== 'dist/cli.js' && !path.startsWith('skills/overleaf-sync'))
    expect(packProblems(paths)).toEqual(['missing dist/cli.js', 'missing skills/overleaf-sync-sources/SKILL.md'])
  })

  test.each(['src/cli.ts', 'test/server.test.ts', 'scripts/check-pack.ts', 'cookies.txt', '.env'])(
    'refuses to publish %s',
    path => {
      expect(packProblems([...REQUIRED_FILES, path])).toEqual([`must not publish ${path}`])
    }
  )
})
