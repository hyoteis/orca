import { describe, expect, it, vi } from 'vitest'
import { getCachedCodeIntelligenceDirectories } from './code-intelligence-directory-scan-cache'

function memoryStorage() {
  const entries = new Map<string, string>()
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value)
    },
    snapshot: () => entries
  }
}

describe('code intelligence directory scan cache', () => {
  it('reuses fresh scans and supports forced refresh', async () => {
    const loadDirectories = vi.fn().mockResolvedValue(['.', 'src', 'src/render'])

    await expect(
      getCachedCodeIntelligenceDirectories({ key: 'repo-a', loadDirectories, now: 100 })
    ).resolves.toEqual(['.', 'src', 'src/render'])
    await getCachedCodeIntelligenceDirectories({ key: 'repo-a', loadDirectories, now: 200 })
    await getCachedCodeIntelligenceDirectories({
      key: 'repo-a',
      loadDirectories,
      force: true,
      now: 300
    })

    expect(loadDirectories).toHaveBeenCalledTimes(2)
  })

  it('persists scans so a fresh module instance skips the rescan until the TTL lapses', async () => {
    const storage = memoryStorage()
    const first = vi.fn().mockResolvedValue(['.', 'src'])
    await getCachedCodeIntelligenceDirectories({
      key: 'repo-persist',
      loadDirectories: first,
      now: 100,
      storage
    })
    expect(storage.snapshot().size).toBe(1)

    // Simulated app restart: module re-evaluated, storage survives.
    vi.resetModules()
    const { getCachedCodeIntelligenceDirectories: revived } = await import(
      './code-intelligence-directory-scan-cache'
    )
    const second = vi.fn().mockResolvedValue(['.'])
    await expect(
      revived({ key: 'repo-persist', loadDirectories: second, now: 200, storage })
    ).resolves.toEqual(['.', 'src'])
    expect(second).not.toHaveBeenCalled()

    const expired = vi.fn().mockRejectedValue(new Error('expired scan reloads'))
    await expect(
      revived({
        key: 'repo-persist',
        loadDirectories: expired,
        now: 100 + 10 * 60_000 + 1,
        storage
      })
    ).rejects.toThrow('expired scan reloads')
  })

  it('treats corrupt persisted payloads as a cache miss', async () => {
    const storage = memoryStorage()
    storage.setItem('orca.codeIntelligence.directoryScan.v1', '{not json')
    const loadDirectories = vi.fn().mockResolvedValue(['.'])

    await expect(
      getCachedCodeIntelligenceDirectories({ key: 'repo-corrupt', loadDirectories, now: 100, storage })
    ).resolves.toEqual(['.'])
    expect(loadDirectories).toHaveBeenCalledOnce()
  })
})
