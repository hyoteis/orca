import { mkdtemp } from 'node:fs/promises'
import { mkdirSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// #38 preview drawer: a server-initiated workspace/applyEdit must surface in
// the guarded bottom drawer (review + diff counts + Host/scope disclosure),
// apply all-or-nothing, and undo from the completion state. The fake clangd
// pushes the applyEdit request on initialization, so no editor interaction is
// needed — the drawer itself is the thing under test.
const fakeClangdScript = path.join(__dirname, 'fake-clangd-stdio.cjs')
const TOUCHED_HEADER = '// touched by drawer e2e'
const ORIGINAL_HEADER = 'int engine_start();\n'

/** The clangd session spawns on first document sync, so a file must be open
 * before the fake server can push its applyEdit. */
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

test.describe('Semantic workspace-edit drawer', () => {
  test('reviews, applies, and undoes a server-initiated workspace edit', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }) => {
    const rootPath = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-drawer-')))
    // Why: Windows keeps the watched workspace locked until the Electron app
    // exits, so the fixture directory can only be removed post-teardown.
    registerPostElectronShutdownCleanup(async () => {
      rmSync(rootPath, { recursive: true, force: true })
    })
    const headerPath = path.join(rootPath, 'engine/core/engine.h')
    mkdirSync(path.dirname(headerPath), { recursive: true })
    writeFileSync(headerPath, ORIGINAL_HEADER)
    const engineCppPath = path.join(rootPath, 'engine/core/engine.cpp')
    writeFileSync(engineCppPath, '#include "engine.h"\n\nint engine_main() {\n    return engine_start();\n}\n')

    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(() => window.__store?.getState().updateSettings({ uiLanguage: 'en' }))
    const repoId = (await orcaPage.evaluate(async (p) => {
      const repo = await window.__store?.getState().addNonGitFolder(p)
      if (!repo) {
        throw new Error('addNonGitFolder returned null')
      }
      return repo.id
    }, rootPath)) as string
    await waitForActiveWorktree(orcaPage)

    const scopeId = `local:folder:${repoId}:cpp`
    await orcaPage.evaluate(
      async ({ id, repo, root, script, pidLog, header, text }) => {
        await window.api.codeIntelligence.upsertScope({
          id,
          name: 'Drawer C++',
          executionHostId: 'local',
          workspaceKey: `folder:${repo}`,
          workspaceRoot: root,
          language: 'cpp',
          members: [{ path: 'engine', visibleResults: true }],
          serverSource: {
            type: 'custom',
            executable: 'node',
            args: [
              script,
              `--compile-commands-dir=${root}`,
              `--pid-log=${pidLog}`,
              `--apply-edit-file=${header}`,
              `--apply-edit-new-text=${text}`
            ]
          },
          enabled: true,
          revision: 0
        })
        await window.api.codeIntelligence.grantConsent({ scopeId: id, revision: 1 })
        await window.__store?.getState().fetchSettings()
      },
      {
        id: scopeId,
        repo: repoId,
        root: rootPath,
        script: fakeClangdScript,
        pidLog: path.join(rootPath, 'clangd-pids.log'),
        header: headerPath,
        text: TOUCHED_HEADER
      }
    )
    await openEngineCpp(orcaPage, rootPath)

    // Review state: the drawer is the only thing that may touch the file, so
    // the header is untouched until Apply is clicked. The pid log doubles as
    // the sync point: the fake clangd only appends 'sent-applyEdit' after the
    // session initialized and the request was pushed.
    const pidLogPath = path.join(rootPath, 'clangd-pids.log')
    await expect
      .poll(
        () => (existsSync(pidLogPath) ? readFileSync(pidLogPath, 'utf8').trim() : ''),
        { timeout: 20_000 }
      )
      .toContain('sent-applyEdit')
    const drawer = orcaPage.locator('[data-slot="sheet-content"]')
    await expect(drawer).toBeVisible({ timeout: 20_000 })
    await expect(drawer.getByText('engine/core/engine.h')).toBeVisible()
    await expect(drawer.getByText('+1')).toBeVisible()
    // Host/scope disclosure starts collapsed; open it for the disclosure rows.
    await drawer.getByText('Host & scope').click()
    await expect(drawer.getByText('Execution host')).toBeVisible()
    await expect(drawer.getByRole('button', { name: 'Apply' })).toBeVisible()
    expect(readFileSync(headerPath, 'utf8')).toBe(ORIGINAL_HEADER)

    await drawer.getByRole('button', { name: 'Apply' }).click()
    await expect(drawer.getByText('Applied 1 file operation(s)')).toBeVisible()
    expect(readFileSync(headerPath, 'utf8')).toBe(TOUCHED_HEADER)

    await drawer.getByRole('button', { name: 'Undo' }).click()
    await expect(drawer.getByText('Undone — files restored')).toBeVisible()
    expect(readFileSync(headerPath, 'utf8')).toBe(ORIGINAL_HEADER)
  })
})
