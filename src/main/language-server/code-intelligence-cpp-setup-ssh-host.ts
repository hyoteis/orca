import { posix } from 'node:path'
import type { Repo } from '../../shared/types'
import type { SshConnection } from '../ssh/ssh-connection'
import type { RemoteOperatingSystem } from '../ssh/ssh-remote-platform'
import { shellEscape } from '../ssh/ssh-connection-utils'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { getCppScopeIdForRepo } from '../../shared/code-intelligence-scope'
import { remoteCppScopeDirectoryPath } from './code-intelligence-setup-cache'
import {
  SshSetupExecQueue,
  buildRemoteFindIncludeDirectoriesCommand,
  buildRemoteFindSourceFilesCommand,
  buildRemoteMtimesCommand,
  buildRemoteReadableDirectoriesCommand,
  buildRemoteReadFileCommand,
  parseRemoteListing,
  sshPathDetection
} from './code-intelligence-ssh-setup-exec'
import type { CppSetupHost } from './code-intelligence-cpp-setup-host'

export type SshCppSetupHostDependencies = {
  getConnection: (targetId: string) => SshConnection | undefined
  getPlatform: (targetId: string) => RemoteOperatingSystem | undefined
}

export function createSshCppSetupHost(dependencies: SshCppSetupHostDependencies): CppSetupHost {
  // validateRepoHost resolves this before any other method may run.
  let queue: SshSetupExecQueue | undefined
  let uname = ''
  const execQueue = (): SshSetupExecQueue => {
    if (!queue) {
      throw new Error('SSH setup host was used before validation')
    }
    return queue
  }
  return {
    detection: sshPathDetection,
    validateRepoHost: async (repo: Repo, logs) => {
      const host = parseExecutionHostId(getRepoExecutionHostId(repo))
      if (host?.kind !== 'ssh') {
        return 'SSH C++ code intelligence requires an SSH project'
      }
      const connection = dependencies.getConnection(host.targetId)
      if (!connection) {
        logs.push(`SSH target ${host.targetId} has no live connection`)
        return 'SSH Host is not connected. Reconnect and retry.'
      }
      const knownPlatform = dependencies.getPlatform(host.targetId)
      if (!knownPlatform) {
        logs.push(`SSH target ${host.targetId} is connected but its platform is not known yet`)
        return 'SSH Host is connected but its platform is not known yet. Reconnect the Host and retry.'
      }
      if (knownPlatform === 'win32') {
        return 'C++ code intelligence on Windows SSH Hosts is not supported; POSIX Hosts (Linux, macOS, WSL) only.'
      }
      queue = new SshSetupExecQueue(connection)
      return null
    },
    scopeDirectoryFor: async (repo: Repo) => {
      uname = await execQueue().capture('uname -s')
      if (!/^(Linux|Darwin)/.test(uname)) {
        throw new Error(`SSH Host is not a POSIX system (uname: ${uname || 'unknown'})`)
      }
      const home = await execQueue().capture('printf %s "$HOME"')
      if (!home || !posix.isAbsolute(home)) {
        throw new Error('Could not resolve the home directory on the SSH Host')
      }
      return remoteCppScopeDirectoryPath(home, getCppScopeIdForRepo(repo))
    },
    statMtimes: async (paths) => {
      const result = await execQueue().exec(buildRemoteMtimesCommand(paths, uname))
      if (result.code !== 0) {
        return null
      }
      const mtimes = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(Number)
      if (mtimes.length !== paths.length || mtimes.some((mtime) => !Number.isFinite(mtime))) {
        return null
      }
      return mtimes
    },
    ensureDirectory: async (directory) => {
      await execQueue().capture(`mkdir -p ${shellEscape(directory)}`)
    },
    findSourceFiles: async (root) =>
      parseRemoteListing(await execQueue().capture(buildRemoteFindSourceFilesCommand(root))),
    findIncludeDirectories: async (root) =>
      parseRemoteListing(await execQueue().capture(buildRemoteFindIncludeDirectoriesCommand(root))),
    readableDirectories: async (candidates) =>
      parseRemoteListing(await execQueue().capture(buildRemoteReadableDirectoriesCommand(candidates))),
    readTextFile: async (path) => await execQueue().capture(buildRemoteReadFileCommand(path)),
    writeTextFile: async (directory, fileName, content) => {
      await execQueue().writeFile(directory, fileName, content)
    }
  }
}
