import { describe, expect, it, vi } from 'vitest'
import type { DirEntry } from '../../../../shared/types'
import { discoverCodeIntelligenceDirectoryBatch } from './code-intelligence-directory-discovery'

function directory(name: string, isSymlink = false): DirEntry {
  return { name, isDirectory: true, isSymlink }
}

describe('code intelligence directory discovery', () => {
  it('reads only five levels per batch', async () => {
    const segments = ['one', 'two', 'three', 'four', 'five', 'six']
    const readDirectory = vi.fn(async (directoryPath: string): Promise<DirEntry[]> => {
      const relative = directoryPath.replace('/workspace', '').replace(/^\//, '')
      const depth = relative ? relative.split('/').length : 0
      return segments[depth] ? [directory(segments[depth])] : []
    })

    const directories = await discoverCodeIntelligenceDirectoryBatch({
      workspaceRoot: '/workspace',
      startDirectory: '.',
      readDirectory
    })

    expect(directories).toContain('one/two/three/four/five')
    expect(directories).not.toContain('one/two/three/four/five/six')
    expect(readDirectory).toHaveBeenCalledTimes(5)
  })

  it('starts the next five-level batch from a selected directory', async () => {
    const readDirectory = vi.fn(async (directoryPath: string): Promise<DirEntry[]> => {
      const depth = directoryPath.split('/').filter(Boolean).length
      return depth < 10 ? [directory(`level-${depth + 1}`)] : []
    })

    const directories = await discoverCodeIntelligenceDirectoryBatch({
      workspaceRoot: '/workspace',
      startDirectory: 'level-2/level-3/level-4/level-5',
      readDirectory
    })

    expect(readDirectory).toHaveBeenCalledTimes(5)
    expect(directories.at(-1)?.split('/')).toHaveLength(9)
  })

  it('shows symlink directories without traversing them and skips .git', async () => {
    const readDirectory = vi.fn(
      async (): Promise<DirEntry[]> => [
        directory('.git'),
        directory('linked', true),
        { name: 'file.cpp', isDirectory: false, isSymlink: false }
      ]
    )

    await expect(
      discoverCodeIntelligenceDirectoryBatch({
        workspaceRoot: 'C:\\workspace',
        startDirectory: '.',
        readDirectory
      })
    ).resolves.toEqual(['.', 'linked'])
    expect(readDirectory).toHaveBeenCalledTimes(1)
  })
})
