import {
  AbstractMessageReader,
  AbstractMessageWriter,
  createMessageConnection,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageConnection
} from 'vscode-jsonrpc/browser'
import {
  InitializeRequest,
  type InitializeParams,
  type InitializeResult
} from 'vscode-languageserver-protocol'
import { LanguageServerDocumentRegistry } from './language-server-document-registry'
import { LanguageServerDocumentSyncController } from './language-server-document-sync-controller'
import { isCodeIntelligenceResultVisible } from './code-intelligence-scope-membership'
import type { CodeIntelligenceScopeMember } from '../../../../shared/code-intelligence-scope'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  LanguageServerSessionLifecycle,
  type SessionRestartDecision
} from './language-server-session-lifecycle'
import type {
  LanguageServerKind,
  LanguageServerSessionEvent,
  LanguageServerSessionHandle,
  LanguageServerSessionOpenRequest
} from '../../../../shared/language-server-session'

const encoder = new TextEncoder(),
  decoder = new TextDecoder()
class ByteReader extends AbstractMessageReader {
  private buffer = new Uint8Array()
  private callback: DataCallback | null = null
  listen(callback: DataCallback): Disposable {
    this.callback = callback
    return {
      dispose: () => {
        this.callback = null
      }
    }
  }
  push(bytes: Uint8Array<ArrayBufferLike>): void {
    const next = new Uint8Array(this.buffer.length + bytes.byteLength)
    next.set(this.buffer)
    next.set(new Uint8Array(bytes), this.buffer.length)
    this.buffer = next
    this.drain()
  }
  close(): void {
    this.fireClose()
  }
  private drain(): void {
    for (;;) {
      const text = decoder.decode(this.buffer)
      const headerEnd = text.indexOf('\r\n\r\n')
      if (headerEnd === -1) {
        return
      }
      const match = /content-length:\s*(\d+)/i.exec(text.slice(0, headerEnd))
      if (!match) {
        this.fireError(new Error('Missing LSP Content-Length'))
        this.buffer = new Uint8Array()
        return
      }
      const bodyStart = encoder.encode(text.slice(0, headerEnd + 4)).byteLength,
        length = Number(match[1])
      if (this.buffer.byteLength < bodyStart + length) {
        return
      }
      const body = this.buffer.slice(bodyStart, bodyStart + length)
      this.buffer = this.buffer.slice(bodyStart + length)
      try {
        this.callback?.(JSON.parse(decoder.decode(body)) as Message)
      } catch (error) {
        this.fireError(error)
      }
    }
  }
}
class ByteWriter extends AbstractMessageWriter {
  constructor(private readonly handle: () => LanguageServerSessionHandle | null) {
    super()
  }
  async write(message: Message): Promise<void> {
    const body = encoder.encode(JSON.stringify(message)),
      header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`),
      bytes = new Uint8Array(header.length + body.length)
    bytes.set(header)
    bytes.set(body, header.length)
    this.handle()?.send(bytes)
  }
  end(): void {
    this.handle()?.close()
    this.fireClose()
  }
}

export type LanguageServerClientKey = {
  executionHostId: ExecutionHostId
  scopeId: string
  kind: LanguageServerKind
  revision: number
}

export class LanguageServerClientRegistry {
  private readonly lifecycles = new Map<string, LanguageServerSessionLifecycle>()
  private readonly clients = new Map<
    string,
    {
      generation: number
      requestGeneration: number
      connection: MessageConnection
      handle: LanguageServerSessionHandle
      sync: LanguageServerDocumentSyncController
      members: readonly CodeIntelligenceScopeMember[]
      workspaceRoot: string
    }
  >()
  private readonly unsubscribeScopeChanges: () => void
  constructor(
    private readonly api: NonNullable<Window['api']>['languageServers'],
    private readonly onRestartDecision?: (
      key: LanguageServerClientKey,
      decision: SessionRestartDecision
    ) => void,
    private readonly scopeAuthority: Pick<
      NonNullable<Window['api']>['codeIntelligence'],
      'authorizeSession' | 'onScopeChanged'
    > = window.api.codeIntelligence
  ) {
    this.unsubscribeScopeChanges = scopeAuthority.onScopeChanged((change) => {
      if (change.revision !== null) {
        this.restartScope(change.scopeId, change.revision)
      } else {
        this.closeScope(change.scopeId)
      }
    })
  }
  async open(
    key: LanguageServerClientKey,
    request: LanguageServerSessionOpenRequest
  ): Promise<{
    generation: number
    connection: MessageConnection
    initialize: (params: InitializeParams) => Promise<InitializeResult>
    sync: LanguageServerDocumentSyncController
  }> {
    const id = JSON.stringify(key)
    const lifecycle = this.lifecycles.get(id) ?? new LanguageServerSessionLifecycle()
    this.lifecycles.set(id, lifecycle)
    const generation = lifecycle.beginGeneration()
    this.close(key)
    const reader = new ByteReader()
    let handle: LanguageServerSessionHandle | null = null
    const launch = await this.scopeAuthority.authorizeSession(request)
    handle = await this.api.open(request, {
      onEvent: (event: LanguageServerSessionEvent) => {
        if (event.type === 'stdout') {
          reader.push(event.bytes)
        } else if (event.status.type === 'exit' || event.status.type === 'closed') {
          reader.close()
          if (lifecycle.isCurrent(generation) && event.status.type === 'exit') {
            this.onRestartDecision?.(key, lifecycle.recordCrash())
          }
        }
      }
    })
    const writer = new ByteWriter(() => handle),
      connection = createMessageConnection(reader, writer)
    connection.listen()
    const documents = new LanguageServerDocumentRegistry(connection)
    const sync = new LanguageServerDocumentSyncController(documents)
    this.clients.set(id, {
      generation,
      requestGeneration: 0,
      connection,
      handle,
      sync,
      members: launch.members,
      workspaceRoot: launch.workspaceRoot
    })
    return {
      generation,
      connection,
      sync,
      initialize: (params) => connection.sendRequest(InitializeRequest.type, params)
    }
  }
  isResultVisible(key: LanguageServerClientKey, relativePath: string): boolean {
    const current = this.clients.get(JSON.stringify(key))
    return current
      ? isCodeIntelligenceResultVisible(
          { workspaceRoot: current.workspaceRoot, members: current.members },
          relativePath
        )
      : false
  }
  restartScope(scopeId: string, revision: number): void {
    for (const [id, current] of this.clients) {
      const key = JSON.parse(id) as LanguageServerClientKey
      if (key.scopeId !== scopeId) {
        continue
      }
      current.sync.dispose()
      current.connection.dispose()
      current.handle.close()
      this.clients.delete(id)
      this.onRestartDecision?.({ ...key, revision }, { type: 'restart', delayMs: 0 })
    }
  }
  closeScope(scopeId: string): void {
    for (const id of this.clients.keys()) {
      const key = JSON.parse(id) as LanguageServerClientKey
      if (key.scopeId === scopeId) {
        this.close(key)
      }
    }
  }
  dispose(): void {
    this.unsubscribeScopeChanges()
    for (const id of this.clients.keys()) {
      this.close(JSON.parse(id) as LanguageServerClientKey)
    }
    for (const lifecycle of this.lifecycles.values()) {
      lifecycle.dispose()
    }
    this.lifecycles.clear()
  }
  nextRequestGeneration(key: LanguageServerClientKey): number {
    const current = this.clients.get(JSON.stringify(key))
    if (!current) {
      throw new Error('Language server client is not open')
    }
    current.requestGeneration += 1
    return current.requestGeneration
  }
  isCurrentRequest(
    key: LanguageServerClientKey,
    sessionGeneration: number,
    requestGeneration: number
  ): boolean {
    const current = this.clients.get(JSON.stringify(key))
    return (
      current?.generation === sessionGeneration && current.requestGeneration === requestGeneration
    )
  }
  scheduleIdle(key: LanguageServerClientKey, onIdle: () => void): void {
    this.lifecycles.get(JSON.stringify(key))?.scheduleIdle(onIdle)
  }
  markActive(key: LanguageServerClientKey): void {
    this.lifecycles.get(JSON.stringify(key))?.cancelIdle()
  }
  disposeKey(key: LanguageServerClientKey): void {
    this.close(key)
    const id = JSON.stringify(key)
    this.lifecycles.get(id)?.dispose()
    this.lifecycles.delete(id)
  }
  close(key: LanguageServerClientKey): void {
    const current = this.clients.get(JSON.stringify(key))
    if (!current) {
      return
    }
    current.sync.dispose()
    current.connection.dispose()
    current.handle.close()
    this.clients.delete(JSON.stringify(key))
  }
}
