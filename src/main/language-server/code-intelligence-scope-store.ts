import { posix, win32 } from 'node:path'
import type {
  CodeIntelligenceScope,
  CodeIntelligenceScopeConsent
} from '../../shared/code-intelligence-scope'
import {
  normalizeCodeIntelligenceScope,
  scopeConfigurationPayload
} from '../../shared/code-intelligence-scope'
import type {
  LanguageServerKind,
  LanguageServerLaunchRequest,
  LanguageServerSessionOpenRequest
} from '../../shared/language-server-session'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import type { GlobalSettings, Repo } from '../../shared/types'
import {
  grantCodeIntelligenceConsent,
  hasCurrentCodeIntelligenceConsent
} from './code-intelligence-scope-consent'

type ScopeSettingsStore = {
  getRepos: () => Repo[]
  getSettings: () => GlobalSettings
  updateSettings: (
    updates: Partial<GlobalSettings>,
    options?: { notifyListeners?: boolean; originWebContentsId?: number }
  ) => GlobalSettings
}

export type CodeIntelligenceScopeMutation = {
  scope: CodeIntelligenceScope
  scopes: readonly CodeIntelligenceScope[]
  restartRequired: boolean
}

function sameConfiguration(left: CodeIntelligenceScope, right: CodeIntelligenceScope): boolean {
  return (
    JSON.stringify(scopeConfigurationPayload(left)) ===
    JSON.stringify(scopeConfigurationPayload(right))
  )
}

function languageServerKind(scope: CodeIntelligenceScope): LanguageServerKind {
  return scope.language === 'cpp' ? 'clangd' : 'basedpyright'
}

function validateWorkspaceRoot(scope: CodeIntelligenceScope): void {
  if (
    !scope.workspaceRoot ||
    (!posix.isAbsolute(scope.workspaceRoot) && !win32.isAbsolute(scope.workspaceRoot))
  ) {
    throw new Error('Code intelligence workspace root must be an absolute Host path')
  }
}

export class CodeIntelligenceScopeStore {
  constructor(private readonly store: ScopeSettingsStore) {}

  list(): readonly CodeIntelligenceScope[] {
    return (this.store.getSettings().codeIntelligenceScopes ?? []).map((scope) =>
      structuredClone(normalizeCodeIntelligenceScope(scope))
    )
  }

  upsert(input: CodeIntelligenceScope): CodeIntelligenceScopeMutation {
    let next = normalizeCodeIntelligenceScope(input)
    this.validateWorkspaceBinding(next)
    const scopes = [...this.list()]
    const index = scopes.findIndex((scope) => scope.id === next.id)
    const prior = index !== -1 ? scopes[index] : null
    const restartRequired = prior ? !sameConfiguration(prior, next) : false
    next = prior
      ? {
          ...next,
          revision: restartRequired ? prior.revision + 1 : prior.revision,
          consent: restartRequired ? undefined : prior.consent
        }
      : { ...next, revision: 1, consent: undefined }
    if (index !== -1) {
      scopes[index] = next
    } else {
      scopes.push(next)
    }
    this.persist(scopes)
    return { scope: structuredClone(next), scopes, restartRequired }
  }

  remove(scopeId: string): { scopes: readonly CodeIntelligenceScope[]; removed: boolean } {
    const current = this.list()
    const scopes = current.filter((scope) => scope.id !== scopeId)
    const removed = scopes.length !== current.length
    if (removed) {
      this.persist(scopes)
    }
    return { scopes, removed }
  }

  grantConsent(scopeId: string, revision: number, now = Date.now()): CodeIntelligenceScope {
    const scopes = [...this.list()]
    const index = scopes.findIndex((scope) => scope.id === scopeId)
    if (index === -1) {
      throw new Error(`Unknown code intelligence scope: ${scopeId}`)
    }
    const scope = scopes[index]
    if (scope.revision !== revision) {
      throw new Error('Code intelligence scope revision changed before consent was granted')
    }
    const consent: CodeIntelligenceScopeConsent = grantCodeIntelligenceConsent(scope, now)
    const next = { ...scope, consent }
    scopes[index] = next
    this.persist(scopes)
    return structuredClone(next)
  }

  resolveProbe(scopeId: string): LanguageServerLaunchRequest {
    const scope = this.requireScope(scopeId)
    return this.toLaunchRequest(scope, {
      sessionId: `probe:${scope.id}`,
      scopeId: scope.id,
      revision: scope.revision
    })
  }

  authorizeSession(request: LanguageServerSessionOpenRequest): LanguageServerLaunchRequest {
    const scope = this.requireScope(request.scopeId)
    if (scope.revision !== request.revision) {
      throw new Error('Code intelligence scope revision is stale')
    }
    if (!scope.enabled) {
      throw new Error('Code intelligence scope is disabled')
    }
    if (!hasCurrentCodeIntelligenceConsent(scope)) {
      throw new Error('Current code intelligence configuration requires launch consent')
    }
    return this.toLaunchRequest(scope, request)
  }

  private requireScope(scopeId: string): CodeIntelligenceScope {
    const scope = this.list().find((candidate) => candidate.id === scopeId)
    if (!scope) {
      throw new Error(`Unknown code intelligence scope: ${scopeId}`)
    }
    return scope
  }

  private toLaunchRequest(
    scope: CodeIntelligenceScope,
    request: LanguageServerSessionOpenRequest
  ): LanguageServerLaunchRequest {
    this.validateWorkspaceBinding(scope)
    if (scope.serverSource.type === 'managed') {
      throw new Error('Managed language servers are not available in Phase 1')
    }
    return {
      ...request,
      kind: languageServerKind(scope),
      workspaceRoot: scope.workspaceRoot,
      executionHostId: scope.executionHostId,
      command:
        scope.serverSource.type === 'custom'
          ? {
              executable: scope.serverSource.executable,
              args: [...scope.serverSource.args]
            }
          : undefined,
      members: structuredClone(scope.members)
    }
  }

  private validateWorkspaceBinding(scope: CodeIntelligenceScope): void {
    validateWorkspaceRoot(scope)
    const separator = scope.workspaceKey.indexOf(':')
    const kind = scope.workspaceKey.slice(0, separator)
    const workspaceId = scope.workspaceKey.slice(separator + 1)
    const repo = this.store.getRepos().find((candidate) => candidate.id === workspaceId)
    if (!repo) {
      throw new Error('Code intelligence scope must reference a known workspace')
    }
    const expectedKind = isFolderRepo(repo) ? 'folder' : 'worktree'
    if (kind !== expectedKind) {
      throw new Error('Code intelligence workspace kind does not match the selected project')
    }
    if (getRepoExecutionHostId(repo) !== scope.executionHostId) {
      throw new Error('Code intelligence scope Host does not own the selected workspace')
    }
    const normalizeRoot = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '')
    if (normalizeRoot(repo.path) !== normalizeRoot(scope.workspaceRoot)) {
      throw new Error('Code intelligence workspace root does not match the selected workspace')
    }
  }

  private persist(scopes: readonly CodeIntelligenceScope[]): void {
    this.store.updateSettings(
      { codeIntelligenceScopes: scopes.map((scope) => structuredClone(scope)) },
      { notifyListeners: true }
    )
  }
}
