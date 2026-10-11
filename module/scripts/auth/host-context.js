/**
 * Host-environment detection — Phase 0 of the multi-host plugin (#699 / epic #419).
 *
 * Distinguishes a Foundry container that the platform is hosting itself
 * ("cfg-hosted") from one running on the user's own server or a third-party
 * provider ("self-hosted"). The discriminator is a window-global injected by
 * the VTT proxy when it serves Foundry through `/vtt/*`:
 *
 *   window.__CFG_HOSTED_CONTEXT__ = {
 *     endpoint:       'https://core.crit-fumble.com', // CFG endpoint URL
 *     apiKey:         'cfk_…',                        // pre-minted server key
 *     installationId: '<cuid>',                       // Foundry-instance row
 *     cfgUserId:      '<cuid>',                       // owner of the container
 *   }
 *
 * Contract for the proxy injection (server-side, separate follow-up):
 *   - The proxy MUST inject this object before any Foundry script tag runs,
 *     so `Hooks.once('init')` sees it on its first read.
 *   - All four fields are required; partial contexts are rejected and the
 *     plugin falls back to the URL-path detection below.
 *   - The apiKey is server-minted (the owner's installation key); the plugin
 *     treats it like any other stored key.
 *
 * URL-path fallback (#699 follow-up): the `__CFG_HOSTED_CONTEXT__` injection
 * is not yet implemented on the proxy. Until it lands, the only signal a
 * CFG-hosted container reliably emits is its route shape: the VTT proxy serves
 * every hosted Foundry from `/servers/foundryvtt/<installationId>/...`. A world
 * created via Foundry's OWN setup UI (not the CFG create-world flow) has no
 * injected global and no stored apiKey, yet it is still cfg-hosted by virtue of
 * the route it's served on. We therefore treat that path prefix as a
 * cfg-hosted signal too — without it, such worlds are wrongly read as
 * self-hosted. Self-hosted / third-party Foundry never serves on
 * this prefix, so the fallback can't misclassify a BYO instance.
 *
 * `getHostedContext()` (the auto-link auth payload) still requires the full
 * injected global — the path alone can't mint an apiKey. Only `getHostKind()`
 * honors the path fallback.
 *
 * Detection is one-shot — the kind is captured into module state on the first
 * read so a tampered global (or a later history.pushState) can't downgrade it.
 */

'use strict'

const MODULE_ID = 'crit-fumble-core'

/**
 * Route prefix the VTT proxy serves every cfg-hosted Foundry container under.
 * `/servers/foundryvtt/<installationId>/...` is the one URL shape for all
 * hosted installs — see cfg-core-server `routes/vtt-proxy.ts`.
 */
const CFG_HOSTED_PATH_PREFIX = '/servers/foundryvtt/'

/**
 * Cookies the platform sets on a cfg-hosted page (cs#391): one DECLARES where core
 * lives, the other hands a seated browser its own scoped Bearer key. forward-auth
 * mints both on every top-level navigation, on core's edge and on the Foundry
 * host alike, and Caddy relays them as Set-Cookie on every stack (prod, dev, e2e).
 * When the endpoint cookie is absent the fallback is the STORED setting — never
 * the page origin (cs#414); when the seat key is absent the client is keyless.
 */
const CORE_ENDPOINT_COOKIE = 'cfg_core_endpoint'
const SEAT_KEY_COOKIE = 'cfg_foundry_seat_key'

/**
 * Read one cookie by name from document.cookie, or null.
 *
 * ⛔ Reads EVERY occurrence, and two that disagree mean NOTHING (cs#455 F1). All
 * hosted worlds share one origin, and these cookies are not HttpOnly (the module
 * has to read them), so any world's JavaScript can write a cookie of the same name
 * with a LONGER path — `/servers/foundryvtt/<other world>/game` — which the browser
 * then lists BEFORE the platform's own. Taking the first match handed that world the
 * choice of where this module sends its Bearer key. A conflict is not something to
 * resolve, only to refuse: the callers fall back to what they would do with no cookie.
 */
function _cookie(name) {
  if (typeof document === 'undefined' || typeof document.cookie !== 'string') return null
  const values = new Set()
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    let value
    try {
      value = decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      value = null // undecodable: still an occurrence, and one that disagrees with any real value
    }
    values.add(value)
  }
  if (values.size > 1) {
    console.warn(`CFG Core | ${values.size} different "${name}" cookies on this page — ignoring all of them (cs#455)`)
    return null
  }
  const [only] = values
  return only || null
}

/** The host label that serves hosted worlds APART from core (cs#391 'retired' mode). */
const FOUNDRY_HOST_LABEL = 'foundryvtt'

/**
 * May a COOKIE name `endpoint` as core, on a page at `pageOrigin`? (cs#455 F1)
 *
 * The cookie is the one endpoint channel another world can write (see `_cookie`), and
 * the module sends its seat key as a Bearer to whatever it names. So it must name a
 * place the platform could actually be:
 *   - `https://core.<parent domain>` — the Foundry host's sibling. On
 *     foundryvtt.crit-fumble.com that is https://core.crit-fumble.com, and no other.
 *   - the page's OWN origin, on a single-origin stack: the e2e stack
 *     (http://localhost:11000) and the dev tunnel, where Caddy serves core and Foundry
 *     from one origin and forward-auth declares exactly that origin (`app.url`). Never
 *     on the dedicated Foundry host, where the page origin is by construction not core
 *     (cs#414: calls there 302 to core and lose their POST bodies).
 * Anything else — another domain, a non-http(s) scheme, an unparseable value — is
 * refused, and the caller falls back to the stored setting.
 *
 * @param {string} endpoint
 * @param {string} pageOrigin `window.location.origin`
 * @returns {boolean}
 */
export function isAcceptableCookieEndpoint(endpoint, pageOrigin) {
  let url
  let page
  try {
    url = new URL(endpoint)
    page = new URL(pageOrigin)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  const labels = page.hostname.split('.')
  if (labels.length >= 3 && url.origin === `https://core.${labels.slice(1).join('.')}`) return true
  return url.origin === page.origin && labels[0] !== FOUNDRY_HOST_LABEL
}

function _pageOrigin() {
  try {
    return typeof window !== 'undefined' ? window.location?.origin ?? null : null
  } catch {
    return null
  }
}

/**
 * The platform's own origin — which is NOT this page's origin.
 *
 * ⛔ Until cs#391 those were the same thing: hosted Foundry was served from
 * core.crit-fumble.com itself, so `window.location.origin` WAS the core API. That
 * coincidence is what the module encoded in several places. Since `foundryVttMode`
 * 'retired' every hosted world is served ONLY from the Foundry host, so a hosted
 * path is by definition on an origin that is never core.
 *
 * Precedence, and the order is deliberate:
 *   1. injected `__CFG_HOSTED_CONTEXT__.endpoint` — the contracted channel.
 *   2. the `cfg_core_endpoint` cookie — server-declared, and the only channel that
 *      reaches a seated browser. forward-auth mints it on BOTH edges —
 *      core and the Foundry host — on every top-level navigation, so a same-origin
 *      dev/e2e stack is declared too, never inferred from the page. Since cs#455 it
 *      is NOT trusted blindly: every world on the origin can write it, so it is
 *      dropped when it appears twice with different values (`_cookie`) or names an
 *      origin core could not be (`isAcceptableCookieEndpoint`), and it is never
 *      persisted (`source: 'cookie'` — see module.js's ready hook).
 *   3. the stored `coreApiUrl` setting — the self-hosted case, and all that is left
 *      on a hosted page whose cookies have lapsed. It holds the declared value the
 *      ready-hook persisted the last time a cookie was seen, or the registered
 *      default (core).
 *   4. null — nothing known; the caller decides.
 *
 * ⛔ There is deliberately NO "hosted path → `location.origin`" step, and there
 * used to be one between 2 and 3 (cs#414, measured in prod 2026-09-15). The page
 * cookies carry Max-Age 12h and are minted only on a top-level navigation, so a tab
 * open longer than that and re-booted by the Foundry client without the document
 * request reaching Caddy had neither cookie, and the old step answered with the
 * Foundry host. Every courier call then went to foundryvtt.crit-fumble.com/api/v1/…,
 * Caddy's catch-all 302'd it to core, the browser followed cross-origin WITH
 * credentials (api-client's same-origin check was now true), core withheld
 * `Access-Control-Allow-Credentials` and the console blamed core for a CORS block —
 * and the 302 downgraded every POST to GET, so ~5h of snapshot pushes 404'd and were
 * silently discarded. A stale stored setting is a BOUNDED problem — the cookie
 * corrects it on the GM's next top-level navigation — whereas the page origin was
 * wrong by construction on the only host that serves hosted worlds, and got
 * re-derived on every load.
 *
 * @returns {{ endpoint: string|null, declared: boolean, source: 'injected'|'cookie'|'stored'|null }}
 *   `declared` is true only for 1 and 2 — the cases a GM auto-correct must not
 *   overwrite. `source` says which; only 'injected' may be persisted.
 */
export function resolveCoreEndpoint() {
  const injected = getHostedContext()
  if (injected && _isNonEmptyString(injected.endpoint)) return { endpoint: injected.endpoint, declared: true, source: 'injected' }

  const fromCookie = _cookie(CORE_ENDPOINT_COOKIE)
  if (_isNonEmptyString(fromCookie)) {
    if (isAcceptableCookieEndpoint(fromCookie, _pageOrigin())) return { endpoint: fromCookie, declared: true, source: 'cookie' }
    console.warn(`CFG Core | ignoring a ${CORE_ENDPOINT_COOKIE} cookie that names ${fromCookie}, which cannot be core here (cs#455)`)
  }

  const stored = _storedSetting('coreApiUrl')
  return _isNonEmptyString(stored)
    ? { endpoint: stored, declared: false, source: 'stored' }
    : { endpoint: null, declared: false, source: null }
}

/**
 * The per-seat Bearer key the platform hands THIS browser, or null.
 *
 * Non-owner GMs and players have never had a Bearer credential — they authenticate
 * to core by same-origin session cookie (api-client.js), which stops working the
 * moment core is a different origin. This cookie is how they get one. Absent today.
 */
export function readSeatKey() {
  return _cookie(SEAT_KEY_COOKIE)
}

/**
 * Minimum spacing between two renewal round-trips. A tab whose platform session is
 * gone cannot renew anything, and every courier tick would otherwise send it back to
 * ask — this caps that at one same-origin request a minute.
 */
const RENEW_COOLDOWN_MS = 60_000

/**
 * A renewal with no answer in this long has failed — the same cap `CoreAPIClient`
 * puts on every call. Without it one stalled request would hold `_renewing`, and with
 * it every 401'd courier, indefinitely and with no notice.
 */
const RENEW_TIMEOUT_MS = 20_000

/**
 * The question itself. forward-auth answers a request carrying it with this seat's
 * current key; it reads it as `SEAT_RENEW_PARAM` (cfg-core-server
 * `foundry-forward-auth.ts`) — rename both or neither.
 */
const RENEW_QUERY = 'cfg_seat_renew=1'

/** @type {Promise<string|null>|null} */
let _renewing = null
let _lastRenewAt = 0
let _failureShown = false
/** The sticky "sync paused" notification Foundry returned, so recovery can take it down. */
let _failureNotice = null

/**
 * A fresh seat key after core refused the one this client holds (cs#414), or null.
 *
 * ⛔ WHY THIS EXISTS. forward-auth mints the seat key on a top-level NAVIGATION, and a
 * Foundry session contains exactly one — `/game` is an SPA on a websocket. A tab open
 * past the key's 12h held a dead key and 401'd on every courier tick, while Foundry
 * played on and this module logged itself healthy (measured in prod 2026-09-15: the
 * platform mirror froze for 1h45m and nothing anywhere said so).
 *
 * How it asks: fetch `<world>/api/status?cfg_seat_renew=1` from this page's OWN
 * origin. That request passes Caddy's forward_auth carrying the browser's platform
 * session, the marker asks core for the seat's current key, and the answer comes back
 * as a Set-Cookie at the world's path — read out of `document.cookie`, where that
 * longest path wins over any same-named cookie at a broader one. `api/status` is
 * Foundry's own cheap, side-effect-free route, and it sits outside the Caddy asset
 * branches, which never relay the page cookies.
 *
 * ⛔ The fetch sends NO Authorization header, and must not: core refuses to mint for a
 * `cfk_` credential (cs#392), and a dead Bearer 401s the request before the session
 * riding beside it is read. The platform session alone authorizes a renewal, so a key
 * copied out of this page cannot renew itself.
 *
 * Always asks, even when the jar already shows a different key: a value this page can
 * see is not proof it came from core (any script on this shared origin can write one),
 * and asking again costs core a cache hit. It is also why every recovery passes
 * through one place that can take the GM's "paused" notice down.
 *
 * Returns null — and tells a GM, once — when nothing new could be had: the platform
 * session is gone, the seat has no key, the request failed or timed out, or this is
 * not a hosted page (whose key a 401 means re-pairing, not renewing).
 *
 * ⚠️ A key it returns is a CANDIDATE, settled by `settleSeatKeyRenewal` once core has
 * answered a request made with it. The jar shows the FIRST same-named cookie, and a
 * cookie planted at a longer path (the page's own) shadows core's; so "resumed" waits
 * for core to accept the key. That catches a dead or garbage plant, not a LIVE key
 * someone else planted — core accepts that one as theirs. The same shadowing reaches
 * the boot-time read; closing it is a cookie-design change (cs#409), not this function.
 *
 * @param {string|null} rejected — the key core just refused (null when the client held none)
 * @returns {Promise<string|null>}
 */
export async function renewSeatKey(rejected) {
  const ref = _installationIdFromPath()
  if (!ref) return null
  if (_renewing) return _renewing
  if (Date.now() - _lastRenewAt < RENEW_COOLDOWN_MS) return null
  _lastRenewAt = Date.now()
  _renewing = _renew(`${CFG_HOSTED_PATH_PREFIX}${ref}/`, rejected).finally(() => {
    _renewing = null
  })
  return _renewing
}

async function _renew(worldPath, rejected) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RENEW_TIMEOUT_MS)
  let status = 0
  try {
    const init = { cache: 'no-store', credentials: 'same-origin', signal: controller.signal }
    status = (await fetch(`${worldPath}api/status?${RENEW_QUERY}`, init)).status
  } catch {
    // Offline, or no answer inside RENEW_TIMEOUT_MS — a failed renewal like any other.
  } finally {
    clearTimeout(timer)
  }
  // Only a 2xx passed forward-auth and reached the container, so only a 2xx can have
  // carried core's Set-Cookie. Anything the jar shows after a refusal is not an answer.
  const fresh = status >= 200 && status < 300 ? readSeatKey() : null
  if (fresh && fresh !== rejected) return fresh
  _reportRenewal(false, status ? `HTTP ${status}` : 'no answer')
  return null
}

/**
 * The verdict on a renewed key, from the only thing that can give it: core's answer to
 * the first request made with it (`CoreAPIClient` calls this). Accepted, "sync resumed";
 * refused (401), a failed renewal — notice and cooldown as usual, and no retry loop,
 * since the client retries once.
 *
 * @param {boolean} accepted
 */
export function settleSeatKeyRenewal(accepted) {
  _reportRenewal(accepted, accepted ? '' : 'core refused the renewed key')
}

/**
 * The half of cs#414 a GM can see. Foundry keeps playing while platform sync is down,
 * so without this a GM never learns that the platform's copy of their world stopped
 * advancing. Once per outage, permanent so a GM who stepped away still finds it, and
 * taken down again by the renewal that ends the outage. Players are not told: the
 * couriers run in a GM's tab, and a player can do nothing about it that the GM cannot.
 *
 * ⚠️ The advice is "try again", not "this will fix it". A reload re-runs the sign-in
 * and the mint, which is the cure for a lapsed platform session — but not for a key
 * revoked while core still has it cached (a moderation revoke, cs#392), which neither
 * a renewal nor a reload gets past until that cache entry is dropped.
 */
function _reportRenewal(renewed, why) {
  const notes = globalThis.ui?.notifications
  if (renewed) {
    console.info('CFG Core | seat key renewed (cs#414)')
    if (_failureShown) {
      try {
        if (_failureNotice) notes?.remove?.(_failureNotice)
      } catch {
        // A Foundry without remove(): the "resumed" note below still says so.
      }
      notes?.info?.('Crit-Fumble: platform sync resumed.')
    }
    _failureShown = false
    _failureNotice = null
    return
  }
  console.warn(`CFG Core | seat key renewal failed (${why}) — platform sync is paused`)
  if (_failureShown || !globalThis.game?.user?.isGM) return
  _failureShown = true
  _failureNotice =
    notes?.warn?.(
      'Crit-Fumble: platform sync is paused — this tab could not renew its platform sign-in. ' +
        'Your game is unaffected; reload the page to try again.',
      { permanent: true },
    ) ?? null
}

/** Read a module setting without throwing when Foundry is not ready. */
function _storedSetting(key) {
  try {
    return globalThis.game?.settings?.get(MODULE_ID, key) ?? null
  } catch {
    return null
  }
}

/**
 * @typedef {Object} HostedContext
 * @property {string} endpoint
 * @property {string} apiKey
 * @property {string} installationId
 * @property {string} cfgUserId
 *
 * @typedef {'cfg-hosted'|'self-hosted'} HostKind
 */

/** @type {HostedContext|null} */
let _cachedContext = null
/** @type {HostKind|null} */
let _cachedKind = null
/** @type {boolean} */
let _hasReadGlobal = false

/**
 * `true` when the current page is served under the cfg-hosted proxy route
 * (`/servers/foundryvtt/<installationId>/...`). This is the URL-path fallback
 * that classifies a hosted container even when the proxy hasn't injected
 * `__CFG_HOSTED_CONTEXT__` (the common case today — see module header).
 *
 * @returns {boolean}
 */
function _isCfgHostedPath() {
  try {
    if (typeof window === 'undefined') return false
    return Boolean(window.location?.pathname?.startsWith(CFG_HOSTED_PATH_PREFIX))
  } catch {
    return false
  }
}

/**
 * Read the injected context once. Subsequent calls return the cached value.
 *
 * Note: the host *kind* may be 'cfg-hosted' (via the URL-path fallback) while
 * this returns null — the path proves the container is hosted, but only the
 * injected global carries the auth payload needed to auto-link. Callers that
 * need the apiKey must null-check; callers that only need the kind use
 * `getHostKind()`.
 *
 * @returns {HostedContext|null}
 */
export function getHostedContext() {
  if (_hasReadGlobal) return _cachedContext
  _hasReadGlobal = true

  let raw
  try {
    raw = typeof window !== 'undefined' ? window.__CFG_HOSTED_CONTEXT__ : null
  } catch {
    raw = null
  }
  _cachedContext = _normalize(raw)
  // cfg-hosted when EITHER a well-formed global is injected OR the page is
  // served on the hosted proxy route. The path fallback covers worlds created
  // via Foundry's own setup UI (no global, no stored key) that are still
  // running inside a CFG container.
  _cachedKind = _cachedContext || _isCfgHostedPath() ? 'cfg-hosted' : 'self-hosted'
  return _cachedContext
}

/**
 * Returns 'cfg-hosted' when the injected global is present and well-formed,
 * OR when the page is served under the cfg-hosted proxy route
 * (`/servers/foundryvtt/<installationId>/...`); 'self-hosted' otherwise. The
 * ready hook branches on it (applyHostedContext), and `CFGCore.hostKind()`
 * exposes it publicly.
 *
 * @returns {HostKind}
 */
export function getHostKind() {
  if (_cachedKind) return _cachedKind
  // Force a one-shot read.
  getHostedContext()
  return _cachedKind ?? 'self-hosted'
}

/**
 * Apply the injected context to Foundry settings — populates `coreApiUrl` +
 * `apiKey` + `installationId` from the global. Without the global, a hosted
 * world only has a stored `apiKey` cleared. No-op when self-hosted.
 *
 * Idempotent: the values are only written when they differ from the existing
 * settings, so a settings.set during init doesn't fire spurious change hooks.
 *
 * @returns {Promise<HostKind>}
 */
export async function applyHostedContext() {
  // 1. Legacy path: an injected `__CFG_HOSTED_CONTEXT__` global wins if present.
  const injected = getHostedContext()
  if (injected) {
    await _setIfChanged('coreApiUrl', injected.endpoint)
    await _setIfChanged('apiKey', injected.apiKey)
    await _setIfChanged('installationId', injected.installationId)
    return 'cfg-hosted'
  }

  // 2. A hosted world authenticates with its seat key, the `cfg_foundry_seat_key`
  //    cookie the platform sets on every navigation (`readSeatKey`). Core mints no
  //    installation owner key any more (cfg-core-server#454), so a key an older
  //    version stored here is dead: clear it, so the client never sends it when
  //    the seat key is missing. No request is made.
  if (!_installationIdFromPath()) return 'self-hosted'
  await _setIfChanged('apiKey', '')
  return 'cfg-hosted'
}

/** Installation id (or slug) from the cfg-hosted route path, or null. */
function _installationIdFromPath() {
  try {
    if (typeof window === 'undefined') return null
    const m = window.location?.pathname?.match(/^\/servers\/foundryvtt\/([^/]+)/)
    return m?.[1] || null
  } catch {
    return null
  }
}

/**
 * Reset module state — tests only.
 * @internal
 */
export function __resetForTests() {
  _cachedContext = null
  _cachedKind = null
  _hasReadGlobal = false
  _renewing = null
  _lastRenewAt = 0
  _failureShown = false
  _failureNotice = null
}

function _normalize(raw) {
  if (!raw || typeof raw !== 'object') return null
  const { endpoint, apiKey, installationId, cfgUserId } = raw
  if (!_isNonEmptyString(endpoint)) return null
  if (!_isNonEmptyString(apiKey)) return null
  if (!_isNonEmptyString(installationId)) return null
  if (!_isNonEmptyString(cfgUserId)) return null
  return {
    endpoint: endpoint.replace(/\/$/, ''),
    apiKey,
    installationId,
    cfgUserId,
  }
}

function _isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

async function _setIfChanged(key, value) {
  let current
  try {
    current = game.settings.get(MODULE_ID, key)
  } catch {
    current = undefined
  }
  if (current === value) return
  try {
    await game.settings.set(MODULE_ID, key, value)
  } catch (err) {
    console.warn(`CFG Core | applyHostedContext: failed to write ${key}:`, err?.message || err)
  }
}
