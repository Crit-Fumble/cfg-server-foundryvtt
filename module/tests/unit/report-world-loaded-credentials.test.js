/**
 * The world-load report rides the courier client (cs#414, after cs#391).
 *
 * `_reportWorldLoaded` used to be a raw fetch with a credential rule of its own. cs#391
 * found it sending `credentials: 'include'` beside a Bearer, which the browser rejects
 * cross-origin because core withholds `Access-Control-Allow-Credentials` for the Foundry
 * origin; the fix made cookies conditional on having NO key. That still asked for
 * cookies whenever the page was keyless — refused cross-origin just the same — so in
 * the 2026-09-26 outage every keyless page lost the report, `pluginVersion` included,
 * and nobody could tell which module version had actually run.
 *
 * It now calls `_api.post`, so the key, the cookie rule and the cs#414 renewal are the
 * client's own, pinned in clients/api-client.test.js and seat-key-renewal.test.js.
 * `_linkPlatformUser` had the same shape (a client of its own, built from the key
 * `ready` started with) and moved with it. This file pins the routing.
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
})

describe('_linkPlatformUser rides it too', () => {
  const body = bodyOf('_linkPlatformUser')

  it('uses _api, not a client built from the key `ready` started with', () => {
    expect(body).toMatch(/_api\.get\('\/api\/v1\/account\/user'\)/)
    expect(body).not.toMatch(/new CoreAPIClient/)
  })
})
