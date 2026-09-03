import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { afterAll } from 'vitest'

export type BudgetRow = {
  name: string
  value: number
  budget: number
  unit: 'ms' | 'count'
  pass: boolean
}

const rows: BudgetRow[] = []

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Record + enforce one budget in a single call; the row lands in the report. */
export function budgetRow(name: string, value: number, budget: number): void {
  const pass = value <= budget
  rows.push({ name, value, budget, unit: 'ms', pass })
  if (!pass) {
    throw new Error(`budget exceeded: ${name} took ${value}ms (ceiling ${budget}ms)`)
  }
}

export function infoRow(name: string, value: number, unit: BudgetRow['unit'] = 'ms'): void {
  rows.push({ name, value, budget: Number.POSITIVE_INFINITY, unit, pass: true })
}

export const NIGHTLY_REPORT_ENV = 'ORCA_CODE_INTELLIGENCE_NIGHTLY_REPORT'

/** afterAll writer: merge-read-write so per-file module instances (vitest
 * isolates modules per test file) append instead of overwriting each other. */
export function installNightlyReportWriter(): void {
  afterAll(async () => {
    const reportPath = process.env[NIGHTLY_REPORT_ENV]
    if (!reportPath) {
      return
    }
    let existing: { generatedAt?: string; rows?: BudgetRow[] } = {}
    try {
      existing = JSON.parse(await readFile(reportPath, 'utf8')) as typeof existing
    } catch {
      // First writer, or an unreadable leftover — start fresh.
    }
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(
      reportPath,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), rows: [...(existing.rows ?? []), ...rows] },
        null,
        2
      )
    )
  })
}
