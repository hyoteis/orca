import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CDPSession, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState, waitForSessionReady } from './helpers/store'
import type { Repo } from '../../src/shared/types'

async function openRepoSettings(page: Page, repoId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const state = window.__store!.getState()
    await state.updateSettingsOrThrow({ uiLanguage: 'en' })
    state.openSettingsTarget({ pane: 'repo', repoId: id })
    state.openSettingsPage()
  }, repoId)
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  const maybeLater = page.getByRole('button', { name: 'Maybe Later' })
  if (await maybeLater.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await maybeLater.click()
  }
}

async function captureSettings(
  session: CDPSession,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  const screenshot = await session.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true
  })
  const outputDir = path.join(process.cwd(), 'output', 'playwright')
  mkdirSync(outputDir, { recursive: true })
  const screenshotPath = path.join(outputDir, `${name}.png`)
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' })
}

test('keeps code intelligence out of settings and exposes one-click setup in project actions', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const [repo] = await getStoreState<Repo[]>(orcaPage, 'repos')
  expect(repo).toBeDefined()
  for (const directory of ['Alpha', path.join('Alpha', 'Nested'), 'Zeta']) {
    const absoluteDirectory = path.join(repo.path, directory)
    mkdirSync(absoluteDirectory, { recursive: true })
    writeFileSync(path.join(absoluteDirectory, 'CMakeLists.txt'), 'project(test)')
  }
  await openRepoSettings(orcaPage, repo.id)

  const project = orcaPage.locator(`[data-settings-section="repo-${repo.id}"]`)
  await expect(project.getByRole('heading', { name: 'Code Intelligence' })).toHaveCount(0)
  await expect(project.getByText('Discover scopes')).toHaveCount(0)

  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.setGroupBy('repo')
    state.closeSettingsPage()
  })
  const projectHeader = orcaPage.locator(`[data-repo-header-id="${repo.id}"]`)
  await projectHeader.hover()
  const actions = orcaPage.getByRole('button', {
    name: `Project actions for ${repo.displayName}`,
    exact: true
  })
  await expect(actions).toBeVisible()
  await actions.click()
  const setupItem = orcaPage.getByRole('menuitem', { name: 'Configure C++ code intelligence' })
  await expect(setupItem).toBeVisible()

  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  await captureSettings(cdp, testInfo, 'code-intelligence-project-actions-en')
  await setupItem.click()
  const setupDialog = orcaPage.getByRole('dialog')
  await expect(setupDialog).toContainText('Configure C++ code intelligence')
  await setupDialog.getByRole('radio', { name: 'Selected folders' }).click()
  const folderSearch = setupDialog.getByRole('textbox', { name: 'Search code folders' })
  await folderSearch.fill('alpha')
  const alphaCheckboxes = setupDialog.getByRole('checkbox')
  await expect(setupDialog.getByRole('checkbox', { name: 'Alpha' })).toBeVisible()
  await expect(setupDialog.getByRole('checkbox', { name: 'Alpha/Nested' })).toBeVisible()
  expect(
    await alphaCheckboxes.evaluateAll((checkboxes) =>
      checkboxes
        .map((checkbox) => checkbox.getAttribute('aria-label'))
        .filter((label): label is string => Boolean(label))
    )
  ).toEqual(['Alpha', 'Alpha/Nested'])

  await folderSearch.fill('zeta')
  const zetaCheckbox = setupDialog.getByRole('checkbox', { name: 'Zeta' })
  await expect(zetaCheckbox).toBeVisible()
  await zetaCheckbox.click()
  await expect(setupDialog.getByText('Selected folders')).toBeVisible()
  await expect(zetaCheckbox).toBeChecked()
  await setupDialog.getByRole('button', { name: 'Clear folder search' }).click()
  await expect(setupDialog.getByRole('checkbox', { name: 'Zeta' })).toBeChecked()
  await captureSettings(cdp, testInfo, 'code-intelligence-setup-en')
})
