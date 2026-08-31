import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

/** Folder workspace with one member root (engine), one hidden-results member (fx), one non-member (tools). */
async function createCppFolderFixture(
  registerPostElectronShutdownCleanup: (cleanup: () => Promise<void>) => void
): Promise<string> {
  const rootPath = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-ci-members-')))
  // Why: Windows keeps the watched workspace locked until the Electron app
  // exits, so the fixture directory can only be removed post-teardown.
  registerPostElectronShutdownCleanup(async () => {
    rmSync(rootPath, { recursive: true, force: true })
  })
  const files: Array<[string, string]> = [
    ['CMakeLists.txt', 'cmake_minimum_required(VERSION 3.10)\n'],
    ['engine/CMakeLists.txt', 'add_library(engine core/engine.cpp)\n'],
    ['engine/core/engine.cpp', 'int engine_main() { return 0; }\n'],
    ['fx/effect.cpp', 'void fx_effect() {}\n'],
    ['tools/tool.cpp', 'void run_tool() {}\n'],
    ['ui/widget.cpp', 'void ui_widget() {}\n']
  ]
  for (const [relativePath, content] of files) {
    const filePath = path.join(rootPath, relativePath)
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, content)
  }
  return rootPath
}

async function addFolderWorkspace(
  page: import('@stablyai/playwright-test').Page,
  folderPath: string
) {
  await waitForSessionReady(page)
  // Why: the host locale persists zh for this profile; the spec asserts on
  // translated settings.* strings, so pin the UI language to the default.
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

async function seedCppScope(
  page: import('@stablyai/playwright-test').Page,
  folderPath: string
): Promise<void> {
  await page.evaluate(async (root) => {
    const repo = window.__store?.getState().repos.find((candidate) => candidate.path === root)
    if (!repo) {
      throw new Error('fixture repo not found')
    }
    await window.api.codeIntelligence.upsertScope({
      id: `local:folder:${repo.id}:cpp`,
      name: `${repo.displayName} C++`,
      executionHostId: 'local',
      workspaceKey: `folder:${repo.id}`,
      workspaceRoot: repo.path,
      language: 'cpp',
      members: [
        { path: 'engine', visibleResults: true },
        { path: 'fx', visibleResults: false }
      ],
      serverSource: { type: 'custom', executable: 'clangd', args: [] },
      enabled: true,
      revision: 0
    })
    await window.__store?.getState().fetchSettings()
  }, folderPath)
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__store?.getState().settings?.codeIntelligenceScopes[0]?.members.length ?? 0
      )
    )
    .toBe(2)
}

function readMembers(page: import('@stablyai/playwright-test').Page) {
  return page.evaluate(() =>
    (window.__store?.getState().settings?.codeIntelligenceScopes ?? []).flatMap((scope) =>
      scope.members.map((member) => `${member.path}:${member.visibleResults ? 'on' : 'off'}`)
    )
  )
}

test('tree context menu applies the three-state membership rule to one scope', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const root = await createCppFolderFixture(registerPostElectronShutdownCleanup)
  await addFolderWorkspace(orcaPage, root)
  await seedCppScope(orcaPage, root)
  await openFileExplorer(orcaPage)

  const row = (name: string) =>
    orcaPage.locator('[data-file-explorer-row]').filter({
      has: orcaPage.locator('[data-file-explorer-row-name]').getByText(name, { exact: true })
    })

  await expect(row('engine')).toBeVisible({ timeout: 10_000 })

  // Strict subpath of member 'engine' → disabled ✓, no Add/Remove offered.
  await row('engine').click()
  await expect(row('core')).toBeVisible({ timeout: 10_000 })
  await row('core').click({ button: 'right' })
  const inScope = orcaPage.getByRole('menuitem', { name: /In Code Intelligence/ })
  await expect(inScope).toBeVisible()
  await expect(inScope).toBeDisabled()
  await orcaPage.keyboard.press('Escape')

  // Multi-selected non-members → Add applies to the whole selection.
  await row('tools').click()
  await row('ui').click({ modifiers: ['ControlOrMeta'] })
  await row('ui').click({ button: 'right' })
  await orcaPage.getByRole('menuitem', { name: 'Add to Code Intelligence' }).click()
  await expect
    .poll(() => readMembers(orcaPage))
    .toEqual(['engine:on', 'fx:off', 'tools:on', 'ui:on'])

  // Exact member → Remove.
  await row('engine').click({ button: 'right' })
  await orcaPage.getByRole('menuitem', { name: 'Remove from Code Intelligence' }).click()
  await expect.poll(() => readMembers(orcaPage)).toEqual(['fx:off', 'tools:on', 'ui:on'])
})

test('status popover edits visibility inline and removes members, guarding the last one', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const root = await createCppFolderFixture(registerPostElectronShutdownCleanup)
  await addFolderWorkspace(orcaPage, root)
  await seedCppScope(orcaPage, root)

  await orcaPage.getByRole('button', { name: /Code intelligence: \d+ folders/ }).click()
  const visibility = orcaPage.getByRole('checkbox', { name: 'Show results for fx' })
  await expect(visibility).toBeVisible()
  await expect(visibility).not.toBeChecked()

  await visibility.click()
  await expect.poll(() => readMembers(orcaPage)).toEqual(['engine:on', 'fx:on'])

  await orcaPage.getByRole('button', { name: 'Remove fx' }).click()
  await expect.poll(() => readMembers(orcaPage)).toEqual(['engine:on'])

  await expect(orcaPage.getByRole('button', { name: 'Remove engine' })).toBeDisabled()
})

test('setup dialog pre-checks members, filters, and takes custom absolute paths', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const root = await createCppFolderFixture(registerPostElectronShutdownCleanup)
  await addFolderWorkspace(orcaPage, root)
  await seedCppScope(orcaPage, root)

  await orcaPage.getByRole('button', { name: /Code intelligence: \d+ folders/ }).click()
  await orcaPage.getByRole('button', { name: 'Reconfigure' }).click()

  await orcaPage.getByRole('radio', { name: 'Selected folders' }).click()
  await expect(orcaPage.getByRole('checkbox', { name: 'engine', exact: true }).first()).toBeVisible(
    { timeout: 15_000 }
  )
  await expect(
    orcaPage.getByRole('checkbox', { name: 'engine', exact: true }).first()
  ).toBeChecked()
  // Pre-check reflects membership, not result visibility (fx hides results but is a member).
  await expect(orcaPage.getByRole('checkbox', { name: 'fx', exact: true }).first()).toBeChecked()
  await expect(orcaPage.getByRole('checkbox', { name: 'fx', exact: true }).first()).toBeVisible()

  // Search filters the available list; the pinned selection summary stays unfiltered.
  const availableList = orcaPage.locator('section', { hasText: 'Available folders' })
  await orcaPage.getByRole('textbox', { name: 'Search code folders' }).fill('eng')
  await expect(availableList.getByRole('checkbox', { name: 'fx', exact: true })).toHaveCount(0)
  await expect(
    availableList.getByRole('checkbox', { name: 'engine', exact: true }).first()
  ).toBeVisible()
  await orcaPage.getByRole('textbox', { name: 'Search code folders' }).fill('')

  await orcaPage
    .getByRole('textbox', { name: /Add a folder outside this workspace/ })
    .fill('/opt/sdk')
  await orcaPage.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(orcaPage.getByText('custom', { exact: true }).first()).toBeVisible()
  await expect(orcaPage.getByRole('checkbox', { name: '/opt/sdk' }).first()).toBeChecked()

  await orcaPage.getByRole('button', { name: 'Cancel' }).click()
})
