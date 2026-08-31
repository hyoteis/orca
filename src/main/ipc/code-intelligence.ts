import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import type {
  CodeIntelligenceProbeResult,
  CodeIntelligenceScope,
  CodeIntelligenceScopeChange
} from '../../shared/code-intelligence-scope'
import type { LanguageServerSessionOpenRequest } from '../../shared/language-server-session'
import type { CodeIntelligenceScopeStore } from '../language-server/code-intelligence-scope-store'
import type { Store } from '../persistence'
import { CodeIntelligenceCppSetup } from '../language-server/code-intelligence-cpp-setup'
import { CodeIntelligenceSshCppSetup } from '../language-server/code-intelligence-ssh-cpp-setup'
import { sweepOrphanCppScopeDirectories } from '../language-server/code-intelligence-setup-cache'
import { probeLocalLanguageServer } from '../language-server/local-language-server-probe'
import { resolveDefaultLocalLanguageServerCommand } from '../language-server/local-language-server-session-manager'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import {
  buildWindowsLanguageServerCommand,
  probeSshLanguageServer
} from '../ssh/ssh-language-server-session-manager'
import { getSshConnectionManager } from './ssh'

function broadcastScopeChange(change: CodeIntelligenceScopeChange): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('codeIntelligence:scopeChanged', change)
    }
  }
}

function installCommand(
  kind: 'basedpyright' | 'pyright' | 'clangd',
  platform: string
): string | undefined {
  if (kind !== 'clangd') {
    return 'python -m pip install --user basedpyright'
  }
  if (platform === 'win32') {
    return 'winget install LLVM.LLVM'
  }
  if (platform === 'darwin') {
    return 'brew install llvm'
  }
  return 'sudo apt-get install clangd'
}

async function probeScope(
  scopes: CodeIntelligenceScopeStore,
  scopeId: string
): Promise<CodeIntelligenceProbeResult> {
  const launch = scopes.resolveProbe(scopeId)
  const host = parseExecutionHostId(launch.executionHostId)
  if (!host) {
    return { available: false, message: 'Invalid execution Host' }
  }
  if (host.kind === 'runtime') {
    return {
      available: false,
      message: 'Re-detect from a terminal on the selected Runtime Host',
      installCommand: installCommand(launch.kind, 'runtime')
    }
  }
  const command = resolveDefaultLocalLanguageServerCommand(launch)
  try {
    if (host.kind === 'local') {
      return { available: true, version: await probeLocalLanguageServer(command) }
    }
    const manager = getSshConnectionManager()
    const connection = manager?.getConnection(host.targetId)
    if (!connection) {
      throw new Error(`SSH target is not connected: ${host.targetId}`)
    }
    const platform = manager?.getState(host.targetId)?.remotePlatform ?? 'linux'
    const buildCommand = platform === 'win32' ? buildWindowsLanguageServerCommand : undefined
    return {
      available: true,
      version: await probeSshLanguageServer(connection, command, buildCommand)
    }
  } catch (error) {
    const platform =
      host.kind === 'local'
        ? process.platform
        : (getSshConnectionManager()?.getState(host.targetId)?.remotePlatform ?? 'linux')
    return {
      available: false,
      message: error instanceof Error ? error.message : String(error),
      installCommand: launch.command ? undefined : installCommand(launch.kind, platform)
    }
  }
}

export function registerCodeIntelligenceHandlers(
  scopes: CodeIntelligenceScopeStore,
  store: Store
): void {
  const cppCacheRoot = join(app.getPath('userData'), 'code-intelligence', 'cpp')
  const cppSetup = new CodeIntelligenceCppSetup(store, cppCacheRoot)
  void sweepOrphanCppScopeDirectories(cppCacheRoot)
  const sshCppSetup = new CodeIntelligenceSshCppSetup(store, {
    getConnection: (targetId) => getSshConnectionManager()?.getConnection(targetId),
    getPlatform: (targetId) => getSshConnectionManager()?.getState(targetId)?.remotePlatform
  })
  ipcMain.handle('codeIntelligence:listScopes', () => scopes.list())
  ipcMain.handle('codeIntelligence:setupCpp', async (_event, request) => {
    const repo = store.getRepo(request.repoId)
    const host = repo ? parseExecutionHostId(getRepoExecutionHostId(repo)) : null
    return host?.kind === 'ssh' ? sshCppSetup.run(request) : cppSetup.run(request)
  })
  ipcMain.handle('codeIntelligence:probeScope', (_event, scopeId: string) =>
    probeScope(scopes, scopeId)
  )
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
  ipcMain.handle('codeIntelligence:removeScope', (_event, scopeId: string) => {
    const result = scopes.remove(scopeId)
    if (result.removed) {
      broadcastScopeChange({ scopeId, revision: null, removed: true })
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
}
