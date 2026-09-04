import { access, constants, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import type { Repo } from '../../shared/types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { getCppScopeIdForRepo } from '../../shared/code-intelligence-scope'
import {
  discoverCppSetupTools,
  installCppSetupTools,
  resolveCppSetupEnvironment,
  runCppSetupCommand,
  type CppSetupCommandRunner,
  type CppSetupToolPaths
} from './code-intelligence-cpp-setup-tools'
import { discoverBundledGn } from './code-intelligence-cpp-tool-provisioning'
import {
  discoverCachedWindowsGn,
  installCachedWindowsGn
} from './code-intelligence-windows-gn-installer'
import { localCppBuildRootDetection } from './code-intelligence-cmake-root-selection'
import {
  IGNORED_DIRECTORIES,
  SOURCE_EXTENSIONS
} from './code-intelligence-compilation-database'
import {
  cppScopeDirectoryPath,
  readCachedCodeIntelligenceSetupResult,
  writeCachedCodeIntelligenceSetupResult
} from './code-intelligence-setup-cache'
import type { CppSetupHost } from './code-intelligence-cpp-setup-host'

/** mtimeMs locally; a missing path folds to 0 (remote parity prints 0). */
async function modifiedAt(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return 0
  }
}

async function collectConventionalIncludeDirectories(
  root: string,
  directories: string[],
  depth = 0
): Promise<void> {
  if (depth > 4) {
    return
  }
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) {
      continue
    }
    const path = join(root, entry.name)
    if (['api', 'include', 'interface'].includes(entry.name.toLowerCase())) {
      directories.push(path)
      continue
    }
    await collectConventionalIncludeDirectories(path, directories, depth + 1)
  }
}

async function collectSourceFiles(root: string, files: string[]): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        await collectSourceFiles(path, files)
      }
      continue
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(path)
    }
  }
}

async function isReadableDirectory(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

export type LocalCppSetupHostDependencies = {
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  run?: CppSetupCommandRunner
  cacheRoot: string
}

export function createLocalCppSetupHost(
  dependencies: LocalCppSetupHostDependencies
): CppSetupHost {
  const platform = dependencies.platform ?? process.platform
  const arch = dependencies.arch ?? process.arch
  const env = dependencies.env ?? process.env
  const runCommand = dependencies.run ?? runCppSetupCommand
  const discoverAllTools = async (workspaceRoot: string): Promise<CppSetupToolPaths> => {
    const tools = await discoverCppSetupTools(platform, env)
    tools.gn ??= (await discoverBundledGn(workspaceRoot, platform)) ?? undefined
    tools.gn ??=
      (await discoverCachedWindowsGn(dependencies.cacheRoot, platform, arch)) ?? undefined
    return tools
  }
  return {
    detection: localCppBuildRootDetection,
    runCommand,
    validateRepoHost: async (repo: Repo) =>
      getRepoExecutionHostId(repo) !== 'local'
        ? 'One-click C++ setup currently requires a local Host'
        : null,
    scopeDirectoryFor: async (repo: Repo) =>
      cppScopeDirectoryPath(dependencies.cacheRoot, getCppScopeIdForRepo(repo)),
    statMtimes: async (paths) => await Promise.all(paths.map(modifiedAt)),
    readCachedResult: readCachedCodeIntelligenceSetupResult,
    discoverTools: async (_requiredTools, workspaceRoot) => await discoverAllTools(workspaceRoot),
    installTools: async (missing, workspaceRoot, logs) => {
      const installedTools: string[] = []
      let remaining = [...missing]
      if (platform === 'win32' && remaining.includes('gn')) {
        await installCachedWindowsGn({
          cacheRoot: dependencies.cacheRoot,
          platform,
          arch,
          run: runCommand,
          logs
        })
        installedTools.push('gn')
        remaining = remaining.filter((tool) => tool !== 'gn')
      }
      if (remaining.length > 0) {
        installedTools.push(
          ...(await installCppSetupTools({
            missing: remaining,
            platform,
            cwd: workspaceRoot,
            run: runCommand,
            logs
          }))
        )
      }
      return installedTools
    },
    configureEnvironment: async (cmakeRequired, logs) =>
      cmakeRequired ? await resolveCppSetupEnvironment(platform, env, logs) : env,
    ensureDirectory: async (directory) => {
      await mkdir(directory, { recursive: true })
    },
    resetBuildDirectory: async (buildDirectory) => {
      await rm(buildDirectory, { recursive: true, force: true })
      await mkdir(buildDirectory, { recursive: true })
    },
    findSourceFiles: async (root) => {
      const files: string[] = []
      await collectSourceFiles(root, files)
      return files
    },
    findIncludeDirectories: async (root) => {
      const directories: string[] = []
      await collectConventionalIncludeDirectories(root, directories)
      return directories
    },
    readableDirectories: async (candidates) => {
      const readable: string[] = []
      for (const candidate of candidates) {
        if (await isReadableDirectory(candidate)) {
          readable.push(candidate)
        }
      }
      return readable
    },
    readTextFile: (path) => readFile(path, 'utf8'),
    writeTextFile: async (directory, fileName, content) => {
      // Atomic swap: a mid-rewrite failure must never leave a torn file.
      const temporary = join(directory, `.${fileName}.tmp`)
      await writeFile(temporary, content)
      await rename(temporary, join(directory, fileName))
    },
    writeCachedResult: writeCachedCodeIntelligenceSetupResult,
    relativeGnOutput: (gnRoot, outputDirectory) =>
      relative(gnRoot, outputDirectory).replace(/\\/g, '/'),
    describeRunError: (error, logs) => {
      logs.push(
        `\n## Error\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
      )
      return error instanceof Error ? error.message : String(error)
    }
  }
}
