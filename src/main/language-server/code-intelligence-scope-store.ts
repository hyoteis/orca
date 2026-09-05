import { posix, win32 } from 'node:path'
import type {
  CodeIntelligenceScope,
  CodeIntelligenceScopeConsent
} from '../../shared/code-intelligence-scope'
import {
  canonicalConfigurationJson,
  codeIntelligenceConfigurationSnapshot,
  hasLegacyCodeIntelligenceMembers,
  normalizeCodeIntelligenceScope,
  scopeConfigurationPayload
} from '../../shared/code-intelligence-scope'
import type {
  LanguageServerKind,
  LanguageServerLaunchRequest,
  LanguageServerSessionOpenRequest
} from '../../shared/language-server-session'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import type { GlobalSettings, Repo } from '../../shared/types'
import {
  grantCodeIntelligenceConsent,
  hasCurrentCodeIntelligenceConsent
} from './code-intelligence-scope-consent'
import { languageServerKindForScope } from '../../shared/code-intelligence-scope'

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
  /** Launch changed → running sessions must restart. Member-only edits keep
   * sessions alive (spec §5); revision/consent still move via `scope`. */
  restartRequired: boolean
}

// Canonical serializers throughout — the same one the consent fingerprint
// hashes, so revision bumps can never drift from consent staleness on
// key-order-only payload differences.
function sameConfiguration(left: CodeIntelligenceScope, right: CodeIntelligenceScope): boolean {
  return (
    codeIntelligenceConfigurationSnapshot(left) === codeIntelligenceConfigurationSnapshot(right)
  )
}

/** Config payload without members — member-only edits keep the clangd session
 * alive (spec §5: the atomic CDB rewrite is picked up lazily), while any other
 * change alters the launch and must restart it. */
function launchConfigurationPayload(scope: CodeIntelligenceScope): Record<string, unknown> {
  const { members: _members, ...payload } = scopeConfigurationPayload(
    scope
  ) as Record<string, unknown>
  return payload
}

function sameLaunchConfiguration(
  left: CodeIntelligenceScope,
  right: CodeIntelligenceScope
): boolean {
  return (
    canonicalConfigurationJson(launchConfigurationPayload(left)) ===
    canonicalConfigurationJson(launchConfigurationPayload(right))
  )
}

function languageServerKind(scope: CodeIntelligenceScope): LanguageServerKind {
  return languageServerKindForScope(scope.language)
}

function validateWorkspaceRoot(scope: CodeIntelligenceScope): void {
  if (
    !scope.workspaceRoot ||
    (!posix.isAbsolute(scope.workspaceRoot) && !win32.isAbsolute(scope.workspaceRoot))
  ) {
    throw new Error('Code intelligence workspace root must be an absolute Host path')
  }
}

/** Resolves the active managed version's launch command on the scope's Host;
 * null when no managed install is active there. */
export type ManagedLanguageServerLaunchResolver = (
  scope: CodeIntelligenceScope
) => Promise<{ executable: string; args: readonly string[] } | null>

export class CodeIntelligenceScopeStore {
  constructor(
    private readonly store: ScopeSettingsStore,
    private readonly resolveManagedLaunch: ManagedLanguageServerLaunchResolver = async () => null
  ) {}

  list(): readonly CodeIntelligenceScope[] {
    const raw = this.store.getSettings().codeIntelligenceScopes ?? []
    // Lazy no-compat migration: map legacy {relativePath} members to {path},
    // drop the setupStatus (its compileCommandsDir points at a swept hash dir),
    // and persist once so later reads never see the old shape again.
    const migrated = raw.some(hasLegacyCodeIntelligenceMembers)
    const scopes = raw.map((scope) =>
      hasLegacyCodeIntelligenceMembers(scope)
        ? normalizeCodeIntelligenceScope({ ...scope, setupStatus: undefined })
        : normalizeCodeIntelligenceScope(scope)
    )
    if (migrated) {
      this.persist(scopes)
    }
    return scopes.map((scope) => structuredClone(scope))
  }

  upsert(input: CodeIntelligenceScope): CodeIntelligenceScopeMutation {
    let next = normalizeCodeIntelligenceScope(input)
    this.validateWorkspaceBinding(next)
    const scopes = [...this.list()]
    const index = scopes.findIndex((scope) => scope.id === next.id)
    const prior = index !== -1 ? scopes[index] : null
    const configurationChanged = prior ? !sameConfiguration(prior, next) : false
    // Restart only when the launch itself changed; member-only changes bump the
    // revision (consent chain) while the running clangd session stays up.
    const restartRequired = prior
      ? configurationChanged && !sameLaunchConfiguration(prior, next)
      : false
    next = prior
      ? {
          ...next,
          revision: configurationChanged ? prior.revision + 1 : prior.revision,
          // Keep the prior consent through changes: its fingerprint no longer
          // matches (authorizeSession refuses it), while its member snapshot
          // lets surfaces show what moved since authorization.
          consent: prior.consent
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

  async authorizeSession(request: LanguageServerSessionOpenRequest): Promise<LanguageServerLaunchRequest> {
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

  private async toLaunchRequest(
    scope: CodeIntelligenceScope,
    request: LanguageServerSessionOpenRequest
  ): Promise<LanguageServerLaunchRequest> {
    this.validateWorkspaceBinding(scope)
    if (scope.serverSource.type === 'managed') {
      const kind = languageServerKind(scope)
      const command = await this.resolveManagedLaunch(scope)
      if (!command && parseExecutionHostId(scope.executionHostId)?.kind !== 'runtime') {
        throw new Error(
          `No managed ${kind} version is active on this Host; install it before enabling the managed source`
        )
      }
      return {
        ...request,
        kind,
        workspaceRoot: scope.workspaceRoot,
        executionHostId: scope.executionHostId,
        ...(command ? { command: { executable: command.executable, args: [...command.args] } } : {}),
        managed: { tool: kind, ...(scope.serverSource.version ? { version: scope.serverSource.version } : {}) },
        members: structuredClone(scope.members)
      }
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
