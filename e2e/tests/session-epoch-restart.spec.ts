import { test, expect } from '@playwright/test'
import http from 'node:http'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchWorld, waitForWorldActive } from '../helpers/foundry-admin'
import { SERVICE_GM } from '../helpers/service-gm'

/**
 * REAL-Foundry proof for the v1.26.0 epoch-keyed player-session cache
 * (cfg-core-server `fix(foundry): epoch-key player-session cache …`, be21679).
 *
 * This closes the exact integration gap that let the /join bug ship to prod:
 * nothing exercised the REAL `getPlayerCookie` against a REAL Foundry across a
 * process restart. Every prior layer was tested against a fake or bypassed
 * Foundry. Here we drive the actual code under test:
 *
 *   1. mint a session via the real `getPlayerCookie` (epoch = container StartedAt)
 *      and prove it loads the game (HTTP 200);
 *   2. `docker restart` the Foundry container (new process → new StartedAt) and
 *      re-activate the world (options.world is null in v14, so it must relaunch);
 *   3. prove the OLD cookie is now DEAD — Foundry 302→/join — i.e. the in-memory
 *      session did NOT survive the restart (the precise failure mode behind the
 *      production bug, here proven against real Foundry rather than assumed);
 *   4. prove `getPlayerCookie`, given the NEW epoch, RE-MINTS (cache invalidated
 *      by the epoch change) and the new session loads the game (200);
 *   5. prove a same-epoch call is a cache hit (no churn).
 *
 * Preconditions (satisfied by run.sh + global-setup): the standalone harness
 * Foundry is up + the test-world is active + the service-GM doc is seeded, and
 * cfg-core-server's `dist` is built (the real code we import). NODE_ENV=test so
 * the transitively-imported serverConfig warns instead of throwing on absent app
 * env. Run: `bash e2e/run.sh session-epoch-restart`.
 */

const CONTAINER = process.env.E2E_FOUNDRY_CONTAINER ?? 'cfg-server-foundryvtt-e2e'
const WORLD = process.env.FOUNDRY_WORLD ?? 'test-world'
const PORT = process.env.E2E_FOUNDRY_PORT ?? '30001'
const BASE = `http://localhost:${PORT}`

/** Raw GET /game (no redirect-follow) so we see Foundry's real verdict: 200 = a
 *  valid session loads the game; 302→/join = the session is rejected. */
function gameStatus(cookie: string): Promise<{ status: number; location: string }> {
  return new Promise((res, rej) => {
    const req = http.request(`${BASE}/game`, { method: 'GET', headers: { cookie, accept: 'text/html' } }, (r) => {
      r.resume()
      res({ status: r.statusCode ?? 0, location: (r.headers.location as string) ?? '' })
    })
    req.on('error', rej)
    req.end()
  })
}

function dockerStartedAt(container: string): string {
  return execSync(`docker inspect ${container} --format '{{.State.StartedAt}}'`).toString().trim()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** After a restart, wait for Foundry's HTTP to answer, then relaunch + await the world. */
async function reactivateWorld(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const up = await new Promise<boolean>((res) => {
      const req = http.request(`${BASE}/`, { method: 'GET', timeout: 3000 }, (r) => {
        r.resume()
        res(true)
      })
      req.on('error', () => res(false))
      req.on('timeout', () => {
        req.destroy()
        res(false)
      })
      req.end()
    })
    if (up) break
    await sleep(2000)
  }
  // launchWorld is idempotent; give Foundry's admin API a moment if it 500s mid-boot.
  for (let i = 0; i < 5; i++) {
    try {
      await launchWorld(BASE, WORLD)
      break
    } catch {
      await sleep(2000)
    }
  }
  await waitForWorldActive(BASE)
}

test('v1.26.0: a Foundry restart invalidates the cached player cookie; getPlayerCookie re-mints on the new epoch', async () => {
  test.setTimeout(180_000)

  // Import the REAL fix under test from the built dist. cfg-core-server's config
  // loader reads config/<appEnv>.json relative to process.cwd(), so chdir into
  // that package for the import, then restore. NODE_ENV=test selects config/test.json
  // and makes the transitively-imported serverConfig warn (not throw) on absent env.
  process.env.NODE_ENV = 'test'
  const coreRoot = resolve(process.cwd(), '..', 'cfg-core-server')
  const distRoot = resolve(coreRoot, 'dist')
  const harnessCwd = process.cwd()

  type SessionMod = { getPlayerCookie: (t: Record<string, unknown>) => Promise<string>; clearAllPlayerCookies: () => void }
  let sessionMod: SessionMod | null = null
  process.chdir(coreRoot)
  try {
    sessionMod = (await import(pathToFileURL(resolve(distRoot, 'services/foundry/foundry-player-session.js')).href)) as SessionMod
  } finally {
    process.chdir(harnessCwd)
  }
  if (!sessionMod) throw new Error('failed to import getPlayerCookie from cfg-core-server/dist — is it built?')
  const { getPlayerCookie, clearAllPlayerCookies } = sessionMod
  clearAllPlayerCookies() // isolate the in-process cache for this proof
  // Epoch source = the container's StartedAt via the docker CLI (reliable from the
  // host; getDockerClient resolves a socket-proxy that isn't reachable here). This
  // is the same value resolveContainerEpoch reads via inspect in prod (client.ts).

  const target = (epoch: string) => ({
    containerName: CONTAINER,
    upstream: BASE,
    routePrefix: '', // standalone Foundry serves at root (no proxy route prefix)
    nativeUserId: SERVICE_GM.nativeUserId,
    password: SERVICE_GM.password,
    epoch,
  })

  // ── Epoch 1: the world is active (global-setup launched it) ──────────────
  const epoch1 = dockerStartedAt(CONTAINER)
  expect(epoch1, 'running container exposes a StartedAt').toBeTruthy()
  console.log(`[proof] epoch1=${epoch1}`)

  const cookie1 = await getPlayerCookie(target(epoch1))
  expect(cookie1, 'getPlayerCookie mints a session cookie').toMatch(/^session=/)
  const live1 = await gameStatus(cookie1)
  console.log(`[proof] minted cookie1; GET /game -> ${live1.status}`)
  expect(live1.status, 'the freshly-minted session loads the game').toBe(200)

  // ── Restart the Foundry process (new StartedAt) + re-activate the world ──
  console.log('[proof] restarting Foundry container…')
  execSync(`docker restart ${CONTAINER}`, { stdio: 'ignore' })
  await reactivateWorld()

  const epoch2 = dockerStartedAt(CONTAINER)
  console.log(`[proof] epoch2=${epoch2} (changed=${epoch2 !== epoch1})`)
  expect(epoch2, 'StartedAt changes across a process restart (the epoch the fix keys on)').not.toBe(epoch1)

  // ── Crux 1: the OLD cookie is DEAD — Foundry sessions don't survive a restart ──
  const dead = await gameStatus(cookie1)
  console.log(`[proof] old cookie after restart: GET /game -> ${dead.status} ${dead.location}`)
  expect(dead.status, `old session must be rejected after restart (got ${dead.status} → ${dead.location})`).not.toBe(200)

  // ── Crux 2: getPlayerCookie RE-MINTS on the epoch change (the v1.26.0 fix) ──
  const cookie2 = await getPlayerCookie(target(epoch2))
  const live2 = await gameStatus(cookie2)
  console.log(`[proof] re-minted cookie2 (new=${cookie2 !== cookie1}); GET /game -> ${live2.status}`)
  expect(cookie2, 'an epoch change forces a re-mint (a different, live session)').not.toBe(cookie1)
  expect(live2.status, 'the re-minted session loads the game').toBe(200)

  // ── Same epoch → cache hit (no per-asset re-mint churn within one process) ──
  expect(await getPlayerCookie(target(epoch2)), 'a same-epoch call returns the cached cookie').toBe(cookie2)
  console.log('[proof] same-epoch call hit cache ✓ — all assertions passed')
})
