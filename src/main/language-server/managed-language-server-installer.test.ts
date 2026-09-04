import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { LanguageServerKind } from '../../shared/language-server-session'
import type {
  ManagedLanguageServerInstallEvent,
  ManagedLanguageServerManifest,
  ManagedLanguageServerManifestEntry
} from '../../shared/managed-language-server'
import { ManagedLanguageServerInstaller } from './managed-language-server-installer'
import type { CppSetupCommandRunner } from './code-intelligence-cpp-setup-tools'
import { readManagedActivation } from './managed-language-server-install-root'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const exeSuffix = process.platform === 'win32' ? '.exe' : ''

function makeEntry(overrides: Partial<ManagedLanguageServerManifestEntry> = {}): ManagedLanguageServerManifestEntry {
  return {
    id: 'clangd@1.0.0:test',
    tool: 'clangd',
    version: '1.0.0',
    platform: process.platform as ManagedLanguageServerManifestEntry['platform'],
    arch: process.arch as ManagedLanguageServerManifestEntry['arch'],
    sourceUrl: 'https://example.test/clangd.zip',
    archiveFileName: 'clangd.zip',
    archiveFormat: 'zip',
    sizeBytes: 3,
    sha256: createHash('sha256').update('abc').digest('hex'),
    archiveRootDirectory: 'clangd_1.0.0',
    probe: { executable: `{root}/bin/clangd${exeSuffix}`, args: ['--version'] },
    command: { executable: `{root}/bin/clangd${exeSuffix}`, args: [] },
    license: { name: 'Apache-2.0', url: 'https://example.test/license' },
    ...overrides
  }
}

/** Simulated extractor/probe: `tar -xf` plants the version tree; running the
 * planted clangd prints a version and exits 0. */
function makeRunner(entry: ManagedLanguageServerManifestEntry): CppSetupCommandRunner {
  return vi.fn(async (executable, args) => {
    if (executable === 'tar') {
      const destination = args[args.indexOf('-C') + 1]
      const root = join(destination, entry.archiveRootDirectory)
      await mkdir(join(root, 'bin'), { recursive: true })
      const planted = join(root, 'bin', `clangd${exeSuffix}`)
      await writeFile(planted, 'clangd')
      if (process.platform !== 'win32') {
        await chmod(planted, 0o755)
      }
      return { code: 0, output: '' }
    }
    if (executable.includes('clangd')) {
      return { code: 0, output: `clangd version ${entry.version}` }
    }
    return { code: 1, output: `unexpected executable ${executable}` }
  })
}

function makeInstaller(args: {
  entries: ManagedLanguageServerManifestEntry[]
  fetchBody?: () => Uint8Array<ArrayBuffer>
  fetchBodies?: Map<string, Uint8Array<ArrayBuffer>>
  getPinnedVersions?: (tool: LanguageServerKind) => Promise<readonly string[]>
  emit?: (event: ManagedLanguageServerInstallEvent) => void
}) {
  const root = newTempDir()
  const fetchArchive = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    body: new Blob([
      args.fetchBodies?.get(url) ?? args.fetchBody?.() ?? new TextEncoder().encode('abc')
    ]).stream()
  }))
  const installer = new ManagedLanguageServerInstaller({
    root,
    manifest: { manifestVersion: 1, entries: args.entries } satisfies ManagedLanguageServerManifest,
    fetchArchive,
    run: makeRunner(args.entries[0]),
    getPinnedVersions: args.getPinnedVersions,
    emit: args.emit
  })
  return { installer, root, fetchArchive }
}

function newTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'orca-managed-install-'))
  tempDirs.push(path)
  return path
}

describe('ManagedLanguageServerInstaller', () => {
  it('runs the full transaction from a host download', async () => {
    const entry = makeEntry()
    const events: ManagedLanguageServerInstallEvent[] = []
    const { installer, root, fetchArchive } = makeInstaller({
      entries: [entry],
      emit: (event) => events.push(event)
    })

    await expect(installer.install({ tool: 'clangd', route: { type: 'host-download' } })).resolves.toMatchObject({
      status: 'installed',
      version: '1.0.0'
    })

    expect(fetchArchive).toHaveBeenCalledOnce()
    const record = await readManagedActivation(join(root, 'clangd'))
    expect(record?.active.version).toBe('1.0.0')
    expect(events.map((event) => event.phase)).toEqual([
      'download',
      'extract',
      'probe',
      'activate',
      'complete'
    ])
    const command = await installer.resolveActiveCommand('clangd')
    expect(command?.executable.replace(/\\/g, '/')).toContain('clangd/1.0.0/bin/clangd')
  })

  it('short-circuits when the requested version is already active', async () => {
    const entry = makeEntry()
    const { installer, fetchArchive } = makeInstaller({ entries: [entry] })
    await installer.install({ tool: 'clangd', route: { type: 'host-download' } })
    fetchArchive.mockClear()

    await expect(installer.install({ tool: 'clangd', route: { type: 'host-download' } })).resolves.toMatchObject({
      status: 'already-active'
    })
    expect(fetchArchive).not.toHaveBeenCalled()
  })

  it('fails closed on a sha256 mismatch without touching activation', async () => {
    const entry = makeEntry()
    const { installer, root } = makeInstaller({
      entries: [entry],
      fetchBody: () => new TextEncoder().encode('xyz')
    })

    const result = await installer.install({ tool: 'clangd', route: { type: 'host-download' } })
    expect(result).toMatchObject({ status: 'failed' })
    if (result.status === 'failed') {
      expect(result.error).toContain('sha256')
    }
    await expect(readManagedActivation(join(root, 'clangd'))).resolves.toBeNull()
    // Staging is cleaned: no dot-directories survive.
    await expect(readdir(join(root, 'clangd'))).resolves.toEqual([])
  })

  it('rejects an archive root that escapes the staging directory', async () => {
    const entry = makeEntry({ archiveRootDirectory: '../escaped' })
    const { installer, root } = makeInstaller({ entries: [entry] })

    const result = await installer.install({ tool: 'clangd', route: { type: 'host-download' } })
    expect(result).toMatchObject({ status: 'failed' })
    if (result.status === 'failed') {
      expect(result.error).toContain('outside its staging directory')
    }
    await expect(readdir(join(root, 'clangd'))).resolves.toEqual([])
  })

  it('cancels mid-download and keeps the active version', async () => {
    const v1 = makeEntry({ id: 'clangd@1.0.0:test', version: '1.0.0' })
    const v2Body = 'z'.repeat(1024 * 1024)
    const v2 = makeEntry({
      id: 'clangd@2.0.0:test',
      version: '2.0.0',
      sourceUrl: 'https://example.test/clangd-2.zip',
      sizeBytes: v2Body.length,
      sha256: createHash('sha256').update(v2Body).digest('hex')
    })
    const controller = new AbortController()
    const events: ManagedLanguageServerInstallEvent[] = []
    const { installer, root, fetchArchive } = makeInstaller({
      entries: [v1, v2],
      fetchBodies: new Map([
        [v1.sourceUrl, new TextEncoder().encode('abc')],
        [v2.sourceUrl, new TextEncoder().encode(v2Body)]
      ]),
      emit: (event) => {
        events.push(event)
        if (event.phase === 'download' && event.version === '2.0.0') {
          controller.abort()
        }
      }
    })
    await installer.install({ tool: 'clangd', version: '1.0.0', route: { type: 'host-download' } })

    const result = await installer.install({
      tool: 'clangd',
      version: '2.0.0',
      route: { type: 'host-download' },
      signal: controller.signal
    })
    expect(result).toMatchObject({ status: 'canceled' })
    const record = await readManagedActivation(join(root, 'clangd'))
    expect(record?.active.version).toBe('1.0.0')
    expect(events.some((event) => event.phase === 'error' && event.canceled)).toBe(true)
    await expect(readdir(join(root, 'clangd'))).resolves.toEqual(
      expect.arrayContaining(['1.0.0', 'active.json'])
    )
    // The canceled v2 download still started; only v1 completed.
    expect(fetchArchive).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent installs for the same tool', async () => {
    const entry = makeEntry({ sizeBytes: 5, sha256: createHash('sha256').update('abcde').digest('hex') })
    const { installer, fetchArchive } = makeInstaller({
      entries: [entry],
      fetchBody: () => new TextEncoder().encode('abcde')
    })

    const [first, second] = await Promise.all([
      installer.install({ tool: 'clangd', route: { type: 'host-download' } }),
      installer.install({ tool: 'clangd', route: { type: 'host-download' } })
    ])
    expect(fetchArchive).toHaveBeenCalledOnce()
    expect(first).toMatchObject({ status: 'installed' })
    expect(second).toBe(first)
  })

  it('returns the unsupported fallback without acquiring anything', async () => {
    const entry = makeEntry({ platform: 'freebsd' as ManagedLanguageServerManifestEntry['platform'] })
    const { installer, fetchArchive } = makeInstaller({ entries: [entry] })

    await expect(installer.install({ tool: 'clangd', route: { type: 'host-download' } })).resolves.toMatchObject({
      status: 'unsupported',
      reason: { type: 'unsupported-platform' }
    })
    expect(fetchArchive).not.toHaveBeenCalled()
    await expect(installer.state('clangd')).resolves.toMatchObject({ supported: false })
  })

  it('installs the private runtime first and templates {runtime} into commands', async () => {
    const node = makeEntry({
      id: 'node@24.0.0:test',
      tool: 'node' as ManagedLanguageServerManifestEntry['tool'],
      version: '24.0.0',
      archiveFileName: 'node.zip',
      archiveRootDirectory: 'node-24.0.0',
      probe: { executable: `{root}/bin/node${exeSuffix}`, args: ['--version'] },
      command: { executable: `{root}/bin/node${exeSuffix}`, args: [] }
    })
    const pyright = makeEntry({
      id: 'pyright@1.0.0:test',
      tool: 'pyright',
      archiveFileName: 'pyright.tgz',
      archiveRootDirectory: 'package',
      runtimeEntryId: node.id,
      probe: { executable: `{runtime}/bin/node${exeSuffix}`, args: ['{root}/index.js', '--version'] },
      command: {
        executable: `{runtime}/bin/node${exeSuffix}`,
        args: ['{root}/langserver.index.js', '--stdio']
      }
    })
    const runner = vi.fn(async (executable: string, args: readonly string[]) => {
      if (executable === 'tar') {
        const destination = args[args.indexOf('-C') + 1]
        await mkdir(join(destination, 'node-24.0.0', 'bin'), { recursive: true })
        await mkdir(join(destination, 'package'), { recursive: true })
        for (const planted of [
          join(destination, 'node-24.0.0', 'bin', `node${exeSuffix}`),
          join(destination, 'package', 'index.js'),
          join(destination, 'package', 'langserver.index.js')
        ]) {
          await writeFile(planted, 'x')
          if (planted.endsWith(exeSuffix) && exeSuffix) {
            await chmod(planted, 0o755)
          }
        }
        return { code: 0, output: '' }
      }
      return { code: 0, output: executable.includes('node') ? 'v24.0.0' : 'pyright 1.0.0' }
    })
    const root = newTempDir()
    const installer = new ManagedLanguageServerInstaller({
      root,
      manifest: { manifestVersion: 1, entries: [node, pyright] },
      fetchArchive: async () => ({
        ok: true,
        status: 200,
        body: new Blob([new TextEncoder().encode('abc')]).stream()
      }),
      run: runner
    })

    await expect(installer.install({ tool: 'pyright', route: { type: 'host-download' } })).resolves.toMatchObject({
      status: 'installed',
      version: '1.0.0'
    })
    await expect(
      readdir(join(root, 'node'))
    ).resolves.toEqual(expect.arrayContaining(['24.0.0', 'active.json']))
    const command = await installer.resolveActiveCommand('pyright')
    expect(command?.executable.replace(/\\/g, '/')).toContain('node/24.0.0/bin/node')
    expect(command?.args[0]?.replace(/\\/g, '/')).toContain('pyright/1.0.0/langserver.index.js')
    expect(command?.args[1]).toBe('--stdio')
  })

  it('verifies a client-selected file route against the manifest', async () => {
    const entry = makeEntry()
    const { installer } = makeInstaller({ entries: [entry] })
    const offline = join(newTempDir(), 'offline-archive.zip')
    await writeFile(offline, 'abc')

    await expect(
      installer.install({ tool: 'clangd', route: { type: 'client-file', filePath: offline } })
    ).resolves.toMatchObject({ status: 'installed' })
  })

  it('rejects a client file whose size does not match the manifest', async () => {
    const entry = makeEntry()
    const { installer, root } = makeInstaller({ entries: [entry] })
    const bogus = join(newTempDir(), 'bogus.zip')
    await writeFile(bogus, 'xyz!')

    const result = await installer.install({ tool: 'clangd', route: { type: 'client-file', filePath: bogus } })
    expect(result).toMatchObject({ status: 'failed' })
    if (result.status === 'failed') {
      expect(result.error).toContain('bytes')
    }
    await expect(readdir(join(root, 'clangd'))).resolves.toEqual([])
  })

  it('rolls back to the prior known-good version', async () => {
    const v1 = makeEntry({ id: 'clangd@1.0.0:test', version: '1.0.0' })
    const v2 = makeEntry({
      id: 'clangd@2.0.0:test',
      version: '2.0.0',
      sourceUrl: 'https://example.test/clangd-2.zip',
      sha256: createHash('sha256').update('zzz').digest('hex')
    })
    const root = newTempDir()
    const bodies = new Map<string, Uint8Array<ArrayBuffer>>([
      [v1.sourceUrl, new TextEncoder().encode('abc')],
      [v2.sourceUrl, new TextEncoder().encode('zzz')]
    ])
    const installer = new ManagedLanguageServerInstaller({
      root,
      manifest: { manifestVersion: 1, entries: [v1, v2] },
      fetchArchive: async (url) => ({
        ok: true,
        status: 200,
        body: new Blob([bodies.get(url)!]).stream()
      }),
      run: makeRunner(v1)
    })

    await installer.install({ tool: 'clangd', version: '1.0.0', route: { type: 'host-download' } })
    await installer.install({ tool: 'clangd', version: '2.0.0', route: { type: 'host-download' } })
    await expect(installer.rollback('clangd')).resolves.toMatchObject({ status: 'rolled-back', version: '1.0.0' })
    const record = await readManagedActivation(join(root, 'clangd'))
    expect(record?.active.version).toBe('1.0.0')
    expect(record?.rollback?.version).toBe('2.0.0')
  })

  it('launches the scope-pinned version instead of the active one', async () => {
    const v1 = makeEntry({ id: 'clangd@1.0.0:test', version: '1.0.0' })
    const v2 = makeEntry({
      id: 'clangd@2.0.0:test',
      version: '2.0.0',
      sourceUrl: 'https://example.test/clangd-2.zip',
      archiveRootDirectory: 'clangd_2.0.0',
      sha256: createHash('sha256').update('zzz').digest('hex')
    })
    const root = newTempDir()
    const bodies = new Map<string, Uint8Array<ArrayBuffer>>([
      [v1.sourceUrl, new TextEncoder().encode('abc')],
      [v2.sourceUrl, new TextEncoder().encode('zzz')]
    ])
    const runner = vi.fn(async (executable: string, args: readonly string[]) => {
      if (executable === 'tar') {
        // Plant both versions' trees in every staging extraction.
        const destination = args[args.indexOf('-C') + 1]
        for (const dir of [v1.archiveRootDirectory, v2.archiveRootDirectory]) {
          await mkdir(join(destination, dir, 'bin'), { recursive: true })
          const planted = join(destination, dir, 'bin', `clangd${exeSuffix}`)
          await writeFile(planted, 'clangd')
          if (process.platform !== 'win32') {
            await chmod(planted, 0o755)
          }
        }
        return { code: 0, output: '' }
      }
      return { code: 0, output: 'ok' }
    })
    const installer = new ManagedLanguageServerInstaller({
      root,
      manifest: { manifestVersion: 1, entries: [v1, v2] },
      fetchArchive: async (url) => ({
        ok: true,
        status: 200,
        body: new Blob([bodies.get(url)!]).stream()
      }),
      run: runner
    })
    await installer.install({ tool: 'clangd', version: '1.0.0', route: { type: 'host-download' } })
    await installer.install({ tool: 'clangd', version: '2.0.0', route: { type: 'host-download' } })

    const command = await installer.resolveActiveCommand('clangd', '1.0.0')
    expect(command?.executable.replace(/\\/g, '/')).toContain('clangd/1.0.0/bin/clangd')
    const active = await installer.resolveActiveCommand('clangd')
    expect(active?.executable.replace(/\\/g, '/')).toContain('clangd/2.0.0/bin/clangd')
    // A pinned-but-uninstalled version resolves to nothing, not to active.
    await expect(installer.resolveActiveCommand('clangd', '9.9.9')).resolves.toBeNull()
  })

  it('collects garbage while protecting active, rollback, and pinned versions', async () => {
    const entry = makeEntry()
    const { installer, root } = makeInstaller({
      entries: [entry],
      getPinnedVersions: async () => ['0.9.0']
    })
    await mkdir(join(root, 'clangd', '0.9.0'), { recursive: true })
    await mkdir(join(root, 'clangd', '0.1.0'), { recursive: true })
    await installer.install({ tool: 'clangd', route: { type: 'host-download' } })

    await expect(readdir(join(root, 'clangd'))).resolves.toEqual(
      expect.arrayContaining(['1.0.0', '0.9.0', 'active.json'])
    )
    await expect(readdir(join(root, 'clangd'))).resolves.not.toContain('0.1.0')
  })
})
