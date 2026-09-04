import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cppScopeDirectoryName,
  cppScopeDirectoryPath,
  codeIntelligenceSetupFingerprintDigest,
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

  it('changes the fingerprint when setup inputs change', () => {
    const digestArgs = {
      repoId: 'repo-1',
      roots: ['module'] as const,
      request: { repoId: 'repo-1', relativeRoots: ['module'], installMissingTools: true },
      buildInputs: [
        {
          path: '/srv/project/module',
          system: 'cmake' as const,
          directoryModifiedAt: 1000,
          cmakeModifiedAt: 2000,
          gnModifiedAt: 0,
          dotGnModifiedAt: 0
        }
      ]
    }
    const base = codeIntelligenceSetupFingerprintDigest(digestArgs)
    expect(
      codeIntelligenceSetupFingerprintDigest({
        ...digestArgs,
        request: { ...digestArgs.request, defines: ['FEATURE=1'] }
      })
    ).not.toBe(base)
    expect(codeIntelligenceSetupFingerprintDigest(digestArgs)).toBe(base)
  })

  it('keeps the digest byte-stable across refactors (setup caches depend on it)', () => {
    // Golden sha256: any change to the payload shape or key order invalidates
    // every user's local and remote setup cache. Update only deliberately.
    expect(
      codeIntelligenceSetupFingerprintDigest({
        repoId: 'repo-1',
        roots: ['module'],
        request: {
          repoId: 'repo-1',
          relativeRoots: ['module'],
          installMissingTools: true,
          defines: ['FEATURE=1'],
          additionalIncludeDirectories: ['vendor/include'],
          cppStandard: 'c++20'
        },
        buildInputs: [
          {
            path: '/srv/project/module',
            system: 'cmake',
            directoryModifiedAt: 1000,
            cmakeModifiedAt: 2000,
            gnModifiedAt: 0,
            dotGnModifiedAt: 0
          }
        ]
      })
    ).toBe('9ca0611531ea76f926d75f106258f1ef51c41cf84c83065fb23aa808664ac6da')
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
