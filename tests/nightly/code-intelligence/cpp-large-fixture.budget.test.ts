import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { afterAll, describe, expect, it } from 'vitest'
import { mergeCompilationDatabaseShards } from '../../../src/main/language-server/code-intelligence-compilation-database'
import { codeIntelligenceSetupFingerprintDigest } from '../../../src/main/language-server/code-intelligence-setup-cache'
import {
  CPP_HEAVY_TU_INDEX,
  basicOverrideRange,
  cppSourcePath,
  cppSourceText,
  generateCppTuFixture,
  generateDependentCppScopesFixture,
  gnOverrideRange,
  toPosixPath,
  type CppFixture
} from './large-fixture-generators'
import { NightlyLspClient, resolveNightlyServerCommand } from './lsp-roundtrip'
import { budgetRow, infoRow, installNightlyReportWriter, median } from './nightly-report'

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

function requireFixture(): CppFixture {
  if (!fixture) {
    throw new Error('fixture generation must run before clangd budgets')
  }
  return fixture
}

describe('50k-TU setup pipeline budget', () => {
  it('fingerprints, merges, dedupes, and writes three shards inside budget', async () => {
    const generatedAt = performance.now()
    fixture = await generateCppTuFixture(root, { tuCount: TU_COUNT })
    infoRow('cpp fixture generation (TUs)', TU_COUNT, 'count')
    infoRow('cpp fixture generation wall time', performance.now() - generatedAt)

    const startedAt = performance.now()
    const fingerprint = codeIntelligenceSetupFingerprintDigest({
      repoId: 'nightly-cpp',
      roots: ['.'],
      request: { repoId: 'nightly-cpp', relativeRoots: ['.'], installMissingTools: false },
      buildInputs: []
    })
    const shards = await Promise.all(
      fixture.shardPaths.map(async (path) => JSON.parse(await readFile(path, 'utf8')))
    )
    const merged = mergeCompilationDatabaseShards(shards)
    expect(merged).toHaveLength(TU_COUNT)
    // The canonical artifact the clangd budgets spawn against — inside the
    // budgeted window: the pipeline cost includes writing it.
    await mkdir(fixture.scopeDirectory, { recursive: true })
    await writeFile(join(fixture.scopeDirectory, 'compile_commands.json'), JSON.stringify(merged))
    budgetRow('cpp 50k-TU fingerprint+merge+write pipeline', performance.now() - startedAt, 30_000)

    // Last shard wins (#47): basic flags survive the low overlap half, gn the high half.
    const byFile = new Map(
      merged.map((entry) => [toPosixPath((entry as { file: string }).file), entry])
    )
    const basicWinner = byFile.get(toPosixPath(cppSourcePath(root, basicOverrideRange(TU_COUNT).from)))
    expect((basicWinner as { arguments?: string[] })?.arguments).toContain('-DBASIC_OVERRIDE')
    const gnWinner = byFile.get(toPosixPath(cppSourcePath(root, gnOverrideRange(TU_COUNT).from)))
    expect((gnWinner as { arguments?: string[] })?.arguments).toContain('-DGN_OVERRIDE')
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('merges dependent repositories into one multi-member scope CDB', async () => {
    const dependent = await generateDependentCppScopesFixture(join(root, 'dependent'))
    const shards = await Promise.all(
      dependent.shardPaths.map(async (path) => JSON.parse(await readFile(path, 'utf8')))
    )
    const merged = mergeCompilationDatabaseShards(shards)
    expect(merged).toHaveLength(dependent.expectedTus)
    // Every repo-B command carries repo-A's include path — the cross-repo
    // dependency survives the merge (empty repo-A shard, #47).
    for (const entry of merged) {
      expect((entry as { arguments?: string[] }).arguments).toContain(dependent.repoBIncludeFlag)
    }
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
    const active = requireFixture()
    const samples: number[] = []
    for (let attempt = 0; attempt < 5; attempt++) {
      const client = new NightlyLspClient({
        executable: clangdExecutable,
        args: clangdArgs(active.scopeDirectory)
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
    const active = requireFixture()
    const client = new NightlyLspClient({
      executable: clangdExecutable,
      args: clangdArgs(active.scopeDirectory)
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
    const active = requireFixture()
    const client = new NightlyLspClient({
      executable: clangdExecutable,
      args: clangdArgs(active.scopeDirectory)
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
