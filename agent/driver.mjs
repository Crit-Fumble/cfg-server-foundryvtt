#!/usr/bin/env node
/**
 * Service-GM drain driver — the production one-shot.
 *
 * The platform spawns this as a SIBLING container (next to the Foundry container, not
 * inside it — prod's docker-socket-proxy denies EXEC) when a running world has invited
 * players queued, whether or not a human GM is connected: only the service-GM creates
 * live seats (owner, 2026-11-11, cs#543). It joins the live world as the platform's
 * role-4 service-GM, creates each queued Foundry user, confirms it to core, and exits
 * once the queue stays empty.
 *
 * Two halves, on purpose:
 *   - Core is called from THIS process, never from the page. The page's origin is the
 *     container's own address, which core's CORS does not admit, and the queue carries
 *     seat passwords that no page script should see.
 *   - Only `User.create` runs in the page, because Foundry lets only a connected GM
 *     client create a User while the world runs.
 *
 * FOUNDRY_URL includes the world's route prefix (`http://localhost:30000/<prefix>`):
 * Foundry serves `/join`, `/game` and every asset under it.
 *
 * It NEVER POSTs /quit (that would kill the world for everyone); it just closes the
 * browser. Config is supplied by the core-server launcher via env. The credential is
 * core-server's resolveServiceGmCredential (nativeUserId + the per-(installation,world)
 * derived password); the on-disk User doc was bootstrapped offline at world pre-launch
 * (ensureServiceGmUser). CORE_API_KEY is a short-lived token bound to this installation.
 */
import { chromium } from '@playwright/test'

const env = (k, d) => process.env[k] ?? d
const FOUNDRY_URL = env('FOUNDRY_URL', '').replace(/\/$/, '') // e.g. http://localhost:30000/servers/foundryvtt/<slug>
const USERID = env('SERVICE_GM_USERID')
const PASSWORD = env('SERVICE_GM_PASSWORD')
const CORE_API_URL = env('CORE_API_URL', '').replace(/\/$/, '')
const CORE_API_KEY = env('CORE_API_KEY', '')
const INSTALLATION_ID = env('INSTALLATION_ID')
const MAX_MS = Number(env('DRAIN_MAX_MS', '120000'))
const IDLE_TICKS = Number(env('DRAIN_IDLE_TICKS', '3'))
const INTERVAL_MS = Number(env('DRAIN_INTERVAL_MS', '2000'))
const REQUEST_TIMEOUT_MS = 20_000

// The module id the created users are flagged under; the e2e suites look for it.
const MODULE_ID = 'crit-fumble-core'

if (!FOUNDRY_URL || !USERID || !PASSWORD || !CORE_API_URL || !CORE_API_KEY || !INSTALLATION_ID) {
  console.error(
    'service-gm driver: missing env (need FOUNDRY_URL, SERVICE_GM_USERID, SERVICE_GM_PASSWORD, CORE_API_URL, CORE_API_KEY, INSTALLATION_ID)',
  )
  process.exit(2)
}

/** One call to core, from this process. Throws on anything but a 2xx. */
async function core(path, init = {}) {
  const res = await fetch(`${CORE_API_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${CORE_API_KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`core answered ${res.status} for ${init.method ?? 'GET'} ${path.split('?')[0]}`)
  return res.json()
}

const queuePath = `/api/v1/installations/${encodeURIComponent(INSTALLATION_ID)}/foundry/pending-provisions`

/**
 * In the page: create one reserved user with the platform's id and derived password,
 * or find it already there. Foundry enforces unique names, so a name a native user
 * already holds gets a suffix; the id and password are what sign-in needs.
 */
function createReservedUser({ p, moduleId }) {
  const game = globalThis.game
  if (game.users.get(p.nativeUserId)) return { created: false }
  let name = p.foundryUsername
  if (game.users.some((u) => u.name === name)) name = `${name} [${p.nativeUserId.slice(0, 4)}]`.slice(0, 32)
  return globalThis.User.create(
    {
      _id: p.nativeUserId,
      name,
      role: p.role,
      // Raw: Foundry hashes it on create, so the proxy's /join with the same derived password validates.
      password: p.password,
      flags: { [moduleId]: { cfgRuntimeProvisioned: true, provisionedAt: Date.now() } },
    },
    { keepId: true },
  ).then((user) => {
    if (!user) throw new Error('User.create returned null')
    return { created: true }
  })
}

const launchOpts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }
// CHROMIUM_PATH lets a slim image point at a SYSTEM chromium and skip Playwright's bundled one.
if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH
const browser = await chromium.launch(launchOpts)

let code = 1
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  const page = await ctx.newPage()

  // /join handshake as the service-GM (page.request shares the context cookie jar).
  await page.request.get(`${FOUNDRY_URL}/join`)
  // Both id keys: Foundry <= 14.363 reads `userid`, >= 14.367 reads `userId` (core-server's own
  // join, foundry-player-session.ts, sends both for the same reason).
  const r = await page.request.post(`${FOUNDRY_URL}/join`, {
    form: { action: 'join', userid: USERID, userId: USERID, password: PASSWORD },
  })
  const body = await r.text()
  if (!/LoginSuccess|"status"\s*:\s*"success"/.test(body)) {
    throw new Error(`/join rejected the service-GM credential: ${body.slice(0, 160)}`)
  }

  await page.goto(`${FOUNDRY_URL}/game`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => globalThis.game?.ready === true && globalThis.game.user?.isGM === true, undefined, {
    timeout: 90_000,
  })
  const worldId = await page.evaluate(() => globalThis.game.world.id)

  const start = Date.now()
  let created = 0
  let idle = 0
  while (Date.now() - start < MAX_MS && idle < IDLE_TICKS) {
    const res = await core(`${queuePath}?world=${encodeURIComponent(worldId)}`)
    const pending = Array.isArray(res?.data) ? res.data : []
    if (pending.length === 0) {
      idle++
    } else {
      idle = 0
      for (const p of pending) {
        try {
          if (!p?.nativeUserId || !p?.foundryUsername) throw new Error('malformed provision')
          const out = await page.evaluate(createReservedUser, { p, moduleId: MODULE_ID })
          if (out.created) created++
          await core(`${queuePath}/confirm`, { method: 'POST', body: JSON.stringify({ world: worldId, nativeUserId: p.nativeUserId }) })
          console.log(`service-gm driver: seat ${p.nativeUserId} ${out.created ? 'created' : 'already present'} and confirmed`)
        } catch (err) {
          // One bad seat must not stall the rest; the next pass retries it (confirm only follows a create).
          console.warn(`service-gm driver: seat ${p?.nativeUserId ?? '?'} failed: ${err?.message ?? err}`)
        }
      }
    }
    await new Promise((res) => setTimeout(res, INTERVAL_MS))
  }
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
