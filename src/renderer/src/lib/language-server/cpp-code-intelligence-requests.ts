import {
  DefinitionRequest,
  DocumentSymbolRequest,
  HoverRequest,
  SemanticTokensRequest,
  WorkspaceSymbolRequest,
  type CancellationToken,
  type DocumentSymbol,
  type Hover,
  type SymbolInformation
} from 'vscode-languageserver-protocol'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import { useAppStore } from '@/store'
import { toServerFileUri } from './language-server-document-uri'
import { cacheRequest, cacheRequestCancellable, requestCacheKey } from './navigation-request-cache'
import { definitionTargets, type CppDefinitionTarget } from './cpp-definition-locations'
import {
  fileUriToHostPath,
  findCppCodeIntelligenceScope,
  CPP_LANGUAGES,
  openCppDefinitionTargetInWorkspace,
  relativeToRoot,
  visibleWorkspaceSymbols,
  type WorkspaceSymbolFanout
} from './cpp-code-intelligence-workspace'
import { remapCppSemanticTokenData } from './cpp-semantic-token-mapping'
import {
  getCppSession,
  resetCppCodeIntelligenceSession,
  type CppActiveClient,
  type CppCodeIntelligenceRequest
} from './cpp-code-intelligence-session'

export type { CppCodeIntelligenceRequest }
export type { CppActiveClient } from './cpp-code-intelligence-session'
export { CPP_LANGUAGES } from './cpp-code-intelligence-workspace'

/** Drops sessions and caches; used by tests and hot reloads. */
export function resetCppCodeIntelligence(): void {
  // Why null the service: it captures the session singleton at construction.
  codeIntelligence = null
  resetCppCodeIntelligenceSession()
  definitionCache.clear()
  hoverCache.clear()
  semanticTokenCache.clear()
  documentSymbolCache.clear()
}

let codeIntelligence: CppCodeIntelligence | null = null

function service(): CppCodeIntelligence {
  codeIntelligence ??= new CppCodeIntelligence()
  return codeIntelligence
}

class CppCodeIntelligence {
  private readonly session = getCppSession()

  constructor() {
    // A dropped/restarted client invalidates the caches' answers (e.g. re-run
    // C++ setup regenerated the compile database the answers came from).
    this.session.onClientDropped(() => {
      definitionCache.clear()
      hoverCache.clear()
      semanticTokenCache.clear()
      documentSymbolCache.clear()
    })
  }

  /** Decorations subscribe here to re-pull after a client drop/restart. */
  onClientDropped(listener: () => void): () => void {
    return this.session.onClientDropped(listener)
  }

  async resolveDefinition(
    request: CppCodeIntelligenceRequest
  ): Promise<CppDefinitionTarget | null> {
    const prepared = await this.prepareRequest(request)
    if (!prepared) {
      return null
    }
    const { scope, active, uri } = prepared
    const requestGeneration = this.session.registry.nextRequestGeneration(active.key)
    const definition = await active.client.connection.sendRequest(DefinitionRequest.type, {
      textDocument: { uri },
      position: { line: request.lineNumber - 1, character: request.column - 1 }
    })
    if (
      !this.session.registry.isCurrentRequest(
        active.key,
        active.client.generation,
        requestGeneration
      )
    ) {
      return null
    }
    return (
      definitionTargets(definition).find((candidate) => {
        const path = fileUriToHostPath(candidate.uri, scope.executionHostId)
        return path ? relativeToRoot(path, scope.workspaceRoot) !== null : false
      }) ?? null
    )
  }

  async hover(request: CppCodeIntelligenceRequest): Promise<Hover | null> {
    const prepared = await this.prepareRequest(request)
    if (!prepared) {
      return null
    }
    const { scope, active, uri } = prepared
    const result = await active.client.connection.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position: { line: request.lineNumber - 1, character: request.column - 1 }
    })
    return this.session.isActive(scope.id, active) ? result : null
  }

  /** #100 Outline: either documentSymbol result shape passes through raw. */
  async documentSymbols(
    request: CppCodeIntelligenceRequest,
    token?: CancellationToken
  ): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    const prepared = await this.prepareRequest(request)
    if (!prepared || token?.isCancellationRequested) {
      return null
    }
    const { scope, active, uri } = prepared
    const result = await active.client.connection.sendRequest(
      DocumentSymbolRequest.type,
      { textDocument: { uri } },
      token
    )
    return !token?.isCancellationRequested && this.session.isActive(scope.id, active)
      ? result
      : null
  }

  async semanticTokens(request: CppCodeIntelligenceRequest): Promise<Uint32Array | null> {
    const prepared = await this.prepareRequest(request)
    const semanticLegend = prepared?.active.semanticLegend
    if (!prepared || !semanticLegend) {
      return null
    }
    const { active, uri } = prepared
    const result = await active.client.connection.sendRequest(SemanticTokensRequest.type, {
      textDocument: { uri }
    })
    if (!result || !this.session.isActive(prepared.scope.id, active)) {
      return null
    }
    return remapCppSemanticTokenData(result.data, semanticLegend)
  }

  /** #32 Command center fan-out over already-open clangd sessions (#13: no spawn). */
  async searchWorkspaceSymbols(
    query: string,
    token?: CancellationToken
  ): Promise<WorkspaceSymbolFanout> {
    if (token?.isCancellationRequested || !query.trim()) {
      return { results: [], partial: false }
    }
    const scopes = new Map(
      (useAppStore.getState().settings?.codeIntelligenceScopes ?? []).map((scope) => [
        scope.id,
        scope
      ])
    )
    const outcomes = await Promise.allSettled(
      this.session.activeClients().map(async ([scopeId, active]) => {
        const requestGeneration = this.session.registry.nextRequestGeneration(active.key)
        const result = await active.client.connection.sendRequest(
          WorkspaceSymbolRequest.type,
          { query },
          token
        )
        if (
          token?.isCancellationRequested ||
          !this.session.registry.isCurrentRequest(
            active.key,
            active.client.generation,
            requestGeneration
          )
        ) {
          return null
        }
        const scope = scopes.get(scopeId)
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

  private async prepareRequest(request: CppCodeIntelligenceRequest): Promise<{
    scope: CodeIntelligenceScope
    active: CppActiveClient
    uri: string
  } | null> {
    if (!CPP_LANGUAGES.has(request.language)) {
      return null
    }
    const scope = findCppCodeIntelligenceScope(request)
    if (!scope) {
      return null
    }
    const active = await this.session.ensureClient(scope)
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
    return { scope, active, uri }
  }
}

const definitionCache = new Map<string, Promise<CppDefinitionTarget | null>>()
const hoverCache = new Map<string, Promise<Hover | null>>()
const semanticTokenCache = new Map<string, Promise<Uint32Array | null>>()
const documentSymbolCache = new Map<
  string,
  Promise<DocumentSymbol[] | SymbolInformation[] | null>
>()

export function resolveCppDefinition(
  request: CppCodeIntelligenceRequest
): Promise<CppDefinitionTarget | null> {
  return cacheRequest(
    definitionCache,
    requestCacheKey(request, true),
    () => service().resolveDefinition(request),
    256
  )
}

export function getCppHover(request: CppCodeIntelligenceRequest): Promise<Hover | null> {
  return cacheRequest(
    hoverCache,
    requestCacheKey(request, true),
    () => service().hover(request),
    256
  )
}

export function getCppSemanticTokens(
  request: CppCodeIntelligenceRequest
): Promise<Uint32Array | null> {
  return cacheRequest(
    semanticTokenCache,
    requestCacheKey(request, false),
    () => service().semanticTokens(request),
    32
  )
}

/** Decorations re-pull after the client drops/restarts (e.g. re-run setup). */
export function subscribeCppClientDropped(listener: () => void): () => void {
  return service().onClientDropped(listener)
}

/** #149: manual restart from the Configure dialog; cache invalidation rides
 * the session's drop listeners. */
export function restartCppSession(scopeId: string, revision: number): boolean {
  return getCppSession().restartSession(scopeId, revision)
}

export function getCppDocumentSymbols(
  request: CppCodeIntelligenceRequest,
  token?: CancellationToken
): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
  return cacheRequestCancellable(
    documentSymbolCache,
    requestCacheKey(request, false),
    () => service().documentSymbols(request, token),
    token,
    32
  )
}

export function openCppDefinitionTarget(
  request: CppCodeIntelligenceRequest,
  target: CppDefinitionTarget
): boolean {
  return openCppDefinitionTargetInWorkspace(request, target)
}

export function searchCppWorkspaceSymbols(
  query: string,
  token?: CancellationToken
): Promise<WorkspaceSymbolFanout> {
  return service().searchWorkspaceSymbols(query, token)
}
