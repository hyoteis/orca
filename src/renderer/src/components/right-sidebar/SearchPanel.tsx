import React from 'react'
import { useCodeScopesSection } from './use-code-scopes-section'
import { SearchQueryRow } from './SearchQueryRow'
import { SearchFilters } from './SearchFilters'
import { SearchResultsPane } from './SearchResultsPane'
import { SymbolSearchResults } from './SymbolSearchResults'
import { useFileSearchPanel } from './useFileSearchPanel'
import { useSymbolSearch, openSymbolSearchResult } from './use-symbol-search'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

/**
 * Standalone search panel (VS Code-style sidebar tab). Owns the content-search
 * query row — with the #77 range pill inside the field — plus filters and the
 * full-height results pane. Explorer keeps only the tree sections.
 */
function SearchPanel(): React.JSX.Element {
  const { scopes: codeScopes } = useCodeScopesSection()
  const searchPanel = useFileSearchPanel(codeScopes)
  // #32 Command center: same query box, workspace-symbol fan-out when toggled.
  const symbolSearch = useSymbolSearch({
    query: searchPanel.queryRowProps.query,
    symbolMode: searchPanel.queryRowProps.symbolMode,
    scopes: codeScopes
  })
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)

  const resultsBody = searchPanel.queryRowProps.symbolMode ? (
    searchPanel.activeWorktreeId ? (
      <SymbolSearchResults
        query={searchPanel.queryRowProps.query}
        rows={symbolSearch.rows}
        loading={symbolSearch.loading}
        partial={symbolSearch.partial}
        onOpen={(row) => openSymbolSearchResult(row, searchPanel.activeWorktreeId!, codeScopes)}
        onFallbackToText={searchPanel.fallbackToTextSearch}
      />
    ) : (
      noWorkspaceSelected()
    )
  ) : searchPanel.activeWorktreeId ? (
    <SearchResultsPane
      {...searchPanel.resultsProps}
      onClearSearch={searchPanel.queryRowProps.onClearSearch}
    />
  ) : (
    noWorkspaceSelected()
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 py-1.5">
        <SearchQueryRow
          {...searchPanel.queryRowProps}
          loading={
            searchPanel.queryRowProps.symbolMode
              ? symbolSearch.loading
              : searchPanel.queryRowProps.loading
          }
          onKeyDown={(e) => {
            // Symbols mode: Enter opens the top result instead of rerunning text search.
            if (
              e.key === 'Enter' &&
              searchPanel.queryRowProps.symbolMode &&
              symbolSearch.rows[0]?.range &&
              activeWorktreeId
            ) {
              openSymbolSearchResult(symbolSearch.rows[0], activeWorktreeId, codeScopes)
              return
            }
            searchPanel.queryRowProps.onKeyDown(e)
          }}
        />
      </div>
      <div
        className={cn(
          'px-2 pb-1.5',
          searchPanel.queryRowProps.symbolMode &&
            'pointer-events-none invisible h-0 overflow-hidden p-0'
        )}
      >
        <SearchFilters {...searchPanel.filtersProps} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{resultsBody}</div>
    </div>
  )
}

function noWorkspaceSelected(): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      {translate('auto.components.right.sidebar.Search.98c8435e36', 'Select a workspace to search')}
    </div>
  )
}

export default React.memo(SearchPanel)
