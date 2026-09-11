/**
 * Plugin connection state — observable singleton tracking the last-known
 * reachability of the CFG endpoint (#699 / epic #419).
 *
 * Written by `fetchCfg` after every call. Read by the connection banner and
 * any other surface that wants to gracefully degrade when CFG is unreachable.
 *
 * Status values:
 *   'unknown'      — no call has been made yet (initial state)
 *   'online'       — last call returned a 2xx response
 *   'offline'      — last call hit a network error / DNS fail / timeout
 *   'auth-failed'  — last call returned 401, or a 403 with no rights code:
 *                    the credential is dead (revoked, expired, never valid)
 *   'forbidden'    — last call returned 403 WITH a rights code: the credential
 *                    is alive but lacks a scope or an ownership right. NOT a
 *                    re-pair signal — pairing filters the rights it grants
 *                    against the account's role at that moment, so a fresh key
 *                    cannot carry a right the account does not have; and an
 *                    ownership right is not a scope, so no key grants it at all.
 *                    Treating this as "re-pair required" is a loop that swapping
 *                    the credential cannot end
 *   'server-error' — last call returned 5xx
 *   'client-error' — last call returned a non-401/403 4xx
 *
 * The banner only surfaces `offline`. The other failure modes are noisy but
 * not infrastructure-level — leaving them silent here keeps the Foundry UI
 * uncluttered while still letting callers branch on the specific reason.
 * `forbidden` stays silent for the same reason and one more: it is per-call and
 * per-right, so one courier's missing scope must not paint a platform-wide
 * banner onto every seat's screen. No caller surfaces `auth-failed` either, so
 * the two credential outcomes are treated alike here on purpose — the
 * difference lives in what a caller may DO about them, not in the banner.
 */

'use strict'

/**
 * @typedef {'unknown'|'online'|'offline'|'auth-failed'|'forbidden'|'server-error'|'client-error'} ConnectionStatus
 *
 * @typedef {Object} ConnectionState
 * @property {ConnectionStatus} status
 * @property {number|null} lastUpdated  — epoch ms of the last status write, or null
 * @property {number|null} lastStatusCode — HTTP status from the last call, or null
 */

/**
 * Server error codes that mean "the credential is alive but lacks a right".
 *
 * A 403 carrying one of these is the platform saying WHO you are is fine and
 * WHAT you may do is not. Mapping it to `auth-failed` is wrong in both
 * directions: the key is not dead, and pairing again cannot mint a key carrying
 * a right the account does not have — a pairing grants only what the account's
 * role allows at that moment, and an ownership right is not a scope at all.
 * Any other 403 — no JSON body, no `code`, or a code outside this list —
 * keeps its pre-3.2.5 meaning, indistinguishable from a dead credential.
 *
 * This list MIRRORS the core server, which is the source of truth for it:
 *   'SCOPE_REQUIRED'              — `requireScope` / `requireScopeIfApiKey` in
 *                                   `src/routes/v1/_lib/auth.ts`; the body is
 *                                   `{ error: 'Scope required: <scope>', code, scope }`
 *   'INSTALLATION_OWNER_REQUIRED' — ⚠️ NO LONGER EMITTED by the live core server.
 *                                   It came from `POST /api/v1/foundry/modules`
 *                                   and its system-schema twin, for a key bound
 *                                   to an installation the caller does not own;
 *                                   the body was `{ error, code }` with no
 *                                   `scope`. Core `ddd280a` (v1.213.0) made a
 *                                   seat key authorized by its BINDING rather
 *                                   than by ownership, which deleted both
 *                                   emission sites. Verified against the tag:
 *                                   zero sends, the string surviving only in
 *                                   comments, positive-controlled against
 *                                   'SCOPE_REQUIRED' (2 sends: `_lib/auth.ts`
 *                                   :134 and :168). ⚠️ An earlier draft of this
 *                                   note said THREE sends — it counted a comment
 *                                   at :121 as a send, i.e. it made the exact
 *                                   comment-vs-code error this list warns about.
 *                                   The conclusion (2 sends -> 0) is unchanged;
 *                                   the control that licensed it was wrong.
 *                                   `server-403-code-inventory.test.js` now
 *                                   derives this instead of a human counting.
 *                                   RETAINED anyway, deliberately — v1.212.0
 *                                   DID emit it, installed copies of this module
 *                                   are long-lived, and one meeting an older
 *                                   core must still read it as a rights problem
 *                                   rather than a dead key.
 * The unit tests carry those bodies verbatim. ⚠️ Do not read that as proof the
 * deployed server can still produce them: the coupling held in only one
 * direction. `ddd280a` changed the server and this list did not follow, which is
 * exactly how the stale claim above survived its own review. Check a code against
 * the DEPLOYED tag, never against these fixtures — they are mocked, so they stay
 * green whatever the server does. A core server that predates the codes answers
 * `code: 'FORBIDDEN'` for the same conditions, and this module then reads it as
 * `auth-failed` exactly as 3.2.4 did — the two halves ship independently, and
 * this side is safe in either order.
 */
export const FORBIDDEN_CODES = Object.freeze(['SCOPE_REQUIRED', 'INSTALLATION_OWNER_REQUIRED'])

/**
 * The rights code a 403 body carries, or null when the body is not a JSON
 * object whose `code` is one of `FORBIDDEN_CODES`.
 *
 * @param {unknown} body — the parsed response body (object, string or null)
 * @returns {string|null}
 */
export function forbiddenCode(body) {
  if (!body || typeof body !== 'object') return null
  const code = body.code
  return typeof code === 'string' && FORBIDDEN_CODES.includes(code) ? code : null
}

/** @type {ConnectionState} */
const state = {
  status: 'unknown',
  lastUpdated: null,
  lastStatusCode: null,
}

/** @type {Set<(s: ConnectionState) => void>} */
const listeners = new Set()

/**
 * Snapshot of the current connection state. Always returns a new object so
 * callers can compare references between snapshots.
 *
 * @returns {ConnectionState}
 */
export function getConnectionState() {
  return { ...state }
}

/**
 * Subscribe to connection-state changes. Returns the unsubscribe function.
 * Listener exceptions are caught and logged so a misbehaving subscriber can't
 * brick the rest of the plugin.
 *
 * @param {(s: ConnectionState) => void} fn
 * @returns {() => void}
 */
export function onConnectionStateChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Update the connection state. Called by `fetchCfg`; not part of the public
 * API but exported for tests + the host-context auto-link path.
 *
 * @param {ConnectionStatus} status
 * @param {number|null} [statusCode]
 */
export function setConnectionStatus(status, statusCode = null) {
  if (state.status === status && state.lastStatusCode === statusCode) {
    // No-op: avoid unnecessary listener fanout when the state doesn't change.
    state.lastUpdated = Date.now()
    return
  }
  state.status = status
  state.lastStatusCode = statusCode
  state.lastUpdated = Date.now()
  for (const fn of listeners) {
    try {
      fn({ ...state })
    } catch (err) {
      console.warn('CFG Core | connection-state listener threw:', err)
    }
  }
}

/**
 * Reset state — tests only.
 * @internal
 */
export function __resetForTests() {
  state.status = 'unknown'
  state.lastUpdated = null
  state.lastStatusCode = null
  listeners.clear()
}
