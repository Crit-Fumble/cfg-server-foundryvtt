/**
 * CFG Server Manager (module id stays `crit-fumble-core` — see module.json)
 * Foundry VTT plugin for Crit-Fumble Gaming platform integration.
 *
 * Extracted from cfg-foundry-plugin at 2.48.3; the 3D overlay (overlay-3d.js +
 * overlay3d/* + three.bundle.js and its module.js hooks) stayed behind there to
 * become its own optional module — nothing in this tree may import it.
 *
 * What this module ACTUALLY does today (verified fp#47 — the previous list was
 * aspirational and named several things that have never been wired):
 *   - Campaign linking — Module Settings → Linked Campaigns (GM-only)
 *   - Runtime player provisioning — creates the Foundry Users the platform
 *     reserved, so the proxy can SSO invited players (ProvisionDrain, GM-only)
 *   - Activity heartbeat (drives idle auto-stop) + the once-per-load world status ping
 *   - Edit-JSON button on document sheets (local; no platform traffic)
 *   - Connection banner (offline pill)
 *
 * NO document sync (owner, 2026-10-03). The world snapshot pushes and every
 * Core→Foundry write-back courier were cut: the platform must never be the reason
 * a hosted Foundry server is slow, and performance outranks sync completeness. The
 * platform does not write into a live world. `git log` has the services.
 *
 * NOT present, though older docs claimed them: party roster, session tracker,
 * campaign filter, chat unification, quest sync, the iframe VTT bridge. Those
 * files were DELETED in fp#47 — 28 modules / ~5k lines that had no importer since
 * the monorepo extraction and would have thrown if wired (they read settings that
 * were never registered). `git log` has them if any is ever wanted back.
 *
 * This file is the ONLY esmodule entry (module.json), so "reachable from here" is
 * the whole of the live plugin. If you add a file nothing imports, it is dead —
 * it will still ship in the zip and still read like production code.
 */

import { CoreAPIClient } from './clients/api-client.js'
import { CfgCampaignLinksDialog } from './views/cfg-campaign-links.js'
import { FilePickerCompat } from './utils/file-picker-compat.js'
import { applyHostedContext, getHostKind, resolveCoreEndpoint, readSeatKey, renewSeatKey, settleSeatKeyRenewal } from './auth/host-context.js'
import { mountConnectionBanner } from './views/connection-banner.js'
import { ActivityHeartbeat } from './services/activity-heartbeat.js'
import { ProvisionDrain } from './services/provision-drain.js'
import { tabTurn } from './services/tab-lock.js'
import { registerJsonEditorHeaderButton } from './views/json-editor-header-button.js'
import { mountLoadingOverlay, unmountLoadingOverlay } from './views/loading-overlay.js'
import { registerJournalIframeGuard } from './views/journal-iframes.js'

// Cover the cold-load black screen as early as possible. This esmodule
// evaluates before `init` fires, while Foundry is still streaming world data +
// modules, so mounting here (not from a hook) is what puts something on screen
// during the longest part of the wait. Torn down at the `ready` hook below.
mountLoadingOverlay()

/* -------------------------------------------- */
/*  Module-level State                           */
/* -------------------------------------------- */

const MODULE_ID = 'crit-fumble-core'
// Derived from module.json AT RUNTIME (game.modules is populated before any
// hook fires). The old hand-bumped constant here drifted from module.json TWICE
// (2.13.0 vs 2.14.0 caught by fp#47, then 2.42.0 vs 2.48.0 caught by dt#268) —
// "bump both together" is exactly the pin-without-a-bump-step failure class, so
// the constant is gone: module.json is the ONLY version source.
const MODULE_VERSION = () => game.modules?.get?.(MODULE_ID)?.version ?? 'unknown'

/**
 * CFG campaign ids that have linked THIS Foundry world via the N:M join
 * (`WorldAccessGrant` rows with `granteeType: 'campaign'`). Populated by
 * `_resolveLinkedCampaigns` in the ready hook and exposed as
 * `CFGCore.linkedCampaignIds()`; an empty list is normal for an unlinked world.
 * @type {string[]}
 */
let _linkedCampaignIds = []

/** @type {CoreAPIClient|null} */
let _api = null

/** @type {ActivityHeartbeat|null} */
let _activityHeartbeat = null

/** @type {ProvisionDrain|null} */
let _provisionDrain = null

/* -------------------------------------------- */
/*  Global Exposure                              */
/* -------------------------------------------- */

window.CFGCore = {
  get version() {
    return MODULE_VERSION()
  },
  /** @returns {string[]} Campaigns currently linked to this Foundry world via the N:M join. */
  linkedCampaignIds: () => [..._linkedCampaignIds],
  /**
   * 'cfg-hosted' when Foundry is served from CFG infrastructure (#699 detect),
   * 'self-hosted' otherwise.
   * @returns {'cfg-hosted'|'self-hosted'}
   */
  hostKind: () => getHostKind(),
  /** @type {CoreAPIClient|null} Set after init. */
  api: null,
}

/* -------------------------------------------- */
/*  Helpers                                      */
/* -------------------------------------------- */

/**
 * Default for `coreApiUrl`: the production platform (a dev stack can override it
 * via `window.CORE_API_URL` at the register site). On a cfg-hosted world the
 * platform-declared `cfg_core_endpoint` cookie overrides it at runtime; since cs#455
 * the cookie is never written over it (see the ready hook).
 *
 * ⛔ This used to answer `window.location.origin` on a `/servers/foundryvtt/`
 * path, which was core only while hosted worlds were served from core. Since
 * `foundryVttMode` 'retired' that origin is the Foundry host, and a default is
 * the one value that gets PERSISTED into world data before any cookie is read —
 * so the old branch seeded every fresh hosted world with an endpoint whose API
 * calls 302 to core and lose their POST bodies on the way (cs#414, 2026-09-15).
 * Same-origin dev/e2e stacks are covered by the cookie, which forward-auth mints
 * on both edges, not by inference from the page.
 */
function _detectDefaultCoreApiUrl() {
  return 'https://core.crit-fumble.com'
}

/**
 * Extract the installation id from the page URL when running cfg-hosted.
 * Post-route-rename, cfg-hosted Foundry is always served from
 * `/servers/foundryvtt/{installationId}/...`. Reading the path is the
 * cheapest + most reliable way to get the installation id — no
 * dependency on the proxy injecting `__CFG_HOSTED_CONTEXT__` (which is
 * stubbed for a future commit).
 *
 * Returns null on a world Crit-Fumble does not host, or when the URL
 * doesn't match the cfg-hosted route shape.
 */
function _detectInstallationIdFromUrl() {
  if (typeof window === 'undefined') return null
  try {
    const match = window.location.pathname.match(/^\/servers\/foundryvtt\/([^/]+)/)
    return match?.[1] || null
  } catch {
    return null
  }
}

/* -------------------------------------------- */
/*  Init Hook — Register Settings & Keybindings */
/* -------------------------------------------- */

Hooks.once('init', () => {
  console.log(`CFG Core | Initializing v${MODULE_VERSION()}`)

  // Cross-origin journal embeds keep working but can no longer navigate the tab (cs#455).
  registerJournalIframeGuard()

  // ---- Settings ----

  game.settings.register(MODULE_ID, 'coreApiUrl', {
    name: 'CFG Endpoint',
    hint: 'Set automatically on Crit-Fumble hosted worlds. Leave as is.',
    scope: 'world',
    // Hidden from the settings UI: the ready hook writes it on hosted worlds,
    // and connecting a world Crit-Fumble does not host is not currently supported.
    config: false,
    type: String,
    default: window.CORE_API_URL || _detectDefaultCoreApiUrl(),
  })

  // The legacy single-campaign `campaignId` setting has been retired. With
  // many-to-many linking (`WorldAccessGrant`, granteeType 'campaign'), a world can host
  // multiple campaigns and a campaign can be played across multiple worlds.
  // The Linked Campaigns dialog (game.settings.registerMenu below) is the
  // single source of truth; plugin-side flows that need a campaign id
  // iterate over the linked set returned by /api/v1/account/foundry/campaigns.

  // Set automatically on cfg-hosted worlds by applyHostedContext() (the
  // installation owner's key). Hidden from the settings UI so users can't paste
  // in arbitrary strings.
  //
  // ⛔ CLIENT SCOPE IS LOAD-BEARING — DO NOT CHANGE IT BACK TO 'world'.
  // This setting previously used `scope: 'world'`, justified by a comment
  // claiming world-scope gave the key "the same protection as other GM
  // secrets". That reasoning conflated two different things: `config: false`
  // hides the settings-UI field, but a WORLD setting is world state and
  // Foundry distributes it to connected clients. A per-account credential is
  // not world state and does not belong in one.
  //
  // 'client' stores it in that browser's localStorage, so it stays with the
  // account it was issued to. Everything that uses it (heartbeat, provision
  // drain) runs in a connected GM's own tab and reads it from there.
  //
  // Client scope costs cfg-hosted worlds nothing: applyHostedContext()
  // re-fetches the key from core on every load, in whichever browser the GM
  // uses.
  //
  // Foundry v14 also offers `scope: 'user'` (per-user, stored server-side),
  // which would keep persistence AND privacy. It is NOT used here: the
  // Setting document declares create/update/delete permissions and no READ
  // rule, so whether the server withholds another user's user-scoped setting
  // from a connecting client is not answerable from the client source — and
  // this module declares a v13 minimum. Adopting it needs that measured on a
  // real world first; 'client' is provably safe today.
  game.settings.register(MODULE_ID, 'apiKey', {
    scope: 'client',
    config: false,
    type: String,
    default: '',
  })

  // Installation id, auto-set from the hosted route path by the ready hook.
  // Not user-visible.
  game.settings.register(MODULE_ID, 'installationId', {
    scope: 'world',
    config: false,
    type: String,
    default: '',
  })

  // Host-environment detection (#699): when Foundry is cfg-hosted, the plugin
  // fetches its installation host key programmatically and stores it as the
  // Bearer `apiKey` setting. That runs in the `ready` hook (awaited, before the
  // API client is built) — see `applyHostedContext()` — so settings are live and
  // the key is in place before the first heartbeat.

  /**
   * Per-campaign officer position configuration (preset + requireLeader flag).
   * Hidden from the settings UI — currently unused by any active surface,
   * kept registered as `Object` so existing saved values don't error.
   */
  game.settings.register(MODULE_ID, 'campaignPositions', {
    scope: 'world',
    config: false,
    type: Object,
    default: {},
  })

  // ── Module Settings → Linked Campaigns ────────────────────────────────────
  // GM-only multi-link manager. The `campaignId` setting (handled by the
  // dropdown below) binds the world to ONE campaign for plugin-side sync;
  // this dialog manages the N:M database link table — "which campaigns
  // can be played in this world" — backed by /api/v1/account/foundry/campaigns.
  game.settings.registerMenu(MODULE_ID, 'campaignLinks', {
    name: 'Linked Campaigns',
    label: 'Open Linked Campaigns',
    hint: 'Manage which CFG campaigns can be played in this Foundry world. Many campaigns can share one world.',
    icon: 'fas fa-link',
    type: CfgCampaignLinksDialog,
    restricted: true,
  })

  console.log(`CFG Core | Settings and keybindings registered`)
})

// NB the 3D config-injection hooks that used to live here (Wall Config "3D
// Rendering", Scene/Level 3D wall defaults, Region 3D terrain, and the token-HUD
// "Character View" button) moved out with the 3D overlay — they write/read flags
// only the 3D viewer consumes, so they ship with the optional 3D module, not the
// Server Manager.

/* -------------------------------------------- */
/*  Ready Hook — Main Initialization            */
/* -------------------------------------------- */

/**
 * One tab per browser runs the pollers below (services/tab-lock.js). Keyed by
 * world AND user: two tabs of one user both win the reporter elections, which
 * compare user ids, so without the lock each would poll.
 */
let _tabTurn = null
function _pollerTurn() {
  _tabTurn ??= tabTurn(`${game.world?.id}:${game.user?.id}`)
  return _tabTurn
}

/**
 * Delete the orphan WORLD-scoped `apiKey` row left behind by module <= 3.1.0
 * (cs#390). GM-only, idempotent, non-fatal.
 *
 * ⛔ WHY THE SCOPE CHANGE ALONE DID NOT CLOSE THE FINDING. Registering the
 * setting as `scope: 'client'` in 3.2.0 stops the module READING the world row —
 * it does not remove it. Foundry's own `ClientSettings#register` says so:
 *
 *     if ( data.scope !== CONST.SETTING_SCOPES.CLIENT ) {
 *       this.storage.get("world").getSetting(data.id, userId)?.reset()
 *     }
 *
 * client scope is precisely the branch that skips the world storage. So on every
 * world paired under an older module the row survives, and Foundry ships every
 * WORLD setting to every connecting client in the world data payload — which is
 * the whole of the original finding, still live, for a module that now looks
 * fixed. Measured on a production world after 3.2.0 shipped: the row was still
 * there, holding a `cfk_`-shaped value.
 *
 * Deleting it is safe because 3.2.0 no longer reads it: the live key lives in
 * this browser's localStorage under the client-scoped registration. A world row
 * for this key can only be a leftover.
 *
 * Self-healing by design — this runs on every GM load, so a world reaches a
 * clean state on its next relaunch with no operator step and no migration
 * script, self-hosted worlds included.
 */
async function purgeLegacyWorldApiKey() {
  // Deleting a Setting document requires GM; a player attempting it just logs a
  // permission error, which is the noise the surrounding code already avoids.
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

Hooks.once('ready', async () => {
  console.log(`CFG Core | Ready`)

  // The cold-load black screen is over once Foundry is ready — drop the overlay.
  unmountLoadingOverlay()

  // World-scoped settings can only be written by a GM. A Trusted Player's client
  // throwing `lacks permission to update Setting` on every load is pure noise
  // (session-zero prod logs: players 401'd writing installationId + coreApiUrl),
  // and players don't need these persisted — they resolve the endpoint from the
  // platform-declared cookie below. So the setting writes here are GM-only.
  const isGM = game.user?.isGM === true
  const onHostedPath =
    typeof window !== 'undefined' && window.location?.pathname?.startsWith('/servers/foundryvtt/') === true

  // BEFORE anything else touches the key: drop the pre-3.2.0 world-scoped row.
  // Ordering is deliberate — applyHostedContext() below writes the CLIENT-scoped
  // key, and doing the purge first means a single load ends with exactly one
  // copy of the credential, in the right place.
  await purgeLegacyWorldApiKey()

  // Auto-correct `coreApiUrl` + `installationId` when running cfg-hosted
  // (proxied at `/servers/foundryvtt/{installationId}/*`). Existing worlds may
  // carry a stale endpoint — the prod URL on a localdev / staging / tunnel stack,
  // or the Foundry host itself on a world seeded by the pre-cs#414 default. The
  // platform-declared `cfg_core_endpoint` cookie (minted on both edges) overrides it
  // at runtime but is no longer written back (cs#455, below); only an injected
  // context is. The installationId derives from the page path so the
  // plugin doesn't depend on `__CFG_HOSTED_CONTEXT__` injection. Idempotent:
  // only writes on actual change, GM-only.
  try {
    if (isGM && onHostedPath) {
      // ⛔ Was `window.location.origin`. That is core ONLY while hosted Foundry is
      // served from core itself; since cs#391 it is the Foundry host, and writing it
      // here PERSISTS the wrong endpoint into world data — outliving the page and
      // clobbering the correct value applyHostedContext just fetched from the server.
      // Resolve instead, and never overwrite a server-DECLARED endpoint.
      //
      // ⛔ Only the INJECTED context is persisted, never the cookie (cs#455 F1). The
      // cookie jar is shared by every world on the Foundry host, so a cookie value is
      // something another world may have written; `coreApiUrl` is WORLD data that every
      // client of this world falls back to, across sessions. A cookie is used for this
      // page load (`apiUrl` below) and re-minted on every navigation, so persisting it
      // bought only the lapsed-cookie fallback, which the registered default covers in
      // prod. A cookie-declared endpoint is still `declared`, so it is not overwritten
      // by the undeclared branch below either.
      const resolved = resolveCoreEndpoint()
      const storedUrl = game.settings.get(MODULE_ID, 'coreApiUrl')
      if (resolved.declared) {
        if (resolved.source === 'injected' && storedUrl !== resolved.endpoint) {
          await game.settings.set(MODULE_ID, 'coreApiUrl', resolved.endpoint)
          console.log(`CFG Core | coreApiUrl set from the platform-declared endpoint ${resolved.endpoint} (was ${storedUrl})`)
        }
      } else if (resolved.endpoint && storedUrl !== resolved.endpoint) {
        // Undeclared = no cookie, no injected context — and since cs#414 the resolver's
        // only source left is the stored setting itself, so `resolved.endpoint` IS
        // `storedUrl` (or null) and this cannot fire. That is the point: a lapsed
        // cookie must never become a write, and the page origin is no longer anything
        // the resolver can hand back. Kept as the undeclared half of the split; a no-op.
        await game.settings.set(MODULE_ID, 'coreApiUrl', resolved.endpoint)
        console.log(`CFG Core | coreApiUrl auto-corrected to ${resolved.endpoint} (was ${storedUrl})`)
      }

      const detectedInstallId = _detectInstallationIdFromUrl()
      if (detectedInstallId) {
        const storedInstallId = game.settings.get(MODULE_ID, 'installationId')
        if (storedInstallId !== detectedInstallId) {
          await game.settings.set(MODULE_ID, 'installationId', detectedInstallId)
          console.log(`CFG Core | installationId auto-corrected to ${detectedInstallId} (was ${storedInstallId || 'unset'})`)
        }
      }
    }
  } catch (err) {
    console.warn('CFG Core | host-context auto-correct failed (non-fatal):', err?.message || err)
  }

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

  // Programmatic pairing: for cfg-hosted Foundry, fetch + store the installation
  // host key (Bearer) BEFORE building the API client, so the heartbeats
  // authenticate as the installation. Owner-scoped on the server; a non-owner GM
  // gets no key and `applyHostedContext` clears any stale one → session fallback.
  // Awaited so the setting is live before the first heartbeat fires below.
  // GM-only: it writes world settings, and a non-GM never receives a key — a
  // player stays on same-origin session auth (apiKey below resolves to null).
  if (isGM && getHostKind() === 'cfg-hosted') {
    try {
      await applyHostedContext()
    } catch (err) {
      console.warn('CFG Core | applyHostedContext failed (non-fatal, using session auth):', err?.message || err)
    }
  }

  // The resolver, never `location.origin`: the platform-declared cookie when it is
  // present — the only channel a non-GM player (who no longer writes `coreApiUrl`
  // above) has, and what a same-origin dev/e2e stack gets too — else the stored
  // setting. On the Foundry host the page origin 302s every API call to core and
  // downgrades the POSTs to GET (cs#414), so it is not in the precedence at all.
  // The `||` is belt-and-braces: the resolver's own last step is this setting.
  const apiUrl = resolveCoreEndpoint().endpoint || game.settings.get(MODULE_ID, 'coreApiUrl')
  // cfg-hosted gets an installation key from `applyHostedContext` (programmatic
  // pairing) or, if that couldn't mint one, an empty value → session-cookie auth
  // (same-origin). An empty/absent setting → null → session-cookie auth.
  // Seat key first: it is per-browser, short-lived and scoped to THIS seat, whereas
  // the `apiKey` world setting is the installation OWNER's key that every seated
  // player can read (cs#390). Once the platform sends a seat key, prefer it — and
  // it is the only credential a non-owner GM or player has once core is a different
  // origin, where same-origin cookie auth stops working. Absent today → unchanged.
  const apiKey = readSeatKey() || game.settings.get(MODULE_ID, 'apiKey') || null

  // apiKey set → Bearer token (seat key or installation key). Null →
  // same-origin session-cookie auth (cfg-hosted non-owner GM fallback). A 401 renews
  // the seat key and retries once (cs#414): the key lives 12h, a session is one page load.
  _api = new CoreAPIClient(apiUrl, apiKey, { renewKey: renewSeatKey, onRenewed: settleSeatKeyRenewal })
  window.CFGCore.api = _api
  console.log(`CFG Core | Auth mode: ${apiKey ? 'Bearer key' : 'session cookie'}`)

  // Resolve the campaigns linked to this Foundry world (N:M join, source of
  // truth lives in the platform DB), exposed as `CFGCore.linkedCampaignIds()`.
  // An empty list is fine.
  _linkedCampaignIds = await _resolveLinkedCampaigns()

  // Link this Foundry user to their platform account. Stays on the critical
  // path: the user link is what SSO'd players wait on.
  await _linkPlatformUser()

  // The boot pushes of `game.modules` + the pack index (#339, dt#185) and of the
  // system schema (dt#212) are gone with the sync: the module list is read from
  // disk by core, and the pack index + schema fed only the cut import/compendium paths.

  // Active-user heartbeat (cfs#109) — reports game.users.active to Core so
  // server-side idle-shutdown automation has a real signal. Only runs when
  // this world is linked to an installation (cfg-hosted, or a world paired by
  // an older module); the single-reporter election lives inside the class.
  const heartbeatInstallId = game.settings.get(MODULE_ID, 'installationId') || null
  if (heartbeatInstallId) {
    _activityHeartbeat = new ActivityHeartbeat(_api, heartbeatInstallId)
    _pollerTurn().then(() => _activityHeartbeat.start())
  }

  // Runtime player provisioning (cfs live-world SSO). When this client is a GM,
  // drain the platform's pending-provision queue — create the reserved Foundry
  // User docs (Foundry only lets a GM do this) so the proxy can SSO invited
  // players into a RUNNING world. Single-GM election lives in the class, so it's
  // safe that this starts in every GM browser AND the headless service-GM.
  if (heartbeatInstallId && game.user.isGM) {
    _provisionDrain = new ProvisionDrain(_api, heartbeatInstallId)
    _pollerTurn().then(() => _provisionDrain.start())
  }

  // NO document sync starts here (owner, 2026-10-03): the world snapshot pushes,
  // the Core→Foundry write-back couriers and the module-pack import queue were all
  // cut. They uploaded full re-push sweeps from the GM's browser (~175 MB/h on the
  // 2026-10-02 game night) and wrote into a live world. Offline platform edits will
  // be written into the world files server-side at launch instead.

  // dt#212 parity — an "Edit JSON" control on Item/Actor/JournalEntry sheet headers, opening the
  // CFG JSON editor with the same discard/required-empty diagnostics and pre-save health probe
  // PlayTable runs. GM-only; injected via the generic renderDocumentSheetV2 hook.
  try {
    registerJsonEditorHeaderButton()
  } catch (err) {
    console.warn('CFG Core | JSON editor button registration failed (non-fatal):', err)
  }

  // NB the CFG sidebar rail that used to mount here is GONE (fp#47). It was
  // disabled 2026-06-22 — it loaded an iframe to /foundry/sidebar, which 404s,
  // and its own note said the rail "isn't the surface we want anyway". The
  // replacement is a proper ApplicationV2 "Surface" window (tracked separately);
  // that's a rewrite, so the dead file bought nothing. `git log` has it.

  // Offline banner (#699). Subscribes to `pluginConnectionState` and surfaces
  // a small fixed-position pill whenever fetchCfg's last call hit the network
  // error branch. Local Foundry features keep working — the banner is purely
  // informational.
  mountConnectionBanner()

  // Report the loaded world to CFG so the platform's Server Manager UI
  // can show "running — <World> loaded" instead of the stale FOUNDRY_WORLD
  // env it used to read. Non-fatal — the platform falls back to "loading…"
  // and the 15-min safety net re-converges.
  _reportWorldLoaded().catch((err) => {
    console.warn('CFG Core | world-load callback failed (non-fatal):', err)
  })

  console.log(`CFG Core | Ready — linkedCampaigns: [${_linkedCampaignIds.join(', ')}]`)
})

/* -------------------------------------------- */
/*  World-load Reporter                          */
/* -------------------------------------------- */

/**
 * POST the active world id to CFG so the platform's runtime state map
 * knows which world is loaded right now. Fired once per `ready` hook —
 * idempotent on the server side (repeated POSTs for the same world just
 * refresh `loadedAt`).
 *
 * Through `_api`, the courier client (cs#414): same endpoint, same key, same
 * cookie rule, and a keyless boot renews its seat key before giving up. It was a
 * raw fetch that asked for cookies whenever it had no key — which CORS refuses
 * cross-origin — so every keyless load lost this report, pluginVersion included.
 * That is why nobody could tell which module version ran in the 2026-09-26 outage.
 */
async function _reportWorldLoaded() {
  if (!game.world?.id || !_api) return
  await _api.post(`/api/v1/foundry/worlds/${encodeURIComponent(game.world.id)}/status`, {
    status: 'ready',
    // pluginVersion rides the heartbeat so the platform's fleet report
    // (dt#268/dt#183) knows what each world actually RUNS — the installed
    // files on disk are not evidence of the running version.
    pluginVersion: MODULE_VERSION(),
  })
}

/* -------------------------------------------- */
/*  Linked Campaigns                             */
/* -------------------------------------------- */

/**
 * Fetch the set of CFG campaigns linked to THIS Foundry world via the
 * many-to-many join (`WorldAccessGrant`, granteeType 'campaign'). The GM manages the
 * link list in Module Settings → Linked Campaigns; this is the
 * canonical "which campaigns can play in this world" lookup.
 *
 * Returns an empty array when nothing is linked or the fetch fails, rather
 * than block plugin boot.
 */
async function _resolveLinkedCampaigns() {
  if (!_api) return []
  const installId = game.settings.get(MODULE_ID, 'installationId') || null
  const worldId = game.world?.id ?? null
  if (!installId || !worldId) return []
  try {
    const data = await _api.get('/api/v1/account/foundry/campaigns')
    const campaigns = Array.isArray(data?.data) ? data.data : []
    const linked = []
    for (const c of campaigns) {
      // `installId` comes from the URL segment, which post-#162 can be EITHER the
      // installation cuid or its slug (the proxy resolves by id then slug). Match
      // on either form so slug-hosted worlds still resolve their linked campaigns
      // (cfs#17 #147).
      const matches = (c.linkedWorlds ?? []).some(
        (l) =>
          (l.installationId === installId || (l.installationSlug && l.installationSlug === installId)) &&
          l.worldId === worldId,
      )
      if (matches) linked.push(c.id)
    }
    return linked
  } catch (err) {
    console.warn('CFG Core | linked-campaign resolution failed (non-fatal):', err?.message ?? err)
    return []
  }
}

/* -------------------------------------------- */
/*  Platform Account Linking                     */
/* -------------------------------------------- */

/**
 * Link this Foundry user to their Core platform account.
 *
 * Auth: `_api`, the courier client — its key and its cs#414 renewal. A client of
 *   its own here kept the key `ready` started with, so a keyless boot lost the link
 *   even after an earlier call had renewed.
 *
 * On success: stores platformUserId in a user flag — core-browser's Foundry
 *   Users panel reads it. (The `av-identity` socket broadcast that used to
 *   follow had no listener anywhere and is gone.)
 */
async function _linkPlatformUser() {
  if (!_api) return
  try {
    const data = await _api.get('/api/v1/account/user')
    const platformUserId = data?.user?.id
    if (!platformUserId) return

    await game.user.setFlag(MODULE_ID, 'platformUserId', platformUserId)
    console.log(`CFG Core | Account linked: platform ${platformUserId} ↔ Foundry ${game.user.id}`)
  } catch (err) {
    console.warn('CFG Core | Platform account link failed (non-fatal):', err.message)
  }
}

