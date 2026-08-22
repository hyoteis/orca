import { isAbsolute } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type {
  LanguageServerKind,
  LanguageServerSessionEvent,
  LanguageServerSessionOpenRequest
} from '../../shared/language-server-session'

export type ResolvedLanguageServerCommand = {
  executable: string
  args: readonly string[]
  cwd: string
  env?: Readonly<Record<string, string>>
}
type LocalSession = {
  child: ChildProcessWithoutNullStreams
  closeTimer: ReturnType<typeof setTimeout> | null
  stderrBytes: number
}
const MAX_INPUT = 8 * 1024 * 1024
const MAX_STDERR = 256 * 1024

export function resolveDefaultLocalLanguageServerCommand(
  request: LanguageServerSessionOpenRequest
): ResolvedLanguageServerCommand {
  const commands: Record<LanguageServerKind, { executable: string; args: string[] }> = {
    basedpyright: { executable: 'basedpyright-langserver', args: ['--stdio'] },
    pyright: { executable: 'pyright-langserver', args: ['--stdio'] },
    clangd: { executable: 'clangd', args: [] }
  }
  return { ...commands[request.kind], cwd: request.workspaceRoot }
}

export class LocalLanguageServerSessionManager {
  private readonly sessions = new Map<string, LocalSession>()
  constructor(
    private readonly emit: (sessionId: string, event: LanguageServerSessionEvent) => void,
    private readonly resolveCommand = resolveDefaultLocalLanguageServerCommand,
    private readonly options: {
      maxPendingInputBytes?: number
      maxStderrBytes?: number
      closeTimeoutMs?: number
    } = {}
  ) {}

  open(request: LanguageServerSessionOpenRequest): void {
    if (this.sessions.has(request.sessionId)) {
      throw new Error(`Language server session already exists: ${request.sessionId}`)
    }
    if (!isAbsolute(request.workspaceRoot)) {
      throw new Error('Language server workspace root must be absolute')
    }
    const command = this.resolveCommand(request)
    if (!command.executable.trim() || !isAbsolute(command.cwd)) {
      throw new Error('Resolved language server command is invalid')
    }
    this.emit(request.sessionId, { type: 'status', status: { type: 'starting' } })
    const child = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      env: command.env ? { ...process.env, ...command.env } : process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const session: LocalSession = { child, closeTimer: null, stderrBytes: 0 }
    this.sessions.set(request.sessionId, session)
    child.once('spawn', () =>
      this.emit(request.sessionId, {
        type: 'status',
        status: { type: 'ready', pid: child.pid ?? 0 }
      })
    )
    child.stdout.on('data', (chunk: Buffer) =>
      this.emit(request.sessionId, { type: 'stdout', bytes: new Uint8Array(chunk) })
    )
    child.stderr.on('data', (chunk: Buffer) => this.emitStderr(request.sessionId, session, chunk))
    child.once('error', (error) =>
      this.emit(request.sessionId, {
        type: 'status',
        status: { type: 'error', message: error.message }
      })
    )
    child.once('exit', (code, signal) => {
      this.clearSession(request.sessionId, session)
      this.emit(request.sessionId, { type: 'status', status: { type: 'exit', code, signal } })
    })
  }

  send(sessionId: string, bytes: Uint8Array<ArrayBufferLike>): boolean {
    const session = this.sessions.get(sessionId)
    if (!session || session.child.stdin.destroyed) {
      return false
    }
    if (
      session.child.stdin.writableLength + bytes.byteLength >
      (this.options.maxPendingInputBytes ?? MAX_INPUT)
    ) {
      this.emit(sessionId, { type: 'status', status: { type: 'backpressure', direction: 'stdin' } })
      return false
    }
    return session.child.stdin.write(Buffer.from(bytes))
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }
    session.child.stdin.end()
    session.child.kill('SIGTERM')
    session.closeTimer = setTimeout(
      () => session.child.kill('SIGKILL'),
      this.options.closeTimeoutMs ?? 2_000
    )
    session.closeTimer.unref?.()
  }

  dispose(): void {
    for (const sessionId of this.sessions.keys()) {
      this.close(sessionId)
    }
  }

  private emitStderr(sessionId: string, session: LocalSession, chunk: Buffer): void {
    const max = this.options.maxStderrBytes ?? MAX_STDERR
    const accepted = chunk.subarray(0, Math.max(0, max - session.stderrBytes))
    if (accepted.byteLength === 0) {
      return
    }
    session.stderrBytes += accepted.byteLength
    this.emit(sessionId, {
      type: 'status',
      status: {
        type: 'stderr',
        text: accepted.toString('utf8'),
        truncated: accepted.byteLength < chunk.byteLength || session.stderrBytes === max
      }
    })
  }

  private clearSession(sessionId: string, session: LocalSession): void {
    if (session.closeTimer) {
      clearTimeout(session.closeTimer)
    }
    if (this.sessions.get(sessionId) === session) {
      this.sessions.delete(sessionId)
    }
  }
}
