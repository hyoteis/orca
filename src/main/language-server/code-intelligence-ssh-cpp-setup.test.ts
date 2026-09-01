import { EventEmitter } from 'node:events'
import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Store } from '../persistence'
import type { SshConnection } from '../ssh/ssh-connection'
import type { RemoteOperatingSystem } from '../ssh/ssh-remote-platform'
import { getCppScopeIdForRepo } from '../../shared/code-intelligence-scope'
import { CodeIntelligenceSshCppSetup } from './code-intelligence-ssh-cpp-setup'
import { cppScopeDirectoryName } from './code-intelligence-setup-cache'
import { buildRemoteAtomicWriteCommand } from './code-intelligence-ssh-setup-exec'

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
  /** `command -v <tool>` answers for cmake/ninja/gn (clangd is built-in). */
  toolPaths?: Record<string, string>
  /** Answers for `find <root> -mindepth 1` subdirectory listings. */
  subdirectoriesByRoot?: Record<string, string>
  /** Exit answers for `exec cmake` / `exec gn` configure commands. */
  configureResults?: Record<string, RemoteResponse>
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
    if (/^command -v '\w+'$/.test(command)) {
      const path = options.toolPaths?.[command.match(/^command -v '(\w+)'$/)?.[1] ?? '']
      return path ? { stdout: path } : { code: 1 }
    }
    if (command.startsWith('rm -rf ')) {
      return { code: 0 }
    }
    // Configure commands arrive as `cd '<cwd>' && exec '<executable>' ...`; answer by executable basename.
    if (command.startsWith('cd ') && command.includes("&& exec '")) {
      const executable = command.match(/exec '([^']+)' /)?.[1] ?? ''
      const name = executable.split('/').pop() ?? ''
      return options.configureResults?.[name] ?? { code: 0 }
    }
    if (command.startsWith('test -r ')) {
      const path = command.match(/^test -r '(.*)'$/)?.[1] ?? ''
      return { code: readable.has(path) ? 0 : 1 }
    }
    if (command.startsWith('find') && command.includes('-type f')) {
      const root = command.match(/^find '([^']+)' /)?.[1] ?? ''
      return { stdout: options.sourcesByRoot?.[root] ?? '/srv/project/module/src/main.cpp\n' }
    }
    if (command.startsWith('find') && command.includes('-mindepth 1')) {
      const root = command.match(/^find '([^']+)' /)?.[1] ?? ''
      return { stdout: options.subdirectoriesByRoot?.[root] ?? '' }
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
    const atomicWrite = buildRemoteAtomicWriteCommand(scopeDirectory, 'compile_commands.json')
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

  it('names the real cause when the connection is live but the platform is unknown', async () => {
    const remote = scriptedConnection(linuxHostScript())
    const setup = new CodeIntelligenceSshCppSetup(fakeStore(), {
      getConnection: () => remote.connection,
      getPlatform: () => undefined
    })

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['module'],
      installMissingTools: true
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('platform is not known')
    expect(result.log).toContain('connected but its platform is not known')
    expect(remote.commands).toEqual([])
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

  it('configures a CMake member remotely and lands the merged CDB in the stable scope directory', async () => {
    const { setup, commands, stdin, files } = setupWith(
      linuxHostScript({
        readable: new Set([
          ...DEFAULT_READABLE_PATHS,
          '/srv/project/module/CMakeLists.txt'
        ]),
        toolPaths: { cmake: '/usr/bin/cmake', ninja: '/usr/bin/ninja' }
      })
    )
    const cmakeShard = [
      {
        directory: '/srv/project/module',
        file: '/srv/project/module/src/main.cpp',
        arguments: ['clang++', '-c', '/srv/project/module/src/main.cpp']
      }
    ]
    files.set(`${scopeDirectory}/build-1/compile_commands.json`, JSON.stringify(cmakeShard))

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['module'],
      installMissingTools: true
    })

    expect(result).toMatchObject({
      ok: true,
      configurationMode: 'cmake',
      healthState: 'ready',
      compileCommandCount: 1,
      clangdExecutable: '/usr/bin/clangd',
      compileCommandsDir: scopeDirectory
    })
    expect(result.warnings).toEqual([])
    // Build directory recreated fresh, configured with compile-command export.
    expect(commands).toContainEqual(
      `rm -rf '${scopeDirectory}/build-1' && mkdir -p '${scopeDirectory}/build-1'`
    )
    const configure = commands.find((command) => command.includes("exec '/usr/bin/cmake'"))
    expect(configure).toEqual(expect.stringMatching(/CMAKE_EXPORT_COMPILE_COMMANDS=ON/))
    expect(configure).toEqual(expect.stringContaining(`'-B' '${scopeDirectory}/build-1'`))
    // CMake members do not go through the basic source walk.
    expect(
      commands.some(
        (command) => command.startsWith("find '/srv/project/module'") && command.includes('-type f')
      )
    ).toBe(false)
    // Shard is read back and merged locally, then swapped atomically at the scope root.
    expect(commands).toContainEqual(`cat '${scopeDirectory}/build-1/compile_commands.json'`)
    const mergedWrite = commands.indexOf(
      buildRemoteAtomicWriteCommand(scopeDirectory, 'compile_commands.json')
    )
    expect(JSON.parse(stdin[mergedWrite] ?? 'null')).toEqual(cmakeShard)
  })

  it('reuses existing GN compile commands found via .gn upward search', async () => {
    const gnShard = [
      {
        directory: '/srv/project',
        file: '/srv/project/module/main.cc',
        arguments: ['clang++', '-c', '/srv/project/module/main.cc']
      }
    ]
    const { setup, commands, files } = setupWith(
      linuxHostScript({
        readable: new Set([
          ...DEFAULT_READABLE_PATHS,
          '/srv/project/module/BUILD.gn',
          '/srv/project/.gn',
          '/srv/project/out/default/compile_commands.json'
        ]),
        subdirectoriesByRoot: { '/srv/project/out': '/srv/project/out/default\n' },
        toolPaths: { gn: '/usr/bin/gn' }
      })
    )
    files.set('/srv/project/out/default/compile_commands.json', JSON.stringify(gnShard))

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['module'],
      installMissingTools: true
    })

    expect(result).toMatchObject({
      ok: true,
      configurationMode: 'gn',
      healthState: 'ready',
      compileCommandCount: 1,
      compileCommandsDir: scopeDirectory
    })
    expect(commands.some((command) => command.includes("exec '/usr/bin/gn'"))).toBe(false)
    expect(commands).toContainEqual(`cat '/srv/project/out/default/compile_commands.json'`)
  })

  it('generates GN compile commands remotely when no output directory exists', async () => {
    const outputDirectory = posix.join(
      '/srv/project/out',
      `.orca-code-intelligence-${posix.basename(scopeDirectory)}-build-1`
    )
    const gnShard = [
      {
        directory: outputDirectory,
        file: '/srv/project/module/main.cc',
        arguments: ['clang++', '-c', '/srv/project/module/main.cc']
      }
    ]
    const { setup, commands, files } = setupWith(
      linuxHostScript({
        readable: new Set([
          ...DEFAULT_READABLE_PATHS,
          '/srv/project/module/BUILD.gn',
          '/srv/project/.gn'
        ]),
        toolPaths: { gn: '/usr/bin/gn' }
      })
    )
    files.set(`${outputDirectory}/compile_commands.json`, JSON.stringify(gnShard))

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['module'],
      installMissingTools: true
    })

    expect(result).toMatchObject({ ok: true, configurationMode: 'gn', compileCommandCount: 1 })
    const gnCommand = commands.find((command) => command.includes("exec '/usr/bin/gn'"))
    expect(gnCommand).toEqual(expect.stringContaining('export-compile-commands'))
    expect(gnCommand).toEqual(expect.stringContaining('--root=/srv/project'))
    expect(commands).toContainEqual(`cat '${outputDirectory}/compile_commands.json'`)
  })

  it('maps a failed CMake configure to an atomic setup failure', async () => {
    const { setup, commands } = setupWith(
      linuxHostScript({
        readable: new Set([...DEFAULT_READABLE_PATHS, '/srv/project/module/CMakeLists.txt']),
        toolPaths: { cmake: '/usr/bin/cmake', ninja: '/usr/bin/ninja' },
        configureResults: { cmake: { code: 1, stderr: 'CMake Error: no C++ compiler found' } }
      })
    )

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['module'],
      installMissingTools: true
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('CMake configuration failed for module')
    expect(result.log).toContain('CMake Error: no C++ compiler found')
    expect(commands.some((command) => command.startsWith(`cd '${scopeDirectory}' && cat >`))).toBe(
      false
    )
  })

  it('fails with a manual install hint when sudo -n cannot install CMake tools', async () => {
    const { setup } = setupWith((command) => {
      if (command.includes("'apt-get'")) {
        return { code: 1, stderr: 'sudo: a password is required' }
      }
      return linuxHostScript({
        readable: new Set([...DEFAULT_READABLE_PATHS, '/srv/project/module/CMakeLists.txt'])
      })(command)
    })

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['module'],
      installMissingTools: true
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Dependency installation failed')
    expect(result.message).toContain('sudo apt-get update && sudo apt-get install -y cmake ninja')
    expect(result.message).not.toContain('sudo -n')
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
