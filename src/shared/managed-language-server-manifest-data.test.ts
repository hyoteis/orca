import { describe, expect, it } from 'vitest'
import { MANAGED_LANGUAGE_SERVER_MANIFEST } from './managed-language-server-manifest-data'

describe('MANAGED_LANGUAGE_SERVER_MANIFEST', () => {
  it('has unique ids and structurally valid entries', () => {
    const ids = new Set<string>()
    for (const entry of MANAGED_LANGUAGE_SERVER_MANIFEST.entries) {
      expect(ids.has(entry.id), entry.id).toBe(false)
      ids.add(entry.id)
      expect(entry.version).toMatch(/^\d+(\.\d+)+$/)
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.sizeBytes).toBeGreaterThan(0)
      expect(entry.sourceUrl).toMatch(/^https:\/\//)
      expect(entry.archiveFileName.length).toBeGreaterThan(0)
      expect(entry.archiveRootDirectory.length).toBeGreaterThan(0)
      expect(entry.license.name).toMatch(/^(MIT|Apache-2.0)/)
    }
  })

  it('ships clangd-only entries after the python removal (#131)', () => {
    const tools = new Set(MANAGED_LANGUAGE_SERVER_MANIFEST.entries.map((entry) => entry.tool))
    expect([...tools]).toEqual(['clangd'])
  })

  it('pins clangd for the supported Hosts with a universal mac artifact', () => {
    const clangd = MANAGED_LANGUAGE_SERVER_MANIFEST.entries.filter((entry) => entry.tool === 'clangd')
    expect(clangd.map((entry) => `${entry.platform}-${entry.arch}`).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'win32-x64'
    ])
    const mac = clangd.filter((entry) => entry.platform === 'darwin')
    expect(mac[0]!.sha256).toBe(mac[1]!.sha256)
    // No zero-hash placeholders may ship.
    for (const entry of clangd) {
      expect(entry.sha256).not.toMatch(/^0+$/)
    }
  })
})
