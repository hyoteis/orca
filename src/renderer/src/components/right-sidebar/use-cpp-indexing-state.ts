import { useSyncExternalStore } from 'react'
import { getCppSession } from '@/lib/language-server/cpp-code-intelligence-session'
import type { CppIndexingState } from '@/lib/language-server/cpp-indexing-progress'

export type { CppIndexingState }

// Stable subscription handle for useSyncExternalStore.
const subscribeCppIndexingState = (listener: () => void): (() => void) =>
  getCppSession().indexing.onState(listener)

/** clangd index state for one scope (#163); null when no scope applies. The
 * snapshot object is stable per state, so getSnapshot never loops React. */
export function useCppIndexingState(scopeId: string | null): CppIndexingState | null {
  return useSyncExternalStore(
    subscribeCppIndexingState,
    () => (scopeId ? getCppSession().indexing.stateFor(scopeId) : null),
    () => null
  )
}
