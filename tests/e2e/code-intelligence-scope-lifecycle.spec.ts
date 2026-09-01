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
    ['engine/core/engine.h', 'int engine_start();\n'],
    [
      'engine/core/engine.cpp',
      '#include "engine.h"\n\nint engine_main() {\n    return engine_start();\n}\n'
    ],
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
  rootPath: string,
  definitionUri?: string
): Promise<{ scopeId: string; pidLog: string }> {
  const pidLog = path.join(rootPath, 'clangd-pids.log')
  const scopeId = `local:folder:${repoId}:cpp`
  await page.evaluate(
    async ({ id, repo, root, log, script, definition }) => {
      const args = [script, `--compile-commands-dir=${root}`, `--pid-log=${log}`]
      if (definition) {
        args.push(`--definition-uri=${definition}`)
      }
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
        serverSource: { type: 'custom', executable: 'node', args },
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
      log: pidLog,
      script: fakeClangdScript,
      definition: definitionUri ?? null
    }
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

test('opened cpp file renders colored tokens and Ctrl+Click jumps to the definition', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const root = await createCppFolderFixture(registerPostElectronShutdownCleanup)
  const repoId = await addFolderWorkspace(orcaPage, root)
  const headerUri = `file:///${path
    .join(root, 'engine', 'core', 'engine.h')
    .replace(/\\/g, '/')}`
  await seedCppScopeWithFakeClangd(orcaPage, repoId, root, headerUri)

  await hoverEngineCpp(orcaPage, path.join(root, 'engine', 'core', 'engine.cpp'))

  // Syntax highlighting: Monaco's cpp tokenizer colors the document with more
  // than one token class (keywords vs identifiers vs preprocessor/strings).
  const tokenClasses = await orcaPage.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll('.view-lines span[class*="mtk"]')].map(
        (element) => element.className
      )
    )
  ])
  expect(tokenClasses.length).toBeGreaterThan(2)

  // Hold the platform definition modifier (Control on Windows/Linux) over the
  // symbol: the jump affordance decoration must appear.
  const symbol = orcaPage.locator('.view-lines span', { hasText: 'engine_start' }).first()
  await orcaPage.keyboard.down('Control')
  try {
    await symbol.hover()
    await expect(orcaPage.locator('.orca-definition-link').first()).toBeVisible({
      timeout: 10_000
    })
    await symbol.click()
  } finally {
    await orcaPage.keyboard.up('Control')
  }

  // The jump opens and focuses the definition target in the editor.
  await expect
    .poll(
      () =>
        orcaPage.evaluate(
          () => window.__store?.getState().openFiles.some((file) => file.filePath.endsWith('engine.h')) ?? false
        ),
      { timeout: 10_000 }
    )
    .toBe(true)
  await expect(orcaPage.locator('.editor-header-path').first()).toContainText('engine.h', {
    timeout: 20_000
  })
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
