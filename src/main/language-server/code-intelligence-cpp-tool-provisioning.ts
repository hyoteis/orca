import { join } from 'node:path'
import { executableName, isExecutable } from './code-intelligence-cpp-setup-tools'

/** Shared bundled-gn candidate table; `joinPath` keeps remote paths POSIX. */
export function bundledGnCandidatePaths(
  workspaceRoot: string,
  platform: NodeJS.Platform,
  joinPath: (...parts: string[]) => string = join
): string[] {
  const gn = executableName('gn', platform)
  const directories =
    platform === 'win32'
      ? ['win', 'win64']
      : platform === 'darwin'
        ? ['mac', 'mac_arm64']
        : ['linux64', 'linux']
  return [
    ...directories.map((directory) => joinPath(workspaceRoot, 'buildtools', directory, gn)),
    joinPath(workspaceRoot, 'buildtools', gn),
    joinPath(workspaceRoot, 'tools', gn)
  ]
}

export async function discoverBundledGn(
  workspaceRoot: string,
  platform: NodeJS.Platform
): Promise<string | null> {
  for (const candidate of bundledGnCandidatePaths(workspaceRoot, platform)) {
    if (await isExecutable(candidate)) {
      return candidate
    }
  }
  return null
}
