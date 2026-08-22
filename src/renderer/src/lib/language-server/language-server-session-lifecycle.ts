export type SessionRestartDecision = { type: 'restart'; delayMs: number } | { type: 'circuit-open' }
export class LanguageServerSessionLifecycle {
  private generation = 0
  private crashes: number[] = []
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  constructor(
    private readonly options: {
      crashWindowMs?: number
      maxCrashes?: number
      restartDelaysMs?: readonly number[]
      idleTimeoutMs?: number
    } = {}
  ) {}
  beginGeneration(): number {
    this.generation += 1
    return this.generation
  }
  isCurrent(generation: number): boolean {
    return generation === this.generation
  }
  recordCrash(now = Date.now()): SessionRestartDecision {
    const windowMs = this.options.crashWindowMs ?? 300_000,
      max = this.options.maxCrashes ?? 3
    this.crashes = this.crashes.filter((at) => now - at <= windowMs)
    this.crashes.push(now)
    if (this.crashes.length >= max) return { type: 'circuit-open' }
    const delays = this.options.restartDelaysMs ?? [1_000, 2_000, 5_000, 30_000]
    return {
      type: 'restart',
      delayMs: delays[Math.min(this.crashes.length - 1, delays.length - 1)]
    }
  }
  clearCrashHistory(): void {
    this.crashes = []
  }
  scheduleIdle(onIdle: () => void): void {
    this.cancelIdle()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      onIdle()
    }, this.options.idleTimeoutMs ?? 300_000)
    this.idleTimer.unref?.()
  }
  cancelIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
  dispose(): void {
    this.cancelIdle()
    this.generation += 1
  }
}
