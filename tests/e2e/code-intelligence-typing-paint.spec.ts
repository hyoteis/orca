import { mkdtemp } from 'node:fs/promises'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// #87 typing-to-paint budget (#33 close-out): keystroke→Monaco view-lines paint
// p95 with a live cpp language-server session attached, so didChange traffic
// flows while typing. @headful is required: Monaco renders through rAF, and a
// never-shown headless window throttles rAF to ~1fps, which would floor every
// sample at ~1s. Timing budgets are CI-noisy, so this runs in the nightly
// workflow only, never in the PR e2e gate.
const fakeClangdScript = path.join(__dirname, 'fake-clangd-stdio.cjs')
const TYPED_SEQUENCE = 'abcdefghijklmnopqrstuvwxyz0123456789'
const MAX_P95_KEY_TO_PAINT_MS = 150
const MAX_WORST_KEY_TO_PAINT_MS = 500

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

async function openEngineCpp(page: Page, rootPath: string): Promise<void> {
  await page.evaluate((root) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const filePath = `${root}/engine/core/engine.cpp`
    store.getState().openFile({
      filePath,
      relativePath: 'engine/core/engine.cpp',
      worktreeId: store.getState().activeWorktreeId ?? '',
      language: 'cpp',
      mode: 'edit'
    })
    const state = store.getState()
    const opened = state.openFiles.findLast((file) => file.filePath === filePath)
    if (!opened) {
      throw new Error('engine.cpp did not open')
    }
    state.setActiveFile(opened.id)
    state.setActiveTabType('editor')
  }, rootPath)
  await page
    .locator('.monaco-editor .view-lines')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
}

test.describe('Code intelligence typing-to-paint budget', () => {
  test('paints typed keys inside the p95 budget with a live clangd session @headful', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    test.slow()
    const rootPath = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-ci-typing-')))
    registerPostElectronShutdownCleanup(async () => {
      rmSync(rootPath, { recursive: true, force: true })
    })
    const sourceLines = ['#include "engine.h"', '', 'int engine_main() {', '    return engine_start();', '}']
    for (const [relativePath, content] of [
      ['engine/core/engine.h', 'int engine_start();\n'],
      ['engine/core/engine.cpp', `${sourceLines.join('\n')}\n`]
    ] as const) {
      const filePath = path.join(rootPath, relativePath)
      mkdirSync(path.dirname(filePath), { recursive: true })
      writeFileSync(filePath, content)
    }

    await waitForSessionReady(orcaPage)
    const repoId = (await orcaPage.evaluate(async (p) => {
      const repo = await window.__store?.getState().addNonGitFolder(p)
      if (!repo) {
        throw new Error('addNonGitFolder returned null')
      }
      return repo.id
    }, rootPath)) as string
    await waitForActiveWorktree(orcaPage)

    // The fake clangd keeps a live session so didChange notifications flow
    // while typing; its --compile-commands-dir must exist or spawn is refused.
    const scopeId = `local:folder:${repoId}:cpp`
    await orcaPage.evaluate(
      async ({ id, repo, root, script }) => {
        await window.api.codeIntelligence.upsertScope({
          id,
          name: 'Typing C++',
          executionHostId: 'local',
          workspaceKey: `folder:${repo}`,
          workspaceRoot: root,
          language: 'cpp',
          members: [{ path: 'engine', visibleResults: true }],
          serverSource: {
            type: 'custom',
            executable: 'node',
            args: [script, `--compile-commands-dir=${root}`]
          },
          enabled: true,
          revision: 0
        })
        await window.api.codeIntelligence.grantConsent({ scopeId: id, revision: 1 })
        await window.__store?.getState().fetchSettings()
      },
      { id: scopeId, repo: repoId, root: rootPath, script: fakeClangdScript }
    )

    await openEngineCpp(orcaPage, rootPath)

    // Focus the editor and park the caret at 1:1 — every typed char then
    // extends the leading prefix of the rendered first line (`#include ...`).
    const viewLines = orcaPage.locator('.monaco-editor .view-lines').first()
    await viewLines.click({ position: { x: 20, y: 12 } })
    await orcaPage.keyboard.press('Home')
    // Cold-start guard: typing before the file content hydrates lands in an
    // empty model and batches renders, faking second-scale latencies.
    await orcaPage.waitForFunction(
      () =>
        (document.querySelector('.monaco-editor .view-lines')?.textContent ?? '').startsWith(
          '#include'
        ),
      undefined,
      { timeout: 15_000 }
    )

    // In-page probe (ai-vault bench pattern): CDP evaluate round trips cost
    // ~1s in this harness, so keydown and paint timestamps are recorded in the
    // page and read back once at the end.
    await orcaPage.evaluate(() => {
      const viewLinesElement = document.querySelector('.monaco-editor .view-lines')
      if (!viewLinesElement) {
        throw new Error('view-lines not present')
      }
      const marks: number[] = []
      const paints: number[] = []
      const inputs: number[] = []
      document.addEventListener(
        'keydown',
        () => marks.push(performance.now()),
        { capture: true }
      )
      document.addEventListener(
        'input',
        () => inputs.push(performance.now()),
        { capture: true }
      )
      new MutationObserver(() => paints.push(performance.now())).observe(viewLinesElement, {
        childList: true,
        subtree: true,
        characterData: true
      })
      Object.assign(window, { __typingPaintProbe: { marks, paints, inputs } })
    })

    for (const char of TYPED_SEQUENCE) {
      await orcaPage.keyboard.type(char)
      await orcaPage.waitForTimeout(30)
    }
    // Let the last keystroke's render settle before reading the probe.
    await orcaPage.waitForTimeout(500)

    const latencies = (await orcaPage.evaluate(() => {
      const { marks, paints } = (window as unknown as {
        __typingPaintProbe: { marks: number[]; paints: number[]; inputs: number[] }
      }).__typingPaintProbe
      // Sequential consumption: each keydown claims the first paint not yet
      // taken — tolerant of one render batch spanning two keystrokes.
      let paintIndex = 0
      return marks.map((mark) => {
        while (paintIndex < paints.length && paints[paintIndex] < mark) {
          paintIndex++
        }
        const paint = paints[paintIndex]
        if (paint === undefined) {
          return Number.POSITIVE_INFINITY
        }
        paintIndex++
        return paint - mark
      })
    })) as number[]
    if (latencies.length !== TYPED_SEQUENCE.length || latencies.some((value) => !Number.isFinite(value))) {
      const debug = (await orcaPage.evaluate(() => {
        const { marks, paints, inputs } = (window as unknown as {
          __typingPaintProbe: { marks: number[]; paints: number[]; inputs: number[] }
        }).__typingPaintProbe
        const origin = marks[0] ?? 0
        return {
          marks: marks.length,
          paints: paints.length,
          inputs: inputs.length,
          focus: document.activeElement?.tagName ?? 'none',
          firstLine: (document.querySelector('.monaco-editor .view-lines')?.textContent ?? '')
            .slice(0, 45),
          trail: marks.slice(0, 12).map((mark, index) => ({
            key: index,
            mark: Math.round(mark - origin),
            input: Math.round((inputs[index] ?? -1) - origin),
            paint: Math.round((paints[index] ?? -1) - origin)
          }))
        }
      })) as { marks: number; paints: number; inputs: number; focus: string; firstLine: string; trail: unknown }
      throw new Error(
        `typing probe missed a keystroke: ${latencies.length}/${TYPED_SEQUENCE.length} measured, ${JSON.stringify(debug)}`
      )
    }

    const p95 = percentile95(latencies)
    const worst = Math.max(...latencies)
    const summary = `p95=${p95.toFixed(1)}ms median=${median(latencies).toFixed(1)}ms worst=${worst.toFixed(1)}ms samples=${latencies.length}`
    console.log(`[ci-typing-paint] ${summary}`)
    testInfo.annotations.push({ type: 'ci-typing-paint', description: summary })
    expect(p95).toBeLessThan(MAX_P95_KEY_TO_PAINT_MS)
    expect(worst).toBeLessThan(MAX_WORST_KEY_TO_PAINT_MS)
  })
})
