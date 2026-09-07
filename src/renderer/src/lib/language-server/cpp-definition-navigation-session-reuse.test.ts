// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CancellationToken } from 'vscode-languageserver-protocol'
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

import {
  getCppDocumentSymbols,
  resetCppCodeIntelligence,
  resolveCppDefinition
} from './cpp-definition-navigation'
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
  resetCppCodeIntelligence()
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

describe('cpp document symbols', () => {
  it('declares hierarchical documentSymbol support so clangd nests instead of ::-qualifying', async () => {
    await resolveCppDefinition(request(1))
    expect(scripted.initializeParams).toMatchObject({
      capabilities: {
        textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } }
      }
    })
  })

  it('requests by textDocument uri and returns hierarchical symbols', async () => {
    const symbols = [
      {
        name: 'main',
        kind: 12,
        range: { start: { line: 0, character: 4 }, end: { line: 2, character: 1 } },
        selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 8 } }
      }
    ]
    let capturedParams: unknown
    scripted.requestHandlers['textDocument/documentSymbol'] = (params: unknown) => {
      capturedParams = params
      return symbols
    }
    expect(await getCppDocumentSymbols(request(1))).toEqual(symbols)
    expect(capturedParams).toEqual({ textDocument: { uri: 'file:///repo/a.cpp' } })
  })

  it('returns the flat SymbolInformation shape unchanged', async () => {
    const symbols = [
      {
        name: 'Renderer',
        kind: 23, // Struct
        containerName: '',
        location: {
          uri: 'file:///repo/a.cpp',
          range: { start: { line: 3, character: 6 }, end: { line: 9, character: 1 } }
        }
      }
    ]
    scripted.requestHandlers['textDocument/documentSymbol'] = () => symbols
    expect(await getCppDocumentSymbols(request(2))).toEqual(symbols)
  })

  it('caches per document version like the Python query', async () => {
    scripted.requestHandlers['textDocument/documentSymbol'] = () => []
    await getCppDocumentSymbols(request(3))
    await getCppDocumentSymbols(request(3))
    expect(
      scripted.requestCalls.filter((call) => call === 'textDocument/documentSymbol')
    ).toHaveLength(1)
  })

  it('re-queries after a session restart instead of serving the stale cache', async () => {
    let generation = 0
    scripted.requestHandlers['textDocument/documentSymbol'] = () => {
      generation += 1
      return [
        {
          name: `sym-${generation}`,
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }
        }
      ]
    }
    expect(await getCppDocumentSymbols(request(3))).toEqual([
      expect.objectContaining({ name: 'sym-1' })
    ])
    // Re-run setup path: the revision bump restarts the session (drop client).
    scripted.instance!.restartScope('local:worktree:demo:cpp', 2)
    expect(await getCppDocumentSymbols(request(3))).toEqual([
      expect.objectContaining({ name: 'sym-2' })
    ])
    expect(
      scripted.requestCalls.filter((call) => call === 'textDocument/documentSymbol')
    ).toHaveLength(2)
  })

  it('does not cache a cancelled result', async () => {
    const cancelled: CancellationToken = {
      isCancellationRequested: true,
      onCancellationRequested: () => ({ dispose: () => {} })
    }
    await getCppDocumentSymbols(request(5), cancelled).catch(() => null)
    expect(scripted.requestCalls).not.toContain('textDocument/documentSymbol')
    scripted.requestHandlers['textDocument/documentSymbol'] = () => []
    await getCppDocumentSymbols(request(5))
    expect(scripted.requestCalls).toContain('textDocument/documentSymbol')
  })

  it('returns null without a cpp scope and never asks the server', async () => {
    settings = { codeIntelligenceScopes: [] as CodeIntelligenceScope[] } as GlobalSettings
    expect(await getCppDocumentSymbols(request(4))).toBeNull()
    expect(scripted.requestCalls).not.toContain('textDocument/documentSymbol')
  })
})
