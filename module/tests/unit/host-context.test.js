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
 * cs#391 — the core endpoint is no longer "this page's origin".
 *
 * Hosted Foundry is moving to its own host, so `window.location.origin` stops being
 * the platform API. These pin the precedence, because the risk is asymmetric: get it
 * wrong toward the page origin and the module calls the Foundry host for platform
 * APIs and PERSISTS that into world data; get it wrong toward the stored setting and
 * a stale prod URL breaks localdev. The order below is what satisfies both.
 */
describe('resolveCoreEndpoint', () => {
  beforeEach(() => {
    globalThis.window = globalThis.window || {}
    delete globalThis.window.__CFG_HOSTED_CONTEXT__
    globalThis.window.location = { pathname: '/servers/foundryvtt/inst-1/game', origin: 'https://foundryvtt.crit-fumble.com' }
    globalThis.document = { cookie: '' }
    settingsStore({})
  })

  it('prefers the injected context over everything', async () => {
    globalThis.window.__CFG_HOSTED_CONTEXT__ = {
      endpoint: 'https://core.crit-fumble.com',
      apiKey: 'cfk_x',
      installationId: 'inst-1',
      cfgUserId: 'u1',
    }
    globalThis.document.cookie = 'cfg_core_endpoint=https://wrong.example'
    const { resolveCoreEndpoint } = await loadHostContext()
    expect(resolveCoreEndpoint()).toEqual({ endpoint: 'https://core.crit-fumble.com', declared: true })
  })

  it('uses the server-declared cookie — the only channel that reaches a player or non-owner GM', async () => {
    globalThis.document.cookie = 'other=1; cfg_core_endpoint=https%3A%2F%2Fcore.crit-fumble.com; x=2'
    const { resolveCoreEndpoint } = await loadHostContext()
    // NOT the page origin, which is the Foundry host in this fixture.
    expect(resolveCoreEndpoint()).toEqual({ endpoint: 'https://core.crit-fumble.com', declared: true })
  })

  it('falls back to the page origin on a hosted path when nothing is declared — today behavior', async () => {
    const { resolveCoreEndpoint } = await loadHostContext()
    expect(resolveCoreEndpoint()).toEqual({ endpoint: 'https://foundryvtt.crit-fumble.com', declared: false })
  })

  it('prefers the page origin OVER a stored setting on a hosted path, so a stale prod URL cannot win', async () => {
    settingsStore({ coreApiUrl: 'https://stale-prod.example' })
    const { resolveCoreEndpoint } = await loadHostContext()
    expect(resolveCoreEndpoint().endpoint).toBe('https://foundryvtt.crit-fumble.com')
  })

  it('uses the stored setting when self-hosted (not on the hosted path)', async () => {
    globalThis.window.location = { pathname: '/game', origin: 'https://foundry.local' }
    settingsStore({ coreApiUrl: 'https://core.crit-fumble.com' })
    const { resolveCoreEndpoint } = await loadHostContext()
    expect(resolveCoreEndpoint()).toEqual({ endpoint: 'https://core.crit-fumble.com', declared: false })
  })

  it('reports declared:false for the fallbacks, so a GM auto-correct knows not to overwrite', async () => {
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
