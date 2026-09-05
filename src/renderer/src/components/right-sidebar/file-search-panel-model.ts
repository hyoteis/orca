import type React from 'react'
import type { SearchFileResult, SearchMatch, SearchResult } from '../../../../shared/types'
import type { buildSearchRows } from './search-rows'
import type { SearchQueryRowProps } from './SearchQueryRow'
import type { SearchFiltersProps } from './SearchFilters'

export type FileSearchPanelModel = {
  activeWorktreeId: string | null
  /** Includes the #77 range fields — the pill lives inside the query row. */
  queryRowProps: SearchQueryRowProps
  filtersProps: SearchFiltersProps
  /** #13 labelled fallback: leave Symbols mode and rerun as text search. */
  fallbackToTextSearch: () => void
  resultsProps: {
    results: SearchResult | null
    hasCommittedResults: boolean
    query: string
    loading: boolean
    rows: ReturnType<typeof buildSearchRows>
    scrollRef: React.RefObject<HTMLDivElement | null>
    onToggleCollapsedFile: (filePath: string) => void
    onMatchClick: (fileResult: SearchFileResult, match: SearchMatch) => void
    /** Worktree-range ◆ marker predicate; absent while searching ◆ Scope. */
    isFileInCodeScopeRange?: (relativePath: string) => boolean
  }
  focusQueryInput: () => void
}
