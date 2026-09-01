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
type Session = { channel: Channel; stderrBytes: number }
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
export class SshLanguageServerSessionManager {
  private readonly sessions = new Map<string, Session>()
  constructor(
    private readonly emit: (sessionId: string, event: LanguageServerSessionEvent) => void,
    private readonly resolveCommand: (
      request: LanguageServerLaunchRequest
    ) => SshLanguageServerCommand,
    private readonly buildCommand = buildPosixLanguageServerCommand,
    private readonly options: { maxPendingInputBytes?: number; maxStderrBytes?: number } = {}
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
    const session = { channel, stderrBytes: 0 }
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
    channel.once('close', () => {
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
    session.channel.end()
    session.channel.close()
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
