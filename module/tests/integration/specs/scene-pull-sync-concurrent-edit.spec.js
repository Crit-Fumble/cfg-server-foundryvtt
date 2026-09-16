/**
 * Concurrent-edit safety for SCENE sync, against a REAL FoundryVTT v14 world (cs#417, H2).
 *
 * The scene a table is playing on is the one document a GM edits WHILE the courier is
 * running: tokens get dropped, walls get drawn, and neither goes through the platform. This
 * spec reproduces what a platform-side edit does to that work today.
 *
 * ## The bug, in one sentence
 *
 * `doc-pull-sync.js:311-325` reconciles an embedded collection by computing
 * `toDelete = live ids − platform array ids`, so ANY child in the world that is missing from
 * the platform's array is deleted. Two different situations produce that exact shape:
 *
 *   (A) the PLATFORM removed a child since its last push  → deleting it is correct
 *   (B) a USER ADDED a child in Foundry since the last push → deleting it is DATA LOSS
 *
 * The courier cannot tell them apart, because the plan carries no record of what was last
 * pushed. Case (B) is this file.
 *
 * ## Why the reconciliation exists at all, and why a mocked test cannot settle this
 *
 * Foundry itself NEVER deletes an embedded document through a parent update — audited
 * 2026-09-15 against 14.367 per the cs#417 audit, and re-read in `common/data/fields.mjs` on
 * the 14.361 this harness actually runs (`EmbeddedCollectionField._updateDiff` matches
 * children by `_id`, creates the unmatched ones and deletes nothing; no line range is quoted
 * because it moves between builds — find the method by name). So the delete is ours alone,
 * which is also why the unit tests
 * are no help: they stub `Scene` and assert that `deleteEmbeddedDocuments` was called with
 * the ids we computed — the bug, written down as an expectation. The only thing that can
 * contradict us is a live world, asked the question a player would ask: after the platform
 * renamed the scene, are my tokens still on it?
 *
 * ## The fix these fixtures are shaped for (cs#417)
 *
 * Rec 2 — SERVER-NAMED REMOVALS: core computes `removedEmbedded` from the ids in
 * `lastPushedData[field]` that are absent from `docData[field]`, and the module deletes only
 * those. Every plan item below carries `lastPushedData` and `removedEmbedded` already; the
 * module ignores both today, so they are inert here and become load-bearing on the day the
 * fix lands — including in the control, which must keep passing with either implementation.
 *
 * Rec 1 — an apply-time skip when Foundry's `_stats.modifiedTime` is newer than the plan's
 * `platformChangedAt`. ⚠️ MEASURED HERE, AND IT NARROWS REC 1 MATERIALLY FOR SCENES: there is
 * no clock anywhere in a Scene that moves when a GM drops a token. The Scene's own
 * `_stats.modifiedTime` does not advance on a child create, AND the children have no `_stats`
 * of their own to compare — `_stats` is a `DocumentStatsField` carried by PRIMARY documents
 * only. Verified against this harness's 14.361: `common/documents/scene.mjs`, `actor.mjs`,
 * `journal-entry.mjs` and `journal-entry-page.mjs` each declare `_stats`, while `token.mjs`,
 * `wall.mjs` and `drawing.mjs` declare none, and `common/abstract/document.mjs` documents
 * `_stats` as "Primary document types have a _stats object".
 *
 * So for a Scene a `_stats`-based staleness check cannot see a concurrent in-world edit AT
 * ALL — not parent-only, and not "deep" either, because there is nothing deep to read. It
 * will NOT turn the marked tests below green, and rec 1 needs a different signal for scenes
 * (a Foundry hook, or comparing the live child id set against `lastPushedData`). The second
 * test below measures both halves of that.
 *
 * ⚠️ Do not generalize this to journals: `world-journal-snapshot.spec.js` measured the
 * parent-clock half for a JournalEntry, but a JournalEntryPage IS a primary document and DOES
 * carry `_stats` — so a deep check is buildable there and is impossible here.
 *
 * Transport is stubbed, Foundry is real; nothing here needs Core to be up.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const MODULE_URL = '/modules/crit-fumble-core/scripts/services/scene-pull-sync.js'

// Foundry's DocumentIdField requires exactly 16 alphanumerics — the same shape
// deriveFoundryEntryId emits server-side.
const SCENE_ID = 'CfgSceneConc0001'
const PLATFORM_TOKEN_A = 'CfgConcTokPlat01'
const PLATFORM_TOKEN_B = 'CfgConcTokPlat02'
const PLATFORM_WALL = 'CfgConcWallPlt01'
const SOURCE_ID = 'loc_scene_conc_1'

// The children the platform pushed when the scene was ADOPTED. The token FIELD SET is the
// one scene-pull-sync.spec.js already creates tokens with — measured to satisfy v14's
// TokenDocument validation with no actorId and no explicit texture — and the GM's live drops
// below use the same set, so a validation change moves both specs together rather than one.
const adoptedTokens = () => [
  { _id: PLATFORM_TOKEN_A, name: 'Platform Tok A', x: 100, y: 100 },
  { _id: PLATFORM_TOKEN_B, name: 'Platform Tok B', x: 200, y: 200 },
]
const adoptedWalls = () => [{ _id: PLATFORM_WALL, c: [0, 0, 100, 100] }]

/**
 * A plan item shaped like the server's buildSceneSyncPlan output, plus the two cs#417 fields
 * a fixed courier would read. `platformChangedAt` defaults to the epoch: the platform edit
 * modelled here is OLDER than the GM's live work, which is the whole point of case (B).
 */
function planItem(over = {}) {
  const { docData: docOver, lastPushedData: pushedOver, ...rest } = over
  return {
    sceneId: SOURCE_ID,
    foundrySceneId: SCENE_ID,
    everPushed: false,
    claimedAt: null,
    removedPaths: [],
    // ── cs#417 shape: ignored by today's module, consumed by the fix. ──
    platformChangedAt: new Date(0).toISOString(),
    lastPushedData: { tokens: adoptedTokens(), walls: adoptedWalls(), ...pushedOver },
    removedEmbedded: { tokens: [], walls: [] },
    // ── end cs#417 shape ──
    docData: {
      _id: SCENE_ID,
      name: 'Sunken Vault',
      width: 2000,
      height: 2000,
      ownership: { default: 0 },
      flags: { playtable: { sourceSceneId: SOURCE_ID } },
      tokens: adoptedTokens(),
      walls: adoptedWalls(),
      ...docOver,
    },
    ...rest,
  }
}

/** Everything a player would notice about the live scene. */
async function inspect(page) {
  return page.evaluate((sceneId) => {
    const doc = game.scenes.get(sceneId)
    const ids = (c) => (c ? [...c].map((d) => d.id).sort() : [])
    // Child clocks are read one-per-child and NEVER folded into 0 with `?? 0` — a missing
    // `_stats` is the finding, so it has to survive as `null` and be asserted on directly.
    const clocks = (c) => (c ? [...c].map((d) => d._stats?.modifiedTime ?? null) : [])
    // Flags are read RAW, never via getFlag: Foundry validates the scope against active
    // module ids and our scope is `playtable` while the module id is `crit-fumble-core` —
    // getFlag THROWS.
    return {
      found: !!doc,
      name: doc?.name ?? null,
      active: doc?.active ?? null,
      source: doc?.flags?.playtable?.sourceSceneId ?? null,
      tokenIds: ids(doc?.tokens),
      wallIds: ids(doc?.walls),
      sceneModified: doc?._stats?.modifiedTime ?? null,
      tokenClocks: clocks(doc?.tokens),
      wallClocks: clocks(doc?.walls),
    }
  }, SCENE_ID)
}

/** Drive ONE real tick of the real service against the live world, then look at it. */
async function runTick(page, plan) {
  const acked = await page.evaluate(
    async ({ plan, moduleUrl }) => {
      const { ScenePullSync } = await import(moduleUrl)
      const acked = []
      const api = {
        getSceneSyncPlan: async () => ({ data: plan }),
        ackSceneSync: async (_inst, _world, results) => {
          acked.push(...results)
          return { data: { recorded: results.length } }
        },
      }
      await new ScenePullSync(api, 'inst-live-test').tick()
      return acked
    },
    { plan, moduleUrl: MODULE_URL },
  )
  return { acked, ...(await inspect(page)) }
}

/** What a GM does mid-session, in the world, with no platform involvement whatsoever. */
async function gmDropsTokensAndDrawsWall(page) {
  return page.evaluate(async (sceneId) => {
    const scene = game.scenes.get(sceneId)
    // No `_id` and no keepId: a GM dropping a token gets a Foundry-minted id, and the ids
    // are returned rather than assumed so nothing here depends on guessing one.
    const tokens = await scene.createEmbeddedDocuments('Token', [
      { name: 'GM Drop 1', x: 640, y: 640 },
      { name: 'GM Drop 2', x: 720, y: 720 },
    ])
    const walls = await scene.createEmbeddedDocuments('Wall', [{ c: [300, 300, 400, 400] }])
    return { tokenIds: tokens.map((t) => t.id), wallIds: walls.map((w) => w.id) }
  }, SCENE_ID)
}

/**
 * Adopt the scene, then let the GM work on it. The starting state for every case-(B) test.
 * Returns the adopt-time state alongside the drops so the caller can assert its preconditions
 * BEFORE arming `test.fail()` — a marked test is green when it fails for any reason at all,
 * so setup that silently created nothing has to be caught while a throw still counts.
 */
async function adoptThenGmEdits(page) {
  const adopted = await runTick(page, [planItem()])
  expect(adopted.found).toBe(true) // a case-(B) assertion means nothing if the scene is absent
  const drops = await gmDropsTokensAndDrawsWall(page)
  return { adopted, drops, live: await inspect(page) }
}

async function cleanup(page) {
  await page.evaluate(async (id) => {
    for (const s of game.scenes.filter((s) => s.id === id)) {
      if (s.active) {
        const other = game.scenes.find((x) => x.id !== id)
        if (other) await other.activate()
      }
      await s.delete()
    }
  }, SCENE_ID)
}

test.describe('Scene sync vs. a GM editing the live scene (cs#417)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore && game?.ready, { timeout: 30_000 })
    await cleanup(page)
  })

  test.afterEach(async ({ page }) => {
    await cleanup(page)
  })

  test('a GM can drop tokens and draw a wall on an adopted platform scene', async ({ page }) => {
    // The honesty guard for the two marked tests below. A `test.fail()` test is green when it
    // fails for ANY reason — including a setup that silently created nothing — so the setup
    // is proved here, unmarked, where a breakage is loud.
    const adopted = await runTick(page, [planItem()])
    expect(adopted.found).toBe(true)
    expect(adopted.tokenIds).toEqual([PLATFORM_TOKEN_A, PLATFORM_TOKEN_B].sort())
    expect(adopted.wallIds).toEqual([PLATFORM_WALL])

    const drops = await gmDropsTokensAndDrawsWall(page)
    expect(drops.tokenIds).toHaveLength(2)
    expect(drops.wallIds).toHaveLength(1)

    const res = await inspect(page)
    expect(res.tokenIds).toEqual([PLATFORM_TOKEN_A, PLATFORM_TOKEN_B, ...drops.tokenIds].sort())
    expect(res.wallIds).toEqual([PLATFORM_WALL, ...drops.wallIds].sort())
  })

  test('a Scene has NO clock that sees a GM token drop — parent unmoved, and the children have none', async ({ page }) => {
    // Measured for cs#417 rec 1, and it narrows rec 1 rather than supporting it. Two facts,
    // asserted separately because the fix depends on BOTH:
    //
    //   (1) the Scene's own `_stats.modifiedTime` does not advance when a child is created —
    //       the same trap `world-journal-snapshot.spec.js` found for a JournalEntry; and
    //   (2) Token and Wall carry no `_stats` at all, because `_stats` is a field of PRIMARY
    //       documents only, so there is no child clock to fall back to.
    //
    // Together: a `_stats` comparison against `platformChangedAt` sees a scene nobody has
    // touched, applies the plan, and deletes the GM's tokens — and going "deep" does not
    // rescue it, because the depth is empty. (2) is the half that is easy to assume away;
    // it is why the marked tests below cannot be fixed by a staleness check alone.
    const adopted = await runTick(page, [planItem()])
    expect(typeof adopted.sceneModified).toBe('number')
    // The platform's own adopted children have no clock either — so this is a property of the
    // document types, not an artifact of how the GM created the ones below.
    expect(adopted.tokenClocks).toEqual([null, null])
    expect(adopted.wallClocks).toEqual([null])

    const drops = await gmDropsTokensAndDrawsWall(page)
    expect(drops.tokenIds).toHaveLength(2) // the drop really happened, or neither fact means anything
    expect(drops.wallIds).toHaveLength(1)
    const after = await inspect(page)

    // (1) the parent clock never moved, even though the scene's contents did
    expect(after.tokenIds).toHaveLength(4)
    expect(after.sceneModified).toBe(adopted.sceneModified)

    // (2) and not one child — platform-pushed or GM-dropped — has a clock of its own
    expect(after.tokenClocks).toEqual([null, null, null, null])
    expect(after.wallClocks).toEqual([null, null])
  })

  // ⚠️ cs#417 — REGRESSION GUARD. This FAILED until the platform stopped sending scene
  // contents at all (rec 4, owner decision 2026-09-15: scenes are view-only on external
  // surfaces). It passes now, and goes red again if any embedded collection is re-added to
  // the pushed doc — which no clock could make safe, since scene children have no `_stats`.
  // Playwright reports a marked test that PASSES as a failure, which is that signal.
  test('tokens the GM dropped after the last push SURVIVE a platform rename', async ({ page }) => {
    const { adopted, drops, live } = await adoptThenGmEdits(page)

    // Preconditions, asserted while the test is still UNMARKED so a broken setup is a real
    // failure instead of being swallowed as "the expected one".
    expect(adopted.tokenIds).toEqual([PLATFORM_TOKEN_A, PLATFORM_TOKEN_B].sort())
    expect(drops.tokenIds).toHaveLength(2)
    for (const id of drops.tokenIds) expect(live.tokenIds).toContain(id) // they really are on the scene

    // The platform edit: a rename, and nothing else. Its `tokens` array is byte-identical to
    // the adopt-time push — the platform removed nothing, it simply never heard about the
    // GM's two tokens. `everPushed` + `lastPushedData` say so in the plan.
    const res = await runTick(page, [planItem({ everPushed: true, docData: { name: 'Sunken Vault (Renamed)' } })])


    // The outcome a player cares about: the tokens they placed are still on the scene.
    // (The rename landing is asserted in the control below, deliberately NOT here — a marked
    // test that fails because the tick no-opped would be indistinguishable from the bug.)
    for (const id of drops.tokenIds) expect(res.tokenIds).toContain(id)
  })

  // ⚠️ cs#417 — REGRESSION GUARD. This FAILED until the platform stopped sending scene
  // contents at all (rec 4, owner decision 2026-09-15: scenes are view-only on external
  // surfaces). It passes now, and goes red again if any embedded collection is re-added to
  // the pushed doc — which no clock could make safe, since scene children have no `_stats`.
  // Kept separate from the token case on purpose: a fix that handles tokens but forgets the
  // other seven collections leaves this one failing, and one combined test would hide that.
  test('a wall the GM drew after the last push SURVIVES a platform rename', async ({ page }) => {
    const { adopted, drops, live } = await adoptThenGmEdits(page)

    // Same honesty guard as the token case, for the wall collection.
    expect(adopted.wallIds).toEqual([PLATFORM_WALL])
    expect(drops.wallIds).toHaveLength(1)
    for (const id of drops.wallIds) expect(live.wallIds).toContain(id)

    // Walls differ from the "collection the platform does not model" case scene-pull-sync.spec.js
    // already covers: an ADOPTED scene carries a `walls` array, so reconciliation runs, and the
    // GM's new wall is an id the platform array has never seen.
    const res = await runTick(page, [planItem({ everPushed: true, docData: { name: 'Sunken Vault (Renamed)' } })])


    for (const id of drops.wallIds) expect(res.wallIds).toContain(id)
  })

  test('CONTROL — a child the PLATFORM removed is still deleted', async ({ page }) => {
    // The other half of the repro, and the reason a fix cannot simply stop deleting: case (A)
    // must keep working. Nothing is edited in the world here, and `platformChangedAt` is newer
    // than everything in it, so a rec-1 staleness skip has nothing to skip either.
    await runTick(page, [planItem()])
    const now = await page.evaluate(() => Date.now())

    const res = await runTick(page, [
      planItem({
        everPushed: true,
        platformChangedAt: new Date(now + 1000).toISOString(),
        // The fix's input: the ids that WERE pushed and are now gone. Today's courier ignores
        // this and reaches the same answer by subtraction — the outcome asserted below is what
        // both implementations owe.
        removedEmbedded: { tokens: [PLATFORM_TOKEN_A], walls: [PLATFORM_WALL] },
        docData: {
          name: 'Sunken Vault (Trimmed)',
          tokens: [{ _id: PLATFORM_TOKEN_B, name: 'Platform Tok B', x: 200, y: 200 }],
          walls: [],
        },
      }),
    ])

    expect(res.name).toBe('Sunken Vault (Trimmed)') // the tick really applied
    expect(res.tokenIds).toEqual([PLATFORM_TOKEN_B]) // the dropped token is gone...
    expect(res.wallIds).toEqual([]) // ...and so is the dropped wall
    expect(res.acked[0]).toMatchObject({ sceneId: SOURCE_ID, foundrySceneId: SCENE_ID, ok: true })
  })
})
