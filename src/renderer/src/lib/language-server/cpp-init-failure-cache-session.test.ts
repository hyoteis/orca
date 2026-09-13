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
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  resetScriptedLanguageServerClient()
  resetCppCodeIntelligenceSession()
  ;(window as unknown as { api: unknown }).api = { languageServers: {} }
})

describe('cpp session init failure cache (#164)', () => {
  it('fails fast on the second query after a deterministic spawn failure', async () => {
    scripted.openRejection = new Error('spawn clangd ENOENT')
    const session = getCppSession()
    await expect(session.ensureClient(cppScope)).rejects.toThrow('ENOENT')

    await expect(session.ensureClient(cppScope)).rejects.toThrow('cached')
    await expect(session.ensureClient(cppScope)).rejects.toThrow('ENOENT')

    expect(scripted.opens).toHaveLength(1)
  })

  it('does not cache transient failures (timeouts, dropped connections)', async () => {
    scripted.openRejection = new Error('SSH target is not connected: target-1')
    const session = getCppSession()
    await expect(session.ensureClient(cppScope)).rejects.toThrow('not connected')

    scripted.openRejection = null
    await expect(session.ensureClient(cppScope)).resolves.toBeTruthy()

    expect(scripted.opens).toHaveLength(2)
  })

  it('manual restart clears the cache even with no running session', async () => {
    scripted.openRejection = new Error('spawn clangd ENOENT')
    const session = getCppSession()
    await expect(session.ensureClient(cppScope)).rejects.toThrow('ENOENT')

    session.restartSession(cppScope.id, cppScope.revision)
    scripted.openRejection = null
    await expect(session.ensureClient(cppScope)).resolves.toBeTruthy()

    expect(scripted.opens).toHaveLength(2)
  })

  it('retries once the TTL elapses', async () => {
    scripted.openRejection = new Error('spawn clangd ENOENT')
    const session = getCppSession()
    await expect(session.ensureClient(cppScope)).rejects.toThrow('ENOENT')

    vi.setSystemTime(Date.now() + 3 * 60_000 + 1)
    scripted.openRejection = null
    await expect(session.ensureClient(cppScope)).resolves.toBeTruthy()

    expect(scripted.opens).toHaveLength(2)
  })

  it('a successful open after TTL expiry leaves no stale cache entry', async () => {
    scripted.openRejection = new Error('spawn clangd ENOENT')
    const session = getCppSession()
    await expect(session.ensureClient(cppScope)).rejects.toThrow('ENOENT')

    vi.setSystemTime(Date.now() + 3 * 60_000 + 1)
    scripted.openRejection = null
    const client = await session.ensureClient(cppScope)
    expect(client).toBeTruthy()

    // Subsequent requests reuse the live client; nothing replays the cache.
    const again = await session.ensureClient(cppScope)
    expect(again).toBe(client)
  })
})
