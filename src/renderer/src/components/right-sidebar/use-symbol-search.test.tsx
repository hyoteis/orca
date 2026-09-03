// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import type * as WorkspaceModule from '@/lib/language-server/code-intelligence-workspace'
import { useSymbolSearch, openSymbolSearchResult } from './use-symbol-search'

const mocks = vi.hoisted(() => ({
  searchPythonWorkspaceSymbols: vi.fn(),
  searchCppWorkspaceSymbols: vi.fn(),
  openDefinitionTargetInWorkspace: vi.fn()
}))

vi.mock('@/lib/language-server/python-definition-navigation', () => ({
  searchPythonWorkspaceSymbols: mocks.searchPythonWorkspaceSymbols
}))

vi.mock('@/lib/language-server/cpp-definition-navigation', () => ({
  searchCppWorkspaceSymbols: mocks.searchCppWorkspaceSymbols
}))

vi.mock('@/lib/language-server/code-intelligence-workspace', async (importOriginal) => {
  // Keep the real pure path helpers — symbol-search-rows builds rows with them.
  const actual = await importOriginal<typeof WorkspaceModule>()
  return {
    ...actual,
    openDefinitionTargetInWorkspace: mocks.openDefinitionTargetInWorkspace
  }
})

const pythonScope: CodeIntelligenceScope = {
  id: 'local:worktree:repo-a:python',
  name: 'Python',
  executionHostId: 'local',
  workspaceKey: 'worktree:repo-a',
  workspaceRoot: '/repo',
  language: 'python',
  members: [{ path: '.', visibleResults: true }],
  serverSource: { type: 'automatic' },
  enabled: true,
  revision: 1
}

// Stable identity like the real caller's memoized scopes — unstable props would
// re-run the effect every render.
const SCOPES = [pythonScope]

const symbolResult = (name: string) => ({
  results: [
    {
      scopeId: pythonScope.id,
      scopeName: pythonScope.name,
      symbols: [
        {
          name,
          kind: 12,
          location: {
            uri: 'file:///repo/app/main.py',
            range: { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } }
          }
        }
      ]
    }
  ],
  partial: false
})

describe('useSymbolSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // C++ fan-out defaults to silent-empty so Python-only tests stay focused.
    mocks.searchCppWorkspaceSymbols.mockResolvedValue({ results: [], partial: false })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('searches after the debounce once the query settles', async () => {
    mocks.searchPythonWorkspaceSymbols.mockResolvedValue(symbolResult('main'))
    const { result, rerender } = renderHook(
      ({ query }: { query: string }) => useSymbolSearch({ query, symbolMode: true, scopes: SCOPES }),
      { initialProps: { query: '' } }
    )

    rerender({ query: 'ma' })
    rerender({ query: 'mai' })
    // Debounced: neither keystroke has fired yet.
    expect(mocks.searchPythonWorkspaceSymbols).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTimeAsync(300)
    })

    expect(mocks.searchPythonWorkspaceSymbols).toHaveBeenCalledTimes(1)
    expect(mocks.searchPythonWorkspaceSymbols).toHaveBeenLastCalledWith('mai')
    expect(result.current.rows.map((row) => row.name)).toEqual(['main'])
    expect(result.current.loading).toBe(false)
  })

  it('stays idle while symbol mode is off and clears on empty query', async () => {
    mocks.searchPythonWorkspaceSymbols.mockResolvedValue(symbolResult('main'))
    const { result, rerender } = renderHook(
      ({ query, symbolMode }: { query: string; symbolMode: boolean }) =>
        useSymbolSearch({ query, symbolMode, scopes: SCOPES }),
      { initialProps: { query: '', symbolMode: false } }
    )

    rerender({ query: 'main', symbolMode: false })
    await act(async () => {
      vi.advanceTimersByTimeAsync(300)
    })
    expect(mocks.searchPythonWorkspaceSymbols).not.toHaveBeenCalled()

    rerender({ query: 'main', symbolMode: true })
    await act(async () => {
      vi.advanceTimersByTimeAsync(300)
    })
    expect(result.current.rows).toHaveLength(1)

    rerender({ query: '', symbolMode: true })
    await act(async () => {
      vi.advanceTimersByTimeAsync(300)
    })
    expect(result.current.rows).toHaveLength(0)
  })

  it('keeps loading true until the latest query resolves and drops stale responses', async () => {
    let resolveSlow: (value: unknown) => void = () => {}
    mocks.searchPythonWorkspaceSymbols
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveSlow = resolve })
      )
      .mockResolvedValueOnce(symbolResult('fresh'))

    const { result, rerender } = renderHook(
      ({ query }: { query: string }) => useSymbolSearch({ query, symbolMode: true, scopes: SCOPES }),
      { initialProps: { query: 'a' } }
    )

    await act(async () => {
      vi.advanceTimersByTimeAsync(300)
    })
    expect(result.current.loading).toBe(true)

    rerender({ query: 'ab' })
    await act(async () => {
      vi.advanceTimersByTimeAsync(300)
    })
    expect(result.current.rows.map((row) => row.name)).toEqual(['fresh'])

    await act(async () => {
      resolveSlow(symbolResult('stale'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.rows.map((row) => row.name)).toEqual(['fresh'])
    expect(result.current.loading).toBe(false)
  })

  it('merges C++ symbols into the same result list', async () => {
    mocks.searchPythonWorkspaceSymbols.mockResolvedValue(symbolResult('main'))
    mocks.searchCppWorkspaceSymbols.mockResolvedValue(symbolResult('Widget'))
    const { result } = renderHook(() =>
      useSymbolSearch({ query: 'x', symbolMode: true, scopes: SCOPES })
    )

    await act(async () => {
      vi.advanceTimersByTimeAsync(300)
    })

    expect(result.current.rows.map((row) => row.name).sort()).toEqual(['Widget', 'main'])
  })

  it('marks partial when either stack rejects a scope', async () => {
    mocks.searchPythonWorkspaceSymbols.mockResolvedValue({ results: [], partial: false })
    mocks.searchCppWorkspaceSymbols.mockResolvedValue({ results: [], partial: true })
    const { result } = renderHook(() =>
      useSymbolSearch({ query: 'x', symbolMode: true, scopes: SCOPES })
    )

    await act(async () => {
      vi.advanceTimersByTimeAsync(300)
    })

    expect(result.current.partial).toBe(true)
  })

  it('surfaces the partial flag from a rejected fan-out', async () => {
    mocks.searchPythonWorkspaceSymbols.mockResolvedValue({ results: [], partial: true })
    const { result } = renderHook(() =>
      useSymbolSearch({ query: 'x', symbolMode: true, scopes: SCOPES })
    )

    await act(async () => {
      vi.advanceTimersByTimeAsync(300)
    })

    expect(result.current.partial).toBe(true)
  })
})

describe('openSymbolSearchResult', () => {
  it('routes through openDefinitionTargetInWorkspace with the row scope and target', () => {
    mocks.openDefinitionTargetInWorkspace.mockReturnValue(true)
    const row = {
      key: 'k',
      name: 'main',
      containerName: '',
      kindLabel: 'Function',
      scopeId: pythonScope.id,
      scopeName: 'Python',
      uri: 'file:///repo/app/main.py',
      displayPath: 'app/main.py',
      external: false,
      range: { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } }
    }

    const opened = openSymbolSearchResult(row, 'repo-a::/repo', [pythonScope])

    expect(opened).toBe(true)
    expect(mocks.openDefinitionTargetInWorkspace).toHaveBeenCalledWith(
      { filePath: 'app/main.py', relativePath: 'app/main.py', worktreeId: 'repo-a::/repo' },
      { uri: row.uri, range: row.range },
      pythonScope
    )
  })
})
