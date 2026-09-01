// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import type { GlobalSettings, Repo } from '../../../../shared/types'
import { CodeIntelligenceConsentBanner } from './CodeIntelligenceConsentBanner'
import type { OpenFile } from '@/store/slices/editor'
import { useAppStore } from '@/store'

const { grantConsentMock } = vi.hoisted(() => ({ grantConsentMock: vi.fn() }))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() }
}))

const staleConsent: CodeIntelligenceScope['consent'] = {
  configurationFingerprint: 'stale',
  grantedAt: 1,
  authorizedMembers: [{ path: 'engine', visibleResults: true }]
}

const staleScope: CodeIntelligenceScope = {
  id: 'local:worktree:demo:cpp',
  name: 'demo C++',
  executionHostId: 'local',
  workspaceKey: 'worktree:demo',
  workspaceRoot: '/repo',
  language: 'cpp',
  members: [
    { path: 'engine', visibleResults: true },
    { path: 'audio', visibleResults: true }
  ],
  serverSource: { type: 'custom', executable: 'clangd', args: [] },
  enabled: true,
  revision: 1,
  consent: staleConsent
}

const cppFile = {
  id: '/repo/engine/main.cpp',
  filePath: '/repo/engine/main.cpp',
  relativePath: 'engine/main.cpp',
  worktreeId: 'demo',
  language: 'cpp',
  isDirty: false,
  mode: 'edit'
} as unknown as OpenFile

const initialState = useAppStore.getInitialState()

function mountBanner(
  scope: CodeIntelligenceScope | null,
  file: OpenFile = cppFile,
  language = 'cpp'
): void {
  useAppStore.setState({
    settings: {
      ...initialState.settings,
      codeIntelligenceScopes: scope ? [scope] : []
    } as GlobalSettings,
    repos: [{ id: 'demo', displayName: 'demo', path: '/repo', connectionId: null } as unknown as Repo],
    fetchSettings: vi.fn().mockResolvedValue(undefined)
  })
  ;(window as unknown as { api: unknown }).api = {
    codeIntelligence: { grantConsent: grantConsentMock }
  }
  render(<CodeIntelligenceConsentBanner file={file} language={language} />)
}

beforeEach(() => {
  grantConsentMock.mockReset()
  grantConsentMock.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('CodeIntelligenceConsentBanner', () => {
  it('surfaces stale consent above the editor and reauthorizes in one click', async () => {
    mountBanner(staleScope)

    expect(screen.getByRole('alert').textContent).toContain(
      'Code intelligence paused — configuration changed since authorization'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reauthorize' }))

    await waitFor(() =>
      expect(grantConsentMock).toHaveBeenCalledWith({
        scopeId: 'local:worktree:demo:cpp',
        revision: 1
      })
    )
    await waitFor(() => expect(useAppStore.getState().fetchSettings).toHaveBeenCalled())
  })

  it('stays hidden while consent is current', () => {
    mountBanner({
      ...staleScope,
      consent: {
        configurationFingerprint: 'current',
        grantedAt: 1,
        authorizedMembers: staleScope.members
      }
    })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reauthorize' })).toBeNull()
  })

  it('stays hidden for non-C/C++ documents inside a stale scope', () => {
    mountBanner(staleScope, { ...cppFile, relativePath: 'engine/README.md' }, 'markdown')

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('stays hidden when the document has no scope', () => {
    mountBanner(null)

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('toasts a grant failure while still refreshing settings', async () => {
    mountBanner(staleScope)
    grantConsentMock.mockRejectedValue(new Error('revision changed'))

    fireEvent.click(screen.getByRole('button', { name: 'Reauthorize' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    await waitFor(() => expect(useAppStore.getState().fetchSettings).toHaveBeenCalled())
  })

  it('disappears once the refreshed settings carry current consent', async () => {
    mountBanner(staleScope)

    fireEvent.click(screen.getByRole('button', { name: 'Reauthorize' }))
    await waitFor(() => expect(grantConsentMock).toHaveBeenCalled())
    useAppStore.setState({
      settings: {
        ...initialState.settings,
        codeIntelligenceScopes: [
          { ...staleScope, consent: { configurationFingerprint: 'current', grantedAt: 2, authorizedMembers: staleScope.members } }
        ]
      } as GlobalSettings
    })

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})
