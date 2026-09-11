/**
 * Plugin connection-state observable + fetchCfg's offline branch (#699).
 *
 * Covers:
 *   - subscriber API: subscribe/unsubscribe + listener fanout
 *   - fetchCfg returns typed `{ ok, reason }` for every failure mode
 *     (offline, auth-failed, forbidden, server-error, client-error)
 *   - a 403 splits on its body: a rights code is `forbidden` (credential alive,
 *     lacks a right), anything else stays `auth-failed` (credential dead)
 *   - fetchCfg never throws
 *   - connection-state mirrors the outcome of the last fetch
 */

import { jest } from '@jest/globals'

async function loadConnectionState() {
  jest.resetModules()
  return await import('../../scripts/auth/connection-state.js')
}

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

describe('connection-state subscribers', () => {
  it('starts in unknown and notifies subscribers on status changes', async () => {
    const { getConnectionState, onConnectionStateChange, setConnectionStatus } = await loadConnectionState()
    expect(getConnectionState().status).toBe('unknown')

    const seen = []
    const unsubscribe = onConnectionStateChange((s) => seen.push(s.status))

    setConnectionStatus('online', 200)
    setConnectionStatus('offline')
    setConnectionStatus('online', 200)

    expect(seen).toEqual(['online', 'offline', 'online'])
    expect(getConnectionState()).toMatchObject({ status: 'online', lastStatusCode: 200 })

    unsubscribe()
  })

  it('does not re-emit when the status repeats', async () => {
    const { onConnectionStateChange, setConnectionStatus } = await loadConnectionState()
    const seen = []
    onConnectionStateChange((s) => seen.push(s.status))

    setConnectionStatus('offline')
    setConnectionStatus('offline')
    setConnectionStatus('offline')

    expect(seen).toEqual(['offline'])
  })

  it('unsubscribed listeners stop receiving updates', async () => {
    const { onConnectionStateChange, setConnectionStatus } = await loadConnectionState()
    const seen = []
    const unsubscribe = onConnectionStateChange((s) => seen.push(s.status))

    setConnectionStatus('online', 200)
    unsubscribe()
    setConnectionStatus('offline')

    expect(seen).toEqual(['online'])
  })

  it('a throwing listener does not block other listeners', async () => {
    const { onConnectionStateChange, setConnectionStatus } = await loadConnectionState()
    const seen = []

    onConnectionStateChange(() => {
      throw new Error('boom')
    })
    onConnectionStateChange((s) => seen.push(s.status))

    setConnectionStatus('offline')
    expect(seen).toEqual(['offline'])
  })
})

describe('forbiddenCode', () => {
  it('recognizes exactly the two rights codes, on a JSON object body only', async () => {
    const { forbiddenCode, FORBIDDEN_CODES } = await loadConnectionState()
    expect(FORBIDDEN_CODES).toEqual(['SCOPE_REQUIRED', 'INSTALLATION_OWNER_REQUIRED'])
    expect(forbiddenCode({ code: 'SCOPE_REQUIRED' })).toBe('SCOPE_REQUIRED')
    expect(forbiddenCode({ code: 'INSTALLATION_OWNER_REQUIRED' })).toBe('INSTALLATION_OWNER_REQUIRED')
    expect(forbiddenCode({ code: 'FORBIDDEN' })).toBeNull()
    expect(forbiddenCode({ error: 'no code at all' })).toBeNull()
    expect(forbiddenCode('SCOPE_REQUIRED')).toBeNull()
    expect(forbiddenCode(null)).toBeNull()
  })
})

describe('fetchCfg — typed result + connection-state side effects', () => {
  beforeEach(() => {
    settingsStore({ coreApiUrl: 'https://cfg.test', apiKey: 'cfk_secret' })
    globalThis.window = globalThis.window || {}
    globalThis.window.location = { origin: 'https://foundry.local' }
  })

  it('returns { ok: true, status, data } on a 2xx with JSON body', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ user: { name: 'Hob' } }),
      text: async () => '{"user":{"name":"Hob"}}',
    }))

    const { fetchCfg } = await loadPairFlow()
    const res = await fetchCfg('/api/v1/account/user')

    expect(res).toEqual({ ok: true, status: 200, data: { user: { name: 'Hob' } } })
  })

  it("returns { ok: false, reason: 'offline' } when fetch throws", async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError('NetworkError when attempting to fetch resource.')
    })

    const { fetchCfg } = await loadPairFlow()
    const res = await fetchCfg('/api/v1/account/user')

    expect(res.ok).toBe(false)
    expect(res.reason).toBe('offline')
    expect(res.error).toMatch(/NetworkError/)
  })

  it("returns { ok: false, reason: 'auth-failed', status } on a 401", async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":"Invalid API key"}',
    }))

    const { fetchCfg } = await loadPairFlow()
    const res = await fetchCfg('/api/v1/account/user')

    expect(res).toMatchObject({ ok: false, reason: 'auth-failed', status: 401, body: { error: 'Invalid API key' } })
  })

  it("returns { ok: false, reason: 'auth-failed', status } on a 403", async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => '',
    }))

    const { fetchCfg } = await loadPairFlow()
    const res = await fetchCfg('/api/v1/account/user')

    expect(res).toMatchObject({ ok: false, reason: 'auth-failed', status: 403 })
  })

  // A 403 wears two different meanings, and only the body tells them apart.
  // With a rights code the credential is ALIVE and lacks a scope or an
  // ownership right — pairing again cannot mint a key carrying a right the
  // account does not have, so this must not read as "re-pair required".
  // Without one it keeps meaning
  // what it always did.
  //
  // Every 403 body below is VERBATIM what cfg-core-server sends — the file is
  // named on each — so a change to either side has a counterpart to update.
  it("returns { ok: false, reason: 'forbidden', code, scope } on a 403 with code SCOPE_REQUIRED", async () => {
    // cfg-core-server src/routes/v1/_lib/auth.ts, requireScope / requireScopeIfApiKey:
    //   { error: `Scope required: ${scope}`, code: 'SCOPE_REQUIRED', scope }
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => '{"error":"Scope required: foundry:write","code":"SCOPE_REQUIRED","scope":"foundry:write"}',
    }))

    const { fetchCfg } = await loadPairFlow()
    const { getConnectionState } = await import('../../scripts/auth/connection-state.js')
    const res = await fetchCfg('/api/v1/foundry/modules', { method: 'POST', body: '{}' })

    expect(res).toEqual({
      ok: false,
      reason: 'forbidden',
      status: 403,
      code: 'SCOPE_REQUIRED',
      scope: 'foundry:write',
      body: { error: 'Scope required: foundry:write', code: 'SCOPE_REQUIRED', scope: 'foundry:write' },
    })
    expect(getConnectionState()).toMatchObject({ status: 'forbidden', lastStatusCode: 403 })
  })

  it("returns { ok: false, reason: 'forbidden', code } on a 403 with code INSTALLATION_OWNER_REQUIRED", async () => {
    // cfg-core-server src/routes/v1/account/foundry-installed-modules.ts (and its
    // foundry-system-schema.ts twin), key bound to an installation the caller does not own:
    //   { error: 'Installation-level sync is owner-only — this key is bound to an installation you do not own', code: 'INSTALLATION_OWNER_REQUIRED' }
    // No `scope` field — the right that is missing is ownership, not a scope.
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      text: async () =>
        '{"error":"Installation-level sync is owner-only — this key is bound to an installation you do not own","code":"INSTALLATION_OWNER_REQUIRED"}',
    }))

    const { fetchCfg } = await loadPairFlow()
    const { getConnectionState } = await import('../../scripts/auth/connection-state.js')
    const res = await fetchCfg('/api/v1/foundry/modules', { method: 'POST', body: '{}' })

    expect(res).toMatchObject({ ok: false, reason: 'forbidden', status: 403, code: 'INSTALLATION_OWNER_REQUIRED' })
    expect(res.scope).toBeUndefined()
    expect(getConnectionState().status).toBe('forbidden')
  })

  it("keeps a 403 with code FORBIDDEN as 'auth-failed' — an unbound key really does need a re-pair", async () => {
    // cfg-core-server src/routes/v1/account/foundry-installed-modules.ts, key NOT bound to
    // any installation — the one 403 on this route where re-pairing is the right advice:
    //   { error: 'API key is not bound to a Foundry installation — re-pair the plugin', code: 'FORBIDDEN' }
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      text: async () =>
        '{"error":"API key is not bound to a Foundry installation — re-pair the plugin","code":"FORBIDDEN"}',
    }))

    const { fetchCfg } = await loadPairFlow()
    const { getConnectionState } = await import('../../scripts/auth/connection-state.js')
    const res = await fetchCfg('/api/v1/foundry/modules', { method: 'POST', body: '{}' })

    expect(res).toMatchObject({ ok: false, reason: 'auth-failed', status: 403 })
    expect(res.code).toBeUndefined()
    expect(getConnectionState().status).toBe('auth-failed')
  })

  it("keeps a 403 with a non-JSON body as 'auth-failed'", async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => '<html>Forbidden</html>',
    }))

    const { fetchCfg } = await loadPairFlow()
    const { getConnectionState } = await import('../../scripts/auth/connection-state.js')
    const res = await fetchCfg('/api/v1/account/user')

    expect(res).toMatchObject({ ok: false, reason: 'auth-failed', status: 403, body: '<html>Forbidden</html>' })
    expect(res.code).toBeUndefined()
    expect(getConnectionState().status).toBe('auth-failed')
  })

  it("a 401 is always 'auth-failed', even when the body carries a rights code", async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":"Invalid API key","code":"SCOPE_REQUIRED","scope":"foundry:modules"}',
    }))

    const { fetchCfg } = await loadPairFlow()
    const { getConnectionState } = await import('../../scripts/auth/connection-state.js')
    const res = await fetchCfg('/api/v1/account/user')

    expect(res).toMatchObject({ ok: false, reason: 'auth-failed', status: 401 })
    expect(res.code).toBeUndefined()
    expect(getConnectionState().status).toBe('auth-failed')
  })

  it("returns { ok: false, reason: 'server-error', status } on a 5xx", async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    }))

    const { fetchCfg } = await loadPairFlow()
    const res = await fetchCfg('/api/v1/account/user')

    expect(res).toMatchObject({ ok: false, reason: 'server-error', status: 503, body: 'Service Unavailable' })
  })

  it("returns { ok: false, reason: 'client-error', status } on a non-401/403 4xx", async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '{"error":"Not found"}',
    }))

    const { fetchCfg } = await loadPairFlow()
    const res = await fetchCfg('/api/v1/path/missing')

    expect(res).toMatchObject({ ok: false, reason: 'client-error', status: 404, body: { error: 'Not found' } })
  })

  it('updates connection-state to online after a 2xx', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '{}',
    }))

    const { fetchCfg } = await loadPairFlow()
    const { getConnectionState } = await import('../../scripts/auth/connection-state.js')

    await fetchCfg('/api/v1/health')
    expect(getConnectionState().status).toBe('online')
  })

  it('updates connection-state to offline when fetch throws', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    })

    const { fetchCfg } = await loadPairFlow()
    const { getConnectionState } = await import('../../scripts/auth/connection-state.js')

    await fetchCfg('/api/v1/health')
    expect(getConnectionState().status).toBe('offline')
  })

  it('does not throw — every error mode resolves to a typed result', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('catastrophe')
    })

    const { fetchCfg } = await loadPairFlow()
    await expect(fetchCfg('/x')).resolves.toMatchObject({ ok: false, reason: 'offline' })
  })
})
