import { shellEscape } from '../ssh/ssh-connection-utils'
import { compareManagedLanguageServerVersions, manifestEntryForLaunch } from '../../shared/managed-language-server'
import type {
  ManagedLanguageServerInstallState,
  ManagedLanguageServerManifest,
  ManagedLanguageServerRollbackResult
} from '../../shared/managed-language-server'
import type { LanguageServerKind } from '../../shared/language-server-session'
import { manifestEntryById } from './managed-language-server-install-root'
import {
  listSshManagedVersions,
  readSshManagedActivation,
  remoteManagedVersionDirectory,
  writeSshManagedActivation,
  type SshManagedInstallContext
} from './code-intelligence-ssh-managed-install-root'
import {
  probeSshManagedEntry,
  probeTail,
  resolveSshTemplate
} from './code-intelligence-ssh-managed-acquisition'
import { resolveSshManagedEntry } from './code-intelligence-ssh-managed-install'

export async function rollbackSshManagedLanguageServer(args: {
  ctx: SshManagedInstallContext
  manifest: ManagedLanguageServerManifest
  tool: LanguageServerKind
}): Promise<ManagedLanguageServerRollbackResult> {
  const { ctx } = args
  const record = await readSshManagedActivation(ctx, args.tool)
  if (!record?.rollback) {
    return { status: 'no-rollback' }
  }
  const entry = manifestEntryById(args.manifest, record.rollback.entryId)
  const smoke = entry
    ? await probeSshManagedEntry(
        ctx,
        args.manifest,
        entry,
        remoteManagedVersionDirectory(ctx.home, entry.tool, entry.version)
      )
    : null
  if (!entry || !smoke || smoke.code !== 0) {
    return {
      status: 'failed',
      error: `Rollback target ${record.rollback.version} failed its smoke test${
        smoke ? `: ${probeTail(smoke)}` : ''
      }`
    }
  }
  await writeSshManagedActivation(ctx, args.tool, { active: record.rollback, rollback: record.active })
  return { status: 'rolled-back', version: record.rollback.version }
}

export async function sshManagedLanguageServerState(args: {
  ctx: SshManagedInstallContext
  manifest: ManagedLanguageServerManifest
  tool: LanguageServerKind
}): Promise<ManagedLanguageServerInstallState> {
  const { ctx } = args
  const resolved = resolveSshManagedEntry(ctx, args.manifest, args.tool)
  const [record, installedVersions] = await Promise.all([
    readSshManagedActivation(ctx, args.tool),
    listSshManagedVersions(ctx, args.tool)
  ])
  const activeVersion = record?.active.version ?? null
  if (!('entry' in resolved)) {
    return {
      tool: args.tool,
      supported: false,
      unsupportedReason: resolved.unsupported,
      activeVersion,
      rollbackVersion: record?.rollback?.version ?? null,
      installedVersions,
      latestEntry: null,
      updateAvailable: false
    }
  }
  return {
    tool: args.tool,
    supported: true,
    activeVersion,
    rollbackVersion: record?.rollback?.version ?? null,
    installedVersions,
    latestEntry: resolved.entry,
    updateAvailable:
      activeVersion !== null &&
      compareManagedLanguageServerVersions(resolved.entry.version, activeVersion) > 0
  }
}

/** Active (or explicitly requested) version's launch command on an SSH Host. */
export async function resolveSshManagedLanguageServerCommand(args: {
  ctx: SshManagedInstallContext
  manifest: ManagedLanguageServerManifest
  tool: LanguageServerKind
  version?: string
}): Promise<{ executable: string; args: string[] } | null> {
  const { ctx } = args
  const record = await readSshManagedActivation(ctx, args.tool)
  if (!record) {
    return null
  }
  const entry = manifestEntryForLaunch(
    args.manifest,
    record,
    { tool: args.tool, version: args.version },
    { platform: ctx.remotePlatform, arch: ctx.remoteArch }
  )
  if (!entry) {
    return null
  }
  return resolveSshTemplate(
    ctx,
    args.manifest,
    entry,
    remoteManagedVersionDirectory(ctx.home, entry.tool, entry.version),
    'command'
  )
}

/** Remote GC: removes versions not protected by the keep set (active,
 * rollback, scope pins). Staging dot-directories never match the version
 * pattern and are left alone. */
export async function gcSshManagedLanguageServerVersions(args: {
  ctx: SshManagedInstallContext
  tool: LanguageServerKind
  keepVersions: readonly string[]
}): Promise<void> {
  const { ctx } = args
  const keep = new Set(args.keepVersions)
  for (const version of await listSshManagedVersions(ctx, args.tool)) {
    if (!keep.has(version)) {
      await ctx.queue.exec(
        `rm -rf -- ${shellEscape(remoteManagedVersionDirectory(ctx.home, args.tool, version))}`
      )
    }
  }
}
