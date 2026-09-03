import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { afterAll, describe, expect, it } from 'vitest'
import {
  generatePythonMonorepoFixture,
  pythonModulePath,
  pythonModuleText
} from './large-fixture-generators'
import { NightlyLspClient, resolveNightlyServerCommand } from './lsp-roundtrip'
import { budgetRow, infoRow, installNightlyReportWriter } from './nightly-report'

const FILE_COUNT = Number(process.env.ORCA_NIGHTLY_PY_FILES ?? '100000')
const pyrightExecutable = resolveNightlyServerCommand('basedpyright-langserver', process.env)
const pyrightAvailable = (() => {
  try {
    return spawnSync(pyrightExecutable, ['--version'], { timeout: 15_000 }).status === 0
  } catch {
    return false
  }
})()

const root = mkdtempSync(join(tmpdir(), 'orca-nightly-py-'))

installNightlyReportWriter()
afterAll(() => rmSync(root, { recursive: true, force: true }))

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

describe('100k-file Python monorepo generation', () => {
  it('writes the deterministic tree', async () => {
    const startedAt = performance.now()
    await generatePythonMonorepoFixture(root, FILE_COUNT)
    infoRow('python fixture generation (files)', FILE_COUNT, 'count')
    infoRow('python fixture generation wall time', performance.now() - startedAt)
  })
})

describe.skipIf(!pyrightAvailable)('basedpyright budgets on the 100k-file tree', () => {
  it('keeps the initialize→ready startup median inside budget', async () => {
    const samples: number[] = []
    for (let attempt = 0; attempt < 3; attempt++) {
      const client = new NightlyLspClient({
        executable: pyrightExecutable,
        args: ['--stdio']
      })
      const startedAt = performance.now()
      await client.initialize(pathToFileURL(root).toString())
      samples.push(performance.now() - startedAt)
      await client.dispose()
    }
    budgetRow('basedpyright initialize→ready startup median (3 runs)', median(samples), 30_000)
    infoRow('basedpyright startup worst run', Math.max(...samples))
  })

  it('serves the first hover after a cold didOpen inside budget', async () => {
    const client = new NightlyLspClient({
      executable: pyrightExecutable,
      args: ['--stdio']
    })
    try {
      await client.initialize(pathToFileURL(root).toString())
      const uri = pathToFileURL(pythonModulePath(root, 0)).toString()
      client.notification('textDocument/didOpen', {
        textDocument: { uri, languageId: 'python', version: 1, text: pythonModuleText(0) }
      })
      const startedAt = performance.now()
      const hover = (await client.request('textDocument/hover', {
        textDocument: { uri },
        // Line 0 is `def nightly_func_0():` — index 4+ lands on the name.
        position: { line: 0, character: 5 }
      })) as { contents?: unknown } | null
      expect(hover?.contents).toBeDefined()
      budgetRow(
        'basedpyright first hover after cold didOpen (100k tree)',
        performance.now() - startedAt,
        15_000
      )
    } finally {
      budgetRow('basedpyright teardown exit', await client.dispose(), 2_000)
    }
  })
})
