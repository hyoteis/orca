import { stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { shellEscape } from '../ssh/ssh-connection-utils'
import { buildPosixLanguageServerCommand } from '../ssh/ssh-language-server-session-manager'
import type { RemoteOperatingSystem } from '../ssh/ssh-remote-platform'
import { resolveManagedLanguageServerCommand, resolveManagedLanguageServerEntry } from '../../shared/managed-language-server'
import type {
  ManagedLanguageServerActivationRecord,
  ManagedLanguageServerInstallResult,
  ManagedLanguageServerInstallRoute,
  ManagedLanguageServerManifest,
  ManagedLanguageServerManifestEntry,
  ManagedLanguageServerUnsupportedReason
} from '../../shared/managed-language-server'
import type { LanguageServerKind } from '../../shared/language-server-session'
import { buildManagedExtractionCommands } from './managed-language-server-extraction'
import { MANAGED_LANGUAGE_SERVER_ACTIVATION_FILE, manifestEntryById } from './managed-language-server-install-root'
import { SshSetupExecQueue } from './code-intelligence-ssh-setup-exec'

/** Everything the remote transaction needs; the IPC layer resolves these per
 * request from the live connection and registered remote platform. */
export type SshManagedInstallContext = {
  queue: SshSetupExecQueue
  home: string
  remotePlatform: RemoteOperatingSystem
  remoteArch: 'x64' | 'arm64'
  /** Remote glibc when probed on linux; drives the artifact floor fallback. */
  remoteGlibc?: string
  uploadFile: (localPath: string, remotePath: string, signal?: AbortSignal) => Promise<void>
}

export function remoteManagedRoot(home: string): string {
  // posix: the remote layout is POSIX regardless of the client platform.
  return posix.join(home, '.orca', 'code-intelligence', 'managed')
}

export const remoteManagedToolRoot = (home: string, tool: string): string =>
  posix.join(remoteManagedRoot(home), tool)

export const remoteManagedVersionDirectory = (home: string, tool: string, version: string): string =>
  posix.join(remoteManagedToolRoot(home, tool), version)

const remoteActivationPath = (home: string, tool: string): string =>
  posix.join(remoteManagedToolRoot(home, tool), MANAGED_LANGUAGE_SERVER_ACTIVATION_FILE)

/** Windows SSH targets have no trusted entries — Windows paths never match the
 * POSIX remote layout, so they fall back to Phase 1 user installation. */
function sshUnsupportedReason(ctx: SshManagedInstallContext): ManagedLanguageServerUnsupportedReason | null {
  if (ctx.remotePlatform === 'win32') {
    return { type: 'unsupported-platform', platform: 'win32', arch: ctx.remoteArch }
  }
  return null
}

export function resolveSshManagedEntry(
  ctx: SshManagedInstallContext,
  manifest: ManagedLanguageServerManifest,
  tool: LanguageServerKind,
  version?: string
):
  | { entry: ManagedLanguageServerManifestEntry; runtimeEntry?: ManagedLanguageServerManifestEntry }
  | { unsupported: ManagedLanguageServerUnsupportedReason } {
  const unsupported = sshUnsupportedReason(ctx)
  if (unsupported) {
    return { unsupported }
  }
  return resolveManagedLanguageServerEntry(
    manifest,
    { tool, version },
    { platform: ctx.remotePlatform, arch: ctx.remoteArch, glibcVersion: ctx.remoteGlibc }
  )
}

export function resolveSshTemplate(
  ctx: SshManagedInstallContext,
  manifest: ManagedLanguageServerManifest,
  entry: ManagedLanguageServerManifestEntry,
  rootDirectory: string,
  template: 'probe' | 'command'
): { executable: string; args: string[] } {
  const runtimeEntry = entry.runtimeEntryId
    ? manifestEntryById(manifest, entry.runtimeEntryId)
    : undefined
  return resolveManagedLanguageServerCommand(entry[template], {
    root: rootDirectory,
    runtimeRoot: runtimeEntry
      ? remoteManagedVersionDirectory(ctx.home, runtimeEntry.tool, runtimeEntry.version)
      : undefined
  })
}

export async function probeSshManagedEntry(
  ctx: SshManagedInstallContext,
  manifest: ManagedLanguageServerManifest,
  entry: ManagedLanguageServerManifestEntry,
  rootDirectory: string
): Promise<boolean> {
  const command = resolveSshTemplate(ctx, manifest, entry, rootDirectory, 'probe')
  const result = await ctx.queue.exec(
    buildPosixLanguageServerCommand({ executable: command.executable, args: command.args, cwd: rootDirectory })
  )
  return result.code === 0
}

export async function readSshManagedActivation(
  ctx: SshManagedInstallContext,
  tool: string
): Promise<ManagedLanguageServerActivationRecord | null> {
  const result = await ctx.queue.exec(`cat ${shellEscape(remoteActivationPath(ctx.home, tool))}`)
  if (result.code !== 0) {
    return null
  }
  try {
    const record = JSON.parse(result.stdout) as ManagedLanguageServerActivationRecord
    return typeof record?.active?.version === 'string' ? record : null
  } catch {
    return null
  }
}

export async function writeSshManagedActivation(
  ctx: SshManagedInstallContext,
  tool: string,
  record: ManagedLanguageServerActivationRecord
): Promise<void> {
  await ctx.queue.writeFile(
    remoteManagedToolRoot(ctx.home, tool),
    MANAGED_LANGUAGE_SERVER_ACTIVATION_FILE,
    JSON.stringify(record, null, 2)
  )
}

/** Version directories under the remote tool root (staging/records excluded). */
export async function listSshManagedVersions(ctx: SshManagedInstallContext, tool: string): Promise<string[]> {
  const result = await ctx.queue.exec(`ls -1 ${shellEscape(remoteManagedToolRoot(ctx.home, tool))} 2>/dev/null`)
  if (result.code !== 0) {
    return []
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+(\.\d+)+$/.test(line))
}

/**
 * Remote mirror of the managed-install transaction (#15): remote staging via
 * mktemp, remote sha256sum verification, shell extraction chain, smoke test,
 * guarded mv into the immutable version root, and an atomic activation swap.
 * A failure or cancellation removes only the staging directory.
 */
export async function installSshManagedLanguageServer(args: {
  ctx: SshManagedInstallContext
  manifest: ManagedLanguageServerManifest
  tool: LanguageServerKind
  version?: string
  route: ManagedLanguageServerInstallRoute
  signal?: AbortSignal
}): Promise<ManagedLanguageServerInstallResult> {
  const { ctx } = args
  const resolved = resolveSshManagedEntry(ctx, args.manifest, args.tool, args.version)
  if (!('entry' in resolved)) {
    return { status: 'unsupported', reason: resolved.unsupported }
  }
  try {
    const { entry, runtimeEntry } = resolved
    args.signal?.throwIfAborted()
    if (runtimeEntry && !(await probeSshManagedVersion(ctx, args.manifest, runtimeEntry))) {
      await acquireSshManagedVersion(ctx, args.manifest, runtimeEntry, { type: 'host-download' }, args.signal)
      await writeSshManagedActivation(ctx, runtimeEntry.tool, {
        active: { version: runtimeEntry.version, entryId: runtimeEntry.id, activatedAt: Date.now() }
      })
    }
    const record = await readSshManagedActivation(ctx, entry.tool)
    const versionDirectory = remoteManagedVersionDirectory(ctx.home, entry.tool, entry.version)
    if (record?.active.version === entry.version) {
      if (!(await probeSshManagedEntry(ctx, args.manifest, entry, versionDirectory))) {
        throw new Error(`Active managed ${entry.tool} ${entry.version} failed its smoke test`)
      }
      return { status: 'already-active', version: entry.version }
    }
    if ((await listSshManagedVersions(ctx, entry.tool)).includes(entry.version)) {
      if (!(await probeSshManagedEntry(ctx, args.manifest, entry, versionDirectory))) {
        throw new Error(`Managed ${entry.tool} ${entry.version} failed its smoke test`)
      }
    } else {
      await acquireSshManagedVersion(ctx, args.manifest, entry, args.route, args.signal)
    }
    args.signal?.throwIfAborted()
    await writeSshManagedActivation(ctx, entry.tool, {
      active: { version: entry.version, entryId: entry.id, activatedAt: Date.now() },
      ...(record?.active && record.active.version !== entry.version
        ? { rollback: record.active }
        : {})
    })
    return { status: 'installed', version: entry.version }
  } catch (error) {
    if (args.signal?.aborted) {
      return { status: 'canceled' }
    }
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

async function probeSshManagedVersion(
  ctx: SshManagedInstallContext,
  manifest: ManagedLanguageServerManifest,
  entry: ManagedLanguageServerManifestEntry
): Promise<boolean> {
  const exists = await ctx.queue.exec(
    `test -d ${shellEscape(remoteManagedVersionDirectory(ctx.home, entry.tool, entry.version))}`
  )
  if (exists.code !== 0) {
    return false
  }
  return probeSshManagedEntry(
    ctx,
    manifest,
    entry,
    remoteManagedVersionDirectory(ctx.home, entry.tool, entry.version)
  )
}

async function acquireSshManagedVersion(
  ctx: SshManagedInstallContext,
  manifest: ManagedLanguageServerManifest,
  entry: ManagedLanguageServerManifestEntry,
  route: ManagedLanguageServerInstallRoute,
  signal?: AbortSignal
): Promise<void> {
  await ctx.queue.exec(`mkdir -p ${shellEscape(remoteManagedToolRoot(ctx.home, entry.tool))}`)
  const staging = (
    await ctx.queue.capture(
      `mktemp -d ${shellEscape(remoteManagedToolRoot(ctx.home, entry.tool))}/.staging.XXXXXX`
    )
  ).trim()
  try {
    signal?.throwIfAborted()
    const archivePath = posix.join(staging, entry.archiveFileName)
    if (route.type === 'host-download') {
      // curl first, wget fallback; both honor the Host's proxy environment.
      const url = shellEscape(entry.sourceUrl)
      const result = await ctx.queue.exec(
        `curl -fL --retry 2 --connect-timeout 15 -o ${shellEscape(archivePath)} ${url} || wget -q --timeout=15 -O ${shellEscape(archivePath)} ${url}`
      )
      if (result.code !== 0) {
        throw new Error(
          `Archive download failed on the SSH Host (curl/wget exited ${String(result.code)})`
        )
      }
    } else {
      const fileStat = await stat(route.filePath)
      if (fileStat.size !== entry.sizeBytes) {
        throw new Error(
          `Selected file is ${String(fileStat.size)} bytes but the trusted manifest expects ${String(entry.sizeBytes)}`
        )
      }
      await ctx.uploadFile(route.filePath, archivePath, signal)
    }
    // Cancellation checkpoints: the exec queue has no per-command abort, so a
    // canceled install stops at the next boundary and never reaches the
    // activation swap.
    signal?.throwIfAborted()
    const digest = (
      await ctx.queue.capture(`sha256sum ${shellEscape(archivePath)} | cut -d ' ' -f1`)
    ).trim()
    if (digest !== entry.sha256) {
      throw new Error(
        'Archive sha256 does not match the trusted manifest; it may be corrupt or a wrong-platform build'
      )
    }
    const extractDirectory = posix.join(staging, 'extract')
    await ctx.queue.exec(`mkdir -p ${shellEscape(extractDirectory)}`)
    const extraction = buildManagedExtractionCommands({
      platform: ctx.remotePlatform,
      archiveFormat: entry.archiveFormat,
      archivePath,
      destination: extractDirectory
    })
    const extractionResult = await ctx.queue.exec(
      // Braces: without them `a && b || c && d` would re-run later extractors
      // after an earlier one already succeeded (|| and && share precedence).
      extraction
        .map((command) =>
          `{ ${buildPosixLanguageServerCommand({ executable: command.executable, args: command.args, cwd: staging })}; }`
        )
        .join(' || ')
    )
    if (extractionResult.code !== 0) {
      throw new Error('Archive extraction failed on the SSH Host')
    }
    const extracted =
      entry.archiveRootDirectory === '.'
        ? extractDirectory
        : posix.join(extractDirectory, entry.archiveRootDirectory)
    const probePath = resolveSshTemplate(ctx, manifest, entry, extracted, 'probe')
    await ctx.queue.exec(`chmod +x ${shellEscape(probePath.executable)}`)
    if (!(await probeSshManagedEntry(ctx, manifest, entry, extracted))) {
      throw new Error(`Managed ${entry.tool} ${entry.version} smoke test failed on the SSH Host`)
    }
    const destination = remoteManagedVersionDirectory(ctx.home, entry.tool, entry.version)
    const move = await ctx.queue.exec(
      `test ! -e ${shellEscape(destination)} && mv ${shellEscape(extracted)} ${shellEscape(destination)}`
    )
    if (move.code !== 0 && !(await probeSshManagedVersion(ctx, manifest, entry))) {
      throw new Error(`Existing managed ${entry.tool} ${entry.version} failed its smoke test`)
    }
    signal?.throwIfAborted()
  } finally {
    await ctx.queue.exec(`rm -rf -- ${shellEscape(staging)}`).catch(() => {})
  }
}

/** Remote arch from `uname -m` for entry matching. */
export async function sshManagedRemoteArch(
  connection: ConstructorParameters<typeof SshSetupExecQueue>[0]
): Promise<'x64' | 'arm64' | null> {
  const result = await new SshSetupExecQueue(connection).exec('uname -m')
  if (result.code !== 0) {
    return null
  }
  const machine = result.stdout.trim()
  if (machine === 'x86_64' || machine === 'amd64') {
    return 'x64'
  }
  if (machine === 'aarch64' || machine === 'arm64') {
    return 'arm64'
  }
  return null
}
