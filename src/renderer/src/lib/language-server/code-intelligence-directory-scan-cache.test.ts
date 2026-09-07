import { describe, expect, it, vi } from 'vitest'
import { getCachedCodeIntelligenceDirectories } from './code-intelligence-directory-scan-cache'

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
})
