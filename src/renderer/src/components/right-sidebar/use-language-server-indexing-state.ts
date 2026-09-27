import { useSyncExternalStore } from 'react'
import {
  getLanguageServerStatus,
  subscribeLanguageServerStatus,
  type LanguageServerIndexingEntry
} from '@/components/editor/lsp-navigation/language-server-status-store'

export type { LanguageServerIndexingEntry }

// Stable subscription handle for useSyncExternalStore.
const subscribeIndexingState = (listener: () => void): (() => void) =>
  subscribeLanguageServerStatus(listener)

/** clangd indexing state for one session (#163); null when no session applies.
 * The store keeps entry objects referentially stable between notifications,
 * so getSnapshot never loops React. */
export function useLanguageServerIndexingState(
  sessionKey: string | null
): LanguageServerIndexingEntry | null {
  return useSyncExternalStore(
    subscribeIndexingState,
    () => (sessionKey ? (getLanguageServerStatus().indexingBySession[sessionKey] ?? null) : null),
    () => null
  )
}
