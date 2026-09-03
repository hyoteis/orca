import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

async function createFolderFixture(
  registerPostElectronShutdownCleanup: (cleanup: () => Promise<void>) => void
): Promise<string> {
  const rootPath = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-range-switch-')))
  // Why: Windows keeps the watched workspace locked until the Electron app
  // exits, so the fixture directory can only be removed post-teardown.
  registerPostElectronShutdownCleanup(async () => {
    rmSync(rootPath, { recursive: true, force: true })
  })
  const files: [string, string][] = [
    ['engine/core/engine.cpp', 'int engine_main() { return 0; }\n'],
    ['tools/tool.cpp', 'void run_tool() {}\n']
  ]
  for (const [relativePath, content] of files) {
    const filePath = path.join(rootPath, relativePath)
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, content)
  }
  return rootPath
}

test('find strip range switch disables ◆ Scope until members exist, then selects it', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const root = await createFolderFixture(registerPostElectronShutdownCleanup)
  await waitForSessionReady(orcaPage)
  // Why: the host locale persists zh for this profile; assert on pinned-en strings.
  await orcaPage.evaluate(() => window.__store?.getState().updateSettings({ uiLanguage: 'en' }))
  await orcaPage.evaluate(async (p) => {
    const repo = await window.__store?.getState().addNonGitFolder(p)
    if (!repo) {
      throw new Error('addNonGitFolder returned null')
    }
  }, root)
  await waitForActiveWorktree(orcaPage)
  await openFileExplorer(orcaPage)

  const rangeSwitch = orcaPage.getByRole('radiogroup', { name: 'Explorer search range' })
  const scopeItem = rangeSwitch.getByRole('radio').filter({ hasText: '◆ Scope' })
  const worktreeItem = rangeSwitch.getByRole('radio').filter({ hasText: 'Worktree' })

  await expect(rangeSwitch).toBeVisible({ timeout: 10_000 })
  await expect(worktreeItem).toHaveAttribute('data-state', 'on')
  // No scope members yet → ◆ side disabled with guidance, no empty-result trap.
  await expect(scopeItem).toBeDisabled()
  await expect(scopeItem).toHaveAttribute('title', 'No Code scope members to search yet')

  await orcaPage.evaluate(async (folderPath) => {
    const repo = window.__store?.getState().repos.find((candidate) => candidate.path === folderPath)
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
      members: [{ path: 'engine', visibleResults: true }],
      serverSource: { type: 'custom', executable: 'clangd', args: [] },
      enabled: true,
      revision: 0
    })
    await window.__store?.getState().fetchSettings()
  }, root)

  await expect(scopeItem).toBeEnabled({ timeout: 10_000 })
  await scopeItem.click()
  await expect(scopeItem).toHaveAttribute('data-state', 'on')
  await expect(worktreeItem).toHaveAttribute('data-state', 'off')
  await expect
    .poll(() =>
      orcaPage.evaluate(() => {
        const worktreeId = window.__store?.getState().activeWorktreeId
        return worktreeId
          ? (window.__store?.getState().fileSearchStateByWorktree[worktreeId]?.searchRange ??
            'worktree')
          : 'missing'
      })
    )
    .toBe('scope')
})
