/**
 * Host-environment detection (#699 / epic #419) — unit tests for the
 * window-global discriminator that distinguishes CFG-hosted Foundry from
 * self-hosted / third-party-hosted Foundry.
 */

import { jest } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    // Default: NOT on the cfg-hosted route.
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

  it('cfg-hosted route + no global → clears a stored key and makes no request', async () => {
    globalThis.window.location = { pathname: '/servers/foundryvtt/rotfs/game', origin: 'https://foundryvtt.crit-fumble.com' }
    store = settingsStore({ coreApiUrl: 'https://core.crit-fumble.com', apiKey: 'cfk_stale', installationId: 'inst_abc' })

    const { applyHostedContext } = await loadHostContext()
    const kind = await applyHostedContext()

    expect(kind).toBe('cfg-hosted')
    // Core mints no installation owner key (cfg-core-server#454): nothing to fetch.
    expect(globalThis.fetch).not.toHaveBeenCalled()
    // A key an older version stored is dead, so it is cleared: the seat key is the only Bearer.
    expect(store.get('apiKey')).toBe('')
    // The endpoint and installation id are the ready hook's to write, not this function's.
    expect(store.get('coreApiUrl')).toBe('https://core.crit-fumble.com')
    expect(store.get('installationId')).toBe('inst_abc')
  })

  it('cfg-hosted route with no stored key → writes nothing', async () => {
    globalThis.window.location = { pathname: '/servers/foundryvtt/rotfs/game', origin: 'https://foundryvtt.crit-fumble.com' }

    const { applyHostedContext } = await loadHostContext()
    const kind = await applyHostedContext()

    expect(kind).toBe('cfg-hosted')
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(game.settings.set).not.toHaveBeenCalled()
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
 * and the redirect downgrades every POST to GET, so writes are discarded. A page-origin
 * fallback lands exactly there on a tab whose 12h page cookies have lapsed.
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
    expect(resolveCoreEndpoint()).toEqual({ endpoint: 'https://core.crit-fumble.com', declared: true, source: 'injected' })
  })

  it('cookie beats the stored setting, declared:true — the only channel that reaches a player or non-owner GM', async () => {
    globalThis.document.cookie = 'other=1; cfg_core_endpoint=https%3A%2F%2Fcore.crit-fumble.com; x=2'
    settingsStore({ coreApiUrl: 'https://stale-prod.example' })
    const { resolveCoreEndpoint } = await loadHostContext()
    expect(resolveCoreEndpoint()).toEqual({ endpoint: 'https://core.crit-fumble.com', declared: true, source: 'cookie' })
  })

  it('hosted path, lapsed cookies, no injected context → the stored setting, declared:false, NEVER the page origin (cs#414)', async () => {
    settingsStore({ coreApiUrl: 'https://core.crit-fumble.com' })
    const { resolveCoreEndpoint } = await loadHostContext()
    const resolved = resolveCoreEndpoint()
    expect(resolved).toEqual({ endpoint: 'https://core.crit-fumble.com', declared: false, source: 'stored' })
    expect(resolved.endpoint).not.toBe(PAGE_ORIGIN)
  })

  it('hosted path with nothing at all → null, not the page origin', async () => {
    const { resolveCoreEndpoint } = await loadHostContext()
    expect(resolveCoreEndpoint()).toEqual({ endpoint: null, declared: false, source: null })
  })

  it('treats an empty stored setting as nothing, not as a cue to guess', async () => {
    settingsStore({ coreApiUrl: '' })
    const { resolveCoreEndpoint } = await loadHostContext()
    expect(resolveCoreEndpoint()).toEqual({ endpoint: null, declared: false, source: null })
  })

  it('uses the stored setting when self-hosted (not on the hosted path)', async () => {
    globalThis.window.location = { pathname: '/game', origin: 'https://foundry.local' }
    settingsStore({ coreApiUrl: 'https://core.crit-fumble.com' })
    const { resolveCoreEndpoint } = await loadHostContext()
    expect(resolveCoreEndpoint()).toEqual({ endpoint: 'https://core.crit-fumble.com', declared: false, source: 'stored' })
  })

  it('reports declared:false for the stored fallback, so a GM auto-correct knows not to overwrite', async () => {
    settingsStore({ coreApiUrl: 'https://core.crit-fumble.com' })
    const { resolveCoreEndpoint } = await loadHostContext()
    expect(resolveCoreEndpoint().declared).toBe(false)
  })

  // ── cs#455 F1: the cookie is writable by EVERY world on this origin ─────────
  // Not HttpOnly (the module must read it), and every hosted world shares the
  // Foundry host, so another world's JavaScript can set `cfg_core_endpoint` at a
  // LONGER path for this world — the browser then lists it FIRST — and choose where
  // this module sends its seat key.
  describe('a cookie another world could have written', () => {
    beforeEach(() => {
      settingsStore({ coreApiUrl: 'https://core.crit-fumble.com' })
      jest.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => console.warn.mockRestore())

    it('two DIFFERENT values → neither is used; falls back to the stored setting, with a warning', async () => {
      globalThis.document.cookie = 'cfg_core_endpoint=https%3A%2F%2Fevil.example; cfg_core_endpoint=https%3A%2F%2Fcore.crit-fumble.com'
      const { resolveCoreEndpoint } = await loadHostContext()
      expect(resolveCoreEndpoint()).toEqual({ endpoint: 'https://core.crit-fumble.com', declared: false, source: 'stored' })
      expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/2 different "cfg_core_endpoint" cookies/))
    })

    it('two IDENTICAL values are one answer, not a conflict', async () => {
      globalThis.document.cookie = 'cfg_core_endpoint=https%3A%2F%2Fcore.crit-fumble.com; cfg_core_endpoint=https://core.crit-fumble.com'
      const { resolveCoreEndpoint } = await loadHostContext()
      expect(resolveCoreEndpoint()).toEqual({ endpoint: 'https://core.crit-fumble.com', declared: true, source: 'cookie' })
      expect(console.warn).not.toHaveBeenCalled()
    })

    it.each([
      ['another domain', 'https://evil.example'],
      ['a lookalike sibling', 'https://core.crit-fumble.com.evil.example'],
      ['plain http to core', 'http://core.crit-fumble.com'],
      ['the Foundry host itself (cs#414)', PAGE_ORIGIN],
      ['a non-http scheme', 'javascript:alert(1)'],
      ['not a URL', 'core'],
    ])('a single cookie naming %s is refused → the stored setting', async (_label, value) => {
      globalThis.document.cookie = `cfg_core_endpoint=${encodeURIComponent(value)}`
      const { resolveCoreEndpoint } = await loadHostContext()
      expect(resolveCoreEndpoint()).toEqual({ endpoint: 'https://core.crit-fumble.com', declared: false, source: 'stored' })
    })
  })
})

describe('isAcceptableCookieEndpoint', () => {
  it.each([
    // prod: the Foundry host's sibling `core.` — and core's own edge, which is that sibling too
    ['https://core.crit-fumble.com', 'https://foundryvtt.crit-fumble.com', true],
    ['https://core.crit-fumble.com/', 'https://foundryvtt.crit-fumble.com', true],
    ['https://core.crit-fumble.com', 'https://core.crit-fumble.com', true],
    // single-origin stacks: e2e on localhost, the dev tunnel — core IS the page origin
    ['http://localhost:11000', 'http://localhost:11000', true],
    ['https://cfg-localdev.crit-fumble-web.workers.dev', 'https://cfg-localdev.crit-fumble-web.workers.dev', true],
    // refused
    ['http://localhost:11001', 'http://localhost:11000', false],
    ['https://foundryvtt.crit-fumble.com', 'https://foundryvtt.crit-fumble.com', false],
    ['https://core.example.com', 'https://foundryvtt.crit-fumble.com', false],
    ['https://core.crit-fumble.com:8443', 'https://foundryvtt.crit-fumble.com', false],
    ['https://core.crit-fumble.com', 'null', false],
    ['ftp://core.crit-fumble.com', 'https://foundryvtt.crit-fumble.com', false],
  ])('%s on a page at %s → %s', async (endpoint, pageOrigin, expected) => {
    const { isAcceptableCookieEndpoint } = await loadHostContext()
    expect(isAcceptableCookieEndpoint(endpoint, pageOrigin)).toBe(expected)
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

// ── cfg-core-server#454: no request, whatever origin core is ──────────────────
// The module used to fetch an installation owner key from core's `hosted-context`
// route when core was this page's own origin. Core no longer mints that key and
// the route is gone, so a hosted world makes no request on either shape.
describe('applyHostedContext — makes no request on any origin shape', () => {
  let store

  beforeEach(() => {
    globalThis.window = globalThis.window || {}
    delete globalThis.window.__CFG_HOSTED_CONTEXT__
    globalThis.document = { cookie: '' }
    globalThis.fetch = jest.fn()
    store = settingsStore({ coreApiUrl: 'https://core.crit-fumble.com', apiKey: 'cfk_stale', installationId: '' })
  })

  it.each([
    ['core is a different origin (the live shape)', 'https://foundryvtt.crit-fumble.com', 'cfg_core_endpoint=https://core.crit-fumble.com'],
    ["core is this page's own origin (a same-origin stack)", 'https://core.crit-fumble.com', 'cfg_core_endpoint=https://core.crit-fumble.com'],
    ['nothing declared, page cookies lapsed', 'https://foundryvtt.crit-fumble.com', ''],
    ['an opaque origin (a sandboxed frame)', 'null', 'cfg_core_endpoint=https://core.crit-fumble.com'],
  ])('%s', async (_name, origin, cookie) => {
    globalThis.window.location = { pathname: '/servers/foundryvtt/rotfs/game', origin }
    globalThis.document = { cookie }

    const { applyHostedContext } = await loadHostContext()
    const kind = await applyHostedContext()

    expect(kind).toBe('cfg-hosted')
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(store.get('apiKey')).toBe('')
  })
})

// ── cs#455 F1: the ready hook never PERSISTS a cookie-derived endpoint ────────
// `coreApiUrl` is world data every client of the world falls back to, across
// sessions; a cookie is something any world on the origin can write. Pinned against
// the source, as purge-legacy-world-api-key.test.js does: module.js is one import
// with ~30 side effects.
describe('module.js ready hook — what may be written to coreApiUrl', () => {
  const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../scripts/module.js'), 'utf8')
  const start = SOURCE.indexOf('const resolved = resolveCoreEndpoint()')
  const block = SOURCE.slice(start, SOURCE.indexOf('const detectedInstallId', start))

  it('the auto-correct block exists', () => {
    expect(start).toBeGreaterThan(-1)
  })

  it('writes a declared endpoint only when it was INJECTED, never from the cookie', () => {
    expect(block).toMatch(/if \(resolved\.declared\) \{\s*if \(resolved\.source === 'injected' &&/)
  })

  it('every coreApiUrl write sits behind that guard or the undeclared (stored-value) branch', () => {
    const writes = block.match(/game\.settings\.set\(MODULE_ID, 'coreApiUrl'/g) ?? []
    expect(writes).toHaveLength(2)
    expect(block).toMatch(/\} else if \(resolved\.endpoint && storedUrl !== resolved\.endpoint\)/)
  })
})
