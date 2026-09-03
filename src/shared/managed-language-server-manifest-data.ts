import type {
  ManagedLanguageServerArchiveFormat,
  ManagedLanguageServerManifest,
  ManagedLanguageServerManifestEntry,
  ManagedLanguageServerToolId
} from './managed-language-server'

/**
 * Orca's trusted, shipped manifest (#15): clients and Host adapters resolve
 * entries from here — never from caller-supplied URLs or hashes. Entries are
 * additive-only across releases: activation records reference entry ids, so
 * ids must stay stable forever. Artifacts pinned 2026-09-03.
 */

const NODE_VERSION = '24.20.0'
const PYRIGHT_VERSION = '1.1.413'
const BASEDPYRIGHT_VERSION = '1.39.10'
const CLANGD_VERSION = '22.1.6'

type HostKey = 'win32-x64' | 'win32-arm64' | 'darwin-x64' | 'darwin-arm64' | 'linux-x64' | 'linux-arm64'

const HOST_KEYS: readonly HostKey[] = [
  'win32-x64',
  'win32-arm64',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64'
]

type Archive = {
  fileName: string
  archiveFormat: ManagedLanguageServerArchiveFormat
  sha256: string
  sizeBytes: number
}

/** Node's per-platform binary path inside its version root. */
const nodeBinaryFor = (key: HostKey): string =>
  key.startsWith('win32') ? 'node.exe' : 'bin/node'

const nodeArchives: Record<HostKey, Archive & { rootDirectory: string }> = {
  'win32-x64': {
    fileName: `node-v${NODE_VERSION}-win-x64.zip`,
    archiveFormat: 'zip',
    sha256: '6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba',
    sizeBytes: 37539751,
    rootDirectory: `node-v${NODE_VERSION}-win-x64`
  },
  'win32-arm64': {
    fileName: `node-v${NODE_VERSION}-win-arm64.zip`,
    archiveFormat: 'zip',
    sha256: '31c6799744de8a54601643098040c68c3697e56c94e407d61d0e5fa5f34191d7',
    sizeBytes: 33621271,
    rootDirectory: `node-v${NODE_VERSION}-win-arm64`
  },
  'darwin-x64': {
    fileName: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    archiveFormat: 'tar-gz',
    sha256: '9e5b2644cf107befb6aefca676b96d3296bc10138096f022ed378d6233ed81f4',
    sizeBytes: 54021618,
    rootDirectory: `node-v${NODE_VERSION}-darwin-x64`
  },
  'darwin-arm64': {
    fileName: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    archiveFormat: 'tar-gz',
    sha256: '40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8',
    sizeBytes: 52813331,
    rootDirectory: `node-v${NODE_VERSION}-darwin-arm64`
  },
  // Linux uses .tar.gz (not .tar.xz): GNU tar reads it without xz-utils.
  'linux-x64': {
    fileName: `node-v${NODE_VERSION}-linux-x64.tar.gz`,
    archiveFormat: 'tar-gz',
    sha256: '855d581f8a4eb1a8117e3426de25fe02770592febcfb31369aee1ffbfee9e8ec',
    sizeBytes: 58006679,
    rootDirectory: `node-v${NODE_VERSION}-linux-x64`
  },
  'linux-arm64': {
    fileName: `node-v${NODE_VERSION}-linux-arm64.tar.gz`,
    archiveFormat: 'tar-gz',
    sha256: '3515603e2487879a39bc75716f1a2affd027500c64ba50e845cf72cb33219013',
    sizeBytes: 57732896,
    rootDirectory: `node-v${NODE_VERSION}-linux-arm64`
  }
}

function nodeEntry(key: HostKey): ManagedLanguageServerManifestEntry {
  const { rootDirectory, ...archive } = nodeArchives[key]
  const binary = nodeBinaryFor(key)
  const [platform, arch] = key.split('-') as [ManagedLanguageServerManifestEntry['platform'], ManagedLanguageServerManifestEntry['arch']]
  return {
    id: `node@${NODE_VERSION}:${key}`,
    tool: 'node',
    version: NODE_VERSION,
    platform,
    arch,
    // Node 24 requires glibc 2.28+, inside Orca's Ubuntu 20.04 floor.
    ...(platform === 'linux' ? { glibcFloor: '2.28' } : {}),
    sourceUrl: `https://nodejs.org/dist/v${NODE_VERSION}/${archive.fileName}`,
    archiveFileName: archive.fileName,
    archiveFormat: archive.archiveFormat,
    sha256: archive.sha256,
    sizeBytes: archive.sizeBytes,
    archiveRootDirectory: rootDirectory,
    probe: { executable: `{root}/${binary}`, args: ['--version'] },
    command: { executable: `{root}/${binary}`, args: [] },
    license: { name: 'MIT', url: 'https://raw.githubusercontent.com/nodejs/node/main/LICENSE' }
  }
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
/** Python servers ship one platform-independent npm tarball; only the private
 * Node runtime path differs per Host. */
function pythonServerEntries(args: {
  tool: Extract<ManagedLanguageServerToolId, 'pyright' | 'basedpyright'>
  version: string
  archive: Archive
  license: { name: string; url: string }
}): ManagedLanguageServerManifestEntry[] {
  return HOST_KEYS.map((key) => {
    const [platform, arch] = key.split('-') as [ManagedLanguageServerManifestEntry['platform'], ManagedLanguageServerManifestEntry['arch']]
    const nodeBinary = nodeBinaryFor(key)
    return {
      id: `${args.tool}@${args.version}:${key}`,
      tool: args.tool,
      version: args.version,
      platform,
      arch,
      sourceUrl: `https://registry.npmjs.org/${args.tool}/-/${args.archive.fileName}`,
      archiveFileName: args.archive.fileName,
      archiveFormat: args.archive.archiveFormat,
      sha256: args.archive.sha256,
      sizeBytes: args.archive.sizeBytes,
      archiveRootDirectory: 'package',
      probe: { executable: `{runtime}/${nodeBinary}`, args: ['{root}/index.js', '--version'] },
      command: {
        executable: `{runtime}/${nodeBinary}`,
        args: ['{root}/langserver.index.js', '--stdio']
      },
      runtimeEntryId: `node@${NODE_VERSION}:${key}`,
      license: args.license
    }
  })
}

export const MANAGED_LANGUAGE_SERVER_MANIFEST: ManagedLanguageServerManifest = {
  manifestVersion: 1,
  entries: [
    ...clangdEntries(),
    ...HOST_KEYS.map(nodeEntry),
    ...pythonServerEntries({
      tool: 'pyright',
      version: PYRIGHT_VERSION,
      archive: {
        fileName: `pyright-${PYRIGHT_VERSION}.tgz`,
        archiveFormat: 'tar-gz',
        sha256: '7322a75188e788f9fe7cbb71891af435a713bf8985141dc0d28e8ca243977bee',
        sizeBytes: 4155725
      },
      license: {
        name: 'MIT',
        url: 'https://raw.githubusercontent.com/microsoft/pyright/main/LICENSE.txt'
      }
    }),
    ...pythonServerEntries({
      tool: 'basedpyright',
      version: BASEDPYRIGHT_VERSION,
      archive: {
        fileName: `basedpyright-${BASEDPYRIGHT_VERSION}.tgz`,
        archiveFormat: 'tar-gz',
        sha256: '11891e35fb3afcde55d5f358b147ec99be13ee1eb8ea5db893db430f51eb5b2b',
        sizeBytes: 6156337
      },
      license: {
        name: 'MIT',
        url: 'https://raw.githubusercontent.com/DetachHead/basedpyright/main/LICENSE'
      }
    })
  ]
}
