import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { DEFAULT_SYNC_IGNORE, loadSyncIgnoreRules } from '../../src/core/ignore-rules.js'
import { scanLocalFolder } from '../../src/core/local-folder.js'

async function folder(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'overleaf-scan-'))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

describe('sync ignore rules', () => {
  test('ship the documented defaults and name the pattern that matched', async () => {
    const rules = await loadSyncIgnoreRules(await folder({}))

    expect(DEFAULT_SYNC_IGNORE).toEqual(expect.arrayContaining(['.*', '__MACOSX/', '*.aux', '*.synctex.gz', '*.fls']))
    expect(rules.match('.git', true)).toBe('.git/')
    expect(rules.match('.DS_Store', false)).toBe('.DS_Store')
    expect(rules.match('chapters/.hidden.tex', false)).toBe('.*')
    expect(rules.match('build/main.aux', false)).toBe('*.aux')
    expect(rules.match('__MACOSX', true)).toBe('__MACOSX/')
    expect(rules.match('main.tex', false)).toBeUndefined()
    expect(rules.match('figures', true)).toBeUndefined()
  })

  test('apply .olignore after the defaults and the caller patterns last, so ! re-includes', async () => {
    const root = await folder({ '.olignore': 'drafts/\n*.pdf\n' })
    const rules = await loadSyncIgnoreRules(root, ['!.latexmkrc', '!keep.pdf'])

    expect(rules.olignore).toBe('drafts/\n*.pdf\n')
    expect(rules.match('drafts', true)).toBe('drafts/')
    expect(rules.match('drafts/notes.tex', false)).toBe('drafts/')
    expect(rules.match('figure.pdf', false)).toBe('*.pdf')
    expect(rules.match('keep.pdf', false)).toBeUndefined()
    expect(rules.match('.latexmkrc', false)).toBeUndefined()
    // A folder pattern only matches folders.
    expect(rules.match('drafts', false)).toBeUndefined()
  })

  test('refuse an .olignore that links outside the folder, since its patterns are echoed back', async () => {
    const elsewhere = await folder({ 'private.txt': 'not for the plan\n' })
    const root = await folder({ 'notes/real.olignore': '*.pdf\n' })
    await symlink(join(elsewhere, 'private.txt'), join(root, '.olignore'))
    await expect(loadSyncIgnoreRules(root)).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ROOT',
      details: { kind: 'outside_folder' },
    })

    // A link that stays inside the folder is read as before.
    const inside = await folder({ 'notes/real.olignore': '*.pdf\n' })
    await symlink(join(inside, 'notes', 'real.olignore'), join(inside, '.olignore'))
    await expect(loadSyncIgnoreRules(inside)).resolves.toMatchObject({ olignore: '*.pdf\n' })
  })
})

describe('local folder scan', () => {
  test('lists included files with blob hashes in a stable order and reports ignored entries once', async () => {
    const root = await folder({
      'main.tex': 'hello\n',
      'figures/b.png': 'b',
      'figures/a.png': 'a',
      'main.aux': 'build output',
      '.git/config': 'never read',
      '.git/objects/aa': 'never read',
    })

    const scan = await scanLocalFolder(root, await loadSyncIgnoreRules(root))

    expect(scan.files.map(file => file.path)).toEqual(['figures/a.png', 'figures/b.png', 'main.tex'])
    expect(scan.files.find(file => file.path === 'main.tex')?.hash).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
    expect(scan.directories).toEqual(['figures'])
    expect(scan.ignored).toEqual([
      { localPath: '.git/', matchedPattern: '.git/' },
      { localPath: 'main.aux', matchedPattern: '*.aux' },
    ])
  })

  test('follows a symbolic link inside the folder and refuses one that leads outside it', async () => {
    const outside = await folder({ 'secret.txt': 'outside' })
    const root = await folder({ 'real/figure.png': 'png' })
    await symlink(join(root, 'real'), join(root, 'linked'))
    const rules = await loadSyncIgnoreRules(root)

    const inside = await scanLocalFolder(root, rules)
    expect(inside.files.map(file => file.path)).toEqual(['linked/figure.png', 'real/figure.png'])

    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'))
    await expect(scanLocalFolder(root, rules)).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ROOT',
      details: { localPath: 'escape.txt' },
    })
    // An ignore pattern takes the link out of the sync, so it no longer blocks the scan.
    await expect(scanLocalFolder(root, await loadSyncIgnoreRules(root, ['escape.txt']))).resolves.toMatchObject({
      ignored: [{ localPath: 'escape.txt', matchedPattern: 'escape.txt' }],
    })
  })

  test('refuses a link back into its own parent folder and reports broken links', async () => {
    const root = await folder({ 'chapters/one.tex': 'one' })
    await symlink(join(root, 'missing.tex'), join(root, 'broken.tex'))
    const rules = await loadSyncIgnoreRules(root)
    await expect(scanLocalFolder(root, rules)).resolves.toMatchObject({
      ignored: [{ localPath: 'broken.tex', reason: 'broken symbolic link' }],
    })

    await symlink(root, join(root, 'chapters', 'loop'))
    await expect(scanLocalFolder(root, rules)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  test('reports a missing folder as NOT_FOUND and a file as INVALID_ARGUMENT', async () => {
    const root = await folder({ 'main.tex': 'x' })
    const rules = await loadSyncIgnoreRules(root)

    await expect(scanLocalFolder(join(root, 'nope'), rules)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(scanLocalFolder(join(root, 'main.tex'), rules)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })
})
