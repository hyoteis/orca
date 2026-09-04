import { useEffect, useState } from 'react'
import type { ManagedLanguageServerInstallEvent } from '../../../../shared/managed-language-server'

// Install failures must survive popover close/reopen (#21 auto-expand), so the
// latest event per Host+tool lives at module scope; mounted hooks subscribe and
// write through. 'node' marks private-runtime internals — sheets show servers only.
const latestInstallEvents = new Map<string, ManagedLanguageServerInstallEvent>()

/** Cache/feed key — shared with the offline-archive memory in the install hook. */
export function managedInstallKey(executionHostId: string, tool: string): string {
  return `${executionHostId}|${tool}`
}

const installEventListeners = new Set<(event: ManagedLanguageServerInstallEvent) => void>()

export function dispatchManagedInstallEvent(event: ManagedLanguageServerInstallEvent): void {
  if (event.tool === 'node') {
    return
  }
  latestInstallEvents.set(managedInstallKey(event.executionHostId, event.tool), event)
  for (const listener of installEventListeners) {
    listener(event)
  }
}

export function getCachedManagedInstallEvent(
  executionHostId: string,
  tool: string
): ManagedLanguageServerInstallEvent | null {
  return latestInstallEvents.get(managedInstallKey(executionHostId, tool)) ?? null
}

function subscribeToManagedInstallEvents(
  listener: (event: ManagedLanguageServerInstallEvent) => void
): () => void {
  installEventListeners.add(listener)
  // Optional chain: partial window.api mocks in unrelated StatusBar tests.
  const unsubscribe =
    window.api.codeIntelligence?.onManagedInstallEvent?.(dispatchManagedInstallEvent) ??
    (() => {})
  return () => {
    installEventListeners.delete(listener)
    unsubscribe()
  }
}

/** Any Host+tool whose latest event is a non-canceled failure (status-bar badge). */
export function hasManagedInstallFailure(): boolean {
  for (const event of latestInstallEvents.values()) {
    if (event.phase === 'error' && !event.canceled) {
      return true
    }
  }
  return false
}

/** Keeps the module cache warm while the status bar exists; exposes the
 * failure flag for the segment's attention color. */
export function useManagedInstallEventCacheKeeper(): boolean {
  const [failure, setFailure] = useState(hasManagedInstallFailure)
  useEffect(
    () => subscribeToManagedInstallEvents(() => setFailure(hasManagedInstallFailure())),
    []
  )
  return failure
}

/** Latest broadcast event for one Host+tool while the caller is mounted. */
export function useManagedInstallEvent(
  executionHostId: string | null,
  tool: string
): ManagedLanguageServerInstallEvent | null {
  const [event, setEvent] = useState<ManagedLanguageServerInstallEvent | null>(() =>
    executionHostId ? getCachedManagedInstallEvent(executionHostId, tool) : null
  )
  useEffect(() => {
    const key = managedInstallKey(String(executionHostId), tool)
    setEvent(executionHostId ? getCachedManagedInstallEvent(executionHostId, tool) : null)
    return subscribeToManagedInstallEvents((incoming) => {
      if (managedInstallKey(incoming.executionHostId, incoming.tool) === key) {
        setEvent(incoming)
      }
    })
  }, [executionHostId, tool])
  return event
}
