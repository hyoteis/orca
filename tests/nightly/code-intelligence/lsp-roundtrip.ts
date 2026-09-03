import { spawn, type ChildProcess } from 'node:child_process'
import { performance } from 'node:perf_hooks'

type LspCommand = { executable: string; args: readonly string[]; cwd?: string }

type PendingRequest = {
  id: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  cancelledAt?: number
}

export type CancelledRequestError = Error & { code: number; roundTripMs: number }

export type RequestHandle<T = unknown> = Promise<T> & { id: number }

/** Resolve a language-server binary: env override wins, else the bare name (PATH). */
export function resolveNightlyServerCommand(name: string, env: NodeJS.ProcessEnv): string {
  return env[`ORCA_NIGHTLY_${name.toUpperCase().replace(/-/g, '_')}`] ?? name
}

/** Content-Length framed JSON-RPC client over a server's stdio — just enough
 * for nightly budget measurements; the production registry owns real sessions. */
export class NightlyLspClient {
  private process: ChildProcess
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private disposed = false
  private stderrTail: string[] = []

  constructor(command: LspCommand, env: NodeJS.ProcessEnv = process.env) {
    this.process = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      env: { ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.process.stdout!.on('data', (chunk: Buffer) => this.receive(chunk))
    this.process.stderr!.on('data', (chunk: Buffer) => {
      this.stderrTail = [...this.stderrTail, chunk.toString('utf8')].slice(-5)
    })
    this.process.once('exit', (code) => {
      for (const entry of this.pending.values()) {
        entry.reject(new Error(`language server exited (code ${code})`))
      }
      this.pending.clear()
    })
    this.process.once('error', (error) => {
      for (const entry of this.pending.values()) {
        entry.reject(error instanceof Error ? error : new Error(String(error)))
      }
      this.pending.clear()
    })
  }

  get pendingRequestCount(): number {
    return this.pending.size
  }

  private send(message: unknown): void {
    const body = JSON.stringify(message)
    this.process.stdin!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    let frame = this.takeFrame()
    while (frame !== null) {
      this.handleFrame(frame)
      frame = this.takeFrame()
    }
  }

  private takeFrame(): Record<string, unknown> | null {
    const headerEnd = this.buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) {
      return null
    }
    const match = /^Content-Length: (\d+)$/.exec(
      this.buffer.subarray(0, headerEnd).toString('utf8')
    )
    if (!match) {
      throw new Error(`language server sent an unframed message: ${this.stderrTail.join('')}`)
    }
    const totalLength = headerEnd + 4 + Number(match[1])
    if (this.buffer.length < totalLength) {
      return null
    }
    const frame = JSON.parse(this.buffer.subarray(headerEnd + 4, totalLength).toString('utf8'))
    this.buffer = this.buffer.subarray(totalLength)
    return frame
  }

  private handleFrame(frame: Record<string, unknown>): void {
    if (frame.id === undefined || frame.method !== undefined) {
      return // Server-initiated messages carry no budget signal; ignore.
    }
    const entry = this.pending.get(frame.id as number)
    if (!entry) {
      return
    }
    this.pending.delete(frame.id as number)
    if (frame.error !== undefined) {
      const error = frame.error as { code?: number; message?: string }
      const rejected = new Error(error.message ?? 'language server error') as CancelledRequestError
      rejected.code = error.code ?? -1
      if (entry.cancelledAt !== undefined) {
        rejected.roundTripMs = performance.now() - entry.cancelledAt
      }
      entry.reject(rejected)
      return
    }
    entry.resolve(frame.result)
  }

  request<T = unknown>(method: string, params?: unknown): RequestHandle<T> {
    if (this.disposed) {
      throw new Error('client already disposed')
    }
    const id = this.nextId++
    const handle = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { id, resolve, reject })
    }) as RequestHandle<T>
    handle.id = id
    this.send({ jsonrpc: '2.0', id, method, params })
    return handle
  }

  notification(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** $/cancelRequest; the rejected promise carries cancel→response roundTripMs. */
  cancel(id: number): void {
    const entry = this.pending.get(id)
    if (entry) {
      entry.cancelledAt = performance.now()
    }
    this.notification('$/cancelRequest', { id })
  }

  async initialize(rootUri: string): Promise<Record<string, unknown>> {
    const result = (await this.request('initialize', {
      processId: null,
      rootUri,
      capabilities: {
        textDocument: { hover: { contentFormat: ['plaintext'] } },
        workspaceSymbol: {}
      }
    })) as Record<string, unknown>
    this.notification('initialized', {})
    return result
  }

  /** Kill the process; resolves with milliseconds until exit. */
  dispose(): Promise<number> {
    if (this.disposed) {
      return Promise.resolve(0)
    }
    this.disposed = true
    const startedAt = performance.now()
    return new Promise((resolveDone) => {
      this.process.once('exit', () => resolveDone(performance.now() - startedAt))
      this.process.kill()
      // A server that ignores SIGTERM still must not outlive the harness.
      setTimeout(() => this.process.kill('SIGKILL'), 3_000).unref()
    })
  }
}
