import {
  assertManagedLanguageServerTool,
  manifestEntryForLaunch
} from '../../shared/managed-language-server'
import type {
  ManagedLanguageServerManifest
} from '../../shared/managed-language-server'
import type { LanguageServerKind } from '../../shared/language-server-session'
import {
  readSshManagedActivation,
  remoteManagedVersionDirectory,
  type SshManagedInstallContext
} from './code-intelligence-ssh-managed-install-root'
import { resolveSshTemplate } from './code-intelligence-ssh-managed-acquisition'

/** Active (or explicitly requested) version's launch command on an SSH Host.
 * Stays out of the install pipeline (#151): the IPC launch seam resolves the
 * scope's command directly without an installer instance. */
export async function resolveSshManagedLanguageServerCommand(args: {
  ctx: SshManagedInstallContext
  manifest: ManagedLanguageServerManifest
  tool: LanguageServerKind
  version?: string
}): Promise<{ executable: string; args: string[] } | null> {
  const { ctx } = args
  const tool = assertManagedLanguageServerTool(args.tool)
  const record = await readSshManagedActivation(ctx, tool)
  if (!record) {
    return null
  }
  const entry = manifestEntryForLaunch(
    args.manifest,
    record,
    { tool, version: args.version },
    { platform: ctx.remotePlatform, arch: ctx.remoteArch }
  )
  if (!entry) {
    return null
  }
  return resolveSshTemplate(
    entry,
    remoteManagedVersionDirectory(ctx.home, entry.tool, entry.version),
    'command'
  )
}
