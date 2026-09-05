// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'

const mockState = vi.hoisted(() => ({ settings: null as unknown }))

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: typeof mockState) => T): T => selector(mockState)
}))

vi.mock('../../runtime/runtime-file-client', () => ({ listRuntimeFiles: vi.fn() }))
vi.mock('../../lib/language-server/code-intelligence-directory-scan-cache', () => ({
  getCachedCodeIntelligenceDirectories: vi.fn().mockResolvedValue(['.', 'src', 'tools'])
}))

import { useSetupScopeSelection } from './code-intelligence-setup-scope-selection'

const REPO = {
  id: 'repo-1',
  displayName: 'repo-1',
  path: '/ws/repo-1',
  kind: 'git',
  connectionId: undefined,
  executionHostId: undefined
} as unknown as Repo

afterEach(cleanup)

function renderSelection() {
  return renderHook(() => useSetupScopeSelection({ open: true, repo: REPO }))
}

/** Python members must stay workspace-relative — the invariant the removed
 *  add-folder dialog enforced with a toast, now enforced by dropping custom picks. */
describe('useSetupScopeSelection selectedRoots', () => {
  it('drops host-absolute custom picks for python but keeps them for cpp', async () => {
    const { result } = renderSelection()
    await waitFor(() => expect(result.current.scanning).toBe(false))
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
