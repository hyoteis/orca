import { app, BrowserWindow, ipcMain } from 'electron'
import { join, posix } from 'node:path'
import { rm } from 'node:fs/promises'
import type {
  CodeIntelligenceScope,
  CodeIntelligenceScopeChange
} from '../../shared/code-intelligence-scope'
import type { LanguageServerSessionOpenRequest } from '../../shared/language-server-session'
import type { CodeIntelligenceScopeStore } from '../language-server/code-intelligence-scope-store'
import type { Store } from '../persistence'
import { CodeIntelligenceCppSetup } from '../language-server/code-intelligence-cpp-setup'
import { CodeIntelligenceSshCppSetup } from '../language-server/code-intelligence-ssh-cpp-setup'
import {
  cppScopeDirectoryName,
  cppScopeDirectoryPath,
  remoteCppScopeDirectoryPath,
  remoteCppScopesRootPath,
  sweepOrphanCppScopeDirectories
} from '../language-server/code-intelligence-setup-cache'
import {
  buildRemoteScopeDirectoryDeleteCommand,
  buildRemoteListSubdirectoriesCommand,
  SshSetupExecQueue
} from '../language-server/code-intelligence-ssh-setup-exec'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { getSshConnectionManager, getRegisteredSshState } from './ssh'
import { subscribeSshTransportConnected } from './ssh-transport-connected'
import { registerManagedLanguageServerInstallHandlers } from './code-intelligence-managed-install'

function broadcastScopeChange(change: CodeIntelligenceScopeChange): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('codeIntelligence:scopeChanged', change)
    }
  }
}

/**
 * Best-effort teardown of the scope's stable directory on its owning host
 * (spec §5). An offline SSH host keeps the directory: it is a pure cache, and
 * the reconnect sweep removes it later. Failures stay silent for the same
 * reason — the sweep is the safety net.
 */
async function deleteCppScopeDirectory(
  scope: CodeIntelligenceScope,
  cppCacheRoot: string
): Promise<void> {
  if (scope.language !== 'cpp') {
    return
  }
  const host = parseExecutionHostId(scope.executionHostId)
  try {
    if (host?.kind === 'ssh') {
      const manager = getSshConnectionManager()
      const connection = manager?.getConnection(host.targetId)
      if (!connection) {
        return
      }
      const queue = new SshSetupExecQueue(connection)
      const home = await queue.capture('printf %s "$HOME"')
      await queue.exec(
        buildRemoteScopeDirectoryDeleteCommand(remoteCppScopeDirectoryPath(home, scope.id))
      )
    } else if (host?.kind === 'local') {
      await rm(cppScopeDirectoryPath(cppCacheRoot, scope.id), { recursive: true, force: true })
    }
  } catch {
    // Offline mid-delete or rm failure: the orphan sweep reclaims it.
  }
}

/**
 * Reconnect sweep (spec §5/§6): scope directories left behind on an SSH host
 * (removed while offline, or failed deletes) are stale caches — delete them
 * silently; the next connection retries.
 */
async function sweepRemoteOrphanCppScopeDirectories(
  scopes: CodeIntelligenceScopeStore,
  targetId: string
): Promise<void> {
  try {
    const manager = getSshConnectionManager()
    const connection = manager?.getConnection(targetId)
    if (!connection) {
      return
    }
    const live = new Set(
      scopes
        .list()
        .filter(
          (scope) =>
            scope.language === 'cpp' && scope.executionHostId === `ssh:${targetId}`
        )
        .map((scope) => cppScopeDirectoryName(scope.id))
    )
    const queue = new SshSetupExecQueue(connection)
    const home = await queue.capture('printf %s "$HOME"')
    const scopesRoot = remoteCppScopesRootPath(home)
    const listing = await queue.exec(buildRemoteListSubdirectoriesCommand(scopesRoot))
    if (listing.code !== 0) {
      return // scopes root absent — nothing to sweep
    }
    const orphans = listing.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => posix.basename(line))
      .filter((name) => !live.has(name))
    for (const name of orphans) {
      await queue.exec(buildRemoteScopeDirectoryDeleteCommand(posix.join(scopesRoot, name)))
    }
  } catch {
    // Best-effort: a dead transport or failing rm waits for the next reconnect.
  }
}

export function registerCodeIntelligenceHandlers(
  scopes: CodeIntelligenceScopeStore,
  store: Store
): void {
  const cppCacheRoot = join(app.getPath('userData'), 'code-intelligence', 'cpp')
  const cppSetup = new CodeIntelligenceCppSetup(store, cppCacheRoot)
  void sweepOrphanCppScopeDirectories(
    cppCacheRoot,
    scopes
      .list()
      .filter((scope) => scope.language === 'cpp' && scope.executionHostId === 'local')
      .map((scope) => scope.id)
  )
  const sshCppSetup = new CodeIntelligenceSshCppSetup(store, {
    getConnection: (targetId) => getSshConnectionManager()?.getConnection(targetId),
    // Why: remotePlatform lives on the relay session; the raw manager state never
    // carries it, so the enriched registered state is the only truthful source.
    getPlatform: (targetId) => getRegisteredSshState(targetId)?.remotePlatform
  })
  // Reconnect sweep = deferred delete for scopes removed while offline.
  subscribeSshTransportConnected((targetId) => {
    void sweepRemoteOrphanCppScopeDirectories(scopes, targetId)
  })
  ipcMain.handle('codeIntelligence:setupCpp', async (_event, request) => {
    const repo = store.getRepo(request.repoId)
    const host = repo ? parseExecutionHostId(getRepoExecutionHostId(repo)) : null
    return host?.kind === 'ssh' ? sshCppSetup.run(request) : cppSetup.run(request)
  })
  ipcMain.handle('codeIntelligence:upsertScope', (_event, scope: CodeIntelligenceScope) => {
    const result = scopes.upsert(scope)
    if (result.restartRequired) {
      broadcastScopeChange({
        scopeId: result.scope.id,
        revision: result.scope.revision,
        removed: false
      })
    }
    return result.scope
  })
  ipcMain.handle('codeIntelligence:removeScope', async (_event, scopeId: string) => {
    // Snapshot before the store drops it — the id decides the directory name.
    const scope = scopes.list().find((candidate) => candidate.id === scopeId)
    const result = scopes.remove(scopeId)
    if (result.removed) {
      broadcastScopeChange({ scopeId, revision: null, removed: true })
      if (scope) {
        await deleteCppScopeDirectory(scope, cppCacheRoot)
      }
    }
    return result.removed
  })
  ipcMain.handle(
    'codeIntelligence:grantConsent',
    (_event, request: Pick<LanguageServerSessionOpenRequest, 'scopeId' | 'revision'>) =>
      scopes.grantConsent(request.scopeId, request.revision)
  )
  ipcMain.handle(
    'codeIntelligence:authorizeSession',
    (_event, request: LanguageServerSessionOpenRequest) => scopes.authorizeSession(request)
  )
  registerManagedLanguageServerInstallHandlers(store)
}
