import {
  assertManagedLanguageServerTool,
  compareManagedLanguageServerVersions,
  manifestEntryForLaunch,
  manifestEntryForVersion,
  resolveManagedLanguageServerCommand,
  resolveManagedLanguageServerEntry
} from '../../shared/managed-language-server'
import type {
  ManagedLanguageServerActivationRecord,
  ManagedLanguageServerHostTarget,
  ManagedLanguageServerInstallEvent,
  ManagedLanguageServerInstallResult,
  ManagedLanguageServerInstallRoute,
  ManagedLanguageServerInstallState,
  ManagedLanguageServerManifest,
  ManagedLanguageServerManifestEntry,
  ManagedLanguageServerRollbackResult,
  ManagedLanguageServerToolId
} from '../../shared/managed-language-server'
import type { LanguageServerKind } from '../../shared/language-server-session'
import type { ManagedLanguageServerInstallHost } from './managed-language-server-install-host'
import { managedVersionDirectory } from './managed-language-server-install-root'

export type ManagedLanguageServerInstallerOptions = {
  /** Local layout root — only resolveActiveCommand still builds paths here;
   * SSH Hosts resolve launch commands in their adapter path instead. */
  root?: string
  manifest: ManagedLanguageServerManifest
  host: ManagedLanguageServerInstallHost
  /** Versions scopes pin via serverSource.version; GC must keep them. */
  getPinnedVersions?: (tool: LanguageServerKind) => Promise<readonly string[]>
  emit?: (event: ManagedLanguageServerInstallEvent) => void
}

/**
 * The managed language-server transaction pipeline (#15, #151): lock/abort/
 * event orchestration, entry matching, branch policy (already-active /
 * installed / acquire), activation swaps with rollback retention, and GC
 * keep-sets — Host-agnostic on top of ManagedLanguageServerInstallHost.
 * One per-tool lock deduplicates identical concurrent requests; a failure or
 * cancellation removes only staging; the active version never changes.
 */
export class ManagedLanguageServerInstaller {
  private readonly locks = new Map<string, Promise<ManagedLanguageServerInstallResult>>()
  private readonly aborts = new Map<string, AbortController>()
  private hostTarget: Promise<ManagedLanguageServerHostTarget> | null = null

  constructor(private readonly options: ManagedLanguageServerInstallerOptions) {}

  install(args: {
    tool: LanguageServerKind
    version?: string
    route: ManagedLanguageServerInstallRoute
    signal?: AbortSignal
    /** Per-call progress sink (relay RPC streams); falls back to options.emit. */
    onEvent?: (event: ManagedLanguageServerInstallEvent) => void
  }): Promise<ManagedLanguageServerInstallResult> {
    const managedTool = assertManagedLanguageServerTool(args.tool)
    const running = this.locks.get(managedTool)
    if (running) {
      return running
    }
    const controller = new AbortController()
    args.signal?.addEventListener('abort', () => controller.abort(args.signal!.reason), {
      once: true
    })
    const emit = (event: ManagedLanguageServerInstallEvent): void => {
      ;(args.onEvent ?? this.options.emit)?.(event)
    }
    const promise = this.runInstall(args, controller, emit)
      .catch((error): ManagedLanguageServerInstallResult => {
        const message = error instanceof Error ? error.message : String(error)
        emit({
          executionHostId: 'local',
          tool: managedTool,
          version: '',
          phase: 'error',
          message,
          canceled: controller.signal.aborted
        })
        return controller.signal.aborted
          ? { status: 'canceled' }
          : { status: 'failed', error: message }
      })
      .finally(() => {
        this.locks.delete(managedTool)
        this.aborts.delete(managedTool)
      })
    this.locks.set(managedTool, promise)
    return promise
  }

  cancel(tool: LanguageServerKind): boolean {
    const controller = this.aborts.get(assertManagedLanguageServerTool(tool))
    controller?.abort(new Error('Managed language-server install was canceled'))
    return controller !== undefined
  }

  async rollback(tool: LanguageServerKind): Promise<ManagedLanguageServerRollbackResult> {
    const managedTool = assertManagedLanguageServerTool(tool)
    const record = await this.options.host.readActivation(managedTool)
    if (!record?.rollback) {
      return { status: 'no-rollback' }
    }
    try {
      await this.probeVersion(managedTool, record.rollback.version)
      await this.options.host.writeActivation(managedTool, {
        active: record.rollback,
        rollback: record.active
      })
      await this.gc(managedTool)
      return { status: 'rolled-back', version: record.rollback.version }
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }

  async state(tool: LanguageServerKind): Promise<ManagedLanguageServerInstallState> {
    const managedTool = assertManagedLanguageServerTool(tool)
    const [record, installedVersions] = await Promise.all([
      this.options.host.readActivation(managedTool),
      this.options.host.listVersions(managedTool)
    ])
    const unsupported = await this.options.host.unsupportedReason?.()
    if (unsupported) {
      return {
        tool,
        supported: false,
        unsupportedReason: unsupported,
        activeVersion: record?.active.version ?? null,
        rollbackVersion: record?.rollback?.version ?? null,
        installedVersions,
        latestEntry: null,
        updateAvailable: false
      }
    }
    const resolved = resolveManagedLanguageServerEntry(
      this.options.manifest,
      { tool: managedTool },
      await this.resolveHostTarget()
    )
    if (!('entry' in resolved)) {
      return {
        tool,
        supported: false,
        unsupportedReason: resolved.unsupported,
        activeVersion: record?.active.version ?? null,
        rollbackVersion: record?.rollback?.version ?? null,
        installedVersions,
        latestEntry: null,
        updateAvailable: false
      }
    }
    const activeVersion = record?.active.version ?? null
    return {
      tool,
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

  /** Launch command for the active (or scope-pinned) managed version. */
  async resolveActiveCommand(
    tool: LanguageServerKind,
    version?: string
  ): Promise<{ executable: string; args: string[] } | null> {
    if (!this.options.root) {
      return null
    }
    const managedTool = assertManagedLanguageServerTool(tool)
    const record = await this.options.host.readActivation(managedTool)
    if (!record) {
      return null
    }
    const entry = manifestEntryForLaunch(
      this.options.manifest,
      record,
      { tool: managedTool, version },
      { platform: process.platform, arch: process.arch }
    )
    if (!entry) {
      return null
    }
    return resolveManagedLanguageServerCommand(entry.command, {
      root: managedVersionDirectory(this.options.root, entry.tool, entry.version)
    })
  }

  private async runInstall(
    args: { tool: LanguageServerKind; version?: string; route: ManagedLanguageServerInstallRoute },
    controller: AbortController,
    emit: (event: ManagedLanguageServerInstallEvent) => void
  ): Promise<ManagedLanguageServerInstallResult> {
    const managedTool = assertManagedLanguageServerTool(args.tool)
    this.aborts.set(managedTool, controller)
    const unsupported = await this.options.host.unsupportedReason?.()
    if (unsupported) {
      return { status: 'unsupported', reason: unsupported }
    }
    const resolved = resolveManagedLanguageServerEntry(
      this.options.manifest,
      { tool: managedTool, version: args.version },
      await this.resolveHostTarget()
    )
    if (!('entry' in resolved)) {
      return { status: 'unsupported', reason: resolved.unsupported }
    }
    const { entry } = resolved
    controller.signal.throwIfAborted()
    const record = await this.options.host.readActivation(entry.tool)
    if (record?.active.version === entry.version) {
      await this.probeVersion(entry.tool, entry.version)
      return { status: 'already-active', version: entry.version }
    }
    if ((await this.options.host.listVersions(entry.tool)).includes(entry.version)) {
      await this.probeVersion(entry.tool, entry.version)
      await this.activate(entry, record)
    } else {
      await this.options.host.acquire({
        entry,
        route: args.route,
        signal: controller.signal,
        emit: (phase, extra) =>
          emit({
            executionHostId: 'local',
            tool: entry.tool,
            version: entry.version,
            phase,
            ...extra
          })
      })
      await this.activate(entry, record)
    }
    emit({ executionHostId: 'local', tool: entry.tool, version: entry.version, phase: 'complete' })
    await this.gc(entry.tool)
    return { status: 'installed', version: entry.version }
  }

  private async probeVersion(tool: ManagedLanguageServerToolId, version: string): Promise<void> {
    const entry = manifestEntryForVersion(
      this.options.manifest,
      tool,
      version,
      await this.resolveHostTarget()
    )
    if (!entry) {
      throw new Error(`No trusted manifest entry for ${tool} ${version}`)
    }
    await this.options.host.probeVersion(entry)
  }

  private async activate(
    entry: ManagedLanguageServerManifestEntry,
    prior: ManagedLanguageServerActivationRecord | null
  ): Promise<void> {
    const next = this.activationFor(entry)
    if (prior?.active && prior.active.version !== entry.version) {
      next.rollback = prior.active
    }
    await this.options.host.writeActivation(entry.tool, next)
  }

  private activationFor(
    entry: ManagedLanguageServerManifestEntry
  ): ManagedLanguageServerActivationRecord {
    return { active: { version: entry.version, entryId: entry.id, activatedAt: Date.now() } }
  }

  /** GC protects active, rollback, and scope-pinned versions; staging is
   * skipped. Best-effort end to end: an unreachable Host or an in-use
   * directory retries on the next install and must never fail a completed
   * activation swap. ponytail: in-use protection approximated — sessions
   * launch from `active`. */
  private async gc(tool: ManagedLanguageServerToolId): Promise<void> {
    try {
      const record = await this.options.host.readActivation(tool)
      const pinned = (await this.options.getPinnedVersions?.(tool)) ?? []
      const keep = new Set<string>(
        [record?.active?.version, record?.rollback?.version, ...pinned].filter(
          (version): version is string => typeof version === 'string'
        )
      )
      for (const version of await this.options.host.listVersions(tool)) {
        if (!keep.has(version)) {
          await this.options.host.removeVersion(tool, version).catch(() => {})
        }
      }
    } catch {
      // Keep-set computation failed — collect until the next install.
    }
  }

  private resolveHostTarget(): Promise<ManagedLanguageServerHostTarget> {
    // A rejected probe (Host was unreachable) must not pin the failure for
    // the installer's lifetime.
    this.hostTarget ??= this.options.host.hostTarget().catch((error) => {
      this.hostTarget = null
      throw error
    })
    return this.hostTarget
  }
}
