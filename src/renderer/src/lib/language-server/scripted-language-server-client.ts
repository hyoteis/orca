import type { LanguageServerClientKey } from './language-server-client-registry'

type RequestHandler = (params: unknown, token?: unknown) => unknown

/** Shared in-memory stand-in for LanguageServerClientRegistry (arch review C3):
 * node tests cannot load the real one because vscode-jsonrpc/browser has no
 * node export. State is module-level so vi.mock factories and test bodies see
 * the same instance; reset between tests. */
export const scripted = {
  capabilities: {} as Record<string, unknown>,
  requestHandlers: {} as Record<string, RequestHandler>,
  serverRequestRoutes: {} as Record<string, (params: unknown) => unknown>,
  notificationRoutes: {} as Record<string, (params: unknown) => void>,
  requestCalls: [] as string[],
  opens: [] as LanguageServerClientKey[],
  closes: [] as LanguageServerClientKey[],
  sessionOverrides: [] as Record<string, RequestHandler>[],
  isCurrentRequest: true,
  instance: null as ScriptedLanguageServerClient | null
}

export function resetScriptedLanguageServerClient(): void {
  scripted.capabilities = {}
  scripted.requestHandlers = {}
  scripted.serverRequestRoutes = {}
  scripted.notificationRoutes = {}
  scripted.requestCalls = []
  scripted.opens = []
  scripted.closes = []
  scripted.sessionOverrides = []
  scripted.isCurrentRequest = true
  scripted.instance = null
}

export class ScriptedLanguageServerClient {
  constructor(
    _api: unknown,
    private readonly onRestartDecision?: (key: Partial<LanguageServerClientKey>) => void
  ) {
    scripted.instance = this
  }
  nextRequestGeneration(): number {
    return 1
  }
  isCurrentRequest(): boolean {
    return scripted.isCurrentRequest
  }
  async open(key: LanguageServerClientKey): Promise<{
    generation: number
    connection: {
      onRequest: (type: { method: string }, handler: (params: unknown) => unknown) => unknown
      onNotification: (type: { method: string }, handler: (params: unknown) => void) => unknown
      sendNotification: () => void
      sendRequest: (type: { method: string }, params: unknown, token?: unknown) => Promise<unknown>
    }
    sync: { reconcile: () => void }
    initialize: () => Promise<{ capabilities: Record<string, unknown> }>
  }> {
    const sessionIndex = scripted.sessionOverrides.length
    scripted.sessionOverrides.push({})
    scripted.opens.push(key)
    return {
      generation: 1,
      connection: {
        onRequest: (type, handler) => {
          scripted.serverRequestRoutes[type.method] = handler
          return { dispose: () => delete scripted.serverRequestRoutes[type.method] }
        },
        onNotification: (type, handler) => {
          scripted.notificationRoutes[type.method] = handler
          return { dispose: () => delete scripted.notificationRoutes[type.method] }
        },
        sendNotification: () => {},
        sendRequest: async (type, params, token) => {
          scripted.requestCalls.push(type.method)
          if ((token as { isCancellationRequested?: boolean } | undefined)?.isCancellationRequested) {
            throw new Error('cancelled')
          }
          const handler =
            scripted.sessionOverrides[sessionIndex][type.method] ??
            scripted.requestHandlers[type.method]
          return handler?.(params, token) ?? null
        }
      },
      sync: { reconcile: () => {} },
      initialize: async () => ({ capabilities: scripted.capabilities })
    }
  }
  restartScope(scopeId: string, revision = 0): void {
    this.onRestartDecision?.({ scopeId, revision })
  }
  close(key: LanguageServerClientKey): void {
    scripted.closes.push(key)
  }
  closeScope(): void {}
  dispose(): void {}
}
