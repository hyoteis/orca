import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { extname, isAbsolute, join, resolve } from 'node:path'

const SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.m', '.mm'])
const IGNORED_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'build', 'node_modules', 'out'])
const MAX_SOURCE_FILES = 50_000

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

function compilerArguments(
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
  outputDirectory: string
  additionalIncludeDirectories?: readonly string[]
  defines?: readonly string[]
  cppStandard?: 'c++17' | 'c++20' | 'c++23'
}): Promise<{ filePath: string; sourceFileCount: number }> {
  const files: string[] = []
  for (const root of args.sourceRoots) {
    await collectSourceFiles(root, files)
  }
  if (files.length === 0) {
    throw new Error('No C or C++ source files were found in the selected folders')
  }
  const discoveredIncludes: string[] = []
  await collectConventionalIncludeDirectories(args.workspaceRoot, discoveredIncludes)
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

export async function mergeCompilationDatabases(
  files: readonly string[],
  destination: string
): Promise<number> {
  const entries: unknown[] = []
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (!Array.isArray(parsed)) {
      throw new Error('Build setup produced an invalid compile_commands.json')
    }
    entries.push(...parsed)
  }
  // Atomic swap: a mid-rewrite failure must never leave a torn merged CDB.
  const destinationPath = join(destination, 'compile_commands.json')
  const temporaryPath = join(destination, '.compile_commands.json.tmp')
  await writeFile(temporaryPath, JSON.stringify(entries, null, 2))
  await rename(temporaryPath, destinationPath)
  return entries.length
}
