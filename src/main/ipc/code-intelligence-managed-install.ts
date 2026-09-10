import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { parseExecutionHostId, toSshExecutionHostId } from '../../shared/execution-host'
import type {
  ManagedLanguageServerInstallEvent,
  ManagedLanguageServerInstallRequest,
  ManagedLanguageServerInstallResult,
  ManagedLanguageServerInstallState,
  ManagedLanguageServerRollbackResult
} from '../../shared/managed-language-server'
import { MANAGED_LANGUAGE_SERVER_MANIFEST } from '../../shared/managed-language-server-manifest-data'
import type {
  CodeIntelligenceScope
} from '../../shared/code-intelligence-scope'
import type { LanguageServerKind } from '../../shared/language-server-session'
import { languageServerKindForScope } from '../../shared/code-intelligence-scope'
import { ManagedLanguageServerInstaller } from '../language-server/managed-language-server-installer'
import { createLocalManagedLanguageServerInstallHost } from '../language-server/managed-language-server-local-install-host'
import { probeSshManagedGlibc, sshManagedRemoteArch } from '../language-server/code-intelligence-ssh-managed-install-root'
import type {
  SshManagedInstallContext
} from '../language-server/code-intelligence-ssh-managed-install-root'
import {
  resolveSshManagedLanguageServerCommand
} from '../language-server/code-intelligence-ssh-managed-install-state'
import { createSshManagedLanguageServerInstallHost } from '../language-server/code-intelligence-ssh-managed-install-host'
import { SshSetupExecQueue } from '../language-server/code-intelligence-ssh-setup-exec'
import { uploadFile as uploadFileViaSftp } from '../ssh/sftp-upload'
import type { SshConnection } from '../ssh/ssh-connection'
import type { Store } from '../persistence'
import { getSshConnectionManager, getRegisteredSshState } from './ssh'

export function broadcastManagedInstallEvent(event: ManagedLanguageServerInstallEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('codeIntelligence:managedInstallEvent', event)
    }
  }
}

/** Managed versions that scopes pin via serverSource.version; GC keeps them. */
function pinnedManagedVersions(store: Store, tool: LanguageServerKind): string[] {
  return (store.getSettings().codeIntelligenceScopes ?? [])
    .filter(
      (scope) =>
        scope.serverSource.type === 'managed' &&
        scope.serverSource.version &&
        languageServerKindForScope(scope.language) === tool
    )
    .map((scope) => (scope.serverSource as { version: string }).version)
}

let installerSingleton: ManagedLanguageServerInstaller | null = null

export function getManagedLanguageServerInstaller(store: Store): ManagedLanguageServerInstaller {
  // Read-only callers (launch resolution) may pass any store view; the first
  // registration pins the GC pin-list source, which only affects deletions.
  const root = join(app.getPath('userData'), 'code-intelligence', 'managed')
  installerSingleton ??= new ManagedLanguageServerInstaller({
    root,
    manifest: MANAGED_LANGUAGE_SERVER_MANIFEST,
    host: createLocalManagedLanguageServerInstallHost({ root }),
    emit: broadcastManagedInstallEvent,
    getPinnedVersions: (tool) => Promise.resolve(pinnedManagedVersions(store, tool))
  })
  return installerSingleton
}

/** Scope-store launch seam: resolves the scope's managed command per Host. */
export async function resolveManagedLanguageServerLaunch(
  store: Store,
  scope: CodeIntelligenceScope
): Promise<{ executable: string; args: string[] } | null> {
  const tool: LanguageServerKind = languageServerKindForScope(scope.language)
  const version = scope.serverSource.type === 'managed' ? scope.serverSource.version : undefined
  const host = parseExecutionHostId(scope.executionHostId)
  if (host?.kind === 'local') {
    return getManagedLanguageServerInstaller(store).resolveActiveCommand(tool, version)
  }
  if (host?.kind === 'ssh') {
    return resolveSshManagedLanguageServerCommand({
      ctx: await createSshManagedInstallContext(host.targetId),
      manifest: MANAGED_LANGUAGE_SERVER_MANIFEST,
      tool,
      version
    })
  }
  return null
}

type SshManagedTargetProbe = Omit<SshManagedInstallContext, 'queue' | 'uploadFile'>

/** Probed once per target for the app lifetime (local parity: the installer
 * caches hostTarget the same way); transport pieces follow the live
 * connection so a reconnect heals itself. */
const sshTargetProbes = new Map<string, Promise<SshManagedTargetProbe>>()

function probeSshManagedTarget(targetId: string): Promise<SshManagedTargetProbe> {
  let probe = sshTargetProbes.get(targetId)
  if (!probe) {
    probe = (async (): Promise<SshManagedTargetProbe> => {
      const connection = requireSshConnection(targetId)
      const queue = new SshSetupExecQueue(connection)
      const remotePlatform = getRegisteredSshState(targetId)?.remotePlatform ?? 'linux'
      return {
        home: await queue.capture('printf %s "$HOME"'),
        remotePlatform,
        remoteArch: (await sshManagedRemoteArch(connection)) ?? 'x64',
        ...(remotePlatform === 'linux'
          ? { remoteGlibc: await probeSshManagedGlibc(queue) }
          : {})
      }
    })()
    sshTargetProbes.set(targetId, probe)
    // A rejected probe (target was down) must not pin the failure forever.
    probe.catch(() => sshTargetProbes.delete(targetId))
  }
  return probe
}

function requireSshConnection(targetId: string): SshConnection {
  const connection = getSshConnectionManager()?.getConnection(targetId)
  if (!connection) {
    throw new Error(`SSH target is not connected: ${targetId}`)
  }
  return connection
}

async function createSshManagedInstallContext(targetId: string): Promise<SshManagedInstallContext> {
  const probe = await probeSshManagedTarget(targetId)
  const connection = requireSshConnection(targetId)
  return {
    queue: new SshSetupExecQueue(connection),
    ...probe,
    // Re-read per call: registration may lag the first probe, and pinning the
    // fallback would veto Windows remotes forever.
    remotePlatform: getRegisteredSshState(targetId)?.remotePlatform ?? probe.remotePlatform,
    uploadFile: async (localPath, remotePath, signal) => {
      const sftp = await connection.sftp(signal ?? undefined)
      await uploadFileViaSftp(sftp, localPath, remotePath, signal ? { signal } : undefined)
    }
  }
}

const sshInstallers = new Map<string, ManagedLanguageServerInstaller>()

/** One pipeline instance per SSH target: its lock deduplicates concurrent
 * installs and its event envelope carries the target's executionHostId. */
function getSshManagedInstaller(targetId: string, store: Store): ManagedLanguageServerInstaller {
  let installer = sshInstallers.get(targetId)
  if (!installer) {
    installer = new ManagedLanguageServerInstaller({
      manifest: MANAGED_LANGUAGE_SERVER_MANIFEST,
      host: createSshManagedLanguageServerInstallHost({
        createContext: () => createSshManagedInstallContext(targetId)
      }),
      getPinnedVersions: (tool) => Promise.resolve(pinnedManagedVersions(store, tool)),
      emit: (event) =>
        broadcastManagedInstallEvent({ ...event, executionHostId: toSshExecutionHostId(targetId) })
    })
    sshInstallers.set(targetId, installer)
  }
  return installer
}

export function registerManagedLanguageServerInstallHandlers(store: Store): void {
  const installer = getManagedLanguageServerInstaller(store)
  ipcMain.handle(
    'codeIntelligence:managedInstallState',
    async (
      _event,
      request: { executionHostId: string; tool: LanguageServerKind }
    ): Promise<ManagedLanguageServerInstallState> => {
      const host = parseExecutionHostId(request.executionHostId)
      if (host?.kind === 'ssh') {
        return getSshManagedInstaller(host.targetId, store).state(request.tool)
      }
      return installer.state(request.tool)
    }
  )
  ipcMain.handle(
    'codeIntelligence:installManagedLanguageServer',
    async (
      _event,
      request: ManagedLanguageServerInstallRequest
    ): Promise<ManagedLanguageServerInstallResult> => {
      const host = parseExecutionHostId(request.executionHostId)
      if (host?.kind === 'ssh') {
        return getSshManagedInstaller(host.targetId, store).install({
          tool: request.tool,
          version: request.version,
          route: request.route
        })
      }
      if (host?.kind === 'local') {
        return installer.install({
          tool: request.tool,
          version: request.version,
          route: request.route
        })
      }
      throw new Error(
        'Managed installs on Runtime Hosts run through the Host RPC capability; use the Runtime adapter'
      )
    }
  )
  ipcMain.handle(
    'codeIntelligence:cancelManagedLanguageServerInstall',
    (_event, request: { executionHostId: string; tool: LanguageServerKind }): boolean => {
      const host = parseExecutionHostId(request.executionHostId)
      if (host?.kind === 'ssh') {
        return getSshManagedInstaller(host.targetId, store).cancel(request.tool)
      }
      return installer.cancel(request.tool)
    }
  )
  ipcMain.handle(
    'codeIntelligence:rollbackManagedLanguageServer',
    async (
      _event,
      request: { executionHostId: string; tool: LanguageServerKind }
    ): Promise<ManagedLanguageServerRollbackResult> => {
      const host = parseExecutionHostId(request.executionHostId)
      if (host?.kind === 'ssh') {
        return getSshManagedInstaller(host.targetId, store).rollback(request.tool)
      }
      return installer.rollback(request.tool)
    }
  )
  ipcMain.handle('codeIntelligence:managedInstallDownloadsPath', (): string =>
    // Offline guidance (#35): where the client should save the archive it
    // downloads manually for the client-file route.
    app.getPath('downloads')
  )
}
