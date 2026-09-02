// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CancellationToken } from 'vscode-languageserver-protocol'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import type { GlobalSettings, Repo } from '../../../../shared/types'

// Single mutable store state, like the real store: tests swap scopes/repos in place.
let settings: GlobalSettings
let repos: Repo[]

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ repos, settings, openFile: vi.fn(), setPendingEditorReveal: vi.fn() })
  }
}))

// Programmable fake connection per test: requestHandlers[method] answers
// sendRequest; notificationRoutes[method] receives server notifications.
// sessionOverrides[i] scopes a handler to the i-th opened session.
const requestHandlers: Record<string, (params: unknown, token?: unknown) => unknown> = {}
const sessionOverrides: Record<string, (params: unknown, token?: unknown) => unknown>[] = []
const notificationRoutes: Record<string, (params: unknown) => void> = {}
const requestCalls: string[] = []
let mockCapabilities: Record<string, unknown> = {}
let isCurrentRequest = true

const registryHandle = vi.hoisted(() => ({
  instance: null as unknown as { restartScope(scopeId: string): void }
}))

vi.mock('./language-server-client-registry', () => ({
  LanguageServerClientRegistry: class {
    constructor(
      _api: unknown,
      private readonly onRestartDecision?: (key: { scopeId: string }) => void
    ) {
      registryHandle.instance = this
    }
    markActive(): void {}
    nextRequestGeneration(): number {
      return 1
    }
    isCurrentRequest(): boolean {
      return isCurrentRequest
    }
    restartScope(scopeId: string): void {
      this.onRestartDecision?.({ scopeId })
    }
    open = vi.fn(async () => {
      const sessionIndex = sessionOverrides.length
      sessionOverrides.push({})
      return {
        generation: 1,
        connection: {
          onRequest: () => ({ dispose: () => {} }),
          onNotification: (type: { method: string }, handler: (params: unknown) => void) => {
            notificationRoutes[type.method] = handler
            return { dispose: () => delete notificationRoutes[type.method] }
          },
          sendNotification: () => {},
          sendRequest: async (type: { method: string }, params: unknown, token?: unknown) => {
            requestCalls.push(type.method)
            if ((token as CancellationToken | undefined)?.isCancellationRequested) {
              throw new Error('cancelled')
            }
            const handler =
              sessionOverrides[sessionIndex][type.method] ?? requestHandlers[type.method]
            return handler?.(params, token) ?? null
          }
        },
        sync: { reconcile: () => {} },
        initialize: async () => ({ capabilities: mockCapabilities })
      }
    })
    close(): void {}
    closeScope(): void {}
    dispose(): void {}
  }
}))

import {
  getPythonDiagnostics,
  getPythonDocumentSymbols,
  getPythonHover,
  getPythonReferences,
  resetPythonCodeIntelligence,
  subscribePythonDiagnostics,
  resolvePythonDefinition,
  searchPythonWorkspaceSymbols
} from './python-definition-navigation'
import type { PythonCodeIntelligenceRequest } from './python-definition-navigation'

const repo = (id: string, path: string): Repo => ({
  id,
  path,
  displayName: id,
  connectionId: null,
  executionHostId: 'local',
  kind: 'git',
  badgeColor: '#000000',
  addedAt: 1
})

const scope = (id: string, root: string, key: string): CodeIntelligenceScope => ({
  id,
  name: `${id} Python`,
  executionHostId: 'local',
  workspaceKey: `worktree:${key}`,
  workspaceRoot: root,
  language: 'python',
  members: [
    { path: '.', visibleResults: true },
    { path: 'vendored', visibleResults: false }
  ],
  serverSource: { type: 'automatic' },
  enabled: true,
  revision: 1
})

const request = (
  version: number,
  overrides: Partial<PythonCodeIntelligenceRequest> = {}
): PythonCodeIntelligenceRequest => ({
  fileId: 'f1',
  filePath: '/repo/main.py',
  relativePath: 'main.py',
  worktreeId: 'demo',
  language: 'python',
  text: 'x = 1',
  documentVersion: version,
  lineNumber: 1,
  column: 1,
  ...overrides
})

const location = (uri: string, line = 1) => ({
  uri,
  range: { start: { line, character: 0 }, end: { line, character: 3 } }
})

const fullCapabilities = {
  definitionProvider: true,
  hoverProvider: true,
  referencesProvider: true,
  documentSymbolProvider: true,
  workspaceSymbolProvider: true
}

beforeEach(() => {
  requestCalls.length = 0
  for (const method of Object.keys(requestHandlers)) {
    delete requestHandlers[method]
  }
  sessionOverrides.length = 0
  for (const method of Object.keys(notificationRoutes)) {
    delete notificationRoutes[method]
  }
  mockCapabilities = { ...fullCapabilities }
  isCurrentRequest = true
  resetPythonCodeIntelligence()
  ;(window as unknown as { api: unknown }).api = { languageServers: {} }
  settings = {
    codeIntelligenceScopes: [scope('local:worktree:demo:python', '/repo', 'demo')]
  } as GlobalSettings
  repos = [repo('demo', '/repo')]
})

describe('python definition navigation', () => {
  it('returns an in-workspace target and prefers it over external dependencies', async () => {
    requestHandlers['textDocument/definition'] = () => [
      { targetUri: 'file:///usr/lib/site-packages/dep.py', targetSelectionRange: location('').range },
      location('file:///repo/lib.py', 4)
    ]
    const result = await resolvePythonDefinition(request(1))
    expect(result).toEqual({
      target: { uri: 'file:///repo/lib.py', range: location('', 4).range },
      external: false
    })
  })

  it('labels targets outside the workspace root as external dependencies', async () => {
    requestHandlers['textDocument/definition'] = () =>
      location('file:///usr/lib/site-packages/dep.py')
    const result = await resolvePythonDefinition(request(2))
    expect(result?.external).toBe(true)
  })

  it('returns null when no python scope matches', async () => {
    settings = { codeIntelligenceScopes: [] as CodeIntelligenceScope[] } as GlobalSettings
    expect(await resolvePythonDefinition(request(3))).toBeNull()
    expect(requestCalls).not.toContain('textDocument/definition')
  })

  it('rejects results from a client dropped by a restart', async () => {
    await getPythonDiagnostics(request(3)) // open the session
    let release!: (value: unknown) => void
    requestHandlers['textDocument/definition'] = () =>
      new Promise((resolve) => {
        release = resolve
      })
    const pending = resolvePythonDefinition(request(4))
    await new Promise((resolve) => setTimeout(resolve, 0))
    registryHandle.instance.restartScope('local:worktree:demo:python')
    release(location('file:///repo/lib.py'))
    expect(await pending).toBeNull()
  })

  it('skips the request entirely when the token is already cancelled', async () => {
    const cancelled: CancellationToken = {
      isCancellationRequested: true,
      onCancellationRequested: () => ({ dispose: () => {} })
    }
    // Cancelled results reject (never cached) so the next call re-requests.
    await expect(resolvePythonDefinition(request(5), cancelled)).rejects.toBeTruthy()
    expect(requestCalls).not.toContain('textDocument/definition')
  })

  it('does not cache a cancelled result', async () => {
    const cancelled: CancellationToken = {
      isCancellationRequested: true,
      onCancellationRequested: () => ({ dispose: () => {} })
    }
    await resolvePythonDefinition(request(6), cancelled).catch(() => null)
    requestCalls.length = 0
    requestHandlers['textDocument/hover'] = () => ({ contents: { kind: 'markdown', value: 'x' } })
    await getPythonHover(request(6))
    expect(requestCalls).toContain('textDocument/hover')
  })
})

describe('python hover', () => {
  it('returns the server hover', async () => {
    const hover = { contents: { kind: 'markdown', value: 'int' } }
    requestHandlers['textDocument/hover'] = () => hover
    expect(await getPythonHover(request(1))).toEqual(hover)
  })

  it('is capability-gated', async () => {
    mockCapabilities = {}
    expect(await getPythonHover(request(2))).toBeNull()
    expect(requestCalls).not.toContain('textDocument/hover')
  })
})

describe('python references', () => {
  it('keeps only in-workspace references under visible members', async () => {
    requestHandlers['textDocument/references'] = () => [
      location('file:///repo/pkg/a.py'),
      location('file:///repo/vendored/b.py'),
      location('file:///usr/lib/site-packages/dep.py')
    ]
    const references = await getPythonReferences(request(1))
    expect(references).toEqual([location('file:///repo/pkg/a.py')])
  })
})

describe('python document symbols', () => {
  it('returns hierarchical symbols', async () => {
    const symbols = [
      { name: 'main', kind: 12, range: location('').range, selectionRange: location('').range }
    ]
    requestHandlers['textDocument/documentSymbol'] = () => symbols
    expect(await getPythonDocumentSymbols(request(1))).toEqual(symbols)
  })
})

describe('python workspace symbols', () => {
  it('fans out across open python scopes and keeps partial results on failure', async () => {
    settings = {
      codeIntelligenceScopes: [
        scope('local:worktree:demo:python', '/repo', 'demo'),
        scope('local:worktree:other:python', '/other', 'other')
      ]
    } as GlobalSettings
    repos = [repo('demo', '/repo'), repo('other', '/other')]
    // Open both sessions by exercising a per-document request in each workspace.
    requestHandlers['textDocument/hover'] = () => null
    await getPythonHover(request(1))
    await getPythonHover(request(2, { filePath: '/other/app.py', relativePath: 'app.py', worktreeId: 'other', fileId: 'f2' }))

    requestHandlers['workspace/symbol'] = () => [
      { name: 'a', kind: 12, location: location('file:///repo/pkg/a.py') }
    ]
    // The second-opened session (other workspace) fails; the first keeps its results.
    sessionOverrides[1]['workspace/symbol'] = () => {
      throw new Error('server down')
    }
    const result = await searchPythonWorkspaceSymbols('anything')
    expect(result.partial).toBe(true)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({ scopeName: 'local:worktree:demo:python Python' })
  })
})

describe('python diagnostics', () => {
  it('stores published diagnostics and drops superseded versions', async () => {
    await getPythonDiagnostics(request(1))
    const publish = (params: { uri: string; diagnostics: unknown[]; version?: number }): void =>
      notificationRoutes['textDocument/publishDiagnostics'](params)
    publish({
      uri: 'file:///repo/main.py',
      diagnostics: [{ message: 'old', range: location('').range, severity: 1 }],
      version: 3
    })
    publish({
      uri: 'file:///repo/main.py',
      diagnostics: [{ message: 'new', range: location('').range, severity: 1 }],
      version: 2
    })
    const diagnostics = await getPythonDiagnostics(request(1))
    expect(diagnostics).toHaveLength(1)
    expect((diagnostics[0] as { message: string }).message).toBe('old')
  })

  it('clears diagnostics when a restart drops the client', async () => {
    await getPythonDiagnostics(request(1))
    notificationRoutes['textDocument/publishDiagnostics']({
      uri: 'file:///repo/main.py',
      diagnostics: [{ message: 'e', range: location('').range, severity: 1 }],
      version: 1
    })
    const notified: string[] = []
    const unsubscribe = subscribePythonDiagnostics((uri) => notified.push(uri))
    registryHandle.instance.restartScope('local:worktree:demo:python')
    expect(notified).toContain('file:///repo/main.py')
    expect(await getPythonDiagnostics(request(2))).toEqual([])
    unsubscribe()
  })

  it('clears diagnostics on empty publish', async () => {
    await getPythonDiagnostics(request(1))
    notificationRoutes['textDocument/publishDiagnostics']({
      uri: 'file:///repo/main.py',
      diagnostics: [{ message: 'e', range: location('').range, severity: 1 }],
      version: 1
    })
    notificationRoutes['textDocument/publishDiagnostics']({
      uri: 'file:///repo/main.py',
      diagnostics: [],
      version: 2
    })
    expect(await getPythonDiagnostics(request(1))).toEqual([])
  })
})
