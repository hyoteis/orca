import {
  ApplyWorkspaceEditRequest,
  InitializedNotification,
  MarkupKind,
  TokenFormat,
  type ApplyWorkspaceEditResult,
  type CancellationToken,
  type InitializeParams,
  type MessageConnection,
  type SemanticTokensLegend,
  type WorkspaceEdit
} from 'vscode-languageserver-protocol'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import {
  LanguageServerClientRegistry,
  type LanguageServerClientKey
} from './language-server-client-registry'
import { toServerFileUri } from './language-server-document-uri'
import {
  CPP_LANGUAGES,
  findCppCodeIntelligenceScope,
  type CodeIntelligenceDocumentRequest
} from './cpp-code-intelligence-workspace'
import {
  readSemanticServerCapabilities,
  semanticEditingClientCapabilities,
  workspaceEditClientCapabilities,
  type SemanticServerCapabilities
} from './semantic-editing-capabilities'
import {
  CPP_SEMANTIC_TOKEN_MODIFIERS,
  CPP_SEMANTIC_TOKEN_TYPES
} from './cpp-semantic-token-mapping'

export type CppCodeIntelligenceRequest = CodeIntelligenceDocumentRequest

type OpenClient = Awaited<ReturnType<LanguageServerClientRegistry['open']>>
export type CppActiveClient = {
  key: LanguageServerClientKey
  client: OpenClient
  semanticLegend: SemanticTokensLegend | null
  semanticCapabilities: SemanticServerCapabilities
}

const CLIENT_INSTANCE_ID = crypto.randomUUID()

/** One clangd session per C++ scope (#12 shared-session model): launch,
 * initialize, capability readout, and guarded applyEdit interception (#37). */
export class CppCodeIntelligenceSession {
  readonly registry = new LanguageServerClientRegistry(window.api.languageServers, (key) =>
    this.dropClient(key.scopeId)
  )
  private readonly clients = new Map<string, CppActiveClient>()
  private readonly opening = new Map<string, Promise<CppActiveClient>>()
  private readonly dropListeners = new Set<() => void>()
  private workspaceApplyEditHandler:
    | ((scope: CodeIntelligenceScope, edit: WorkspaceEdit) => Promise<ApplyWorkspaceEditResult>)
    | null = null

  private async resolveApplyEdit(
    scope: CodeIntelligenceScope,
    edit: WorkspaceEdit
  ): Promise<ApplyWorkspaceEditResult> {
    if (!this.workspaceApplyEditHandler) {
      return { applied: false, failureReason: 'guarded edits not available' }
    }
    return this.workspaceApplyEditHandler(scope, edit)
  }

  /** Cache owners subscribe: a dropped client's results must not be reused
   * (restart after re-run setup serves a regenerated compile database). */
  onClientDropped(listener: () => void): () => void {
    this.dropListeners.add(listener)
    return () => this.dropListeners.delete(listener)
  }

  private dropClient(scopeId: string): void {
    this.clients.delete(scopeId)
    for (const listener of this.dropListeners) {
      listener()
    }
  }

  setWorkspaceApplyEditHandler(
    handler:
      | ((scope: CodeIntelligenceScope, edit: WorkspaceEdit) => Promise<ApplyWorkspaceEditResult>)
      | null
  ): void {
    this.workspaceApplyEditHandler = handler
  }

  activeClient(scopeId: string): CppActiveClient | undefined {
    return this.clients.get(scopeId)
  }

  activeClients(): [string, CppActiveClient][] {
    return [...this.clients.entries()]
  }

  /** Stale rejection by identity: results from a dropped client are dead (#13). */
  isActive(scopeId: string, client: CppActiveClient): boolean {
    return this.clients.get(scopeId) === client
  }

  /** Manual restart (Configure dialog #149): drops the live client; caches
   * clear via onClientDropped and the next request reopens against the
   * rebuilt aggregate. False = no live client for the scope. */
  restartSession(scopeId: string, revision: number): boolean {
    if (!this.clients.has(scopeId)) {
      return false
    }
    this.registry.restartScope(scopeId, revision)
    return true
  }

  dispose(): void {
    this.registry.dispose()
    this.clients.clear()
  }

  /** Capability-gated typed request with document sync and stale rejection. */
  async semanticRequest<Result>(
    request: CppCodeIntelligenceRequest,
    type: { method: string },
    params: object,
    options: {
      capability?: keyof SemanticServerCapabilities
      satisfies?: (capabilities: SemanticServerCapabilities) => boolean
      token?: CancellationToken
    } = {}
  ): Promise<{ scope: CodeIntelligenceScope; active: CppActiveClient; result: Result } | null> {
    if (!CPP_LANGUAGES.has(request.language)) {
      return null
    }
    const scope = findCppCodeIntelligenceScope(request)
    if (!scope) {
      return null
    }
    const active = await this.ensureClient(scope)
    if (options.capability && !active.semanticCapabilities[options.capability]) {
      return null
    }
    // #20: per-request refinement of the coarse capability flag (e.g. the
    // server-declared executeCommand list) — inherited from the python stack.
    if (options.satisfies && !options.satisfies(active.semanticCapabilities)) {
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
    const sendRequest = active.client.connection.sendRequest as unknown as (
      type: unknown,
      params: object,
      token?: CancellationToken
    ) => Promise<Result>
    const result = await sendRequest(type, params, options.token)
    if (options.token?.isCancellationRequested || !this.isActive(scope.id, active)) {
      return null
    }
    return { scope, active, result }
  }

  async ensureClient(scope: CodeIntelligenceScope): Promise<CppActiveClient> {
    const current = this.clients.get(scope.id)
    if (current) {
      // Member-only edits keep the clangd session alive (spec §5): the running
      // process picks up the atomically rewritten CDB lazily. Only a launch
      // change restarts, and that arrives via the registry's restart broadcast.
      return current
    }
    // Single-flight: outline and decorations query the same tick; a second
    // open of the live sessionId is rejected by the Host as a duplicate.
    const inFlight = this.opening.get(scope.id)
    if (inFlight) {
      return inFlight
    }
    const opening = this.openClient(scope).finally(() => this.opening.delete(scope.id))
    this.opening.set(scope.id, opening)
    return opening
  }

  private async openClient(scope: CodeIntelligenceScope): Promise<CppActiveClient> {
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
    this.installServerRequestHandlers(client.connection, scope)
    const rootUri = toServerFileUri(scope.workspaceRoot)
    const params: InitializeParams = {
      processId: null,
      clientInfo: { name: 'Orca', version: '1' },
      rootUri,
      capabilities: {
        workspace: {
          configuration: false,
          workspaceFolders: true,
          ...workspaceEditClientCapabilities()
        },
        textDocument: {
          definition: { linkSupport: true },
          // Flat SymbolInformation names arrive ::-qualified, which flattens the
          // outline; hierarchical keeps classes as tree nodes (as the Python session does).
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          hover: { contentFormat: [MarkupKind.Markdown, MarkupKind.PlainText] },
          ...semanticEditingClientCapabilities(),
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
    const active: CppActiveClient = {
      key,
      client,
      semanticLegend:
        semanticProvider && typeof semanticProvider === 'object' && 'legend' in semanticProvider
          ? semanticProvider.legend
          : null,
      semanticCapabilities: readSemanticServerCapabilities(initialized.capabilities)
    }
    this.clients.set(scope.id, active)
    return active
  }

  private installServerRequestHandlers(
    connection: Pick<MessageConnection, 'onRequest'>,
    scope: CodeIntelligenceScope
  ): void {
    connection.onRequest('workspace/configuration', () => [])
    connection.onRequest('client/registerCapability', () => null)
    connection.onRequest('window/workDoneProgress/create', () => null)
    connection.onRequest(ApplyWorkspaceEditRequest.type, (params) =>
      this.resolveApplyEdit(scope, params.edit)
    )
  }
}

let sessionSingleton: CppCodeIntelligenceSession | null = null

/** Shared clangd session singleton; provider layers install handlers here. */
export function getCppSession(): CppCodeIntelligenceSession {
  sessionSingleton ??= new CppCodeIntelligenceSession()
  return sessionSingleton
}

export function resetCppCodeIntelligenceSession(): void {
  sessionSingleton?.dispose()
  sessionSingleton = null
}
