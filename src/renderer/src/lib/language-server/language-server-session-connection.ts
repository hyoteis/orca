import {
  AbstractMessageReader,
  AbstractMessageWriter,
  createMessageConnection,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageConnection
} from 'vscode-jsonrpc/browser'

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

class TransportWriter extends AbstractMessageWriter {
  constructor(
    private readonly transport: {
      send: (bytes: Uint8Array<ArrayBufferLike>) => void
      close: () => void
    }
  ) {
    super()
  }
  async write(message: Message): Promise<void> {
    const body = encoder.encode(JSON.stringify(message)),
      header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`),
      bytes = new Uint8Array(header.length + body.length)
    bytes.set(header)
    bytes.set(body, header.length)
    this.transport.send(bytes)
  }
  end(): void {
    this.transport.close()
    this.fireClose()
  }
}

/** Loaded via dynamic import by the client registry so node-environment tests
 * can import the registry without vscode-jsonrpc/browser (no node export). */
export function createSessionConnection(transport: {
  send: (bytes: Uint8Array<ArrayBufferLike>) => void
  close: () => void
}): { reader: ByteReader; connection: MessageConnection } {
  const reader = new ByteReader(),
    connection = createMessageConnection(reader, new TransportWriter(transport))
  connection.listen()
  return { reader, connection }
}
