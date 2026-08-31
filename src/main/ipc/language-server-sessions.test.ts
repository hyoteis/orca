import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, Repo } from '../../shared/types'
import type { CodeIntelligenceScope } from '../../shared/code-intelligence-scope'
import { clangdCompileCommandsDirArg } from '../../shared/code-intelligence-cpp-setup'
import type { SshConnection } from '../ssh/ssh-connection'
import { CodeIntelligenceScopeStore } from '../language-server/code-intelligence-scope-store'

const { handleMock, onMock, spawnMock, getSshConnectionManagerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  spawnMock: vi.fn(),
  getSshConnectionManagerMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock, on: onMock } }))
vi.mock('./ssh', () => ({ getSshConnectionManager: getSshConnectionManagerMock }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { registerLanguageServerSessionHandlers } from './language-server-sessions'

const sender = () =>
  ({ send: vi.fn(), once: vi.fn(), isDestroyed: () => false }) as never

const fakeChild = () =>
  Object.assign(new EventEmitter(), {
    pid: 4321,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { destroyed: false },
    kill: vi.fn()
  }) as never

/** Spawn channels stay open; `test -d` channels close with the mapped exit code (null = dead transport). */
function fakeSshConnection(exitByCommand: Record<string, number | null>, commands: string[]) {
  return {
    exec: async (command: string) => {
      commands.push(command)
      const channel = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        write: () => true,
        end: () => {},
        close: () => channel.emit('close', 0)
      })
      const exit = Object.entries(exitByCommand).find(([prefix]) => command.startsWith(prefix))?.[1]
      if (exit !== undefined) {
        setTimeout(() => channel.emit('close', exit), 0)
      }
      return channel
    }
  } as unknown as SshConnection
}

function scopeFixture(
  scopeId: string,
  executionHostId: 'local' | `ssh:${string}`,
  compileCommandsDir?: string
): CodeIntelligenceScope {
  return {
    id: scopeId,
    name: 'Engine',
    executionHostId,
    workspaceKey: `folder:${scopeId}`,
    workspaceRoot: '/workspace',
    language: 'cpp',
    members: [
      { path: 'engine', visibleResults: true },
      { path: '/abs/host/module', visibleResults: true }
    ],
    serverSource: compileCommandsDir
      ? {
          type: 'custom',
          executable: executionHostId === 'local' ? 'clangd' : '/usr/bin/clangd',
          args: [clangdCompileCommandsDirArg(compileCommandsDir)]
        }
      : { type: 'automatic' },
    enabled: true,
    revision: 1
  }
}

function registerWith(scopes: CodeIntelligenceScope[]): {
  open: (scopeId: string) => Promise<unknown>
} {
  let settings = { codeIntelligenceScopes: scopes } as GlobalSettings
  const settingsStore = {
    getRepos: () =>
      scopes.map<Repo>((scope) => ({
        id: scope.id,
        path: '/workspace',
        displayName: scope.name,
        connectionId: scope.executionHostId === 'local' ? null : scope.executionHostId.slice(4),
        executionHostId: scope.executionHostId,
        kind: 'folder' as const,
        badgeColor: '#000000',
        addedAt: 1
      })),
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    }
  }
  const store = new CodeIntelligenceScopeStore(settingsStore)
  for (const scope of scopes) {
    store.grantConsent(scope.id, 1, Date.now())
  }
  registerLanguageServerSessionHandlers(store)
  const open = handleMock.mock.calls
    .findLast(([channel]) => channel === 'languageServers:open')![1] as (event: unknown, request: { sessionId: string; scopeId: string; revision: number }) => Promise<unknown>
  return {
    open: (scopeId: string) => open({ sender: sender() }, { sessionId: `s:${scopeId}`, scopeId, revision: 1 })
  }
}

beforeEach(() => {
  handleMock.mockClear()
  onMock.mockClear()
  spawnMock.mockClear()
  spawnMock.mockImplementation(() => fakeChild())
  getSshConnectionManagerMock.mockReturnValue(null)
})

describe('registerLanguageServerSessionHandlers clangd compile-commands wiring', () => {
  it('spawns local clangd with the --compile-commands-dir arg', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-cdb-'))
    const { open } = registerWith([scopeFixture('scope', 'local', directory)])
    await expect(open('scope')).resolves.toEqual({ sessionId: 's:scope' })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0][0]).toBe('clangd')
    expect(spawnMock.mock.calls[0][1]).toEqual([clangdCompileCommandsDirArg(directory)])
  })

  it('refuses local spawn when the directory is missing, naming it', async () => {
    const missing = join(tmpdir(), 'orca-cdb-missing')
    const { open } = registerWith([scopeFixture('scope', 'local', missing)])
    await expect(open('scope')).rejects.toThrow(missing)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('validates the remote directory over SSH and launches with the same arg', async () => {
    const remoteDir = '/home/dev/.orca/code-intelligence/cpp/scopes/abc123'
    const commands: string[] = []
    getSshConnectionManagerMock.mockReturnValue({
      getConnection: () => fakeSshConnection({ 'test -d': 0 }, commands),
      getState: () => ({ remotePlatform: 'linux' })
    })
    const { open } = registerWith([scopeFixture('scope', 'ssh:box', remoteDir)])
    await expect(open('scope')).resolves.toEqual({ sessionId: 's:scope' })
    expect(commands[0]).toBe(`test -d '${remoteDir}'`)
    expect(commands[1]).toContain(`'--compile-commands-dir=${remoteDir}'`)
  })

  it('refuses the SSH launch when the remote directory is missing, naming it', async () => {
    const remoteDir = '/home/dev/.orca/code-intelligence/cpp/scopes/gone'
    const commands: string[] = []
    getSshConnectionManagerMock.mockReturnValue({
      getConnection: () => fakeSshConnection({ 'test -d': 1 }, commands),
      getState: () => ({ remotePlatform: 'linux' })
    })
    const { open } = registerWith([scopeFixture('scope', 'ssh:box', remoteDir)])
    await expect(open('scope')).rejects.toThrow(remoteDir)
    expect(commands).toEqual([`test -d '${remoteDir}'`])
  })

  it('reports a dead SSH transport as a connection error, not a missing directory', async () => {
    getSshConnectionManagerMock.mockReturnValue({
      getConnection: () => fakeSshConnection({ 'test -d': null }, []),
      getState: () => ({ remotePlatform: 'linux' })
    })
    const { open } = registerWith([scopeFixture('scope', 'ssh:box', '/home/dev/cdb')])
    await expect(open('scope')).rejects.toThrow('SSH connection was interrupted')
  })

  it('leaves python launches untouched', async () => {
    const python: CodeIntelligenceScope = {
      ...scopeFixture('scope', 'local'),
      language: 'python',
      members: [{ path: 'engine', visibleResults: true }]
    }
    const { open } = registerWith([python])
    await expect(open('scope')).resolves.toEqual({ sessionId: 's:scope' })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0][0]).toBe('basedpyright-langserver')
  })
})
