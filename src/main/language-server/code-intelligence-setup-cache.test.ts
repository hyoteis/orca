import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cppScopeDirectoryName,
  cppScopeDirectoryPath,
  createCodeIntelligenceSetupFingerprint,
  readCachedCodeIntelligenceSetupResult,
  sweepOrphanCppScopeDirectories,
  writeCachedCodeIntelligenceSetupResult
} from './code-intelligence-setup-cache'

const result = {
  ok: true,
  message: 'Generated compile commands with BASIC',
  log: '',
  relativeRoots: ['.'],
  installedTools: [],
  clangdExecutable: process.execPath,
  compileCommandsDir: '/cached',
  configurationMode: 'basic' as const,
  healthState: 'ready' as const,
  compileCommandCount: 1,
  warnings: []
}

const fingerprintArgs = {
  repoId: 'repo-1',
  roots: ['.'] as const,
  request: { repoId: 'repo-1', relativeRoots: ['.'], installMissingTools: true },
  buildRoots: [] as const
}

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

describe('setup manifest', () => {
  it('returns the cached result when the fingerprint matches', async () => {
    const scopeDir = await mkdtemp(join(tmpdir(), 'orca-manifest-'))
    try {
      await writeFile(join(scopeDir, 'compile_commands.json'), '[]')
      await writeCachedCodeIntelligenceSetupResult(scopeDir, 'fingerprint-1', result)
      const cached = await readCachedCodeIntelligenceSetupResult(scopeDir, 'fingerprint-1')
      expect(cached?.message).toContain('Reused cached')
      expect(cached?.compileCommandsDir).toBe(result.compileCommandsDir)
    } finally {
      await rm(scopeDir, { recursive: true, force: true })
    }
  })

  it('misses when the fingerprint changed', async () => {
    const scopeDir = await mkdtemp(join(tmpdir(), 'orca-manifest-'))
    try {
      await writeCachedCodeIntelligenceSetupResult(scopeDir, 'fingerprint-1', result)
      expect(await readCachedCodeIntelligenceSetupResult(scopeDir, 'fingerprint-2')).toBeNull()
    } finally {
      await rm(scopeDir, { recursive: true, force: true })
    }
  })

  it('misses when no manifest was written yet', async () => {
    const scopeDir = await mkdtemp(join(tmpdir(), 'orca-manifest-'))
    try {
      expect(await readCachedCodeIntelligenceSetupResult(scopeDir, 'fingerprint-1')).toBeNull()
    } finally {
      await rm(scopeDir, { recursive: true, force: true })
    }
  })

  it('changes the fingerprint when setup inputs change', async () => {
    const base = await createCodeIntelligenceSetupFingerprint(fingerprintArgs)
    const changed = await createCodeIntelligenceSetupFingerprint({
      ...fingerprintArgs,
      request: {
        ...fingerprintArgs.request,
        defines: ['FEATURE=1']
      }
    })
    expect(changed).not.toBe(base)
    expect(await createCodeIntelligenceSetupFingerprint(fingerprintArgs)).toBe(base)
  })
})

describe('sweepOrphanCppScopeDirectories', () => {
  it('keeps tools/ and scopes/, deletes legacy hash directories', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'orca-sweep-'))
    try {
      await mkdir(join(cacheRoot, 'tools', 'gn', 'windows-amd64'), { recursive: true })
      await mkdir(join(cacheRoot, 'scopes', cppScopeDirectoryName('scope-1')), { recursive: true })
      await mkdir(join(cacheRoot, '0123456789abcdef'), { recursive: true })
      await mkdir(join(cacheRoot, '.gn-install-orphan'), { recursive: true })
      await writeFile(join(cacheRoot, 'loose-file.txt'), 'keep me')

      await sweepOrphanCppScopeDirectories(cacheRoot, ['scope-1'])

      expect(await readdir(cacheRoot)).toEqual(['loose-file.txt', 'scopes', 'tools'])
      expect(await readdir(join(cacheRoot, 'tools'))).toContain('gn')
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
