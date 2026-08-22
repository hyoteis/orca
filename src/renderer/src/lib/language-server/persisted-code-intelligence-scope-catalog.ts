import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/types'
import { CodeIntelligenceScopeCatalog } from './code-intelligence-scope-catalog'
export function createPersistedCodeIntelligenceScopeCatalog(
  store: StoreApi<AppState>
): CodeIntelligenceScopeCatalog {
  const state = store.getState()
  return new CodeIntelligenceScopeCatalog(
    state.settings?.codeIntelligenceScopes ?? [],
    async (scopes) => {
      await store.getState().updateSettingsOrThrow({ codeIntelligenceScopes: [...scopes] })
    }
  )
}
