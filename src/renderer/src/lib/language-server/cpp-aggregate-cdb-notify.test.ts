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

const watchedFileNotifications = () =>
  scripted.sentNotifications.filter(
    (sent) => sent.method === 'workspace/didChangeWatchedFiles'
  )

describe('cpp session aggregate CDB rewrite notify (#165)', () => {
  it('sends didChangeWatchedFiles for the aggregate CDB on a health push', async () => {
    const session = getCppSession()
    await session.ensureClient(cppScope)

    scripted.instance!.pushMappingHealth({
      scopeId: cppScope.id,
      mappingHealth: [],
      aggregateCdbPath: 'C:/cache/cpp/demo/compile_commands.json'
    })

    expect(watchedFileNotifications()).toEqual([
      {
        method: 'workspace/didChangeWatchedFiles',
        params: {
          changes: [
            { uri: 'file:///C:/cache/cpp/demo/compile_commands.json', type: 2 }
          ]
        }
      }
    ])
  })

  it('ignores health pushes without a path (old Host, mixed versions)', async () => {
    const session = getCppSession()
    await session.ensureClient(cppScope)

    scripted.instance!.pushMappingHealth({ scopeId: cppScope.id, mappingHealth: [] })

    expect(watchedFileNotifications()).toEqual([])
  })

  it('ignores pushes when no session is live', async () => {
    getCppSession()

    expect(() =>
      scripted.instance!.pushMappingHealth({
        scopeId: cppScope.id,
        mappingHealth: [],
        aggregateCdbPath: '/cache/cpp/demo/compile_commands.json'
      })
    ).not.toThrow()
    expect(watchedFileNotifications()).toEqual([])
  })

  it('declares didChangeWatchedFiles so clangd accepts the notification', async () => {
    await getCppSession().ensureClient(cppScope)
    const params = scripted.initializeParams as {
      capabilities?: { workspace?: { didChangeWatchedFiles?: unknown } }
    }
    expect(params.capabilities?.workspace?.didChangeWatchedFiles).toEqual({
      dynamicRegistration: false
    })
  })
})
