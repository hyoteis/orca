// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeIntelligenceLanguage } from '../../../../shared/code-intelligence-scope'
import type { DirEntry, Repo } from '../../../../shared/types'

const mockState = vi.hoisted(() => ({ settings: null as unknown }))
const runtimeFiles = vi.hoisted(() => ({
  listRuntimeFiles: vi.fn(),
  readRuntimeDirectory: vi.fn(),
  readRuntimeDirectoryTree: vi.fn()
}))
const directoryCache = vi.hoisted(() => ({
  getCachedCodeIntelligenceDirectories: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: <T>(selector: (state: typeof mockState) => T): T => selector(mockState)
}))

vi.mock('../../runtime/runtime-file-client', () => runtimeFiles)
vi.mock('../../lib/language-server/code-intelligence-directory-scan-cache', () => directoryCache)

import { useSetupScopeSelection } from './code-intelligence-setup-scope-selection'

const REPO = {
  id: 'repo-1',
  displayName: 'repo-1',
  path: '/ws/repo-1',
  kind: 'git',
  connectionId: undefined,
  executionHostId: undefined
} as unknown as Repo

beforeEach(() => {
  runtimeFiles.listRuntimeFiles.mockResolvedValue(['src/file.cpp', 'tools/build.ts'])
  runtimeFiles.readRuntimeDirectoryTree.mockResolvedValue(null)
  runtimeFiles.readRuntimeDirectory.mockImplementation(
    async (_context: unknown, directoryPath: string): Promise<DirEntry[]> =>
      directoryPath === '/ws/repo-1'
        ? [
            { name: 'src', isDirectory: true, isSymlink: false },
            { name: 'tools', isDirectory: true, isSymlink: false }
          ]
        : []
  )
  directoryCache.getCachedCodeIntelligenceDirectories.mockImplementation(
    async (args: { loadDirectories: () => Promise<string[]> }) => args.loadDirectories()
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderSelection(props: { initialLanguage?: CodeIntelligenceLanguage } = {}) {
  return renderHook(() => useSetupScopeSelection({ open: true, repo: REPO, ...props }))
}

/** #106: the enable action preselects the active file's language family. */
describe('useSetupScopeSelection initialLanguage', () => {
  it('seeds python instead of the cpp default', async () => {
    const { result } = renderSelection({ initialLanguage: 'python' })
    await waitFor(() => expect(result.current.scanning).toBe(false))
    expect(result.current.language).toBe('python')
  })

  it('falls back to cpp when absent', async () => {
    const { result } = renderSelection()
    await waitFor(() => expect(result.current.scanning).toBe(false))
    expect(result.current.language).toBe('cpp')
  })
})

/** Python members must stay workspace-relative — the invariant the removed
 *  add-folder dialog enforced with a toast, now enforced by dropping custom picks. */
describe('useSetupScopeSelection selectedRoots', () => {
  it('drops host-absolute custom picks for python but keeps them for cpp', async () => {
    const { result } = renderSelection()
    await waitFor(() => expect(result.current.roots).toContain('src'))
    act(() => {
      result.current.setMode('selected')
      result.current.setSelected(new Set(['src', '/abs/host/path']))
    })
    // cpp keeps the dual form: workspace-relative plus host-absolute alike.
    expect(result.current.selectedRoots).toEqual(['src', '/abs/host/path'])

    // Separate act: the language pre-check effect resets selection on switch.
    act(() => {
      result.current.setLanguage('python')
    })
    act(() => {
      result.current.setSelected(new Set(['src', '/abs/host/path']))
    })
    expect(result.current.selectedRoots).toEqual(['src'])
  })
})

describe('useSetupScopeSelection directory discovery', () => {
  it('avoids the full-tree rg listing and scans five more levels after selection', async () => {
    runtimeFiles.listRuntimeFiles.mockRejectedValue(new Error('rg list timed out'))
    const segments = [
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
      'eleven'
    ]
    const relativePaths = segments.map((_, index) => segments.slice(0, index + 1).join('/'))
    runtimeFiles.readRuntimeDirectory.mockImplementation(
      async (_context: unknown, dirPath: string) => {
        const relative = dirPath.replace('/ws/repo-1', '').replace(/^\//, '')
        const depth = relative ? relative.split('/').length : 0
        const nextName = segments[depth]
        return nextName
          ? ([{ name: nextName, isDirectory: true, isSymlink: false }] satisfies DirEntry[])
          : []
      }
    )

    const { result } = renderSelection()
    await waitFor(() => expect(result.current.roots).toContain(relativePaths[4]))

    expect(runtimeFiles.listRuntimeFiles).not.toHaveBeenCalled()
    expect(result.current.roots).toContain(relativePaths[4])
    expect(result.current.roots).not.toContain(relativePaths[5])

    act(() => {
      result.current.setMode('selected')
      result.current.setSelected(new Set([relativePaths[4]]))
    })
    await waitFor(() => expect(result.current.scanning).toBe(false))

    expect(result.current.roots).toContain(relativePaths[9])
    expect(result.current.roots).not.toContain(relativePaths[10])
  })
})
