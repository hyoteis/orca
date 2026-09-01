import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, Repo } from '../../shared/types'
import type { CodeIntelligenceScope } from '../../shared/code-intelligence-scope'
import { CodeIntelligenceScopeStore } from '../language-server/code-intelligence-scope-store'
import { cppScopeDirectoryName } from '../language-server/code-intelligence-setup-cache'
import type { SshConnection } from '../ssh/ssh-connection'

const { handleMock, connectionManagerMock, subscribeMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  connectionManagerMock: vi.fn(),
  subscribeMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: handleMock, on: vi.fn() }
}))
vi.mock('./ssh', () => ({ getSshConnectionManager: connectionManagerMock }))
// registerCodeIntelligenceHandlers runs once in production; mock the
// subscription so repeated test registrations stay isolated.
vi.mock('./ssh-transport-connected', () => ({
  subscribeSshTransportConnected: subscribeMock
}))

let tempRoot: string
let handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

import { registerCodeIntelligenceHandlers } from './code-intelligence'
import type { Store } from '../persistence'

const localCppScope = (overrides: Partial<CodeIntelligenceScope> = {}): CodeIntelligenceScope => ({
  id: 'local:worktree:demo:cpp',
  name: 'demo C++',
  executionHostId: 'local',
  workspaceKey: 'worktree:demo',
  workspaceRoot: 'C:/repo',
  language: 'cpp',
  members: [{ path: '.', visibleResults: true }],
  serverSource: { type: 'automatic' },
  enabled: true,
  revision: 1,
  ...overrides
})

function settingsStore(initial: CodeIntelligenceScope[]): {
  store: {
    getRepos: () => Repo[]
    getSettings: () => GlobalSettings
    updateSettings: (updates: Partial<GlobalSettings>) => GlobalSettings
  }
  scopes: CodeIntelligenceScopeStore
} {
  let settings = { codeIntelligenceScopes: initial } as GlobalSettings
  const store = {
    getRepos: () =>
      [
        {
          id: 'demo',
          path: 'C:/repo',
          displayName: 'demo',
          connectionId: null,
          executionHostId: 'local',
          kind: 'worktree' as const,
          badgeColor: '#000000',
          addedAt: 1
        },
        {
          id: 'box',
          path: '/workspace',
          displayName: 'box',
          connectionId: 'box',
          executionHostId: 'ssh:box' as const,
          kind: 'worktree' as const,
          badgeColor: '#000000',
          addedAt: 1
        }
      ] as unknown as Repo[],
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    }
  }
  return { store, scopes: new CodeIntelligenceScopeStore(store) }
}

/** Fires only the latest registered transport listener (production registers once). */
function notifyLatestSshTransportConnected(targetId: string): void {
  const listener = subscribeMock.mock.calls.at(-1)?.[0] as (targetId: string) => void
  listener?.(targetId)
}

/** exec double: answers `printf %s "$HOME"` and the scopes listing, records commands. */
function fakeSshConnection(commands: string[], listing = ''): SshConnection {
  return {
    exec: async (command: string) => {
      commands.push(command)
      const channel = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        write: () => true,
        end: () => {},
        close: () => channel.emit('close', 0)
      })
      if (command.startsWith('printf')) {
        setTimeout(() => channel.emit('data', Buffer.from('/home/u')), 0)
      } else if (command.startsWith('find')) {
        setTimeout(() => channel.emit('data', Buffer.from(listing)), 0)
      }
      setTimeout(() => channel.emit('close', 0), 0)
      return channel
    }
  } as unknown as SshConnection
}

async function register(scopes: CodeIntelligenceScope[], sshCommands: string[] = []) {
  const { store, scopes: scopeStore } = settingsStore(scopes)
  connectionManagerMock.mockReturnValue({
    getConnection: () => fakeSshConnection(sshCommands),
    getState: () => ({ remotePlatform: 'linux' })
  })
  registerCodeIntelligenceHandlers(scopeStore, store as unknown as Store)
  for (const call of handleMock.mock.calls) {
    handlers.set(call[0] as string, call[1] as (event: unknown, ...args: unknown[]) => unknown)
  }
  return handlers
}

beforeEach(async () => {
  handleMock.mockClear()
  handlers = new Map()
  tempRoot = await mkdtemp(join(tmpdir(), 'orca-ci-ipc-'))
})

describe('codeIntelligence:removeScope directory cleanup', () => {
  it('deletes the owning local scope directory', async () => {
    const scope = localCppScope()
    const handlers = await register([scope])
    const scopeDir = join(
      tempRoot,
      'code-intelligence',
      'cpp',
      'scopes',
      cppScopeDirectoryName(scope.id)
    )
    await mkdir(scopeDir, { recursive: true })
    await handlers.get('codeIntelligence:removeScope')!(null, scope.id)
    expect(await readdir(join(tempRoot, 'code-intelligence', 'cpp', 'scopes'))).toEqual([])
  })

  it('rm -rf the directory on a connected SSH host', async () => {
    const scope = localCppScope({
      id: 'ssh%3Abox:worktree:box:cpp',
      executionHostId: 'ssh:box',
      workspaceKey: 'worktree:box',
      workspaceRoot: '/workspace'
    })
    const commands: string[] = []
    const handlers = await register([scope], commands)
    await handlers.get('codeIntelligence:removeScope')!(null, scope.id)
    expect(commands).toContain(
      `rm -rf -- '/home/u/.orca/code-intelligence/cpp/scopes/${cppScopeDirectoryName(scope.id)}'`
    )
  })

  it('stays silent when the SSH host is offline', async () => {
    const scope = localCppScope({
      id: 'ssh%3Abox:worktree:box:cpp',
      executionHostId: 'ssh:box',
      workspaceKey: 'worktree:box',
      workspaceRoot: '/workspace'
    })
    const handlers = await register([scope])
    connectionManagerMock.mockReturnValue(undefined)
    await expect(handlers.get('codeIntelligence:removeScope')!(null, scope.id)).resolves.toBe(true)
  })

  it('leaves python scopes untouched', async () => {
    const scope = localCppScope({ language: 'python' })
    const handlers = await register([scope])
    const scopeDir = join(
      tempRoot,
      'code-intelligence',
      'cpp',
      'scopes',
      cppScopeDirectoryName(scope.id)
    )
    await mkdir(scopeDir, { recursive: true })
    await handlers.get('codeIntelligence:removeScope')!(null, scope.id)
    expect(await readdir(join(tempRoot, 'code-intelligence', 'cpp', 'scopes'))).toEqual([
      cppScopeDirectoryName(scope.id)
    ])
  })
})

const sshCppScope = (scopeId: string): CodeIntelligenceScope =>
  localCppScope({
    id: scopeId,
    executionHostId: 'ssh:box',
    workspaceKey: 'worktree:box',
    workspaceRoot: '/workspace'
  })

describe('SSH reconnect orphan sweep', () => {
  it('rm -rf remote scope directories no live scope owns', async () => {
    const live = sshCppScope('ssh%3Abox:worktree:box:cpp')
    const liveName = cppScopeDirectoryName(live.id)
    const orphanName = cppScopeDirectoryName('ssh%3Abox:worktree:gone:cpp')
    const commands: string[] = []
    await register([live], commands)
    connectionManagerMock.mockReturnValue({
      getConnection: () =>
        fakeSshConnection(
          commands,
          `/home/u/.orca/code-intelligence/cpp/scopes/${liveName}\n/home/u/.orca/code-intelligence/cpp/scopes/${orphanName}\n`
        ),
      getState: () => ({ remotePlatform: 'linux' })
    })

    notifyLatestSshTransportConnected('box')
    // The sweep is fire-and-forget; let its promise settle.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(commands).toContain(
      `rm -rf -- '/home/u/.orca/code-intelligence/cpp/scopes/${orphanName}'`
    )
    expect(commands.join('\n')).not.toContain(
      `rm -rf -- '/home/u/.orca/code-intelligence/cpp/scopes/${liveName}'`
    )
  })

  it('stays silent when the host is offline', async () => {
    const commands: string[] = []
    await register([], commands)
    connectionManagerMock.mockReturnValue(undefined)
    notifyLatestSshTransportConnected('box')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(commands).toEqual([])
  })
})

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})
