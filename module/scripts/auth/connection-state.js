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
 *                    re-pair signal — pairing again mints a key with the same
 *                    rights, so treating this as "re-pair required" would loop
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
 * directions: the key is not dead, and pairing again mints a key with the same
 * rights. Any other 403 — no JSON body, no `code`, or a code outside this list —
 * keeps its pre-3.2.5 meaning, indistinguishable from a dead credential.
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
