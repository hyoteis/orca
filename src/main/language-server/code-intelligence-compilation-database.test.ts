import { describe, expect, it } from 'vitest'
import { mergeCompilationDatabaseShards } from './code-intelligence-compilation-database'

describe('mergeCompilationDatabaseShards', () => {
  it('dedupes by file key, keeping the last shard spelling (nested members)', () => {
    const first = [
      { directory: '/w', file: '/w/module/src/main.cpp', arguments: ['clang++', '-c'] },
      { directory: '/w', file: '/w/other.cpp', arguments: ['clang++', '-c'] }
    ]
    const second = [
      { directory: '/w', file: '/w/module/src/main.cpp', arguments: ['clang++', '-c', '-DSECOND'] }
    ]

    const merged = mergeCompilationDatabaseShards([first, second])

    // Replacement keeps the first occurrence's position, last shard's spelling.
    expect(merged).toEqual([
      { directory: '/w', file: '/w/module/src/main.cpp', arguments: ['clang++', '-c', '-DSECOND'] },
      { directory: '/w', file: '/w/other.cpp', arguments: ['clang++', '-c'] }
    ])
  })

  it('folds POSIX duplicate separators when keying files (case stays significant)', () => {
    const merged = mergeCompilationDatabaseShards([
      [{ file: '/w/module//src/main.cpp', arguments: [] }],
      [{ file: '/w/module/src/main.cpp', arguments: ['-DSECOND'] }],
      [{ file: '/w/module/src/Main.CPP', arguments: [] }]
    ])
    expect(merged).toEqual([
      { file: '/w/module/src/main.cpp', arguments: ['-DSECOND'] },
      { file: '/w/module/src/Main.CPP', arguments: [] }
    ])
  })

  it('rejects a shard that is not an array', () => {
    expect(() => mergeCompilationDatabaseShards([[{ file: '/w/a.cpp' }], {} as never])).toThrow(
      'Build setup produced an invalid compile_commands.json'
    )
  })
})
