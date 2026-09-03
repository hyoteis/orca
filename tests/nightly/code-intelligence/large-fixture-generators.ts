import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'

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

export function isCppHeavyTu(index: number): boolean {
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
  /** POSIX-style entry (arguments form) for canonical TUs. */
  argumentsEntry: (index: number) => Record<string, unknown>
  shardPaths: readonly string[]
  scopeDirectory: string
  tuCount: number
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
    argumentsEntry: (index) => ({
      directory,
      file: fileAt(index),
      arguments: ['clang++', '-std=c++17', '-c', fileAt(index)]
    }),
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

/** Human-visible spec of the fixture for report rows (POSIX separators). */
export function posixPathOf(value: string): string {
  return posix.normalize(value.split('\\').join('/'))
}
