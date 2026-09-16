/**
 * Concurrent-edit DATA LOSS on actor pull-sync, against a REAL FoundryVTT v14 world (cs#417 H1).
 *
 * A player drags an item onto their sheet. Thirty seconds later the platform ticks, and the
 * item is gone. This spec is the live reproduction of that, and it exists because no mocked
 * test can produce it:
 *
 *   1. In the unit suite the parent Actor is a stub, so `deleteEmbeddedDocuments` is a spy.
 *      A mock can only ever assert "we asked to delete [id]" — it cannot say whether that id
 *      belonged to something the PLATFORM dropped or something a PLAYER just made, and it
 *      cannot show the item missing from a sheet afterwards. The whole defect is that those
 *      two are indistinguishable at the point we decide, so the assertion has to be made on
 *      the surviving world, not on the call.
 *   2. The deletion is entirely OURS, and only a real world proves it. Foundry never removes
 *      an embedded document through a parent update — `EmbeddedCollectionField._updateDiff`
 *      (common/data/fields.mjs:3062-3105, audited against 14.367) matches children by `_id`,
 *      creates the unmatched, and deletes nothing. So a world left to itself would have kept
 *      the player's item; `_reconcileEmbedded` is what takes it away.
 *
 * ── THE AMBIGUITY ────────────────────────────────────────────────────────────────────
 *
 * `doc-pull-sync.js:311-325` computes `toDelete = liveIds - platformArrayIds`. Two different
 * histories arrive at that set, and the courier cannot tell them apart:
 *
 *   (A) the PLATFORM removed a child since its last push        → deleting it is CORRECT
 *   (B) a USER ADDED a child in Foundry since the last push     → deleting it is DATA LOSS
 *
 * Both read as "an id in the live world that is not in the platform array". The world-actor
 * mirror is what is supposed to keep case (B) from arising — it snapshots the world back into
 * the sheet — but `worldEditWinsDeep` HOLDS the mirror whenever the platform sheet's clock is
 * newer (world-actor-mirror.ts:174). So the exact sequence modelled below — player adds an
 * item, someone then edits HP on the platform — is not an exotic race; it is the ordinary one.
 *
 * The fix cs#417 proposes is server-named removals (rec 2): core computes `removedEmbedded`
 * from ids present in `lastPushedData[field]` and absent from `docData[field]`, and the module
 * deletes ONLY those. Case (A) stays a delete because the platform can name it; case (B)
 * cannot be named, so nothing happens to it. ⚠️ NEITHER `removedEmbedded` NOR `lastPushedData`
 * IS ON THE WIRE TODAY — `ActorSyncPlanItem` (actor-sync-plan.ts) carries `{characterId,
 * foundryActorId, everPushed, systemId, claimedAt, docData, removedPaths}` and nothing else — so
 * the two repros do not invent them. They are written entirely in the shape the server sends
 * now, and a fail-safe rec-2 module (absent `removedEmbedded` → delete nothing) turns both
 * repros green as they stand. The case-(A) control is the deliberate exception: it carries both
 * fields ahead of the server, because that is the only way it can tell the rec-2 fix apart from
 * the naive one. See its own comment.
 *
 * Rec 1 (skip the apply when Foundry's `_stats.modifiedTime` is newer than the plan item's
 * `platformChangedAt`) would also make the repros green, by skipping the whole push. That is a
 * different trade — a platform edit deferred instead of a player's item destroyed — and which
 * one cs#417 takes is not this file's call, so nothing here asserts that the HP edit landed on a
 * CONTESTED actor. The uncontroversial half IS asserted: on an actor nobody touched in the
 * world there is no edit to defer to, so the push must still land, or "the fix" is just an
 * elaborate way of not syncing.
 *
 * Transport is stubbed, Foundry is real: the REAL ActorPullSync runs one fixed plan against
 * the live world. No Core stack, no fixtures — a failure means the courier destroyed data.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const MODULE_URL = '/modules/crit-fumble-core/scripts/services/actor-pull-sync.js'

// Foundry's DocumentIdField requires exactly 16 alphanumerics — the same shape
// deriveFoundryEntryId emits server-side.
const ACTOR_ID = 'CfgConcActor0001'
const PLATFORM_ITEM = 'CfgConcItemPlat1' // the platform knows about this one
const PLAYER_ITEM = 'CfgConcItemPlyr1' // this one was made in the world, not the platform
const PLAYER_EFFECT = 'CfgConcEffctPly1'

// Distinct from actor-pull-sync.spec.js's `char_live_1` so neither spec's cleanup reaps the
// other's actor.
const CHARACTER_ID = 'char_live_concurrent'

/** A plan item shaped exactly like the server's buildActorSyncPlan output. */
function planItem(over = {}) {
  const { docData: docOver, ...rest } = over
  return {
    characterId: CHARACTER_ID,
    foundryActorId: ACTOR_ID,
    everPushed: false,
    systemId: 'dnd5e',
    claimedAt: null,
    removedPaths: [],
    docData: {
      _id: ACTOR_ID,
      name: 'Doran Vale',
      type: 'character',
      system: { attributes: { hp: { value: 12, max: 12 } } },
      // The platform's view of the sheet: one item, no effects. `effects: []` is what a
      // mirrored actor carries when the character has none — and an EMPTY ARRAY is managed,
      // unlike an absent key, which `_reconcileEmbedded` deliberately leaves alone.
      items: [{ _id: PLATFORM_ITEM, name: 'Dagger', type: 'weapon' }],
      effects: [],
      ownership: { default: 0 },
      flags: { playtable: { sourceCharacterId: CHARACTER_ID } },
      ...docOver,
    },
    ...rest,
  }
}

/** Drive ONE real tick of the real service against the live world. */
async function runTick(page, plan) {
  return page.evaluate(
    async ({ plan, moduleUrl, actorId }) => {
      const { ActorPullSync } = await import(moduleUrl)
      const acked = []
      const api = {
        getActorSyncPlan: async () => ({ data: plan }),
        ackActorSync: async (_inst, _world, _system, results) => {
          acked.push(...results)
          return { data: { recorded: results.length } }
        },
      }
      await new ActorPullSync(api, 'inst-live-test').tick()

      const doc = game.actors.get(actorId)
      return {
        acked,
        found: !!doc,
        hp: doc ? foundry.utils.deepClone(doc.system?.attributes?.hp ?? null) : null,
        itemIds: doc ? doc.items.map((i) => i.id).sort() : [],
        effectIds: doc ? doc.effects.map((e) => e.id).sort() : [],
      }
    },
    { plan, moduleUrl: MODULE_URL, actorId: ACTOR_ID },
  )
}

/**
 * What a player does at the table: drop an item on the sheet.
 *
 * A real compendium drag mints a RANDOM id; we pin ours only so the assertions can name the
 * child. That changes nothing about the defect — `_reconcileEmbedded` compares id SETS and
 * has no idea where an id came from, which is precisely the problem.
 *
 * Items and effects get SEPARATE helpers on purpose. Sharing one would let the effect repro be
 * satisfied by an ActiveEffect schema error during setup rather than by the deletion it claims
 * to be about, so each repro creates only the child it asserts on.
 */
async function addItemInWorld(page) {
  return page.evaluate(
    async ({ actorId, itemId }) => {
      const actor = game.actors.get(actorId)
      if (!actor) throw new Error('setup: the actor is missing before the in-world edit')
      await actor.createEmbeddedDocuments('Item', [{ _id: itemId, name: 'Looted Greataxe', type: 'weapon' }], { keepId: true })
      return { itemIds: actor.items.map((i) => i.id).sort() }
    },
    { actorId: ACTOR_ID, itemId: PLAYER_ITEM },
  )
}

/** The other half of the same table moment: the cleric blesses them. */
async function addEffectInWorld(page) {
  return page.evaluate(
    async ({ actorId, effectId }) => {
      const actor = game.actors.get(actorId)
      if (!actor) throw new Error('setup: the actor is missing before the in-world edit')
      await actor.createEmbeddedDocuments('ActiveEffect', [{ _id: effectId, name: 'Blessed', changes: [], disabled: false }], { keepId: true })
      return { effectIds: actor.effects.map((e) => e.id).sort() }
    },
    { actorId: ACTOR_ID, effectId: PLAYER_EFFECT },
  )
}

async function cleanup(page) {
  await page.evaluate(
    async ({ id, characterId }) => {
      // Flags are read RAW, never via getFlag: Foundry validates the scope against active
      // module ids and our scope is `playtable` while the module id is `crit-fumble-core` —
      // getFlag THROWS.
      for (const a of game.actors.filter((a) => a.id === id || a.flags?.playtable?.sourceCharacterId === characterId)) {
        await a.delete()
      }
    },
    { id: ACTOR_ID, characterId: CHARACTER_ID },
  )
}

test.describe('Actor pull-sync vs a concurrent in-world edit (cs#417 H1)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore && game?.ready, { timeout: 30_000 })
    await cleanup(page) // a prior failed run must not poison this one
  })

  test.afterEach(async ({ page }) => {
    await cleanup(page)
  })

  test('SETUP CONTROL: a player-added Item and ActiveEffect land in the live world', async ({ page }) => {
    // Not ceremony. The two repros below are `test.fail()`, and an expected-to-fail test is
    // satisfied by ANY failure — including one where the setup never happened. This asserts
    // the premise separately, so a broken fixture goes red HERE instead of quietly making the
    // repros look like they are still reproducing.
    await runTick(page, [planItem()])
    const withItem = await addItemInWorld(page)
    const withEffect = await addEffectInWorld(page)

    // `toContain` rather than a strict set: the claim is that both children exist. The file
    // should not go red because dnd5e one day seeds a new character with items of its own.
    expect(withItem.itemIds).toContain(PLATFORM_ITEM)
    expect(withItem.itemIds).toContain(PLAYER_ITEM)
    expect(withEffect.effectIds).toContain(PLAYER_EFFECT)
  })

  // cs#417 H1 — REGRESSION GUARD. This FAILED until rec 2 (server-named removals) landed on
  // 2026-09-15; it passes now and goes red again the moment a courier infers a delete from
  // the live collection instead of deleting only what the server named.
  test('an Item the player added in Foundry SURVIVES a platform tick that never knew about it', async ({ page }) => {
    // 1. The platform pushes the character. The world now matches: one Dagger.
    await runTick(page, [planItem()])

    // 2. The player loots an axe, in the world, the way they would at the table.
    const live = await addItemInWorld(page)

    // 3. The platform ticks again. Its `docData` is unchanged except for an HP edit — its
    //    `items` array still lists only the Dagger, because it has never seen the axe. This
    //    is NOT the platform removing the axe; it is the platform not knowing it exists.
    const res = await runTick(page, [
      planItem({ everPushed: true, docData: { system: { attributes: { hp: { value: 4, max: 12 } } } } }),
    ])

    // PRECONDITION, asserted BEFORE `test.fail()` so it goes red on its own: the setup really
    // happened. A world where the axe was never created would "reproduce" the bug for free.
    expect(live.itemIds).toContain(PLAYER_ITEM)


    // The platform's own item was not collateral damage — checked first, so the claim is
    // genuinely tested and the marked failure still comes from the player's item below.
    expect(res.itemIds).toContain(PLATFORM_ITEM)
    // The outcome a player cares about: their loot is still on the sheet.
    expect(res.itemIds).toContain(PLAYER_ITEM)
  })

  // cs#417 H1 — REGRESSION GUARD. This FAILED until rec 2 (server-named removals) landed on
  // 2026-09-15; it passes now and goes red again the moment a courier infers a delete from
  // the live collection instead of deleting only what the server named.
  test('an ActiveEffect the player picked up in Foundry SURVIVES the same tick', async ({ page }) => {
    // Effects are the second reconciled collection on an Actor, and they lose the same way —
    // separately asserted so a fix that repairs `items` and forgets `effects` is still red.
    await runTick(page, [planItem()])
    const live = await addEffectInWorld(page)

    const res = await runTick(page, [
      planItem({ everPushed: true, docData: { system: { attributes: { hp: { value: 4, max: 12 } } } } }),
    ])

    // Precondition first, for the same reason as the Item repro: no effect, no reproduction.
    expect(live.effectIds).toContain(PLAYER_EFFECT)

    expect(res.effectIds).toContain(PLAYER_EFFECT)
  })

  test('CONTROL: a platform edit still LANDS on an actor nobody touched in the world', async ({ page }) => {
    // Without this, both repros are satisfied by a module that simply skips the apply whenever
    // the world has moved at all — green repros, broken sync. An UNCONTESTED actor has no
    // in-world edit to defer to, so rec 1 and rec 2 alike must keep this passing; a fix that
    // turns it red has stopped syncing rather than started being careful.
    await runTick(page, [planItem()])

    const res = await runTick(page, [
      planItem({ everPushed: true, docData: { system: { attributes: { hp: { value: 4, max: 12 } } } } }),
    ])

    expect(res.found).toBe(true)
    expect(res.hp?.value).toBe(4)
  })

  test('CONTROL: a child the platform GENUINELY removed is still deleted', async ({ page }) => {
    // The repros above must not be "fixed" by never deleting anything. A platform-side
    // removal has to keep propagating, or a deleted item lives forever at the table — which
    // is the behaviour actor-pull-sync.spec.js pins as desired, and this file does not
    // contradict it.
    //
    // ⚠️ This is the ONE plan item in the file written ahead of the wire, and deliberately: a
    // control carrying only TODAY's shape (the id merely absent from `docData.items`) cannot
    // tell the rec-2 fix from the naive one — "never delete embedded children" turns it red
    // too, and a red control reads like a regression instead of a wrong fix. So it is given
    // the rec-2 shape it is actually guarding for: `lastPushedData` (tick 1's docData, where
    // the Dagger is still listed) plus the `removedEmbedded` the server would derive from it.
    // TODAY the module ignores both fields and deletes by set-difference anyway, so this
    // passes NOW; under rec 2 it passes because the removal is NAMED. Only the naive fix,
    // which stops deleting regardless of what the server said, makes it red.
    await runTick(page, [planItem()])
    const seeded = await runTick(page, [planItem({ everPushed: true })])
    expect(seeded.itemIds).toContain(PLATFORM_ITEM)

    const res = await runTick(page, [
      planItem({
        everPushed: true,
        lastPushedData: planItem().docData,
        removedEmbedded: { items: [PLATFORM_ITEM] },
        docData: { items: [] },
      }),
    ])

    expect(res.found).toBe(true)
    expect(res.itemIds).not.toContain(PLATFORM_ITEM)
  })
})
