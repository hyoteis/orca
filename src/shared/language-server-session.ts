import type { ExecutionHostId } from './execution-host'
import type { CodeIntelligenceScopeMember } from './code-intelligence-scope'

export type LanguageServerKind = 'basedpyright' | 'pyright' | 'clangd'

/** Zod-friendly literal tuple of LanguageServerKind. */
export const LANGUAGE_SERVER_KINDS = ['basedpyright', 'pyright', 'clangd'] as const

export type LanguageServerSessionOpenRequest = {
  sessionId: string
  scopeId: string
  revision: number
}

export type LanguageServerLaunchCommand = {
  executable: string
  args: readonly string[]
}

export type LanguageServerLaunchRequest = LanguageServerSessionOpenRequest & {
  kind: LanguageServerKind
  workspaceRoot: string
  executionHostId: ExecutionHostId
  command?: LanguageServerLaunchCommand
  /** Managed source: the Host-side active-version launch target. Runtime
   * Hosts resolve this server-side (client paths are meaningless there). */
  managed?: { tool: LanguageServerKind; version?: string }
  members: readonly CodeIntelligenceScopeMember[]
}

export type RuntimeLanguageServerSessionParams = Pick<
  LanguageServerLaunchRequest,
  'sessionId' | 'kind' | 'workspaceRoot' | 'executionHostId' | 'command' | 'managed'
>

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
