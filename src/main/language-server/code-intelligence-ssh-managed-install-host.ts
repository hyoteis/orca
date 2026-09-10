import { shellEscape } from '../ssh/ssh-connection-utils'
import type { ManagedLanguageServerInstallHost } from './managed-language-server-install-host'
import {
  acquireSshManagedVersion,
  probeSshManagedEntry,
  probeTail
} from './code-intelligence-ssh-managed-acquisition'
import {
  listSshManagedVersions,
  readSshManagedActivation,
  remoteManagedVersionDirectory,
  writeSshManagedActivation,
  type SshManagedInstallContext
} from './code-intelligence-ssh-managed-install-root'

/** SSH-Host adapter (#151 PR2): remote mktemp staging, remote sha256sum
 * verification, and shell extraction chains over the remote
 * ~/.orca/code-intelligence/managed layout. Transport-silent on progress —
 * the pipeline envelope is ready for phases whenever a follow-up adds them. */
export function createSshManagedLanguageServerInstallHost(args: {
  createContext: () => Promise<SshManagedInstallContext>
}): ManagedLanguageServerInstallHost {
  const withContext = async <T>(
    run: (ctx: SshManagedInstallContext) => Promise<T>
  ): Promise<T> => run(await args.createContext())
  return {
    hostTarget: async () => {
      const ctx = await args.createContext()
      return { platform: ctx.remotePlatform, arch: ctx.remoteArch, glibcVersion: ctx.remoteGlibc }
    },
    unsupportedReason: async () => {
      // Windows SSH targets have no managed support — the acquisition chain is
      // POSIX-only while the manifest does carry win32 entries for local Hosts.
      const ctx = await args.createContext()
      return ctx.remotePlatform === 'win32'
        ? { type: 'unsupported-platform' as const, platform: 'win32', arch: ctx.remoteArch }
        : null
    },
    readActivation: (tool) => withContext((ctx) => readSshManagedActivation(ctx, tool)),
    writeActivation: (tool, record) =>
      withContext((ctx) => writeSshManagedActivation(ctx, tool, record)),
    listVersions: (tool) => withContext((ctx) => listSshManagedVersions(ctx, tool)),
    probeVersion: (entry) =>
      withContext(async (ctx) => {
        const smoke = await probeSshManagedEntry(
          ctx,
          entry,
          remoteManagedVersionDirectory(ctx.home, entry.tool, entry.version)
        )
        if (smoke.code !== 0) {
          throw new Error(
            `Managed ${entry.tool} ${entry.version} smoke test failed on the SSH Host: ${probeTail(smoke)}`
          )
        }
      }),
    acquire: async (acquireArgs) =>
      withContext((ctx) =>
        acquireSshManagedVersion({
          ctx,
          entry: acquireArgs.entry,
          route: acquireArgs.route,
          signal: acquireArgs.signal
        })
      ),
    removeVersion: (tool, version) =>
      withContext(async (ctx) => {
        await ctx.queue.exec(
          `rm -rf -- ${shellEscape(remoteManagedVersionDirectory(ctx.home, tool, version))}`
        )
      })
  }
}
