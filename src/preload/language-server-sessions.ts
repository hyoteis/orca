import type {
  LanguageServerSessionCallbacks,
  LanguageServerSessionEvent,
  LanguageServerSessionOpenRequest,
  LanguageServerSessionsApi
} from '../shared/language-server-session'

type LanguageServerSessionIpc = {
  invoke: (
    channel: string,
    request: LanguageServerSessionOpenRequest
  ) => Promise<{ sessionId: string }>
  send: (channel: string, payload: unknown) => void
  on: (
    channel: string,
    listener: (
      _event: unknown,
      payload: { sessionId: string; event: LanguageServerSessionEvent }
    ) => void
  ) => void
}

export function createLanguageServerSessionsApi(
  ipc: LanguageServerSessionIpc
): LanguageServerSessionsApi {
  const callbacks = new Map<string, LanguageServerSessionCallbacks>()
  ipc.on('languageServers:event', (_event, payload) =>
    callbacks.get(payload.sessionId)?.onEvent(payload.event)
  )
  return {
    open: async (request, sessionCallbacks) => {
      callbacks.set(request.sessionId, sessionCallbacks)
      let result: { sessionId: string }
      try {
        result = await ipc.invoke('languageServers:open', request)
      } catch (error) {
        callbacks.delete(request.sessionId)
        throw error
      }
      return {
        sessionId: result.sessionId,
        send: (bytes) => {
          ipc.send('languageServers:write', { sessionId: result.sessionId, bytes })
        },
        close: () => {
          callbacks.delete(result.sessionId)
          ipc.send('languageServers:close', { sessionId: result.sessionId })
        }
      }
    }
  }
}
