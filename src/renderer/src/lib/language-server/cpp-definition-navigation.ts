import {
  DefinitionRequest,
  HoverRequest,
  InitializedNotification,
  MarkupKind,
  SemanticTokensRequest,
  TokenFormat,
  type Hover,
  type InitializeParams,
  type SemanticTokensLegend
} from 'vscode-languageserver-protocol'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import {
  LanguageServerClientRegistry,
  type LanguageServerClientKey
} from './language-server-client-registry'
import { toServerFileUri } from './language-server-document-uri'
import { definitionTargets, type CppDefinitionTarget } from './cpp-definition-locations'
import {
  fileUriToHostPath,
  findCppCodeIntelligenceScope,
  openCppDefinitionTargetInWorkspace,
  relativeToRoot
} from './cpp-code-intelligence-workspace'
import {
  CPP_SEMANTIC_TOKEN_MODIFIERS,
  CPP_SEMANTIC_TOKEN_TYPES,
  remapCppSemanticTokenData
} from './cpp-semantic-token-mapping'

export type CppCodeIntelligenceRequest = {
  fileId: string
  filePath: string
  relativePath: string
  worktreeId: string
  language: string
  text: string
  documentVersion: number
  lineNumber: number
  column: number
}

type OpenClient = Awaited<ReturnType<LanguageServerClientRegistry['open']>>
type ActiveClient = {
  key: LanguageServerClientKey
  client: OpenClient
  semanticLegend: SemanticTokensLegend | null
}

const CPP_LANGUAGES = new Set(['c', 'cpp', 'objective-c', 'objective-cpp'])
const CLIENT_INSTANCE_ID = crypto.randomUUID()

class CppCodeIntelligence {
  private readonly registry = new LanguageServerClientRegistry(window.api.languageServers, (key) =>
    this.clients.delete(key.scopeId)
  )
  private readonly clients = new Map<string, ActiveClient>()

  async resolveDefinition(
    request: CppCodeIntelligenceRequest
  ): Promise<CppDefinitionTarget | null> {
    const prepared = await this.prepareRequest(request)
    if (!prepared) {
      return null
    }
    const { scope, active, uri } = prepared
    const requestGeneration = this.registry.nextRequestGeneration(active.key)
    const definition = await active.client.connection.sendRequest(DefinitionRequest.type, {
      textDocument: { uri },
      position: { line: request.lineNumber - 1, character: request.column - 1 }
    })
    if (!this.registry.isCurrentRequest(active.key, active.client.generation, requestGeneration)) {
      return null
    }
    return (
      definitionTargets(definition).find((candidate) => {
        const path = fileUriToHostPath(candidate.uri, scope.executionHostId)
        const relativePath = path ? relativeToRoot(path, scope.workspaceRoot) : null
        // Definitions in sibling modules are part of the same workspace even when the visible indexing scope is narrower.
        return relativePath !== null
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
    return this.clients.get(scope.id) === active ? result : null
  }

  async semanticTokens(request: CppCodeIntelligenceRequest): Promise<Uint32Array | null> {
    const prepared = await this.prepareRequest(request)
    const semanticLegend = prepared?.active.semanticLegend
    if (!prepared || !semanticLegend) {
      return null
    }
    const { scope, active, uri } = prepared
    const result = await active.client.connection.sendRequest(SemanticTokensRequest.type, {
      textDocument: { uri }
    })
    if (!result || this.clients.get(scope.id) !== active) {
      return null
    }
    return remapCppSemanticTokenData(result.data, semanticLegend)
  }

  private async prepareRequest(request: CppCodeIntelligenceRequest): Promise<{
    scope: CodeIntelligenceScope
    active: ActiveClient
    uri: string
  } | null> {
    if (!CPP_LANGUAGES.has(request.language)) {
      return null
    }
    const scope = findCppCodeIntelligenceScope(request)
    if (!scope) {
      return null
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
    return { scope, active, uri }
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
      sessionId: `definition:${scope.id}:${scope.revision}:${CLIENT_INSTANCE_ID}`,
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
        textDocument: {
          definition: { linkSupport: true },
          hover: { contentFormat: [MarkupKind.Markdown, MarkupKind.PlainText] },
          semanticTokens: {
            dynamicRegistration: false,
            requests: { range: false, full: true },
            tokenTypes: [...CPP_SEMANTIC_TOKEN_TYPES],
            tokenModifiers: [...CPP_SEMANTIC_TOKEN_MODIFIERS],
            formats: [TokenFormat.Relative],
            overlappingTokenSupport: false,
            multilineTokenSupport: false
          },
          synchronization: {}
        }
      },
      workspaceFolders: [{ uri: rootUri, name: scope.name }]
    }
    const initialized = await client.initialize(params)
    client.connection.sendNotification(InitializedNotification.type, {})
    const semanticProvider = initialized.capabilities.semanticTokensProvider
    const active: ActiveClient = {
      key,
      client,
      semanticLegend:
        semanticProvider && typeof semanticProvider === 'object' && 'legend' in semanticProvider
          ? semanticProvider.legend
          : null
    }
    this.clients.set(scope.id, active)
    return active
  }
}

const definitionCache = new Map<string, Promise<CppDefinitionTarget | null>>()
const hoverCache = new Map<string, Promise<Hover | null>>()
const semanticTokenCache = new Map<string, Promise<Uint32Array | null>>()

function cacheRequest<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
  limit: number
): Promise<T> {
  const cached = cache.get(key)
  if (cached) {
    return cached
  }
  const request = load().catch((error) => {
    if (cache.get(key) === request) {
      cache.delete(key)
    }
    throw error
  })
  cache.set(key, request)
  while (cache.size > limit) {
    const oldest = cache.keys().next().value
    if (oldest) {
      cache.delete(oldest)
    } else {
      break
    }
  }
  return request
}

function requestCacheKey(request: CppCodeIntelligenceRequest, position: boolean): string {
  const base = `${request.worktreeId}:${request.filePath}:${request.documentVersion}`
  return position ? `${base}:${request.lineNumber}:${request.column}` : base
}

let codeIntelligence: CppCodeIntelligence | null = null

function service(): CppCodeIntelligence {
  codeIntelligence ??= new CppCodeIntelligence()
  return codeIntelligence
}

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
