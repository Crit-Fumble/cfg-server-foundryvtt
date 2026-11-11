/**
 * CFG Server Manager (module id stays `crit-fumble-core` — see module.json)
 * Foundry VTT plugin for Crit-Fumble Gaming platform integration.
 *
 * A member's tab holds no platform credential and calls no platform API (owner,
 * 2026-11-11, cs#543). Any module or system a member installs runs in this same page,
 * so whatever this page can read, they can. Everything that needs a credential runs on
 * the server: core-server writes a stopped world's files, reads a running world from
 * Foundry's own `/api/status`, and the headless service-GM creates live seats.
 *
 * What runs in a member's tab:
 *   - A loading overlay over the cold-load black screen, gone at `ready`
 *   - The File Picker opens in the world's assets/ folder
 *   - In a GM's tab, a GM-presence beacon: one same-origin request every 30 s. The
 *     platform reads who sent it from the sign-in it already checks on every request,
 *     so the request carries nothing (cs#543).
 *   - In a GM's tab, removal of the credentials older versions stored
 *
 * The module ships no platform client at all. Live seats are the service-GM's: its
 * container (agent/driver.mjs) calls core itself and only creates the User in the page.
 *
 * This file is the ONLY esmodule entry (module.json), so "reachable from here" is the
 * whole of the page's plugin. If you add a file nothing imports or loads, it is dead —
 * it will still ship in the zip and still read like production code.
 */

import { FilePickerCompat } from './utils/file-picker-compat.js'
import { tabTurn } from './services/tab-lock.js'
import { mountLoadingOverlay, unmountLoadingOverlay } from './views/loading-overlay.js'

// Cover the cold-load black screen as early as possible. This esmodule
// evaluates before `init` fires, while Foundry is still streaming world data +
// modules, so mounting here (not from a hook) is what puts something on screen
// during the longest part of the wait. Torn down at the `ready` hook below.
mountLoadingOverlay()

const MODULE_ID = 'crit-fumble-core'
// Derived from module.json AT RUNTIME (game.modules is populated before any
// hook fires): module.json is the ONLY version source.
const MODULE_VERSION = () => game.modules?.get?.(MODULE_ID)?.version ?? 'unknown'

// One request every 30 s keeps a quiet GM counted: core treats a GM unseen for three
// minutes as gone (cfg-core-server gm-presence.ts).
const GM_BEACON_MS = 30_000

window.CFGCore = {
  get version() {
    return MODULE_VERSION()
  },
}

/**
 * Delete the orphan WORLD-scoped `apiKey` row left behind by module <= 3.1.0
 * (cs#390). GM-only, idempotent, non-fatal.
 *
 * Foundry ships every WORLD setting to every connecting client, so a leftover row
 * puts a `cfk_`-shaped value in front of every client. Nothing reads the setting
 * any more, so a row for it can only be a leftover. Runs on every GM load, so a
 * world reaches a clean state on its next relaunch with no operator step.
 */
async function purgeLegacyWorldApiKey() {
  // Deleting a Setting document requires GM.
  if (game.user?.isGM !== true) return
  try {
    const world = game.settings?.storage?.get?.('world')
    if (!world?.getSetting) return
    // Second argument is the USER id for user-scoped rows; null is the
    // world-scoped row, which is the only one this ever touches.
    const doc = world.getSetting(`${MODULE_ID}.apiKey`, null)
    if (!doc) return
    await doc.delete()
    console.log('CFG Core | removed the legacy world-scoped apiKey setting (cs#390)')
  } catch (err) {
    // Never break a world load over cleanup. The key it referenced is revoked
    // server-side; a surviving row is untidy, not dangerous.
    console.warn('CFG Core | could not remove the legacy world-scoped apiKey setting:', err?.message || err)
  }
}

/**
 * Remove the key module 3.2.0 to 3.3.x kept in this browser's localStorage (a
 * client-scoped setting, `<module>.<key>`). Any script on this page can read
 * localStorage; a key nothing uses must not sit there.
 */
function forgetStoredClientKey() {
  try {
    globalThis.localStorage?.removeItem(`${MODULE_ID}.apiKey`)
  } catch {
    // Storage blocked: there is nothing stored to remove either.
  }
}

/**
 * GM-presence beacon (cs#543): a GM's tab requests this world's own `api/status`
 * every 30 s. The request passes the platform's sign-in check like every other
 * request to the world, and that check records that a GM of the world is here,
 * which keeps a world its GM marked inactive from stopping under them. Nothing
 * secret rides it, and nothing comes back that the page does not already have.
 *
 * One tab per browser (services/tab-lock.js), and none while the tab's socket is
 * down: a tab cut off from its world must not say a GM is in it.
 */
function startGmBeacon() {
  if (game.user?.isGM !== true) return
  const url = foundry.utils.getRoute('api/status')
  const send = () => {
    if (game.socket?.connected === false) return
    fetch(url, { cache: 'no-store', credentials: 'same-origin' }).catch(() => {})
  }
  tabTurn(`${game.world?.id}:${game.user?.id}`).then(() => {
    send()
    setInterval(send, GM_BEACON_MS)
  })
}

Hooks.once('init', () => {
  console.log(`CFG Core | Initializing v${MODULE_VERSION()}`)
})

Hooks.once('ready', async () => {
  // The cold-load black screen is over once Foundry is ready — drop the overlay.
  unmountLoadingOverlay()

  forgetStoredClientKey()
  await purgeLegacyWorldApiKey()

  // Steer FilePicker away from User Data root, where Foundry blocks uploads
  // (modules/ and systems/ are overwritten on updates). Point it at the
  // current world's assets/ folder — pre-created server-side on provision.
  try {
    const FP = FilePickerCompat.getClass()
    if (FP && game.world?.id) {
      FP.LAST_BROWSED_DIRECTORY = `worlds/${game.world.id}/assets`
    }
  } catch (err) {
    console.warn('CFG Core | FilePicker default path setup failed (non-fatal):', err)
  }

  startGmBeacon()

  console.log('CFG Core | Ready')
})
