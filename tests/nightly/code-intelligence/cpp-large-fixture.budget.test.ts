import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { afterAll, describe, expect, it } from 'vitest'
import { mergeCompilationDatabaseShards } from '../../../src/main/language-server/code-intelligence-compilation-database'
import {
  CPP_HEAVY_TU_INDEX,
  basicOverrideRange,
  cppSourcePath,
  cppSourceText,
  generateCppTuFixture,
  gnOverrideRange,
  type CppFixture
} from './large-fixture-generators'
import { NightlyLspClient, resolveNightlyServerCommand } from './lsp-roundtrip'
import { budgetRow, infoRow, installNightlyReportWriter } from './nightly-report'

const TU_COUNT = Number(process.env.ORCA_NIGHTLY_CPP_TUS ?? '50000')
const clangdExecutable = resolveNightlyServerCommand('clangd', process.env)
const clangdAvailable = (() => {
  try {
    return spawnSync(clangdExecutable, ['--version'], { timeout: 10_000 }).status === 0
  } catch {
    return false
  }
})()

const root = mkdtempSync(join(tmpdir(), 'orca-nightly-cpp-'))
let fixture: CppFixture | null = null

installNightlyReportWriter()
afterAll(() => rmSync(root, { recursive: true, force: true }))

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const toPosix = (value: string): string => value.split('\\').join('/')

describe('50k-TU setup pipeline budget', () => {
  it('merges and dedupes three shards inside budget', async () => {
    const generatedAt = performance.now()
    fixture = await generateCppTuFixture(root, { tuCount: TU_COUNT })
    infoRow('cpp fixture generation (TUs)', TU_COUNT, 'count')
    infoRow('cpp fixture generation wall time', performance.now() - generatedAt)

    const startedAt = performance.now()
    const shards = await Promise.all(
      fixture.shardPaths.map(async (path) => JSON.parse(await readFile(path, 'utf8')))
    )
    const merged = mergeCompilationDatabaseShards(shards)
    const pipelineMs = performance.now() - startedAt
    expect(merged).toHaveLength(TU_COUNT)
    budgetRow('cpp 50k-TU merge pipeline', pipelineMs, 30_000)

    // Last shard wins (#47): basic flags survive the low overlap half, gn the high half.
    const byFile = new Map(
      merged.map((entry) => [toPosix((entry as { file: string }).file), entry])
    )
    const basicWinner = byFile.get(toPosix(cppSourcePath(root, basicOverrideRange(TU_COUNT).from)))
    expect((basicWinner as { arguments?: string[] })?.arguments).toContain('-DBASIC_OVERRIDE')
    const gnWinner = byFile.get(toPosix(cppSourcePath(root, gnOverrideRange(TU_COUNT).from)))
    expect((gnWinner as { arguments?: string[] })?.arguments).toContain('-DGN_OVERRIDE')

    // The canonical artifact the clangd budgets spawn against.
    await mkdir(fixture.scopeDirectory, { recursive: true })
    await writeFile(join(fixture.scopeDirectory, 'compile_commands.json'), JSON.stringify(merged))
  })
})

describe.skipIf(!clangdAvailable)('clangd budgets on the 50k-TU database', () => {
  const clangdArgs = (scopeDirectory: string): string[] => [
    // Background indexing stays off: these budgets isolate preamble + CDB
    // lookup cost, not the (separately covered) background index build.
    '--background-index=false',
    `--compile-commands-dir=${scopeDirectory}`
  ]

  it('keeps the initialize→ready startup median inside budget', async () => {
    if (!fixture) {
      throw new Error('fixture generation must run before clangd budgets')
    }
    const samples: number[] = []
    for (let attempt = 0; attempt < 5; attempt++) {
      const client = new NightlyLspClient({
        executable: clangdExecutable,
        args: clangdArgs(fixture.scopeDirectory)
      })
      const startedAt = performance.now()
      await client.initialize(pathToFileURL(root).toString())
      samples.push(performance.now() - startedAt)
      await client.dispose()
    }
    budgetRow('clangd initialize→ready startup median (5 runs)', median(samples), 5_000)
    infoRow('clangd startup worst run', Math.max(...samples))
  })

  it('serves the first hover after a cold didOpen inside budget', async () => {
    if (!fixture) {
      throw new Error('fixture generation must run before clangd budgets')
    }
    const client = new NightlyLspClient({
      executable: clangdExecutable,
      args: clangdArgs(fixture.scopeDirectory)
    })
    try {
      await client.initialize(pathToFileURL(root).toString())
      const uri = pathToFileURL(cppSourcePath(root, 0)).toString()
      client.notification('textDocument/didOpen', {
        textDocument: { uri, languageId: 'cpp', version: 1, text: cppSourceText(0) }
      })
      const startedAt = performance.now()
      const hover = (await client.request('textDocument/hover', {
        textDocument: { uri },
        // Line 3 is `    return nightly_helper();` — index 11 lands on the call.
        position: { line: 3, character: 11 }
      })) as { contents?: unknown } | null
      expect(hover?.contents).toBeDefined()
      budgetRow(
        'clangd first hover after cold didOpen (50k CDB)',
        performance.now() - startedAt,
        20_000
      )
    } finally {
      budgetRow('clangd teardown exit', await client.dispose(), 2_000)
    }
  })

  it('answers $/cancelRequest round trips inside budget', async () => {
    if (!fixture) {
      throw new Error('fixture generation must run before clangd budgets')
    }
    const client = new NightlyLspClient({
      executable: clangdExecutable,
      args: clangdArgs(fixture.scopeDirectory)
    })
    try {
      await client.initialize(pathToFileURL(root).toString())
      // The heavy TU's parse is slow enough that the cancel lands mid-flight;
      // clangd must answer it as RequestCancelled, not complete the request.
      const uri = pathToFileURL(cppSourcePath(root, CPP_HEAVY_TU_INDEX)).toString()
      const roundTrips: number[] = []
      for (let attempt = 0; attempt < 5; attempt++) {
        const pending = client.request('textDocument/hover', {
          textDocument: { uri },
          position: { line: 2, character: 22 }
        })
        client.cancel(pending.id)
        const rejection = (await pending.catch(
          (error: { roundTripMs?: number; code?: number }) => error
        )) as { roundTripMs?: number; code?: number }
        expect(rejection.code).toBe(-32800)
        roundTrips.push(rejection.roundTripMs ?? Number.POSITIVE_INFINITY)
      }
      budgetRow('clangd cancel→response median (5 requests)', median(roundTrips), 250)
    } finally {
      await client.dispose()
    }
  })
})
