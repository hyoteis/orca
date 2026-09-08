import { describe, expect, it, vi } from 'vitest'
import { AggregateRefreshCoordinator } from './code-intelligence-aggregate-refresh'

const flush = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('AggregateRefreshCoordinator', () => {
  it('debounces bursts into one rebuild per scope', async () => {
    const rebuild = vi.fn(async () => {})
    const coordinator = new AggregateRefreshCoordinator(20)
    coordinator.track('scope-a', ['/cdb/one.json'], rebuild)

    coordinator.handleFileChange(['/cdb/one.json'])
    coordinator.handleFileChange(['/cdb/one.json', '/unrelated/file.txt'])
    coordinator.handleFileChange(['/cdb/one.json'])
    await flush(5)
    expect(rebuild).not.toHaveBeenCalled()
    await flush(30)
    expect(rebuild).toHaveBeenCalledTimes(1)
    coordinator.dispose()
  })

  it('ignores events that hit no tracked database', async () => {
    const rebuild = vi.fn(async () => {})
    const coordinator = new AggregateRefreshCoordinator(5)
    coordinator.track('scope-a', ['/cdb/one.json'], rebuild)
    coordinator.handleFileChange(['/ws/src/main.cpp', '/cdb/other.json'])
    await flush(20)
    expect(rebuild).not.toHaveBeenCalled()
    coordinator.dispose()
  })

  it('keeps scopes independent and single-flights concurrent triggers', async () => {
    const resolvers: (() => void)[] = []
    const rebuildA = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve)
        })
    )
    const rebuildB = vi.fn(async () => {})
    const coordinator = new AggregateRefreshCoordinator(5)
    coordinator.track('scope-a', ['/cdb/a.json'], rebuildA)
    coordinator.track('scope-b', ['/cdb/b.json'], rebuildB)

    // Two events for scope-a while its rebuild is pending join the same flight.
    coordinator.handleFileChange(['/cdb/a.json'])
    await flush(10)
    expect(rebuildA).toHaveBeenCalledTimes(1)
    coordinator.handleFileChange(['/cdb/a.json'])
    // scope-b fires independently.
    coordinator.handleFileChange(['/cdb/b.json'])
    await flush(10)
    expect(rebuildB).toHaveBeenCalledTimes(1)
    expect(rebuildA).toHaveBeenCalledTimes(1)
    resolvers[0]?.()
    await flush(5)
    expect(rebuildA).toHaveBeenCalledTimes(1)
    coordinator.dispose()
  })

  it('never lets a failing rebuild escape or block later refreshes', async () => {
    let calls = 0
    const coordinator = new AggregateRefreshCoordinator(5)
    coordinator.track('scope', ['/cdb/one.json'], async () => {
      calls += 1
      if (calls === 1) {
        throw new Error('mount vanished')
      }
    })
    coordinator.handleFileChange(['/cdb/one.json'])
    await flush(15)
    coordinator.handleFileChange(['/cdb/one.json'])
    await flush(15)
    expect(calls).toBe(2)
    coordinator.dispose()
  })

  it('re-merges on session-open drift and stays quiet while signatures match', async () => {
    const signatures = new Map([['/cdb/one.json', 'mtime:1']])
    const probe = async (paths: readonly string[]) =>
      paths.map((path) => signatures.get(path) ?? null)
    const rebuild = vi.fn(async () => {})
    const coordinator = new AggregateRefreshCoordinator()
    coordinator.track('scope', ['/cdb/one.json'], rebuild)

    // First open after app start: no recorded merge signature → re-merge.
    expect(await coordinator.refreshIfDrifted('scope', probe)).toBe(true)
    expect(rebuild).toHaveBeenCalledTimes(1)
    coordinator.noteMerged('scope', 'mtime:1')

    // In-band change lands through the watch path and re-records the merge.
    signatures.set('/cdb/one.json', 'mtime:2')
    coordinator.handleFileChange(['/cdb/one.json'])
    await flush(600)
    expect(rebuild).toHaveBeenCalledTimes(2)
    coordinator.noteMerged('scope', 'mtime:2')
    expect(await coordinator.refreshIfDrifted('scope', probe)).toBe(false)
    expect(rebuild).toHaveBeenCalledTimes(2)

    // Out-of-band change (watch missed): session open catches it.
    signatures.set('/cdb/one.json', 'mtime:3')
    expect(await coordinator.refreshIfDrifted('scope', probe)).toBe(true)
    expect(rebuild).toHaveBeenCalledTimes(3)
    coordinator.dispose()
  })

  it('treats an unreadable database as drift', async () => {
    const probe = async () => [null]
    const rebuild = vi.fn(async () => {})
    const coordinator = new AggregateRefreshCoordinator()
    coordinator.track('scope', ['/cdb/one.json'], rebuild)
    coordinator.noteMerged('scope', 'mtime:1')
    expect(await coordinator.refreshIfDrifted('scope', probe)).toBe(true)
    expect(rebuild).toHaveBeenCalledTimes(1)
    coordinator.dispose()
  })

  it('untracks empty scopes and disposes pending timers', async () => {
    const rebuild = vi.fn(async () => {})
    const coordinator = new AggregateRefreshCoordinator(10)
    coordinator.track('scope', ['/cdb/one.json'], rebuild)
    coordinator.handleFileChange(['/cdb/one.json'])
    coordinator.untrack('scope')
    await flush(30)
    expect(rebuild).not.toHaveBeenCalled()
    expect(await coordinator.refreshIfDrifted('scope', async () => [])).toBe(false)
    coordinator.dispose()
  })
})
