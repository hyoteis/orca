// Document routing for the language-server host: which session owns which
// document, joining in-flight starts, and click-driven recovery after a relay
// loss. Extracted from language-server-host.ts when it exceeded the max-lines
// gate; the host keeps the session lifecycle, this owns the doc→session tables.
import type { ClangdSession } from './clangd-session'
import type { SessionEntry } from './language-server-host-types'

export type DocumentScope = { worktreeRoot: string; connectionId: string | null }

export type DocumentRoutingDeps = {
  normalizeHostFileKey: (filePath: string) => string
  sessionsByKey: Map<string, SessionEntry>
  /** Rebuild a dropped session (relay recovery); may reject while the relay is down. */
  ensureSession: (worktreeRoot: string, sshTargetId: string | null) => Promise<ClangdSession>
}

export type DocumentRouting = {
  /** docKey → session key; the reconnect replay re-populates it on respawn. */
  sessionKeyByDocument: Map<string, string>
  /** docKey → owning worktree scope; survives session drops (click-driven recovery). */
  sessionScopeByDocument: Map<string, DocumentScope>
  set(docKey: string, sessionKey: string, scope: DocumentScope): void
  delete(docKey: string): void
  clear(): void
  sessionForDocument(filePath: string): ClangdSession | null
  sessionForDocumentOrPending(filePath: string): Promise<ClangdSession | null>
}

export function createDocumentRouting(deps: DocumentRoutingDeps): DocumentRouting {
  const { normalizeHostFileKey, sessionsByKey, ensureSession } = deps
  const sessionKeyByDocument = new Map<string, string>()
  const sessionScopeByDocument = new Map<string, DocumentScope>()

  function sessionForDocument(filePath: string): ClangdSession | null {
    const key = normalizeHostFileKey(filePath)
    const ownerKey = sessionKeyByDocument.get(key)
    if (!ownerKey) {
      return null
    }
    const entry = sessionsByKey.get(ownerKey)
    if (!entry || entry.session?.died) {
      sessionKeyByDocument.delete(key)
      return null
    }
    if (!entry.session) {
      // Start still in flight: the mapping must survive so async callers can
      // join the pending startPromise (cold-start semanticTokens race, #209).
      return null
    }
    return entry.session
  }

  /** Owning session, joining an in-flight session start when one is pending.
   *  With no live or pending session but a retained scope, rebuilds the session
   *  (relay recovery): the next click after the relay returns re-ensures,
   *  replays retained didOpens, and serves the request — no app restart. */
  async function sessionForDocumentOrPending(filePath: string): Promise<ClangdSession | null> {
    const docKey = normalizeHostFileKey(filePath)
    const direct = sessionForDocument(docKey)
    if (direct) {
      return direct
    }
    const ownerKey = sessionKeyByDocument.get(docKey)
    const pending = ownerKey ? sessionsByKey.get(ownerKey)?.startPromise : undefined
    if (!pending) {
      const scope = sessionScopeByDocument.get(docKey)
      if (!scope) {
        return null
      }
      try {
        await ensureSession(scope.worktreeRoot, scope.connectionId)
      } catch {
        // Relay still down: the gate already surfaced the degraded hint.
        return null
      }
      // replayOnRespawn (startPromise.then) re-mapped the retained docs.
      return sessionForDocument(docKey)
    }
    try {
      await pending
    } catch {
      // Start failed; dropSession already removed the entry + mappings.
    }
    return sessionForDocument(docKey)
  }

  return {
    sessionKeyByDocument,
    sessionScopeByDocument,
    set(docKey, sessionKey, scope) {
      sessionKeyByDocument.set(docKey, sessionKey)
      sessionScopeByDocument.set(docKey, scope)
    },
    delete(docKey) {
      sessionKeyByDocument.delete(docKey)
      sessionScopeByDocument.delete(docKey)
    },
    clear() {
      sessionKeyByDocument.clear()
      sessionScopeByDocument.clear()
    },
    sessionForDocument,
    sessionForDocumentOrPending
  }
}
