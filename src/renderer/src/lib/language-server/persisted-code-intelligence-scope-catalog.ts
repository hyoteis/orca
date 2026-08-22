import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/types'
import { CodeIntelligenceScopeCatalog } from './code-intelligence-scope-catalog'

export function createPersistedCodeIntelligenceScopeCatalog(
  store: StoreApi<AppState>
): CodeIntelligenceScopeCatalog {
  return new CodeIntelligenceScopeCatalog(store.getState().settings?.codeIntelligenceScopes ?? [], {
    upsert: (scope) => window.api.codeIntelligence.upsertScope(scope),
    remove: (scopeId) => window.api.codeIntelligence.removeScope(scopeId)
  })
}
