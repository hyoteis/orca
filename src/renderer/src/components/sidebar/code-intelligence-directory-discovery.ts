import type { DirEntry } from '../../../../shared/types'
import { resolveRuntimePath } from '../../../../shared/cross-platform-path'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import { sortCodeIntelligenceDirectories } from './code-intelligence-directory-list'

export const CODE_INTELLIGENCE_DIRECTORY_SCAN_DEPTH = 5

const DIRECTORY_READ_CONCURRENCY = 8

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
        if (!entry.isSymlink) {
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
    entry.name !== '.' &&
    entry.name !== '..' &&
    !entry.name.includes('/') &&
    !entry.name.includes('\\')
  )
}
