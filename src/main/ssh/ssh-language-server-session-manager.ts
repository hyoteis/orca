import type { EventEmitter } from 'node:events'
import type {
  LanguageServerLaunchRequest,
  LanguageServerSessionEvent
} from '../../shared/language-server-session'
import {
  acceptsLanguageServerInput,
  retainLanguageServerStderr
} from '../language-server/language-server-session-io-policy'
import type { SshConnection } from './ssh-connection'

export type SshLanguageServerCommand = { executable: string; args: readonly string[]; cwd: string }
type Channel = EventEmitter & {
  stderr: EventEmitter
  writableLength?: number
  write: (bytes: Buffer) => boolean
  end: () => void
  close: () => void
}
type Session = { channel: Channel; stderrBytes: number; hardCloseTimer?: NodeJS.Timeout }
const quotePosix = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`
const quotePowerShell = (value: string): string => `'${value.replace(/'/g, "''")}'`
export function buildPosixLanguageServerCommand(command: SshLanguageServerCommand): string {
  return `cd ${quotePosix(command.cwd)} && exec ${[command.executable, ...command.args].map(quotePosix).join(' ')}`
}
export function buildWindowsLanguageServerCommand(command: SshLanguageServerCommand): string {
  const invocation = [command.executable, ...command.args].map(quotePowerShell).join(' ')
  const script = `Set-Location -LiteralPath ${quotePowerShell(command.cwd)}; & ${invocation}`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`
}

/** Standard LSP shutdown frames (#182): a well-behaved server exits itself on
 * `exit`, which also takes wrapper shells down with it — the only reliable
 * tree cleanup on Windows OpenSSH hosts, where a channel close alone does not
 * reach a PowerShell-wrapped clangd. */
const SHUTDOWN_EXIT_FRAMES = (() => {
  const shutdown = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'shutdown' })
  const exit = JSON.stringify({ jsonrpc: '2.0', method: 'exit' })
  return `Content-Length: ${Buffer.byteLength(shutdown)}\r\n\r\n${shutdown}Content-Length: ${Buffer.byteLength(exit)}\r\n\r\n${exit}`
})()

const HARD_CLOSE_TIMEOUT_MS = 2_000
export class SshLanguageServerSessionManager {
  private readonly sessions = new Map<string, Session>()
  constructor(
    private readonly emit: (sessionId: string, event: LanguageServerSessionEvent) => void,
    private readonly resolveCommand: (
      request: LanguageServerLaunchRequest
    ) => SshLanguageServerCommand,
    private readonly buildCommand = buildPosixLanguageServerCommand,
    private readonly options: {
      maxPendingInputBytes?: number
      maxStderrBytes?: number
      hardCloseTimeoutMs?: number
    } = {}
  ) {}
  async open(
    connection: SshConnection,
    request: LanguageServerLaunchRequest,
    buildCommand: (command: SshLanguageServerCommand) => string = this.buildCommand
  ): Promise<void> {
    if (this.sessions.has(request.sessionId)) {
      throw new Error(`Language server session already exists: ${request.sessionId}`)
    }
    this.emit(request.sessionId, { type: 'status', status: { type: 'starting' } })
    const channel = (await connection.exec(
      buildCommand(this.resolveCommand(request))
    )) as unknown as Channel
    const session: Session = { channel, stderrBytes: 0 }
    this.sessions.set(request.sessionId, session)
    this.emit(request.sessionId, { type: 'status', status: { type: 'ready', pid: 0 } })
    channel.on('data', (chunk: Buffer) =>
      this.emit(request.sessionId, { type: 'stdout', bytes: new Uint8Array(chunk) })
    )
    channel.stderr.on('data', (chunk: Buffer) => this.stderr(request.sessionId, session, chunk))
    channel.once('error', (error: Error) =>
      this.emit(request.sessionId, {
        type: 'status',
        status: { type: 'error', message: error.message }
      })
    )
    // Natural exit (#182): surface the remote exit status, then the close
    // handler finishes the lifecycle exactly as before.
    channel.once('exit', (code: number | null) => {
      if (this.sessions.get(request.sessionId) !== session) {
        return
      }
      this.emit(request.sessionId, {
        type: 'status',
        status: { type: 'exit', code, signal: null }
      })
    })
    channel.once('close', () => {
      if (session.hardCloseTimer) {
        clearTimeout(session.hardCloseTimer)
      }
      if (this.sessions.get(request.sessionId) !== session) {
        return
      }
      this.sessions.delete(request.sessionId)
      this.emit(request.sessionId, { type: 'status', status: { type: 'closed' } })
    })
  }
  send(sessionId: string, bytes: Uint8Array<ArrayBufferLike>): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return false
    }
    if (
      !acceptsLanguageServerInput(
        session.channel.writableLength ?? 0,
        bytes.byteLength,
        this.options.maxPendingInputBytes
      )
    ) {
      this.emit(sessionId, { type: 'status', status: { type: 'backpressure', direction: 'stdin' } })
      return false
    }
    return session.channel.write(Buffer.from(bytes))
  }
  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }
    this.sessions.delete(sessionId)
    // #182: standard LSP shutdown + EOF first, so a well-behaved server and
    // its wrapper shells take themselves down; a wedged tree still gets the
    // hard channel close after the grace period.
    try {
      session.channel.write(Buffer.from(SHUTDOWN_EXIT_FRAMES))
      session.channel.end()
    } catch {
      // Channel already torn down — the fallback below finishes the job.
    }
    session.hardCloseTimer = setTimeout(() => {
      try {
        session.channel.close()
      } catch {
        // already closed
      }
    }, this.options.hardCloseTimeoutMs ?? HARD_CLOSE_TIMEOUT_MS)
    session.hardCloseTimer.unref?.()
    this.emit(sessionId, { type: 'status', status: { type: 'closed' } })
  }
  dispose(): void {
    for (const id of this.sessions.keys()) {
      this.close(id)
    }
  }
  private stderr(id: string, session: Session, chunk: Buffer): void {
    const retained = retainLanguageServerStderr(
      session.stderrBytes,
      chunk,
      this.options.maxStderrBytes
    )
    if (!retained.accepted.length) {
      return
    }
    session.stderrBytes = retained.retainedBytes
    this.emit(id, {
      type: 'status',
      status: {
        type: 'stderr',
        text: retained.accepted.toString('utf8'),
        truncated: retained.truncated
      }
    })
  }
}
