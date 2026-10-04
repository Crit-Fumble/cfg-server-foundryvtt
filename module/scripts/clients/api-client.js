/**
 * CFG Core API Client
 *
 * Handles all communication with the Core platform from within a Crit-Fumble
 * hosted FoundryVTT world. Supports two authentication modes:
 *
 *   Session cookie — core is this page's own origin. Authentication uses the
 *                    browser's existing session cookie (credentials: 'include').
 *                    No key needed; the cookie is included automatically.
 *
 *   Bearer key     — the hosted seat key, or the installation owner's key, both
 *                    set automatically by the module on a hosted world (see
 *                    host-context.js). The key is sent as
 *                    `Authorization: Bearer cfk_...` on every request.
 *
 * Usage:
 *   // Session cookie (no key)
 *   const api = new CoreAPIClient('https://core.crit-fumble.com')
 *   // Bearer key
 *   const api = new CoreAPIClient('https://core.crit-fumble.com', 'cfk_yourkey')
 *   const data = await api.get('/api/v1/player/campaigns/my-campaign/quests')
 */

'use strict'

import { forbiddenCode } from '../auth/connection-state.js'

const DEFAULT_TIMEOUT = 20_000 // 20 seconds
const MAX_RETRIES = 2

export class CoreAPIClient {
  /**
   * @param {string} baseUrl — e.g. 'https://core.crit-fumble.com'
   * @param {string|null} [apiKey] — CFG API key (cfk_...) for Bearer mode; null for session-cookie auth
   * @param {{ renewKey?: (rejected: string|null) => Promise<string|null>, onRenewed?: (accepted: boolean) => void }} [options]
   *   cs#414: `renewKey` answers a 401 with a fresh key or null; `onRenewed` hears whether core then accepted it
   *   (`renewSeatKey` / `settleSeatKeyRenewal` in host-context.js)
   */
  constructor(baseUrl, apiKey = null, { renewKey = null, onRenewed = null } = {}) {
    this.baseUrl = (baseUrl || 'https://core.crit-fumble.com').replace(/\/$/, '')
    this.apiKey = apiKey || null
    this._renewKey = renewKey
    this._onRenewed = onRenewed
    this._candidate = null
  }

  // ── Request primitives ────────────────────────────────────────────────────

  /**
   * @param {string} endpoint
   * @param {RequestInit & { timeout?: number; retries?: number }} options
   * @returns {Promise<Response>}
   */
  /**
   * Is the configured core endpoint this page's own origin?
   *
   * Defaults to FALSE (treat core as cross-origin) when it cannot tell, because
   * that path omits cookies — correct on a separated host, and merely
   * unauthenticated on a same-origin one. Defaulting the other way re-creates
   * the failure this exists to remove, where the browser rejects the response
   * and every caller reports a generic "offline".
   *
   * @returns {boolean}
   */
  _coreIsSameOrigin() {
    try {
      const pageOrigin = globalThis.window?.location?.origin
      if (!pageOrigin) return false
      return new URL(this.baseUrl, pageOrigin).origin === pageOrigin
    } catch {
      return false
    }
  }

  /**
   * One request, retried ONCE with a renewed key when core answers 401 (cs#414): a seat
   * key lives 12h, a Foundry session is one page load. The key sent is captured first, so
   * a call whose 401 lands after another call swapped a fresh key in retries with that
   * instead of asking again. A renewed key is a CANDIDATE until a request MADE WITH IT gets
   * a 2xx (accepted) or a 401 (refused); old-key calls still in flight say nothing about it.
   */
  async _request(endpoint, options = {}) {
    const sentKey = this.apiKey
    const res = this._settle(await this._send(endpoint, options), sentKey)
    if (res.status !== 401 || !this._renewKey) return res
    let fresh = this.apiKey
    if (fresh === sentKey) fresh = this._candidate = await this._renewKey(sentKey)
    if (!fresh || fresh === sentKey) return res
    this.apiKey = fresh
    return this._settle(await this._send(endpoint, options), fresh)
  }

  _settle(res, sentKey) {
    // A 5xx (core restarting behind Caddy) or a 403 says nothing about the key: stays pending.
    if (this._candidate && sentKey === this._candidate && (res.ok || res.status === 401)) {
      this._candidate = null
      this._onRenewed?.(res.ok)
    }
    return res
  }

  async _send(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`
    const timeout = options.timeout ?? DEFAULT_TIMEOUT
    const retries = options.retries ?? MAX_RETRIES
    const { timeout: _t, retries: _r, ...fetchOpts } = options

    const headers = {
      'Content-Type': 'application/json',
      ...(fetchOpts.headers ?? {}),
    }

    // Key set: send it as a Bearer token; no session cookie needed.
    // No key: rely on the session cookie via credentials: 'include'.
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    }

    // ⛔ ASKING FOR COOKIES CROSS-ORIGIN IS WORSE THAN SENDING NOTHING (cs#391).
    //
    // The keyless fallback below used to be an unconditional
    // `credentials: 'include'`, on the premise that a cfg-hosted world is
    // same-origin with core. It is not, since hosted worlds moved to their own
    // host: core withholds `Access-Control-Allow-Credentials` for that origin
    // deliberately, so the browser REJECTS THE RESPONSE BEFORE READING IT and
    // the caller cannot tell a refused request from a dead platform — both
    // surface as a network failure.
    //
    // Omitting them instead means an unauthenticated call earns an honest 401,
    // which the caller can report. It does not make the call succeed; a
    // credential is what does that, and since cs#392 stage 1 a seated player
    // gets one. This is the half that stops the failure being INVISIBLE.
    const sameOrigin = this._coreIsSameOrigin()

    let lastErr
    for (let attempt = 1; attempt <= retries; attempt++) {
      const controller = new AbortController()
      const timerId = setTimeout(() => controller.abort(), timeout)
      try {
        const res = await fetch(url, {
          ...fetchOpts,
          headers,
          ...(this.apiKey || !sameOrigin ? {} : { credentials: 'include' }),
          signal: controller.signal,
        })
        clearTimeout(timerId)
        return res
      } catch (err) {
        clearTimeout(timerId)
        lastErr = err
        if (attempt < retries && !controller.signal.aborted) {
          await new Promise((r) => setTimeout(r, 500 * attempt))
        }
      }
    }
    throw lastErr
  }

  /**
   * Parse response — throws a friendly Error on non-2xx.
   * @param {Response} res
   * @returns {Promise<any>}
   */
  async _parse(res) {
    let body
    try {
      body = await res.json()
    } catch {
      body = {}
    }

    if (res.ok) return body

    if (res.status === 401) {
      throw new Error(
        this.apiKey
          ? 'Your Crit-Fumble sign-in for this world has expired. Reload the page to reconnect.'
          : 'Not logged in to Core. Open core.crit-fumble.com in your browser and sign in.',
      )
    }
    if (res.status === 403) {
      // With a rights code the credential is alive and merely lacks a scope or
      // an ownership right. The server writes that message for the user, so
      // relay it as-is — and do NOT point at re-pairing or regenerating a key,
      // which cannot carry a right the account does not have. Any other 403
      // keeps the generic wording.
      //
      // The MESSAGE degrades, the CODE does not. A body whose `error` is
      // missing, empty or blank still falls back to the generic sentence rather
      // than throwing a blank Error — but `code` rides along either way, because
      // "this credential is alive" is what callers branch on, and that fact
      // does not depend on the server
      // having written any prose.
      const code = forbiddenCode(body)
      const generic = 'You do not have permission for this action.'
      if (code) {
        const relayed = typeof body.error === 'string' && body.error.trim() ? body.error : generic
        const err = new Error(relayed)
        err.code = code
        throw err
      }
      throw new Error(generic)
    }
    if (res.status === 404) throw new Error('Resource not found.')
    if (res.status === 429) throw new Error('Rate limited — please try again in a moment.')
    throw new Error(body?.error ?? `Core server error (HTTP ${res.status})`)
  }

  // ── Public request method (used by module internals) ─────────────────────────

  /** Generic fetch — parses response and throws on non-2xx. */
  async request(endpoint, options = {}) {
    return this._parse(await this._request(endpoint, options))
  }

  // ── HTTP verbs ────────────────────────────────────────────────────────────

  async get(endpoint, opts = {}) {
    return this._parse(await this._request(endpoint, { ...opts, method: 'GET' }))
  }
  async post(endpoint, body, opts = {}) {
    return this._parse(await this._request(endpoint, { ...opts, method: 'POST', body: JSON.stringify(body) }))
  }
  async patch(endpoint, body, opts = {}) {
    return this._parse(await this._request(endpoint, { ...opts, method: 'PATCH', body: JSON.stringify(body) }))
  }
  async del(endpoint, opts = {}) {
    return this._parse(await this._request(endpoint, { ...opts, method: 'DELETE' }))
  }

  // ── Campaign endpoints ────────────────────────────────────────────────────

  /** GET /api/v1/player/campaigns/{id} */
  getCampaign(id) {
    return this.get(`/api/v1/player/campaigns/${id}`)
  }

  // ── Characters ────────────────────────────────────────────────────────────

  /**
   * GET /api/v1/player/campaigns/{id}/characters
   * @param {string} id         — campaign ID
   * @param {{ role?: string }} [params]
   * @returns {Promise<{ playerCharacters: Array, summary: object }>}
   */
  getCampaignCharacters(id, params = {}) {
    const qs = new URLSearchParams(params).toString()
    return this.get(`/api/v1/player/campaigns/${id}/characters${qs ? `?${qs}` : ''}`)
  }

  // ── Parties ───────────────────────────────────────────────────────────────

  /** GET /api/v1/player/campaigns/{id}/parties */
  getParties(id) {
    return this.get(`/api/v1/player/campaigns/${id}/parties`)
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  /** GET /api/v1/player/campaigns/{id}/sessions/active */
  getActiveSession(id) {
    return this.get(`/api/v1/player/campaigns/${id}/sessions/active`)
  }

  /** GET /api/v1/player/campaigns/{id}/sessions */
  getSessions(id) {
    return this.get(`/api/v1/player/campaigns/${id}/sessions`)
  }

  // ── Quests ────────────────────────────────────────────────────────────────

  /** GET /api/v1/player/campaigns/{id}/quests */
  getQuests(id, params = {}) {
    const qs = new URLSearchParams(params).toString()
    return this.get(`/api/v1/player/campaigns/${id}/quests${qs ? `?${qs}` : ''}`)
  }

  /** PATCH /api/v1/player/campaigns/{id}/quests/{questId} */
  updateQuest(campaignId, questId, data) {
    return this.patch(`/api/v1/player/campaigns/${campaignId}/quests/${questId}`, data)
  }

  // ── Journal ───────────────────────────────────────────────────────────────

  /** GET /api/v1/player/campaigns/{id}/journal */
  getJournal(id) {
    return this.get(`/api/v1/player/campaigns/${id}/journal`)
  }

  // ── GM Assist ─────────────────────────────────────────────────────────────

  /**
   * POST /api/v1/player/campaigns/{id}/gm-assist
   * @param {string} id  — campaign ID
   * @param {string} prompt
   * @returns {Promise<{response: string}>}
   */
  gmAssist(id, prompt) {
    return this.post(`/api/v1/player/campaigns/${id}/gm-assist`, { prompt })
  }

  // ── Runtime player provisioning ───────────────────────────────────────────

  /**
   * GET /api/v1/installations/{installationId}/foundry/pending-provisions?world={worldId}
   * The reserved Foundry seats a connected GM must create so the proxy can SSO
   * invited players into the LIVE world (Foundry only lets a GM create User
   * docs). Owner-session / installation-key scoped.
   * @param {string} installationId
   * @param {string} worldId — Foundry world folder (`game.world.id`)
   * @returns {Promise<{ data: Array<{ nativeUserId: string, foundryUsername: string, role: number, password: string }> }>}
   */
  getPendingProvisions(installationId, worldId) {
    return this.get(
      `/api/v1/installations/${installationId}/foundry/pending-provisions?world=${encodeURIComponent(worldId)}`,
    )
  }

  /**
   * POST /api/v1/installations/{installationId}/foundry/pending-provisions/confirm
   * Mark a reserved seat provisioned once its Foundry User doc has been created;
   * this is what flips the proxy SSO gate on for that player.
   */
  confirmProvision(installationId, worldId, nativeUserId) {
    return this.post(`/api/v1/installations/${installationId}/foundry/pending-provisions/confirm`, {
      world: worldId,
      nativeUserId,
    })
  }
}
