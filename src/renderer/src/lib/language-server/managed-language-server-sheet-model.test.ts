import { describe, expect, it } from 'vitest'
import type { ManagedLanguageServerInstallEvent } from '../../../../shared/managed-language-server'
import type { ManagedLanguageServerInstallState } from '../../../../shared/managed-language-server'
import {
  deriveManagedServerSheetView,
  managedInstallProgressPercent,
  needsFirstManagedInstallConsent
} from './managed-language-server-sheet-model'

const state = (overrides: Partial<ManagedLanguageServerInstallState> = {}): ManagedLanguageServerInstallState => ({
  tool: 'clangd',
  supported: true,
  activeVersion: '22.1.6',
  rollbackVersion: null,
  installedVersions: ['22.1.6'],
  latestEntry: {
    id: 'clangd-22.1.6-linux-x64',
    tool: 'clangd',
    version: '22.1.6',
    platform: 'linux',
    arch: 'x64',
    sourceUrl: 'https://example.invalid/clangd.tar.xz',
    archiveFileName: 'clangd-22.1.6-linux-x64.tar.xz',
    archiveFormat: 'tar-xz',
    sizeBytes: 193_000_000,
    sha256: 'a'.repeat(64),
    archiveRootDirectory: '.',
    probe: { executable: '{root}/clangd', args: ['--version'] },
    command: { executable: '{root}/clangd', args: [] },
    license: { name: 'Apache-2.0', url: 'https://example.invalid/license' }
  },
  updateAvailable: false,
  ...overrides
})

const event = (overrides: Partial<ManagedLanguageServerInstallEvent>): ManagedLanguageServerInstallEvent => ({
  executionHostId: 'local',
  tool: 'clangd',
  version: '22.1.6',
  phase: 'download',
  ...overrides
})

describe('managedInstallProgressPercent', () => {
  it('computes percent for byte-counted phases', () => {
    expect(
      managedInstallProgressPercent(event({ receivedBytes: 50, totalBytes: 200 }))
    ).toBe(25)
  })

  it('clamps above 100 and returns null without totals', () => {
    expect(managedInstallProgressPercent(event({ receivedBytes: 500, totalBytes: 200 }))).toBe(100)
    expect(managedInstallProgressPercent(event({ receivedBytes: 50 }))).toBeNull()
    expect(managedInstallProgressPercent(null)).toBeNull()
  })
})

describe('deriveManagedServerSheetView', () => {
  it('returns null while the state snapshot is unknown', () => {
    expect(deriveManagedServerSheetView({ state: null, event: null })).toBeNull()
  })

  it('marks unsupported hosts for attention', () => {
    const view = deriveManagedServerSheetView({
      state: state({
        supported: false,
        unsupportedReason: { type: 'unsupported-glibc', glibcVersion: '2.17', floor: '2.31' },
        activeVersion: null,
        installedVersions: [],
        updateAvailable: false
      }),
      event: null
    })
    expect(view?.status).toBe('unsupported')
    expect(view?.needsAttention).toBe(true)
  })

  it('treats a runtime host without the capability as unsupported', () => {
    const view = deriveManagedServerSheetView({
      state: null,
      event: null,
      runtimeCapabilityUnsupported: true
    })
    expect(view?.status).toBe('unsupported')
    expect(view?.needsAttention).toBe(true)
  })

  it('a running phase wins over the snapshot', () => {
    const view = deriveManagedServerSheetView({
      state: state({ activeVersion: null, installedVersions: [], updateAvailable: false }),
      event: event({ phase: 'extract' })
    })
    expect(view?.status).toBe('installing')
    expect(view?.needsAttention).toBe(false)
    expect(view?.progressPercent).toBeNull()
    // #15 active-version safety: the running version stays visible.
    expect(view?.safeActiveVersion).toBeNull()
  })

  it('an error event fails with attention; canceled does not', () => {
    const failed = deriveManagedServerSheetView({
      state: state(),
      event: event({ phase: 'error', message: 'ECONNRESET' })
    })
    expect(failed?.status).toBe('failed')
    expect(failed?.needsAttention).toBe(true)
    expect(failed?.failureMessage).toBe('ECONNRESET')
    expect(failed?.safeActiveVersion).toBe('22.1.6')

    const canceled = deriveManagedServerSheetView({
      state: state(),
      event: event({ phase: 'error', canceled: true })
    })
    expect(canceled?.status).toBe('canceled')
    expect(canceled?.needsAttention).toBe(false)
  })

  it('classifies first install, update, and active snapshots', () => {
    expect(
      deriveManagedServerSheetView({
        state: state({ activeVersion: null, installedVersions: [] }),
        event: null
      })?.status
    ).toBe('needs-first-install')
    expect(deriveManagedServerSheetView({ state: state({ updateAvailable: true }), event: null })?.status).toBe(
      'update-available'
    )
    expect(deriveManagedServerSheetView({ state: state(), event: null })?.status).toBe('active')
  })
})

describe('needsFirstManagedInstallConsent', () => {
  it('is true only when nothing was ever installed on the Host', () => {
    expect(needsFirstManagedInstallConsent(state({ activeVersion: null, installedVersions: [] }))).toBe(true)
    expect(needsFirstManagedInstallConsent(state({ activeVersion: null, installedVersions: ['19.1.7'] }))).toBe(false)
    expect(needsFirstManagedInstallConsent(state())).toBe(false)
  })
})
