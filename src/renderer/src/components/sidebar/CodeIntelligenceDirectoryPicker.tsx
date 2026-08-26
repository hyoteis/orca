import React, { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, RefreshCw, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import {
  buildCodeIntelligenceDirectoryTree,
  flattenCodeIntelligenceDirectoryTree,
  getCodeIntelligenceDirectorySelectionState,
  getDefaultCollapsedCodeIntelligenceDirectories,
  getMinimalCodeIntelligenceDirectories,
  toggleCodeIntelligenceDirectorySelection
} from './code-intelligence-directory-list'

type Props = {
  directories: readonly string[]
  selected: ReadonlySet<string>
  query: string
  discovering: boolean
  onQueryChange: (query: string) => void
  onSelectedChange: (selected: Set<string>) => void
  onRescan: () => void
}

export function CodeIntelligenceDirectoryPicker({
  directories,
  selected,
  query,
  discovering,
  onQueryChange,
  onSelectedChange,
  onRescan
}: Props): React.JSX.Element {
  const fullTree = useMemo(
    () =>
      buildCodeIntelligenceDirectoryTree({
        directories,
        query: ''
      }),
    [directories]
  )
  const [collapsed, setCollapsed] = useState<Set<string>>(
    getDefaultCollapsedCodeIntelligenceDirectories(fullTree)
  )
  useEffect(() => {
    setCollapsed(getDefaultCollapsedCodeIntelligenceDirectories(fullTree))
  }, [fullTree])

  const selectedDirectories = useMemo(
    () => getMinimalCodeIntelligenceDirectories(directories, selected),
    [directories, selected]
  )
  const availableTree = useMemo(
    () => buildCodeIntelligenceDirectoryTree({ directories, query }),
    [directories, query]
  )
  const rows = useMemo(
    () =>
      flattenCodeIntelligenceDirectoryTree({
        tree: availableTree,
        collapsed,
        expandAll: Boolean(query.trim())
      }),
    [availableTree, collapsed, query]
  )
  const availableCount = directories.length

  const toggleCollapsed = (path: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  return (
    <div className="space-y-2">
      {selectedDirectories.length > 0 ? (
        <section className="rounded-md border border-border bg-muted/20">
          <div className="flex items-center justify-between border-b border-border/60 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.05em] text-muted-foreground">
            <span>
              {translate('settings.codeIntelligence.selectedFoldersPinned', 'Selected folders')}
            </span>
            <span className="tabular-nums">{selectedDirectories.length}</span>
          </div>
          <div className="max-h-28 overflow-y-auto p-1.5 scrollbar-sleek">
            {selectedDirectories.map((path) => (
              <label
                key={path}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-foreground hover:bg-accent/60"
                title={path}
              >
                <Checkbox
                  checked
                  onCheckedChange={() =>
                    onSelectedChange(
                      toggleCodeIntelligenceDirectorySelection({
                        directories,
                        selected,
                        path,
                        checked: false
                      })
                    )
                  }
                />
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{path}</span>
              </label>
            ))}
          </div>
        </section>
      ) : null}

      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={query}
            aria-label={translate(
              'settings.codeIntelligence.directorySearchLabel',
              'Search code folders'
            )}
            placeholder={translate(
              'settings.codeIntelligence.directorySearchPlaceholder',
              'Search folders...'
            )}
            data-escape-clears-value={query ? 'true' : undefined}
            className="h-8 bg-background pl-8 pr-8 text-xs shadow-none"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault()
                onQueryChange('')
              }
            }}
          />
          {query ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              aria-label={translate(
                'settings.codeIntelligence.clearDirectorySearch',
                'Clear folder search'
              )}
              onClick={() => onQueryChange('')}
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          disabled={discovering}
          aria-label={translate('settings.codeIntelligence.rescanFolders', 'Rescan folders')}
          onClick={onRescan}
        >
          <RefreshCw className={`size-3.5 ${discovering ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <section className="rounded-md border border-border">
        <div className="flex items-center justify-between border-b border-border/60 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.05em] text-muted-foreground">
          <span>{translate('settings.codeIntelligence.folderTree', 'Folder tree')}</span>
          <span className="tabular-nums">{availableCount}</span>
        </div>
        <div role="tree" className="max-h-64 overflow-y-auto p-1.5 scrollbar-sleek">
          {directories.length === 0 && !discovering ? (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">
              {translate(
                'settings.codeIntelligence.noBuildFolders',
                'No CMake or GN build folders were detected.'
              )}
            </p>
          ) : null}
          {directories.length > 0 && rows.length === 0 ? (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">
              {translate(
                'settings.codeIntelligence.noDirectorySearchMatches',
                'No folders match your search.'
              )}
            </p>
          ) : null}
          {rows.map((row) => {
            const hasChildren = row.children.length > 0
            const expanded = query.trim() ? true : !collapsed.has(row.path)
            const selectionState = getCodeIntelligenceDirectorySelectionState({
              directories,
              selected,
              path: row.path
            })
            return (
              <div
                key={row.path}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={hasChildren ? expanded : undefined}
                className="flex h-7 items-center rounded pr-1 text-xs hover:bg-accent/50"
                style={{ paddingLeft: `${row.depth * 16 + 2}px` }}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                    aria-label={
                      expanded
                        ? translate('settings.codeIntelligence.collapseFolder', 'Collapse folder')
                        : translate('settings.codeIntelligence.expandFolder', 'Expand folder')
                    }
                    onClick={() => toggleCollapsed(row.path)}
                  >
                    {expanded ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                  </button>
                ) : (
                  <span className="size-5 shrink-0" />
                )}
                {row.selectable ? (
                  <label
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
                    title={row.path}
                  >
                    <Checkbox
                      checked={selectionState}
                      aria-label={row.path}
                      onCheckedChange={(checked) =>
                        onSelectedChange(
                          toggleCodeIntelligenceDirectorySelection({
                            directories,
                            selected,
                            path: row.path,
                            checked: checked === true
                          })
                        )
                      }
                    />
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-[11px]">{row.name}</span>
                  </label>
                ) : (
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-muted-foreground"
                    title={row.path}
                    onClick={() => hasChildren && toggleCollapsed(row.path)}
                  >
                    <Folder className="size-3.5 shrink-0" />
                    <span className="truncate font-mono text-[11px]">{row.name}</span>
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
