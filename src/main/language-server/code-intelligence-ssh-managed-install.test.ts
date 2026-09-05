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
import { installSshManagedLanguageServer } from './code-intelligence-ssh-managed-install'
import {
  gcSshManagedLanguageServerVersions,
  resolveSshManagedLanguageServerCommand,
  rollbackSshManagedLanguageServer,
  sshManagedLanguageServerState
} from './code-intelligence-ssh-managed-install-state'

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
    uploadFile
  }
}

const archiveDigest = createHash('sha256').update('abc').digest('hex')

describe('installSshManagedLanguageServer', () => {
  it('runs the remote transaction for a host download', async () => {
    const entry = makeEntry()
    const { queue, commands, written } = makeQueue([
      [/^mktemp -d/, () => ({ code: 0, stdout: '/home/user/.orca/code-intelligence/managed/clangd/.staging.X1' })],
      [/sha256sum/, () => ({ code: 0, stdout: archiveDigest })],
      [/cat .*active\.json/, () => ({ code: 1 })],
      [/\{root\}\/bin\/clangd|clangd_1\.0\.0\/bin\/clangd|managed\/clangd\/1\.0\.0\/bin\/clangd/, () => ({ code: 0, stdout: 'clangd version 1.0.0' })]
    ])
    const ctx = makeContext(queue)

    const result = await installSshManagedLanguageServer({
      ctx,
      manifest: { manifestVersion: 1, entries: [entry] },
      tool: 'clangd',
      route: { type: 'host-download' }
    })
    if (result.status === 'failed') {
      throw new Error(`INSTALL_ERROR: ${result.error}`)
    }
    expect(result).toMatchObject({ status: 'installed', version: '1.0.0' })

    const joined = commands.join('\n')
    expect(joined).toContain('curl -fL')
    expect(joined).toContain('wget')
    expect(joined).toContain('sha256sum')
    expect(joined).toContain("exec 'tar'")
    expect(joined).toContain('chmod +x')
    expect(joined).toContain('mv ')
    expect(joined).toContain('rm -rf')
    const record = JSON.parse(Object.values(written)[0]!)
    expect(record.active.version).toBe('1.0.0')
  })

  it('uploads a client-selected file and verifies it remotely', async () => {
    const entry = makeEntry()
    const local = mkdtempSync(join(tmpdir(), 'orca-ssh-managed-'))
    try {
      const archive = join(local, 'offline.zip')
      await writeFile(archive, 'abc')
      const { queue, commands } = makeQueue([
        [/^mktemp -d/, () => ({ code: 0, stdout: '/home/user/.orca/code-intelligence/managed/clangd/.staging.X2' })],
        [/sha256sum/, () => ({ code: 0, stdout: archiveDigest })],
        [/cat .*active\.json/, () => ({ code: 1 })],
        [/managed\/clangd\/1\.0\.0/, () => ({ code: 0, stdout: 'clangd version 1.0.0' })]
      ])
      const uploadFile = vi.fn()
      const ctx = makeContext(queue, uploadFile)

      await expect(
        installSshManagedLanguageServer({
          ctx,
          manifest: { manifestVersion: 1, entries: [entry] },
          tool: 'clangd',
          route: { type: 'client-file', filePath: archive }
        })
      ).resolves.toMatchObject({ status: 'installed' })
      expect(uploadFile).toHaveBeenCalledOnce()
      expect(commands.join('\n')).not.toContain('curl')
    } finally {
      await rm(local, { recursive: true, force: true })
    }
  })

  it('fails closed when the remote digest does not match', async () => {
    const entry = makeEntry()
    const { queue, written } = makeQueue([
      [/^mktemp -d/, () => ({ code: 0, stdout: '/home/user/.orca/code-intelligence/managed/clangd/.staging.X3' })],
      [/sha256sum/, () => ({ code: 0, stdout: `${'0'.repeat(64)}  file` })],
      [/cat .*active\.json/, () => ({ code: 1 })]
    ])

    const result = await installSshManagedLanguageServer({
      ctx: makeContext(queue),
      manifest: { manifestVersion: 1, entries: [entry] },
      tool: 'clangd',
      route: { type: 'host-download' }
    })
    expect(result).toMatchObject({ status: 'failed' })
    if (result.status === 'failed') {
      expect(result.error).toContain('sha256')
    }
    expect(Object.keys(written)).toEqual([])
  })

  it('returns a canceled result before any activation when aborted', async () => {
    const entry = makeEntry()
    const { queue, written } = makeQueue([
      [/^mktemp -d/, () => ({ code: 0, stdout: '/home/user/.orca/code-intelligence/managed/clangd/.staging.X4' })],
      [/sha256sum/, () => ({ code: 0, stdout: archiveDigest })],
      [/cat .*active\.json/, () => ({ code: 1 })]
    ])
    const controller = new AbortController()
    controller.abort()

    await expect(
      installSshManagedLanguageServer({
        ctx: makeContext(queue),
        manifest: { manifestVersion: 1, entries: [entry] },
        tool: 'clangd',
        route: { type: 'host-download' },
        signal: controller.signal
      })
    ).resolves.toMatchObject({ status: 'canceled' })
    expect(Object.keys(written)).toEqual([])
  })

  it('surfaces the remote probe output when the smoke test fails', async () => {
    const entry = makeEntry()
    const { queue, written } = makeQueue([
      [/^mktemp -d/, () => ({ code: 0, stdout: '/home/user/.orca/code-intelligence/managed/clangd/.staging.X5' })],
      [/sha256sum/, () => ({ code: 0, stdout: archiveDigest })],
      [/cat .*active\.json/, () => ({ code: 1 })],
      // bin/clangd only matches the probe command, never the archive URL/name.
      [/bin\/clangd/, () => ({ code: 127, stdout: '', stderr: 'libstdc++.so.6: version GLIBCXX_3.4.30 not found' })]
    ])

    const result = await installSshManagedLanguageServer({
      ctx: makeContext(queue),
      manifest: { manifestVersion: 1, entries: [entry] },
      tool: 'clangd',
      route: { type: 'host-download' }
    })
    expect(result).toMatchObject({ status: 'failed' })
    if (result.status === 'failed') {
      expect(result.error).toContain('smoke test failed on the SSH Host')
      expect(result.error).toContain('GLIBCXX_3.4.30')
    }
    expect(Object.keys(written)).toEqual([])
  })

  it('returns unsupported for Windows SSH targets', async () => {
    const entry = makeEntry({ platform: 'win32', id: 'clangd@1.0.0:win32-x64' })
    const { queue } = makeQueue([])
    const ctx = { ...makeContext(queue), remotePlatform: 'win32' as const }

    await expect(
      installSshManagedLanguageServer({
        ctx,
        manifest: { manifestVersion: 1, entries: [entry] },
        tool: 'clangd',
        route: { type: 'host-download' }
      })
    ).resolves.toMatchObject({ status: 'unsupported', reason: { type: 'unsupported-platform' } })
  })
})

describe('ssh managed install state and rollback', () => {
  const record = {
    active: { version: '2.0.0', entryId: 'clangd@2.0.0:linux-x64', activatedAt: 1 },
    rollback: { version: '1.0.0', entryId: 'clangd@1.0.0:linux-x64', activatedAt: 0 }
  }
  const v1 = makeEntry()
  const v2 = makeEntry({ id: 'clangd@2.0.0:linux-x64', version: '2.0.0' })
  const manifest: ManagedLanguageServerManifest = { manifestVersion: 1, entries: [v1, v2] }

  function recordQueue(handlers: [RegExp, () => { code: number; stdout?: string; stderr?: string }][] = []) {
    return makeQueue([
      [/cat .*active\.json/, () => ({ code: 0, stdout: JSON.stringify(record) })],
      [/^ls -1/, () => ({ code: 0, stdout: '1.0.0\n2.0.0\nactive.json\n.staging.tmp\n' })],
      ...handlers
    ])
  }

  it('reports installed versions, active, rollback, and updates', async () => {
    const { queue } = recordQueue()
    await expect(
      sshManagedLanguageServerState({ ctx: makeContext(queue), manifest, tool: 'clangd' })
    ).resolves.toMatchObject({
      supported: true,
      activeVersion: '2.0.0',
      rollbackVersion: '1.0.0',
      installedVersions: ['1.0.0', '2.0.0'],
      updateAvailable: false
    })
  })

  it('rolls back to the prior known-good version', async () => {
    const { queue, written } = recordQueue([
      [/managed\/clangd\/1\.0\.0/, () => ({ code: 0, stdout: 'clangd version 1.0.0' })]
    ])
    await expect(
      rollbackSshManagedLanguageServer({ ctx: makeContext(queue), manifest, tool: 'clangd' })
    ).resolves.toMatchObject({ status: 'rolled-back', version: '1.0.0' })
    const swapped = JSON.parse(Object.values(written)[0]!)
    expect(swapped.active.version).toBe('1.0.0')
    expect(swapped.rollback.version).toBe('2.0.0')
  })

  it('resolves the active launch command from the record', async () => {
    const { queue } = recordQueue()
    await expect(
      resolveSshManagedLanguageServerCommand({ ctx: makeContext(queue), manifest, tool: 'clangd' })
    ).resolves.toEqual({
      executable: '/home/user/.orca/code-intelligence/managed/clangd/2.0.0/bin/clangd',
      args: []
    })
  })

  it('garbage-collects remote versions outside the keep set', async () => {
    const { queue, commands } = makeQueue([
      [/^ls -1/, () => ({ code: 0, stdout: '0.1.0\n1.0.0\n2.0.0\nactive.json\n' })]
    ])
    await gcSshManagedLanguageServerVersions({
      ctx: makeContext(queue),
      tool: 'clangd',
      keepVersions: ['1.0.0', '2.0.0']
    })
    const joined = commands.join('\n')
    expect(joined).toContain("rm -rf -- '/home/user/.orca/code-intelligence/managed/clangd/0.1.0'")
    expect(joined).not.toContain('rm -rf -- /home/user/.orca/code-intelligence/managed/clangd/1.0.0')
    expect(joined).not.toContain('rm -rf -- /home/user/.orca/code-intelligence/managed/clangd/2.0.0')
  })
})
