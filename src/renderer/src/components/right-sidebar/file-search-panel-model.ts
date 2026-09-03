import type React from 'react'
import type { SearchFileResult, SearchMatch, SearchResult } from '../../../../shared/types'
import type { buildSearchRows } from './search-rows'
import type { SearchQueryRowProps } from './SearchQueryRow'
import type { SearchFiltersProps } from './SearchFilters'
import type { FileExplorerRangeSwitchProps } from './FileExplorerRangeSwitch'

export type FileSearchPanelModel = {
  activeWorktreeId: string | null
  queryRowProps: SearchQueryRowProps
  filtersProps: SearchFiltersProps
  /** One range shared by Names find and Contents search (#77). */
  rangeProps: FileExplorerRangeSwitchProps
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
