import { resolveManagedLanguageServerEntry } from '../../shared/managed-language-server'
import type {
  ManagedLanguageServerInstallResult,
  ManagedLanguageServerInstallRoute,
  ManagedLanguageServerManifest,
  ManagedLanguageServerManifestEntry,
  ManagedLanguageServerUnsupportedReason
} from '../../shared/managed-language-server'
import type { LanguageServerKind } from '../../shared/language-server-session'
import { SshSetupExecQueue } from './code-intelligence-ssh-setup-exec'
import {
  listSshManagedVersions,
  readSshManagedActivation,
  remoteManagedVersionDirectory,
  writeSshManagedActivation,
  type SshManagedInstallContext
} from './code-intelligence-ssh-managed-install-root'
import {
  acquireSshManagedVersion,
  probeSshManagedEntry,
  probeSshManagedVersion,
  probeTail
} from './code-intelligence-ssh-managed-acquisition'

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

/**
 * Remote mirror of the managed-install transaction (#15): runtime prefetch,
 * already-active smoke re-check, acquisition, and the atomic activation swap
 * with rollback retention. A failure or cancellation removes only staging; the
 * active version never changes.
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
      await acquireSshManagedVersion({
        ctx,
        manifest: args.manifest,
        entry: runtimeEntry,
        route: { type: 'host-download' },
        signal: args.signal
      })
      await writeSshManagedActivation(ctx, runtimeEntry.tool, {
        active: { version: runtimeEntry.version, entryId: runtimeEntry.id, activatedAt: Date.now() }
      })
    }
    const record = await readSshManagedActivation(ctx, entry.tool)
    const versionDirectory = remoteManagedVersionDirectory(ctx.home, entry.tool, entry.version)
    if (record?.active.version === entry.version) {
      const smoke = await probeSshManagedEntry(ctx, args.manifest, entry, versionDirectory)
      if (smoke.code !== 0) {
        throw new Error(
          `Active managed ${entry.tool} ${entry.version} failed its smoke test: ${probeTail(smoke)}`
        )
      }
      return { status: 'already-active', version: entry.version }
    }
    if ((await listSshManagedVersions(ctx, entry.tool)).includes(entry.version)) {
      const smoke = await probeSshManagedEntry(ctx, args.manifest, entry, versionDirectory)
      if (smoke.code !== 0) {
        throw new Error(
          `Managed ${entry.tool} ${entry.version} failed its smoke test: ${probeTail(smoke)}`
        )
      }
    } else {
      await acquireSshManagedVersion({
        ctx,
        manifest: args.manifest,
        entry,
        route: args.route,
        signal: args.signal
      })
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
