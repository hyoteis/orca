import { describe, expect, it } from 'vitest'
import { posix } from 'node:path'
import type { AggregateCdbEntry } from './code-intelligence-aggregate-cdb'
import {
  aggregateMappingId,
  buildAggregateCompileDatabase,
  hasInFolderCommand,
  isValidSuppliedCdbShape,
  mergeAggregateEntries,
  normalizeSuppliedCdbEntries,
  parseSuppliedCdbText,
  type AggregateCdbHost
} from './code-intelligence-aggregate-cdb'

const posixDetection = {
  resolve: posix.resolve,
  isAbsolute: posix.isAbsolute
}

function createHost(files: Record<string, string> = {}): AggregateCdbHost & {
  files: Map<string, string>
  writes: { directory: string; fileName: string; content: string }[]
} {
  const map = new Map(Object.entries(files))
  return {
    files: map,
    writes: [],
    detection: posixDetection,
    readTextFile: async (path) => {
      const text = map.get(path)
      if (text === undefined) {
        throw new Error(`ENOENT: ${path}`)
      }
      return text
    },
    writeTextFile: async (directory, fileName, content) => {
      map.set(`${directory}/${fileName}`, content)
      void directory
    },
    findSourceFiles: async (root) =>
      [...map.keys()].filter((path) => path.startsWith(`${root}/`)).filter((path) => path.endsWith('.cpp')),
    findIncludeDirectories: async () => [],
    readableDirectories: async (candidates) => candidates,
    ensureDirectory: async () => {}
  } as unknown as AggregateCdbHost & { files: Map<string, string>; writes: { directory: string; fileName: string; content: string }[] }
}

const entry = (file: string, overrides: Partial<AggregateCdbEntry> = {}): AggregateCdbEntry => ({
  directory: posix.dirname(file),
  file,
  arguments: ['clang++', '-c', file],
  ...overrides
})

describe('supplied database validation', () => {
  it('distinguishes not-found, invalid-json, invalid-shape, and no-in-folder-commands', async () => {
    const cases: { files: Record<string, string>; expected: string }[] = [
      { files: {}, expected: 'not readable' },
      { files: { '/cdb/a.json': 'not json' }, expected: 'not valid JSON' },
      { files: { '/cdb/a.json': '{"entries": []}' }, expected: 'shape' },
      {
        files: { '/cdb/a.json': JSON.stringify([entry('/elsewhere/main.cpp')]) },
        expected: 'no commands inside its mapped folder'
      }
    ]
    for (const { files, expected } of cases) {
      const host = createHost(files)
      await expect(
        buildAggregateCompileDatabase({
          host,
          workspaceRoot: '/ws',
          members: [{ path: 'engine', visibleResults: true, compileDatabase: '/cdb/a.json' }],
          scopeDirectory: '/cache/scope',
          initial: true
        })
      ).rejects.toThrow(expected)
    }
  })

  it('runs the in-folder-command check at initial validation only', async () => {
    const files = { '/cdb/a.json': JSON.stringify([entry('/elsewhere/main.cpp')]) }
    // Initial build rejects…
    await expect(
      buildAggregateCompileDatabase({
        host: createHost(files),
        workspaceRoot: '/ws',
        members: [{ path: 'engine', visibleResults: true, compileDatabase: '/cdb/a.json' }],
        scopeDirectory: '/cache/scope',
        initial: true
      })
    ).rejects.toThrow('mapped folder')
    // …a later re-merge of the same readable database no longer blocks on it:
    // entries merge and the mapping only warns (#136).
    const result = await buildAggregateCompileDatabase({
      host: createHost(files),
      workspaceRoot: '/ws',
      members: [{ path: 'engine', visibleResults: true, compileDatabase: '/cdb/a.json' }],
      scopeDirectory: '/cache/scope',
      initial: false
    })
    expect(result).toMatchObject({ entryCount: 1 })
    expect(result.mappings[0]).toMatchObject({
      state: 'warning',
      failure: 'no-in-folder-commands'
    })
  })

  it('accepts a database whose commands cover the mapped folder', () => {
    const normalized = normalizeSuppliedCdbEntries(
      [entry('/ws/engine/main.cpp'), entry('/ws/engine/sub/util.cpp')],
      posixDetection
    )
    expect(hasInFolderCommand(normalized, '/ws', 'engine')).toBe(true)
    expect(hasInFolderCommand(normalized, '/ws', 'tools')).toBe(false)
  })
})

describe('entry normalization', () => {
  it('drops unknown keys, keeps arguments/command verbatim, and resolves relative files', () => {
    const raw = [
      {
        directory: '/ws/build',
        file: '../src/main.cpp',
        arguments: ['clang++', '-D_FLAG=x', '-c', '../src/main.cpp'],
        output: '/ws/build/main.o',
        unknownExtra: { nested: true }
      },
      {
        directory: '/ws',
        file: '/ws/lib.cpp',
        command: 'ccache clang++ -c /ws/lib.cpp'
      }
    ]
    expect(normalizeSuppliedCdbEntries(raw, posixDetection)).toEqual([
      {
        directory: '/ws/build',
        file: '/ws/src/main.cpp',
        arguments: ['clang++', '-D_FLAG=x', '-c', '../src/main.cpp']
      },
      {
        directory: '/ws',
        file: '/ws/lib.cpp',
        command: 'ccache clang++ -c /ws/lib.cpp'
      }
    ])
  })

  it('shape-gates malformed entries', () => {
    expect(isValidSuppliedCdbShape(parseSuppliedCdbText('[]'))).toBe(true)
    expect(isValidSuppliedCdbShape(parseSuppliedCdbText('[{"file": "a.cpp"}]'))).toBe(false)
    expect(isValidSuppliedCdbShape(parseSuppliedCdbText('{"directory": "."}'))).toBe(false)
    expect(isValidSuppliedCdbShape(null)).toBe(false)
  })
})

describe('aggregate merge', () => {
  it('resolves duplicate TUs first-wins by scope.members order', () => {
    const first = [entry('/ws/engine/main.cpp', { arguments: ['winner'] })]
    const second = [entry('/ws/engine/main.cpp', { arguments: ['loser'] }), entry('/ws/tools/gen.cpp')]
    const merged = mergeAggregateEntries([first, second])
    expect(merged).toHaveLength(2)
    expect(merged.find((candidate) => candidate.file === '/ws/engine/main.cpp')?.arguments).toEqual(['winner'])
  })

  it('keeps the aggregate bytes stable (golden)', () => {
    const shards = [
      [entry('/ws/b/second.cpp'), entry('/ws/a/first.cpp')],
      [entry('/ws/a/first.cpp', { command: 'duplicate spelling' })]
    ]
    const merged = mergeAggregateEntries(shards)
    expect(JSON.stringify(merged, null, 2)).toBe(
      JSON.stringify([entry('/ws/a/first.cpp'), entry('/ws/b/second.cpp')], null, 2)
    )
    // Identical inputs → identical bytes on a second pass.
    expect(JSON.stringify(mergeAggregateEntries(shards), null, 2)).toBe(JSON.stringify(merged, null, 2))
  })
})

describe('buildAggregateCompileDatabase', () => {
  it('writes one aggregate plus per-mapping snapshots and synthesizes BASIC entries', async () => {
    const host = createHost({
      '/cdb/one.json': JSON.stringify([entry('/ws/one/main.cpp'), entry('/external/ext.cpp')]),
      '/ws/basic/util.cpp': 'int f() {}'
    })
    const result = await buildAggregateCompileDatabase({
      host,
      workspaceRoot: '/ws',
      members: [
        { path: 'one', visibleResults: true, compileDatabase: '/cdb/one.json' },
        { path: 'basic', visibleResults: true }
      ],
      basicOptions: { includeDirectories: ['/opt/sdk/include'], defines: ['USE_GPU=1'] },
      scopeDirectory: '/cache/scope',
      initial: true
    })
    expect(result).toMatchObject({ entryCount: 3, basicEntryCount: 1 })
    expect(result.mappings).toHaveLength(1)
    const aggregate = JSON.parse(host.files.get('/cache/scope/compile_commands.json')!) as {
      file: string
      arguments?: string[]
    }[]
    expect(aggregate.map((row) => row.file).sort()).toEqual([
      '/external/ext.cpp',
      '/ws/basic/util.cpp',
      '/ws/one/main.cpp'
    ])
    const basic = aggregate.find((row) => row.file === '/ws/basic/util.cpp')
    expect(basic?.arguments).toEqual([
      'clang++',
      '-std=c++17',
      '-DUSE_GPU=1',
      '-I/ws',
      '-I/opt/sdk/include',
      '-c',
      '/ws/basic/util.cpp'
    ])
    // Snapshot holds the mapping's normalized entries under its stable id.
    const snapshotId = aggregateMappingId('one', '/cdb/one.json')
    expect(JSON.parse(host.files.get(`/cache/scope/mappings/${snapshotId}.json`)!)).toHaveLength(2)
    const manifest = JSON.parse(host.files.get('/cache/scope/aggregate-manifest.json')!) as {
      mappings: { memberPath: string; degraded: boolean; entryCount: number }[]
    }
    expect(manifest.mappings).toMatchObject([
      { memberPath: 'one', state: 'ok', entryCount: 2 }
    ])
  })

  it('degrades one unreadable mapping independently while others stay intact', async () => {
    const host = createHost({
      '/cdb/one.json': JSON.stringify([entry('/ws/one/main.cpp')]),
      '/cdb/two.json': JSON.stringify([entry('/ws/two/gen.cpp')])
    })
    const members = [
      { path: 'one', visibleResults: true, compileDatabase: '/cdb/one.json' },
      { path: 'two', visibleResults: true, compileDatabase: '/cdb/two.json' }
    ] as const
    await buildAggregateCompileDatabase({
      host,
      workspaceRoot: '/ws',
      members: [...members],
      scopeDirectory: '/cache/scope',
      initial: true
    })
    // The mount for mapping two disappears; its last-valid snapshot survives.
    host.files.delete('/cdb/two.json')
    const degraded = await buildAggregateCompileDatabase({
      host,
      workspaceRoot: '/ws',
      members: [...members],
      scopeDirectory: '/cache/scope',
      initial: false
    })
    expect(degraded.mappings).toMatchObject([
      { memberPath: 'one', state: 'ok', entryCount: 1 },
      { memberPath: 'two', state: 'degraded', failure: 'not-found', entryCount: 1 }
    ])
    const aggregate = JSON.parse(host.files.get('/cache/scope/compile_commands.json')!) as { file: string }[]
    expect(aggregate.map((row) => row.file).sort()).toEqual(['/ws/one/main.cpp', '/ws/two/gen.cpp'])
  })
})

describe('degradation semantics (#136 spec §2 Step 4)', () => {
  const members = [
    { path: 'one', visibleResults: true, compileDatabase: '/cdb/one.json' }
  ]

  it('warns on readable-but-corrupt content while the snapshot keeps working', async () => {
    const host = createHost({
      '/cdb/one.json': JSON.stringify([entry('/ws/one/main.cpp')])
    })
    await buildAggregateCompileDatabase({
      host, workspaceRoot: '/ws', members, scopeDirectory: '/cache/scope', initial: true
    })
    // The file stays readable but its content rots.
    host.files.set('/cdb/one.json', '}{ not json')
    const rebuilt = await buildAggregateCompileDatabase({
      host, workspaceRoot: '/ws', members, scopeDirectory: '/cache/scope', initial: false
    })
    expect(rebuilt.mappings[0]).toMatchObject({
      state: 'warning',
      failure: 'invalid-json',
      entryCount: 1
    })
    const aggregate = JSON.parse(host.files.get('/cache/scope/compile_commands.json')!) as { file: string }[]
    expect(aggregate.map((row) => row.file)).toEqual(['/ws/one/main.cpp'])
  })

  it('auto-heals back to ok when the database recovers', async () => {
    const host = createHost({
      '/cdb/one.json': JSON.stringify([entry('/ws/one/main.cpp')])
    })
    await buildAggregateCompileDatabase({
      host, workspaceRoot: '/ws', members, scopeDirectory: '/cache/scope', initial: true
    })
    host.files.delete('/cdb/one.json')
    const degraded = await buildAggregateCompileDatabase({
      host, workspaceRoot: '/ws', members, scopeDirectory: '/cache/scope', initial: false
    })
    expect(degraded.mappings[0]).toMatchObject({ state: 'degraded', failure: 'not-found' })
    // The mount returns — the refresh chain rebuilds and health returns to ok.
    host.files.set('/cdb/one.json', JSON.stringify([entry('/ws/one/main.cpp')]))
    const healed = await buildAggregateCompileDatabase({
      host, workspaceRoot: '/ws', members, scopeDirectory: '/cache/scope', initial: false
    })
    expect(healed.mappings[0]).toMatchObject({ state: 'ok' })
    expect('failure' in healed.mappings[0]).toBe(false)
  })
})
