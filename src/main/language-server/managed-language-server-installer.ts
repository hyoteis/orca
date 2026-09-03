import { join } from 'node:path'
import {
  compareManagedLanguageServerVersions,
  resolveManagedLanguageServerCommand,
  resolveManagedLanguageServerEntry
} from '../../shared/managed-language-server'
import type {
  ManagedLanguageServerActivationRecord,
  ManagedLanguageServerInstallEvent,
  ManagedLanguageServerInstallPhase,
  ManagedLanguageServerInstallResult,
  ManagedLanguageServerInstallRoute,
  ManagedLanguageServerInstallState,
  ManagedLanguageServerManifest,
  ManagedLanguageServerManifestEntry,
  ManagedLanguageServerRollbackResult,
  ManagedLanguageServerToolId
} from '../../shared/managed-language-server'
import type { LanguageServerKind } from '../../shared/language-server-session'
import type { CppSetupCommandRunner } from './code-intelligence-cpp-setup-tools'
import { runCppSetupCommand } from './code-intelligence-cpp-setup-tools'
import {
  acquireManagedVersion,
  resolveLocalManagedHostTarget,
  isProbingManagedVersion,
  managedRuntimeRoot,
  probeManagedEntry
} from './managed-language-server-acquisition'
import type { FetchManagedArchive } from './managed-language-server-archive'
import {
  listManagedVersions,
  managedToolRoot,
  managedVersionDirectory,
  manifestEntryById,
  readManagedActivation,
  writeManagedActivation
} from './managed-language-server-install-root'

export type ManagedLanguageServerInstallerOptions = {
  /** Orca-private managed root: <userData>/code-intelligence/managed. */
  root: string
  manifest: ManagedLanguageServerManifest
  fetchArchive?: FetchManagedArchive
  run?: CppSetupCommandRunner
  /** Versions scopes pin via serverSource.version; GC must keep them. */
  getPinnedVersions?: (tool: LanguageServerKind) => Promise<readonly string[]>
  emit?: (event: ManagedLanguageServerInstallEvent) => void
}

/**
 * The local-Host managed language-server transaction (#15): acquisition runs
 * stage → verify → extract → probe → atomic rename, then activation swaps the
 * record atomically. A failure or cancellation removes only staging; the
 * active version never changes. One per-tool lock deduplicates identical
 * concurrent requests, and GC protects active/rollback/pinned versions.
 */
export class ManagedLanguageServerInstaller {
  private readonly locks = new Map<string, Promise<ManagedLanguageServerInstallResult>>()
  private readonly aborts = new Map<string, AbortController>()
  private hostTarget: Promise<{ platform: string; arch: string; glibcVersion?: string }> | null = null

  constructor(private readonly options: ManagedLanguageServerInstallerOptions) {}

  install(args: {
    tool: LanguageServerKind
    version?: string
    route: ManagedLanguageServerInstallRoute
    signal?: AbortSignal
    /** Per-call progress sink (relay RPC streams); falls back to options.emit. */
    onEvent?: (event: ManagedLanguageServerInstallEvent) => void
  }): Promise<ManagedLanguageServerInstallResult> {
    const running = this.locks.get(args.tool)
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
          tool: args.tool,
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
        this.locks.delete(args.tool)
        this.aborts.delete(args.tool)
      })
    this.locks.set(args.tool, promise)
    return promise
  }

  cancel(tool: LanguageServerKind): boolean {
    const controller = this.aborts.get(tool)
    controller?.abort(new Error('Managed language-server install was canceled'))
    return controller !== undefined
  }

  async rollback(tool: LanguageServerKind): Promise<ManagedLanguageServerRollbackResult> {
    const toolRoot = managedToolRoot(this.options.root, tool)
    const record = await readManagedActivation(toolRoot)
    if (!record?.rollback) {
      return { status: 'no-rollback' }
    }
    try {
      await this.probeVersion(tool, record.rollback.version)
      await writeManagedActivation(toolRoot, {
        active: record.rollback,
        rollback: record.active
      })
      await this.gc(tool)
      return { status: 'rolled-back', version: record.rollback.version }
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }

  async state(tool: LanguageServerKind): Promise<ManagedLanguageServerInstallState> {
    const toolRoot = managedToolRoot(this.options.root, tool)
    const [record, installedVersions] = await Promise.all([
      readManagedActivation(toolRoot),
      listManagedVersions(toolRoot)
    ])
    const resolved = resolveManagedLanguageServerEntry(
      this.options.manifest,
      { tool },
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
    const toolRoot = managedToolRoot(this.options.root, tool)
    const record = await readManagedActivation(toolRoot)
    if (!record) {
      return null
    }
    const entry =
      version !== undefined && version !== record.active.version
        ? this.entryForVersion(tool, version)
        : (manifestEntryById(this.options.manifest, record.active.entryId) ??
          this.entryForVersion(tool, record.active.version))
    if (!entry) {
      return null
    }
    return resolveManagedLanguageServerCommand(entry.command, {
      root: managedVersionDirectory(this.options.root, entry.tool, entry.version),
      runtimeRoot: managedRuntimeRoot(this.options.root, this.options.manifest, entry)
    })
  }

  private async runInstall(
    args: { tool: LanguageServerKind; version?: string; route: ManagedLanguageServerInstallRoute },
    controller: AbortController,
    emit: (event: ManagedLanguageServerInstallEvent) => void
  ): Promise<ManagedLanguageServerInstallResult> {
    this.aborts.set(args.tool, controller)
    const resolved = resolveManagedLanguageServerEntry(
      this.options.manifest,
      { tool: args.tool, version: args.version },
      await this.resolveHostTarget()
    )
    if (!('entry' in resolved)) {
      return { status: 'unsupported', reason: resolved.unsupported }
    }
    const { entry, runtimeEntry } = resolved
    controller.signal.throwIfAborted()
    const seams = {
      run: this.run,
      fetchArchive: this.options.fetchArchive,
      emit: (target: ManagedLanguageServerManifestEntry, phase: ManagedLanguageServerInstallPhase, extra?: { receivedBytes?: number; totalBytes?: number }) =>
        emit({
          executionHostId: 'local',
          tool: target.tool as LanguageServerKind,
          version: target.version,
          phase,
          ...extra
        })
    }
    if (runtimeEntry && !(await isProbingManagedVersion(this.options.root, this.options.manifest, runtimeEntry, this.run))) {
      await acquireManagedVersion({
        root: this.options.root,
        manifest: this.options.manifest,
        entry: runtimeEntry,
        route: { type: 'host-download' },
        signal: controller.signal,
        seams
      })
      await writeManagedActivation(
        managedToolRoot(this.options.root, runtimeEntry.tool),
        this.activationFor(runtimeEntry)
      )
    }
    const toolRoot = managedToolRoot(this.options.root, entry.tool)
    const record = await readManagedActivation(toolRoot)
    if (record?.active.version === entry.version) {
      await this.probeVersion(entry.tool, entry.version)
      return { status: 'already-active', version: entry.version }
    }
    if ((await listManagedVersions(toolRoot)).includes(entry.version)) {
      await this.probeVersion(entry.tool, entry.version)
      await this.activate(entry, record)
    } else {
      await acquireManagedVersion({
        root: this.options.root,
        manifest: this.options.manifest,
        entry,
        runtimeEntry,
        route: args.route,
        signal: controller.signal,
        seams
      })
      await this.activate(entry, record)
    }
    emit({ executionHostId: 'local', tool: entry.tool as LanguageServerKind, version: entry.version, phase: 'complete' })
    await this.gc(entry.tool)
    return { status: 'installed', version: entry.version }
  }

  private async probeVersion(tool: string, version: string): Promise<void> {
    const entry = this.entryForVersion(tool, version)
    if (!entry) {
      throw new Error(`No trusted manifest entry for ${tool} ${version}`)
    }
    await probeManagedEntry(
      this.options.root,
      this.options.manifest,
      entry,
      managedVersionDirectory(this.options.root, entry.tool, entry.version),
      this.run
    )
  }

  private async activate(
    entry: ManagedLanguageServerManifestEntry,
    prior: ManagedLanguageServerActivationRecord | null
  ): Promise<void> {
    const toolRoot = managedToolRoot(this.options.root, entry.tool)
    const next = this.activationFor(entry)
    if (prior?.active && prior.active.version !== entry.version) {
      next.rollback = prior.active
    }
    await writeManagedActivation(toolRoot, next)
  }

  private activationFor(
    entry: ManagedLanguageServerManifestEntry
  ): ManagedLanguageServerActivationRecord {
    return { active: { version: entry.version, entryId: entry.id, activatedAt: Date.now() } }
  }

  /** GC protects active, rollback, and scope-pinned versions; staging is skipped.
   * ponytail: in-use protection approximated — sessions launch from `active`. */
  private async gc(tool: ManagedLanguageServerToolId): Promise<void> {
    const toolRoot = managedToolRoot(this.options.root, tool)
    const record = await readManagedActivation(toolRoot)
    const pinned =
      tool === 'node' ? [] : ((await this.options.getPinnedVersions?.(tool)) ?? [])
    const keep = new Set<string>(
      [record?.active?.version, record?.rollback?.version, ...pinned].filter(
        (version): version is string => typeof version === 'string'
      )
    )
    const { rm } = await import('node:fs/promises')
    for (const version of await listManagedVersions(toolRoot)) {
      if (!keep.has(version)) {
        await rm(join(toolRoot, version), { recursive: true, force: true })
      }
    }
  }

  /** Platform-aware version lookup — one version ships several per-Host
   * entries, and picking another platform's would yield node.exe paths on
   * macOS/Linux. */
  private entryForVersion(tool: string, version: string): ManagedLanguageServerManifestEntry | undefined {
    return this.options.manifest.entries.find(
      (entry) =>
        entry.tool === tool &&
        entry.version === version &&
        entry.platform === process.platform &&
        entry.arch === process.arch
    )
  }

  private resolveHostTarget(): Promise<{ platform: string; arch: string; glibcVersion?: string }> {
    this.hostTarget ??= resolveLocalManagedHostTarget(this.run)
    return this.hostTarget
  }

  private run: CppSetupCommandRunner = (executable, args, cwd) =>
    (this.options.run ?? runCppSetupCommand)(executable, args, cwd)
}
