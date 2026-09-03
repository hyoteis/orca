import { useCallback } from 'react'
import { useAppStore } from '@/store'

/** Store writes for the Symbols toggle (#32); kept free of the LSP import chain. */
export function useSymbolSearchModeActions({
  activeWorktreeId,
  symbolMode,
  executeSearch
}: {
  activeWorktreeId: string | null
  symbolMode: boolean
  executeSearch: (query: string) => void
}): {
  onToggleSymbolMode: () => void
  /** #13 labelled fallback: leave Symbols mode and rerun the query as text search. */
  fallbackToTextSearch: () => void
} {
  const onToggleSymbolMode = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    useAppStore.getState().updateFileSearchState(activeWorktreeId, {
      symbolMode: !symbolMode
    })
  }, [activeWorktreeId, symbolMode])

  const fallbackToTextSearch = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    const query = (useAppStore.getState().fileSearchStateByWorktree[activeWorktreeId]?.query ?? '').trim()
    useAppStore.getState().updateFileSearchState(activeWorktreeId, { symbolMode: false })
    if (query) {
      executeSearch(query)
    }
  }, [activeWorktreeId, executeSearch])

  return { onToggleSymbolMode, fallbackToTextSearch }
}
