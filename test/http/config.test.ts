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

  test('treats a blank variable as unset, as a launcher that passes every declared one would', () => {
    const context = { platform: 'linux' as const, homeDir: '/home/alice' }
    for (const blank of ['', '   ']) {
      const config = readConfig(
        {
          XDG_CONFIG_HOME: '/tmp/xdg',
          OVERLEAF_BASE_URL: blank,
          OVERLEAF_COOKIE_JAR_FILE: blank,
          OVERLEAF_BROWSER_PATH: blank,
          OVERLEAF_BROWSER_PROFILE_DIR: blank,
          OVERLEAF_PROTOCOL_VERSIONS: blank,
          OVERLEAF_LOGIN_TIMEOUT_MS: blank,
          OVERLEAF_MIN_REQUEST_INTERVAL_MS: blank,
        },
        context
      )

      expect(config, `blank of ${blank.length} characters`).toMatchObject({
        baseUrl: 'https://www.overleaf.com',
        cookieJarFile: '/tmp/xdg/overleaf-web-mcp/cookies.txt',
        browserProfileDir: '/tmp/xdg/overleaf-web-mcp/chrome-profile',
        supportedProtocolVersions: [2],
        loginTimeoutMs: 300_000,
        minRequestIntervalMs: 0,
      })
      expect(config.browserPath).toBeUndefined()
    }
  })

  test('keeps rejecting a malformed non-empty base URL', () => {
    expect(() => readConfig({ OVERLEAF_BASE_URL: 'not a url' })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    )
  })

  test('falls back to the platform configuration directory when its own variable is blank', () => {
    expect(resolveAuthPaths({ platform: 'linux', homeDir: '/home/alice', env: { XDG_CONFIG_HOME: '  ' } })).toEqual({
      cookieJarFile: '/home/alice/.config/overleaf-web-mcp/cookies.txt',
      browserProfileDir: '/home/alice/.config/overleaf-web-mcp/chrome-profile',
    })
    expect(resolveAuthPaths({ platform: 'win32', homeDir: 'C:\\Users\\alice', env: { APPDATA: '' } })).toEqual({
      cookieJarFile: 'C:\\Users\\alice\\AppData\\Roaming\\overleaf-web-mcp\\cookies.txt',
      browserProfileDir: 'C:\\Users\\alice\\AppData\\Roaming\\overleaf-web-mcp\\chrome-profile',
    })
  })
})
