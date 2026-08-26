import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { SshConnection } from '../ssh/ssh-connection'
import type { IFilesystemProvider } from '../providers/types'
import { CodeIntelligenceSshCppSetup } from './code-intelligence-ssh-cpp-setup'

function channelWithOutput(output: string): EventEmitter & { stderr: EventEmitter } {
  const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
  setTimeout(() => {
    channel.emit('data', Buffer.from(output))
    channel.emit('close', 0)
  }, 0)
  return channel
}

function fakeStore(): Store {
  return {
    getRepo: () => ({
      id: 'repo-1',
      path: '/srv/project',
      displayName: 'Remote project',
      executionHostId: 'ssh:ssh-1',
      connectionId: 'ssh-1'
    })
  } as unknown as Store
}

describe('SSH C++ setup', () => {
  it('writes a BASIC compilation database into the remote Orca cache', async () => {
    const exec = vi.fn(async (command: string) =>
      channelWithOutput(command.includes('command -v clangd') ? '/usr/bin/clangd' : '/home/dev')
    )
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const provider = {
      listFiles: vi.fn().mockResolvedValue(['src/main.cpp', 'include/main.h']),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile
    } as unknown as IFilesystemProvider
    const setup = new CodeIntelligenceSshCppSetup(fakeStore(), {
      getConnection: () => ({ exec }) as unknown as SshConnection,
      getProvider: () => provider,
      getPlatform: () => 'linux'
    })

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['module'],
      workspaceDirectories: ['module/api', 'shared/include'],
      installMissingTools: true,
      defines: ['REMOTE_BUILD=1'],
      cppStandard: 'c++20'
    })

    expect(result).toMatchObject({
      ok: true,
      configurationMode: 'basic',
      healthState: 'limited',
      compileCommandCount: 1,
      clangdExecutable: '/usr/bin/clangd'
    })
    expect(provider.createDir).toHaveBeenCalledWith(
      expect.stringMatching(/^\/home\/dev\/\.orca\/code-intelligence\/cpp\//)
    )
    const database = JSON.parse(writeFile.mock.calls[0][1])
    expect(database).toEqual([
      expect.objectContaining({
        file: '/srv/project/module/src/main.cpp',
        arguments: expect.arrayContaining([
          'clang++',
          '-std=c++20',
          '-DREMOTE_BUILD=1',
          '-I/srv/project/shared/include'
        ])
      })
    ])
  })
})
