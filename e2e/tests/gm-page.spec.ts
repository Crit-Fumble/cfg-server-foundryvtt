import { test, expect } from '@playwright/test'
import { SERVICE_GM } from '../helpers/service-gm'
import { joinWorldAsUser } from '../helpers/foundry-admin'

/**
 * A GM's page holds no platform credential and calls no platform API (cs#543). What the
 * module does send is the GM-presence beacon: a request to its OWN world's `api/status`,
 * which the platform's sign-in check reads. The service-GM's session is a role-4 GM in
 * this world, so its page runs the same module code a human GM's does.
 *
 * Also: a key module 3.2 to 3.3 stored in localStorage is gone after one GM load.
 */
test("a GM's page beacons its own world and makes no script call to any other origin", async ({ page }) => {
  const otherOrigins: string[] = []
  const beacons: string[] = []
  const pageOrigin = () => new URL(page.url()).origin
  page.on('request', (req) => {
    const url = new URL(req.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    // Script calls only: a licensed module's web font from its CDN is a stylesheet, not a call.
    const scripted = ['fetch', 'xhr', 'eventsource', 'websocket'].includes(req.resourceType())
    if (scripted && page.url().startsWith('http') && url.origin !== pageOrigin()) otherOrigins.push(req.url())
    if (url.pathname.endsWith('/api/status')) beacons.push(req.url())
  })
  await page.addInitScript(() => {
    try {
      localStorage.setItem('crit-fumble-core.apiKey', '"cfk_left_over_by_3_3"')
    } catch {
      // A page without storage has nothing stored to remove either.
    }
  })

  await joinWorldAsUser(page, SERVICE_GM.nativeUserId, SERVICE_GM.password)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.waitForFunction(() => (globalThis as any).game?.ready === true && (globalThis as any).CFGCore, undefined, {
    timeout: 90_000,
  })

  await expect.poll(() => beacons.length, { message: 'the GM tab sent its beacon to its own api/status', timeout: 15_000 }).toBeGreaterThan(0)
  expect(new URL(beacons[0]).origin, 'the beacon stays on the page origin').toBe(pageOrigin())
  expect(otherOrigins, 'no script call leaves the world origin').toEqual([])

  const state = await page.evaluate(() => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keys: Object.keys((globalThis as any).CFGCore),
    storedKey: localStorage.getItem('crit-fumble-core.apiKey'),
  }))
  expect(state.keys, 'the page exposes the version and no API client').toEqual(['version'])
  expect(state.storedKey, 'the left-over key is removed').toBeNull()
})
