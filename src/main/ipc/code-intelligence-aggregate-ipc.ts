import { BrowserWindow, ipcMain } from 'electron'
import type {
  CodeIntelligenceBasicOptions,
  CodeIntelligenceScope,
  CodeIntelligenceScopeChange
} from '../../shared/code-intelligence-scope'
import {
  getCodeIntelligenceWorkspaceKey,
  getCppScopeIdForRepo
} from '../../shared/code-intelligence-scope'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import type { CodeIntelligenceScopeStore } from '../language-server/code-intelligence-scope-store'
import type { Store } from '../persistence'
import type { AggregateDriftProbe } from '../language-server/code-intelligence-aggregate-refresh'
import {
  getAggregateRefreshCoordinator,
  localAggregateDriftProbe,
  LocalAggregateWatchSet,
  syncAggregateRefreshTracking
} from '../language-server/code-intelligence-aggregate-refresh-wiring'
import { buildAggregateCompileDatabase } from '../language-server/code-intelligence-aggregate-cdb'
import { createLocalCppSetupHost } from '../language-server/code-intelligence-cpp-setup-local-host'
import { createSshCppSetupHost } from '../language-server/code-intelligence-cpp-setup-ssh-host'
import { cppScopeDirectoryPath } from '../language-server/code-intelligence-setup-cache'
import { registerAggregateSessionOpenDriftCheck } from './language-server-sessions'

export type AggregateIpcDependencies = {
  getConnection: (targetId: string) => unknown
  getPlatform: (targetId: string) => string | undefined
}

function broadcastScopeChange(change: CodeIntelligenceScopeChange): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('codeIntelligence:scopeChanged', change)
    }
  }
}

/**
 * Aggregate code-intelligence IPC (#135–#138): refresh chain wiring, the
 * session-open drift re-check, and the workspace-level Configure Code
 * save/revalidate handlers. Split from code-intelligence.ts to respect the
 * max-lines budget.
 */
export function registerAggregateCodeIntelligenceHandlers(
  scopes: CodeIntelligenceScopeStore,
  store: Store,
  cppCacheRoot: string,
  dependencies: AggregateIpcDependencies
): { syncAggregateTracking: () => void } {
  const aggregateWatch = new LocalAggregateWatchSet()
  const coordinator = getAggregateRefreshCoordinator()
  const hostFor = (scope: CodeIntelligenceScope) =>
    parseExecutionHostId(scope.executionHostId)?.kind === 'ssh'
      ? createSshCppSetupHost(dependencies as never)
      : createLocalCppSetupHost({ cacheRoot: cppCacheRoot })
  const rebuildAggregate = async (scope: CodeIntelligenceScope): Promise<void> => {
    const host = hostFor(scope)
    const repo = store
      .getRepos()
      .find((candidate) => candidate.id === scope.workspaceKey.split(':').slice(1).join(':'))
    const scopeDirectory = repo
      ? await host.scopeDirectoryFor(repo)
      : cppScopeDirectoryPath(cppCacheRoot, scope.id)
    const built = await buildAggregateCompileDatabase({
      host,
      workspaceRoot: scope.workspaceRoot,
      members: scope.members,
      basicOptions: scope.basicOptions,
      scopeDirectory,
      initial: false
    })
    const databases = scope.members
      .map((member) => member.compileDatabase)
      .filter((path): path is string => path !== undefined)
    if (databases.length > 0) {
      const mtimes = (await host.statMtimes(databases)) ?? []
      coordinator.noteMerged(scope.id, mtimes.join('|'))
    }
    // Health rides the existing scope-snapshot push as an ephemeral field
    // (#136): revision null + removed false marks it health-only; nothing is
    // persisted into settings.
    broadcastScopeChange({
      scopeId: scope.id,
      revision: null,
      removed: false,
      mappingHealth: built.mappings.map((mapping) => ({
        id: mapping.id,
        memberPath: mapping.memberPath,
        compileDatabase: mapping.compileDatabase,
        state: mapping.state,
        ...(mapping.failure ? { failure: mapping.failure } : {})
      }))
    })
  }
  const syncAggregateTracking = (): void => {
    void syncAggregateRefreshTracking({ scopes, watch: aggregateWatch, rebuild: rebuildAggregate })
  }
  syncAggregateTracking()
  const driftProbeFor = (scope: CodeIntelligenceScope): AggregateDriftProbe =>
    parseExecutionHostId(scope.executionHostId)?.kind === 'ssh'
      ? async (paths) => {
          const mtimes = (await createSshCppSetupHost(dependencies as never).statMtimes(paths)) ?? []
          return mtimes.map((mtime) => (mtime === null ? null : String(mtime)))
        }
      : localAggregateDriftProbe
  /** Session-open drift re-check (spec §2 Step 3): out-of-band database edits
   * the watch missed trigger one single-flight re-merge before the session
   * reads the aggregate. Best-effort — a dead transport retries next open. */
  const refreshAggregateIfDrifted = async (scopeId: string): Promise<void> => {
    const scope = scopes.list().find((candidate) => candidate.id === scopeId)
    if (!scope) {
      return
    }
    try {
      await coordinator.refreshIfDrifted(scopeId, driftProbeFor(scope))
    } catch {
      // Probe failures are invisible: the next open retries.
    }
  }
  registerAggregateSessionOpenDriftCheck(refreshAggregateIfDrifted)

  // ── Workspace-level Configure Code (#138): supplied CDB | BASIC, one row. ──
  const upsertWorkspaceScope = async (request: {
    repoId: string
    mode: 'cdb' | 'basic'
    compileDatabase?: string
    basicOptions?: CodeIntelligenceBasicOptions
  }): Promise<CodeIntelligenceScope> => {
    const repo = store.getRepo(request.repoId)
    if (!repo) {
      throw new Error('Unknown workspace')
    }
    const existing = scopes.list().find((scope) => scope.id === getCppScopeIdForRepo(repo))
    const base =
      existing ?? {
        id: getCppScopeIdForRepo(repo),
        name: `${repo.displayName} C++`,
        executionHostId: getRepoExecutionHostId(repo),
        workspaceKey: getCodeIntelligenceWorkspaceKey(repo.id, repo.kind === 'folder'),
        workspaceRoot: repo.path,
        language: 'cpp' as const,
        members: [{ path: '.', visibleResults: true }],
        serverSource: { type: 'automatic' as const },
        enabled: true,
        revision: 0
      }
    const mutation = scopes.upsert({
      ...base,
      members: [
        {
          path: '.',
          visibleResults: true,
          ...(request.mode === 'cdb' && request.compileDatabase
            ? { compileDatabase: request.compileDatabase }
            : {})
        }
      ],
      ...(request.mode === 'basic' && request.basicOptions ? { basicOptions: request.basicOptions } : {})
    })
    if (mutation.restartRequired) {
      broadcastScopeChange({
        scopeId: mutation.scope.id,
        revision: mutation.scope.revision,
        removed: false
      })
    }
    syncAggregateTracking()
    return mutation.scope
  }
  ipcMain.handle(
    'codeIntelligence:configureAggregate',
    async (_event, request: Parameters<typeof upsertWorkspaceScope>[0]) => {
      const scope = await upsertWorkspaceScope(request)
      // Initial build: full validation; failures fail the save with a readable error.
      const host = hostFor(scope)
      const repo = store.getRepo(request.repoId)!
      const built = await buildAggregateCompileDatabase({
        host,
        workspaceRoot: scope.workspaceRoot,
        members: scope.members,
        basicOptions: scope.basicOptions,
        scopeDirectory: await host.scopeDirectoryFor(repo),
        initial: true
      })
      scopes.grantConsent(scope.id, scope.revision)
      coordinator.noteMerged(
        scope.id,
        ((await host.statMtimes(
          scope.members.map((member) => member.compileDatabase).filter((path): path is string => path !== undefined)
        )) ?? []).join('|')
      )
      return { scope, mappings: built.mappings, entryCount: built.entryCount }
    }
  )
  ipcMain.handle('codeIntelligence:revalidateAggregate', async (_event, request: { repoId: string }) => {
    const repo = store.getRepo(request.repoId)
    const scope = repo ? scopes.list().find((candidate) => candidate.id === getCppScopeIdForRepo(repo)) : null
    if (!repo || !scope) {
      throw new Error('Unknown workspace')
    }
    await rebuildAggregate(scope)
    const host = hostFor(scope)
    const built = await buildAggregateCompileDatabase({
      host,
      workspaceRoot: scope.workspaceRoot,
      members: scope.members,
      basicOptions: scope.basicOptions,
      scopeDirectory: await host.scopeDirectoryFor(repo),
      initial: false
    })
    return { mappings: built.mappings, entryCount: built.entryCount }
  })
  return { syncAggregateTracking }
}
