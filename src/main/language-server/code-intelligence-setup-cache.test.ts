import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cppScopeDirectoryName,
  cppScopeDirectoryPath,
  sweepOrphanCppScopeDirectories
} from './code-intelligence-setup-cache'

describe('cppScopeDirectoryName', () => {
  it('derives a stable 16-hex directory name from the scope id', () => {
    const scopeId = 'local%3Ax:worktree:repo-1:cpp'
    expect(cppScopeDirectoryName(scopeId)).toMatch(/^[0-9a-f]{16}$/)
    expect(cppScopeDirectoryName(scopeId)).toBe(cppScopeDirectoryName(scopeId))
    expect(cppScopeDirectoryName('other-scope')).not.toBe(cppScopeDirectoryName(scopeId))
  })

  it('places scope directories under the scopes cache layout', () => {
    expect(cppScopeDirectoryPath('C:/cache', 'local:worktree:repo-1:cpp')).toBe(
      join('C:/cache', 'scopes', cppScopeDirectoryName('local:worktree:repo-1:cpp'))
    )
  })
})

describe('sweepOrphanCppScopeDirectories', () => {
  it('keeps scopes/ and loose files, deletes legacy hash and tool directories', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'orca-sweep-'))
    try {
      await mkdir(join(cacheRoot, 'tools', 'gn', 'windows-amd64'), { recursive: true })
      await mkdir(join(cacheRoot, 'scopes', cppScopeDirectoryName('scope-1')), { recursive: true })
      await mkdir(join(cacheRoot, '0123456789abcdef'), { recursive: true })
      await mkdir(join(cacheRoot, '.gn-install-orphan'), { recursive: true })
      await writeFile(join(cacheRoot, 'loose-file.txt'), 'keep me')

      await sweepOrphanCppScopeDirectories(cacheRoot, ['scope-1'])

      expect(await readdir(cacheRoot)).toEqual(['loose-file.txt', 'scopes'])
    } finally {
      await rm(cacheRoot, { recursive: true, force: true })
    }
  })

  it('deletes scope directories no live scope owns (spec §6)', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'orca-sweep-'))
    try {
      await mkdir(join(cacheRoot, 'scopes', cppScopeDirectoryName('live')), { recursive: true })
      const orphan = join(cacheRoot, 'scopes', cppScopeDirectoryName('deleted-scope'))
      await mkdir(join(orphan, '.cache', 'clangd', 'index'), { recursive: true })

      await sweepOrphanCppScopeDirectories(cacheRoot, ['live'])

      expect(await readdir(join(cacheRoot, 'scopes'))).toEqual([cppScopeDirectoryName('live')])
    } finally {
      await rm(cacheRoot, { recursive: true, force: true })
    }
  })

  it('stays silent when the cache root does not exist yet', async () => {
    await expect(
      sweepOrphanCppScopeDirectories(join(tmpdir(), 'orca-sweep-missing'), [])
    ).resolves.toBeUndefined()
  })
})
