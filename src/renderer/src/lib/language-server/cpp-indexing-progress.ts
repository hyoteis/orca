/** $/progress token payload per active work-done token. */
type ProgressTokenState = { percentage?: number }

/** Projected per-scope indexing state; `active` when any token is running. */
export type CppIndexingState = {
  scopeId: string
  active: boolean
  percentage?: number
}

type WorkDoneProgressValue = {
  kind?: unknown
  percentage?: unknown
}

type TrackedScope = {
  tokens: Map<string | number, ProgressTokenState>
  latest: string | number | null
  snapshot: CppIndexingState
}

/**
 * Tracks clangd work-done progress per scope (#163): begin/report/end per
 * token, projecting to one active/percentage state per scope. Unknown kinds
 * are dropped — clangd also reports non-indexing work on this channel, and a
 * stray notification must never wedge the state machine.
 */
export class CppIndexingProgress {
  private readonly scopes = new Map<string, TrackedScope>()
  private readonly listeners = new Set<(state: CppIndexingState) => void>()

  onState(listener: (state: CppIndexingState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Latest projected state; the object is stable until the state changes. */
  stateFor(scopeId: string): CppIndexingState {
    return this.scope(scopeId).snapshot
  }

  apply(scopeId: string, token: string | number, value: WorkDoneProgressValue): void {
    const tracked = this.scope(scopeId)
    if (value.kind === 'begin') {
      tracked.tokens.set(token, {
        percentage: typeof value.percentage === 'number' ? value.percentage : undefined
      })
      tracked.latest = token
      this.project(tracked)
      return
    }
    if (value.kind === 'report') {
      const prior = tracked.tokens.get(token)
      if (!prior) {
        return
      }
      const percentage = typeof value.percentage === 'number' ? value.percentage : prior.percentage
      if (percentage === prior.percentage) {
        return
      }
      tracked.tokens.set(token, { percentage })
      if (tracked.latest === token || tracked.latest === null) {
        tracked.latest = token
        this.project(tracked)
      }
      return
    }
    if (value.kind === 'end') {
      if (!tracked.tokens.delete(token)) {
        return
      }
      if (tracked.latest === token || tracked.tokens.size === 0) {
        tracked.latest = tracked.tokens.size > 0 ? [...tracked.tokens.keys()].at(-1)! : null
      }
      this.project(tracked)
    }
  }

  /** Scope session dropped: no progress can arrive anymore — go idle. */
  clearScope(scopeId: string): void {
    const tracked = this.scopes.get(scopeId)
    if (!tracked || !tracked.snapshot.active) {
      return
    }
    tracked.tokens.clear()
    tracked.latest = null
    this.project(tracked)
  }

  private scope(scopeId: string): TrackedScope {
    let tracked = this.scopes.get(scopeId)
    if (!tracked) {
      const snapshot: CppIndexingState = { scopeId, active: false }
      tracked = { tokens: new Map(), latest: null, snapshot }
      this.scopes.set(scopeId, tracked)
    }
    return tracked
  }

  private project(tracked: TrackedScope): void {
    const latest = tracked.latest !== null ? tracked.tokens.get(tracked.latest) : undefined
    tracked.snapshot = {
      scopeId: tracked.snapshot.scopeId,
      active: tracked.tokens.size > 0,
      ...(latest?.percentage !== undefined ? { percentage: latest.percentage } : {})
    }
    for (const listener of this.listeners) {
      listener(tracked.snapshot)
    }
  }
}
