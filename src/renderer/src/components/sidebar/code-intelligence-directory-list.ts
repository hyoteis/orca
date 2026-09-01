import { isRuntimePathAbsolute } from '../../../../shared/cross-platform-path'

const directoryCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base'
})

function normalizeDirectoryPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.'
}

function topLevelDirectory(path: string): string {
  const normalized = normalizeDirectoryPath(path)
  return normalized === '.' ? '' : (normalized.split('/')[0] ?? '')
}

function directoryDepth(path: string): number {
  const normalized = normalizeDirectoryPath(path)
  return normalized === '.' ? 0 : normalized.split('/').length
}

export function sortCodeIntelligenceDirectories(directories: readonly string[]): string[] {
  return [...directories].sort((left, right) => {
    const topLevelOrder = directoryCollator.compare(
      topLevelDirectory(left),
      topLevelDirectory(right)
    )
    if (topLevelOrder !== 0) {
      return topLevelOrder
    }
    const depthOrder = directoryDepth(left) - directoryDepth(right)
    return depthOrder || directoryCollator.compare(left, right)
  })
}

export function filterCodeIntelligenceDirectories(
  directories: readonly string[],
  query: string
): string[] {
  const normalizedQuery = normalizeDirectoryPath(query.trim()).toLocaleLowerCase()
  if (!query.trim()) {
    return [...directories]
  }
  return directories.filter((directory) =>
    normalizeDirectoryPath(directory).toLocaleLowerCase().includes(normalizedQuery)
  )
}

export function discoverCodeIntelligenceDirectories(relativeFiles: readonly string[]): string[] {
  const directories = new Set<string>(['.'])
  for (const file of relativeFiles) {
    const directoryEntry = /[\\/]$/.test(file)
    const segments = file.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean)
    const directorySegmentCount = directoryEntry
      ? segments.length
      : Math.max(0, segments.length - 1)
    let path = ''
    for (let index = 0; index < directorySegmentCount; index += 1) {
      path = path ? `${path}/${segments[index]}` : segments[index]
      if (!path.split('/').includes('.git')) {
        directories.add(path)
      }
    }
  }
  return sortCodeIntelligenceDirectories([...directories])
}

function directoryAncestors(path: string): string[] {
  if (path === '.') {
    return []
  }
  const segments = path.split('/')
  const ancestors: string[] = ['.']
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join('/'))
  }
  return ancestors
}

export function getMinimalCodeIntelligenceDirectories(
  directories: readonly string[],
  selected: ReadonlySet<string>
): string[] {
  return sortCodeIntelligenceDirectories(
    directories.filter(
      (directory) =>
        selected.has(directory) &&
        !directoryAncestors(directory).some((ancestor) => selected.has(ancestor))
    )
  )
}

/** Host-absolute selections the workspace scan cannot know about — typed in by hand. */
export function getCodeIntelligenceCustomPaths(
  directories: readonly string[],
  selected: ReadonlySet<string>
): string[] {
  return [...selected]
    .filter((path) => isRuntimePathAbsolute(path) && !directories.includes(path))
    .sort((left, right) => directoryCollator.compare(left, right))
}
