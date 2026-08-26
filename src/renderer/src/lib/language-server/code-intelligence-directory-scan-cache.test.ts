import { describe, expect, it, vi } from 'vitest'
import { getCachedCodeIntelligenceDirectories } from './code-intelligence-directory-scan-cache'

describe('code intelligence directory scan cache', () => {
  it('reuses fresh scans and supports forced refresh', async () => {
    const loadFiles = vi.fn().mockResolvedValue(['src/render/file.cpp'])

    await expect(
      getCachedCodeIntelligenceDirectories({ key: 'repo-a', loadFiles, now: 100 })
    ).resolves.toEqual(['.', 'src', 'src/render'])
    await getCachedCodeIntelligenceDirectories({ key: 'repo-a', loadFiles, now: 200 })
    await getCachedCodeIntelligenceDirectories({
      key: 'repo-a',
      loadFiles,
      force: true,
      now: 300
    })

    expect(loadFiles).toHaveBeenCalledTimes(2)
  })
})
