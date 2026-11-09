/**
 * Checks the file list `npm pack` would publish, so a release never ships without its entry
 * points, skills, or license, and never ships sources, tests, or a saved session.
 *
 *   npm run build && npx tsx scripts/check-pack.ts
 *
 * The publish workflow runs it before `npm publish`; CI runs it on every push.
 */
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** Paths every published package must contain. */
export const REQUIRED_FILES = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'dist/cli.js',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/sdk.js',
  'dist/sdk.d.ts',
  'skills/overleaf-reviewer-comments/SKILL.md',
  'skills/overleaf-revise-manuscript/SKILL.md',
  'skills/overleaf-sync-sources/SKILL.md',
] as const

/** Path prefixes and names that must never be published. */
const FORBIDDEN = [
  /^src\//u,
  /^test\//u,
  /^scripts\//u,
  /^\.github\//u,
  /^node_modules\//u,
  /cookies?\.txt$/iu,
  /\.env$/u,
]

/** Every problem with a packed file list; empty when it is fit to publish. */
export function packProblems(paths: readonly string[]): string[] {
  const present = new Set(paths)
  return [
    ...REQUIRED_FILES.filter(path => !present.has(path)).map(path => `missing ${path}`),
    ...paths.filter(path => FORBIDDEN.some(pattern => pattern.test(path))).map(path => `must not publish ${path}`),
  ]
}

function packedPaths(): string[] {
  // Scripts are skipped so prepack's build output cannot mix with the JSON; build first.
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' })
  const [entry] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>
  return (entry?.files ?? []).map(file => file.path)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = packedPaths()
  const problems = packProblems(paths)
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`${paths.length} files to publish, all required ones included.\n`)
  }
}
