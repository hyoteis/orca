// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import type { GlobalSettings, Repo, Worktree } from '../../../../shared/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CodeIntelligenceStatusSegment } from './CodeIntelligenceStatusSegment'
import { useAppStore } from '@/store'

const { upsertScopeMock } = vi.hoisted(() => ({ upsertScopeMock: vi.fn() }))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() }
}))

const makeScope = (members: CodeIntelligenceScope['members']): CodeIntelligenceScope => ({
  id: 'local:worktree:demo:cpp',
  name: 'demo C++',
  executionHostId: 'local',
  workspaceKey: 'worktree:demo',
  workspaceRoot: '/repo',
  language: 'cpp',
  members,
  serverSource: { type: 'custom', executable: 'clangd', args: [] },
  enabled: true,
  revision: 1
})

const initialState = useAppStore.getInitialState()

function mountSegment(scope: CodeIntelligenceScope): void {
  useAppStore.setState({
    settings: {
      ...initialState.settings,
      codeIntelligenceScopes: [scope]
    } as GlobalSettings,
    repos: [
      {
        id: 'demo',
        displayName: 'demo',
        path: '/repo',
        connectionId: null
      } as unknown as Repo
    ],
    worktreesByRepo: {
      demo: [{ id: 'demo', repoId: 'demo', path: '/repo' } as unknown as Worktree]
    },
    activeWorktreeId: 'demo',
    fetchSettings: vi.fn().mockResolvedValue(undefined)
  })
  ;(window as unknown as { api: unknown }).api = {
    codeIntelligence: { upsertScope: upsertScopeMock.mockResolvedValue(scope) }
  }
  render(
    <TooltipProvider>
      <CodeIntelligenceStatusSegment iconOnly={false} />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: /Code intelligence: \d+ folders/ })!)
}

beforeEach(() => {
  upsertScopeMock.mockClear()
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('CodeIntelligenceStatusSegment member rows', () => {
  it('toggles inline result visibility through a scope upsert', async () => {
    mountSegment(
      makeScope([
        { path: 'engine', visibleResults: true },
        { path: 'fx', visibleResults: true }
      ])
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show results for fx' }))

    await waitFor(() => expect(upsertScopeMock).toHaveBeenCalledTimes(1))
    const persisted = upsertScopeMock.mock.calls[0][0] as CodeIntelligenceScope
    expect(persisted.members).toEqual([
      { path: 'engine', visibleResults: true },
      { path: 'fx', visibleResults: false }
    ])
  })

  it('removes a member on hover ✕ and disables it for the last member', async () => {
    mountSegment(
      makeScope([
        { path: 'engine', visibleResults: true },
        { path: 'fx', visibleResults: true }
      ])
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove fx' }))

    await waitFor(() => expect(upsertScopeMock).toHaveBeenCalledTimes(1))
    expect(
      (upsertScopeMock.mock.calls[0][0] as CodeIntelligenceScope).members.map((m) => m.path)
    ).toEqual(['engine'])

    cleanup()
    upsertScopeMock.mockClear()
    mountSegment(makeScope([{ path: 'engine', visibleResults: true }]))
    fireEvent.click(screen.getByRole('button', { name: 'Remove engine' }))
    expect(upsertScopeMock).not.toHaveBeenCalled()
  })
})
