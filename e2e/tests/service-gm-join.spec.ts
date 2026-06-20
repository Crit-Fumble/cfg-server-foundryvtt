import { test, expect } from '@playwright/test'
import { SERVICE_GM } from '../helpers/service-gm'
import { joinWorldAsUser } from '../helpers/foundry-admin'

/**
 * In-repo rung 2: a headless browser session authenticated as the platform
 * service-GM lands in the live world as a role-4 Gamemaster — proven DIRECTLY
 * against the wrapper (no proxy, no core-server). globalSetup seeded the
 * service-GM doc on disk; here we /join with that credential and assert
 * game.user.isGM === true.
 */
test('the service-GM /joins the live world and lands as a Gamemaster', async ({ page }) => {
  await joinWorldAsUser(page, SERVICE_GM.nativeUserId, SERVICE_GM.password)
  const isGM = await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (globalThis as any).game.user.isGM === true,
  )
  expect(isGM, 'service-GM session is a role-4 Gamemaster').toBe(true)
})
