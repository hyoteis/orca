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
import {
  getPythonCodeIntelligenceSession,
  resetPythonCodeIntelligenceSession
} from './python-code-intelligence-session'

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

const pythonScope: CodeIntelligenceScope = {
  ...cppScope,
  id: 'local:worktree:demo:python',
  name: 'Demo Python',
  language: 'python'
}

beforeEach(() => {
  resetScriptedLanguageServerClient()
  resetCppCodeIntelligenceSession()
  resetPythonCodeIntelligenceSession()
  ;(window as unknown as { api: unknown }).api = { languageServers: {} }
})

// Outline and semantic-highlight decorations fire the same tick; a duplicate
// open of the live sessionId is rejected by the Host ("already exists").
describe('language-server session single-flight', () => {
  it('shares one open across concurrent cpp ensureClient calls', async () => {
    const [a, b] = await Promise.all([
      getCppSession().ensureClient(cppScope),
      getCppSession().ensureClient(cppScope)
    ])
    expect(scripted.opens).toHaveLength(1)
    expect(a).toBe(b)
  })

  it('shares one open across concurrent python ensureClient calls', async () => {
    const [a, b] = await Promise.all([
      getPythonCodeIntelligenceSession().ensureClient(pythonScope),
      getPythonCodeIntelligenceSession().ensureClient(pythonScope)
    ])
    expect(scripted.opens).toHaveLength(1)
    expect(a).toBe(b)
  })
})
