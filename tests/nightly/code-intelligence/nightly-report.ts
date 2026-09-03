import { mkdir, writeFile } from 'node:fs/promises'
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

export function currentBudgetRows(): readonly BudgetRow[] {
  return rows
}

export const NIGHTLY_REPORT_ENV = 'ORCA_CODE_INTELLIGENCE_NIGHTLY_REPORT'

/** afterAll writer: JSON report for artifacts/trending when the env points at a path. */
export function installNightlyReportWriter(): void {
  afterAll(async () => {
    const reportPath = process.env[NIGHTLY_REPORT_ENV]
    if (!reportPath) {
      return
    }
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(
      reportPath,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), rows },
        null,
        2
      )
    )
  })
}
