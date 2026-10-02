/**
 * fetchCfg — the authenticated fetch helper in pair-flow.js (the file keeps its
 * old name; the device-pair state machine that used to live there is gone).
 * Covers Bearer-vs-cookie selection and the apiKey fallback.
 */

import { jest } from '@jest/globals'

/** Re-import the module fresh per test so each starts from clean settings reads. */
async function loadPairFlow() {
  jest.resetModules()
  return await import('../../scripts/auth/pair-flow.js')
}

function settingsStore(initial = {}) {
  const map = new Map(Object.entries(initial))
  game.settings.get = jest.fn((_mod, key) => map.get(key))
  game.settings.set = jest.fn(async (_mod, key, value) => {
    map.set(key, value)
  })
  return map
}

function mockResponse({ ok = true, status = 200, json = {} } = {}) {
  return {
    ok,
    status,
    json: async () => json,
  }
}

describe('fetchCfg', () => {
  beforeEach(() => {
    jest.useRealTimers()
    settingsStore({ coreApiUrl: 'https://cfg.test', apiKey: 'cfk_secret' })
    globalThis.fetch = jest.fn(async () => mockResponse({ json: { ok: true } }))
    globalThis.window = globalThis.window || {}
    // Default: a cross-origin page (no cfg-hosted proxy route, no injected global).
    globalThis.window.location = { origin: 'https://foundry.local' }
    delete globalThis.window.__CFG_HOSTED_CONTEXT__
  })

  it('attaches Bearer token from settings and strips caller-supplied auth', async () => {
    const { fetchCfg } = await loadPairFlow()
    await fetchCfg('/api/v1/account/user', {
      headers: { Authorization: 'Bearer attacker', 'X-Trace': 'abc' },
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://cfg.test/api/v1/account/user')
    const headers = init.headers
    expect(headers.get('Authorization')).toBe('Bearer cfk_secret')
    expect(headers.get('X-Trace')).toBe('abc')
    expect(init.credentials).toBe('omit')
  })

  it('omits Authorization when no apiKey is set', async () => {
    settingsStore({ coreApiUrl: 'https://cfg.test', apiKey: '' })
    const { fetchCfg } = await loadPairFlow()
    await fetchCfg('/api/v1/public/ping')
    const [, init] = fetch.mock.calls[0]
    expect(init.headers.has('Authorization')).toBe(false)
  })

  it('falls back to default endpoint when setting is missing', async () => {
    settingsStore({})
    const { fetchCfg } = await loadPairFlow()
    await fetchCfg('/x')
    const [url] = fetch.mock.calls[0]
    expect(url).toBe('https://core.crit-fumble.com/x')
  })

  // #43 — a cfg-hosted Foundry is served same-origin with core, so the session
  // cookie is the auth. A stale stored API key (from a prior self-hosted pair)
  // must NOT ride along as a Bearer — that's what 401'd the plugin↔core calls.
  // ── cs#391: the branch is the ORIGIN, not the host kind ────────────────────
  // These four replace two tests that asserted "cfg-hosted → cookie". That was
  // right only while hosted Foundry was served FROM core; once it moved to its
  // own host the cookie became unusable (core withholds
  // Access-Control-Allow-Credentials for that origin, deliberately), and asking
  // for it failed the preflight — so every hosted call reported a generic
  // "offline" while the container sat healthy.

  it('SAME-origin as core: the session cookie is the auth, no Bearer', async () => {
    settingsStore({ coreApiUrl: 'https://core.crit-fumble.com', apiKey: 'cfk_secret' })
    globalThis.window.location = {
      origin: 'https://core.crit-fumble.com',
      pathname: '/servers/foundryvtt/abc123/game',
    }
    const { fetchCfg } = await loadPairFlow()
    await fetchCfg('/api/v1/account/user')
    const [, init] = fetch.mock.calls[0]
    expect(init.credentials).toBe('include')
    expect(init.headers.has('Authorization')).toBe(false)
  })

  it('CROSS-origin (hosted on its own host): seat key as Bearer, cookies omitted', async () => {
    settingsStore({ coreApiUrl: 'https://core.crit-fumble.com', apiKey: 'cfk_paired' })
    globalThis.window.location = {
      origin: 'https://foundryvtt.crit-fumble.com',
      pathname: '/servers/foundryvtt/abc123/game',
    }
    globalThis.document = { cookie: 'cfg_foundry_seat_key=cfk_seat_abc; other=1' }
    const { fetchCfg } = await loadPairFlow()
    await fetchCfg('/api/v1/account/user')
    const [, init] = fetch.mock.calls[0]
    // Cookies MUST be omitted: asking for them is what the browser rejects.
    expect(init.credentials).toBe('omit')
    // Seat key wins over the paired key — per-browser and scoped to this seat.
    expect(init.headers.get('Authorization')).toBe('Bearer cfk_seat_abc')
  })

  it('CROSS-origin with no seat key: falls back to the paired key', async () => {
    settingsStore({ coreApiUrl: 'https://core.crit-fumble.com', apiKey: 'cfk_paired' })
    globalThis.window.location = { origin: 'https://foundry.local', pathname: '/game' }
    globalThis.document = { cookie: '' }
    const { fetchCfg } = await loadPairFlow()
    await fetchCfg('/api/v1/account/user')
    const [, init] = fetch.mock.calls[0]
    expect(init.credentials).toBe('omit')
    expect(init.headers.get('Authorization')).toBe('Bearer cfk_paired')
  })

  it('CROSS-origin with no credential at all: unauthenticated, but still not a cookie request', async () => {
    // A seated PLAYER on a hosted world. There is nothing to authenticate with,
    // and that is fine — it earns an honest 401 the caller can report, rather
    // than a preflight rejection that surfaces as "offline" and hides the cause.
    settingsStore({ coreApiUrl: 'https://core.crit-fumble.com' })
    globalThis.window.location = { origin: 'https://foundryvtt.crit-fumble.com', pathname: '/game' }
    globalThis.document = { cookie: '' }
    const { fetchCfg } = await loadPairFlow()
    await fetchCfg('/api/v1/account/user')
    const [, init] = fetch.mock.calls[0]
    expect(init.credentials).toBe('omit')
    expect(init.headers.has('Authorization')).toBe(false)
  })
})
