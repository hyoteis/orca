import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

export const SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.m', '.mm'])
export const IGNORED_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'build', 'node_modules', 'out'])
export const MAX_SOURCE_FILES = 50_000

async function isReadableDirectory(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
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
      if (files.length > MAX_SOURCE_FILES) {
        throw new Error(`Basic C++ indexing exceeds ${MAX_SOURCE_FILES} source files`)
      }
    }
  }
}

export function compilerArguments(
  file: string,
  includeDirectories: readonly string[],
  defines: readonly string[],
  cppStandard: 'c++17' | 'c++20' | 'c++23'
): string[] {
  const extension = extname(file).toLowerCase()
  const isC = extension === '.c' || extension === '.m'
  return [
    isC ? 'clang' : 'clang++',
    isC ? '-std=c11' : `-std=${cppStandard}`,
    ...defines.map((define) => `-D${define}`),
    ...includeDirectories.map((directory) => `-I${directory}`),
    '-c',
    file
  ]
}

export async function createBasicCompilationDatabase(args: {
  workspaceRoot: string
  sourceRoots: readonly string[]
  /** Every member root — include discovery runs once per root and merges globally. */
  includeDiscoveryRoots?: readonly string[]
  outputDirectory: string
  additionalIncludeDirectories?: readonly string[]
  defines?: readonly string[]
  cppStandard?: 'c++17' | 'c++20' | 'c++23'
}): Promise<{ filePath: string; sourceFileCount: number }> {
  const files: string[] = []
  for (const root of args.sourceRoots) {
    await collectSourceFiles(root, files)
  }
  const discoveredIncludes: string[] = []
  for (const root of new Set([args.workspaceRoot, ...(args.includeDiscoveryRoots ?? [])])) {
    await collectConventionalIncludeDirectories(root, discoveredIncludes)
  }
  const additionalIncludes = (args.additionalIncludeDirectories ?? []).map((path) =>
    isAbsolute(path) ? resolve(path) : resolve(args.workspaceRoot, path)
  )
  const includeCandidates = [
    args.workspaceRoot,
    ...additionalIncludes,
    ...discoveredIncludes,
    ...args.sourceRoots.flatMap((root) => [
      root,
      join(root, 'api'),
      join(root, 'include'),
      join(root, 'src')
    ])
  ]
  const includeDirectories: string[] = []
  for (const candidate of new Set(includeCandidates)) {
    if (await isReadableDirectory(candidate)) {
      includeDirectories.push(candidate)
    }
  }
  // A member without sources contributes an empty shard; its discovered include
  // directories still feed every other member's commands.
  const database = files.map((file) => ({
    directory: args.workspaceRoot,
    file,
    arguments: compilerArguments(
      file,
      includeDirectories,
      (args.defines ?? []).map((define) => define.trim()).filter(Boolean),
      args.cppStandard ?? 'c++17'
    )
  }))
  await mkdir(args.outputDirectory, { recursive: true })
  const filePath = join(args.outputDirectory, 'compile_commands.json')
  await writeFile(filePath, JSON.stringify(database, null, 2))
  return { filePath, sourceFileCount: files.length }
}

function compileCommandFile(entry: unknown): string | undefined {
  const file = (entry as { file?: unknown } | null)?.file
  return typeof file === 'string' ? file : undefined
}

/** Single-source merge/dedupe for CDB shards (local and SSH setups alike). */
export function mergeCompilationDatabaseShards(shards: readonly unknown[][]): unknown[] {
  const entries: unknown[] = []
  const indexByFile = new Map<string, number>()
  for (const parsed of shards) {
    if (!Array.isArray(parsed)) {
      throw new Error('Build setup produced an invalid compile_commands.json')
    }
    for (const entry of parsed) {
      // Nested/overlapping members can cover the same TU; one canonical entry
      // survives and the last shard's spelling wins. Generators spell `file`
      // differently (cmake forward slashes, basic native joins), so the key
      // folds separators and case per path flavor.
      const sourceFile = compileCommandFile(entry)
      const key =
        sourceFile === undefined ? undefined : normalizeRuntimePathForComparison(sourceFile)
      const existingIndex = key === undefined ? undefined : indexByFile.get(key)
      if (existingIndex === undefined) {
        if (key !== undefined) {
          indexByFile.set(key, entries.length)
        }
        entries.push(entry)
        continue
      }
      entries[existingIndex] = entry
    }
  }
  return entries
}

export async function mergeCompilationDatabases(
  files: readonly string[],
  destination: string
): Promise<number> {
  const shards: unknown[][] = []
  for (const file of files) {
    shards.push(JSON.parse(await readFile(file, 'utf8')))
  }
  const entries = mergeCompilationDatabaseShards(shards)
  if (entries.length === 0) {
    // An empty merged CDB is never a valid artifact (setup fails all-zero);
    // keep the previous merged file intact for the still-live scope.
    return 0
  }
  // Atomic swap: a mid-rewrite failure must never leave a torn merged CDB.
  const destinationPath = join(destination, 'compile_commands.json')
  const temporaryPath = join(destination, '.compile_commands.json.tmp')
  await writeFile(temporaryPath, JSON.stringify(entries, null, 2))
  await rename(temporaryPath, destinationPath)
  return entries.length
}
