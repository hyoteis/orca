import type { LanguageServerClientKey } from './language-server-client-registry'

type RequestHandler = (params: unknown, token?: unknown) => unknown

/** Real connections accept both NotificationType objects and bare method strings. */
function routeMethod(type: { method: string } | string): string {
  return typeof type === 'string' ? type : type.method
}

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
  initializeParams: null as unknown,
  opens: [] as LanguageServerClientKey[],
  closes: [] as LanguageServerClientKey[],
  sessionOverrides: [] as Record<string, RequestHandler>[],
  isCurrentRequest: true,
  instance: null as ScriptedLanguageServerClient | null,
  /** When set, the next open() rejects with it (#164 failure injection). */
  openRejection: null as Error | null,
  sentNotifications: [] as { method: string; params: unknown }[]
}

export function resetScriptedLanguageServerClient(): void {
  scripted.capabilities = {}
  scripted.requestHandlers = {}
  scripted.serverRequestRoutes = {}
  scripted.notificationRoutes = {}
  scripted.requestCalls = []
  scripted.initializeParams = null
  scripted.opens = []
  scripted.closes = []
  scripted.sessionOverrides = []
  scripted.isCurrentRequest = true
  scripted.instance = null
  scripted.openRejection = null
  scripted.sentNotifications = []
}

export class ScriptedLanguageServerClient {
  constructor(
    _api: unknown,
    private readonly onRestartDecision?: (key: Partial<LanguageServerClientKey>) => void,
    _scopeAuthority?: unknown,
    private readonly onMappingHealth?: (change: unknown) => void
  ) {
    scripted.instance = this
  }
  /** Test hook: deliver a health-only scope push (#165 wiring). */
  pushMappingHealth(change: unknown): void {
    this.onMappingHealth?.(change)
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
      onRequest: (type: { method: string } | string, handler: (params: unknown) => unknown) => unknown
      onNotification: (type: { method: string } | string, handler: (params: unknown) => void) => unknown
      sendNotification: (type: { method: string } | string, params?: unknown) => Promise<void>
      sendRequest: (type: { method: string }, params: unknown, token?: unknown) => Promise<unknown>    }
    sync: { reconcile: () => void }
    initialize: (params: unknown) => Promise<{ capabilities: Record<string, unknown> }>
  }> {
    if (scripted.openRejection) {
      scripted.opens.push(key)
      throw scripted.openRejection
    }
    const sessionIndex = scripted.sessionOverrides.length
    scripted.sessionOverrides.push({})
    scripted.opens.push(key)
    return {
      generation: 1,
      connection: {
        onRequest: (type, handler) => {
          scripted.serverRequestRoutes[routeMethod(type)] = handler
          return { dispose: () => delete scripted.serverRequestRoutes[routeMethod(type)] }
        },
        onNotification: (type, handler) => {
          scripted.notificationRoutes[routeMethod(type)] = handler
          return { dispose: () => delete scripted.notificationRoutes[routeMethod(type)] }
        },
        sendNotification: (type: { method: string } | string, params?: unknown) => {
          scripted.sentNotifications.push({ method: routeMethod(type), params })
          return Promise.resolve()
        },
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
      initialize: async (params: unknown) => {
        scripted.initializeParams = params
        return { capabilities: scripted.capabilities }
      }
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
