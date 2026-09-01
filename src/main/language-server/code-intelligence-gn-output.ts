import { localCppBuildRootDetection, type CppBuildRootDetection } from './code-intelligence-cmake-root-selection'

/** Walks up from `sourceDir` to `searchBound` (inclusive) looking for a `.gn`
 * dotfile. Relative members bound at the workspace root, absolute members at
 * the filesystem root. */
export async function findGnRoot(
  searchBound: string,
  sourceDir: string,
  detection: CppBuildRootDetection = localCppBuildRootDetection
): Promise<string | null> {
  let current = sourceDir
  for (;;) {
    if (await detection.isReadablePath(detection.join(current, '.gn'))) {
      return current
    }
    if (
      current === searchBound ||
      detection.relative(searchBound, current).startsWith('..')
    ) {
      return null
    }
    const parent = detection.dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

async function gnOutputDirectories(
  gnRoot: string,
  detection: CppBuildRootDetection
): Promise<string[]> {
  const candidates: string[] = []
  for (const name of ['out', 'build']) {
    // Missing conventional output directories are expected before the first GN generation.
    const directories = await detection.listSubdirectories(detection.join(gnRoot, name))
    candidates.push(
      ...directories.sort((left, right) => {
        const leftDefault = /[\\/](default|debug)$/i.test(left) ? 0 : 1
        const rightDefault = /[\\/](default|debug)$/i.test(right) ? 0 : 1
        return leftDefault - rightDefault || left.localeCompare(right)
      })
    )
  }
  return candidates
}

export async function findGnOutputFile(
  gnRoot: string,
  name: string,
  detection: CppBuildRootDetection = localCppBuildRootDetection
): Promise<string | null> {
  for (const directory of await gnOutputDirectories(gnRoot, detection)) {
    const candidate = detection.join(directory, name)
    if (await detection.isReadablePath(candidate)) {
      return candidate
    }
  }
  return null
}
