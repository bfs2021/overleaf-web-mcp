import { describe, expect, test } from 'vitest'

import { resolveAuthPaths } from '../../src/auth/paths.js'
import { readConfig } from '../../src/config.js'

describe('configuration', () => {
  test('uses a platform config directory when no cookie path is configured', () => {
    const config = readConfig({ XDG_CONFIG_HOME: '/tmp/xdg' }, { platform: 'linux', homeDir: '/home/alice' })

    expect(config).toMatchObject({
      cookieJarFile: '/tmp/xdg/overleaf-web-mcp/cookies.txt',
      browserProfileDir: '/tmp/xdg/overleaf-web-mcp/chrome-profile',
      loginTimeoutMs: 300_000,
    })
  })

  test('normalizes the base URL and applies conservative defaults', () => {
    const config = readConfig({
      OVERLEAF_COOKIE_JAR_FILE: '/tmp/cookies.txt',
      OVERLEAF_BASE_URL: 'https://example.test/',
      OVERLEAF_BROWSER_PATH: '/opt/chrome',
      OVERLEAF_BROWSER_PROFILE_DIR: '/tmp/profile',
      OVERLEAF_LOGIN_TIMEOUT_MS: '60000',
    })

    expect(config).toMatchObject({
      baseUrl: 'https://example.test',
      cookieJarFile: '/tmp/cookies.txt',
      browserPath: '/opt/chrome',
      browserProfileDir: '/tmp/profile',
      loginTimeoutMs: 60_000,
      maxDocLength: 2_097_152,
      maxUpdateChars: 7 * 1024 * 1024,
      socketCacheSize: 2,
      socketIdleTtlMs: 90_000,
      compileTimeoutMs: 120_000,
    })
  })

  test('reads the retry and pacing settings, capping attempts at three and the interval at a minute', () => {
    const base = { OVERLEAF_COOKIE_JAR_FILE: '/tmp/cookies.txt' }
    expect(readConfig(base)).toMatchObject({ readAttempts: 3, minRequestIntervalMs: 0 })
    expect(readConfig({ ...base, OVERLEAF_READ_ATTEMPTS: '1', OVERLEAF_MIN_REQUEST_INTERVAL_MS: '250' })).toMatchObject(
      { readAttempts: 1, minRequestIntervalMs: 250 }
    )
    expect(
      readConfig({ ...base, OVERLEAF_READ_ATTEMPTS: '9', OVERLEAF_MIN_REQUEST_INTERVAL_MS: '999999' })
    ).toMatchObject({ readAttempts: 3, minRequestIntervalMs: 60_000 })
    for (const [name, value] of [
      ['OVERLEAF_READ_ATTEMPTS', '0'],
      ['OVERLEAF_READ_ATTEMPTS', '1.5'],
      ['OVERLEAF_READ_ATTEMPTS', 'three'],
      ['OVERLEAF_MIN_REQUEST_INTERVAL_MS', '-1'],
      ['OVERLEAF_MIN_REQUEST_INTERVAL_MS', 'soon'],
    ] as const) {
      expect(() => readConfig({ ...base, [name]: value }), `${name}=${value}`).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' })
      )
    }
  })

  test('resolves platform-specific authentication paths', () => {
    expect(resolveAuthPaths({ platform: 'darwin', homeDir: '/Users/alice', env: {} })).toEqual({
      cookieJarFile: '/Users/alice/Library/Application Support/overleaf-web-mcp/cookies.txt',
      browserProfileDir: '/Users/alice/Library/Application Support/overleaf-web-mcp/chrome-profile',
    })
    expect(
      resolveAuthPaths({
        platform: 'win32',
        homeDir: 'C:\\Users\\alice',
        env: { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' },
      })
    ).toEqual({
      cookieJarFile: 'C:\\Users\\alice\\AppData\\Roaming\\overleaf-web-mcp\\cookies.txt',
      browserProfileDir: 'C:\\Users\\alice\\AppData\\Roaming\\overleaf-web-mcp\\chrome-profile',
    })
  })
})
