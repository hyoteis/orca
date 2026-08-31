import { EventEmitter } from 'node:events'
import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Store } from '../persistence'
import type { SshConnection } from '../ssh/ssh-connection'
import type { RemoteOperatingSystem } from '../ssh/ssh-remote-platform'
import { getCppScopeIdForRepo } from '../../shared/code-intelligence-scope'
import { CodeIntelligenceSshCppSetup } from './code-intelligence-ssh-cpp-setup'
import { cppScopeDirectoryName } from './code-intelligence-setup-cache'

type RemoteResponse = { code?: number; stdout?: string; stderr?: string }

/** Scripted remote shell: answers each exec by command text, records commands and stdin.
 * Atomic-write commands populate a tiny in-memory FS that `cat` reads back. */
function scriptedConnection(respond: (command: string) => RemoteResponse) {
  const commands: string[] = []
  const stdin: string[] = []
  const files = new Map<string, string>()
  const connection = {
    exec: async (command: string) => {
      const index = commands.length
      commands.push(command)
      // Shell-scripted commands resolve eagerly so a throwing script rejects exec
      // like a dropped connection; stdin-driven writes resolve on the timer.
      const directory = command.match(/^cd '(.*)' && cat >/)?.[1]
      const readPath = command.match(/^cat '(.*)'$/)?.[1]
      const response = directory || readPath ? undefined : respond(command)
      const channel = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        write: (data: string) => {
          stdin[index] = data
        },
        end: () => {},
        close: () => {
          channel.emit('close', 0)
        }
      })
      setTimeout(() => {
        if (directory) {
          files.set(`${directory}/compile_commands.json`, stdin[index] ?? '')
          channel.emit('close', 0)
          return
        }
        const resolved =
          response ?? { code: 0, stdout: files.get(readPath!) ?? '' }
        if (resolved.stdout) {
          channel.emit('data', Buffer.from(resolved.stdout))
        }
        if (resolved.stderr) {
          channel.stderr.emit('data', Buffer.from(resolved.stderr))
        }
        channel.emit('close', resolved.code ?? 0)
      }, 0)
      return channel
    }
  } as unknown as SshConnection
  return { connection, commands, stdin, files }
}

const REPO = {
  id: 'repo-1',
  kind: 'git' as const,
  path: '/srv/project',
  displayName: 'Remote project',
  executionHostId: 'ssh:ssh-1' as const,
  connectionId: 'ssh-1'
}
const DEFAULT_READABLE_PATHS = new Set([
  '/srv/project',
  '/srv/project/module',
  '/srv/project/include'
])

type HostScriptOptions = {
  readable?: Set<string>
  sourcesByRoot?: Record<string, string>
}

function linuxHostScript(options: HostScriptOptions = {}) {
  const readable = options.readable ?? DEFAULT_READABLE_PATHS
  return (command: string): RemoteResponse => {
    if (command === 'uname -s') {
      return { stdout: 'Linux' }
    }
    if (command === 'printf %s "$HOME"') {
      return { stdout: '/home/dev' }
    }
    if (command.startsWith('command -v clangd')) {
      return { stdout: '/usr/bin/clangd' }
    }
    if (command.startsWith('test -r ')) {
      const path = command.match(/^test -r '(.*)'$/)?.[1] ?? ''
      return { code: readable.has(path) ? 0 : 1 }
    }
    if (command.startsWith('find') && command.includes('-type f')) {
      const root = command.match(/^find '([^']+)' /)?.[1] ?? ''
      return { stdout: options.sourcesByRoot?.[root] ?? '/srv/project/module/src/main.cpp\n' }
    }
    if (command.startsWith('find')) {
      return { stdout: command.includes("'/srv/project'") ? '/srv/project/include\n' : '' }
    }
    if (command.startsWith('for d in')) {
      const listPart = command.slice(command.indexOf('in ') + 3, command.indexOf('; do'))
      const readableListed = [...listPart.matchAll(/'([^']+)'/g)]
        .map((match) => match[1]!)
        .filter((path) => readable.has(path))
      return { stdout: readableListed.length > 0 ? `${readableListed.join('\n')}\n` : '' }
    }
    return { code: 0 }
  }
}

function fakeStore(): Store {
  return { getRepo: () => REPO } as unknown as Store
}

function setupWith(
  respond: (command: string) => RemoteResponse,
  platform: RemoteOperatingSystem = 'linux'
) {
  const remote = scriptedConnection(respond)
  const setup = new CodeIntelligenceSshCppSetup(fakeStore(), {
    getConnection: () => remote.connection,
    getPlatform: () => platform
  })
  return { setup, ...remote }
}

const scopeDirectory = posix.join(
  '/home/dev/.orca/code-intelligence/cpp/scopes',
  cppScopeDirectoryName(getCppScopeIdForRepo(REPO))
)

describe('CodeIntelligenceSshCppSetup', () => {
  it('runs basic member setup fully remotely and lands the merged CDB in the stable scope directory', async () => {
    const { setup, commands, stdin } = setupWith(linuxHostScript())

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['module'],
      installMissingTools: true
    })

    expect(result).toMatchObject({
      ok: true,
      configurationMode: 'basic',
      healthState: 'limited',
      compileCommandCount: 1,
      clangdExecutable: '/usr/bin/clangd',
      compileCommandsDir: scopeDirectory
    })

    // Shard written under basic/, merged CDB swapped atomically in the scope root.
    expect(commands).toContainEqual(expect.stringContaining(`cd '${scopeDirectory}/basic'`))
    const atomicWrite = `cd '${scopeDirectory}' && cat > '.compile_commands.json.tmp' && mv '.compile_commands.json.tmp' 'compile_commands.json'`
    const mergedWrite = commands.indexOf(atomicWrite)
    expect(mergedWrite).toBeGreaterThan(-1)
    const merged = JSON.parse(stdin[mergedWrite] ?? 'null')
    expect(merged).toEqual([
      {
        directory: '/srv/project',
        file: '/srv/project/module/src/main.cpp',
        arguments: expect.arrayContaining([
          'clang++',
          '-std=c++17',
          '-I/srv/project',
          '-I/srv/project/include',
          '-I/srv/project/module',
          '-c',
          '/srv/project/module/src/main.cpp'
        ])
      }
    ])
    // The shard is read back and merged locally, not trusted blind.
    expect(commands).toContainEqual(`cat '${scopeDirectory}/basic/compile_commands.json'`)
  })

  it('fails with a reconnect hint when the connection drops mid-run, and a rerun succeeds', async () => {
    let dropped = true
    const { setup, commands } = setupWith((command) => {
      if (dropped && command.startsWith('find')) {
        throw new Error('Not connected')
      }
      return linuxHostScript()(command)
    })
    const request = { repoId: 'repo-1', relativeRoots: ['module'], installMissingTools: true }

    const interrupted = await setup.run(request)
    expect(interrupted).toMatchObject({
      ok: false,
      message: 'SSH connection was interrupted. Reconnect and retry.'
    })
    expect(commands.some((command) => command.includes('cat >'))).toBe(false)

    dropped = false
    const rerun = await setup.run(request)
    expect(rerun).toMatchObject({ ok: true, compileCommandsDir: scopeDirectory })
  })

  it('fails fast on non-POSIX remotes before running any command', async () => {
    const { setup, commands } = setupWith(linuxHostScript(), 'win32')

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['module'],
      installMissingTools: true
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Windows SSH Hosts')
    expect(commands).toEqual([])
  })

  it('fails atomically with a manual install hint when sudo -n cannot install', async () => {
    const { setup } = setupWith((command) => {
      if (command.startsWith('command -v clangd')) {
        return { code: 1 }
      }
      if (command.includes("'apt-get'")) {
        return { code: 1, stderr: 'sudo: a password is required' }
      }
      return linuxHostScript()(command)
    })

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['module'],
      installMissingTools: true
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Dependency installation failed')
    expect(result.message).toContain('sudo apt-get update && sudo apt-get install -y clangd')
    expect(result.message).not.toContain('sudo -n')
  })

  it('fails when a member needs CMake or GN generation (later tickets)', async () => {
    const { setup } = setupWith(
      linuxHostScript({
        readable: new Set([...DEFAULT_READABLE_PATHS, '/srv/project/module/CMakeLists.txt'])
      })
    )

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['module'],
      installMissingTools: true
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('CMake/GN members')
    expect(result.message).toContain('module')
  })

  it('accepts host-absolute members (dual form) against the remote filesystem', async () => {
    const { setup, stdin, commands } = setupWith(
      linuxHostScript({
        readable: new Set([...DEFAULT_READABLE_PATHS, '/opt/other']),
        sourcesByRoot: { '/opt/other': '/opt/other/main.c\n' }
      })
    )

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['/opt/other'],
      installMissingTools: true
    })

    expect(result).toMatchObject({ ok: true, relativeRoots: ['/opt/other'] })
    const mergedWrite = commands.findIndex((command) =>
      command.startsWith(`cd '${scopeDirectory}' && cat >`)
    )
    const merged = JSON.parse(stdin[mergedWrite] ?? 'null')
    expect(merged).toEqual([
      {
        directory: '/srv/project',
        file: '/opt/other/main.c',
        arguments: expect.arrayContaining(['clang', '-std=c11', '-c', '/opt/other/main.c'])
      }
    ])
  })

  it('fails without writing the merged CDB when no member has sources', async () => {
    const { setup, commands } = setupWith(
      linuxHostScript({ sourcesByRoot: { '/srv/project/module': '' } })
    )

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['module'],
      installMissingTools: true
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('No compile commands were generated')
    expect(commands.some((command) => command.includes('cat >'))).toBe(false)
  })
})
