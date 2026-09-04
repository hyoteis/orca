import { extname } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

export const SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.m', '.mm'])
export const IGNORED_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'build', 'node_modules', 'out'])
export const MAX_SOURCE_FILES = 50_000

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
