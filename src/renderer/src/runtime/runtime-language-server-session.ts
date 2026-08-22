import type {
  LanguageServerSessionCallbacks,
  LanguageServerSessionHandle,
  LanguageServerSessionOpenRequest
} from '../../../shared/language-server-session'
export async function openRuntimeLanguageServerSession(
  api: NonNullable<Window['api']>['runtimeEnvironments'],
  environmentId: string,
  request: LanguageServerSessionOpenRequest,
  callbacks: LanguageServerSessionCallbacks
): Promise<LanguageServerSessionHandle> {
  const subscription = await api.subscribe(
    { selector: environmentId, method: 'languageServer.session', params: request },
    {
      onResponse: (response) => {
        if (
          response.ok &&
          response.result &&
          typeof response.result === 'object' &&
          'status' in response.result
        )
          callbacks.onEvent({
            type: 'status',
            status: (
              response.result as {
                status: Parameters<LanguageServerSessionCallbacks['onEvent']>[0] & never
              }
            ).status as never
          })
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
