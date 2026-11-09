import { readFile, readdir } from 'node:fs/promises'

import { describe, expect, test } from 'vitest'

import { ALIASES } from '../src/cli/commands.js'
import { OPERATION_NAMES } from '../src/contracts/operations.js'
import { ERROR_CODES } from '../src/contracts/error-codes.js'

// The documentation site tags each feature with the release that introduced it, as
// `<!-- md:version X.Y.Z -->`; overrides/hooks/shortcodes.py renders the badge. These checks keep
// every tag pointing at a real release and every feature tagged.

const root = new URL('../', import.meta.url)
// Not inside an inline code span, as the hook skips those.
const BADGE = /(?<!`)<!-- md:version (\S+) -->(?!`)/gu

async function text(path: string): Promise<string> {
  return await readFile(new URL(path, root), 'utf8')
}

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n${heading}\n`)
  expect(start, `section "${heading}"`).toBeGreaterThanOrEqual(0)
  const end = markdown.indexOf('\n## ', start + 1)
  return markdown.slice(start, end === -1 ? undefined : end)
}

function tableRows(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter(line => line.startsWith('| ') && !line.startsWith('| ---') && !line.startsWith('| :'))
    .slice(1)
}

function lastCell(row: string): string {
  const cells = row.split(' | ')
  return cells[cells.length - 1]!
}

describe('version tags in the documentation', () => {
  test('name only releases that have a heading in CHANGELOG.md', async () => {
    const releases = new Set(
      [...(await text('CHANGELOG.md')).matchAll(/^## \[(\d+\.\d+\.\d+)\]/gmu)].map(match => match[1])
    )
    const pages = (await readdir(new URL('docs/', root))).filter(name => name.endsWith('.md'))
    let tags = 0
    for (const page of pages) {
      for (const match of (await text(`docs/${page}`)).matchAll(BADGE)) {
        tags += 1
        expect(releases, `docs/${page}: ${match[0]}`).toContain(match[1])
      }
    }
    expect(tags).toBeGreaterThan(0)
  })

  test('tag every tool heading in docs/tools.md', async () => {
    const reference = await text('docs/tools.md')
    const tagged = [...reference.matchAll(/^### `([a-z_]+)`[^\n]*\n\n<!-- md:version \S+ -->$/gmu)].map(
      match => match[1]
    )
    expect([...tagged].sort()).toEqual([...OPERATION_NAMES].sort())
  })

  test('tag every command in the docs/cli.md Commands tables', async () => {
    const rows = tableRows(section(await text('docs/cli.md'), '## Commands')).filter(
      line => !line.startsWith('| Command |')
    )
    for (const row of rows) expect(lastCell(row), row.slice(0, 40)).toMatch(/^<!-- md:version \S+ --> \|$/u)
    for (const word of ['serve', 'login', 'keepalive', '--help', 'call', 'schema', 'capabilities', 'doctor']) {
      expect(
        rows.some(line => line.startsWith(`| \`${word}\` |`)),
        word
      ).toBe(true)
    }
    for (const alias of ALIASES) {
      expect(
        rows.some(line => line.startsWith(`| \`${alias.words.join(' ')}\` |`)),
        alias.words.join(' ')
      ).toBe(true)
    }
  })

  test('tag every variable, error code, and stable export in its table', async () => {
    const tables = [
      ['docs/configuration.md', '## Reference'],
      ['docs/safety.md', '## Error codes'],
      ['docs/sdk.md', '## Stable surface'],
    ] as const
    for (const [page, heading] of tables) {
      const rows = tableRows(section(await text(page), heading))
      expect(rows.length, `${page} ${heading}`).toBeGreaterThan(0)
      for (const row of rows)
        expect(lastCell(row), `${page}: ${row.slice(0, 60)}`).toMatch(/^<!-- md:version \S+ --> \|$/u)
    }
    const errors = tableRows(section(await text('docs/safety.md'), '## Error codes'))
    for (const code of ERROR_CODES)
      expect(
        errors.some(row => row.startsWith(`| \`${code}\` |`)),
        code
      ).toBe(true)
  })
})
