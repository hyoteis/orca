import { useCallback, useState } from 'react'
import type { DirEntry } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export type LazyDirectoryListing = {
  expandedDirs: ReadonlySet<string>
  pendingDirs: ReadonlySet<string>
  entriesByDir: Record<string, DirEntry[]>
  errorByDir: Record<string, string>
  toggleDir: (dirPath: string) => void
}

/** Deferred-feedback dir cache shared by the Code panel tree and its add-folder picker. */
export function useLazyDirectoryListing(
  list: (dirPath: string) => Promise<DirEntry[]>
): LazyDirectoryListing {
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(() => new Set())
  const [pendingDirs, setPendingDirs] = useState<ReadonlySet<string>>(() => new Set())
  const [entriesByDir, setEntriesByDir] = useState<Record<string, DirEntry[]>>({})
  const [errorByDir, setErrorByDir] = useState<Record<string, string>>({})

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
        setPendingDirs((current) => new Set(current).add(dirPath))
        void list(dirPath)
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
      }
    },
    [entriesByDir, list, pendingDirs]
  )

  return { expandedDirs, pendingDirs, entriesByDir, errorByDir, toggleDir }
}
