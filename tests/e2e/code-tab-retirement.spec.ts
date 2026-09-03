import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// Why: #83 retired the Code activity tab; Explorer inherits first position.
// Assertions are locale-independent: routing via window.__store, and the
// retired tab's literal label (never translated in any locale).
const ACTIVITY_BUTTON_SELECTOR = '.side-activity-bar-windows-inset button[aria-label]'

test.describe('Code tab retirement (#83)', () => {
  test('Explorer is the first activity entry and no Code tab remains', async ({ orcaPage }) => {
    await orcaPage.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)

    await orcaPage.evaluate(() => {
      window.__store?.setState({ rightSidebarOpen: true, activityBarPosition: 'side' })
    })

    await expect
      .poll(
        async () =>
          orcaPage.evaluate(
            (selector) => document.querySelectorAll(selector).length,
            ACTIVITY_BUTTON_SELECTOR
          ),
        { timeout: 5_000, message: 'side activity bar never rendered' }
      )
      .toBeGreaterThan(0)

    const labels = await orcaPage.evaluate(
      (selector) =>
        Array.from(document.querySelectorAll(selector)).map((button) =>
          button.getAttribute('aria-label')
        ),
      ACTIVITY_BUTTON_SELECTOR
    )
    expect(labels).not.toContain('Code')

    await orcaPage.evaluate((selector) => {
      document.querySelector<HTMLElement>(selector)?.click()
    }, ACTIVITY_BUTTON_SELECTOR)
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store?.getState().rightSidebarTab ?? null))
      .toBe('explorer')
  })
})
