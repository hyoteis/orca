import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { LanguageServerKind } from '../../../../shared/language-server-session'
import type {
  ManagedLanguageServerInstallEvent,
  ManagedLanguageServerInstallResult,
  ManagedLanguageServerRollbackResult,
  ManagedLanguageServerInstallState
} from '../../../../shared/managed-language-server'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-result'
import { dispatchManagedInstallEvent } from './managed-install-event-feed'

type RuntimeSubscriptionHandle = { unsubscribe: () => void }

/** Streaming Runtime methods emit once then complete; subscribe, take the
 * first emission, and tear the stream down. */
export function subscribeRuntimeOnce<TResult>(
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    let handle: RuntimeSubscriptionHandle | null = null
    const finish = (settle: () => void): void => {
      settled = true
      settle()
      void handle?.unsubscribe()
    }
    window.api.runtimeEnvironments
      .subscribe({ selector: environmentId, method, params }, {
        onResponse: (response) => {
          if (settled) {
            void handle?.unsubscribe()
            return
          }
          if (!response.ok) {
            finish(() => reject(new Error(response.error.message)))
            return
          }
          finish(() =>
            resolve(unwrapRuntimeRpcResult<TResult>(response as RuntimeRpcResponse<TResult>))
          )
        },
        onError: (error) => {
          if (!settled) {
            finish(() => reject(new Error(error.message)))
          }
        },
        onClose: () => {
          if (!settled) {
            finish(() => reject(new Error('Runtime stream closed without a result')))
          }
        }
      })
      .then((subscription) => {
        handle = subscription
        if (settled) {
          void subscription.unsubscribe()
        }
      })
      .catch((error: unknown) => {
        if (!settled) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))))
        }
      })
  })
}

export function runtimeManagedInstallState(
  environmentId: string,
  tool: LanguageServerKind
): Promise<ManagedLanguageServerInstallState> {
  return subscribeRuntimeOnce<{ state: ManagedLanguageServerInstallState }>(
    environmentId,
    'languageServer.managedInstallState',
    { tool }
  ).then((payload) => payload.state)
}

export function runtimeManagedRollback(
  environmentId: string,
  tool: LanguageServerKind
): Promise<ManagedLanguageServerRollbackResult> {
  return subscribeRuntimeOnce<{ result: ManagedLanguageServerRollbackResult }>(
    environmentId,
    'languageServer.managedRollback',
    { tool }
  ).then((payload) => payload.result)
}

/** Relay-Host installs stream progress ({event}) then one terminal {result}. */
export function runtimeManagedInstall(
  executionHostId: ExecutionHostId,
  environmentId: string,
  request: { tool: LanguageServerKind; version?: string },
  onUnsubscribe: (unsubscribe: (() => void) | null) => void
): Promise<ManagedLanguageServerInstallResult> {
  return new Promise((resolve, reject) => {
    let result: ManagedLanguageServerInstallResult | null = null
    let canceledLocally = false
    let open = true
    window.api.runtimeEnvironments
      .subscribe(
        {
          selector: environmentId,
          method: 'languageServer.managedInstall',
          // Host RPC v1 accepts host-download only (#15); client-file stays
          // local/SSH where Orca can read the file.
          params: { tool: request.tool, version: request.version, route: 'host-download' }
        },
        {
          onResponse: (response) => {
            if (!response.ok) {
              open = false
              reject(new Error(response.error.message))
              return
            }
            const payload = response.result as {
              event?: ManagedLanguageServerInstallEvent
              result?: ManagedLanguageServerInstallResult
            }
            if (payload.event) {
              dispatchManagedInstallEvent({ ...payload.event, executionHostId })
            }
            if (payload.result) {
              result = payload.result
            }
          },
          onError: (error) => {
            open = false
            reject(new Error(error.message))
          },
          onClose: () => {
            open = false
            if (result) {
              resolve(result)
            } else if (canceledLocally) {
              resolve({ status: 'canceled' })
            } else {
              reject(new Error('Runtime install stream closed without a result'))
            }
          }
        }
      )
      .then((subscription) => {
        // ponytail: Runtime cancel = unsubscribe; the abort relies on the RPC
        // layer tearing down the subscription's ctx.signal.
        onUnsubscribe(
          open
            ? () => {
                canceledLocally = true
                void subscription.unsubscribe()
              }
            : null
        )
      })
      .catch(reject)
  })
}
