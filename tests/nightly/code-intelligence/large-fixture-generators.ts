import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type FixtureFile = { path: string; content: string }

/** Bounded-concurrency writer — 100k+ awaited writes in a flat loop starve the pool. */
async function writeAll(files: readonly FixtureFile[], concurrency = 64): Promise<void> {
  let cursor = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < files.length) {
        const entry = files[cursor++]
        await mkdir(dirname(entry.path), { recursive: true })
        await writeFile(entry.path, entry.content)
      }
    })
  )
}

// ---------------------------------------------------------------------------
// C++: deterministic 50k-TU tree + three generator-flavored shards.
// ---------------------------------------------------------------------------

export function cppSourcePath(root: string, index: number): string {
  return join(root, 'sources', `pkg-${index % 20}`, `mod-${index % 100}`, `tu-${index}.cpp`)
}

/** TU index whose source is deliberately heavy — a parse slow enough (≥1s)
 * that $/cancelRequest observably interrupts it mid-flight. */
export const CPP_HEAVY_TU_INDEX = 2

function isCppHeavyTu(index: number): boolean {
  return index === CPP_HEAVY_TU_INDEX
}

const HEAVY_FUNCTION_COUNT = 4_000

export function cppSourceText(index: number): string {
  if (isCppHeavyTu(index)) {
    const functions = Array.from(
      { length: HEAVY_FUNCTION_COUNT },
      (_, i) => `int heavy_${i}(int x) { return nightly_helper() + x; }`
    ).join('\n')
    return `#include "nightly-helper.h"\n\n${functions}\n\nint nightly_tu_${index}(void) {\n    return nightly_helper();\n}\n`
  }
  return `#include "nightly-helper.h"\n\nint nightly_tu_${index}(void) {\n    return nightly_helper();\n}\n`
}

const CPP_HEADER = `#ifndef NIGHTLY_HELPER_H\n#define NIGHTLY_HELPER_H\n\ninline int nightly_helper(void) {\n    return 42;\n}\n\n#endif\n`

export type CppFixture = {
  shardPaths: readonly string[]
  scopeDirectory: string
  tuCount: number
}

/** Host path → POSIX spelling, shared with the budget tests' CDB assertions. */
export function toPosixPath(value: string): string {
  return value.split('\\').join('/')
}

/**
 * Builds `tuCount` stub TUs under sources/ plus include/nightly-helper.h, and
 * three shards with deliberate overlap: cmake-style `command` (all TUs), a
 * basic-style `arguments` override (first overlapRange TUs), and a gn-style
 * re-spelling of the upper half of that range — last shard wins per #47.
 */
export async function generateCppTuFixture(
  root: string,
  options: { tuCount: number; overlapCount?: number } = { tuCount: 50_000 }
): Promise<CppFixture> {
  const { tuCount } = options
  const overlapCount = options.overlapCount ?? Math.min(1_000, tuCount)
  const files: FixtureFile[] = [
    { path: join(root, 'include', 'nightly-helper.h'), content: CPP_HEADER }
  ]
  for (let index = 0; index < tuCount; index++) {
    files.push({ path: cppSourcePath(root, index), content: cppSourceText(index) })
  }
  await writeAll(files)

  const toPosix = (value: string): string => value.split('\\').join('/')
  const directory = toPosix(root)
  const fileAt = (index: number): string => toPosix(cppSourcePath(root, index))

  const cmakeShard = Array.from({ length: tuCount }, (_, index) => ({
    directory,
    file: fileAt(index),
    command: `clang++ -std=c++17 -I${toPosix(join(root, 'include'))} -c ${fileAt(index)}`
  }))
  const basicShard = Array.from({ length: overlapCount }, (_, index) => ({
    directory,
    file: fileAt(index),
    arguments: [
      'clang++',
      '-std=c++17',
      `-I${toPosix(join(root, 'include'))}`,
      '-DBASIC_OVERRIDE',
      '-c',
      fileAt(index)
    ]
  }))
  const gnShard = Array.from(
    { length: Math.floor(overlapCount / 2) },
    (_, offset) => {
      const index = Math.floor(overlapCount / 2) + offset
      return {
        directory,
        file: fileAt(index),
        arguments: [
          'clang++',
          '-std=c++20',
          `-I${toPosix(join(root, 'include'))}`,
          '-DGN_OVERRIDE',
          '-c',
          fileAt(index)
        ]
      }
    }
  )

  const shardPaths = [
    join(root, 'shard-cmake.json'),
    join(root, 'shard-basic.json'),
    join(root, 'shard-gn.json')
  ]
  await Promise.all([
    writeFile(shardPaths[0], JSON.stringify(cmakeShard)),
    writeFile(shardPaths[1], JSON.stringify(basicShard)),
    writeFile(shardPaths[2], JSON.stringify(gnShard))
  ])
  return {
    shardPaths,
    scopeDirectory: join(root, 'scope'),
    tuCount
  }
}

/** Overlap slice where the basic shard is the surviving spelling. */
export function basicOverrideRange(tuCount: number): { from: number; to: number } {
  const overlap = Math.min(1_000, tuCount)
  return { from: 0, to: Math.floor(overlap / 2) }
}

/** Overlap slice where the gn shard re-spells and survives. */
export function gnOverrideRange(tuCount: number): { from: number; to: number } {
  const overlap = Math.min(1_000, tuCount)
  return { from: Math.floor(overlap / 2), to: overlap }
}

// ---------------------------------------------------------------------------
// Python: deterministic 100k-file monorepo.
// ---------------------------------------------------------------------------

export function pythonModulePath(root: string, index: number): string {
  return join(root, 'packages', `pkg-${index % 50}`, `module_${index}.py`)
}

export function pythonModuleText(index: number): string {
  return `def nightly_func_${index}():\n    return ${index}\n`
}

export async function generatePythonMonorepoFixture(
  root: string,
  fileCount = 100_000
): Promise<{ fileCount: number }> {
  const files: FixtureFile[] = Array.from({ length: fileCount }, (_, index) => ({
    path: pythonModulePath(root, index),
    content: pythonModuleText(index)
  }))
  await writeAll(files)
  return { fileCount }
}

// ---------------------------------------------------------------------------
// Dependent repositories, multi-scope layout: repo A exposes include/a-lib.h;
// repo B's TUs depend on it. Two member shards merge into one scope CDB.
// ---------------------------------------------------------------------------

const DEPENDENT_REPO_A_HEADERS = 3
const DEPENDENT_REPO_B_TUS = 4

export type DependentRepoFixture = {
  repoAIncludeDir: string
  repoBIncludeFlag: string
  shardPaths: readonly string[]
  expectedTus: number
}

export async function generateDependentCppScopesFixture(
  root: string
): Promise<DependentRepoFixture> {
  const repoAIncludeDir = join(root, 'repo-a', 'include')
  const repoBRoot = join(root, 'repo-b')
  const files: FixtureFile[] = Array.from({ length: DEPENDENT_REPO_A_HEADERS }, (_, index) => ({
    path: join(repoAIncludeDir, `a-lib-${index}.h`),
    content: `inline int a_lib_${index}(void) { return ${index}; }\n`
  }))
  for (let index = 0; index < DEPENDENT_REPO_B_TUS; index++) {
    files.push({
      path: join(repoBRoot, 'src', `app-${index}.cpp`),
      content: `#include "a-lib-${index % DEPENDENT_REPO_A_HEADERS}.h"\n\nint app_${index}(void) { return a_lib_${index % DEPENDENT_REPO_A_HEADERS}(); }\n`
    })
  }
  await writeAll(files)

  const repoBIncludeFlag = `-I${toPosixPath(repoAIncludeDir)}`
  const scopeDir = join(root, 'scope')
  await mkdir(scopeDir, { recursive: true })
  const shardPaths = [join(scopeDir, 'shard-repo-a.json'), join(scopeDir, 'shard-repo-b.json')]
  // Repo A contributes headers only — an empty shard plus its include path
  // (#47: a member without sources still feeds every other member's commands).
  await writeFile(shardPaths[0], JSON.stringify([]))
  await writeFile(
    shardPaths[1],
    JSON.stringify(
      Array.from({ length: DEPENDENT_REPO_B_TUS }, (_, index) => ({
        directory: toPosixPath(repoBRoot),
        file: toPosixPath(join(repoBRoot, 'src', `app-${index}.cpp`)),
        arguments: ['clang++', '-std=c++17', repoBIncludeFlag, '-c', toPosixPath(join(repoBRoot, 'src', `app-${index}.cpp`))]
      }))
    )
  )
  return { repoAIncludeDir, repoBIncludeFlag, shardPaths, expectedTus: DEPENDENT_REPO_B_TUS }
}
