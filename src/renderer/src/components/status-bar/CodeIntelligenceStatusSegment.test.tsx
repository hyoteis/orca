// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import type { GlobalSettings, Repo, Worktree } from '../../../../shared/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CodeIntelligenceStatusSegment } from './CodeIntelligenceStatusSegment'
import { useAppStore } from '@/store'

const { grantConsentMock, upsertScopeMock } = vi.hoisted(() => ({
  grantConsentMock: vi.fn(),
  upsertScopeMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() }
}))

const makeScope = (
  members: CodeIntelligenceScope['members'],
  overrides: Partial<CodeIntelligenceScope> = {}
): CodeIntelligenceScope => ({
  id: 'local:worktree:demo:cpp',
  name: 'demo C++',
  executionHostId: 'local',
  workspaceKey: 'worktree:demo',
  workspaceRoot: '/repo',
  language: 'cpp',
  members,
  serverSource: { type: 'custom', executable: 'clangd', args: [] },
  enabled: true,
  revision: 1,
  ...overrides
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
    codeIntelligence: {
      upsertScope: upsertScopeMock.mockResolvedValue(scope),
      grantConsent: grantConsentMock.mockResolvedValue(scope)
    }
  }
  render(
    <TooltipProvider>
      <CodeIntelligenceStatusSegment iconOnly={false} />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: /Code intelligence/ })!)
}

beforeEach(() => {
  upsertScopeMock.mockClear()
  grantConsentMock.mockReset()
  grantConsentMock.mockResolvedValue(undefined)
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

describe('CodeIntelligenceStatusSegment re-consent', () => {
  const staleConsent = {
    configurationFingerprint: 'stale',
    grantedAt: 1,
    authorizedMembers: [
      { path: 'engine', visibleResults: true },
      { path: 'fx', visibleResults: true }
    ]
  }

  it('flags pending re-consent on the segment and reauthorizes stale scopes in one click', async () => {
    mountSegment(
      makeScope(
        [
          { path: 'engine', visibleResults: true },
          { path: 'audio', visibleResults: true }
        ],
        { consent: staleConsent }
      )
    )

    expect(await screen.findByText('2 folders changed since authorization')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reauthorize' }))

    await waitFor(() =>
      expect(grantConsentMock).toHaveBeenCalledWith({
        scopeId: 'local:worktree:demo:cpp',
        revision: 1
      })
    )
    await waitFor(() => expect(useAppStore.getState().fetchSettings).toHaveBeenCalled())
  })

  it('falls back to a configuration-changed line when no folder paths moved', async () => {
    mountSegment(
      makeScope(
        [
          { path: 'engine', visibleResults: true },
          { path: 'fx', visibleResults: false }
        ],
        { consent: staleConsent }
      )
    )

    expect(await screen.findByText('Configuration changed since authorization')).toBeTruthy()
  })

  it('renders no banner and keeps the normal label while consent is current', () => {
    mountSegment(
      makeScope([{ path: 'engine', visibleResults: true }], {
        consent: {
          configurationFingerprint: 'current',
          grantedAt: 1,
          authorizedMembers: [{ path: 'engine', visibleResults: true }]
        }
      })
    )

    fireEvent.click(screen.getByRole('button', { name: /Code intelligence: 1 folders/ }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reauthorize' })).toBeNull()
  })

  it('surfaces a grant failure as a toast while still refreshing granted scopes', async () => {
    mountSegment(
      makeScope([{ path: 'audio', visibleResults: true }], { consent: staleConsent })
    )
    grantConsentMock.mockRejectedValue(new Error('revision changed'))

    fireEvent.click(await screen.findByRole('button', { name: 'Reauthorize' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    await waitFor(() => expect(useAppStore.getState().fetchSettings).toHaveBeenCalled())
  })
})

describe('CodeIntelligenceStatusSegment mount transitions', () => {
  it('renders after mount without scopes and keeps a stable hook order', async () => {
    useAppStore.setState({
      settings: { ...initialState.settings, codeIntelligenceScopes: [] } as GlobalSettings,
      repos: [
        { id: 'demo', displayName: 'demo', path: '/repo', connectionId: null } as unknown as Repo
      ],
      worktreesByRepo: {
        demo: [{ id: 'demo', repoId: 'demo', path: '/repo' } as unknown as Worktree]
      },
      activeWorktreeId: 'demo',
      fetchSettings: vi.fn().mockResolvedValue(undefined)
    })
    const { rerender } = render(
      <TooltipProvider>
        <CodeIntelligenceStatusSegment iconOnly={false} />
      </TooltipProvider>
    )

    useAppStore.setState({
      settings: {
        ...initialState.settings,
        codeIntelligenceScopes: [makeScope([{ path: 'engine', visibleResults: true }])]
      } as GlobalSettings
    })
    rerender(
      <TooltipProvider>
        <CodeIntelligenceStatusSegment iconOnly={false} />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: /Code intelligence/ }))
    expect(await screen.findByRole('checkbox', { name: 'Show results for engine' })).toBeTruthy()
  })
})
