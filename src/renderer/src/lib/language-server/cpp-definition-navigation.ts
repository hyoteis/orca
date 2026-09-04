import {
  DefinitionRequest,
  HoverRequest,
  SemanticTokensRequest,
  WorkspaceSymbolRequest,
  type CancellationToken,
  type Hover
} from 'vscode-languageserver-protocol'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import { useAppStore } from '@/store'
import { toServerFileUri } from './language-server-document-uri'
import { cacheRequest, requestCacheKey } from './navigation-request-cache'
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
  resetCppCodeIntelligenceSession()
  definitionCache.clear()
  hoverCache.clear()
  semanticTokenCache.clear()
}

let codeIntelligence: CppCodeIntelligence | null = null

function service(): CppCodeIntelligence {
  codeIntelligence ??= new CppCodeIntelligence()
  return codeIntelligence
}

class CppCodeIntelligence {
  private readonly session = getCppSession()

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
