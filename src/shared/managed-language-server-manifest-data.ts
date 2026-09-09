import type {
  ManagedLanguageServerArchiveFormat,
  ManagedLanguageServerManifest,
  ManagedLanguageServerManifestEntry
} from './managed-language-server'

/**
 * Orca's trusted, shipped manifest (#15): clients and Host adapters resolve
 * entries from here — never from caller-supplied URLs or hashes. Entries are
 * additive-only across releases: activation records reference entry ids, so
 * ids must stay stable forever. Artifacts pinned 2026-09-03. The python
 * server entries (pyright/basedpyright + private node runtime) were removed
 * in #131; their ids are never reused.
 */

const CLANGD_VERSION = '22.1.6'

type Archive = {
  fileName: string
  archiveFormat: ManagedLanguageServerArchiveFormat
  sha256: string
  sizeBytes: number
}

/** clangd ships one zip per platform; the mac build is universal (x64+arm64).
 * probe/command templates carry the per-platform binary name. */
function clangdEntries(): ManagedLanguageServerManifestEntry[] {
  const archives: Record<'win32-x64' | 'linux-x64' | 'darwin', Archive> = {
    'win32-x64': {
      fileName: `clangd-windows-${CLANGD_VERSION}.zip`,
      archiveFormat: 'zip',
      sha256: 'ce54f16e0b4fd76d450eeda9664420b195360b73febcfe40e661108fa57f2ce1',
      sizeBytes: 28198778
    },
    'linux-x64': {
      fileName: `clangd-linux-${CLANGD_VERSION}.zip`,
      archiveFormat: 'zip',
      sha256: 'a9c77443af2e447ed467e84771848d3a6ac1c56f84bcfcde717e66318de77cfa',
      sizeBytes: 114790601
    },
    darwin: {
      fileName: `clangd-mac-${CLANGD_VERSION}.zip`,
      archiveFormat: 'zip',
      sha256: '631aef462556cbd74e0ebaae1778a38d1997d0ba3371652ca54f82652a179e7d',
      sizeBytes: 98113276
    }
  }
  const targets: { key: string; archive: Archive }[] = [
    { key: 'win32-x64', archive: archives['win32-x64'] },
    { key: 'linux-x64', archive: archives['linux-x64'] },
    { key: 'darwin-x64', archive: archives.darwin },
    { key: 'darwin-arm64', archive: archives.darwin }
  ]
  return targets.map(({ key, archive }) => {
    const [platform, arch] = key.split('-') as [ManagedLanguageServerManifestEntry['platform'], ManagedLanguageServerManifestEntry['arch']]
    return {
      id: `clangd@${CLANGD_VERSION}:${key}`,
      tool: 'clangd' as const,
      version: CLANGD_VERSION,
      platform,
      arch,
      ...(platform === 'linux' ? { glibcFloor: '2.31' } : {}),
      sourceUrl: `https://github.com/clangd/clangd/releases/download/${CLANGD_VERSION}/${archive.fileName}`,
      archiveFileName: archive.fileName,
      archiveFormat: archive.archiveFormat,
      sha256: archive.sha256,
      sizeBytes: archive.sizeBytes,
      archiveRootDirectory: `clangd_${CLANGD_VERSION}`,
      probe: {
        executable: platform === 'win32' ? '{root}/bin/clangd.exe' : '{root}/bin/clangd',
        args: ['--version']
      },
      command: {
        executable: platform === 'win32' ? '{root}/bin/clangd.exe' : '{root}/bin/clangd',
        args: []
      },
      license: {
        name: 'Apache-2.0 WITH LLVM-exception',
        url: 'https://raw.githubusercontent.com/llvm/llvm-project/main/clang/LICENSE.TXT'
      }
    }
  })
}
export const MANAGED_LANGUAGE_SERVER_MANIFEST: ManagedLanguageServerManifest = {
  manifestVersion: 1,
  entries: [...clangdEntries()]
}
