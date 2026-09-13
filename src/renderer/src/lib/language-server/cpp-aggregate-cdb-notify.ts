import type { CppActiveClient } from './cpp-code-intelligence-session'
import { toServerFileUri } from './language-server-document-uri'

/** #165: best-effort didChangeWatchedFiles for a rewritten aggregate CDB —
 * never blocks the push, never throws (a dead session heals via restart).
 * Absent path = old Host (mixed versions); absent client = nothing live. */
export function notifyAggregateCdbRewritten(
  clients: ReadonlyMap<string, CppActiveClient>,
  change: { scopeId: string; aggregateCdbPath?: unknown }
): void {
  const cdbPath = typeof change.aggregateCdbPath === 'string' ? change.aggregateCdbPath : null
  const active = clients.get(change.scopeId)
  if (!cdbPath || !active) {
    return
  }
  void active.client.connection
    .sendNotification('workspace/didChangeWatchedFiles', {
      changes: [{ uri: toServerFileUri(cdbPath), type: 2 }]
    })
    .catch(() => {})
}
