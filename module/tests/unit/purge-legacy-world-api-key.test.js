/**
 * The pre-3.2.0 world-scoped `apiKey` row must be DELETED, not merely ignored
 * (cs#390).
 *
 * Registering the setting as `scope: 'client'` stopped the module reading the
 * world row — Foundry's own `ClientSettings#register` skips world storage for
 * exactly that scope. It does not remove the row, and Foundry ships every WORLD
 * setting to every connecting client. Measured on a production world AFTER
 * 3.2.0 shipped: the row was still present holding a `cfk_`-shaped value. So
 * the finding stayed live behind a module that looked fixed.
 *
 * These drive the exported behaviour through a mocked Foundry surface, because
 * the failure modes are all about WHO may act and WHAT is targeted — a purge
 * that runs for players, or that deletes the wrong row, is worse than none.
 */
import { jest } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_ID = 'crit-fumble-core'

/** Minimal Foundry surface: a world settings collection + a GM flag. */
function mockFoundry({ isGM = true, rows = [], throwOnDelete = false } = {}) {
  const deleted = []
  const docs = rows.map((r) => ({
    ...r,
    delete: jest.fn(async () => {
      if (throwOnDelete) throw new Error('nope')
      deleted.push(r)
    }),
  }))
  globalThis.game = {
    user: { isGM },
    settings: {
      storage: {
        get: (scope) =>
          scope === 'world'
            ? { getSetting: (key, user = null) => docs.find((d) => d.key === key && (d.user ?? null) === user) ?? null }
            : null,
      },
    },
  }
  return { docs, deleted }
}

/** The function under test, mirrored — module.js is one big import with ~30 side effects. */
async function purgeLegacyWorldApiKey() {
  if (globalThis.game.user?.isGM !== true) return
  try {
    const world = globalThis.game.settings?.storage?.get?.('world')
    if (!world?.getSetting) return
    const doc = world.getSetting(`${MODULE_ID}.apiKey`, null)
    if (!doc) return
    await doc.delete()
  } catch {
    /* non-fatal */
  }
}

describe('purgeLegacyWorldApiKey', () => {
  it('deletes the world-scoped apiKey row when one exists', async () => {
    const { docs, deleted } = mockFoundry({ rows: [{ key: `${MODULE_ID}.apiKey`, user: null }] })
    await purgeLegacyWorldApiKey()
    expect(docs[0].delete).toHaveBeenCalled()
    expect(deleted).toHaveLength(1)
  })

  it('is a no-op on a clean world — safe to run every load', async () => {
    const { deleted } = mockFoundry({ rows: [] })
    await purgeLegacyWorldApiKey()
    expect(deleted).toHaveLength(0)
  })

  it('does NOTHING for a player — only a GM may delete a Setting', async () => {
    const { docs } = mockFoundry({ isGM: false, rows: [{ key: `${MODULE_ID}.apiKey`, user: null }] })
    await purgeLegacyWorldApiKey()
    expect(docs[0].delete).not.toHaveBeenCalled()
  })

  it('touches ONLY this module\'s apiKey row', async () => {
    const { docs } = mockFoundry({
      rows: [
        { key: 'core.permissions', user: null },
        { key: `${MODULE_ID}.installationId`, user: null },
        { key: `${MODULE_ID}.coreApiUrl`, user: null },
        { key: `${MODULE_ID}.apiKey`, user: null },
      ],
    })
    await purgeLegacyWorldApiKey()
    const byKey = Object.fromEntries(docs.map((d) => [d.key, d.delete]))
    expect(byKey[`${MODULE_ID}.apiKey`]).toHaveBeenCalled()
    for (const k of ['core.permissions', `${MODULE_ID}.installationId`, `${MODULE_ID}.coreApiUrl`]) {
      expect(byKey[k]).not.toHaveBeenCalled()
    }
  })

  it('never throws — a cleanup failure must not break the world load', async () => {
    mockFoundry({ rows: [{ key: `${MODULE_ID}.apiKey`, user: null }], throwOnDelete: true })
    await expect(purgeLegacyWorldApiKey()).resolves.toBeUndefined()
  })

  it('survives a Foundry surface that has no world storage at all', async () => {
    globalThis.game = { user: { isGM: true }, settings: { storage: { get: () => null } } }
    await expect(purgeLegacyWorldApiKey()).resolves.toBeUndefined()
  })
})

/**
 * The suite above drives a MIRROR of the function, because module.js is one
 * import with ~30 side effects. A mirror can drift from the original, so these
 * pin the real source on the three things the mirror asserts. Without them a
 * refactor could gut the shipped function while the suite stayed green — the
 * exact "green about the wrong thing" shape this repo keeps hitting.
 */
describe('the shipped module.js matches what these tests exercise', () => {
  const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../scripts/module.js'), 'utf8')
  const body = SOURCE.slice(
    SOURCE.indexOf('async function purgeLegacyWorldApiKey'),
    SOURCE.indexOf('async function purgeLegacyWorldApiKey') + 1200,
  )

  it('the function exists', () => {
    expect(SOURCE).toContain('async function purgeLegacyWorldApiKey')
  })

  it('is GM-gated', () => {
    expect(body).toMatch(/game\.user\?\.isGM !== true\)\s*return/)
  })

  it("targets this module's apiKey row at WORLD scope", () => {
    expect(body).toMatch(/storage\?\.get\?\.\('world'\)/)
    expect(body).toMatch(/getSetting\(`\$\{MODULE_ID\}\.apiKey`, null\)/)
  })

  it('deletes it, and is wrapped so a failure cannot break the load', () => {
    expect(body).toMatch(/await doc\.delete\(\)/)
    expect(body).toMatch(/try \{/)
    expect(body).toMatch(/catch/)
  })

  it('is actually CALLED from the ready hook — a function nobody invokes is not a fix', () => {
    // ⚠️ Anchored to line start, NOT a bare substring. The first version of this
    // assertion was `/await purgeLegacyWorldApiKey\(\)/`, which a mutation check
    // caught passing against `// await purgeLegacyWorldApiKey()` — a commented-out
    // call satisfied the regex, so the one test guarding "it is wired" was blind
    // to the single most likely way of unwiring it.
    const called = SOURCE.split('\n').filter((l) => /^\s*await purgeLegacyWorldApiKey\(\)/.test(l))
    expect(called).toHaveLength(1)
  })
})
