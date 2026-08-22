import type { EventEmitter } from 'node:events'
import type {
  LanguageServerSessionEvent,
  LanguageServerSessionOpenRequest
} from '../../shared/language-server-session'
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
export function buildPosixLanguageServerCommand(command: SshLanguageServerCommand): string {
  return `cd ${quotePosix(command.cwd)} && exec ${[command.executable, ...command.args].map(quotePosix).join(' ')}`
}
export class SshLanguageServerSessionManager {
  private readonly sessions = new Map<string, Session>()
  constructor(
    private readonly emit: (sessionId: string, event: LanguageServerSessionEvent) => void,
    private readonly resolveCommand: (
      request: LanguageServerSessionOpenRequest
    ) => SshLanguageServerCommand,
    private readonly buildCommand = buildPosixLanguageServerCommand,
    private readonly options: { maxPendingInputBytes?: number; maxStderrBytes?: number } = {}
  ) {}
  async open(connection: SshConnection, request: LanguageServerSessionOpenRequest): Promise<void> {
    if (this.sessions.has(request.sessionId)) {
      throw new Error(`Language server session already exists: ${request.sessionId}`)
    }
    this.emit(request.sessionId, { type: 'status', status: { type: 'starting' } })
    const channel = (await connection.exec(
      this.buildCommand(this.resolveCommand(request))
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
      (session.channel.writableLength ?? 0) + bytes.byteLength >
      (this.options.maxPendingInputBytes ?? 8 * 1024 * 1024)
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
    const max = this.options.maxStderrBytes ?? 256 * 1024,
      accepted = chunk.subarray(0, Math.max(0, max - session.stderrBytes))
    if (!accepted.length) {
      return
    }
    session.stderrBytes += accepted.length
    this.emit(id, {
      type: 'status',
      status: {
        type: 'stderr',
        text: accepted.toString('utf8'),
        truncated: accepted.length < chunk.length || session.stderrBytes === max
      }
    })
  }
}
