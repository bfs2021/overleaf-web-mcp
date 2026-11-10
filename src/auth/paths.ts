import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

export interface AuthPathOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  homeDir?: string
}

export interface AuthPaths {
  cookieJarFile: string
  browserProfileDir: string
}

export function resolveAuthPaths(options: AuthPathOptions = {}): AuthPaths {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? homedir()
  const path = platform === 'win32' ? win32 : posix
  // A blank setting is a setting the launcher filled in with nothing, so it gets the default.
  const appData = env.APPDATA?.trim()
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim()

  let configRoot: string
  if (platform === 'darwin') {
    configRoot = path.join(homeDir, 'Library', 'Application Support')
  } else if (platform === 'win32') {
    configRoot = appData ? appData : path.join(homeDir, 'AppData', 'Roaming')
  } else {
    configRoot = xdgConfigHome ? xdgConfigHome : path.join(homeDir, '.config')
  }

  const authRoot = path.join(configRoot, 'overleaf-web-mcp')
  return {
    cookieJarFile: path.join(authRoot, 'cookies.txt'),
    browserProfileDir: path.join(authRoot, 'chrome-profile'),
  }
}
