/** Mirrors oh-my-pi's initFailures: a deterministic init failure fails fast
 * instead of re-spawning the full handshake on every editor query (#164). */
export const CPP_INIT_FAILURE_TTL_MS = 3 * 60_000

type CachedFailure = { at: number; message: string }

/** Timeouts, cancels, and dropped connections may recover on the next
 * attempt — those stay uncached so a slow or reconnecting server retries. */
export function isTransientInitFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /timed? ?out|timeout|abort|cancel|not connected|connection|closed/i.test(message)
}

export class CppInitFailureCache {
  private readonly failures = new Map<string, CachedFailure>()

  /** Cached rejection for the scope, or null when none is fresh. */
  cached(scopeId: string, now = Date.now()): Error | null {
    const failure = this.failures.get(scopeId)
    if (!failure) {
      return null
    }
    if (now - failure.at >= CPP_INIT_FAILURE_TTL_MS) {
      this.failures.delete(scopeId)
      return null
    }
    return new Error(
      `clangd session failed to start recently (cached): ${failure.message}. Re-run C++ setup or restart the session to retry now.`
    )
  }

  record(scopeId: string, message: string, now = Date.now()): void {
    this.failures.set(scopeId, { at: now, message })
  }

  /** Manual restart (#149) and scope reload clear the way for a fresh spawn. */
  clear(scopeId: string): void {
    this.failures.delete(scopeId)
  }
}
