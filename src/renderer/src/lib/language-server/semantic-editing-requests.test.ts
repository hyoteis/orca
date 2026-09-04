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

vi.mock('./language-server-client-registry', async () => {
  const { ScriptedLanguageServerClient } = await import('./scripted-language-server-client')
  return { LanguageServerClientRegistry: ScriptedLanguageServerClient }
})

import { resetScriptedLanguageServerClient, scripted } from './scripted-language-server-client'
import { createSemanticEditingRequests } from './semantic-editing-requests'
import type { SemanticWorkspaceEditContext } from './semantic-workspace-edit-flow'
import {
  getCppSession,
  resetCppCodeIntelligenceSession,
  type CppCodeIntelligenceRequest
} from './cpp-code-intelligence-session'
import {
  getPythonCodeIntelligenceSession,
  resetPythonCodeIntelligenceSession,
  type PythonCodeIntelligenceRequest
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

const pythonScope: CodeIntelligenceScope = { ...cppScope, id: 'local:worktree:demo:python', name: 'Demo Python', language: 'python' }

const cppRequest: CppCodeIntelligenceRequest = {
  fileId: 'f1',
  filePath: '/repo/main.cpp',
  relativePath: 'main.cpp',
  worktreeId: 'demo',
  language: 'cpp',
  text: 'int main() {}',
  documentVersion: 1,
  lineNumber: 1,
  column: 1
}

const pythonRequest: PythonCodeIntelligenceRequest = { ...cppRequest, filePath: '/repo/main.py', relativePath: 'main.py', language: 'python', text: 'x = 1' }

const cppRequests = createSemanticEditingRequests(getCppSession)
const pythonRequests = createSemanticEditingRequests(getPythonCodeIntelligenceSession)

beforeEach(() => {
  resetScriptedLanguageServerClient()
  scripted.capabilities = {
    completionProvider: { resolveProvider: true },
    renameProvider: true,
    documentFormattingProvider: true
  }
  resetCppCodeIntelligenceSession()
  resetPythonCodeIntelligenceSession()
  ;(window as unknown as { api: unknown }).api = { languageServers: {} }
  settings = { codeIntelligenceScopes: [cppScope, pythonScope] } as GlobalSettings
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

describe('semantic editing requests', () => {
  it('returns completion items from a CompletionList', async () => {
    const item: CompletionItem = { label: 'sqrt' }
    scripted.requestHandlers['textDocument/completion'] = () => ({ items: [item] })
    expect(await pythonRequests.getCompletion(pythonRequest, { triggerKind: 1 })).toEqual([item])
  })

  it('returns completion items from a bare array (clangd shape)', async () => {
    const item: CompletionItem = { label: 'vector' }
    scripted.requestHandlers['textDocument/completion'] = () => [item]
    expect(await cppRequests.getCompletion(cppRequest, { triggerKind: 1 })).toEqual([item])
  })

  it('sends no request when the server lacks the capability', async () => {
    scripted.capabilities = {}
    expect(await pythonRequests.getCompletion(pythonRequest, { triggerKind: 1 })).toBeNull()
    expect(await pythonRequests.getRenameEdit(pythonRequest, 'renamed')).toBeNull()
    expect(
      await pythonRequests.getFormattingEdits(pythonRequest, { tabSize: 4, insertSpaces: true })
    ).toBeNull()
    expect(scripted.requestCalls).toEqual([])
  })

  it('rejects server commands the server never declared (#20)', async () => {
    scripted.capabilities = { executeCommandProvider: { commands: ['allowed.command'] } }
    scripted.requestHandlers['workspace/executeCommand'] = () => 'ran'
    expect(await pythonRequests.executeServerCommand(pythonRequest, 'unknown.command', [])).toBeNull()
    expect(await pythonRequests.executeServerCommand(pythonRequest, 'allowed.command', [])).toBe('ran')
  })

  it('drops empty rename and formatting results', async () => {
    scripted.requestHandlers['textDocument/rename'] = () => ({ changes: {} })
    scripted.requestHandlers['textDocument/formatting'] = () => []
    expect(await pythonRequests.getRenameEdit(pythonRequest, 'renamed')).toBeNull()
    expect(
      await pythonRequests.getFormattingEdits(pythonRequest, { tabSize: 4, insertSpaces: true })
    ).toBeNull()
  })

  it('returns a rename edit when the server produces changes', async () => {
    scripted.requestHandlers['textDocument/rename'] = () => ({
      changes: {
        'file:///repo/main.py': [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'y' }
        ]
      }
    })
    expect(await pythonRequests.getRenameEdit(pythonRequest, 'y')).toMatchObject({ changes: {} })
  })
})

describe('workspace/applyEdit interception', () => {
  const applyEditParams: ApplyWorkspaceEditParams = {
    edit: {
      changes: {
        'file:///repo/main.py': [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'y' }
        ]
      }
    }
  }

  const guardedContext = (confirm: () => Promise<boolean>): SemanticWorkspaceEditContext => ({
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
  })

  it('answers declined and never commits when the user rejects the proposal', async () => {
    const confirm = vi.fn(async () => false)
    pythonRequests.installWorkspaceApplyEditInterceptor(() => guardedContext(confirm))
    // Open a client so the interceptor installs on it.
    await pythonRequests.getCompletion(pythonRequest, { triggerKind: 1 })
    const handler = scripted.serverRequestRoutes['workspace/applyEdit']
    expect(handler).toBeDefined()
    const result = (await handler!(applyEditParams)) as { applied: boolean }
    expect(result.applied).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('reports a missing context without confirming', async () => {
    pythonRequests.installWorkspaceApplyEditInterceptor(() => null)
    await pythonRequests.getCompletion(pythonRequest, { triggerKind: 1 })
    const handler = scripted.serverRequestRoutes['workspace/applyEdit']!
    const result = (await handler(applyEditParams)) as {
      applied: boolean
      failureReason?: string
    }
    expect(result.applied).toBe(false)
    expect(result.failureReason).toMatch(/no guarded-edit context/)
  })

  it('routes clangd sessions through the same guarded path', async () => {
    const confirm = vi.fn(async () => false)
    cppRequests.installWorkspaceApplyEditInterceptor(() => guardedContext(confirm))
    await cppRequests.getCompletion(cppRequest, { triggerKind: 1 })
    const handler = scripted.serverRequestRoutes['workspace/applyEdit']
    expect(handler).toBeDefined()
    const result = (await handler!({ edit: { changes: {} } } as ApplyWorkspaceEditParams)) as {
      applied: boolean
    }
    expect(result.applied).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
  })
})
