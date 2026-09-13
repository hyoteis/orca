import { describe, expect, it, vi } from 'vitest'
import { CppIndexingProgress } from './cpp-indexing-progress'

const begin = { kind: 'begin', title: 'indexing', percentage: 0 }
const report = (percentage: number) => ({ kind: 'report', percentage })
const end = { kind: 'end' }

describe('cpp indexing progress (#163)', () => {
  it('activates on begin and carries the title', () => {
    const progress = new CppIndexingProgress()
    const events: unknown[] = []
    progress.onState((state) => events.push(state))

    progress.apply('scope', 'tok', begin)

    expect(progress.stateFor('scope')).toEqual({
      scopeId: 'scope',
      active: true,
      percentage: 0
    })
    expect(events).toEqual([{ scopeId: 'scope', active: true, percentage: 0 }])
  })

  it('updates the percentage on report and deactivates on end', () => {
    const progress = new CppIndexingProgress()
    const events: unknown[] = []
    progress.onState((state) => events.push(state))

    progress.apply('scope', 'tok', begin)
    progress.apply('scope', 'tok', report(45))
    progress.apply('scope', 'tok', report(45))
    progress.apply('scope', 'tok', end)

    expect(progress.stateFor('scope')).toEqual({ scopeId: 'scope', active: false })
    expect(events.map((event) => (event as { percentage?: number }).percentage)).toEqual([
      0, 45, undefined
    ])
  })

  it('stays active while any token remains, tracking the latest one', () => {
    const progress = new CppIndexingProgress()

    progress.apply('scope', 'a', begin)
    progress.apply('scope', 'b', begin)
    progress.apply('scope', 'b', report(80))

    expect(progress.stateFor('scope')).toMatchObject({ active: true, percentage: 80 })

    progress.apply('scope', 'b', end)

    // Token a is still running; falls back to its last known payload.
    expect(progress.stateFor('scope')).toMatchObject({ active: true })

    progress.apply('scope', 'a', end)

    expect(progress.stateFor('scope')).toEqual({ scopeId: 'scope', active: false })
  })

  it('keeps scopes isolated', () => {
    const progress = new CppIndexingProgress()
    progress.apply('a', 't', begin)
    progress.apply('b', 't', begin)

    expect(progress.stateFor('a')).toMatchObject({ scopeId: 'a', active: true })
    expect(progress.stateFor('b')).toMatchObject({ scopeId: 'b', active: true })
  })

  it('clearScope wipes the scope and broadcasts inactive', () => {
    const progress = new CppIndexingProgress()
    const events: unknown[] = []
    progress.onState((state) => events.push(state))
    progress.apply('scope', 't', begin)

    progress.clearScope('scope')

    expect(progress.stateFor('scope')).toEqual({ scopeId: 'scope', active: false })
    expect(events.at(-1)).toEqual({ scopeId: 'scope', active: false })
  })

  it('returns a stable reference per state for React getSnapshot', () => {
    const progress = new CppIndexingProgress()
    progress.apply('scope', 't', begin)
    const first = progress.stateFor('scope')
    progress.apply('other', 't', begin)
    expect(progress.stateFor('scope')).toBe(first)
  })

  it('stops delivering after unsubscribe', () => {
    const progress = new CppIndexingProgress()
    const events: unknown[] = []
    const unsubscribe = progress.onState((state) => events.push(state))
    unsubscribe()

    progress.apply('scope', 't', begin)

    expect(events).toEqual([])
    expect(progress.stateFor('scope')).toMatchObject({ active: true })
  })

  it('ignores unknown progress kinds instead of throwing', () => {
    const progress = new CppIndexingProgress()
    const listener = vi.fn()
    progress.onState(listener)

    expect(() => progress.apply('scope', 't', { kind: 'weird' })).not.toThrow()
    expect(listener).not.toHaveBeenCalled()
  })
})
