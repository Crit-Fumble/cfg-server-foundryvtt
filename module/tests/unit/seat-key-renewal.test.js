/**
 * A seat key that dies mid-session is renewed, and a GM is told when it cannot be
 * (cs#414).
 *
 * The platform mints the seat key on a top-level navigation, and a Foundry session is
 * exactly one — `/game` is an SPA on a websocket. So a tab open past the key's 12h held
 * a dead key and 401'd on every courier tick while Foundry itself played on. Measured in
 * prod 2026-09-15: the platform's copy of a world froze for 1h45m and nothing said so.
 *
 * Two halves, both pinned here:
 *   · `renewSeatKey` (host-context.js) asks the platform for the seat's CURRENT key with
 *     a marked same-origin request, and tells a GM once when it cannot;
 *   · `CoreAPIClient` answers a 401 by renewing and retrying ONCE.
 */
import { jest } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORLD = '/servers/foundryvtt/inst-1/'
const DEAD = 'cfk_seat_dead'
const FRESH = 'cfk_seat_fresh'

/**
 * A `document.cookie` with the one browser rule these tests lean on: of same-named
 * cookies the page can see, the one with the LONGEST path comes first — which is what
 * lets the world's own cookie win over one planted at a broader path. Writes from page
 * script are recorded (the renewal makes none).
 */
function cookieJar(entries = []) {
  const jar = new Map()
  const put = (name, value, path = WORLD) => jar.set(`${name}|${path}`, { name, value, path })
  for (const [name, value, path] of entries) put(name, value, path)
  const writes = []
  globalThis.document = {
    get cookie() {
      const here = globalThis.window.location.pathname
      return [...jar.values()]
        .filter((c) => here.startsWith(c.path))
        .sort((a, b) => b.path.length - a.path.length)
        .map((c) => `${c.name}=${c.value}`)
        .join('; ')
    },
    set cookie(str) {
      writes.push(str)
    },
  }
  return { put, writes }
}

/** forward-auth's answer to the renewal, as Caddy relays it: a Set-Cookie at the world's path, or none. */
function platformAnswers({ key = FRESH, status = 200 } = {}, { put }) {
  globalThis.fetch = jest.fn(async () => {
    if (key) put('cfg_foundry_seat_key', key)
    return { status }
  })
  return globalThis.fetch
}

async function loadHostContext() {
  jest.resetModules()
  return await import('../../scripts/auth/host-context.js')
}

let now
let dateNow
beforeEach(() => {
  jest.clearAllMocks()
  now = 1_000_000
  dateNow = jest.spyOn(Date, 'now').mockImplementation(() => now)
  globalThis.window = { location: { pathname: `${WORLD}game`, origin: 'https://foundryvtt.crit-fumble.com' } }
  game.user.isGM = true
  ui.notifications.remove = jest.fn()
})

afterEach(() => {
  dateNow.mockRestore()
})

describe('renewSeatKey — asking the platform for the seat’s current key', () => {
  it('asks its OWN origin with the renewal marker, no Bearer, and no cookie surgery', async () => {
    const jar = cookieJar([['cfg_foundry_seat_key', DEAD]])
    const fetch = platformAnswers({}, jar)
    const { renewSeatKey } = await loadHostContext()

    expect(await renewSeatKey(DEAD)).toBe(FRESH)

    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(`${WORLD}api/status?cfg_seat_renew=1`)
    expect(init).toEqual({ cache: 'no-store', credentials: 'same-origin', signal: expect.any(AbortSignal) })
    // ⛔ No Authorization: core refuses to mint for a cfk_ credential, and a dead one
    // 401s the request before the platform session beside it is read.
    expect(init.headers).toBeUndefined()
    expect(jar.writes).toEqual([])
  })

  // Another script on this shared origin can write a same-named cookie at a broader
  // path. The world's own cookie, which core just re-set, is the longer path and wins.
  it('adopts the world’s own cookie, never one planted at a broader path', async () => {
    const jar = cookieJar([
      ['cfg_foundry_seat_key', DEAD],
      ['cfg_foundry_seat_key', 'cfk_planted', '/'],
      ['cfg_foundry_seat_key', 'cfk_planted_too', '/servers/foundryvtt/'],
    ])
    platformAnswers({}, jar)
    const { renewSeatKey } = await loadHostContext()

    expect(await renewSeatKey(DEAD)).toBe(FRESH)
  })

  // What the jar shows is not proof core issued it, so the renewal always asks. Core
  // answers from its cache — the key another tab already got — at no mint's cost.
  it('asks even when the jar already shows another key', async () => {
    const jar = cookieJar([['cfg_foundry_seat_key', FRESH]])
    const fetch = platformAnswers({}, jar)
    const { renewSeatKey } = await loadHostContext()

    expect(await renewSeatKey(DEAD)).toBe(FRESH)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  // Self-hosted: a 401 there means the paired key needs re-pairing, which this
  // cannot do — and there is no forward-auth to ask.
  it('does nothing off a hosted path', async () => {
    cookieJar()
    globalThis.window.location.pathname = '/game'
    globalThis.fetch = jest.fn()
    const { renewSeatKey } = await loadHostContext()

    expect(await renewSeatKey('cfk_paired')).toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  // Nineteen couriers hit the same 401 on the same tick.
  it('collapses concurrent renewals into one request', async () => {
    const jar = cookieJar([['cfg_foundry_seat_key', DEAD]])
    const fetch = platformAnswers({}, jar)
    const { renewSeatKey } = await loadHostContext()

    const keys = await Promise.all([renewSeatKey(DEAD), renewSeatKey(DEAD), renewSeatKey(DEAD)])
    expect(keys).toEqual([FRESH, FRESH, FRESH])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  // Core handed back the key it refuses — or handed back nothing and the dead one is
  // still in the jar. Either way nothing changed.
  it('treats the same key as a failure, not a renewal', async () => {
    const jar = cookieJar([['cfg_foundry_seat_key', DEAD]])
    platformAnswers({ key: DEAD }, jar)
    const { renewSeatKey } = await loadHostContext()

    expect(await renewSeatKey(DEAD)).toBeNull()
  })

  // Only a 2xx reached the container, so only a 2xx can have carried core's cookie.
  it('a refused renewal adopts nothing the jar happens to show', async () => {
    const jar = cookieJar([['cfg_foundry_seat_key', 'cfk_planted', `${WORLD}game`]])
    platformAnswers({ key: null, status: 503 }, jar)
    const { renewSeatKey } = await loadHostContext()

    expect(await renewSeatKey(DEAD)).toBeNull()
    expect(ui.notifications.warn).toHaveBeenCalledTimes(1)
  })

  // A stalled request must not hold every 401'd courier on `_renewing` indefinitely.
  it('gives up after 20s: a failed renewal, and the next one can run', async () => {
    jest.useFakeTimers({ doNotFake: ['Date'] })
    try {
      cookieJar([['cfg_foundry_seat_key', DEAD]])
      globalThis.fetch = jest.fn(
        (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      )
      const { renewSeatKey } = await loadHostContext()

      const pending = renewSeatKey(DEAD)
      await jest.advanceTimersByTimeAsync(19_999)
      expect(ui.notifications.warn).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(1)
      expect(await pending).toBeNull()
      expect(ui.notifications.warn).toHaveBeenCalledTimes(1)

      now += 61_000
      renewSeatKey(DEAD)
      expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  // A tab whose platform session is gone gets a 401 from forward-auth every time.
  it('asks at most once a minute after a failure', async () => {
    const jar = cookieJar([['cfg_foundry_seat_key', DEAD]])
    const fetch = platformAnswers({ key: null, status: 401 }, jar)
    const { renewSeatKey } = await loadHostContext()

    await renewSeatKey(DEAD)
    now += 59_000
    expect(await renewSeatKey(DEAD)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
    now += 2_000
    await renewSeatKey(DEAD)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('renewSeatKey — the GM is told, once, and untold on recovery', () => {
  it('warns a GM with a notification that stays up, and promises nothing', async () => {
    const jar = cookieJar([['cfg_foundry_seat_key', DEAD]])
    platformAnswers({ key: null, status: 401 }, jar)
    const { renewSeatKey } = await loadHostContext()

    await renewSeatKey(DEAD)
    expect(ui.notifications.warn).toHaveBeenCalledTimes(1)
    const [message, options] = ui.notifications.warn.mock.calls[0]
    expect(message).toMatch(/platform sync is paused/)
    expect(message).toMatch(/Your game is unaffected/)
    // "try again", not "to resume": a key revoked while core still caches it (cs#392)
    // survives a reload too, so the notice must not promise one fixes it.
    expect(message).toMatch(/reload the page to try again/)
    expect(options).toEqual({ permanent: true })
  })

  it('does not repeat the warning on every failed tick', async () => {
    const jar = cookieJar([['cfg_foundry_seat_key', DEAD]])
    platformAnswers({ key: null, status: 401 }, jar)
    const { renewSeatKey } = await loadHostContext()

    await renewSeatKey(DEAD)
    now += 61_000
    await renewSeatKey(DEAD)
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    expect(ui.notifications.warn).toHaveBeenCalledTimes(1)
  })

  // A stale "paused — reload" left up while sync works is wrong twice: it tells the GM
  // something false, and while it stands the NEXT real outage is never announced.
  it('takes the warning down and says sync resumed — whatever refilled the jar', async () => {
    const notice = { id: 7 }
    ui.notifications.warn.mockReturnValueOnce(notice)
    const jar = cookieJar([['cfg_foundry_seat_key', DEAD]])
    platformAnswers({ key: null, status: 503 }, jar)
    const { renewSeatKey } = await loadHostContext()
    await renewSeatKey(DEAD)

    // Another tab got the key meanwhile; this tab's next ask is answered from core's cache.
    jar.put('cfg_foundry_seat_key', FRESH)
    now += 61_000
    platformAnswers({}, jar)
    const { settleSeatKeyRenewal } = await import('../../scripts/auth/host-context.js')
    expect(await renewSeatKey(DEAD)).toBe(FRESH)
    // A candidate is not a recovery: nothing changes until core has accepted it.
    expect(ui.notifications.remove).not.toHaveBeenCalled()
    settleSeatKeyRenewal(true)
    expect(ui.notifications.remove).toHaveBeenCalledWith(notice)
    expect(ui.notifications.info).toHaveBeenCalledWith('Crit-Fumble: platform sync resumed.')
  })

  // A key the jar showed but core refuses — a garbage or dead cookie planted where it
  // shadows core's — is a failed renewal, not a recovery.
  it('a renewed key core refuses is a failure: the GM is told', async () => {
    const jar = cookieJar([['cfg_foundry_seat_key', DEAD]])
    platformAnswers({}, jar)
    const { renewSeatKey, settleSeatKeyRenewal } = await loadHostContext()

    expect(await renewSeatKey(DEAD)).toBe(FRESH)
    settleSeatKeyRenewal(false)
    expect(ui.notifications.warn).toHaveBeenCalledTimes(1)
    expect(ui.notifications.info).not.toHaveBeenCalled()
  })

  it('announces the next outage after a recovery', async () => {
    const jar = cookieJar([['cfg_foundry_seat_key', DEAD]])
    platformAnswers({ key: null, status: 401 }, jar)
    const { renewSeatKey, settleSeatKeyRenewal } = await loadHostContext()
    await renewSeatKey(DEAD)
    now += 61_000
    platformAnswers({}, jar)
    await renewSeatKey(DEAD)
    settleSeatKeyRenewal(true)

    now += 61_000
    platformAnswers({ key: null, status: 401 }, jar)
    await renewSeatKey(FRESH)
    expect(ui.notifications.warn).toHaveBeenCalledTimes(2)
  })

  it('a quiet renewal shows nothing at all', async () => {
    const jar = cookieJar([['cfg_foundry_seat_key', DEAD]])
    platformAnswers({}, jar)
    const { renewSeatKey } = await loadHostContext()

    await renewSeatKey(DEAD)
    expect(ui.notifications.warn).not.toHaveBeenCalled()
    expect(ui.notifications.info).not.toHaveBeenCalled()
  })

  it('does not notify a player', async () => {
    game.user.isGM = false
    const jar = cookieJar([['cfg_foundry_seat_key', DEAD]])
    platformAnswers({ key: null, status: 401 }, jar)
    const { renewSeatKey } = await loadHostContext()

    await renewSeatKey(DEAD)
    expect(ui.notifications.warn).not.toHaveBeenCalled()
  })
})

describe('CoreAPIClient — a 401 renews and retries once', () => {
  let CoreAPIClient
  const ok = (body = { ok: true }) => ({ ok: true, status: 200, json: async () => body })
  const unauthorized = () => ({ ok: false, status: 401, json: async () => ({ error: 'Invalid or expired API key' }) })
  const badGateway = () => ({ ok: false, status: 502, json: async () => ({}) })
  const bearerOf = (call) => call[1].headers['Authorization']
  const CORE = 'https://core.crit-fumble.com'

  /**
   * A fetch whose answers the test hands out one at a time, in any order — how two
   * couriers in flight across a key swap actually interleave.
   */
  function heldFetch() {
    const held = []
    globalThis.fetch = jest.fn(
      (_url, init) =>
        new Promise((resolve) => held.push({ bearer: init.headers['Authorization'], answer: resolve })),
    )
    return held
  }
  const settleTurn = () => new Promise((r) => setTimeout(r, 0))

  /** A GM who has already been told "sync paused", so a recovery is visible as "resumed". */
  async function afterAFailedRenewal() {
    const jar = cookieJar([['cfg_foundry_seat_key', DEAD]])
    platformAnswers({ key: null, status: 503 }, jar)
    const host = await loadHostContext()
    await host.renewSeatKey(DEAD)
    expect(ui.notifications.warn).toHaveBeenCalledTimes(1)
    now += 61_000
    return host
  }

  beforeAll(async () => {
    ;({ CoreAPIClient } = await import('../../scripts/clients/api-client.js'))
  })

  it('retries with the renewed key and returns its answer', async () => {
    globalThis.fetch = jest.fn().mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ok({ n: 1 }))
    const renewKey = jest.fn(async () => FRESH)
    const api = new CoreAPIClient('https://core.crit-fumble.com', DEAD, { renewKey })

    await expect(api.get('/api/v1/x')).resolves.toEqual({ n: 1 })
    expect(renewKey).toHaveBeenCalledWith(DEAD)
    expect(bearerOf(globalThis.fetch.mock.calls[0])).toBe(`Bearer ${DEAD}`)
    expect(bearerOf(globalThis.fetch.mock.calls[1])).toBe(`Bearer ${FRESH}`)
    // Every later call rides the new key without asking again.
    globalThis.fetch.mockResolvedValueOnce(ok())
    await api.get('/api/v1/y')
    expect(bearerOf(globalThis.fetch.mock.calls[2])).toBe(`Bearer ${FRESH}`)
    expect(renewKey).toHaveBeenCalledTimes(1)
  })

  it('surfaces the 401 when nothing could be renewed', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(unauthorized())
    const api = new CoreAPIClient('https://core.crit-fumble.com', DEAD, { renewKey: async () => null })

    await expect(api.get('/api/v1/x')).rejects.toThrow('Invalid or expired CFG API key')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  // A renewed key that is refused too must not start a loop.
  it('retries at most once', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(unauthorized())
    const renewKey = jest.fn(async () => FRESH)
    const api = new CoreAPIClient('https://core.crit-fumble.com', DEAD, { renewKey })

    await expect(api.get('/api/v1/x')).rejects.toThrow()
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    expect(renewKey).toHaveBeenCalledTimes(1)
  })

  // The 12h rollover with two couriers in flight on the dead key. A renews and retries;
  // B's DEAD 401 lands after the swap. It is an answer about the OLD key, so it must not
  // be read as "core refused the renewed key" — that was a false "sync paused" at every
  // rollover. B retries with the key A already got, without asking again.
  it('an old-key 401 landing after the swap says nothing about the new key', async () => {
    const { settleSeatKeyRenewal } = await afterAFailedRenewal()
    const settle = jest.fn(settleSeatKeyRenewal)
    const renewKey = jest.fn(async () => FRESH)
    const held = heldFetch()
    const api = new CoreAPIClient(CORE, DEAD, { renewKey, onRenewed: settle })

    const a = api.get('/api/v1/a')
    const b = api.get('/api/v1/b')
    await settleTurn()
    held[0].answer(unauthorized()) // A: dead key refused → renew → retry with FRESH
    await settleTurn()
    expect(held.map((h) => h.bearer)).toEqual([`Bearer ${DEAD}`, `Bearer ${DEAD}`, `Bearer ${FRESH}`])
    held[1].answer(unauthorized()) // B: its OLD-key 401, after the swap
    await settleTurn()
    expect(settle).not.toHaveBeenCalled()
    expect(renewKey).toHaveBeenCalledTimes(1)
    expect(held[3].bearer).toBe(`Bearer ${FRESH}`)

    held[2].answer(ok()) // A's FRESH answer settles it — the only kind that may
    held[3].answer(ok())
    await Promise.all([a, b])
    expect(settle.mock.calls).toEqual([[true]])
    expect(ui.notifications.warn).toHaveBeenCalledTimes(1) // the earlier one; no new "paused"
    expect(ui.notifications.info.mock.calls).toEqual([['Crit-Fumble: platform sync resumed.']])
  })

  // The reverse: B's old-key answer lands first and is NOT a 401 — a 502 while core
  // restarts, or a 200 for a request sent just before the key expired. Neither is about
  // FRESH, and FRESH's own refusal must still reach the GM.
  it.each([
    ['502', () => ({ ok: false, status: 502, json: async () => ({}) })],
    ['200', () => ({ ok: true, status: 200, json: async () => ({}) })],
  ])('an old-key %s landing first does not settle the new key; its 401 is still reported', async (_label, oldKeyAnswer) => {
    const { settleSeatKeyRenewal } = await loadHostContext()
    const settle = jest.fn(settleSeatKeyRenewal)
    const held = heldFetch()
    const api = new CoreAPIClient(CORE, DEAD, { renewKey: async () => FRESH, onRenewed: settle })

    const a = api.get('/api/v1/a')
    const b = api.get('/api/v1/b')
    await settleTurn()
    held[0].answer(unauthorized()) // A renews, retries with FRESH
    await settleTurn()
    held[1].answer(oldKeyAnswer()) // B: old key, after the swap
    await b.catch(() => {})
    expect(settle).not.toHaveBeenCalled()

    held[2].answer(unauthorized()) // FRESH refused
    await expect(a).rejects.toThrow()
    expect(settle.mock.calls).toEqual([[false]])
    expect(ui.notifications.warn).toHaveBeenCalledTimes(1)
  })

  // Caddy answers 502/503 while core restarts, and core can 500 before it reads the key.
  // Neither is a verdict on the key: it stays pending until a 2xx or a 401 about IT.
  it('a 5xx to the renewed key leaves it pending; its next 2xx settles it', async () => {
    const onRenewed = jest.fn()
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(badGateway())
      .mockResolvedValue(ok())
    const api = new CoreAPIClient(CORE, DEAD, { renewKey: async () => FRESH, onRenewed })

    await expect(api.get('/api/v1/x')).rejects.toThrow()
    expect(onRenewed).not.toHaveBeenCalled()
    await api.get('/api/v1/y')
    expect(onRenewed.mock.calls).toEqual([[true]])
  })

  // The 2026-09-26 outage shape: a page restored from the browser cache booted with no
  // seat cookie, so the client was BORN keyless and its 401s carried no Authorization at
  // all. The renewal must not need a key to have been there first.
  it('a client born keyless renews on its first 401 and retries with the key', async () => {
    globalThis.fetch = jest.fn().mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ok({ n: 1 }))
    const renewKey = jest.fn(async () => FRESH)
    const api = new CoreAPIClient('https://core.crit-fumble.com', null, { renewKey })

    await expect(api.post('/api/v1/foundry/worlds/w/status', { status: 'ready' })).resolves.toEqual({ n: 1 })
    expect(renewKey).toHaveBeenCalledWith(null)
    const [first, retry] = globalThis.fetch.mock.calls
    expect(first[1].headers['Authorization']).toBeUndefined()
    // Cross-origin and keyless: never asks for cookies, before or after.
    expect(first[1].credentials).toBeUndefined()
    expect(retry[1].headers['Authorization']).toBe(`Bearer ${FRESH}`)
    expect(retry[1].credentials).toBeUndefined()
    expect(retry[1].body).toBe(JSON.stringify({ status: 'ready' }))
  })

  it('end to end: an empty jar at boot, the real renewSeatKey, one retry', async () => {
    const jar = cookieJar()
    const { renewSeatKey } = await loadHostContext()
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.startsWith(WORLD)) {
        // forward-auth answering the marked renewal: a Set-Cookie at the world's path.
        jar.put('cfg_foundry_seat_key', FRESH)
        return { status: 200 }
      }
      return init.headers['Authorization'] === `Bearer ${FRESH}` ? ok({ n: 2 }) : unauthorized()
    })
    const api = new CoreAPIClient('https://core.crit-fumble.com', null, { renewKey: renewSeatKey })

    await expect(api.get('/api/v1/installations/i/foundry/actor-sync')).resolves.toEqual({ n: 2 })
    const urls = globalThis.fetch.mock.calls.map(([url]) => url)
    expect(urls).toEqual([
      'https://core.crit-fumble.com/api/v1/installations/i/foundry/actor-sync',
      `${WORLD}api/status?cfg_seat_renew=1`,
      'https://core.crit-fumble.com/api/v1/installations/i/foundry/actor-sync',
    ])
  })

  // The renewed key is settled by the first answer it gets, and only once.
  it('tells the renewer whether core accepted the renewed key', async () => {
    const onRenewed = jest.fn()
    globalThis.fetch = jest.fn().mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ok()).mockResolvedValue(ok())
    const api = new CoreAPIClient('https://core.crit-fumble.com', DEAD, { renewKey: async () => FRESH, onRenewed })
    await api.get('/api/v1/x')
    await api.get('/api/v1/y')
    expect(onRenewed.mock.calls).toEqual([[true]])

    const refused = jest.fn()
    globalThis.fetch = jest.fn().mockResolvedValue(unauthorized())
    const api2 = new CoreAPIClient('https://core.crit-fumble.com', DEAD, { renewKey: async () => FRESH, onRenewed: refused })
    await expect(api2.get('/api/v1/x')).rejects.toThrow()
    expect(refused.mock.calls).toEqual([[false]])
  })

  it('a retry that never answered is settled by the next call', async () => {
    const onRenewed = jest.fn()
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(unauthorized())
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(ok())
    const api = new CoreAPIClient('https://core.crit-fumble.com', DEAD, { renewKey: async () => FRESH, onRenewed })
    await expect(api.get('/api/v1/x', { retries: 2 })).rejects.toThrow('offline')
    expect(onRenewed).not.toHaveBeenCalled()
    await api.get('/api/v1/y')
    expect(onRenewed.mock.calls).toEqual([[true]])
  })

  it('without a renewer a 401 behaves exactly as before', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(unauthorized())
    const api = new CoreAPIClient('https://core.crit-fumble.com', DEAD)

    await expect(api.get('/api/v1/x')).rejects.toThrow('Invalid or expired CFG API key')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})

// module.js is one big import with ~30 side effects, so the wiring is pinned against
// its source — the technique report-world-loaded-credentials.test.js uses. Without the
// renewer every piece above is correct and a long session still dies at 12h.
describe('module.js wires the renewer into the courier client', () => {
  it('constructs CoreAPIClient with renewSeatKey', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, '../../scripts/module.js'), 'utf8')
    expect(src).toMatch(
      /new CoreAPIClient\(apiUrl, apiKey, \{ renewKey: renewSeatKey, onRenewed: settleSeatKeyRenewal \}\)/,
    )
  })
})
