/**
 * The world-load report rides the courier client (cs#391, cs#414).
 *
 * A raw fetch with a credential rule of its own breaks cross-origin: sending
 * `credentials: 'include'` beside a Bearer is rejected because core withholds
 * `Access-Control-Allow-Credentials` for the Foundry origin, and asking for cookies on a
 * keyless page is refused just the same — so every keyless page would lose the report,
 * `pluginVersion` included, and nobody could tell which module version had actually run.
 *
 * `_reportWorldLoaded` calls `_api.post`, so the key, the cookie rule and the cs#414
 * renewal are the client's own, pinned in clients/api-client.test.js and
 * seat-key-renewal.test.js. This file pins the routing, that only a GM's tab sends the
 * report (3.3.5), and that a page load makes no other request of core.
 *
 * Pinned against the source rather than imported: module.js is one big import with ~30
 * side effects — the same technique as purge-legacy-world-api-key.test.js.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../scripts/module.js'), 'utf8')

/** The body of a top-level function in module.js, up to its closing brace. */
function bodyOf(name) {
  const start = SOURCE.indexOf(`async function ${name}(`)
  if (start === -1) return null
  return SOURCE.slice(start, SOURCE.indexOf('\n}\n', start))
}

describe('_reportWorldLoaded rides the courier client', () => {
  const body = bodyOf('_reportWorldLoaded')

  it('the function exists', () => {
    expect(body).not.toBeNull()
  })

  it('posts the world status through _api', () => {
    expect(body).toMatch(/_api\.post\(`\/api\/v1\/foundry\/worlds\/\$\{encodeURIComponent\(game\.world\.id\)\}\/status`/)
  })

  it('⛔ makes no request of its own and picks no credential mode', () => {
    // A raw fetch here is the regression: it cannot renew, and it has to invent a
    // cookie rule the client already gets right.
    expect(body).not.toMatch(/\bfetch\(/)
    expect(body).not.toMatch(/credentials/)
    expect(body).not.toMatch(/authorization/i)
  })

  it('still reports the version that is actually running', () => {
    expect(body).toMatch(/pluginVersion: MODULE_VERSION\(\)/)
  })

  it("only a GM's tab sends it — one report per load says what the world runs", () => {
    expect(body).toMatch(/if \(!game\.user\?\.isGM \|\| /)
  })
})

describe('a page load asks core for nothing else (3.3.5)', () => {
  // Core reads who is connected from Foundry, "a human GM is here" off the provision poll,
  // and the CFG↔Foundry user link from its own seat rows. None of these may come back.
  it.each([
    ['the activity heartbeat', /\/activity\b|ActivityHeartbeat/],
    // The Linked Campaigns dialog still reads that route when a GM opens it (views/cfg-campaign-links.js).
    ['the linked-campaign lookup', /_api\.get\('\/api\/v1\/account\/foundry\/campaigns'\)|linkedCampaignIds/],
    ['the account lookup and its user flag', /\/api\/v1\/account\/user|platformUserId/],
  ])('no %s', (_label, pattern) => {
    expect(SOURCE).not.toMatch(pattern)
  })
})
