import React from 'react'
import { Loader2, X } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { SearchFileResult, SearchMatch, SearchResult } from '../../../../shared/types'
import type { SearchRow } from './search-rows'
import { FileResultRow, MatchResultRow } from './SearchResultItems'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

const SEARCH_VIRTUAL_OVERSCAN = 12

type SearchResultsPaneProps = {
  results: SearchResult | null
  hasCommittedResults: boolean
  query: string
  loading: boolean
  rows: SearchRow[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  onToggleCollapsedFile: (filePath: string) => void
  onMatchClick: (fileResult: SearchFileResult, match: SearchMatch) => void
  /** Worktree-range ◆ marker predicate; absent while searching ◆ Scope. */
  isFileInCodeScopeRange?: (relativePath: string) => boolean
  /** Header × clears the query and folds the pane away. */
  onClearSearch: () => void
}

export function SearchResultsPane({
  results,
  hasCommittedResults,
  query,
  loading,
  rows,
  scrollRef,
  onToggleCollapsedFile,
  onMatchClick,
  isFileInCodeScopeRange,
  onClearSearch
}: SearchResultsPaneProps): React.JSX.Element {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index]
      if (!row) {
        return 20
      }
      // Why: file rows include pt-1.5 (6 px) for inter-group spacing, so
      // their estimate is taller than match rows.
      if (row.type === 'file') {
        return 28
      }
      return 20
    },
    // Why: paddingEnd adds visible breathing room after the last result row.
    // paddingStart is unnecessary because each file row already includes
    // pt-1.5 for inter-group spacing (which also covers the first row).
    paddingEnd: 8,
    overscan: SEARCH_VIRTUAL_OVERSCAN,
    getItemKey: (index) => {
      const row = rows[index]
      if (!row) {
        return `missing:${index}`
      }
      if (row.type === 'file') {
        return `file:${row.fileResult.filePath}`
      }
      return `match:${row.fileResult.filePath}:${row.match.line}:${row.match.column}:${row.matchIndex}`
    }
  })

  return (
    <>
      {/* Why: the summary is rendered outside the virtualizer so it stays
         pinned at the top while the user scrolls through results. */}
      {(results || loading) && (
        <div className="flex items-center gap-1 border-b border-border px-1 py-0.5 text-[10px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate px-1">
            {results && rows.length > 0
              ? `${results.totalMatches} ${translate(
                  'auto.components.right.sidebar.Search.6aeda362ed',
                  'results'
                )} ${translate('auto.components.right.sidebar.Search.4107975b3a', 'in')} ${
                  results.files.length
                } ${translate('auto.components.right.sidebar.Search.0b8104eaf2', 'files')}${
                  results.truncated
                    ? ` ${translate('auto.components.right.sidebar.Search.dcc294f28d', '(results truncated)')}`
                    : ''
                }`
              : null}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="h-auto w-auto shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
            aria-label={translate(
              'auto.components.right.sidebar.SearchQueryRow.clearLabel',
              'Clear search'
            )}
            onClick={onClearSearch}
          >
            <X className="size-3" />
          </Button>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-sleek">
        {rows.length > 0 && (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]
              if (!row) {
                return null
              }

              return (
                <div
                  key={virtualRow.key}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {row.type === 'file' && (
                    <FileResultRow
                      fileResult={row.fileResult}
                      collapsed={row.collapsed}
                      inCodeScopeRange={isFileInCodeScopeRange?.(row.fileResult.relativePath)}
                      onToggleCollapse={() => onToggleCollapsedFile(row.fileResult.filePath)}
                    />
                  )}
                  {row.type === 'match' && (
                    <MatchResultRow
                      match={row.match}
                      relativePath={row.fileResult.relativePath}
                      onClick={() => onMatchClick(row.fileResult, row.match)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {!hasCommittedResults && query && !loading && (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-xs">
            {translate('auto.components.right.sidebar.Search.d56d140747', 'Press Enter to search')}
          </div>
        )}

        {loading && !hasCommittedResults && query && (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-xs">
            <Loader2 className="mr-2 size-3.5 animate-spin" aria-hidden />
            {translate(
              'auto.components.right.sidebar.SearchResultsPane.searching',
              'Searching…'
            )}
          </div>
        )}

        {!query && (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-xs">
            {translate(
              'auto.components.right.sidebar.Search.1abfb25a66',
              'Type to search in files'
            )}
          </div>
        )}
      </div>
    </>
  )
}
