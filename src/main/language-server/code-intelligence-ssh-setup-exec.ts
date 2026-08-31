import type { ClientChannel } from 'ssh2'
import { shellEscape } from '../ssh/ssh-connection-utils'
import type { SshConnection } from '../ssh/ssh-connection'
import { COMMAND_TIMEOUT_MS } from './code-intelligence-cpp-setup-tools'
import {
  IGNORED_DIRECTORIES,
  SOURCE_EXTENSIONS
} from './code-intelligence-compilation-database'

export type SshSetupExecResult = { code: number | null; stdout: string; stderr: string }

/** Transport-level failure (disconnect, dead channel) — the setup run fails but reruns stay safe. */
export class SshSetupConnectionError extends Error {}

type Channel = ClientChannel & {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  once(event: 'close' | 'error', listener: (...args: never[]) => void): unknown
}

/** Atomic remote file replace: content arrives on stdin (no ARG_MAX limit), swap via tmp + mv. */
export function buildRemoteAtomicWriteCommand(directory: string, fileName: string): string {
  const temporary = `.${fileName}.tmp`
  return `cd ${shellEscape(directory)} && cat > ${shellEscape(temporary)} && mv ${shellEscape(
    temporary
  )} ${shellEscape(fileName)}`
}

/** clangd spawn-time --compile-commands-dir existence probe. */
export function buildRemoteDirectoryExistsCommand(directory: string): string {
  return `test -d ${shellEscape(directory)}`
}

/** Single-path readability probe (build-root detection). */
export function buildRemoteReadablePathCommand(path: string): string {
  return `test -r ${shellEscape(path)}`
}

/** PATH lookup for a setup tool executable. */
export function buildRemoteToolLookupCommand(tool: string): string {
  return `command -v ${shellEscape(tool)}`
}

/** Shard readback for the local single-source merge. */
export function buildRemoteReadFileCommand(path: string): string {
  return `cat ${shellEscape(path)}`
}

/** Direct child directories of `directory` (GN output scan). */
export function buildRemoteListSubdirectoriesCommand(directory: string): string {
  return `find ${shellEscape(directory)} -mindepth 1 -maxdepth 1 -type d -print`
}

const prunedNames = () =>
  [...IGNORED_DIRECTORIES].map((name) => `-name ${shellEscape(name)}`).join(' -o ')

/** Source walk mirroring the local collector: pruned dirs, case-insensitive extensions. */
export function buildRemoteFindSourceFilesCommand(root: string): string {
  const extensions = [...SOURCE_EXTENSIONS]
    .map((extension) => `-iname ${shellEscape(`*${extension}`)}`)
    .join(' -o ')
  return `find ${shellEscape(root)} \\( ${prunedNames()} \\) -prune -o -type f \\( ${extensions} \\) -print`
}

/** Conventional include walk: matches are printed and not descended (local parity). */
export function buildRemoteFindIncludeDirectoriesCommand(root: string): string {
  const matches = ['api', 'include', 'interface']
    .map((name) => `-iname ${shellEscape(name)}`)
    .join(' -o ')
  return `find ${shellEscape(root)} -maxdepth 5 \\( ${prunedNames()} \\) -prune -o -type d \\( ${matches} \\) -print -prune`
}

/** One round trip to filter candidate include directories by readability, in order.
 * `if` (not `&&`) so an unreadable last candidate cannot fail the whole loop. */
export function buildRemoteReadableDirectoriesCommand(paths: readonly string[]): string {
  return `for d in ${paths.map(shellEscape).join(' ')}; do if [ -r "$d" ]; then printf '%s\\n' "$d"; fi; done`
}

/** clangd lookup: PATH first, then the same darwin candidates the local flow probes. */
export function buildRemoteClangdDiscoveryCommand(
  darwinCandidates: readonly string[]
): string {
  const candidates = darwinCandidates.map(shellEscape).join(' ')
  return `command -v clangd || { for c in ${candidates}; do [ -x "$c" ] && printf '%s\\n' "$c" && exit 0; done; exit 1; }`
}

/**
 * Serializes setup commands over one SSH connection: the system ssh transport
 * has no concurrent exec, so every caller (including Promise.all detection
 * fans) degenerates to FIFO here.
 */
export class SshSetupExecQueue {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly connection: SshConnection,
    private readonly timeoutMs = COMMAND_TIMEOUT_MS
  ) {}

  exec(command: string, options: { stdin?: string } = {}): Promise<SshSetupExecResult> {
    const run = this.tail.then(() => this.collect(command, options.stdin))
    this.tail = run.catch(() => {})
    return run
  }

  /** Throws on non-zero exit; returns trimmed stdout. A close without an exit
   * status is a dead transport, so it maps to the connection error. */
  async capture(command: string): Promise<string> {
    const result = await this.exec(command)
    if (result.code === null) {
      throw new SshSetupConnectionError('SSH connection was interrupted')
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim()
      throw new Error(
        detail || `Command failed with exit code ${String(result.code)}: ${command.slice(0, 120)}`
      )
    }
    return result.stdout.trim()
  }

  /** Atomic remote write via stdin; throws when the swap does not succeed. */
  async writeFile(directory: string, fileName: string, content: string): Promise<void> {
    const result = await this.exec(buildRemoteAtomicWriteCommand(directory, fileName), {
      stdin: content
    })
    if (result.code === null || result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          `Remote file write failed: ${directory}/${fileName} (exit ${String(result.code)})`
      )
    }
  }

  private async collect(command: string, stdin?: string): Promise<SshSetupExecResult> {
    let channel: Channel
    try {
      channel = (await this.connection.exec(command)) as Channel
    } catch (error) {
      throw new SshSetupConnectionError(error instanceof Error ? error.message : String(error))
    }
    return await new Promise<SshSetupExecResult>((resolve, reject) => {
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      channel.on('data', (chunk: Buffer) => stdout.push(chunk))
      channel.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
      // Timeout closes our channel only; the remote process is left alone (spec §4.2).
      const timer = setTimeout(() => {
        channel.close()
        reject(new Error(`Timed out running SSH setup command: ${command.slice(0, 120)}`))
      }, this.timeoutMs)
      timer.unref?.()
      const settle = (): void => clearTimeout(timer)
      channel.once('error', (error) => {
        settle()
        reject(new SshSetupConnectionError(String(error)))
      })
      channel.once('close', (code: number | null) => {
        settle()
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8')
        })
      })
      if (stdin !== undefined) {
        channel.write(stdin)
        channel.end()
      }
    })
  }
}
