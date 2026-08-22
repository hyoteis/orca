import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CDPSession, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState, waitForSessionReady } from './helpers/store'
import type { GlobalSettings, Repo } from '../../src/shared/types'

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

test('configures a consented custom C++ scope and captures the rendered settings', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const [repo] = await getStoreState<Repo[]>(orcaPage, 'repos')
  expect(repo).toBeDefined()
  await openRepoSettings(orcaPage, repo.id)

  const project = orcaPage.locator(`[data-settings-section="repo-${repo.id}"]`)
  await expect(project.getByRole('heading', { name: 'Code Intelligence' })).toBeVisible()
  await project.getByRole('button', { name: 'Add C++ scope' }).click()
  await expect(project.getByText(`${repo.displayName} C++`, { exact: true })).toBeVisible()

  await project.getByRole('radio', { name: 'Custom' }).click()
  await project.getByLabel('Executable path').fill('clangd')
  await project.getByLabel('Server arguments').fill('--background-index')
  await project.getByRole('button', { name: 'Add directory' }).click()
  await project.getByLabel('Scope directory').nth(1).fill('src')
  await project.getByRole('button', { name: 'Save', exact: true }).click()
  await project.getByRole('button', { name: 'Allow launch' }).click()
  await expect(project.getByRole('button', { name: 'Re-allow launch' })).toBeVisible()

  await expect
    .poll(async () => {
      const settings = await getStoreState<GlobalSettings | null>(orcaPage, 'settings')
      return settings?.codeIntelligenceScopes?.find((scope) => scope.language === 'cpp')
    })
    .toMatchObject({
      enabled: true,
      serverSource: { type: 'custom', executable: 'clangd', args: ['--background-index'] },
      members: [
        { relativePath: '.', visibleResults: true },
        { relativePath: 'src', visibleResults: true }
      ],
      consent: { configurationFingerprint: expect.any(String) }
    })

  await project.getByRole('heading', { name: 'Code Intelligence' }).scrollIntoViewIfNeeded()
  const englishLayout = await project.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth
  }))
  expect(englishLayout.scrollWidth).toBeLessThanOrEqual(englishLayout.clientWidth + 1)

  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  await captureSettings(cdp, testInfo, 'code-intelligence-settings-en')

  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettingsOrThrow({ uiLanguage: 'zh' })
  })
  await expect(project.getByRole('heading', { name: '\u4ee3\u7801\u667a\u80fd' })).toBeVisible()
  await expect(project).toContainText(
    '\u5728\u6b64\u4e3b\u673a\u4e0a\u914d\u7f6e Python \u548c C++ \u8bed\u4e49\u8303\u56f4'
  )
  await expect(
    project.getByRole('button', { name: '\u91cd\u65b0\u5141\u8bb8\u542f\u52a8' })
  ).toBeVisible()
  expect(await project.innerText()).not.toMatch(/\?{2,}/)
  const chineseLayout = await project.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth
  }))
  expect(chineseLayout.scrollWidth).toBeLessThanOrEqual(chineseLayout.clientWidth + 1)
  await captureSettings(cdp, testInfo, 'code-intelligence-settings-zh')
})
