// Pure store for the language-server status surface (spec §6): the transient
// `$/progress` projection and the persistent degraded hint. Framework-free and
// cycle-free so both the React status bar and the IPC subscriber can import it
// without a circular dependency. Toast routing (LRU eviction) lives in the
// subscriber, which owns the sonner import.

/** Per-session clangd indexing state (spec-b B2). */
export type LanguageServerIndexingEntry = {
  active: boolean
  percentage?: number
}

export type LanguageServerStatusState = {
  /** Transient `$/progress` projection; null when idle (cleared on `end`). */
  progress: string | null
  /** Persistent degraded hint (no clangd / version too low); null when fine. */
  degraded: string | null
  /** Per-session indexing state; the entry is deleted once inactive. */
  indexingBySession: Record<string, LanguageServerIndexingEntry | undefined>
}

type Listener = (state: LanguageServerStatusState) => void

const state: LanguageServerStatusState = {
  progress: null,
  degraded: null,
  indexingBySession: {}
}
// Cached snapshot: useSyncExternalStore requires getSnapshot to return a
// referentially-stable value between notifications, or React re-renders every
// commit (Maximum update depth exceeded). Rebuilt only when state changes.
let snapshot: LanguageServerStatusState = { ...state }
const listeners = new Set<Listener>()

function notify(): void {
  snapshot = { ...state }
  for (const listener of listeners) {
    listener(snapshot)
  }
}

/** Set the transient progress projection; null clears it. */
export function setLanguageServerProgress(text: string | null): void {
  state.progress = text
  notify()
}

/** Set the persistent degraded hint; null clears it. */
export function setLanguageServerDegraded(message: string | null): void {
  state.degraded = message
  notify()
}

/** Apply one per-session indexing update; inactive (or null) deletes the
 * entry. No-op (no notify) when nothing changed, so repeated `$/progress`
 * reports with the same percentage do not churn subscribers. */
export function setLanguageServerIndexing(
  sessionKey: string,
  indexing: LanguageServerIndexingEntry | null
): void {
  const current = state.indexingBySession[sessionKey]
  if (indexing?.active) {
    if (current?.active && current.percentage === indexing.percentage) {
      return
    }
    state.indexingBySession = { ...state.indexingBySession, [sessionKey]: indexing }
  } else if (current) {
    const next = { ...state.indexingBySession }
    delete next[sessionKey]
    state.indexingBySession = next
  } else {
    return
  }
  notify()
}

/** Read the current status snapshot (stable between notifications). */
export function getLanguageServerStatus(): LanguageServerStatusState {
  return snapshot
}

/** Subscribe to status changes; returns an unsubscribe function. */
export function subscribeLanguageServerStatus(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reset the store for unit tests. */
export function resetLanguageServerStatusForTests(): void {
  state.progress = null
  state.degraded = null
  state.indexingBySession = {}
  snapshot = { ...state }
  listeners.clear()
}
