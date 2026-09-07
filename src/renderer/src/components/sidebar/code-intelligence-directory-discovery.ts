import type { DirEntry } from '../../../../shared/types'
import { resolveRuntimePath } from '../../../../shared/cross-platform-path'
import { CODE_INTELLIGENCE_SCAN_PRUNE_NAMES } from '../../../../shared/code-intelligence-directory-scan'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import { sortCodeIntelligenceDirectories } from './code-intelligence-directory-list'

export const CODE_INTELLIGENCE_DIRECTORY_SCAN_DEPTH = 5

const DIRECTORY_READ_CONCURRENCY = 8

/** Tree-first discovery: one readDirectoryTree round trip when the serving
 * runtime supports it, otherwise the per-directory BFS below. */
export async function discoverCodeIntelligenceDirectories(args: {
  workspaceRoot: string
  startDirectory: string
  readDirectory: (directoryPath: string) => Promise<readonly DirEntry[]>
  readDirectoryTree?: (
    (directoryPath: string, maxDepth: number) => Promise<string[] | null>
  ) | null
  maxDepth?: number
}): Promise<string[]> {
  const maxDepth = args.maxDepth ?? CODE_INTELLIGENCE_DIRECTORY_SCAN_DEPTH
  if (args.readDirectoryTree) {
    // Any tree failure (unsupported runtime included) falls back to the BFS.
    const tree = await args
      .readDirectoryTree(
        resolveRuntimePath(args.workspaceRoot, normalizeRelativeDirectory(args.startDirectory)),
        maxDepth
      )
      .catch(() => null)
    if (tree) {
      return sortCodeIntelligenceDirectories([...new Set(tree.map(normalizeRelativeDirectory))])
    }
  }
  return discoverCodeIntelligenceDirectoryBatch(args)
}

export async function discoverCodeIntelligenceDirectoryBatch(args: {
  workspaceRoot: string
  startDirectory: string
  readDirectory: (directoryPath: string) => Promise<readonly DirEntry[]>
  maxDepth?: number
}): Promise<string[]> {
  const startDirectory = normalizeRelativeDirectory(args.startDirectory)
  const directories = new Set<string>([startDirectory])
  let frontier = [startDirectory]
  const maxDepth = args.maxDepth ?? CODE_INTELLIGENCE_DIRECTORY_SCAN_DEPTH

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const listings = await mapWithConcurrency(
      frontier,
      DIRECTORY_READ_CONCURRENCY,
      async (relativeDirectory) => {
        try {
          const entries = await args.readDirectory(
            resolveRuntimePath(args.workspaceRoot, relativeDirectory)
          )
          return { relativeDirectory, entries }
        } catch (error) {
          if (depth === 0) {
            throw error
          }
          return { relativeDirectory, entries: [] }
        }
      }
    )
    const nextFrontier: string[] = []
    for (const { relativeDirectory, entries } of listings) {
      for (const entry of entries) {
        if (!isTraversableDirectoryName(entry) || !entry.isDirectory) {
          continue
        }
        const child = relativeDirectory === '.' ? entry.name : `${relativeDirectory}/${entry.name}`
        directories.add(child)
        if (!entry.isSymlink && !CODE_INTELLIGENCE_SCAN_PRUNE_NAMES.has(entry.name)) {
          nextFrontier.push(child)
        }
      }
    }
    frontier = nextFrontier
  }

  return sortCodeIntelligenceDirectories([...directories])
}

function normalizeRelativeDirectory(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.'
}

function isTraversableDirectoryName(entry: DirEntry): boolean {
  return (
    entry.name !== '.git' &&
    entry.name !== '.hg' &&
    entry.name !== '.svn' &&
    entry.name !== '.' &&
    entry.name !== '..' &&
    !entry.name.includes('/') &&
    !entry.name.includes('\\')
  )
}
