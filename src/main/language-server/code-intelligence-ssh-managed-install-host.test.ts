import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type {
  ManagedLanguageServerManifest,
  ManagedLanguageServerManifestEntry
} from '../../shared/managed-language-server'
import {
  resolveSshManagedLanguageServerCommand
} from './code-intelligence-ssh-managed-install-state'
import {
  createSshManagedLanguageServerInstallHost
} from './code-intelligence-ssh-managed-install-host'
import { probeSshManagedGlibc } from './code-intelligence-ssh-managed-install-root'
import { ManagedLanguageServerInstaller } from './managed-language-server-installer'

type FakeResult = { code: number; stdout?: string; stderr?: string }

/** Fake SshSetupExecQueue: pattern-matched handlers over the command string. */
function makeQueue(handlers: [match: RegExp, result: () => FakeResult][]) {
  const commands: string[] = []
  const written: Record<string, string> = {}
  const queue = {
    exec: async (command: string): Promise<FakeResult> => {
      commands.push(command)
      for (const [match, result] of handlers) {
        if (match.test(command)) {
          return result()
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    capture: async (command: string): Promise<string> => {
      commands.push(command)
      for (const [match, result] of handlers) {
        if (match.test(command)) {
          const value = result()
          if (value.code !== 0) {
            throw new Error(`capture failed: ${command}`)
          }
          return value.stdout ?? ''
        }
      }
      return ''
    },
    writeFile: async (directory: string, fileName: string, content: string) => {
      commands.push(`write ${directory}/${fileName}`)
      written[`${directory}/${fileName}`] = content
    }
  }
  return { queue, commands, written }
}

const HOME = '/home/user'

function makeEntry(overrides: Partial<ManagedLanguageServerManifestEntry> = {}): ManagedLanguageServerManifestEntry {
  return {
    id: 'clangd@1.0.0:linux-x64',
    tool: 'clangd',
    version: '1.0.0',
    platform: 'linux',
    arch: 'x64',
    sourceUrl: 'https://example.test/clangd.zip',
    archiveFileName: 'clangd.zip',
    archiveFormat: 'zip',
    sizeBytes: 3,
    sha256: createHash('sha256').update('abc').digest('hex'),
    archiveRootDirectory: 'clangd_1.0.0',
    probe: { executable: '{root}/bin/clangd', args: ['--version'] },
    command: { executable: '{root}/bin/clangd', args: [] },
    license: { name: 'Apache-2.0', url: 'https://example.test/license' },
    ...overrides
  }
}

function makeContext(queue: ReturnType<typeof makeQueue>['queue'], uploadFile = vi.fn()) {
  return {
    queue: queue as never,
    home: HOME,
    remotePlatform: 'linux' as const,
    remoteArch: 'x64' as const,
    remoteGlibc: '2.35',
    uploadFile
  }
}

function makeHost(queue: ReturnType<typeof makeQueue>['queue'], uploadFile = vi.fn()) {
  return createSshManagedLanguageServerInstallHost({
    createContext: async () => makeContext(queue, uploadFile)
  })
}

const archiveDigest = createHash('sha256').update('abc').digest('hex')

const stagingHandlers: [RegExp, () => FakeResult][] = [
  [/^mktemp -d/, () => ({ code: 0, stdout: '/home/user/.orca/code-intelligence/managed/clangd/.staging.X1' })],
  [/sha256sum/, () => ({ code: 0, stdout: archiveDigest })],
  [/bin\/clangd/, () => ({ code: 0, stdout: 'clangd version 1.0.0' })]
]

describe('ssh managed install host transport', () => {
  it('downloads via the curl/wget chain with the brace extraction sequence', async () => {
    const entry = makeEntry()
    const { queue, commands } = makeQueue(stagingHandlers)
    const host = makeHost(queue)

    await host.acquire({
      entry,
      route: { type: 'host-download' },
      signal: new AbortController().signal,
      emit: () => {}
    })

    const joined = commands.join('\n')
    expect(joined).toContain('curl -fL')
    expect(joined).toContain('wget')
    expect(joined).toContain('sha256sum')
    expect(joined).toContain("exec 'tar'")
    expect(joined).toContain('chmod +x')
    expect(joined).toContain('mv ')
    expect(joined).toContain('rm -rf')
  })

  it('uploads a client-selected file and verifies it remotely', async () => {
    const entry = makeEntry()
    const local = mkdtempSync(join(tmpdir(), 'orca-ssh-managed-'))
    try {
      const archive = join(local, 'offline.zip')
      await writeFile(archive, 'abc')
      const { queue, commands } = makeQueue(stagingHandlers)
      const uploadFile = vi.fn()
      const host = makeHost(queue, uploadFile)

      await host.acquire({
        entry,
        route: { type: 'client-file', filePath: archive },
        signal: new AbortController().signal,
        emit: () => {}
      })
      expect(uploadFile).toHaveBeenCalledOnce()
      expect(commands.join('\n')).not.toContain('curl')
    } finally {
      await rm(local, { recursive: true, force: true })
    }
  })

  it('pre-checks the client file size before any sftp upload', async () => {
    const entry = makeEntry()
    const local = mkdtempSync(join(tmpdir(), 'orca-ssh-managed-'))
    try {
      const bogus = join(local, 'bogus.zip')
      await writeFile(bogus, 'xyz!')
      const { queue } = makeQueue(stagingHandlers)
      const uploadFile = vi.fn()
      const host = makeHost(queue, uploadFile)

      await expect(
        host.acquire({
          entry,
          route: { type: 'client-file', filePath: bogus },
          signal: new AbortController().signal,
          emit: () => {}
        })
      ).rejects.toThrow('bytes')
      expect(uploadFile).not.toHaveBeenCalled()
    } finally {
      await rm(local, { recursive: true, force: true })
    }
  })

  it('fails closed when the remote digest does not match', async () => {
    const entry = makeEntry()
    const { queue, written } = makeQueue([
      [/^mktemp -d/, () => ({ code: 0, stdout: '/home/user/.orca/code-intelligence/managed/clangd/.staging.X3' })],
      [/sha256sum/, () => ({ code: 0, stdout: `${'0'.repeat(64)}  file` })]
    ])
    const host = makeHost(queue)

    await expect(
      host.acquire({
        entry,
        route: { type: 'host-download' },
        signal: new AbortController().signal,
        emit: () => {}
      })
    ).rejects.toThrow('sha256')
    expect(Object.keys(written)).toEqual([])
  })

  it('probeVersion surfaces the remote probe output on failure', async () => {
    const entry = makeEntry()
    const { queue } = makeQueue([
      // bin/clangd only matches the probe command, never the archive URL/name.
      [/bin\/clangd/, () => ({ code: 127, stdout: '', stderr: 'libstdc++.so.6: version GLIBCXX_3.4.30 not found' })]
    ])
    const host = makeHost(queue)

    await expect(host.probeVersion(entry)).rejects.toThrow(
      'smoke test failed on the SSH Host'
    )
    await expect(host.probeVersion(entry)).rejects.toThrow('GLIBCXX_3.4.30')
  })

  it('reports the probed remote platform, arch, and glibc', async () => {
    const { queue } = makeQueue([])
    const host = makeHost(queue)
    await expect(host.hostTarget()).resolves.toEqual({
      platform: 'linux',
      arch: 'x64',
      glibcVersion: '2.35'
    })
  })

  it('extracts the glibc version from ldd and treats failure as unknown', async () => {
    const ok = makeQueue([
      [/ldd --version/, () => ({ code: 0, stdout: 'ldd (Ubuntu GLIBC 2.31-0ubuntu9) 2.31' })]
    ])
    await expect(probeSshManagedGlibc(ok.queue as never)).resolves.toBe('2.31')
    const failing = makeQueue([
      [/ldd --version/, () => ({ code: 1, stdout: '' })]
    ])
    await expect(probeSshManagedGlibc(failing.queue as never)).resolves.toBeUndefined()
  })

  it('returns unsupported for Windows SSH targets through the pipeline', async () => {
    // The manifest does carry win32 entries (local Hosts install them); the
    // SSH acquisition chain is POSIX-only, so the adapter must veto.
    const entry = makeEntry({ platform: 'win32', id: 'clangd@1.0.0:win32-x64' })
    const { queue } = makeQueue([])
    const ctx = { ...makeContext(queue), remotePlatform: 'win32' as const }
    const installer = new ManagedLanguageServerInstaller({
      manifest: { manifestVersion: 1, entries: [entry] },
      host: createSshManagedLanguageServerInstallHost({ createContext: async () => ctx })
    })
    await expect(
      installer.install({ tool: 'clangd', route: { type: 'host-download' } })
    ).resolves.toMatchObject({
      status: 'unsupported',
      reason: { type: 'unsupported-platform', platform: 'win32' }
    })
    await expect(installer.state('clangd')).resolves.toMatchObject({
      supported: false,
      unsupportedReason: { type: 'unsupported-platform', platform: 'win32' }
    })
  })

  it('removes one version directory with an escaped rm -rf', async () => {
    const { queue, commands } = makeQueue([])
    const host = makeHost(queue)
    await host.removeVersion('clangd', '0.1.0')
    expect(commands.join('\n')).toContain(
      "rm -rf -- '/home/user/.orca/code-intelligence/managed/clangd/0.1.0'"
    )
  })
})

describe('ssh managed launch command resolution', () => {
  const record = {
    active: { version: '2.0.0', entryId: 'clangd@2.0.0:linux-x64', activatedAt: 1 },
    rollback: { version: '1.0.0', entryId: 'clangd@1.0.0:linux-x64', activatedAt: 0 }
  }
  const v1 = makeEntry()
  const v2 = makeEntry({ id: 'clangd@2.0.0:linux-x64', version: '2.0.0' })
  const manifest: ManagedLanguageServerManifest = { manifestVersion: 1, entries: [v1, v2] }

  it('resolves the active launch command from the record', async () => {
    const { queue } = makeQueue([
      [/cat .*active\.json/, () => ({ code: 0, stdout: JSON.stringify(record) })]
    ])
    await expect(
      resolveSshManagedLanguageServerCommand({ ctx: makeContext(queue), manifest, tool: 'clangd' })
    ).resolves.toEqual({
      executable: '/home/user/.orca/code-intelligence/managed/clangd/2.0.0/bin/clangd',
      args: []
    })
  })
})
