import type { ClientChannel } from 'ssh2'
import { posix, win32 } from 'node:path'
import type { Store } from '../persistence'
import type { IFilesystemProvider } from '../providers/types'
import type { SshConnection } from '../ssh/ssh-connection'
import type { RemoteOperatingSystem } from '../ssh/ssh-remote-platform'
import type {
  CodeIntelligenceCppSetupRequest,
  CodeIntelligenceCppSetupResult
} from '../../shared/code-intelligence-cpp-setup'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import {
  getCppScopeIdForRepo,
  normalizeScopeRelativePath
} from '../../shared/code-intelligence-scope'
import { cppScopeDirectoryName } from './code-intelligence-setup-cache'
import { buildWindowsLanguageServerCommand } from '../ssh/ssh-language-server-session-manager'

const SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.m', '.mm'])
const MAX_SOURCE_FILES = 50_000

type Dependencies = {
  getConnection: (targetId: string) => SshConnection | undefined
  getProvider: (targetId: string) => IFilesystemProvider | undefined
  getPlatform: (targetId: string) => RemoteOperatingSystem | undefined
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function remotePathApi(platform: RemoteOperatingSystem): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix
}

function captureCommand(connection: SshConnection, command: string): Promise<string> {
  return connection.exec(command).then(
    (channel) =>
      new Promise<string>((resolve, reject) => {
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        const stream = channel as ClientChannel
        stream.on('data', (chunk: Buffer) => stdout.push(chunk))
        stream.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        const timer = setTimeout(() => {
          stream.close()
          reject(new Error('Timed out preparing SSH code intelligence'))
        }, 10_000)
        timer.unref?.()
        stream.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        stream.once('close', (code: number | null) => {
          clearTimeout(timer)
          const output = Buffer.concat(stdout).toString('utf8').trim()
          if (code && code !== 0) {
            reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || output))
          } else {
            resolve(output)
          }
        })
      })
  )
}

async function resolveRemoteEnvironment(args: {
  connection: SshConnection
  platform: RemoteOperatingSystem
  workspaceRoot: string
}): Promise<{ home: string; clangd: string }> {
  if (args.platform === 'win32') {
    const homeCommand = buildWindowsLanguageServerCommand({
      executable: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Environment]::GetFolderPath("UserProfile")'
      ],
      cwd: args.workspaceRoot
    })
    const clangdCommand = buildWindowsLanguageServerCommand({
      executable: 'where.exe',
      args: ['clangd.exe'],
      cwd: args.workspaceRoot
    })
    const [home, clangdOutput] = await Promise.all([
      captureCommand(args.connection, homeCommand),
      captureCommand(args.connection, clangdCommand)
    ])
    return { home, clangd: clangdOutput.split(/\r?\n/)[0] }
  }
  const [home, clangd] = await Promise.all([
    captureCommand(args.connection, `printf %s "$HOME"`),
    captureCommand(args.connection, `cd ${quotePosix(args.workspaceRoot)} && command -v clangd`)
  ])
  if (!clangd) {
    throw new Error('clangd is not installed on the SSH Host')
  }
  return { home, clangd }
}

function isSourceFile(path: string): boolean {
  const normalized = path.toLowerCase()
  return [...SOURCE_EXTENSIONS].some((extension) => normalized.endsWith(extension))
}

export class CodeIntelligenceSshCppSetup {
  constructor(
    private readonly store: Store,
    private readonly dependencies: Dependencies
  ) {}

  async run(request: CodeIntelligenceCppSetupRequest): Promise<CodeIntelligenceCppSetupResult> {
    const roots = [...new Set(request.relativeRoots.map(normalizeScopeRelativePath))]
    const fail = (message: string, log = ''): CodeIntelligenceCppSetupResult => ({
      ok: false,
      message,
      log,
      relativeRoots: roots,
      installedTools: []
    })
    try {
      const repo = this.store.getRepo(request.repoId)
      if (!repo) {
        return fail('Project is no longer available')
      }
      const host = parseExecutionHostId(getRepoExecutionHostId(repo))
      if (host?.kind !== 'ssh') {
        return fail('SSH C++ setup requires an SSH project')
      }
      const connection = this.dependencies.getConnection(host.targetId)
      const provider = this.dependencies.getProvider(host.targetId)
      if (!connection || !provider) {
        return fail('SSH Host is not connected. Reconnect and retry.')
      }
      const platform = this.dependencies.getPlatform(host.targetId) ?? 'linux'
      const pathApi = remotePathApi(platform)
      const environment = await resolveRemoteEnvironment({
        connection,
        platform,
        workspaceRoot: repo.path
      })
      const sourceFiles = new Set<string>()
      for (const root of roots) {
        const absoluteRoot = root === '.' ? repo.path : pathApi.join(repo.path, root)
        const relativeFiles = await provider.listFiles(absoluteRoot, {
          maxResults: MAX_SOURCE_FILES + 1
        })
        for (const relativeFile of relativeFiles) {
          if (isSourceFile(relativeFile)) {
            sourceFiles.add(pathApi.join(absoluteRoot, relativeFile))
          }
        }
      }
      if (sourceFiles.size === 0) {
        return fail('No C or C++ source files were found in the selected SSH folders')
      }
      if (sourceFiles.size > MAX_SOURCE_FILES) {
        return fail(`SSH C++ indexing exceeds ${MAX_SOURCE_FILES} source files`)
      }
      const workspaceDirectories = request.workspaceDirectories ?? []
      const includeDirectories = new Set<string>([
        repo.path,
        ...roots.map((root) => (root === '.' ? repo.path : pathApi.join(repo.path, root))),
        ...workspaceDirectories
          .filter((path) =>
            ['api', 'include', 'interface'].includes(path.split('/').at(-1)?.toLowerCase() ?? '')
          )
          .map((path) => pathApi.join(repo.path, path)),
        ...(request.additionalIncludeDirectories ?? []).map((path) =>
          pathApi.isAbsolute(path) ? path : pathApi.join(repo.path, path)
        )
      ])
      const defines = (request.defines ?? []).map((define) => define.trim()).filter(Boolean)
      const cppStandard = request.cppStandard ?? 'c++17'
      const database = [...sourceFiles].map((file) => {
        const extension = pathApi.extname(file).toLowerCase()
        const isC = extension === '.c' || extension === '.m'
        return {
          directory: repo.path,
          file,
          arguments: [
            isC ? 'clang' : 'clang++',
            isC ? '-std=c11' : `-std=${cppStandard}`,
            ...defines.map((define) => `-D${define}`),
            ...[...includeDirectories].map((directory) => `-I${directory}`),
            '-c',
            file
          ]
        }
      })
      const cacheDirectory = pathApi.join(
        environment.home,
        '.orca',
        'code-intelligence',
        'cpp',
        'scopes',
        cppScopeDirectoryName(getCppScopeIdForRepo(repo))
      )
      await provider.createDir(cacheDirectory)
      await provider.writeFile(
        pathApi.join(cacheDirectory, 'compile_commands.json'),
        JSON.stringify(database, null, 2)
      )
      return {
        ok: true,
        message: 'Generated SSH BASIC compile commands',
        log: `Generated ${database.length} SSH compile commands in ${cacheDirectory}`,
        relativeRoots: roots,
        installedTools: [],
        clangdExecutable: environment.clangd,
        compileCommandsDir: cacheDirectory,
        configurationMode: 'basic',
        healthState: 'limited',
        compileCommandCount: database.length,
        warnings: [
          'SSH BASIC indexing infers include paths and may miss SDK headers, generated files, or build macros.'
        ]
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail(message, message)
    }
  }
}
