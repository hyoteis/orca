// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import { useFileSearchPanel } from './useFileSearchPanel'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  getConnectionId: vi.fn(),
  searchRuntimeFiles: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: mocks.getConnectionId
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  searchRuntimeFiles: mocks.searchRuntimeFiles
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

const stateRef: { current: Record<string, unknown> } = { current: {} }

const localScope = (members: CodeIntelligenceScope['members']): CodeIntelligenceScope => ({
  id: 'local:worktree:repo-a:python',
  name: 'Python',
  executionHostId: 'local',
  workspaceKey: 'worktree:repo-a',
  workspaceRoot: '/repo',
  language: 'python',
  members,
  serverSource: { type: 'automatic' },
  enabled: true,
  revision: 1
})

function setState(searchState: Record<string, unknown> | undefined): void {
  stateRef.current = {
    activeWorktreeId: 'repo-a::/repo',
    openFile: vi.fn(),
    setPendingEditorReveal: vi.fn(),
    updateFileSearchState: vi.fn(),
    consumeFileSearchSeedRequest: vi.fn(),
    toggleFileSearchCollapsedFile: vi.fn(),
    clearFileSearch: vi.fn(),
    fileSearchStateByWorktree:
      searchState === undefined ? {} : { 'repo-a::/repo': searchState }
  }
  mocks.getState.mockImplementation(() => stateRef.current)
}

describe('useFileSearchPanel range props', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getConnectionId.mockReturnValue(null)
    mocks.searchRuntimeFiles.mockResolvedValue({
      files: [],
      totalMatches: 0,
      truncated: false
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('defaults to the worktree range shared by Names and Contents', () => {
    setState(undefined)
    const { result } = renderHook(() => useFileSearchPanel('files', [localScope([])]))

    expect(result.current.rangeProps.range).toBe('worktree')
    expect(result.current.rangeProps.scopeRangeUnavailable).toBe(true)
    // Sharing is structural: no marker predicate while worktree range is empty-scope.
    expect(result.current.resultsProps.isFileInCodeScopeRange).toBeUndefined()
  })

  it('falls back to worktree when the stored scope range has no local members', () => {
    setState({ query: 'needle', searchRange: 'scope' })
    const { result } = renderHook(() => useFileSearchPanel('search', [localScope([])]))

    expect(result.current.rangeProps.range).toBe('worktree')
    expect(result.current.rangeProps.scopeRangeUnavailable).toBe(true)
  })

  it('exposes the stored scope range and marker-free results when members exist', () => {
    setState({ query: 'needle', searchRange: 'scope' })
    const { result } = renderHook(() =>
      useFileSearchPanel('search', [localScope([{ path: 'engine/py', visibleResults: true }])])
    )

    expect(result.current.rangeProps.range).toBe('scope')
    expect(result.current.rangeProps.scopeRangeUnavailable).toBe(false)
    expect(result.current.resultsProps.isFileInCodeScopeRange).toBeUndefined()
  })

  it('marks worktree-range hits only while local members exist', () => {
    setState({ query: 'needle', searchRange: 'worktree' })
    const { result } = renderHook(() =>
      useFileSearchPanel('search', [localScope([{ path: 'engine/py', visibleResults: true }])])
    )

    expect(result.current.rangeProps.range).toBe('worktree')
    expect(result.current.resultsProps.isFileInCodeScopeRange?.('engine/py/app.py')).toBe(true)
    expect(result.current.resultsProps.isFileInCodeScopeRange?.('engine/fx/a.cpp')).toBe(false)
  })

  it('writes the shared range field and reruns the committed query on select', async () => {
    setState({ query: 'needle', searchRange: 'worktree' })
    const update = stateRef.current.updateFileSearchState as ReturnType<typeof vi.fn>
    const { result } = renderHook(() =>
      useFileSearchPanel('search', [localScope([{ path: 'engine/py', visibleResults: true }])])
    )

    await act(async () => {
      result.current.rangeProps.onSelectRange('scope')
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(update).toHaveBeenCalledWith('repo-a::/repo', { searchRange: 'scope' })
    expect(mocks.searchRuntimeFiles).toHaveBeenCalledTimes(1)
  })
})
