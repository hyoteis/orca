import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { Page } from '@stablyai/playwright-test'

const fakeClangdScript = path.join(__dirname, 'fake-clangd-stdio.cjs')

/** Folder workspace whose two member roots each hold one small .cpp file. */
async function createCppFolderFixture(
  registerPostElectronShutdownCleanup: (cleanup: () => Promise<void>) => void
): Promise<string> {
  const rootPath = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-ci-lifecycle-')))
  // Why: Windows keeps the watched workspace locked until the Electron app
  // exits, so the fixture directory can only be removed post-teardown.
  registerPostElectronShutdownCleanup(async () => {
    rmSync(rootPath, { recursive: true, force: true })
  })
  for (const [relativePath, content] of [
    ['engine/core/engine.cpp', 'int engine_main() { return 0; }\n'],
    ['fx/effect.cpp', 'void fx_effect() {}\n']
  ] as const) {
    const filePath = path.join(rootPath, relativePath)
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, content)
  }
  return rootPath
}

async function addFolderWorkspace(
  page: Page,
  folderPath: string
) {
  await waitForSessionReady(page)
  // Why: the host locale persists zh for this profile; the spec drives the
  // status popover, whose accessible names come from translated strings.
  await page.evaluate(() => window.__store?.getState().updateSettings({ uiLanguage: 'en' }))
  const repoId = await page.evaluate(async (p) => {
    const repo = await window.__store?.getState().addNonGitFolder(p)
    if (!repo) {
      throw new Error('addNonGitFolder returned null')
    }
    return repo.id
  }, folderPath)
  await waitForActiveWorktree(page)
  return repoId
}

/**
 * Seeds a cpp scope whose language server is the fake stdio clangd: every
 * spawn appends its pid to the log, so "session survived" = one log line.
 */
async function seedCppScopeWithFakeClangd(
  page: Page,
  repoId: string,
  rootPath: string
): Promise<{ scopeId: string; pidLog: string }> {
  const pidLog = path.join(rootPath, 'clangd-pids.log')
  const scopeId = `local:folder:${repoId}:cpp`
  await page.evaluate(
    async ({ id, repo, root, log, script }) => {
      await window.api.codeIntelligence.upsertScope({
        id,
        name: 'Engine C++',
        executionHostId: 'local',
        workspaceKey: `folder:${repo}`,
        workspaceRoot: root,
        language: 'cpp',
        members: [
          { path: 'engine', visibleResults: true },
          { path: 'fx', visibleResults: true }
        ],
        // The compile-commands dir must exist or spawn is refused (#58); the
        // workspace root always does.
        serverSource: {
          type: 'custom',
          executable: 'node',
          args: [script, `--compile-commands-dir=${root}`, `--pid-log=${log}`]
        },
        enabled: true,
        revision: 0
      })
      await window.api.codeIntelligence.grantConsent({ scopeId: id, revision: 1 })
      await window.__store?.getState().fetchSettings()
    },
    { id: scopeId, repo: repoId, root: rootPath, log: pidLog, script: fakeClangdScript }
  )
  return { scopeId, pidLog }
}

const readPids = (pidLog: string): string[] =>
  readFileSync(pidLog, 'utf8').split('\n').filter(Boolean)

async function hoverEngineCpp(
  page: Page,
  filePath: string
): Promise<void> {
  await page.evaluate((fp) => {
    const store = window.__store
    if (!store) {
      return
    }
    store.getState().openFile({
      filePath: fp,
      relativePath: 'engine/core/engine.cpp',
      worktreeId: store.getState().activeWorktreeId ?? '',
      language: 'cpp',
      mode: 'edit'
    })
    const state = store.getState()
    const opened = state.openFiles.findLast((file) => file.filePath === fp)
    if (opened) {
      state.setActiveFile(opened.id)
      state.setActiveTabType('editor')
    }
  }, filePath)
  const editor = page.locator('.monaco-editor .view-lines').first()
  await editor.waitFor({ state: 'visible', timeout: 15_000 })
  // Re-position the pointer so Monaco fires a fresh hover round each time.
  await page.mouse.move(5, 5)
  await editor.hover()
  await page.waitForTimeout(1_000)
}

test('member edits keep the running language-server session alive', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const root = await createCppFolderFixture(registerPostElectronShutdownCleanup)
  const repoId = await addFolderWorkspace(orcaPage, root)
  const { pidLog } = await seedCppScopeWithFakeClangd(orcaPage, repoId, root)

  // First hover opens the session: exactly one spawn.
  await hoverEngineCpp(orcaPage, path.join(root, 'engine', 'core', 'engine.cpp'))
  await expect
    .poll(() => readPids(pidLog).length, { timeout: 20_000 })
    .toBe(1)
  const sessionPid = readPids(pidLog)[0]

  // Member removal through the status popover (revision bumps, consent goes
  // stale) must NOT restart the session.
  await orcaPage.getByRole('button', { name: /Code intelligence: 2 folders/ }).click()
  await orcaPage.getByRole('button', { name: 'Remove fx' }).click()
  await expect
    .poll(() =>
      orcaPage.evaluate(
        () => window.__store?.getState().settings?.codeIntelligenceScopes[0]?.members.length ?? 0
      )
    )
    .toBe(1)

  await hoverEngineCpp(orcaPage, path.join(root, 'engine', 'core', 'engine.cpp'))
  expect(readPids(pidLog)).toEqual([sessionPid])

  // Reauthorization restores the trust chain but still reuses the session.
  await orcaPage.getByRole('button', { name: 'Reauthorize' }).click()
  await expect(
    orcaPage.getByRole('button', { name: /Code intelligence: 1 folders/ })
  ).toBeVisible({ timeout: 10_000 })
  await hoverEngineCpp(orcaPage, path.join(root, 'engine', 'core', 'engine.cpp'))
  expect(readPids(pidLog)).toEqual([sessionPid])
})

test('scope removal deletes the owning host scope directory', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}) => {
  const root = await createCppFolderFixture(registerPostElectronShutdownCleanup)
  const repoId = await addFolderWorkspace(orcaPage, root)
  const { scopeId } = await seedCppScopeWithFakeClangd(orcaPage, repoId, root)

  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const scopeDirectory = path.join(
    userDataDir,
    'code-intelligence',
    'cpp',
    'scopes',
    createHash('sha256').update(scopeId).digest('hex').slice(0, 16)
  )
  mkdirSync(path.join(scopeDirectory, '.cache', 'clangd', 'index'), { recursive: true })

  await orcaPage.evaluate(async (id) => {
    await window.api.codeIntelligence.removeScope(id)
  }, scopeId)

  await expect
    .poll(() => !existsSync(scopeDirectory), { timeout: 10_000 })
    .toBe(true)
})
