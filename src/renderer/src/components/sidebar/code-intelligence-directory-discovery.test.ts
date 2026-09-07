import { describe, expect, it, vi } from 'vitest'
import type { DirEntry } from '../../../../shared/types'
import {
  discoverCodeIntelligenceDirectories,
  discoverCodeIntelligenceDirectoryBatch
} from './code-intelligence-directory-discovery'

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

  it('lists build/output directories without descending into them', async () => {
    const readDirectory = vi.fn(async (directoryPath: string): Promise<DirEntry[]> => {
      if (directoryPath.endsWith('node_modules')) {
        return [directory('should-not-appear')]
      }
      return [directory('node_modules'), directory('src')]
    })

    const directories = await discoverCodeIntelligenceDirectoryBatch({
      workspaceRoot: '/workspace',
      startDirectory: '.',
      readDirectory
    })

    expect(directories).toContain('node_modules')
    expect(directories).not.toContain('node_modules/should-not-appear')
  })

  it('prefers the one-shot tree listing and normalizes its paths', async () => {
    const readDirectory = vi.fn()
    const readDirectoryTree = vi.fn(async () => ['', 'src', 'src/engine', './generated'])

    await expect(
      discoverCodeIntelligenceDirectories({
        workspaceRoot: '/workspace',
        startDirectory: '.',
        readDirectory,
        readDirectoryTree
      })
    ).resolves.toEqual(['.', 'generated', 'src', 'src/engine'])
    expect(readDirectoryTree).toHaveBeenCalledWith('/workspace', 5)
    expect(readDirectory).not.toHaveBeenCalled()
  })

  it('falls back to the per-directory BFS when the tree call is unsupported or fails', async () => {
    const readDirectory = vi.fn(async (directoryPath: string): Promise<DirEntry[]> =>
      directoryPath === '/workspace' ? [directory('src')] : []
    )
    for (const readDirectoryTree of [
      vi.fn(async () => null),
      vi.fn(async () => {
        throw new Error('transport failed')
      })
    ]) {
      await expect(
        discoverCodeIntelligenceDirectories({
          workspaceRoot: '/workspace',
          startDirectory: '.',
          readDirectory,
          readDirectoryTree
        })
      ).resolves.toEqual(['.', 'src'])
    }
    expect(readDirectory).toHaveBeenCalledTimes(4)
  })
})
