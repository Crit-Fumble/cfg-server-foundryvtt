#!/usr/bin/env node
/**
 * Service-GM drain driver — the production one-shot.
 *
 * The platform spawns this as a SIBLING container (next to the Foundry
 * container, not inside it — prod's docker-socket-proxy denies EXEC) when a
 * running world has invited players queued but NO human GM connected. It joins
 * the live world as the platform's role-4 service-GM and runs the in-world
 * cfg-foundry-plugin ProvisionDrain — the EXACT class a human GM's browser runs
 * — until the queue is idle, then exits.
 *
 * It NEVER POSTs /quit (that would kill the world for everyone); it just closes
 * the browser. Config is supplied by the core-server launcher via env. The
 * credential is core-server's resolveServiceGmCredential (nativeUserId + the
 * per-(installation,world)-derived password); the on-disk User doc was
 * bootstrapped offline at world pre-launch (ensureServiceGmUser).
 */
import { chromium } from '@playwright/test'

const env = (k, d) => process.env[k] ?? d
const FOUNDRY_URL = env('FOUNDRY_URL') // e.g. http://cfg-foundry-<install>:30000
const USERID = env('SERVICE_GM_USERID')
const PASSWORD = env('SERVICE_GM_PASSWORD')
const CORE_API_URL = env('CORE_API_URL')
const CORE_API_KEY = env('CORE_API_KEY', '')
const INSTALLATION_ID = env('INSTALLATION_ID')
const MAX_MS = Number(env('DRAIN_MAX_MS', '120000'))
const IDLE_TICKS = Number(env('DRAIN_IDLE_TICKS', '3'))
const INTERVAL_MS = Number(env('DRAIN_INTERVAL_MS', '2000'))

if (!FOUNDRY_URL || !USERID || !PASSWORD || !CORE_API_URL || !INSTALLATION_ID) {
  console.error(
    'service-gm driver: missing env (need FOUNDRY_URL, SERVICE_GM_USERID, SERVICE_GM_PASSWORD, CORE_API_URL, INSTALLATION_ID)',
  )
  process.exit(2)
}

// CHROMIUM_PATH lets a slim image point at a SYSTEM chromium (e.g. Alpine's) and
// skip Playwright's ~1GB bundled download; unset = Playwright's bundled chromium.
const launchOpts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }
if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH
const browser = await chromium.launch(launchOpts)
let code = 1
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  const page = await ctx.newPage()

  // /join handshake as the service-GM (page.request shares the context cookie jar).
  await page.request.get(`${FOUNDRY_URL}/join`)
  const r = await page.request.post(`${FOUNDRY_URL}/join`, { form: { action: 'join', userid: USERID, password: PASSWORD } })
  const body = await r.text()
  if (!body.includes('LoginSuccess')) throw new Error(`/join rejected the service-GM credential: ${body.slice(0, 160)}`)

  await page.goto(`${FOUNDRY_URL}/game`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => globalThis.game?.ready === true && globalThis.game.user?.isGM === true, undefined, {
    timeout: 90_000,
  })

  // Run the real plugin ProvisionDrain until the queue is idle.
  const { created } = await page.evaluate(
    async ({ coreUrl, coreKey, installationId, maxMs, idleTicks, intervalMs }) => {
      const { CoreAPIClient } = await import('/modules/crit-fumble-core/scripts/clients/api-client.js')
      const { ProvisionDrain } = await import('/modules/crit-fumble-core/scripts/services/provision-drain.js')
      const drain = new ProvisionDrain(new CoreAPIClient(coreUrl, coreKey || null), installationId)
      const start = Date.now()
      let created = 0
      let idle = 0
      while (Date.now() - start < maxMs && idle < idleTicks) {
        const before = globalThis.game.users.size
        await drain._tick()
        if (globalThis.game.users.size > before) {
          created += globalThis.game.users.size - before
          idle = 0
        } else {
          idle++
        }
        await new Promise((res) => setTimeout(res, intervalMs))
      }
      return { created }
    },
    { coreUrl: CORE_API_URL, coreKey: CORE_API_KEY, installationId: INSTALLATION_ID, maxMs: MAX_MS, idleTicks: IDLE_TICKS, intervalMs: INTERVAL_MS },
  )
  console.log(`service-gm driver: drain idle, created ${created} user(s) — exiting`)
  code = 0
} catch (err) {
  console.error('service-gm driver failed:', err?.message ?? err)
  code = 1
} finally {
  // Close the browser — NEVER POST /quit (that would stop the world for everyone).
  await browser.close().catch(() => {})
}
process.exit(code)
