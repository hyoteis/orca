import { useCallback, useState } from 'react'
import type { DirEntry } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export type LazyDirectoryListing = {
  expandedDirs: ReadonlySet<string>
  pendingDirs: ReadonlySet<string>
  entriesByDir: Record<string, DirEntry[]>
  errorByDir: Record<string, string>
  toggleDir: (dirPath: string) => void
  /** Force a re-list so mutations (create/rename/delete) land in the cached tree. */
  refreshDir: (dirPath: string) => Promise<void>
}

/** Deferred-feedback dir cache shared by the Code panel tree and its add-folder picker. */
export function useLazyDirectoryListing(
  list: (dirPath: string) => Promise<DirEntry[]>
): LazyDirectoryListing {
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(() => new Set())
  const [pendingDirs, setPendingDirs] = useState<ReadonlySet<string>>(() => new Set())
  const [entriesByDir, setEntriesByDir] = useState<Record<string, DirEntry[]>>({})
  const [errorByDir, setErrorByDir] = useState<Record<string, string>>({})

  const loadDir = useCallback(
    (dirPath: string): Promise<void> => {
      setPendingDirs((current) => new Set(current).add(dirPath))
      return list(dirPath)
        .then((entries) => {
          setEntriesByDir((current) => ({ ...current, [dirPath]: entries }))
          setErrorByDir((current) => {
            const { [dirPath]: _dropped, ...rest } = current
            return rest
          })
        })
        .catch(() => {
          setErrorByDir((current) => ({
            ...current,
            [dirPath]: translate(
              'auto.components.rightSidebar.CodePanel.listFailed',
              'Could not list this folder'
            )
          }))
        })
        .finally(() => {
          setPendingDirs((current) => {
            const next = new Set(current)
            next.delete(dirPath)
            return next
          })
        })
    },
    [list]
  )

  const toggleDir = useCallback(
    (dirPath: string): void => {
      setExpandedDirs((current) => {
        const next = new Set(current)
        if (next.has(dirPath)) {
          next.delete(dirPath)
        } else {
          next.add(dirPath)
        }
        return next
      })
      if (entriesByDir[dirPath] === undefined && !pendingDirs.has(dirPath)) {
        void loadDir(dirPath)
      }
    },
    [entriesByDir, loadDir, pendingDirs]
  )

  const refreshDir = useCallback((dirPath: string): Promise<void> => loadDir(dirPath), [loadDir])

  return { expandedDirs, pendingDirs, entriesByDir, errorByDir, toggleDir, refreshDir }
}
