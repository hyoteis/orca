import {
  DefinitionRequest,
  InitializedNotification,
  type InitializeParams
} from 'vscode-languageserver-protocol'
import { detectLanguage } from '@/lib/language-detect'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import { isDocumentInCodeIntelligenceScope } from './code-intelligence-scope-membership'
import {
  LanguageServerClientRegistry,
  type LanguageServerClientKey
} from './language-server-client-registry'
import { toServerFileUri } from './language-server-document-uri'
import { definitionTargets, type CppDefinitionTarget } from './cpp-definition-locations'

type DefinitionNavigationRequest = {
  fileId: string
  filePath: string
  relativePath: string
  worktreeId: string
  language: string
  text: string
  lineNumber: number
  column: number
}

type OpenClient = Awaited<ReturnType<LanguageServerClientRegistry['open']>>
type ActiveClient = { key: LanguageServerClientKey; client: OpenClient }

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function pathStartsWith(path: string, root: string): boolean {
  const left = normalizePath(path)
  const right = normalizePath(root)
  if (/^[A-Za-z]:\//.test(left) || /^[A-Za-z]:\//.test(right)) {
    return (
      left.toLowerCase() === right.toLowerCase() ||
      left.toLowerCase().startsWith(`${right.toLowerCase()}/`)
    )
  }
  return left === right || left.startsWith(`${right}/`)
}

function relativeToRoot(path: string, root: string): string | null {
  if (!pathStartsWith(path, root)) {
    return null
  }
  const normalizedPath = normalizePath(path)
  const normalizedRoot = normalizePath(root)
  return normalizedPath.length === normalizedRoot.length
    ? '.'
    : normalizedPath.slice(normalizedRoot.length + 1)
}

function fileUriToHostPath(uri: string, executionHostId: string): string | null {
  const url = new URL(uri)
  if (url.protocol !== 'file:') {
    return null
  }
  const pathname = decodeURIComponent(url.pathname)
  if (url.hostname) {
    return `//${url.hostname}${pathname}`
  }
  if (executionHostId === 'local' && /^\/[A-Za-z]:\//.test(pathname)) {
    return pathname.slice(1).replace(/\//g, '\\')
  }
  return pathname
}

function findScope(request: DefinitionNavigationRequest): CodeIntelligenceScope | null {
  const state = useAppStore.getState()
  const repo = state.repos.find(
    (candidate) =>
      candidate.id === request.worktreeId || pathStartsWith(request.filePath, candidate.path)
  )
  if (!repo) {
    return null
  }
  const executionHostId = getRepoExecutionHostId(repo)
  return (
    state.settings?.codeIntelligenceScopes?.find(
      (scope) =>
        scope.language === 'cpp' &&
        scope.enabled &&
        scope.executionHostId === executionHostId &&
        pathStartsWith(request.filePath, scope.workspaceRoot) &&
        isDocumentInCodeIntelligenceScope(scope, request.relativePath)
    ) ?? null
  )
}

class CppDefinitionNavigation {
  private readonly registry = new LanguageServerClientRegistry(window.api.languageServers, (key) =>
    this.clients.delete(key.scopeId)
  )
  private readonly clients = new Map<string, ActiveClient>()

  async navigate(request: DefinitionNavigationRequest): Promise<boolean> {
    if (!['c', 'cpp', 'objective-c', 'objective-cpp'].includes(request.language)) {
      return false
    }
    const scope = findScope(request)
    if (!scope) {
      return false
    }
    const active = await this.ensureClient(scope)
    const uri = toServerFileUri(request.filePath)
    active.client.sync.reconcile([
      {
        documentId: request.fileId,
        uri,
        languageId: request.language,
        diskText: request.text,
        draftText: request.text,
        references: 1
      }
    ])
    const requestGeneration = this.registry.nextRequestGeneration(active.key)
    const definition = await active.client.connection.sendRequest(DefinitionRequest.type, {
      textDocument: { uri },
      position: { line: request.lineNumber - 1, character: request.column - 1 }
    })
    if (!this.registry.isCurrentRequest(active.key, active.client.generation, requestGeneration)) {
      return false
    }
    const target = definitionTargets(definition).find((candidate) => {
      const path = fileUriToHostPath(candidate.uri, scope.executionHostId)
      const relativePath = path ? relativeToRoot(path, scope.workspaceRoot) : null
      return relativePath !== null && this.registry.isResultVisible(active.key, relativePath)
    })
    return target ? this.openTarget(scope, request, target) : false
  }

  private async ensureClient(scope: CodeIntelligenceScope): Promise<ActiveClient> {
    const current = this.clients.get(scope.id)
    if (current?.key.revision === scope.revision) {
      this.registry.markActive(current.key)
      return current
    }
    if (current) {
      this.registry.disposeKey(current.key)
      this.clients.delete(scope.id)
    }
    const key: LanguageServerClientKey = {
      executionHostId: scope.executionHostId,
      scopeId: scope.id,
      kind: 'clangd',
      revision: scope.revision
    }
    const client = await this.registry.open(key, {
      sessionId: `definition:${scope.id}:${scope.revision}`,
      scopeId: scope.id,
      revision: scope.revision
    })
    client.connection.onRequest('workspace/configuration', () => [])
    client.connection.onRequest('client/registerCapability', () => null)
    client.connection.onRequest('window/workDoneProgress/create', () => null)
    const rootUri = toServerFileUri(scope.workspaceRoot)
    const params: InitializeParams = {
      processId: null,
      clientInfo: { name: 'Orca', version: '1' },
      rootUri,
      capabilities: {
        workspace: { configuration: false, workspaceFolders: true },
        textDocument: { definition: { linkSupport: true }, synchronization: {} }
      },
      workspaceFolders: [{ uri: rootUri, name: scope.name }]
    }
    await client.initialize(params)
    client.connection.sendNotification(InitializedNotification.type, {})
    const active = { key, client }
    this.clients.set(scope.id, active)
    return active
  }

  private openTarget(
    scope: CodeIntelligenceScope,
    request: DefinitionNavigationRequest,
    target: CppDefinitionTarget
  ): boolean {
    const filePath = fileUriToHostPath(target.uri, scope.executionHostId)
    const relativePath = filePath ? relativeToRoot(filePath, scope.workspaceRoot) : null
    if (!filePath || relativePath === null) {
      return false
    }
    const state = useAppStore.getState()
    state.setPendingEditorReveal(null)
    state.openFile(
      {
        filePath,
        relativePath,
        worktreeId: request.worktreeId,
        language: detectLanguage(relativePath),
        mode: 'edit'
      },
      {
        forceContentReload: true,
        focusEditor: true,
        suppressActiveRuntimeFallback: scope.executionHostId === 'local'
      }
    )
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        state.setPendingEditorReveal({
          filePath,
          line: target.range.start.line + 1,
          column: target.range.start.character + 1,
          matchLength: Math.max(0, target.range.end.character - target.range.start.character)
        })
      })
    })
    return true
  }
}

let navigation: CppDefinitionNavigation | null = null

export async function navigateToCppDefinition(
  request: DefinitionNavigationRequest
): Promise<boolean> {
  navigation ??= new CppDefinitionNavigation()
  return navigation.navigate(request)
}
