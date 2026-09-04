import { useCallback, useEffect, useRef, useState } from 'react'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { LANGUAGE_SERVER_MANAGED_INSTALL_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { LanguageServerKind } from '../../../../shared/language-server-session'
import type {
  ManagedLanguageServerInstallEvent,
  ManagedLanguageServerInstallResult,
  ManagedLanguageServerInstallRoute,
  ManagedLanguageServerInstallState,
  ManagedLanguageServerRollbackResult
} from '../../../../shared/managed-language-server'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { managedInstallKey, useManagedInstallEvent } from './managed-install-event-feed'
import {
  runtimeManagedInstall,
  runtimeManagedInstallState,
  runtimeManagedRollback
} from './runtime-managed-install-rpc'

/** #21 reload affordance: last client-picked archive per Host+tool (session memory). */
const lastOfflineArchives = new Map<string, string>()

export function getLastOfflineManagedArchive(
  executionHostId: string,
  tool: string
): string | null {
  return lastOfflineArchives.get(managedInstallKey(executionHostId, tool)) ?? null
}

export type ManagedInstallActionRoute = ManagedLanguageServerInstallRoute

/** Per Host+tool controller: snapshot state, live event, and the install /
 * cancel / rollback actions routed over IPC (local+SSH) or the capability-gated
 * Runtime RPC stream (#34). */
export function useManagedLanguageServerInstall(args: {
  executionHostId: ExecutionHostId | null
  tool: LanguageServerKind
}): {
  state: ManagedLanguageServerInstallState | null
  stateError: string | null
  runtimeCapabilityUnsupported: boolean
  busy: boolean
  event: ManagedLanguageServerInstallEvent | null
  refresh: () => Promise<void>
  install: (
    route: ManagedInstallActionRoute,
    version?: string
  ) => Promise<ManagedLanguageServerInstallResult | null>
  cancel: () => Promise<boolean>
  rollback: () => Promise<ManagedLanguageServerRollbackResult | null>
} {
  const { executionHostId, tool } = args
  const parsedHost = parseExecutionHostId(executionHostId)
  // Stable primitives, not the re-parsed object identity.
  const hostKind = parsedHost?.kind ?? null
  const environmentId = parsedHost?.kind === 'runtime' ? parsedHost.environmentId : null
  const [state, setState] = useState<ManagedLanguageServerInstallState | null>(null)
  const [stateError, setStateError] = useState<string | null>(null)
  const [runtimeCapabilityUnsupported, setRuntimeCapabilityUnsupported] = useState(false)
  const [busy, setBusy] = useState(false)
  const event = useManagedInstallEvent(executionHostId, tool)
  const runtimeInstallUnsubscribeRef = useRef<(() => void) | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!executionHostId || !hostKind) {
      return
    }
    setStateError(null)
    try {
      if (hostKind === 'runtime') {
        const supported = await runtimeEnvironmentSupportsCapability(
          environmentId!,
          LANGUAGE_SERVER_MANAGED_INSTALL_RUNTIME_CAPABILITY
        ).catch(() => false)
        setRuntimeCapabilityUnsupported(!supported)
        if (!supported) {
          setState(null)
          return
        }
        setState(await runtimeManagedInstallState(environmentId!, tool))
        return
      }
      setState(await window.api.codeIntelligence.managedInstallState({ executionHostId, tool }))
    } catch (error) {
      // Common case: an SSH Host that is not connected right now.
      setState(null)
      setStateError(error instanceof Error ? error.message : String(error))
    }
  }, [executionHostId, tool, hostKind, environmentId])

  useEffect(() => {
    setState(null)
    setRuntimeCapabilityUnsupported(false)
    void refresh()
  }, [refresh])

  const install = useCallback(
    async (
      route: ManagedInstallActionRoute,
      version?: string
    ): Promise<ManagedLanguageServerInstallResult | null> => {
      if (!executionHostId || !hostKind) {
        return null
      }
      if (route.type === 'client-file') {
        lastOfflineArchives.set(managedInstallKey(executionHostId, tool), route.filePath)
      }
      setBusy(true)
      try {
        if (hostKind === 'runtime') {
          if (route.type !== 'host-download') {
            return { status: 'failed', error: 'Runtime Hosts accept host downloads only' }
          }
          return await runtimeManagedInstall(
            executionHostId,
            environmentId!,
            { tool, version },
            (unsubscribe) => (runtimeInstallUnsubscribeRef.current = unsubscribe)
          )
        }
        return await window.api.codeIntelligence.installManagedLanguageServer({
          executionHostId,
          tool,
          version,
          route
        })
      } finally {
        setBusy(false)
        void refresh()
      }
    },
    [executionHostId, tool, hostKind, environmentId, refresh]
  )

  const cancel = useCallback(async (): Promise<boolean> => {
    if (hostKind === 'runtime') {
      runtimeInstallUnsubscribeRef.current?.()
      runtimeInstallUnsubscribeRef.current = null
      return true
    }
    if (!executionHostId) {
      return false
    }
    return window.api.codeIntelligence.cancelManagedLanguageServerInstall({
      executionHostId,
      tool
    })
  }, [executionHostId, tool, hostKind])

  const rollback = useCallback(async (): Promise<ManagedLanguageServerRollbackResult | null> => {
    if (!executionHostId || !hostKind) {
      return null
    }
    setBusy(true)
    try {
      if (hostKind === 'runtime') {
        return await runtimeManagedRollback(environmentId!, tool)
      }
      return await window.api.codeIntelligence.rollbackManagedLanguageServer({
        executionHostId,
        tool
      })
    } finally {
      setBusy(false)
      void refresh()
    }
  }, [executionHostId, tool, hostKind, environmentId, refresh])

  return {
    state,
    stateError,
    runtimeCapabilityUnsupported,
    busy,
    event,
    refresh,
    install,
    cancel,
    rollback
  }
}
