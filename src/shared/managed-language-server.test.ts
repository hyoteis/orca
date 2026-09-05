import { describe, expect, it } from 'vitest'
import type {
  ManagedLanguageServerActivationRecord,
  ManagedLanguageServerManifestEntry
} from './managed-language-server'
import {
  compareManagedLanguageServerVersions,
  manifestEntryForLaunch,
  resolveManagedLanguageServerEntry
} from './managed-language-server'

const entry = (overrides: Partial<ManagedLanguageServerManifestEntry>): ManagedLanguageServerManifestEntry => ({
  id: 'e',
  tool: 'clangd',
  version: '22.1.6',
  platform: 'linux',
  arch: 'x64',
  sourceUrl: 'https://example.test/clangd.zip',
  archiveFileName: 'clangd.zip',
  archiveFormat: 'zip',
  sizeBytes: 1,
  sha256: 'a'.repeat(64),
  archiveRootDirectory: 'clangd_22.1.6',
  probe: { executable: '{root}/bin/clangd', args: ['--version'] },
  command: { executable: '{root}/bin/clangd', args: [] },
  license: { name: 'Apache-2.0', url: 'https://example.test/license' },
  ...overrides
})

const manifest = (entries: ManagedLanguageServerManifestEntry[]) => ({
  manifestVersion: 1,
  entries
})

describe('compareManagedLanguageServerVersions', () => {
  it('orders dotted numerics', () => {
    expect(compareManagedLanguageServerVersions('22.1.6', '22.1')).toBeGreaterThan(0)
    expect(compareManagedLanguageServerVersions('9.0.0', '10.0.0')).toBeLessThan(0)
    expect(compareManagedLanguageServerVersions('1.2.3', '1.2.3')).toBe(0)
  })
})

describe('manifestEntryForLaunch', () => {
  const host = { platform: 'linux', arch: 'x64' }
  const m = manifest([
    entry({ id: 'clangd@22.1.6:linux-x64' }),
    entry({ id: 'clangd@21.0.0:linux-x64', version: '21.0.0' }),
    entry({ id: 'clangd@22.1.6:win32-x64', platform: 'win32' })
  ])
  const activation = (version: string, entryId: string): ManagedLanguageServerActivationRecord => ({
    active: { version, entryId, activatedAt: 1 }
  })

  it('prefers an explicitly requested version over the record', () => {
    expect(
      manifestEntryForLaunch(
        m,
        activation('22.1.6', 'clangd@22.1.6:linux-x64'),
        { tool: 'clangd', version: '21.0.0' },
        host
      )
    ).toMatchObject({ version: '21.0.0' })
  })

  it('resolves the active record by entryId', () => {
    expect(
      manifestEntryForLaunch(
        m,
        activation('22.1.6', 'clangd@22.1.6:linux-x64'),
        { tool: 'clangd' },
        host
      )
    ).toMatchObject({ id: 'clangd@22.1.6:linux-x64' })
  })

  it('falls back to a platform match when manifest rotation retired the entryId', () => {
    expect(
      manifestEntryForLaunch(m, activation('22.1.6', 'clangd@22.1.6:retired'), { tool: 'clangd' }, host)
    ).toMatchObject({ id: 'clangd@22.1.6:linux-x64' })
  })

  it('returns undefined when the version has no entry for this host', () => {
    expect(
      manifestEntryForLaunch(m, activation('20.0.0', 'clangd@20.0.0:linux-x64'), { tool: 'clangd' }, host)
    ).toBeUndefined()
  })
})

describe('resolveManagedLanguageServerEntry', () => {
  it('picks the newest matching entry when no version is requested', () => {
    const result = resolveManagedLanguageServerEntry(
      manifest([entry({ version: '21.0.0' }), entry({ version: '22.1.6' })]),
      { tool: 'clangd' },
      { platform: 'linux', arch: 'x64' }
    )
    expect(result).toMatchObject({ entry: { version: '22.1.6' } })
  })

  it('never cross-matches a shared version onto another platform entry', () => {
    // Regression: one version ships several per-Host entries; the latest pick
    // must stay within the requesting Host's platform/arch.
    const sameVersion = [
      entry({ id: 'clangd@22.1.6:win32-x64', platform: 'win32', arch: 'x64' }),
      entry({ id: 'clangd@22.1.6:linux-x64', platform: 'linux', arch: 'x64' })
    ]
    expect(
      resolveManagedLanguageServerEntry(manifest(sameVersion), { tool: 'clangd' }, {
        platform: 'linux',
        arch: 'x64'
      })
    ).toMatchObject({ entry: { id: 'clangd@22.1.6:linux-x64' } })
    expect(
      resolveManagedLanguageServerEntry(
        manifest(sameVersion),
        { tool: 'clangd', version: '22.1.6' },
        { platform: 'darwin', arch: 'arm64' }
      )
    ).toMatchObject({ unsupported: { type: 'unsupported-platform' } })
  })

  it('rejects an explicit unknown version', () => {
    const result = resolveManagedLanguageServerEntry(
      manifest([entry({})]),
      { tool: 'clangd', version: '99.0.0' },
      { platform: 'linux', arch: 'x64' }
    )
    expect(result).toMatchObject({ unsupported: { type: 'unknown-version', version: '99.0.0' } })
  })

  it('rejects platform/arch combinations with no pinned artifact', () => {
    const result = resolveManagedLanguageServerEntry(
      manifest([entry({})]),
      { tool: 'clangd' },
      { platform: 'freebsd', arch: 'x64' }
    )
    expect(result).toMatchObject({
      unsupported: { type: 'unsupported-platform', platform: 'freebsd' }
    })
  })

  it('honors the glibc floor when the host reports an older glibc', () => {
    const result = resolveManagedLanguageServerEntry(
      manifest([entry({ glibcFloor: '2.31' })]),
      { tool: 'clangd' },
      { platform: 'linux', arch: 'x64', glibcVersion: '2.17' }
    )
    expect(result).toMatchObject({
      unsupported: { type: 'unsupported-glibc', glibcVersion: '2.17', floor: '2.31' }
    })
  })

  it('allows linux entries with unknown glibc telemetry', () => {
    const result = resolveManagedLanguageServerEntry(
      manifest([entry({ glibcFloor: '2.31' })]),
      { tool: 'clangd' },
      { platform: 'linux', arch: 'x64' }
    )
    expect(result).toMatchObject({ entry: { version: '22.1.6' } })
  })

  it('resolves the private managed runtime dependency', () => {
    const node = entry({
      id: 'node',
      tool: 'clangd',
      version: '24.20.0',
      archiveRootDirectory: 'node-v24.20.0-linux-x64'
    })
    const pyright = entry({
      id: 'pyright',
      tool: 'pyright',
      platform: 'linux',
      runtimeEntryId: 'node',
      command: { executable: '{runtime}/bin/node', args: ['{root}/langserver.index.js', '--stdio'] }
    })
    const result = resolveManagedLanguageServerEntry(
      manifest([node, pyright]),
      { tool: 'pyright' },
      { platform: 'linux', arch: 'x64' }
    )
    expect(result).toMatchObject({ entry: { id: 'pyright' }, runtimeEntry: { id: 'node' } })
  })

  it('treats a missing runtime dependency as unsupported', () => {
    const pyright = entry({ id: 'pyright', tool: 'pyright', runtimeEntryId: 'node' })
    const result = resolveManagedLanguageServerEntry(
      manifest([pyright]),
      { tool: 'pyright' },
      { platform: 'linux', arch: 'x64' }
    )
    expect(result).toMatchObject({ unsupported: { type: 'unknown-version' } })
  })
})
