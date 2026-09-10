/**
 * The `apiKey` setting must stay CLIENT-scoped.
 *
 * This is a source-level assertion, and that is deliberate rather than lazy.
 * The registration lives inside `Hooks.once('init', …)` in module.js alongside
 * ~30 other side effects, so importing it to observe the call would exercise
 * far more than the one literal under test. What needs guarding is exactly that
 * literal: a WORLD setting is world state and Foundry distributes it to
 * connected clients, so a per-account credential must not live in one.
 *
 * The revert is a one-word edit that no other test in this suite can see, and
 * the comment that used to sit above it actively argued FOR world scope. So the
 * failure mode being guarded is a well-meaning refactor, not a typo.
 *
 * ⚠️ What this does NOT prove: that Foundry honors the scope. That is Foundry's
 * contract, verified by reading `CONST.SETTING_SCOPES` and `ClientSettings`
 * (v14: CLIENT → window.localStorage; WORLD → the shared WorldSettings
 * collection). This test only pins OUR side of it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '../../scripts/module.js'), 'utf8')

/** The `game.settings.register(MODULE_ID, '<key>', { … })` block for one key. */
function registrationBlock(key) {
  const start = SOURCE.indexOf(`game.settings.register(MODULE_ID, '${key}', {`)
  if (start === -1) return null
  const end = SOURCE.indexOf('})', start)
  return end === -1 ? null : SOURCE.slice(start, end)
}

describe('apiKey setting scope', () => {
  it('is registered', () => {
    expect(registrationBlock('apiKey')).not.toBeNull()
  })

  it("uses scope: 'client' — the key stays with the account it was issued to", () => {
    expect(registrationBlock('apiKey')).toMatch(/scope:\s*'client'/)
  })

  it("does NOT use scope: 'world' — a credential is not world state", () => {
    expect(registrationBlock('apiKey')).not.toMatch(/scope:\s*'world'/)
  })

  it('stays hidden from the settings UI', () => {
    // Not the boundary — `config: false` only hides the settings-UI field, and
    // was true under the old scope too. Pinned because a visible field would
    // invite pasting arbitrary strings, which is a separate reason it is off.
    expect(registrationBlock('apiKey')).toMatch(/config:\s*false/)
  })

  it('leaves the non-secret settings world-scoped', () => {
    // The scope change is scoped to the credential. `coreApiUrl` and
    // `installationId` describe the WORLD, are not secrets, and are correct to
    // share — narrowing them would break a player's module with no gain.
    expect(registrationBlock('coreApiUrl')).toMatch(/scope:\s*'world'/)
    expect(registrationBlock('installationId')).toMatch(/scope:\s*'world'/)
  })
})
