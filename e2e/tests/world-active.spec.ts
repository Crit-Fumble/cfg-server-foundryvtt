import { test, expect } from '@playwright/test'

/**
 * In-repo rung 1: a REAL world (dnd5e + the crit-fumble-core plugin) is live in
 * the standalone wrapper — no core-server, no proxy. globalSetup launched it via
 * the admin API; here we assert it actually activated and serves its join form.
 * The service-GM rungs (direct /join, plugin drain) build on this.
 */
test('the seeded test-world is active and serves its join form', async ({ page }) => {
  const resp = await page.goto('/join', { waitUntil: 'domcontentloaded', timeout: 30_000 })
  expect(resp?.status(), 'join page served').toBe(200)

  // "no active game session" is Foundry's setup-mode page; its absence + a join
  // form means a world is genuinely loaded.
  await expect(page.locator('body')).not.toContainText('no active game session', { timeout: 10_000 })
  await expect(page.locator('#join-game, form#join-game-form')).toBeVisible({ timeout: 10_000 })
})
