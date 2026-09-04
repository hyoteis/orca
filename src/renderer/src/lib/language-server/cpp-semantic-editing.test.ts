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

import {
  resetScriptedLanguageServerClient,
  scripted
} from './scripted-language-server-client'
import {
  getCppCompletion,
  getCppRenameEdit,
  installCppWorkspaceApplyEditInterceptor
} from './cpp-semantic-editing'
import {
  resetCppCodeIntelligenceSession,
  type CppCodeIntelligenceRequest
} from './cpp-code-intelligence-session'

const scope: CodeIntelligenceScope = {
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

const request: CppCodeIntelligenceRequest = {
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

beforeEach(() => {
  resetScriptedLanguageServerClient()
  scripted.capabilities = {
    completionProvider: { resolveProvider: true },
    renameProvider: true
  }
  resetCppCodeIntelligenceSession()
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

describe('cpp semantic editing requests', () => {
  it('returns completion items', async () => {
    const item: CompletionItem = { label: 'vector' }
    scripted.requestHandlers['textDocument/completion'] = () => [item]
    expect(await getCppCompletion(request, { triggerKind: 1 })).toEqual([item])
  })

  it('sends no feature request when the capability is absent', async () => {
    scripted.capabilities = {}
    expect(await getCppCompletion(request, { triggerKind: 1 })).toBeNull()
    expect(await getCppRenameEdit(request, 'renamed')).toBeNull()
    expect(scripted.requestCalls).toEqual([])
  })
})

describe('cpp workspace/applyEdit interception', () => {
  it('reports declined when the user rejects the guarded proposal', async () => {
    const confirm = vi.fn(async () => false)
    installCppWorkspaceApplyEditInterceptor(() => ({
      operationHostId: 'local',
      view: {
        openDocumentFor: () => null,
        readText: async () => 'int main() {}',
        exists: async () => true
      },
      ports: {
        readText: async () => 'int main() {}',
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
    await getCppCompletion(request, { triggerKind: 1 })
    const handler = scripted.serverRequestRoutes['workspace/applyEdit']
    expect(handler).toBeDefined()
    const result = (await handler!({
      edit: { changes: {} }
    } as ApplyWorkspaceEditParams)) as { applied: boolean }
    expect(result.applied).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
  })
})
