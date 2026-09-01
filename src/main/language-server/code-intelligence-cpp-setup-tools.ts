import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'

export const COMMAND_TIMEOUT_MS = 10 * 60 * 1000
export const MAX_LOG_BYTES = 1024 * 1024
export const NO_COMPILE_COMMANDS_MESSAGE =
  'No compile commands were generated: no member folder contains C or C++ sources or a buildable project. Select a member with sources or generate its build directory, then retry.'

export type CppSetupToolName = 'clangd' | 'cmake' | 'ninja' | 'gn'
export type CppSetupCommandResult = { code: number | null; output: string }
export type CppSetupToolPaths = Partial<Record<CppSetupToolName, string>>
export type CppSetupCommandRunner = (
  executable: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
) => Promise<CppSetupCommandResult>

export function executableName(tool: CppSetupToolName, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${tool}.exe` : tool
}

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function windowsToolCandidates(tool: CppSetupToolName, env: NodeJS.ProcessEnv): string[] {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const localAppData = env.LOCALAPPDATA ?? ''
  const name = executableName(tool, 'win32')
  const candidates = [
    join(programFiles, 'LLVM', 'bin', name),
    join(programFiles, 'CMake', 'bin', name),
    join(localAppData, 'Programs', 'LLVM', 'bin', name),
    join(localAppData, 'Microsoft', 'WinGet', 'Links', name)
  ]
  if (tool === 'clangd') {
    candidates.push(
      join(
        programFiles,
        'Android',
        'Android Studio',
        'plugins',
        'cidr-clangd',
        'bin',
        'clang',
        'win',
        'x64',
        'bin',
        name
      )
    )
  }
  for (const edition of ['Community', 'Professional', 'Enterprise', 'BuildTools']) {
    const vsRoot = join(programFiles, 'Microsoft Visual Studio', '2022', edition, 'Common7', 'IDE')
    if (tool === 'cmake') {
      candidates.push(join(vsRoot, 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', name))
    } else if (tool === 'ninja') {
      candidates.push(join(vsRoot, 'CommonExtensions', 'Microsoft', 'CMake', 'Ninja', name))
    } else if (tool === 'clangd') {
      candidates.push(
        join(vsRoot, 'CommonExtensions', 'Microsoft', 'VC', 'Tools', 'Llvm', 'x64', 'bin', name)
      )
    }
  }
  return candidates
}

function pathCandidates(
  tool: CppSetupToolName,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] {
  const pathEntries = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  const candidates = pathEntries.map((entry) => join(entry, executableName(tool, platform)))
  if (platform === 'win32') {
    candidates.push(...windowsToolCandidates(tool, env))
  } else if (platform === 'darwin' && tool === 'clangd') {
    candidates.push('/opt/homebrew/opt/llvm/bin/clangd', '/usr/local/opt/llvm/bin/clangd')
  }
  return [...new Set(candidates)]
}

export async function discoverCppSetupTools(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): Promise<CppSetupToolPaths> {
  const result: CppSetupToolPaths = {}
  for (const tool of ['clangd', 'cmake', 'ninja', 'gn'] as const) {
    for (const candidate of pathCandidates(tool, platform, env)) {
      if (await isExecutable(candidate)) {
        result[tool] = candidate
        break
      }
    }
  }
  return result
}

export function packageInstallCommands(
  platform: NodeJS.Platform,
  missing: readonly CppSetupToolName[]
): string[][] {
  if (platform === 'win32') {
    if (missing.includes('gn')) {
      throw new Error(
        'GN was not found. Install depot_tools or add a gn.exe binary to PATH, then retry.'
      )
    }
    const packages: Record<Exclude<CppSetupToolName, 'gn'>, string> = {
      clangd: 'LLVM.LLVM',
      cmake: 'Kitware.CMake',
      ninja: 'Ninja-build.Ninja'
    }
    return missing.map((tool) => [
      'winget',
      'install',
      '--id',
      packages[tool],
      '--exact',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements'
    ])
  }
  if (platform === 'darwin') {
    return [['brew', 'install', ...missing.map((tool) => (tool === 'clangd' ? 'llvm' : tool))]]
  }
  const packages = missing.map((tool) =>
    tool === 'ninja' ? 'ninja-build' : tool === 'gn' ? 'generate-ninja' : tool
  )
  return [
    ['sudo', '-n', 'apt-get', 'update'],
    ['sudo', '-n', 'apt-get', 'install', '-y', ...packages]
  ]
}

export function runCppSetupCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<CppSetupCommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(executable, [...args], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const chunks: Buffer[] = []
    let retained = 0
    const collect = (chunk: Buffer): void => {
      const accepted = chunk.subarray(0, Math.max(0, MAX_LOG_BYTES - retained))
      retained += accepted.byteLength
      if (accepted.byteLength > 0) {
        chunks.push(accepted)
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolveResult({ code: null, output: error.message })
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolveResult({ code, output: Buffer.concat(chunks).toString('utf8') })
    })
  })
}

function visualStudioEnvironmentCandidates(env: NodeJS.ProcessEnv): string[] {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  return ['Community', 'Professional', 'Enterprise', 'BuildTools'].map((edition) =>
    join(
      programFiles,
      'Microsoft Visual Studio',
      '2022',
      edition,
      'Common7',
      'Tools',
      'VsDevCmd.bat'
    )
  )
}

function captureVisualStudioEnvironment(
  commandFile: string,
  baseEnv: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  return new Promise((resolveEnvironment, reject) => {
    const command = `call "${commandFile}" -arch=x64 -host_arch=x64 >nul && set`
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
      env: baseEnv,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(
          new Error(
            Buffer.concat(stderr).toString('utf8').trim() ||
              `Visual Studio environment exited with code ${String(code)}`
          )
        )
        return
      }
      const environment = { ...baseEnv }
      for (const line of Buffer.concat(stdout).toString('utf8').split(/\r?\n/)) {
        const separator = line.indexOf('=')
        if (separator > 0) {
          environment[line.slice(0, separator)] = line.slice(separator + 1)
        }
      }
      resolveEnvironment(environment)
    })
  })
}

export async function resolveCppSetupEnvironment(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  logs: string[]
): Promise<NodeJS.ProcessEnv> {
  if (platform !== 'win32' || (env.INCLUDE && env.LIB && env.VSCMD_VER)) {
    return env
  }
  for (const candidate of visualStudioEnvironmentCandidates(env)) {
    if (await isExecutable(candidate)) {
      const environment = await captureVisualStudioEnvironment(candidate, env)
      logs.push('\n## Prepare MSVC environment\nVisual Studio developer environment loaded.')
      return environment
    }
  }
  throw new Error('Visual Studio C++ developer environment was not found')
}

export function appendCppSetupLog(
  logs: string[],
  title: string,
  command: readonly string[],
  result: CppSetupCommandResult
): void {
  logs.push(
    `\n## ${title}\n$ ${command.join(' ')}\n${result.output.trim()}\nExit: ${String(result.code)}`
  )
}

export async function installCppSetupTools(args: {
  missing: readonly CppSetupToolName[]
  platform: NodeJS.Platform
  cwd: string
  run: CppSetupCommandRunner
  logs: string[]
}): Promise<string[]> {
  for (const command of packageInstallCommands(args.platform, args.missing)) {
    const [executable, ...commandArgs] = command
    const result = await args.run(executable, commandArgs, args.cwd)
    appendCppSetupLog(args.logs, 'Install dependencies', command, result)
    if (result.code !== 0) {
      throw new Error(`Dependency installation failed: ${executable}`)
    }
  }
  return [...args.missing]
}
