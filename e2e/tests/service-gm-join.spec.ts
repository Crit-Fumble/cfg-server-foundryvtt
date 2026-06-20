import { test, expect } from '@playwright/test'
import { SERVICE_GM } from '../helpers/service-gm'

/**
 * In-repo rung 2: a headless browser session authenticated as the platform
 * service-GM lands in the live world as a role-4 Gamemaster — proven DIRECTLY
 * against the wrapper (no proxy, no core-server). globalSetup seeded the
 * service-GM doc on disk; here we run Foundry's /join handshake with that
 * credential (the same handshake core-server's foundry-player-session uses) and
 * assert game.user.isGM === true.
 */
test('the service-GM /joins the live world and lands as a Gamemaster', async ({ page }) => {
  page.on('pageerror', (e) => {
    // eslint-disable-next-line no-console
    console.error('[pageerror]', String(e).slice(0, 200))
  })

  // /join handshake: GET /join for an anonymous session, then POST the credential
  // to bind that session to the user. page.request shares the browser context's
  // cookie jar, so the bound session carries into the navigation below.
  await page.request.get('/join')
  const resp = await page.request.post('/join', {
    form: { action: 'join', userid: SERVICE_GM.nativeUserId, password: SERVICE_GM.password },
  })
  const body = await resp.text()
  expect(body, 'Foundry accepted the service-GM credential').toContain('LoginSuccess')

  // Load the game with the bound session and wait for Foundry to be ready.
  await page.goto('/game', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => typeof (globalThis as any).game !== 'undefined' && (globalThis as any).game.ready === true && !!(globalThis as any).game.user,
    undefined,
    { timeout: 90_000 },
  )
  const isGM = await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (globalThis as any).game.user.isGM === true,
  )
  expect(isGM, 'service-GM session is a role-4 Gamemaster').toBe(true)
})
