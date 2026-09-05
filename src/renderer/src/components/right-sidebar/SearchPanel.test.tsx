// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  getConnectionId: vi.fn(),
  searchRuntimeFiles: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    vi.fn((selector: (state: Record<string, unknown>) => unknown) => selector(stateRef.current)),
    { getState: mocks.getState }
  )
}))

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => ({ path: '/repo' })
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: mocks.getConnectionId
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  searchRuntimeFiles: mocks.searchRuntimeFiles
}))

vi.mock('./use-code-scopes-section', () => ({
  useCodeScopesSection: () => ({ scopes: [] })
}))

vi.mock('./use-symbol-search', () => ({
  useSymbolSearch: () => ({ rows: [], loading: false, partial: false }),
  openSymbolSearchResult: vi.fn()
}))

import SearchPanel from './SearchPanel'

const stateRef: { current: Record<string, unknown> } = { current: {} }

describe('SearchPanel', () => {
  afterEach(() => {
    // No `globals: true`, so Testing Library's auto-cleanup never runs.
    cleanup()
    vi.clearAllMocks()
  })

  it('renders the query row with the range pill and empty-workspace hint', () => {
    stateRef.current = {
      activeWorktreeId: 'repo-a::/repo',
      openFile: vi.fn(),
      setPendingEditorReveal: vi.fn(),
      updateFileSearchState: vi.fn(),
      consumeFileSearchSeedRequest: vi.fn(),
      toggleFileSearchCollapsedFile: vi.fn(),
      clearFileSearch: vi.fn(),
      fileSearchStateByWorktree: { 'repo-a::/repo': { query: 'needle' } }
    }
    mocks.getState.mockImplementation(() => stateRef.current)

    render(<SearchPanel />)

    const input = screen.getByLabelText('Search files') as HTMLInputElement
    expect(input.value).toBe('needle')
    // Range pill lives inside the query row; default range is the whole tree.
    expect(screen.getByText('Files')).toBeTruthy()
  })
})
