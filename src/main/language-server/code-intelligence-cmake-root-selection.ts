import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { isRuntimePathAbsolute } from '../../shared/cross-platform-path'

export type CppBuildRoot = {
  /** Member as spelled for logs and errors: relative member string or host-native absolute path. */
  memberLabel: string
  sourceDir: string
  system: 'cmake' | 'gn' | 'basic'
}

/** True when `candidate` is `parent` itself or anywhere underneath it. */
export function pathContains(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/** Upward-search ceiling for a member: relative forms stop at the workspace
 * root, absolute forms at the filesystem root of the member's source dir. */
export function cppUpwardSearchBound(root: CppBuildRoot, workspaceRoot: string): string {
  return isRuntimePathAbsolute(root.memberLabel) ? parse(root.sourceDir).root : workspaceRoot
}

function isFilesystemRoot(path: string): boolean {
  return parse(path).root === path
}

async function isReadablePath(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** Path/check seams: local setups use node fs; SSH setups pass posix + remote `test -r`. */
export type CppBuildRootDetection = {
  join: typeof join
  resolve: typeof resolve
  isReadablePath: (path: string) => Promise<boolean>
}

export async function detectCppBuildRoot(
  workspaceRoot: string,
  memberRoot: string,
  detection: CppBuildRootDetection = { join, resolve, isReadablePath }
): Promise<CppBuildRoot> {
  // Absolute members arrive with normalized forward slashes; resolve() restores
  // the host-native spelling so generator args and logs match the workspace form.
  const absolute = isRuntimePathAbsolute(memberRoot)
  const sourceDir = absolute ? detection.resolve(memberRoot) : detection.join(workspaceRoot, memberRoot)
  const memberLabel = absolute ? sourceDir : memberRoot
  if (await detection.isReadablePath(detection.join(sourceDir, 'CMakeLists.txt'))) {
    return { memberLabel, sourceDir, system: 'cmake' }
  }
  if (
    (await detection.isReadablePath(detection.join(sourceDir, 'BUILD.gn'))) ||
    (await detection.isReadablePath(detection.join(sourceDir, '.gn')))
  ) {
    return { memberLabel, sourceDir, system: 'gn' }
  }
  if (await detection.isReadablePath(sourceDir)) {
    return { memberLabel, sourceDir, system: 'basic' }
  }
  throw new Error(`Selected folder is no longer available: ${memberRoot}`)
}

/** Coalesces one form's cmake roots up to `bound`. Absolute members bound at the
 * filesystem root may not coalesce there; relative members may coalesce at the
 * workspace root. */
async function coalesceCmakeGroup(
  group: readonly CppBuildRoot[],
  bound: string,
  rejectAtBound: boolean
): Promise<CppBuildRoot[]> {
  if (group.length < 2) {
    return [...group]
  }
  let commonRoot = group[0].sourceDir
  for (;;) {
    if (rejectAtBound && isFilesystemRoot(commonRoot)) {
      break
    }
    if (
      group.every((root) => pathContains(commonRoot, root.sourceDir)) &&
      (await isReadablePath(join(commonRoot, 'CMakeLists.txt')))
    ) {
      const memberLabel = rejectAtBound
        ? commonRoot
        : relative(bound, commonRoot).replace(/\\/g, '/') || '.'
      return [{ memberLabel, sourceDir: commonRoot, system: 'cmake' }]
    }
    if (commonRoot === bound) {
      break
    }
    const parent = dirname(commonRoot)
    if (parent === commonRoot) {
      break
    }
    commonRoot = parent
  }
  return [...group]
}

export async function coalesceCmakeBuildRoots(
  workspaceRoot: string,
  roots: readonly CppBuildRoot[]
): Promise<CppBuildRoot[]> {
  // Forms never mix: a relative member's coalescing ceiling is the workspace
  // root, an absolute member's is the filesystem root.
  const cmakeRoots = roots.filter((root) => root.system === 'cmake')
  if (cmakeRoots.length < 2) {
    return [...roots]
  }
  const relativeForm = cmakeRoots.filter((root) => !isRuntimePathAbsolute(root.memberLabel))
  const absoluteForm = cmakeRoots.filter((root) => isRuntimePathAbsolute(root.memberLabel))
  const others = roots.filter((root) => root.system !== 'cmake')
  return [
    ...(await coalesceCmakeGroup(relativeForm, workspaceRoot, false)),
    ...(await coalesceCmakeGroup(
      absoluteForm,
      absoluteForm.length > 0 ? cppUpwardSearchBound(absoluteForm[0], workspaceRoot) : workspaceRoot,
      true
    )),
    ...others
  ]
}
