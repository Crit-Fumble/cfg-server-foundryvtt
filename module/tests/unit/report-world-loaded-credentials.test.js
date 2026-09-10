/**
 * The world-load heartbeat must not ask for cookies when it is sending a Bearer
 * (cs#391).
 *
 * `_reportWorldLoaded` set `credentials: 'include'` UNCONDITIONALLY, alongside an
 * `Authorization` header. Same-origin that was merely redundant. Cross-origin it
 * is fatal, and in a way the Bearer cannot rescue: core deliberately withholds
 * `Access-Control-Allow-Credentials` for the Foundry origin — that withholding IS
 * the origin separation, since it is what stops a GM-installed module spending a
 * visitor's session — so the browser rejects the response before reading it. The
 * request was authenticated and still failed.
 *
 * ⚠️ This file exists because the fix was mutation-checked and NOTHING went red:
 * restoring the unconditional `credentials: 'include'` left the suite green. A
 * fix no test can see is one refactor away from being undone.
 *
 * Mirrors the function rather than importing it — module.js is one big import
 * with ~30 side effects — and the second describe pins the mirror to the real
 * source, the same technique as purge-legacy-world-api-key.test.js.
 */
import { jest } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The credential half of `_reportWorldLoaded`, mirrored. */
function buildInit(apiKey) {
  const headers = { 'content-type': 'application/json' }
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`
  return {
    method: 'POST',
    headers,
    ...(apiKey ? {} : { credentials: 'include' }),
    body: JSON.stringify({ status: 'ready' }),
  }
}

describe('_reportWorldLoaded credential mode', () => {
  it('with a Bearer: cookies are OMITTED, not merely unused', async () => {
    const init = buildInit('cfk_seat_abc')
    expect(init.headers.authorization).toBe('Bearer cfk_seat_abc')
    // The whole point: `credentials` must be ABSENT, so fetch defaults to
    // same-origin and the cross-origin preflight is never asked for cookies.
    expect(init.credentials).toBeUndefined()
  })

  it('with no Bearer: falls back to the session cookie (same-origin hosted)', async () => {
    const init = buildInit(null)
    expect(init.headers.authorization).toBeUndefined()
    expect(init.credentials).toBe('include')
  })

  it('never sends BOTH — that combination is what the browser rejects', async () => {
    for (const key of ['cfk_seat_abc', 'cfk_paired', null]) {
      const init = buildInit(key)
      const hasBearer = !!init.headers.authorization
      const asksForCookies = init.credentials === 'include'
      expect(hasBearer && asksForCookies).toBe(false)
    }
  })
})

describe('the mirror matches module.js', () => {
  const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../scripts/module.js'), 'utf8')
  const start = SOURCE.indexOf('async function _reportWorldLoaded')
  const body = SOURCE.slice(start, start + 1600)

  it('the function exists', () => {
    expect(start).toBeGreaterThan(-1)
  })

  it('sets the Bearer from the resolved key', () => {
    expect(body).toMatch(/headers\['authorization'\] = `Bearer \$\{apiKey\}`/)
  })

  it('⛔ makes credentials CONDITIONAL on there being no key', () => {
    // The regression guard. An unconditional `credentials: 'include'` here is
    // the exact bug, and it is invisible to every other test in this repo.
    expect(body).toMatch(/\.\.\.\(apiKey \? \{\} : \{ credentials: 'include' \}\)/)
    expect(body).not.toMatch(/^\s*credentials: 'include',\s*$/m)
  })
})
