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
import {
  getCppSession,
  resetCppCodeIntelligenceSession,
  type CppDiagnosticsEvent
} from './cpp-code-intelligence-session'

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

describe('cpp session diagnostics routing (#162)', () => {
  it('publishes server diagnostics to subscribers', async () => {
    const session = getCppSession()
    const events: CppDiagnosticsEvent[] = []
    const unsubscribe = session.onDiagnostics((event) => events.push(event))
    await session.ensureClient(cppScope)

    const diagnostics = [
      {
        range: {
          start: { line: 2, character: 4 },
          end: { line: 2, character: 9 }
        },
        message: 'unknown type: Widget',
        severity: 1
      }
    ]
    scripted.notificationRoutes['textDocument/publishDiagnostics']({
      uri: 'file:///repo/a.cpp',
      diagnostics
    })

    expect(events).toEqual([
      {
        type: 'publish',
        scopeId: cppScope.id,
        uri: 'file:///repo/a.cpp',
        diagnostics
      }
    ])
    unsubscribe()
  })

  it('broadcasts an empty publish as the clear semantics (LSP arrays replace)', async () => {
    const session = getCppSession()
    const events: CppDiagnosticsEvent[] = []
    session.onDiagnostics((event) => events.push(event))
    await session.ensureClient(cppScope)

    scripted.notificationRoutes['textDocument/publishDiagnostics']({
      uri: 'file:///repo/a.cpp',
      diagnostics: []
    })

    expect(events).toEqual([
      { type: 'publish', scopeId: cppScope.id, uri: 'file:///repo/a.cpp', diagnostics: [] }
    ])
  })

  it('broadcasts scopeCleared when the client drops so markers do not outlive the session', async () => {
    const session = getCppSession()
    const events: CppDiagnosticsEvent[] = []
    session.onDiagnostics((event) => events.push(event))
    await session.ensureClient(cppScope)

    scripted.instance!.restartScope(cppScope.id)

    expect(events).toEqual([{ type: 'scopeCleared', scopeId: cppScope.id }])
  })

  it('stops delivering after unsubscribe', async () => {
    const session = getCppSession()
    const events: CppDiagnosticsEvent[] = []
    const unsubscribe = session.onDiagnostics((event) => events.push(event))
    await session.ensureClient(cppScope)
    unsubscribe()

    scripted.notificationRoutes['textDocument/publishDiagnostics']({
      uri: 'file:///repo/a.cpp',
      diagnostics: []
    })

    expect(events).toEqual([])
  })
})
