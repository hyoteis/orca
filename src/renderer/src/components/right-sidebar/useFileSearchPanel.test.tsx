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
    const { result } = renderHook(() => useFileSearchPanel([localScope([])]))

    expect(result.current.queryRowProps.range).toBe('worktree')
    expect(result.current.queryRowProps.scopeRangeUnavailable).toBe(true)
    // Sharing is structural: no marker predicate while worktree range is empty-scope.
    expect(result.current.resultsProps.isFileInCodeScopeRange).toBeUndefined()
  })

  it('falls back to worktree when the stored scope range has no local members', () => {
    setState({ query: 'needle', searchRange: 'scope' })
    const { result } = renderHook(() => useFileSearchPanel([localScope([])]))

    expect(result.current.queryRowProps.range).toBe('worktree')
    expect(result.current.queryRowProps.scopeRangeUnavailable).toBe(true)
  })

  it('exposes the stored scope range and marker-free results when members exist', () => {
    setState({ query: 'needle', searchRange: 'scope' })
    const { result } = renderHook(() =>
      useFileSearchPanel([localScope([{ path: 'engine/py', visibleResults: true }])])
    )

    expect(result.current.queryRowProps.range).toBe('scope')
    expect(result.current.queryRowProps.scopeRangeUnavailable).toBe(false)
    expect(result.current.resultsProps.isFileInCodeScopeRange).toBeUndefined()
  })

  it('marks worktree-range hits only while local members exist', () => {
    setState({ query: 'needle', searchRange: 'worktree' })
    const { result } = renderHook(() =>
      useFileSearchPanel([localScope([{ path: 'engine/py', visibleResults: true }])])
    )

    expect(result.current.queryRowProps.range).toBe('worktree')
    expect(result.current.resultsProps.isFileInCodeScopeRange?.('engine/py/app.py')).toBe(true)
    expect(result.current.resultsProps.isFileInCodeScopeRange?.('engine/fx/a.cpp')).toBe(false)
  })

  it('writes the shared range field without rerunning the committed query', async () => {
    setState({ query: 'needle', searchRange: 'worktree' })
    const update = stateRef.current.updateFileSearchState as ReturnType<typeof vi.fn>
    const { result } = renderHook(() =>
      useFileSearchPanel([localScope([{ path: 'engine/py', visibleResults: true }])])
    )

    await act(async () => {
      result.current.queryRowProps.onSelectRange('scope')
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(update).toHaveBeenCalledWith('repo-a::/repo', { searchRange: 'scope' })
    // Range is a display-time subset over the raw scan — no rescan on switch.
    expect(mocks.searchRuntimeFiles).not.toHaveBeenCalled()
  })

  it('restricts committed results to member dirs at display time in scope range', () => {
    setState({
      query: 'needle',
      searchRange: 'scope',
      results: {
        files: [
          {
            filePath: '/repo/engine/py/app.py',
            relativePath: 'engine/py/app.py',
            matches: [
              { line: 1, column: 1, matchLength: 5, lineContent: 'owner' },
              { line: 2, column: 1, matchLength: 5, lineContent: 'owner' }
            ]
          },
          {
            filePath: '/repo/docs/readme.md',
            relativePath: 'docs/readme.md',
            matches: [{ line: 1, column: 1, matchLength: 5, lineContent: 'owner' }]
          }
        ],
        totalMatches: 3,
        truncated: false
      }
    })
    const { result } = renderHook(() =>
      useFileSearchPanel([localScope([{ path: 'engine/py', visibleResults: true }])])
    )

    expect(result.current.resultsProps.results?.files).toHaveLength(1)
    expect(result.current.resultsProps.results?.files[0]?.relativePath).toBe('engine/py/app.py')
    expect(result.current.resultsProps.results?.totalMatches).toBe(2)
    expect(result.current.resultsProps.hasCommittedResults).toBe(true)
  })

  it('keeps the full raw scan at display time in worktree range', () => {
    setState({
      query: 'needle',
      searchRange: 'worktree',
      results: {
        files: [
          {
            filePath: '/repo/engine/py/app.py',
            relativePath: 'engine/py/app.py',
            matches: [{ line: 1, column: 1, matchLength: 5, lineContent: 'owner' }]
          },
          {
            filePath: '/repo/docs/readme.md',
            relativePath: 'docs/readme.md',
            matches: [{ line: 1, column: 1, matchLength: 5, lineContent: 'owner' }]
          }
        ],
        totalMatches: 2,
        truncated: false
      }
    })
    const { result } = renderHook(() =>
      useFileSearchPanel([localScope([{ path: 'engine/py', visibleResults: true }])])
    )

    expect(result.current.resultsProps.results?.files).toHaveLength(2)
    expect(result.current.resultsProps.results?.totalMatches).toBe(2)
  })
})
