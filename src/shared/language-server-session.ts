export type LanguageServerKind = 'basedpyright' | 'pyright' | 'clangd'

export type LanguageServerSessionOpenRequest = {
  sessionId: string
  kind: LanguageServerKind
  workspaceRoot: string
  executionHostId?: `ssh:${string}` | `runtime:${string}` | 'local'
}

export type LanguageServerSessionStatus =
  | { type: 'starting' }
  | { type: 'ready'; pid: number }
  | { type: 'stderr'; text: string; truncated?: boolean }
  | { type: 'backpressure'; direction: 'stdin' }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { type: 'error'; message: string }
  | { type: 'closed' }

export type LanguageServerSessionEvent =
  | { type: 'stdout'; bytes: Uint8Array<ArrayBufferLike> }
  | { type: 'status'; status: LanguageServerSessionStatus }

export type LanguageServerSessionCallbacks = {
  onEvent: (event: LanguageServerSessionEvent) => void
}

export type LanguageServerSessionHandle = {
  sessionId: string
  send: (bytes: Uint8Array<ArrayBufferLike>) => void
  close: () => void
}

export type LanguageServerSessionsApi = {
  open: (
    request: LanguageServerSessionOpenRequest,
    callbacks: LanguageServerSessionCallbacks
  ) => Promise<LanguageServerSessionHandle>
}
