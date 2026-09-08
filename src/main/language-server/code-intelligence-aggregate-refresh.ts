import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

/**
 * Aggregate refresh chain (spec §2 Step 3): changed supplied databases
 * re-merge automatically — local hosts through file events, SSH hosts through
 * the provider watch — debounced and single-flight per scope, with a drift
 * re-check on every session open. No polling, no new runtime RPC; this module
 * owns the coordination only, the event sources are injected seams.
 */
export type AggregateRefreshRebuild = (scopeId: string) => Promise<void>

/** Per-database stat signature; null = unreadable (always counts as drift). */
export type AggregateDriftProbe = (paths: readonly string[]) => Promise<(string | null)[]>

type TrackedScope = {
  /** Configured paths verbatim — the drift probe stats these. */
  databasePaths: Set<string>
  /** Comparison keys — Windows watchers report native backslash paths while
   * the scope stores the configured form, so matching must fold separators. */
  matchKeys: Set<string>
  rebuild: AggregateRefreshRebuild
}

const DEFAULT_DEBOUNCE_MS = 500

export class AggregateRefreshCoordinator {
  private readonly scopes = new Map<string, TrackedScope>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inFlight = new Map<string, Promise<void>>()
  /** Signature each scope's aggregate was last merged from. */
  private readonly mergedSignatures = new Map<string, string>()

  constructor(private readonly debounceMs: number = DEFAULT_DEBOUNCE_MS) {}

  /** Register (or replace) a scope's mappings; empty paths unregister. */
  track(scopeId: string, databasePaths: readonly string[], rebuild: AggregateRefreshRebuild): void {
    if (databasePaths.length === 0) {
      this.scopes.delete(scopeId)
      this.clearTimer(scopeId)
      this.mergedSignatures.delete(scopeId)
      return
    }
    this.scopes.set(scopeId, {
      databasePaths: new Set(databasePaths),
      matchKeys: new Set(databasePaths.map(normalizeRuntimePathForComparison)),
      rebuild
    })
  }

  untrack(scopeId: string): void {
    this.track(scopeId, [], async () => {})
  }

  /** A file event landed (local watcher or SSH provider) — schedule one
   * debounced single-flight rebuild per scope whose mapping it touches. */
  handleFileChange(changed: readonly string[]): void {
    const changedKeys = changed.map(normalizeRuntimePathForComparison)
    for (const [scopeId, scope] of this.scopes) {
      if (!changedKeys.some((key) => scope.matchKeys.has(key))) {
        continue
      }
      this.clearTimer(scopeId)
      const timer = setTimeout(() => {
        this.timers.delete(scopeId)
        void this.rebuildScope(scopeId)
      }, this.debounceMs)
      timer.unref?.()
      this.timers.set(scopeId, timer)
    }
  }

  /** Record what the current aggregate was merged from (called by the rebuild
   * path); the next drift check compares against this. */
  noteMerged(scopeId: string, signature: string): void {
    this.mergedSignatures.set(scopeId, signature)
  }

  /** Session-open drift re-check: the databases moved out-of-band since the
   * last merge (watch missed, app was closed). Triggers the rebuild inline
   * when they did; returns whether a rebuild was scheduled. */
  async refreshIfDrifted(scopeId: string, probe: AggregateDriftProbe): Promise<boolean> {
    const scope = this.scopes.get(scopeId)
    if (!scope || scope.databasePaths.size === 0) {
      return false
    }
    const signature = await signatureOf(probe, [...scope.databasePaths])
    if (signature !== null && signature === this.mergedSignatures.get(scopeId)) {
      return false
    }
    await this.rebuildScope(scopeId)
    return true
  }

  /** Single-flight: concurrent triggers for one scope join the same rebuild. */
  private async rebuildScope(scopeId: string): Promise<void> {
    const scope = this.scopes.get(scopeId)
    if (!scope) {
      return
    }
    const running = this.inFlight.get(scopeId)
    if (running) {
      return running
    }
    const promise = scope
      .rebuild(scopeId)
      .catch((error) => {
        // Degrade the failure to a log line: a broken refresh must never take
        // the session-open path down; the next event retries.
        console.warn(`[code-intelligence] aggregate refresh failed for ${scopeId}: ${describe(error)}`)
      })
      .finally(() => {
        this.inFlight.delete(scopeId)
      })
    this.inFlight.set(scopeId, promise)
    return promise
  }

  private clearTimer(scopeId: string): void {
    const timer = this.timers.get(scopeId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(scopeId)
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.scopes.clear()
    this.mergedSignatures.clear()
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Stable join of per-file signatures; any unreadable file (null) makes the
 * whole signature null so the next merge always fires. */
export async function signatureOf(
  probe: AggregateDriftProbe,
  paths: readonly string[]
): Promise<string | null> {
  const parts = await probe(paths)
  if (parts.some((part) => part === null)) {
    return null
  }
  return parts.join('|')
}
