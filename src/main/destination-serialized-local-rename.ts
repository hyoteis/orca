import { realpath, rename } from 'node:fs/promises'
import { dirname, normalize } from 'node:path'
import { assertNoClobberRenameDestinationAvailable } from '../shared/filesystem-rename-collision'

// Why: parent scope covers native Unicode aliases without guessing each filesystem's collation.
const pendingRenamesByParent = new Map<string, Promise<void>>()

function isENOENT(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

async function destinationParentKey(filePath: string): Promise<string> {
  const parentPath = dirname(filePath)
  try {
    return normalize(await realpath(parentPath))
  } catch (error) {
    // A missing parent will fail the rename; retain its path so that failure
    // does not prevent unrelated destinations from progressing.
    if (isENOENT(error)) {
      return normalize(parentPath)
    }
    throw error
  }
}

export async function renameLocalPathSerializedByDestination(
  oldPath: string,
  newPath: string,
  options: { overwrite?: boolean } = {}
): Promise<void> {
  const key = await destinationParentKey(newPath)
  const previous = pendingRenamesByParent.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  pendingRenamesByParent.set(key, current)

  await previous
  try {
    // Overwrite replaces an existing destination FILE atomically (Node's
    // rename maps to MoveFileEx|REPLACE_EXISTING on Windows); it is reserved
    // for staged atomic writes and never for explorer moves.
    if (!options.overwrite) {
      await assertNoClobberRenameDestinationAvailable(oldPath, newPath)
    }
    await rename(oldPath, newPath)
  } finally {
    release()
    if (pendingRenamesByParent.get(key) === current) {
      pendingRenamesByParent.delete(key)
    }
  }
}
