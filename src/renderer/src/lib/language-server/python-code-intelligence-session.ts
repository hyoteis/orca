import {
  InitializedNotification,
  MarkupKind,
  PublishDiagnosticsNotification,
  type Diagnostic,
  type InitializeParams,
  type SymbolInformation,
  type WorkspaceSymbol
} from 'vscode-languageserver-protocol'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import {
  LanguageServerClientRegistry,
  type LanguageServerClientKey
} from './language-server-client-registry'
import { toServerFileUri } from './language-server-document-uri'
import type { CodeIntelligenceDocumentRequest } from './code-intelligence-workspace'

// Kept here (jsonrpc import chain) like CPP_LANGUAGES' counterpart split: UI
// gating modules should not need this file.
export const PYTHON_LANGUAGES = new Set(['python'])

export type PythonCodeIntelligenceRequest = CodeIntelligenceDocumentRequest

export type PythonCapabilities = {
  definition: boolean
  hover: boolean
  references: boolean
  documentSymbol: boolean
  workspaceSymbol: boolean
}

export type PythonDefinitionResult = {
  target: { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }
  external: boolean
}

export type PythonSessionState = {
  quality: 'semantic' | 'text-search'
  capabilities: PythonCapabilities | null
}

export type PythonWorkspaceSymbols = {
  results: {
    scopeId: string
    scopeName: string
    symbols: (SymbolInformation | WorkspaceSymbol)[]
  }[]
  partial: boolean
}

type OpenClient = Awaited<ReturnType<LanguageServerClientRegistry['open']>>
export type PythonActiveClient = {
  key: LanguageServerClientKey
  client: OpenClient
  capabilities: PythonCapabilities
  /** Lives on the client so a restart drops pre-restart diagnostics with it. */
  diagnostics: Map<string, { diagnostics: Diagnostic[]; version?: number }>
}

const CLIENT_INSTANCE_ID = crypto.randomUUID()

const diagnosticsListeners = new Set<(uri: string) => void>()

/** Live diagnostics push for marker surfaces; not cached. */
export function subscribePythonDiagnostics(listener: (uri: string) => void): () => void {
  diagnosticsListeners.add(listener)
  return () => {
    diagnosticsListeners.delete(listener)
  }
}

/** One basedpyright session per python scope; capability and diagnostics state. */
export class PythonCodeIntelligenceSession {
  readonly registry = new LanguageServerClientRegistry(window.api.languageServers, (key) =>
    this.dropClient(key.scopeId)
  )
  private readonly clients = new Map<string, PythonActiveClient>()

  activeClient(scopeId: string): PythonActiveClient | undefined {
    return this.clients.get(scopeId)
  }

  /** Stale rejection by identity: results from a dropped/replaced client are dead. */
  isActive(scopeId: string, client: PythonActiveClient): boolean {
    return this.clients.get(scopeId) === client
  }

  activeClients(): [string, PythonActiveClient][] {
    return [...this.clients.entries()]
  }

  private dropClient(scopeId: string): void {
    const dropped = this.clients.get(scopeId)
    this.clients.delete(scopeId)
    if (!dropped) {
      return
    }
    // Disconnect clears authoritative diagnostics (#13): notify each affected
    // uri so marker surfaces re-pull (and find the client gone).
    for (const uri of dropped.diagnostics.keys()) {
      for (const listener of diagnosticsListeners) {
        listener(uri)
      }
    }
  }

  async ensureClient(scope: CodeIntelligenceScope): Promise<PythonActiveClient> {
    const current = this.clients.get(scope.id)
    if (current) {
      this.registry.markActive(current.key)
      return current
    }
    const key: LanguageServerClientKey = {
      executionHostId: scope.executionHostId,
      scopeId: scope.id,
      kind: 'basedpyright',
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
    const active: PythonActiveClient = {
      key,
      client,
      capabilities: {
        definition: false,
        hover: false,
        references: false,
        documentSymbol: false,
        workspaceSymbol: false
      },
      diagnostics: new Map()
    }
    client.connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
      const prior = active.diagnostics.get(params.uri)
      // Superseded diagnostic versions drop; empties clear.
      if (
        prior?.version !== undefined &&
        params.version !== undefined &&
        params.version < prior.version
      ) {
        return
      }
      active.diagnostics.set(params.uri, {
        diagnostics: params.diagnostics ?? [],
        version: params.version
      })
      for (const listener of diagnosticsListeners) {
        listener(params.uri)
      }
    })
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
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          synchronization: {}
        }
      },
      workspaceFolders: [{ uri: rootUri, name: scope.name }]
    }
    const initialized = await client.initialize(params)
    client.connection.sendNotification(InitializedNotification.type, {})
    const capabilities = initialized.capabilities
    active.capabilities = {
      definition: Boolean(capabilities.definitionProvider),
      hover: Boolean(capabilities.hoverProvider),
      references: Boolean(capabilities.referencesProvider),
      documentSymbol: Boolean(capabilities.documentSymbolProvider),
      workspaceSymbol: Boolean(capabilities.workspaceSymbolProvider)
    }
    this.clients.set(scope.id, active)
    return active
  }

  dispose(): void {
    this.registry.dispose()
    this.clients.clear()
  }
}
