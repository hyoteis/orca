import { describe, expect, it } from 'vitest'
import { LanguageServerSessionLifecycle } from './language-server-session-lifecycle'
describe('LanguageServerSessionLifecycle', () => {
  it('rejects stale generations and opens a crash circuit', () => {
    const state = new LanguageServerSessionLifecycle({ maxCrashes: 3, restartDelaysMs: [10, 20] })
    const first = state.beginGeneration(),
      second = state.beginGeneration()
    expect(state.isCurrent(first)).toBe(false)
    expect(state.isCurrent(second)).toBe(true)
    expect(state.recordCrash(0)).toEqual({ type: 'restart', delayMs: 10 })
    expect(state.recordCrash(1)).toEqual({ type: 'restart', delayMs: 20 })
    expect(state.recordCrash(2)).toEqual({ type: 'circuit-open' })
  })
})
