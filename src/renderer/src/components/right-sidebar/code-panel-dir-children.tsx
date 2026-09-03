import React from 'react'
import { ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { joinPath } from '@/lib/path'
import type { LazyDirectoryListing } from './use-lazy-directory-listing'

/** Directory subtree rows shared by the panel's member trees (browse view). */
export function CodePanelDirChildren({
  dirPath,
  depth,
  listing,
  onOpenFile
}: {
  dirPath: string
  depth: number
  listing: LazyDirectoryListing
  onOpenFile: (filePath: string, fileName: string) => void
}): React.JSX.Element[] | null {
  const { expandedDirs, entriesByDir, errorByDir, toggleDir } = listing
  if (!expandedDirs.has(dirPath)) {
    return null
  }
  const entries = entriesByDir[dirPath]
  if (!entries) {
    const error = errorByDir[dirPath]
    return error
      ? [
          <div
            key={`${dirPath}\0error`}
            className="px-2 py-1 pl-3 text-[11px] text-muted-foreground"
          >
            {error}
          </div>
        ]
      : null
  }
  return entries.map((entry) => {
    const childPath = joinPath(dirPath, entry.name)
    if (!entry.isDirectory) {
      return (
        <button
          type="button"
          key={childPath}
          className="flex h-[26px] w-full items-center gap-1.5 text-left font-mono text-xs text-foreground hover:bg-accent"
          style={{ paddingLeft: `${depth * 14 + 22}px` }}
          title={childPath}
          onClick={() => onOpenFile(childPath, entry.name)}
        >
          <span className="size-3 shrink-0" />
          <span className="truncate">{entry.name}</span>
        </button>
      )
    }
    const expanded = expandedDirs.has(childPath)
    return (
      <React.Fragment key={childPath}>
        <button
          type="button"
          className="flex h-[26px] w-full items-center gap-1.5 text-left font-mono text-xs text-foreground hover:bg-accent"
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          onClick={() => toggleDir(childPath)}
        >
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-90'
            )}
          />
          {expanded ? (
            <FolderOpen className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{entry.name}</span>
        </button>
        <CodePanelDirChildren dirPath={childPath} depth={depth + 1} listing={listing} onOpenFile={onOpenFile} />
      </React.Fragment>
    )
  })
}
