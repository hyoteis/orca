// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplyWorkspaceEditParams, CompletionItem } from 'vscode-languageserver-protocol'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import type { GlobalSettings, Repo } from '../../../../shared/types'

let settings: GlobalSettings
let repos: Repo[]

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ repos, settings, openFile: vi.fn(), setPendingEditorReveal: vi.fn() })
  }
}))

const requestHandlers: Record<string, (params: unknown) => unknown> = {}
const serverRequestRoutes: Record<string, (params: unknown) => unknown> = {}
const requestCalls: string[] = []
let mockCapabilities: Record<string, unknown> = {}

vi.mock('./language-server-client-registry', () => ({
  LanguageServerClientRegistry: class {
    markActive(): void {}
    nextRequestGeneration(): number {
      return 1
    }
    isCurrentRequest(): boolean {
      return true
    }
    open = vi.fn(async () => ({
      generation: 1,
      connection: {
        onRequest: (type: { method: string }, handler: (params: unknown) => unknown) => {
          serverRequestRoutes[type.method] = handler
          return { dispose: () => delete serverRequestRoutes[type.method] }
        },
        onNotification: () => ({ dispose: () => {} }),
        sendNotification: () => {},
        sendRequest: async (type: { method: string }, params: unknown) => {
          requestCalls.push(type.method)
          return requestHandlers[type.method]?.(params) ?? null
        }
      },
      sync: { reconcile: () => {} },
      initialize: async () => ({ capabilities: mockCapabilities })
    }))
    close(): void {}
    closeScope(): void {}
    dispose(): void {}
  }
}))

import {
  executePythonServerCommand,
  getPythonCompletion,
  getPythonFormattingEdits,
  getPythonRenameEdit,
  installPythonWorkspaceApplyEditInterceptor
} from './python-semantic-editing'
import {
  resetPythonCodeIntelligenceSession,
  type PythonCodeIntelligenceRequest
} from './python-code-intelligence-session'

const scope: CodeIntelligenceScope = {
  id: 'local:worktree:demo:python',
  name: 'Demo Python',
  executionHostId: 'local',
  workspaceKey: 'worktree:demo',
  workspaceRoot: '/repo',
  language: 'python',
  members: [{ path: '.', visibleResults: true }],
  serverSource: { type: 'automatic' },
  enabled: true,
  revision: 1
}

const request: PythonCodeIntelligenceRequest = {
  fileId: 'f1',
  filePath: '/repo/main.py',
  relativePath: 'main.py',
  worktreeId: 'demo',
  language: 'python',
  text: 'x = 1',
  documentVersion: 1,
  lineNumber: 1,
  column: 1
}

beforeEach(() => {
  requestCalls.length = 0
  for (const method of Object.keys(requestHandlers)) {
    delete requestHandlers[method]
  }
  for (const method of Object.keys(serverRequestRoutes)) {
    delete serverRequestRoutes[method]
  }
  mockCapabilities = {
    completionProvider: { resolveProvider: true },
    renameProvider: true,
    documentFormattingProvider: true
  }
  resetPythonCodeIntelligenceSession()
  ;(window as unknown as { api: unknown }).api = { languageServers: {} }
  settings = { codeIntelligenceScopes: [scope] } as GlobalSettings
  repos = [
    {
      id: 'demo',
      path: '/repo',
      displayName: 'demo',
      connectionId: null,
      executionHostId: 'local',
      kind: 'git',
      badgeColor: '#000000',
      addedAt: 1
    }
  ]
})

describe('python semantic editing requests', () => {
  it('returns completion items from a CompletionList', async () => {
    const item: CompletionItem = { label: 'sqrt' }
    requestHandlers['textDocument/completion'] = () => ({ items: [item] })
    const items = await getPythonCompletion(request, { triggerKind: 1 })
    expect(items).toEqual([item])
  })

  it('sends no request when the server lacks the capability', async () => {
    mockCapabilities = {}
    expect(await getPythonCompletion(request, { triggerKind: 1 })).toBeNull()
    expect(await getPythonRenameEdit(request, 'renamed')).toBeNull()
    expect(await getPythonFormattingEdits(request, { tabSize: 4, insertSpaces: true })).toBeNull()
    expect(requestCalls).toEqual([])
  })

  it('rejects server commands the server never declared (#20)', async () => {
    mockCapabilities = { executeCommandProvider: { commands: ['allowed.command'] } }
    requestHandlers['workspace/executeCommand'] = () => 'ran'
    expect(
      await executePythonServerCommand(request, 'unknown.command', [])
    ).toBeNull()
    expect(await executePythonServerCommand(request, 'allowed.command', [])).toBe('ran')
  })

  it('drops empty rename and formatting results', async () => {
    requestHandlers['textDocument/rename'] = () => ({ changes: {} })
    requestHandlers['textDocument/formatting'] = () => []
    expect(await getPythonRenameEdit(request, 'renamed')).toBeNull()
    expect(await getPythonFormattingEdits(request, { tabSize: 4, insertSpaces: true })).toBeNull()
  })

  it('returns a rename edit when the server produces changes', async () => {
    requestHandlers['textDocument/rename'] = () => ({
      changes: {
        'file:///repo/main.py': [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'y' }
        ]
      }
    })
    expect(await getPythonRenameEdit(request, 'y')).toMatchObject({ changes: {} })
  })
})

describe('python workspace/applyEdit interception', () => {
  const applyEditParams: ApplyWorkspaceEditParams = {
    edit: {
      changes: {
        'file:///repo/main.py': [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'y' }
        ]
      }
    }
  }

  it('answers declined and never commits when the user rejects the proposal', async () => {
    const confirm = vi.fn(async () => false)
    installPythonWorkspaceApplyEditInterceptor(() => ({
      operationHostId: 'local',
      view: {
        openDocumentFor: () => null,
        readText: async () => 'x = 1',
        exists: async () => true
      },
      ports: {
        readText: async () => 'x = 1',
        exists: async () => true,
        writeAtomic: vi.fn(),
        createFile: vi.fn(),
        renamePath: vi.fn(),
        deletePath: vi.fn(),
        quiesceEditorSaves: vi.fn(async () => undefined),
        openDocumentFor: () => null
      },
      confirm,
      openFiles: [],
      worktreePathFor: () => '/repo'
    }))
    // Open a client so the interceptor installs on it.
    await getPythonCompletion(request, { triggerKind: 1 })
    const handler = serverRequestRoutes['workspace/applyEdit']
    expect(handler).toBeDefined()
    const result = (await handler!(applyEditParams)) as { applied: boolean }
    expect(result.applied).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('reports a missing context without confirming', async () => {
    installPythonWorkspaceApplyEditInterceptor(() => null)
    await getPythonCompletion(request, { triggerKind: 1 })
    const handler = serverRequestRoutes['workspace/applyEdit']!
    const result = (await handler(applyEditParams)) as {
      applied: boolean
      failureReason?: string
    }
    expect(result.applied).toBe(false)
    expect(result.failureReason).toMatch(/no guarded-edit context/)
  })
})
