import React, { useMemo, useState } from 'react'
import { Folder, Plus, RefreshCw, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { normalizeScopeMemberPath } from '../../../../shared/code-intelligence-scope'
import { isRuntimePathAbsolute } from '../../../../shared/cross-platform-path'
import {
  filterCodeIntelligenceDirectories,
  getCodeIntelligenceCustomPaths,
  getMinimalCodeIntelligenceDirectories
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
  const [customPath, setCustomPath] = useState('')
  const selectedDirectories = useMemo(
    () => getMinimalCodeIntelligenceDirectories(directories, selected),
    [directories, selected]
  )
  const customPaths = useMemo(
    () => getCodeIntelligenceCustomPaths(directories, selected),
    [directories, selected]
  )
  const matchedDirectories = useMemo(
    () => filterCodeIntelligenceDirectories(directories, query),
    [directories, query]
  )
  const matchedCustomPaths = useMemo(
    () => filterCodeIntelligenceDirectories(customPaths, query),
    [customPaths, query]
  )
  const rows = [...matchedDirectories, ...matchedCustomPaths]
  const availableCount = directories.length + customPaths.length

  const togglePath = (path: string, checked: boolean): void => {
    const next = new Set(selected)
    if (checked) {
      next.add(path)
    } else {
      next.delete(path)
    }
    onSelectedChange(next)
  }

  const handleAddCustomPath = (): void => {
    try {
      // Why: ~ and .. must be rejected here — members persist exactly as typed.
      const path = normalizeScopeMemberPath(customPath.trim())
      if (!isRuntimePathAbsolute(path)) {
        throw new Error('not-absolute')
      }
      if (!selected.has(path)) {
        onSelectedChange(new Set(selected).add(path))
      }
      setCustomPath('')
    } catch {
      toast.error(
        translate(
          'settings.codeIntelligence.customPathInvalid',
          'Enter an absolute Host path (~ and .. are not expanded)'
        )
      )
    }
  }

  const renderRow = (path: string, custom: boolean): React.JSX.Element => (
    <label
      key={path}
      className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-foreground hover:bg-accent/50"
      title={path}
    >
      <Checkbox
        checked={selected.has(path)}
        aria-label={path}
        onCheckedChange={(checked) => togglePath(path, checked === true)}
      />
      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{path}</span>
      {custom ? (
        <Badge variant="outline" className="px-1.5 py-0 text-[11px] font-normal">
          {translate('settings.codeIntelligence.customPathBadge', 'custom')}
        </Badge>
      ) : null}
    </label>
  )

  return (
    <div className="space-y-2">
      {selectedDirectories.length > 0 || customPaths.length > 0 ? (
        <section className="rounded-md border border-border bg-muted/20">
          <div className="flex items-center justify-between border-b border-border/60 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.05em] text-muted-foreground">
            <span>
              {translate('settings.codeIntelligence.selectedFoldersPinned', 'Selected folders')}
            </span>
            <span className="tabular-nums">{selectedDirectories.length + customPaths.length}</span>
          </div>
          <div className="max-h-28 overflow-y-auto p-1.5 scrollbar-sleek">
            {selectedDirectories.map((path) => renderRow(path, false))}
            {customPaths.map((path) => renderRow(path, true))}
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
          <span>
            {translate('settings.codeIntelligence.availableFolders', 'Available folders')}
          </span>
          <span className="tabular-nums">{availableCount}</span>
        </div>
        <div className="max-h-64 overflow-y-auto p-1.5 scrollbar-sleek">
          {directories.length === 0 && customPaths.length === 0 && !discovering ? (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">
              {translate(
                'settings.codeIntelligence.noBuildFolders',
                'No CMake or GN build folders were detected.'
              )}
            </p>
          ) : null}
          {rows.length === 0 &&
          (directories.length > 0 || customPaths.length > 0) &&
          !discovering ? (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">
              {translate(
                'settings.codeIntelligence.noDirectorySearchMatches',
                'No folders match your search.'
              )}
            </p>
          ) : null}
          {rows.map((path) => renderRow(path, customPaths.includes(path)))}
        </div>
      </section>

      <div className="flex items-center gap-2">
        <Input
          type="text"
          value={customPath}
          aria-label={translate(
            'settings.codeIntelligence.customPathPlaceholder',
            'Add a folder outside this workspace (Host absolute path)'
          )}
          placeholder={translate(
            'settings.codeIntelligence.customPathPlaceholder',
            'Add a folder outside this workspace (Host absolute path)'
          )}
          className="h-8 bg-background text-xs shadow-none"
          onChange={(event) => setCustomPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && customPath.trim()) {
              event.preventDefault()
              handleAddCustomPath()
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          disabled={!customPath.trim()}
          onClick={handleAddCustomPath}
        >
          <Plus className="size-3.5" />
          {translate('settings.codeIntelligence.addCustomPath', 'Add')}
        </Button>
      </div>
    </div>
  )
}
