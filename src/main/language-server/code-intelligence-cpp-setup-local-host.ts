import { access, constants, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { Repo } from '../../shared/types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { getCppScopeIdForRepo } from '../../shared/code-intelligence-scope'
import {
  IGNORED_DIRECTORIES,
  SOURCE_EXTENSIONS
} from './code-intelligence-compilation-database'
import { cppScopeDirectoryPath } from './code-intelligence-setup-cache'
import {
  localCppSetupPathDetection,
  type CppSetupHost
} from './code-intelligence-cpp-setup-host'

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
  cacheRoot: string
}

export function createLocalCppSetupHost(
  dependencies: LocalCppSetupHostDependencies
): CppSetupHost {
  return {
    detection: localCppSetupPathDetection,
    validateRepoHost: async (repo: Repo) =>
      getRepoExecutionHostId(repo) !== 'local'
        ? 'C++ code intelligence currently requires a local Host'
        : null,
    scopeDirectoryFor: async (repo: Repo) =>
      cppScopeDirectoryPath(dependencies.cacheRoot, getCppScopeIdForRepo(repo)),
    statMtimes: async (paths) => await Promise.all(paths.map(modifiedAt)),
    ensureDirectory: async (directory) => {
      await mkdir(directory, { recursive: true })
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
    }
  }
}
