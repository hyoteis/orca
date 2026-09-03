import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { parseExecutionHostId } from '../../shared/execution-host'
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
import {
  installSshManagedLanguageServer,
  readSshManagedActivation,
  sshManagedRemoteArch,
  type SshManagedInstallContext
} from '../language-server/code-intelligence-ssh-managed-install'
import {
  gcSshManagedLanguageServerVersions,
  resolveSshManagedLanguageServerCommand,
  rollbackSshManagedLanguageServer,
  sshManagedLanguageServerState
} from '../language-server/code-intelligence-ssh-managed-install-state'
import { SshSetupExecQueue } from '../language-server/code-intelligence-ssh-setup-exec'
import { uploadFile as uploadFileViaSftp } from '../ssh/sftp-upload'
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
  installerSingleton ??= new ManagedLanguageServerInstaller({
    root: join(app.getPath('userData'), 'code-intelligence', 'managed'),
    manifest: MANAGED_LANGUAGE_SERVER_MANIFEST,
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

async function createSshManagedInstallContext(targetId: string): Promise<SshManagedInstallContext> {
  const connection = getSshConnectionManager()?.getConnection(targetId)
  if (!connection) {
    throw new Error(`SSH target is not connected: ${targetId}`)
  }
  const queue = new SshSetupExecQueue(connection)
  const home = await queue.capture('printf %s "$HOME"')
  const remotePlatform = getRegisteredSshState(targetId)?.remotePlatform ?? 'linux'
  const remoteArch = (await sshManagedRemoteArch(connection)) ?? 'x64'
  return {
    queue,
    home,
    remotePlatform,
    remoteArch,
    ...(remotePlatform === 'linux' ? { remoteGlibc: await probeRemoteGlibc(queue) } : {}),
    uploadFile: async (localPath, remotePath, signal) => {
      const sftp = await connection.sftp(signal ?? undefined)
      await uploadFileViaSftp(sftp, localPath, remotePath, signal ? { signal } : undefined)
    }
  }
}

/** `ldd --version | head -1` carries the remote glibc; failure = unknown. */
async function probeRemoteGlibc(queue: SshSetupExecQueue): Promise<string | undefined> {
  const result = await queue.exec('ldd --version 2>/dev/null | head -1')
  return result.code === 0 ? result.stdout.match(/\b(2\.\d+(?:\.\d+)?)\b/)?.[1] : undefined
}

export function registerManagedLanguageServerInstallHandlers(store: Store): void {
  const installer = getManagedLanguageServerInstaller(store)
  const sshInstallLocks = new Map<string, Promise<ManagedLanguageServerInstallResult>>()
  const sshInstallAborts = new Map<string, AbortController>()
  const emitSshTerminalEvent = (
    request: Pick<ManagedLanguageServerInstallRequest, 'executionHostId' | 'tool'>,
    result: ManagedLanguageServerInstallResult
  ): void => {
    // Terminal outcomes only — unsupported/already-active are not events.
    if (result.status === 'unsupported' || result.status === 'already-active') {
      return
    }
    const version = 'version' in result ? result.version : ''
    broadcastManagedInstallEvent({
      executionHostId: request.executionHostId,
      tool: request.tool,
      version,
      phase: result.status === 'installed' ? 'complete' : 'error',
      ...(result.status === 'failed' ? { message: result.error } : {}),
      ...(result.status === 'canceled' ? { canceled: true } : {})
    })
  }
  /** Remote GC after install/rollback: keep active, rollback, and pins. */
  const gcSshManaged = async (targetId: string, tool: LanguageServerKind): Promise<void> => {
    try {
      const ctx = await createSshManagedInstallContext(targetId)
      const record = await readSshManagedActivation(ctx, tool)
      await gcSshManagedLanguageServerVersions({
        ctx,
        tool,
        keepVersions: [
          record?.active.version,
          record?.rollback?.version,
          ...pinnedManagedVersions(store, tool)
        ].filter((version): version is string => typeof version === 'string')
      })
    } catch {
      // Best-effort: an unreachable host collects until the next install.
    }
  }
  const runSshManagedInstall = (
    targetId: string,
    request: ManagedLanguageServerInstallRequest,
    signal?: AbortSignal
  ): Promise<ManagedLanguageServerInstallResult> => {
    const key = `${targetId}:${request.tool}`
    const running = sshInstallLocks.get(key)
    if (running) {
      return running
    }
    const controller = new AbortController()
    signal?.addEventListener('abort', () => controller.abort(signal!.reason), { once: true })
    const promise = (async () => {
      sshInstallAborts.set(key, controller)
      try {
        return await installSshManagedLanguageServer({
          ctx: await createSshManagedInstallContext(targetId),
          manifest: MANAGED_LANGUAGE_SERVER_MANIFEST,
          tool: request.tool,
          version: request.version,
          route: request.route,
          signal: controller.signal
        })
      } catch (error) {
        return {
          status: 'failed' as const,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    })().finally(() => {
      sshInstallLocks.delete(key)
      sshInstallAborts.delete(key)
    })
    sshInstallLocks.set(key, promise)
    return promise
  }
  ipcMain.handle(
    'codeIntelligence:managedInstallState',
    async (
      _event,
      request: { executionHostId: string; tool: LanguageServerKind }
    ): Promise<ManagedLanguageServerInstallState> => {
      const host = parseExecutionHostId(request.executionHostId)
      if (host?.kind === 'ssh') {
        return sshManagedLanguageServerState({
          ctx: await createSshManagedInstallContext(host.targetId),
          manifest: MANAGED_LANGUAGE_SERVER_MANIFEST,
          tool: request.tool
        })
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
        const result = await runSshManagedInstall(host.targetId, request)
        emitSshTerminalEvent(request, result)
        if (result.status === 'installed') {
          await gcSshManaged(host.targetId, request.tool)
        }
        return result
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
        const controller = sshInstallAborts.get(`${host.targetId}:${request.tool}`)
        controller?.abort(new Error('Managed language-server install was canceled'))
        return controller !== undefined
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
        const result = await rollbackSshManagedLanguageServer({
          ctx: await createSshManagedInstallContext(host.targetId),
          manifest: MANAGED_LANGUAGE_SERVER_MANIFEST,
          tool: request.tool
        })
        if (result.status === 'rolled-back') {
          await gcSshManaged(host.targetId, request.tool)
        }
        return result
      }
      return installer.rollback(request.tool)
    }
  )
}
