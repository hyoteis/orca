import { LANGUAGE_SERVER_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import type {
  LanguageServerSessionCallbacks,
  LanguageServerSessionHandle,
  LanguageServerSessionOpenRequest,
  LanguageServerSessionStatus,
  LanguageServerSessionsApi
} from '../../../shared/language-server-session'
export async function openRuntimeLanguageServerSession(
  api: NonNullable<Window['api']>['runtimeEnvironments'],
  environmentId: string,
  request: LanguageServerSessionOpenRequest,
  callbacks: LanguageServerSessionCallbacks
): Promise<LanguageServerSessionHandle> {
  if (
    !(await runtimeEnvironmentSupportsCapability(
      environmentId,
      LANGUAGE_SERVER_SESSION_RUNTIME_CAPABILITY
    ))
  ) {
    throw new Error('Remote Runtime Host does not support language-server sessions')
  }
  const subscription = await api.subscribe(
    { selector: environmentId, method: 'languageServer.session', params: request },
    {
      onResponse: (response) => {
        if (!response.ok || !response.result || typeof response.result !== 'object') {
          return
        }
        const status = (response.result as { status?: LanguageServerSessionStatus }).status
        if (status) {
          callbacks.onEvent({ type: 'status', status })
        }
      },
      onBinary: (bytes) => callbacks.onEvent({ type: 'stdout', bytes }),
      onError: (error) =>
        callbacks.onEvent({ type: 'status', status: { type: 'error', message: error.message } }),
      onClose: () => callbacks.onEvent({ type: 'status', status: { type: 'closed' } })
    }
  )
  return {
    sessionId: request.sessionId,
    send: (bytes) => subscription.sendBinary(bytes),
    close: () => subscription.unsubscribe()
  }
}

export function createRuntimeLanguageServerSessionsApi(
  environmentId: string
): LanguageServerSessionsApi {
  return {
    open: (request, callbacks) =>
      openRuntimeLanguageServerSession(
        window.api.runtimeEnvironments,
        environmentId,
        request,
        callbacks
      )
  }
}
