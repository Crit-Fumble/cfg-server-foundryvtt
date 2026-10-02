/**
 * Crit-Fumble fetch helper — endpoint, credential and `fetchCfg`.
 *
 * Every authenticated plugin → CFG call goes through `fetchCfg`. It reads the
 * `coreApiUrl` setting (set automatically on Crit-Fumble hosted worlds) and
 * decides per call between the same-origin session cookie and a Bearer key:
 * the per-browser seat key first, then the `apiKey` setting (the hosted
 * owner's installation key).
 *
 * The file keeps its old name because three importers reference it. The
 * device-pair flow that used to live here (linking a world Crit-Fumble does
 * not host) has been removed: connecting a self-hosted world is not
 * currently supported.
 */

'use strict'

import { forbiddenCode, setConnectionStatus } from './connection-state.js'
import { readSeatKey } from './host-context.js'

const MODULE_ID = 'crit-fumble-core'
const FETCH_TIMEOUT_MS = 20_000

/**
 * Read the configured CFG endpoint, sans trailing slash. Falls back to the
 * production origin when the setting is missing — keeps `fetchCfg` callable
 * even before settings are fully wired up.
 *
 * @returns {string}
 */
export function getCfgEndpoint() {
  let url = ''
  try {
    url = game.settings.get(MODULE_ID, 'coreApiUrl') || ''
  } catch {
    // settings not ready yet
  }
  return (url || 'https://core.crit-fumble.com').replace(/\/$/, '')
}

/**
 * Is the configured core endpoint this page's own origin?
 *
 * Decides cookie-vs-Bearer for every `fetchCfg` call. Defaults to FALSE (treat
 * core as cross-origin) when it cannot tell, because that path sends an explicit
 * Bearer and omits cookies — which is correct on a cross-origin host and merely
 * unauthenticated on a same-origin one. The opposite default would re-create the
 * cs#391 failure, where the request is rejected by the browser before the server
 * ever sees it and every caller reports a generic "offline".
 *
 * @param {string} [endpoint] — defaults to the configured endpoint.
 * @returns {boolean}
 */
export function _coreIsSameOrigin(endpoint) {
  try {
    const pageOrigin = globalThis.window?.location?.origin
    if (!pageOrigin) return false
    return new URL(endpoint ?? getCfgEndpoint(), pageOrigin).origin === pageOrigin
  } catch {
    return false
  }
}

/**
 * Read the client-scoped `apiKey` setting — the hosted owner's installation key.
 *
 * Client-scoped since the fix for the world-scope leak (see the setting's
 * registration in module.js): it lives in THIS browser's localStorage, never
 * in the world database.
 * @returns {string|null}
 */
export function getCfgApiKey() {
  try {
    return game.settings.get(MODULE_ID, 'apiKey') || null
  } catch {
    return null
  }
}

/**
 * Authenticated fetch helper — every plugin → CFG call goes through here.
 *
 * Safety:
 *   - Reads endpoint + apiKey from settings on each call so a freshly-written
 *     key takes effect without reload.
 *   - The Authorization header is added internally; callers MUST NOT pass it.
 *     We strip any `authorization` from `init.headers` defensively so the key
 *     can't be overwritten with a stale value at the call site.
 *   - The key never appears in console output. The helper never throws —
 *     network/transport errors and HTTP failures are returned as a typed
 *     result so callers can branch without try/catch.
 *
 * Result shape:
 *   { ok: true,  status, data }                 — 2xx, body parsed (JSON or null)
 *   { ok: false, reason: 'offline', error }     — network/DNS/timeout
 *   { ok: false, reason: 'auth-failed', status, body }
 *       — 401, or a 403 without a rights code: the credential is dead
 *         (re-pair required)
 *   { ok: false, reason: 'forbidden', status, code, scope?, body }
 *       — 403 WITH a rights code (`SCOPE_REQUIRED` / `INSTALLATION_OWNER_REQUIRED`):
 *         the credential is alive but lacks a scope or an ownership right.
 *         NOT a re-pair signal — a fresh key cannot carry a right the account
 *         does not have.
 *   { ok: false, reason: 'server-error', status, body } — 5xx
 *   { ok: false, reason: 'client-error', status, body } — non-401/403 4xx
 *
 * Side effects: every call updates `connection-state` so the offline banner
 * and other observers react to the latest reachability without polling.
 *
 * @param {string} path                  — leading slash, e.g. `/api/v1/account/user`
 * @param {RequestInit & {timeoutMs?: number}} [init]
 * @returns {Promise<{ok:true,status:number,data:any}|{ok:false,reason:string,status?:number,code?:string,scope?:string,body?:any,error?:string}>}
 */
export async function fetchCfg(path, init = {}) {
  const endpoint = getCfgEndpoint()
  // ⛔ THE TEST IS THE ORIGIN, NOT THE HOST KIND (cs#391).
  //
  // This used to branch on `getHostKind() === 'cfg-hosted'`, on the premise —
  // stated in its own comment — that "cfg-hosted Foundry is served same-origin
  // with core". cs#391 moved hosted worlds to their own host, and that premise
  // died with it. A cfg-hosted world is now typically CROSS-origin, where the
  // cookie is not merely unnecessary but actively fatal: core deliberately
  // withholds `Access-Control-Allow-Credentials` for the Foundry origin (the
  // whole point of the separation — a GM-installed module must not be able to
  // spend a visitor's session), so `credentials: 'include'` makes the browser
  // reject the response before any of it is read. Every fetchCfg caller on a
  // hosted world failed its preflight.
  //
  // So ask the only question that actually decides it: is core THIS PAGE's
  // origin? If yes, the cookie works and is the auth. If no, the cookie cannot
  // work, and the only usable credential is a Bearer.
  const sameOrigin = _coreIsSameOrigin(endpoint)
  // Seat key first: per-browser, short-lived, scoped to THIS seat, and the only
  // credential a non-owner GM has once core is a different origin. Falls back to
  // the `apiKey` setting (the hosted owner's installation key). Same precedence
  // as module.js's client construction, deliberately.
  const apiKey = sameOrigin ? null : readSeatKey() || getCfgApiKey()

  const headers = new Headers(init.headers || {})
  // Strip caller-supplied auth — only this helper sets it.
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase() === 'authorization') headers.delete(name)
  }
  if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`)
  if (init.body && !headers.has('content-type')) {
    headers.set('Content-Type', 'application/json')
  }

  const timeoutMs = init.timeoutMs ?? FETCH_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response
  try {
    response = await fetch(`${endpoint}${path}`, {
      ...init,
      headers,
      // Same-origin: the cookie IS the auth. Cross-origin: omit it — it would
      // not be honored, and asking for it fails the preflight outright.
      credentials: sameOrigin ? 'include' : 'omit',
      signal: init.signal ?? controller.signal,
    })
  } catch (err) {
    // DNS failure, connection refused, abort/timeout, CORS preflight reject.
    // All look identical from the caller's perspective: the platform is not
    // reachable right now.
    setConnectionStatus('offline')
    return { ok: false, reason: 'offline', error: err?.message || 'Network error' }
  } finally {
    clearTimeout(timer)
  }

  const status = response.status
  if (response.ok) {
    let data = null
    try {
      data = await response.json()
    } catch {
      // Empty body or non-JSON success — treat as null data, still ok.
    }
    setConnectionStatus('online', status)
    return { ok: true, status, data }
  }

  const body = await _readBody(response)

  if (status === 401) {
    // A 401 is always a dead credential, whatever the body says.
    setConnectionStatus('auth-failed', status)
    return { ok: false, reason: 'auth-failed', status, body }
  }
  if (status === 403) {
    // Two different things wear a 403, and only the body tells them apart.
    // With a rights code the credential is ALIVE and merely lacks a scope or
    // an ownership right — pairing again cannot mint a key carrying a right the
    // account does not have, so this must not read as "re-pair required".
    // Without one (no JSON, no code, any other code) it keeps its old meaning,
    // which is indistinguishable from a dead key.
    const code = forbiddenCode(body)
    if (code) {
      setConnectionStatus('forbidden', status)
      const scope = typeof body.scope === 'string' ? body.scope : undefined
      return { ok: false, reason: 'forbidden', status, code, scope, body }
    }
    setConnectionStatus('auth-failed', status)
    return { ok: false, reason: 'auth-failed', status, body }
  }
  if (status >= 500) {
    setConnectionStatus('server-error', status)
    return { ok: false, reason: 'server-error', status, body }
  }
  setConnectionStatus('client-error', status)
  return { ok: false, reason: 'client-error', status, body }
}

async function _readBody(response) {
  try {
    const text = await response.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  } catch {
    return null
  }
}
