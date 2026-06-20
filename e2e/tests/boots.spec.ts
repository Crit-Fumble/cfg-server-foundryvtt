import { test, expect } from '@playwright/test'

/**
 * Runtime-level passthrough proof: the wrapper image actually boots + serves
 * FoundryVTT (the config-level byte-identical check is in the Dockerfile build).
 * A fresh Foundry with a valid license + no world serves its setup/license/join
 * surface — we just assert the Foundry app shell renders through the wrapper.
 */
test('the wrapper image boots and serves FoundryVTT', async ({ page }) => {
  const resp = await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  expect(resp?.status(), `Foundry responded (status ${resp?.status()})`).toBeLessThan(500)

  // Foundry's pages (setup / license / join) all ship its app shell — a <title>
  // mentioning Foundry and the Foundry bootstrap. Assert the app renders.
  await expect(page).toHaveTitle(/foundry/i, { timeout: 30_000 })
  await expect(page.locator('body')).toBeVisible()
})
