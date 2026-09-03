// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSymbolSearchModeActions } from './symbol-search-mode-actions'

const mocks = vi.hoisted(() => ({
  updateFileSearchState: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    vi.fn((selector: (state: Record<string, unknown>) => unknown) => selector(stateRef.current)),
    { getState: () => stateRef.current }
  )
}))

const stateRef: { current: Record<string, unknown> } = { current: {} }

describe('useSymbolSearchModeActions', () => {
  beforeEach(() => {
    stateRef.current = {
      updateFileSearchState: mocks.updateFileSearchState,
      fileSearchStateByWorktree: {
        'repo-a::/repo': { query: '  widget  ', symbolMode: true }
      }
    }
  })

  afterEach(() => vi.clearAllMocks())

  it('toggles symbol mode off', () => {
    const { result } = renderHook(() =>
      useSymbolSearchModeActions({
        activeWorktreeId: 'repo-a::/repo',
        symbolMode: true,
        executeSearch: vi.fn()
      })
    )

    result.current.onToggleSymbolMode()
    expect(mocks.updateFileSearchState).toHaveBeenCalledWith('repo-a::/repo', {
      symbolMode: false
    })
  })

  it('fallback reruns the trimmed query as text search after clearing the mode', () => {
    const executeSearch = vi.fn()
    const { result } = renderHook(() =>
      useSymbolSearchModeActions({
        activeWorktreeId: 'repo-a::/repo',
        symbolMode: true,
        executeSearch
      })
    )

    result.current.fallbackToTextSearch()
    expect(mocks.updateFileSearchState).toHaveBeenCalledWith('repo-a::/repo', {
      symbolMode: false
    })
    expect(executeSearch).toHaveBeenCalledWith('widget')
  })

  it('does not rerun text search without a worktree or query', () => {
    const executeSearch = vi.fn()
    const { result } = renderHook(() =>
      useSymbolSearchModeActions({
        activeWorktreeId: null,
        symbolMode: true,
        executeSearch
      })
    )

    result.current.fallbackToTextSearch()
    expect(executeSearch).not.toHaveBeenCalled()
    expect(mocks.updateFileSearchState).not.toHaveBeenCalled()
  })
})
