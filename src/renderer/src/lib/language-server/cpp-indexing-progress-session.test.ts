// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ repos: [], settings: {} }) }
}))

vi.mock('./language-server-client-registry', async () => {
  const { ScriptedLanguageServerClient } = await import('./scripted-language-server-client')
  return { LanguageServerClientRegistry: ScriptedLanguageServerClient }
})

import { resetScriptedLanguageServerClient, scripted } from './scripted-language-server-client'
import { getCppSession, resetCppCodeIntelligenceSession } from './cpp-code-intelligence-session'

const cppScope: CodeIntelligenceScope = {
  id: 'local:worktree:demo:cpp',
  name: 'Demo C++',
  executionHostId: 'local',
  workspaceKey: 'worktree:demo',
  workspaceRoot: '/repo',
  language: 'cpp',
  members: [{ path: '.', visibleResults: true }],
  serverSource: { type: 'automatic' },
  enabled: true,
  revision: 1
}

beforeEach(() => {
  resetScriptedLanguageServerClient()
  resetCppCodeIntelligenceSession()
  ;(window as unknown as { api: unknown }).api = { languageServers: {} }
})

describe('cpp session indexing progress wiring (#163)', () => {
  it('declares workDoneProgress so clangd reports background-index progress', async () => {
    await getCppSession().ensureClient(cppScope)
    const params = scripted.initializeParams as { capabilities?: { window?: unknown } }
    expect(params.capabilities?.window).toEqual({ workDoneProgress: true })
  })

  it('feeds $/progress notifications into the per-scope state', async () => {
    const session = getCppSession()
    await session.ensureClient(cppScope)

    scripted.notificationRoutes['$/progress']({
      token: 'index-token',
      value: { kind: 'begin', title: 'indexing' }
    })
    expect(session.indexing.stateFor(cppScope.id)).toMatchObject({ active: true })

    scripted.notificationRoutes['$/progress']({
      token: 'index-token',
      value: { kind: 'report', percentage: 45 }
    })
    expect(session.indexing.stateFor(cppScope.id)).toMatchObject({
      active: true,
      percentage: 45
    })
  })

  it('goes idle when the client drops mid-index', async () => {
    const session = getCppSession()
    await session.ensureClient(cppScope)
    scripted.notificationRoutes['$/progress']({
      token: 'index-token',
      value: { kind: 'begin', title: 'indexing' }
    })

    scripted.instance!.restartScope(cppScope.id)

    expect(session.indexing.stateFor(cppScope.id)).toEqual({
      scopeId: cppScope.id,
      active: false
    })
  })
})
