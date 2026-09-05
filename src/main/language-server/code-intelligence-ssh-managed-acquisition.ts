import { stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { shellEscape } from '../ssh/ssh-connection-utils'
import { buildPosixLanguageServerCommand } from '../ssh/ssh-language-server-session-manager'
import { resolveManagedLanguageServerCommand } from '../../shared/managed-language-server'
import type {
  ManagedLanguageServerInstallRoute,
  ManagedLanguageServerManifest,
  ManagedLanguageServerManifestEntry
} from '../../shared/managed-language-server'
import { buildManagedExtractionCommands } from './managed-language-server-extraction'
import { manifestEntryById } from './managed-language-server-install-root'
import { PROBE_LOG_LIMIT } from './managed-language-server-acquisition'
import type { SshSetupExecResult } from './code-intelligence-ssh-setup-exec'
import {
  remoteManagedToolRoot,
  remoteManagedVersionDirectory,
  type SshManagedInstallContext
} from './code-intelligence-ssh-managed-install-root'

/** Remote probe tail for error messages (local parity: the smoke-test log is
 * the only clue when a remote binary refuses to run — glibc, perms, arch). */
export const probeTail = (result: SshSetupExecResult): string =>
  `${result.stdout}${result.stderr}`.trim().slice(0, PROBE_LOG_LIMIT)

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
): Promise<SshSetupExecResult> {
  const command = resolveSshTemplate(ctx, manifest, entry, rootDirectory, 'probe')
  return ctx.queue.exec(
    buildPosixLanguageServerCommand({ executable: command.executable, args: command.args, cwd: rootDirectory })
  )
}

/** Installed-version smoke test; false when the directory is absent or dead. */
export async function probeSshManagedVersion(
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
  return (
    await probeSshManagedEntry(
      ctx,
      manifest,
      entry,
      remoteManagedVersionDirectory(ctx.home, entry.tool, entry.version)
    )
  ).code === 0
}

/**
 * Remote mirror of the managed-install acquisition (#15): remote staging via
 * mktemp, remote sha256sum verification, shell extraction chain, smoke test,
 * guarded mv into the immutable version root. A failure or cancellation
 * removes only the staging directory.
 */
export async function acquireSshManagedVersion(args: {
  ctx: SshManagedInstallContext
  manifest: ManagedLanguageServerManifest
  entry: ManagedLanguageServerManifestEntry
  route: ManagedLanguageServerInstallRoute
  signal?: AbortSignal
}): Promise<void> {
  const { ctx, entry } = args
  await ctx.queue.exec(`mkdir -p ${shellEscape(remoteManagedToolRoot(ctx.home, entry.tool))}`)
  const staging = (
    await ctx.queue.capture(
      `mktemp -d ${shellEscape(remoteManagedToolRoot(ctx.home, entry.tool))}/.staging.XXXXXX`
    )
  ).trim()
  try {
    args.signal?.throwIfAborted()
    const archivePath = posix.join(staging, entry.archiveFileName)
    if (args.route.type === 'host-download') {
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
      const fileStat = await stat(args.route.filePath)
      if (fileStat.size !== entry.sizeBytes) {
        throw new Error(
          `Selected file is ${String(fileStat.size)} bytes but the trusted manifest expects ${String(entry.sizeBytes)}`
        )
      }
      await ctx.uploadFile(args.route.filePath, archivePath, args.signal)
    }
    // Cancellation checkpoints: the exec queue has no per-command abort, so a
    // canceled install stops at the next boundary and never reaches the
    // activation swap.
    args.signal?.throwIfAborted()
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
      throw new Error(
        `Archive extraction failed on the SSH Host: ${probeTail(extractionResult)}`
      )
    }
    const extracted =
      entry.archiveRootDirectory === '.'
        ? extractDirectory
        : posix.join(extractDirectory, entry.archiveRootDirectory)
    const probePath = resolveSshTemplate(ctx, args.manifest, entry, extracted, 'probe')
    await ctx.queue.exec(`chmod +x ${shellEscape(probePath.executable)}`)
    const smoke = await probeSshManagedEntry(ctx, args.manifest, entry, extracted)
    if (smoke.code !== 0) {
      throw new Error(
        `Managed ${entry.tool} ${entry.version} smoke test failed on the SSH Host: ${probeTail(smoke)}`
      )
    }
    const destination = remoteManagedVersionDirectory(ctx.home, entry.tool, entry.version)
    const move = await ctx.queue.exec(
      `test ! -e ${shellEscape(destination)} && mv ${shellEscape(extracted)} ${shellEscape(destination)}`
    )
    if (move.code !== 0 && !(await probeSshManagedVersion(ctx, args.manifest, entry))) {
      throw new Error(`Existing managed ${entry.tool} ${entry.version} failed its smoke test`)
    }
    args.signal?.throwIfAborted()
  } finally {
    await ctx.queue.exec(`rm -rf -- ${shellEscape(staging)}`).catch(() => {})
  }
}
