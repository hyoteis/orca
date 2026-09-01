/** Transport-level "host connected" fan-out. ssh.ts owns the single
 * SshConnectionCallbacks slot, so per-host lazy work (e.g. the remote
 * code-intelligence orphan sweep) subscribes here instead of adding
 * dependencies into the SSH state machine. */
export type SshTransportConnectedListener = (targetId: string) => void

const listeners = new Set<SshTransportConnectedListener>()

export function subscribeSshTransportConnected(listener: SshTransportConnectedListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifySshTransportConnected(targetId: string): void {
  for (const listener of listeners) {
    try {
      listener(targetId)
    } catch {
      // One subscriber's failure must not block the rest or the SSH state flow.
    }
  }
}
