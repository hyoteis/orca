import { extname } from 'node:path'

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
