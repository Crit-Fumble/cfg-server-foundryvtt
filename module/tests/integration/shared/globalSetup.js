/**
 * Playwright globalSetup — runs once before all integration tests.
 *
 * 1. Waits for FoundryVTT to be ready (polls /api/status)
 * 2. Logs into Foundry as GM via headless Playwright browser
 * 3. Enables the crit-fumble-core module. It has no settings to inject: a member's
 *    page holds no platform credential (cs#543).
 * 4. Saves GM storage state so test projects skip re-login
 *
 * Env vars (from tests/.env.test):
 *   FOUNDRY_URL                — default http://localhost:30000
 */

import { chromium } from '@playwright/test'
import { mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { ensureInGame } from './foundry-login.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = join(__dirname, '../../.auth')
const AUTH_FILE = join(AUTH_DIR, 'foundry.json')

const FOUNDRY_URL = process.env.FOUNDRY_URL || 'http://localhost:30000'

const POLL_MS = 5_000
const TIMEOUT_MS = 180_000

const MODULE_ID = 'crit-fumble-core'

// ── Helpers ──────────────────────────────────────────────────────────────────

async function waitForFoundry() {
  const start = Date.now()
  console.log(`[globalSetup] Waiting for Foundry at ${FOUNDRY_URL}/api/status ...`)
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      const res = await fetch(`${FOUNDRY_URL}/api/status`)
      if (res.ok) {
        console.log(`[globalSetup] Foundry ready (${Math.round((Date.now() - start) / 1000)}s)`)
        return
      }
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
    process.stdout.write('.')
  }
  throw new Error(`[globalSetup] Foundry did not become ready within ${TIMEOUT_MS / 1000}s`)
}

async function enableModule(page) {
  // A pristine world has no modules enabled. Flip crit-fumble-core on in
  // core.moduleConfiguration (the same setting the Manage Modules dialog writes)
  // and reload so the module actually initialises — its settings + window.CFGCore
  // only exist once it has run. Idempotent: a no-op if already enabled.
  const enabled = await page.evaluate(async (moduleId) => {
    const cfg = { ...(game.settings.get('core', 'moduleConfiguration') || {}) }
    if (cfg[moduleId]) return false
    cfg[moduleId] = true
    await game.settings.set('core', 'moduleConfiguration', cfg)
    return true
  }, MODULE_ID)

  if (enabled) {
    console.log('[globalSetup] Enabled crit-fumble-core — reloading world')
    await page.reload()
    await page.waitForSelector('#sidebar', { timeout: 90_000 })
    await page.waitForFunction(() => window.game?.ready, { timeout: 60_000 })
  }

  const active = await page.evaluate((id) => game.modules.get(id)?.active ?? false, MODULE_ID)
  if (!active) throw new Error('[globalSetup] crit-fumble-core failed to activate after enabling')
  console.log('[globalSetup] crit-fumble-core module active')
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default async function globalSetup() {
  await waitForFoundry()
  await mkdir(AUTH_DIR, { recursive: true })

  const browser = await chromium.launch()
  const context = await browser.newContext({ baseURL: FOUNDRY_URL })
  const page = await context.newPage()

  try {
    await ensureInGame(page)
    console.log('[globalSetup] Logged in as GM')
    await enableModule(page)
    await context.storageState({ path: AUTH_FILE })
    console.log(`[globalSetup] Auth state saved to ${AUTH_FILE}`)
    // Don't game.logOut() here — it destroys the session we just saved. Closing
    // the context drops the websocket, freeing the single GM slot; each later
    // project's ensureInGame() re-joins as GM (kicking any stale connection).
  } finally {
    await browser.close()
  }
}
