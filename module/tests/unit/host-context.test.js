/**
 * Host-environment detection (#699 / epic #419) — unit tests for the
 * window-global discriminator that distinguishes CFG-hosted Foundry from
 * self-hosted / third-party-hosted Foundry.
 */

import { jest } from '@jest/globals'

const MODULE_ID = 'crit-fumble-core'

/**
 * Re-import the host-context module fresh per test so the cached one-shot
 * read is reset. Mirrors the pair-flow.test.js pattern.
 */
async function loadHostContext() {
  jest.resetModules()
  return await import('../../scripts/auth/host-context.js')
}

function settingsStore(initial = {}) {
  const map = new Map(Object.entries(initial))
  game.settings.get = jest.fn((_mod, key) => map.get(key))
  game.settings.set = jest.fn(async (_mod, key, value) => {
    map.set(key, value)
  })
  return map
}

describe('getHostKind', () => {
  beforeEach(() => {
    globalThis.window = globalThis.window || {}
    delete globalThis.window.__CFG_HOSTED_CONTEXT__
    // Non-hosted path by default — self-hosted Foundry is never served on the
    // `/servers/foundryvtt/` prefix, so the URL fallback stays off unless a
    // test opts in.
    globalThis.window.location = { pathname: '/game', origin: 'https://foundry.local' }
    settingsStore({})
  })

  it("returns 'cfg-hosted' when the injected global is well-formed", async () => {
    globalThis.window.__CFG_HOSTED_CONTEXT__ = {
      endpoint: 'https://core.crit-fumble.com',
      apiKey: 'cfk_injected',
      installationId: 'inst_abc',
      cfgUserId: 'user_xyz',
    }
    const { getHostKind } = await loadHostContext()
    expect(getHostKind()).toBe('cfg-hosted')
  })

  it("returns 'self-hosted' when the global is absent and the path is not hosted", async () => {
    const { getHostKind } = await loadHostContext()
    expect(getHostKind()).toBe('self-hosted')
  })

  it("returns 'cfg-hosted' from the URL path even when no global is injected", async () => {
    // The common case today: the proxy hasn't injected __CFG_HOSTED_CONTEXT__,
    // but the container is served under /servers/foundryvtt/<installationId>/.
    // A world created via Foundry's own setup UI (no apiKey, no global) is
    // still cfg-hosted by virtue of its route.
    globalThis.window.location = {
      pathname: '/servers/foundryvtt/cmpn6xzfa000h01qdjr15ey1t/game',
      origin: 'https://core.crit-fumble.com',
    }
    const { getHostKind } = await loadHostContext()
    expect(getHostKind()).toBe('cfg-hosted')
  })

  it('getInstallationRef falls back to the URL path when no global is injected', async () => {
    // The bug behind dt#211's first fix attempt: module sync read
    // getHostedContext()?.installationId, which is null in exactly the path-fallback case it
    // needed to work in — so it sent no installation and the server kept 403ing. The ref must
    // come from here, where the fallback lives.
    globalThis.window.location = {
      pathname: '/servers/foundryvtt/rotfs/game',
      origin: 'https://core.crit-fumble.com',
    }
    const { getInstallationRef, getHostedContext } = await loadHostContext()
    expect(getHostedContext()).toBeNull()
    expect(getInstallationRef()).toBe('rotfs') // slug is fine — the server resolves id or slug
  })

  it('getInstallationRef prefers the injected global over the path', async () => {
    globalThis.window.__CFG_HOSTED_CONTEXT__ = {
      endpoint: 'https://core.crit-fumble.com',
      apiKey: 'cfk_injected',
      installationId: 'inst_from_global',
      cfgUserId: 'user_xyz',
    }
    globalThis.window.location = {
      pathname: '/servers/foundryvtt/rotfs/game',
      origin: 'https://core.crit-fumble.com',
    }
    const { getInstallationRef } = await loadHostContext()
    expect(getInstallationRef()).toBe('inst_from_global')
  })

  it('getInstallationRef is null when neither source knows', async () => {
    const { getInstallationRef } = await loadHostContext()
    expect(getInstallationRef()).toBeNull()
  })

  it("getHostedContext stays null on the path fallback — no auth payload without the global", async () => {
    globalThis.window.location = {
      pathname: '/servers/foundryvtt/cmpn6xzfa000h01qdjr15ey1t/game',
      origin: 'https://core.crit-fumble.com',
    }
    const { getHostKind, getHostedContext } = await loadHostContext()
    expect(getHostKind()).toBe('cfg-hosted')
    // The path proves hosting, but only the injected global carries the apiKey.
    expect(getHostedContext()).toBeNull()
  })

  it("returns 'self-hosted' when the global is missing required fields", async () => {
    // Partial contexts are rejected — no endpoint means no auto-link is
    // possible, so we fall through to the pair flow.
    globalThis.window.__CFG_HOSTED_CONTEXT__ = {
      endpoint: 'https://core.crit-fumble.com',
      apiKey: 'cfk_injected',
      // missing installationId + cfgUserId
    }
    const { getHostKind } = await loadHostContext()
    expect(getHostKind()).toBe('self-hosted')
  })

  it("returns 'self-hosted' when an injected field is empty string", async () => {
    globalThis.window.__CFG_HOSTED_CONTEXT__ = {
      endpoint: '',
      apiKey: 'cfk_injected',
      installationId: 'inst_abc',
      cfgUserId: 'user_xyz',
    }
    const { getHostKind } = await loadHostContext()
    expect(getHostKind()).toBe('self-hosted')
  })

  it('caches the result — tampering with the global after the first read is ignored', async () => {
    globalThis.window.__CFG_HOSTED_CONTEXT__ = {
      endpoint: 'https://core.crit-fumble.com',
      apiKey: 'cfk_injected',
      installationId: 'inst_abc',
      cfgUserId: 'user_xyz',
    }
    const { getHostKind } = await loadHostContext()
    expect(getHostKind()).toBe('cfg-hosted')

    delete globalThis.window.__CFG_HOSTED_CONTEXT__
    expect(getHostKind()).toBe('cfg-hosted')
  })
})

describe('applyHostedContext', () => {
  let store

  beforeEach(() => {
    globalThis.window = globalThis.window || {}
    delete globalThis.window.__CFG_HOSTED_CONTEXT__
    // Default: NOT on the cfg-hosted route → no programmatic fetch.
    globalThis.window.location = { pathname: '/game', origin: 'https://foundry.local' }
    globalThis.fetch = jest.fn()
    store = settingsStore({ coreApiUrl: 'https://default', apiKey: '', installationId: '' })
  })

  it('writes endpoint, apiKey and installationId from the injected global', async () => {
    globalThis.window.__CFG_HOSTED_CONTEXT__ = {
      endpoint: 'https://cfg.example.com/',
      apiKey: 'cfk_injected',
      installationId: 'inst_abc',
      cfgUserId: 'user_xyz',
    }

    const { applyHostedContext } = await loadHostContext()
    const kind = await applyHostedContext()

    expect(kind).toBe('cfg-hosted')
    // Trailing slash on endpoint is stripped — fetch helpers append paths
    // with a leading slash and double slashes break some upstream proxies.
    expect(store.get('coreApiUrl')).toBe('https://cfg.example.com')
    expect(store.get('apiKey')).toBe('cfk_injected')
    expect(store.get('installationId')).toBe('inst_abc')
  })

  it("returns 'self-hosted' and writes nothing when the global is absent", async () => {
    const { applyHostedContext } = await loadHostContext()
    const kind = await applyHostedContext()

    expect(kind).toBe('self-hosted')
    expect(game.settings.set).not.toHaveBeenCalled()
  })

  it('programmatic pairing: cfg-hosted route + no global → fetches the host key and stores it', async () => {
    globalThis.window.location = { pathname: '/servers/foundryvtt/rotfs/game', origin: 'https://core.crit-fumble.com' }
    // Same-origin install = the STORED (or declared) endpoint is this page's origin.
    // Since cs#414 the resolver never infers that from the path, so the fixture
    // has to say it; the `https://default` sentinel above would read as cross-origin.
    store = settingsStore({ coreApiUrl: 'https://core.crit-fumble.com', apiKey: '', installationId: '' })
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ endpoint: 'https://core.crit-fumble.com', apiKey: 'cfk_minted', installationId: 'inst_abc', cfgUserId: 'owner_1' }),
    }))

    const { applyHostedContext } = await loadHostContext()
    const kind = await applyHostedContext()

    expect(kind).toBe('cfg-hosted')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://core.crit-fumble.com/api/v1/account/foundry/hosted-context?installationId=rotfs',
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(store.get('apiKey')).toBe('cfk_minted')
    expect(store.get('installationId')).toBe('inst_abc')
  })

  it('programmatic pairing: non-owner GM (404) → clears any stale key so it falls back to session auth', async () => {
    globalThis.window.location = { pathname: '/servers/foundryvtt/rotfs/game', origin: 'https://core.crit-fumble.com' }
    store = settingsStore({ coreApiUrl: 'https://core.crit-fumble.com', apiKey: 'cfk_stale', installationId: 'inst_abc' })
    globalThis.fetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }))

    const { applyHostedContext } = await loadHostContext()
    const kind = await applyHostedContext()

    expect(kind).toBe('cfg-hosted')
    expect(store.get('apiKey')).toBe('') // stale Bearer cleared → session-cookie auth
  })

  it('nothing known at all (setting blanked, cookies lapsed) → no hosted-context fetch from the page origin (cs#414)', async () => {
    globalThis.window.location = { pathname: '/servers/foundryvtt/rotfs/game', origin: 'https://foundryvtt.crit-fumble.com' }
    globalThis.document.cookie = ''
    // `new URL(null, origin)` would resolve relative and read as same-origin —
    // i.e. fetch hosted-context from the Foundry host, which 302s to core and
    // fails CORS on every load. Unknown must mean "not this origin".
    store = settingsStore({ coreApiUrl: '', apiKey: 'cfk_stale', installationId: '' })
    globalThis.fetch = jest.fn()

    const { applyHostedContext } = await loadHostContext()
    const kind = await applyHostedContext()

    expect(kind).toBe('cfg-hosted')
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(store.get('apiKey')).toBe('')
  })

  it('skips the write when the setting already matches — no spurious change hooks', async () => {
    globalThis.window.__CFG_HOSTED_CONTEXT__ = {
      endpoint: 'https://cfg.example.com',
      apiKey: 'cfk_injected',
      installationId: 'inst_abc',
      cfgUserId: 'user_xyz',
    }
    settingsStore({
      coreApiUrl: 'https://cfg.example.com',
      apiKey: 'cfk_injected',
      installationId: 'inst_abc',
    })

    const { applyHostedContext } = await loadHostContext()
    await applyHostedContext()

    expect(game.settings.set).not.toHaveBeenCalled()
  })
})

describe('getHostedContext', () => {
  beforeEach(() => {
    globalThis.window = globalThis.window || {}
    delete globalThis.window.__CFG_HOSTED_CONTEXT__
  })

  it('returns the normalised context object when the global is well-formed', async () => {
    globalThis.window.__CFG_HOSTED_CONTEXT__ = {
      endpoint: 'https://core.crit-fumble.com/',
      apiKey: 'cfk_injected',
      installationId: 'inst_abc',
      cfgUserId: 'user_xyz',
    }
    const { getHostedContext } = await loadHostContext()
    expect(getHostedContext()).toEqual({
      endpoint: 'https://core.crit-fumble.com',
      apiKey: 'cfk_injected',
      installationId: 'inst_abc',
      cfgUserId: 'user_xyz',
    })
  })

  it('returns null when the global is absent', async () => {
    const { getHostedContext } = await loadHostContext()
    expect(getHostedContext()).toBeNull()
  })
})

/**
 * cs#391 / cs#414 — the core endpoint is NEVER "this page's origin".
 *
 * Hosted Foundry is served only from its own host (`foundryVttMode` 'retired'), so
 * `window.location.origin` on a hosted path is the Foundry host. Calling the platform
 * API there 302s to core: the browser follows cross-origin, CORS blocks the response,
 * and the redirect downgrades every POST to GET — which is how ~5h of snapshot pushes
 * were discarded in prod on 2026-09-15 (cs#414), on a tab whose 12h page cookies had
 * lapsed. The resolver used to fall back to the page origin in exactly that gap.
 *
 * These pin the precedence — injected context → cookie → stored setting → null — and,
 * in every fixture, that the page origin is not in it. The window is on the Foundry
 * host throughout so a regression toward `location.origin` reads as a wrong answer,
 * not a coincidentally right one.
 */
describe('resolveCoreEndpoint', () => {
  const PAGE_ORIGIN = 'https://foundryvtt.crit-fumble.com'

  beforeEach(() => {
    globalThis.window = globalThis.window || {}
    delete globalThis.window.__CFG_HOSTED_CONTEXT__
    globalThis.window.location = { pathname: '/servers/foundryvtt/inst-1/game', origin: PAGE_ORIGIN }
    globalThis.document = { cookie: '' }
    settingsStore({})
  })

  it('prefers the injected context over the cookie and the stored setting', async () => {
    globalThis.window.__CFG_HOSTED_CONTEXT__ = {
      endpoint: 'https://core.crit-fumble.com',
      apiKey: 'cfk_x',
      installationId: 'inst-1',
      cfgUserId: 'u1',
    }
    globalThis.document.cookie = 'cfg_core_endpoint=https://wrong.example'
    settingsStore({ coreApiUrl: 'https://also-wrong.example' })
    const { resolveCoreEndpoint } = await loadHostContext()
    expect(resolveCoreEndpoint()).toEqual({ endpoint: 'https://core.crit-fumble.com', declared: true })
  })

  it('cookie beats the stored setting, declared:true — the only channel that reaches a player or non-owner GM', async () => {
    globalThis.document.cookie = 'other=1; cfg_core_endpoint=https%3A%2F%2Fcore.crit-fumble.com; x=2'
    settingsStore({ coreApiUrl: 'https://stale-prod.example' })
    const { resolveCoreEndpoint } = await loadHostContext()
    expect(resolveCoreEndpoint()).toEqual({ endpoint: 'https://core.crit-fumble.com', declared: true })
  })

  it('hosted path, lapsed cookies, no injected context → the stored setting, declared:false, NEVER the page origin (cs#414)', async () => {
    settingsStore({ coreApiUrl: 'https://core.crit-fumble.com' })
    const { resolveCoreEndpoint } = await loadHostContext()
    const resolved = resolveCoreEndpoint()
    expect(resolved).toEqual({ endpoint: 'https://core.crit-fumble.com', declared: false })
    expect(resolved.endpoint).not.toBe(PAGE_ORIGIN)
  })

  it('hosted path with nothing at all → null, not the page origin', async () => {
    const { resolveCoreEndpoint } = await loadHostContext()
    expect(resolveCoreEndpoint()).toEqual({ endpoint: null, declared: false })
  })

  it('treats an empty stored setting as nothing, not as a cue to guess', async () => {
    settingsStore({ coreApiUrl: '' })
    const { resolveCoreEndpoint } = await loadHostContext()
    expect(resolveCoreEndpoint()).toEqual({ endpoint: null, declared: false })
  })

  it('uses the stored setting when self-hosted (not on the hosted path)', async () => {
    globalThis.window.location = { pathname: '/game', origin: 'https://foundry.local' }
    settingsStore({ coreApiUrl: 'https://core.crit-fumble.com' })
    const { resolveCoreEndpoint } = await loadHostContext()
    expect(resolveCoreEndpoint()).toEqual({ endpoint: 'https://core.crit-fumble.com', declared: false })
  })

  it('reports declared:false for the stored fallback, so a GM auto-correct knows not to overwrite', async () => {
    settingsStore({ coreApiUrl: 'https://core.crit-fumble.com' })
    const { resolveCoreEndpoint } = await loadHostContext()
    expect(resolveCoreEndpoint().declared).toBe(false)
  })
})

describe('readSeatKey', () => {
  beforeEach(() => {
    globalThis.window = globalThis.window || {}
    globalThis.window.location = { pathname: '/servers/foundryvtt/inst-1/game', origin: 'https://foundryvtt.crit-fumble.com' }
    globalThis.document = { cookie: '' }
    settingsStore({})
  })

  it('returns null when the platform sends no seat key — the state today', async () => {
    const { readSeatKey } = await loadHostContext()
    expect(readSeatKey()).toBeNull()
  })

  it('reads the per-seat key, which a player or non-owner GM has no other way to obtain', async () => {
    globalThis.document.cookie = 'a=1; cfg_foundry_seat_key=cfk_seat_abc; b=2'
    const { readSeatKey } = await loadHostContext()
    expect(readSeatKey()).toBe('cfk_seat_abc')
  })
})

// ── cs#391: hosted-context is a SAME-ORIGIN-only call ─────────────────────────
// It fetched from this PAGE's origin with `credentials: 'include'`. Once hosted
// Foundry moved to its own host that request could not succeed for three
// independent reasons — it 302s to core and re-runs CORS on the target, the
// endpoint is session-only since 401c7ff, and the cookie is refused from that
// origin both by CORS and by cookie-origin-trust. It failed on EVERY world load
// and was logged as "non-fatal", which trained the console to treat a CORS error
// as normal. That is how a real one gets missed.
describe('applyHostedContext — cross-origin core (cs#391)', () => {
  let store

  beforeEach(() => {
    globalThis.window = globalThis.window || {}
    delete globalThis.window.__CFG_HOSTED_CONTEXT__
    globalThis.document = { cookie: '' }
    globalThis.fetch = jest.fn()
    store = settingsStore({ coreApiUrl: 'https://core.crit-fumble.com', apiKey: 'cfk_stale', installationId: '' })
  })

  it('does NOT fetch hosted-context when core is a different origin', async () => {
    // The live shape: page on the Foundry host, core declared elsewhere.
    globalThis.window.location = {
      pathname: '/servers/foundryvtt/rotfs/game',
      origin: 'https://foundryvtt.crit-fumble.com',
    }
    globalThis.document = { cookie: 'cfg_core_endpoint=https://core.crit-fumble.com' }

    const { applyHostedContext } = await loadHostContext()
    const kind = await applyHostedContext()

    expect(kind).toBe('cfg-hosted')
    // The whole point — no request is made at all.
    expect(globalThis.fetch).not.toHaveBeenCalled()
    // And the stale owner key is cleared, so nothing sends a dead Bearer.
    expect(store.get('apiKey')).toBe('')
  })

  it('DOES fetch when core is this page\'s own origin — the same-origin path is unchanged', async () => {
    globalThis.window.location = {
      pathname: '/servers/foundryvtt/rotfs/game',
      origin: 'https://core.crit-fumble.com',
    }
    globalThis.document = { cookie: 'cfg_core_endpoint=https://core.crit-fumble.com' }
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        endpoint: 'https://core.crit-fumble.com',
        apiKey: 'cfk_minted',
        installationId: 'inst_abc',
      }),
    }))

    const { applyHostedContext } = await loadHostContext()
    await applyHostedContext()

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(store.get('apiKey')).toBe('cfk_minted')
  })

  it('with nothing declared, the STORED endpoint decides — same-origin stored → still fetches', async () => {
    // No endpoint cookie, no injected global: the guard must not invent a
    // cross-origin verdict and silently stop working on a same-origin install.
    // The store in beforeEach already names this origin.
    globalThis.window.location = {
      pathname: '/servers/foundryvtt/rotfs/game',
      origin: 'https://core.crit-fumble.com',
    }
    globalThis.document = { cookie: '' }
    globalThis.fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) }))

    const { applyHostedContext } = await loadHostContext()
    await applyHostedContext()

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('with nothing declared and core stored elsewhere, does NOT fetch from this page\'s origin (cs#414)', async () => {
    // The 2026-09-15 shape: a tab on the Foundry host whose 12h page cookies have
    // lapsed. The resolver used to answer with `location.origin` here, and this
    // call then 302'd to core and died in CORS on every world load. Now it reads
    // the stored setting, sees another origin, and makes no request at all.
    globalThis.window.location = {
      pathname: '/servers/foundryvtt/rotfs/game',
      origin: 'https://foundryvtt.crit-fumble.com',
    }
    globalThis.document = { cookie: '' }
    globalThis.fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) }))

    const { applyHostedContext } = await loadHostContext()
    const kind = await applyHostedContext()

    expect(kind).toBe('cfg-hosted')
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(store.get('apiKey')).toBe('')
  })

  it('an OPAQUE origin falls back to same-origin rather than disabling the call', async () => {
    // A sandboxed iframe reports `location.origin === 'null'` (the string), and
    // `new URL(x, 'null')` throws. The catch must default to SAME-origin: that
    // preserves today's behaviour, where defaulting the other way would silently
    // switch off hosted-context for anyone embedding Foundry in a frame.
    globalThis.window.location = { pathname: '/servers/foundryvtt/rotfs/game', origin: 'null' }
    globalThis.document = { cookie: 'cfg_core_endpoint=https://core.crit-fumble.com' }
    globalThis.fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) }))

    const { applyHostedContext } = await loadHostContext()
    await applyHostedContext()

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})
