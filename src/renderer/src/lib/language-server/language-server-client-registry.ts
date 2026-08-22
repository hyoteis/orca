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
import type {
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

export type LanguageServerClientKey = { executionHostId: string; scopeId: string; kind: string }

export class LanguageServerClientRegistry {
  private readonly clients = new Map<
    string,
    {
      generation: number
      requestGeneration: number
      connection: MessageConnection
      handle: LanguageServerSessionHandle
    }
  >()
  constructor(private readonly api: NonNullable<Window['api']>['languageServers']) {}
  async open(
    key: LanguageServerClientKey,
    request: LanguageServerSessionOpenRequest
  ): Promise<{
    generation: number
    connection: MessageConnection
    initialize: (params: InitializeParams) => Promise<InitializeResult>
  }> {
    const id = JSON.stringify(key),
      generation = (this.clients.get(id)?.generation ?? 0) + 1
    this.close(key)
    const reader = new ByteReader()
    let handle: LanguageServerSessionHandle | null = null
    handle = await this.api.open(request, {
      onEvent: (event: LanguageServerSessionEvent) => {
        if (event.type === 'stdout') {
          reader.push(event.bytes)
        } else if (event.status.type === 'exit' || event.status.type === 'closed') {
          reader.close()
        }
      }
    })
    const writer = new ByteWriter(() => handle),
      connection = createMessageConnection(reader, writer)
    connection.listen()
    this.clients.set(id, { generation, requestGeneration: 0, connection, handle })
    return {
      generation,
      connection,
      initialize: (params) => connection.sendRequest(InitializeRequest.type, params)
    }
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
  close(key: LanguageServerClientKey): void {
    const current = this.clients.get(JSON.stringify(key))
    if (!current) {
      return
    }
    current.connection.dispose()
    current.handle.close()
    this.clients.delete(JSON.stringify(key))
  }
}
