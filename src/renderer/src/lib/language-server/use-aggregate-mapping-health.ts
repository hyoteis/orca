import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { AggregateMappingHealthSnapshot } from '../../../../shared/code-intelligence-scope'
import { translate } from '@/i18n/i18n'

/** Module-level health store: one subscription feeds every consumer surface
 * (banner, status), and transition detection lives in one place (#137). */
type HealthByScope = Record<string, readonly AggregateMappingHealthSnapshot[]>

let healthByScope: HealthByScope = {}
const listeners = new Set<() => void>()
let subscribed = false

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(onChange: () => void): () => void {
  ensureSubscription()
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

function ensureSubscription(): void {
  if (subscribed || !window.api) {
    return
  }
  subscribed = true
  window.api.codeIntelligence.onScopeChanged((change) => {
    if (change.mappingHealth === undefined) {
      return
    }
    const previous = healthByScope[change.scopeId]
    healthByScope = { ...healthByScope, [change.scopeId]: change.mappingHealth }
    // Toast exactly once on the transition into degraded; recovery and
    // warnings stay silent (spec §2 Step 4).
    const wasDegraded = previous?.some((mapping) => mapping.state === 'degraded') ?? false
    const isDegraded = change.mappingHealth.some((mapping) => mapping.state === 'degraded')
    if (isDegraded && !wasDegraded) {
      toast.warning(
        translate(
          'settings.codeIntelligence.mappingDegradedToast',
          'A compile database became unreadable — its last-valid entries keep working'
        )
      )
    }
    emit()
  })
}

/** Mapping health per scope as of the latest aggregate rebuild. */
export function readAggregateMappingHealth(
  scopeId: string
): readonly AggregateMappingHealthSnapshot[] | undefined {
  return healthByScope[scopeId]
}

/** React hook wrapper — re-renders on every health refresh. */
export function useAggregateMappingHealth(
  scopeId: string | null
): readonly AggregateMappingHealthSnapshot[] | undefined {
  const [snapshot, setSnapshot] = useState<readonly AggregateMappingHealthSnapshot[] | undefined>(() =>
    scopeId ? healthByScope[scopeId] : undefined
  )
  useEffect(() => {
    if (!scopeId) {
      return
    }
    const sync = (): void => {
      setSnapshot(healthByScope[scopeId])
    }
    sync()
    return subscribe(sync)
  }, [scopeId])
  return snapshot
}

/** Test seam: inject health state without the IPC round trip. */
export function setAggregateMappingHealthForTest(
  scopeId: string,
  health: readonly AggregateMappingHealthSnapshot[] | undefined
): void {
  if (health === undefined) {
    const next = { ...healthByScope }
    delete next[scopeId]
    healthByScope = next
  } else {
    healthByScope = { ...healthByScope, [scopeId]: health }
  }
  emit()
}
