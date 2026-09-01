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

const opens: unknown[] = []
const closes: unknown[] = []

// The real registry cannot load under node test conditions (its jsonrpc
// browser build has no node export); the behavior under test is ensureClient's
// session-reuse decision, not the registry plumbing.
vi.mock('./language-server-client-registry', () => ({
  LanguageServerClientRegistry: class {
    constructor(
      _api: unknown,
      private readonly onRestartDecision?: (key: unknown) => void
    ) {}
    markActive(): void {}
    nextRequestGeneration(): number {
      return 1
    }
    isCurrentRequest(): boolean {
      return true
    }
    open = vi.fn(async (key: { revision: number }) => {
      opens.push(key.revision)
      return {
        generation: 1,
        connection: {
          onRequest: () => ({ dispose: () => {} }),
          sendNotification: () => {},
          // initialize params carry no textDocument; definition requests do.
          sendRequest: async (_type: unknown, params: { textDocument?: unknown }) =>
            params.textDocument ? null : { capabilities: {} }
        },
        sync: { reconcile: () => {} },
        initialize: async () => ({ capabilities: {} })
      }
    })
    close = vi.fn((key: unknown) => closes.push(key))
    disposeKey = this.close
    closeScope(): void {}
    restartScope(_scopeId: string, revision: number): void {
      this.onRestartDecision?.({ revision })
    }
  }
}))

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
  opens.length = 0
  closes.length = 0
  ;(window as unknown as { api: unknown }).api = { languageServers: {} }
  settings = { codeIntelligenceScopes: [scope(1)] } as GlobalSettings
})

describe('cpp definition navigation sessions', () => {
  it('reuses the clangd session across member-only revision bumps', async () => {
    expect(await resolveCppDefinition(request(1))).toBeNull()
    expect(opens).toEqual([1])

    // Member-only change: revision and consent move, the session must not
    // restart (spec §5) — no reopen, no close.
    settings = { codeIntelligenceScopes: [scope(2)] } as GlobalSettings
    expect(await resolveCppDefinition(request(2))).toBeNull()
    expect(opens).toEqual([1])
    expect(closes).toEqual([])
  })
})
