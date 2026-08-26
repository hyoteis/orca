import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'

export type CppBuildRoot = {
  relativeRoot: string
  sourceDir: string
  system: 'cmake' | 'gn' | 'basic'
}

function pathContains(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

async function isReadablePath(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

export async function detectCppBuildRoot(
  workspaceRoot: string,
  relativeRoot: string
): Promise<CppBuildRoot> {
  const sourceDir = join(workspaceRoot, relativeRoot)
  if (await isReadablePath(join(sourceDir, 'CMakeLists.txt'))) {
    return { relativeRoot, sourceDir, system: 'cmake' }
  }
  if (
    (await isReadablePath(join(sourceDir, 'BUILD.gn'))) ||
    (await isReadablePath(join(sourceDir, '.gn')))
  ) {
    return { relativeRoot, sourceDir, system: 'gn' }
  }
  if (await isReadablePath(sourceDir)) {
    return { relativeRoot, sourceDir, system: 'basic' }
  }
  throw new Error(`Selected folder is no longer available: ${relativeRoot}`)
}

export async function coalesceCmakeBuildRoots(
  workspaceRoot: string,
  roots: readonly CppBuildRoot[]
): Promise<CppBuildRoot[]> {
  const cmakeRoots = roots.filter((root) => root.system === 'cmake')
  if (cmakeRoots.length < 2) {
    return [...roots]
  }
  let commonRoot = cmakeRoots[0].sourceDir
  while (pathContains(workspaceRoot, commonRoot)) {
    if (
      cmakeRoots.every((root) => pathContains(commonRoot, root.sourceDir)) &&
      (await isReadablePath(join(commonRoot, 'CMakeLists.txt')))
    ) {
      const relativeRoot = relative(workspaceRoot, commonRoot).replace(/\\/g, '/') || '.'
      return [
        { relativeRoot, sourceDir: commonRoot, system: 'cmake' },
        ...roots.filter((root) => root.system !== 'cmake')
      ]
    }
    if (commonRoot === workspaceRoot) {
      break
    }
    commonRoot = dirname(commonRoot)
  }
  return [...roots]
}
