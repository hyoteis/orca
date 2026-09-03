import {
  DefinitionRequest,
  DocumentSymbolRequest,
  HoverRequest,
  ReferencesRequest,
  WorkspaceSymbolRequest,
  type CancellationToken,
  type Definition,
  type Diagnostic,
  type LocationLink,
  type DocumentSymbol,
  type Hover,
  type Location,
  type SymbolInformation,
  type WorkspaceSymbol
} from 'vscode-languageserver-protocol'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import { useAppStore } from '@/store'
import { definitionTargets } from './cpp-definition-locations'
import {
  fileUriToHostPath,
  findCodeIntelligenceScope,
  relativeToRoot,
  visibleWorkspaceSymbols
} from './code-intelligence-workspace'
import { isCodeIntelligenceResultVisible } from './code-intelligence-scope-membership'
import { toServerFileUri } from './language-server-document-uri'
import {
  cacheRequestCancellable,
  requestCacheKey
} from './navigation-request-cache'
import {
  PYTHON_LANGUAGES,
  PythonCodeIntelligenceSession,
  type PythonCapabilities,
  type PythonCodeIntelligenceRequest,
  type PythonActiveClient,
  type PythonDefinitionResult,
  type PythonSessionState,
  type PythonWorkspaceSymbols
} from './python-code-intelligence-session'

export {
  PYTHON_LANGUAGES,
  subscribePythonDiagnostics
} from './python-code-intelligence-session'
export type {
  PythonCodeIntelligenceRequest,
  PythonDefinitionResult,
  PythonSessionState,
  PythonWorkspaceSymbols
} from './python-code-intelligence-session'

let session: PythonCodeIntelligenceSession | null = null

function service(): PythonCodeIntelligenceSession {
  session ??= new PythonCodeIntelligenceSession()
  return session
}

/** Drops sessions and caches; used by tests and hot reloads. */
export function resetPythonCodeIntelligence(): void {
  session?.dispose()
  session = null
  definitionCache.clear()
  hoverCache.clear()
  referencesCache.clear()
  documentSymbolCache.clear()
}

function isVisibleInScope(scope: CodeIntelligenceScope, location: { uri: string }): boolean {
  const path = fileUriToHostPath(location.uri, scope.executionHostId)
  const relativePath = path ? relativeToRoot(path, scope.workspaceRoot) : null
  return relativePath !== null && isCodeIntelligenceResultVisible(scope, relativePath)
}

async function prepareRequest(
  request: PythonCodeIntelligenceRequest,
  requiredCapability?: keyof PythonCapabilities
): Promise<{
  scope: CodeIntelligenceScope
  uri: string
  active: Awaited<ReturnType<PythonCodeIntelligenceSession['ensureClient']>>
} | null> {
  if (!PYTHON_LANGUAGES.has(request.language)) {
    return null
  }
  const scope = findCodeIntelligenceScope(request, 'python')
  if (!scope) {
    return null
  }
  const active = await service().ensureClient(scope)
  if (requiredCapability && !active.capabilities[requiredCapability]) {
    return null
  }
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
  return { scope, uri, active }
}

async function sendChecked<Result>(
  scopeId: string,
  active: PythonActiveClient,
  type: { method: string },
  params: object,
  token?: CancellationToken
): Promise<Result | null> {
  // The typed request objects share a runtime shape; the cast keeps one helper
  // for all five LSP requests.
  const sendRequest = active.client.connection.sendRequest as unknown as (
    type: unknown,
    params: object,
    token?: CancellationToken
  ) => Promise<Result>
  const result = await sendRequest(type, params, token)
  // Identity check, not request-generation equality: concurrent requests on one
  // client are independent, while a dropped/replaced client's results are dead
  // (#13 pre-restart rejection).
  if (token?.isCancellationRequested || !service().isActive(scopeId, active)) {
    return null
  }
  return result
}

async function resolvePythonDefinitionUncached(
  request: PythonCodeIntelligenceRequest,
  token?: CancellationToken
): Promise<PythonDefinitionResult | null> {
  if (token?.isCancellationRequested) {
    return null
  }
  const prepared = await prepareRequest(request, 'definition')
  if (!prepared) {
    return null
  }
  const { scope, uri, active } = prepared
  const definition = await sendChecked<Definition | LocationLink[] | null>(
    scope.id,
    active,
    DefinitionRequest.type,
    {
      textDocument: { uri },
      position: { line: request.lineNumber - 1, character: request.column - 1 }
    },
    token
  )
  const candidates = definitionTargets(definition).map((target) => ({
    target,
    relativePath: (() => {
      const hostPath = fileUriToHostPath(target.uri, scope.executionHostId)
      return hostPath ? relativeToRoot(hostPath, scope.workspaceRoot) : null
    })()
  }))
  // In-workspace definitions win; external dependencies (site-packages) stay
  // navigable but labelled.
  const chosen = candidates.find((candidate) => candidate.relativePath !== null) ?? candidates[0]
  return chosen ? { target: chosen.target, external: chosen.relativePath === null } : null
}

async function getPythonHoverUncached(
  request: PythonCodeIntelligenceRequest,
  token?: CancellationToken
): Promise<Hover | null> {
  const prepared = await prepareRequest(request, 'hover')
  return prepared
    ? sendChecked<Hover>(
        prepared.scope.id,
        prepared.active,
        HoverRequest.type,
        {
          textDocument: { uri: prepared.uri },
          position: { line: request.lineNumber - 1, character: request.column - 1 }
        },
        token
      )
    : null
}

async function getPythonReferencesUncached(
  request: PythonCodeIntelligenceRequest,
  token?: CancellationToken
): Promise<Location[] | null> {
  const prepared = await prepareRequest(request, 'references')
  if (!prepared) {
    return null
  }
  const result = await sendChecked<Location[] | null>(
    prepared.scope.id,
    prepared.active,
    ReferencesRequest.type,
    {
      textDocument: { uri: prepared.uri },
      position: { line: request.lineNumber - 1, character: request.column - 1 },
      context: { includeDeclaration: true }
    },
    token
  )
  // References default to language-service-scope members (#13): external and
  // non-visible members drop out.
  return (result ?? []).filter((location) => isVisibleInScope(prepared.scope, location))
}

async function getPythonDocumentSymbolsUncached(
  request: PythonCodeIntelligenceRequest,
  token?: CancellationToken
): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
  const prepared = await prepareRequest(request, 'documentSymbol')
  return prepared
    ? sendChecked<DocumentSymbol[] | SymbolInformation[] | null>(
        prepared.scope.id,
        prepared.active,
        DocumentSymbolRequest.type,
        { textDocument: { uri: prepared.uri } },
        token
      )
    : null
}

export async function getPythonDiagnostics(
  request: PythonCodeIntelligenceRequest
): Promise<Diagnostic[]> {
  const prepared = await prepareRequest(request)
  if (!prepared) {
    return []
  }
  return [...(prepared.active.diagnostics.get(prepared.uri)?.diagnostics ?? [])]
}

export async function searchPythonWorkspaceSymbols(
  query: string,
  token?: CancellationToken
): Promise<PythonWorkspaceSymbols> {
  if (token?.isCancellationRequested || !query.trim()) {
    return { results: [], partial: false }
  }
  const scopes = new Map(
    (useAppStore.getState().settings?.codeIntelligenceScopes ?? []).map((scope) => [
      scope.id,
      scope
    ])
  )
  // Fan out to ready sessions only (#13): unopened scopes spawn no process.
  const outcomes = await Promise.allSettled(
    service().activeClients().map(async ([scopeId, active]) => {
      if (!active.capabilities.workspaceSymbol) {
        return null
      }
      const scope = scopes.get(scopeId)
      const result = await sendChecked<(SymbolInformation | WorkspaceSymbol)[] | null>(
        scopeId,
        active,
        WorkspaceSymbolRequest.type,
        { query },
        token
      )
      return {
        scopeId,
        scopeName: scope?.name ?? scopeId,
        symbols: scope ? visibleWorkspaceSymbols(scope, result ?? []) : []
      }
    })
  )
  return {
    results: outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' && outcome.value ? [outcome.value] : []
    ),
    partial: outcomes.some((outcome) => outcome.status === 'rejected')
  }
}

/** Capability/quality state without opening a session. */
export function getPythonSessionState(
  request: PythonCodeIntelligenceRequest
): PythonSessionState {
  const scope = findCodeIntelligenceScope(request, 'python')
  if (!scope) {
    return { quality: 'text-search', capabilities: null }
  }
  const active = service().activeClient(scope.id)
  return {
    quality: active ? 'semantic' : 'text-search',
    capabilities: active?.capabilities ?? null
  }
}

const definitionCache = new Map<string, Promise<PythonDefinitionResult | null>>()
const hoverCache = new Map<string, Promise<Hover | null>>()
const referencesCache = new Map<string, Promise<Location[] | null>>()
const documentSymbolCache = new Map<
  string,
  Promise<DocumentSymbol[] | SymbolInformation[] | null>
>()

export function resolvePythonDefinition(
  request: PythonCodeIntelligenceRequest,
  token?: CancellationToken
): Promise<PythonDefinitionResult | null> {
  return cacheRequestCancellable(definitionCache, requestCacheKey(request, true), () => resolvePythonDefinitionUncached(request, token), token, 256)
}

export function getPythonHover(
  request: PythonCodeIntelligenceRequest,
  token?: CancellationToken
): Promise<Hover | null> {
  return cacheRequestCancellable(hoverCache, requestCacheKey(request, true), () => getPythonHoverUncached(request, token), token, 256)
}

export function getPythonReferences(
  request: PythonCodeIntelligenceRequest,
  token?: CancellationToken
): Promise<Location[] | null> {
  return cacheRequestCancellable(referencesCache, requestCacheKey(request, true), () => getPythonReferencesUncached(request, token), token, 256)
}

export function getPythonDocumentSymbols(
  request: PythonCodeIntelligenceRequest,
  token?: CancellationToken
): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
  return cacheRequestCancellable(documentSymbolCache, requestCacheKey(request, false), () => getPythonDocumentSymbolsUncached(request, token), token, 32)
}
