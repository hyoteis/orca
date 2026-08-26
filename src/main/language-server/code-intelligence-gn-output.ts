import { access, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, relative } from 'node:path'

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

export async function findGnRoot(workspaceRoot: string, sourceDir: string): Promise<string | null> {
  let current = sourceDir
  for (;;) {
    if (await isReadable(join(current, '.gn'))) {
      return current
    }
    if (current === workspaceRoot || relative(workspaceRoot, current).startsWith('..')) {
      return null
    }
    const parent = dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

async function gnOutputDirectories(gnRoot: string): Promise<string[]> {
  const candidates: string[] = []
  for (const name of ['out', 'build']) {
    const base = join(gnRoot, name)
    try {
      const entries = await readdir(base, { withFileTypes: true })
      const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(base, entry.name))
        .sort((left, right) => {
          const leftDefault = /[\\/](default|debug)$/i.test(left) ? 0 : 1
          const rightDefault = /[\\/](default|debug)$/i.test(right) ? 0 : 1
          return leftDefault - rightDefault || left.localeCompare(right)
        })
      candidates.push(...directories)
    } catch {
      // Missing conventional output directories are expected before the first GN generation.
    }
  }
  return candidates
}

export async function findGnOutputFile(gnRoot: string, name: string): Promise<string | null> {
  for (const directory of await gnOutputDirectories(gnRoot)) {
    const candidate = join(directory, name)
    if (await isReadable(candidate)) {
      return candidate
    }
  }
  return null
}
