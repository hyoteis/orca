// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import type { GlobalSettings, Repo } from '../../../../shared/types'

// Single mutable settings source, like the real store: the second request must
// see the bumped revision from a member-only change.
let settings: GlobalSettings

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      repos: [
        {
          id: 'demo',
          path: '/repo',
          displayName: 'demo',
          connectionId: null,
          executionHostId: 'local',
          kind: 'git' as const,
          badgeColor: '#000000',
          addedAt: 1
        } satisfies Repo
      ],
      settings
    }),
    setPendingEditorReveal: vi.fn(),
    openFile: vi.fn()
  }
}))

// The real registry's session-reuse behavior is covered by the scripted
// client (in-memory, no jsonrpc): what is under test is ensureClient's
// restart decision, not the registry plumbing.
vi.mock('./language-server-client-registry', async () => {
  const { ScriptedLanguageServerClient } = await import('./scripted-language-server-client')
  return { LanguageServerClientRegistry: ScriptedLanguageServerClient }
})

import { resetScriptedLanguageServerClient, scripted } from './scripted-language-server-client'

import { resolveCppDefinition } from './cpp-definition-navigation'
import type { CppCodeIntelligenceRequest } from './cpp-definition-navigation'

const scope = (revision: number): CodeIntelligenceScope => ({
  id: 'local:worktree:demo:cpp',
  name: 'demo C++',
  executionHostId: 'local',
  workspaceKey: 'worktree:demo',
  workspaceRoot: '/repo',
  language: 'cpp',
  members: [{ path: '.', visibleResults: true }],
  serverSource: { type: 'automatic' },
  enabled: true,
  revision
})

const request = (documentVersion: number): CppCodeIntelligenceRequest => ({
  fileId: 'f1',
  filePath: '/repo/a.cpp',
  relativePath: 'a.cpp',
  worktreeId: 'demo',
  language: 'cpp',
  text: 'int main(){}',
  documentVersion,
  lineNumber: 1,
  column: 5
})

beforeEach(() => {
  resetScriptedLanguageServerClient()
  ;(window as unknown as { api: unknown }).api = { languageServers: {} }
  settings = { codeIntelligenceScopes: [scope(1)] } as GlobalSettings
})

describe('cpp definition navigation sessions', () => {
  it('reuses the clangd session across member-only revision bumps', async () => {
    expect(await resolveCppDefinition(request(1))).toBeNull()
    expect(scripted.opens.map((key) => key.revision)).toEqual([1])

    // Member-only change: revision and consent move, the session must not
    // restart (spec §5) — no reopen, no close.
    settings = { codeIntelligenceScopes: [scope(2)] } as GlobalSettings
    expect(await resolveCppDefinition(request(2))).toBeNull()
    expect(scripted.opens.map((key) => key.revision)).toEqual([1])
    expect(scripted.closes).toEqual([])
  })
})
