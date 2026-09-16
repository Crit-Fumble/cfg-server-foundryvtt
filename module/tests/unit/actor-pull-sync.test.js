/**
 * Actor pull-sync (fp#46) — the GM-side half that carries a platform character into the
 * LIVE world, INCLUDING creating it.
 *
 * This replaces CharacterPullSync, whose two bail gates are what fp#46 was about:
 *   - `if (!game.actors.get(foundryActorId)) continue`  (no mapping ever registered)
 *   - `if (!actor) return // actor not in this world (yet)`
 * That `(yet)` never arrived: nothing in the plugin ever called `Actor.create`, so a
 * PlayTable-created character was invisible at the table forever. The two tests those
 * gates used to be pinned by are inverted here — absent + never-pushed now CREATES.
 *
 * The keepId assertion is load-bearing. Foundry's default is `keepId: false` and
 * `common/abstract/document.mjs:483` does `if (!keepId) delete data._id` — so without it
 * the server-assigned id is dropped, the create-if-absent lookup never matches, and we
 * duplicate every actor in the world every 30s, forever.
 */

import { jest } from '@jest/globals'
import { ActorPullSync, withRemovals } from '../../scripts/services/actor-pull-sync.js'

/** Array-backed game.users collection that also exposes Foundry's `.get(id)`. */
function makeUsers(list) {
  const arr = [...list]
  arr.get = (id) => arr.find((u) => u.id === id)
  return arr
}

const ACTOR_ID = 'DerivedActor0001'

const planItem = (over = {}) => ({
  characterId: 'char_1',
  foundryActorId: ACTOR_ID,
  everPushed: false,
  systemId: 'dnd5e',
  claimedAt: null,
  removedPaths: [],
  docData: {
    _id: ACTOR_ID,
    name: 'Aria Brightwood',
    type: 'character',
    system: { attributes: { hp: { value: 10, max: 10 } } },
    items: [{ _id: 'itemAAAAAAAAAAAA', name: 'Dagger', type: 'weapon' }],
    ownership: { default: 0, natAlice: 3 },
  },
  ...over,
})

function api(plan = []) {
  return {
    getActorSyncPlan: jest.fn(async () => ({ data: plan })),
    ackActorSync: jest.fn(async () => ({ data: { recorded: plan.length } })),
  }
}

/** A live Actor with the given embedded item/effect ids. */
function liveActor({ type = 'character', itemIds = [], effectIds = [] } = {}) {
  return {
    id: ACTOR_ID,
    type,
    toObject: () => ({ _id: ACTOR_ID, name: 'Stale', type, system: {}, items: [], effects: [] }),
    items: itemIds.map((id) => ({ id })),
    effects: effectIds.map((id) => ({ id })),
    update: jest.fn(async () => {}),
    delete: jest.fn(async () => {}),
    deleteEmbeddedDocuments: jest.fn(async () => {}),
    updateEmbeddedDocuments: jest.fn(async () => {}),
    createEmbeddedDocuments: jest.fn(async () => {}),
  }
}

function seedActors(byId = {}) {
  globalThis.game.actors = { get: (id) => byId[id] ?? undefined }
}

beforeEach(() => {
  globalThis.Actor = { create: jest.fn(async (d) => ({ id: d._id })) }
  globalThis.CONFIG = { Actor: { documentClass: function ActorClass() {} } }
  globalThis.foundry = { utils: { deepClone: (v) => JSON.parse(JSON.stringify(v)) } }
  globalThis.game = {
    world: { id: 'world-folder' },
    system: { id: 'dnd5e' },
    user: { id: 'gm-a', isGM: true },
    users: makeUsers([{ id: 'gm-a', active: true, isGM: true }]),
  }
  seedActors({})
})

describe('ActorPullSync — reporter election', () => {
  it('acts when this client is the elected (smallest-id human) GM', async () => {
    globalThis.game.users = makeUsers([
      { id: 'gm-a', active: true, isGM: true },
      { id: 'gm-b', active: true, isGM: true },
    ])
    const a = api([planItem()])
    await new ActorPullSync(a, 'inst-1').tick()
    expect(a.getActorSyncPlan).toHaveBeenCalled()
  })

  it('stays quiet on a non-elected GM client', async () => {
    globalThis.game.user = { id: 'gm-b', isGM: true }
    globalThis.game.users = makeUsers([
      { id: 'gm-a', active: true, isGM: true },
      { id: 'gm-b', active: true, isGM: true },
    ])
    const a = api([planItem()])
    await new ActorPullSync(a, 'inst-1').tick()
    expect(a.getActorSyncPlan).not.toHaveBeenCalled()
  })

  it('defers to a human GM when the service-GM is also connected', async () => {
    globalThis.game.user = { id: 'CFGServiceGM0000', isGM: true }
    globalThis.game.users = makeUsers([
      { id: 'CFGServiceGM0000', active: true, isGM: true },
      { id: 'gm-a', active: true, isGM: true },
    ])
    const a = api([planItem()])
    await new ActorPullSync(a, 'inst-1').tick()
    expect(a.getActorSyncPlan).not.toHaveBeenCalled()
  })

  it('acts when the service-GM is the only connected GM', async () => {
    globalThis.game.user = { id: 'CFGServiceGM0000', isGM: true }
    globalThis.game.users = makeUsers([{ id: 'CFGServiceGM0000', active: true, isGM: true }])
    const a = api([planItem()])
    await new ActorPullSync(a, 'inst-1').tick()
    expect(a.getActorSyncPlan).toHaveBeenCalled()
  })
})

describe('ActorPullSync — create (the fp#46 hole)', () => {
  it('CREATES an actor that is not in this world and has never been pushed', async () => {
    // Inverted from character-pull-sync.test.js "skips a record whose actor is not in
    // game.actors" — that assertion is exactly what pinned the bug in place.
    const a = api([planItem()])
    await new ActorPullSync(a, 'inst-1').tick()

    expect(globalThis.Actor.create).toHaveBeenCalledTimes(1)
    const [doc, opts] = globalThis.Actor.create.mock.calls[0]
    expect(doc._id).toBe(ACTOR_ID)
    expect(opts).toEqual({ keepId: true }) // without this the id is dropped → duplicates forever
  })

  it('does NOT re-create an actor the world already has', async () => {
    seedActors({ [ACTOR_ID]: liveActor() })
    const a = api([planItem({ everPushed: true })])
    await new ActorPullSync(a, 'inst-1').tick()
    expect(globalThis.Actor.create).not.toHaveBeenCalled()
  })

  it('reports world_deleted instead of resurrecting an actor the GM deleted', async () => {
    // Absent + everPushed means the world had it and no longer does. Re-creating it
    // every 30s would make the actor un-deletable.
    const a = api([planItem({ everPushed: true })])
    await new ActorPullSync(a, 'inst-1').tick()

    expect(globalThis.Actor.create).not.toHaveBeenCalled()
    const [, , , results] = a.ackActorSync.mock.calls[0]
    expect(results[0]).toMatchObject({ ok: false, code: 'world_deleted' })
  })
})

describe('ActorPullSync — update', () => {
  it('updates the parent without items/effects and reconciles them separately', async () => {
    const live = liveActor({ itemIds: ['itemOLD00000000A'] })
    seedActors({ [ACTOR_ID]: live })
    // ⚠️ This test used to end `expect(live.deleteEmbeddedDocuments).toHaveBeenCalledWith('Item',
    // ['itemOLD00000000A'])` with NO `removedEmbedded` on the item — i.e. it pinned the cs#417
    // set-difference bug as the desired behaviour. The delete is now the server's call, so the
    // id has to be NAMED to be taken away; the rest of the reconciliation split is unchanged.
    const a = api([planItem({ everPushed: true, removedEmbedded: { items: ['itemOLD00000000A'] } })])
    await new ActorPullSync(a, 'inst-1').tick()

    // Embedded collections merge by _id through a parent update and never REMOVE —
    // so they must be reconciled explicitly, exactly like journal pages.
    const payload = live.update.mock.calls[0][0]
    expect(payload.items).toBeUndefined()
    expect(payload.effects).toBeUndefined()
    expect(live.createEmbeddedDocuments).toHaveBeenCalledWith('Item', [expect.objectContaining({ _id: 'itemAAAAAAAAAAAA' })], { keepId: true })
    expect(live.deleteEmbeddedDocuments).toHaveBeenCalledWith('Item', ['itemOLD00000000A'])
  })

  it('emits `-=` markers ONLY for the server-supplied removedPaths (fp#49)', async () => {
    // Never from diffing the live doc: that asks Foundry to delete every field the
    // platform doesn't model (`_stats`, `prototypeToken`, …), which makes the whole
    // update a silent no-op on dnd5e. removedPaths comes from the server's own baseline.
    const live = liveActor()
    live.toObject = () => ({ _id: ACTOR_ID, name: 'Stale', type: 'character', system: { gone: 1 }, items: [], effects: [], _stats: { modifiedTime: 1 } })
    seedActors({ [ACTOR_ID]: live })
    const a = api([
      planItem({
        everPushed: true,
        removedPaths: ['system.gone', 'img'],
        docData: { _id: ACTOR_ID, name: 'Aria', type: 'character', system: {}, items: [] },
      }),
    ])
    await new ActorPullSync(a, 'inst-1').tick()

    const payload = live.update.mock.calls[0][0]
    expect(payload.system['-=gone']).toBeNull()
    expect(payload['-=img']).toBeNull()
    // The fields the platform never modeled are untouched — no marker for them anywhere.
    expect(JSON.stringify(payload)).not.toContain('_stats')
    expect(JSON.stringify(payload)).not.toContain('prototypeToken')
    expect(payload.name).toBe('Aria')
  })

  it('sends no markers at all when the server names no removals', async () => {
    const live = liveActor()
    seedActors({ [ACTOR_ID]: live })
    const a = api([planItem({ everPushed: true })]) // removedPaths defaults to []
    await new ActorPullSync(a, 'inst-1').tick()

    expect(JSON.stringify(live.update.mock.calls[0][0])).not.toContain('-=')
  })

  it('recreates with keepId when the type changed — update() cannot change type', async () => {
    seedActors({ [ACTOR_ID]: liveActor({ type: 'npc' }) })
    const live = globalThis.game.actors.get(ACTOR_ID)
    const a = api([planItem({ everPushed: true })]) // docData.type === 'character'
    await new ActorPullSync(a, 'inst-1').tick()

    expect(live.delete).toHaveBeenCalled()
    expect(globalThis.Actor.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'character' }), { keepId: true })
  })
})

describe('ActorPullSync — server-named embedded removals (cs#417 rec 2)', () => {
  // REPRODUCED LIVE 2026-09-15 (cfs PR #33): an Item a player drops on their sheet, an
  // ActiveEffect a spell applies, a page a GM adds to a journal and tokens/walls a GM places
  // were all destroyed by the next 30s tick, because `_reconcileEmbedded` derived deletions as
  // `liveIds - platformIds`. Foundry NEVER deletes an embedded document through a parent
  // update — `EmbeddedCollectionField._updateDiff` matches by `_id` and creates the unmatched —
  // so "the platform removed it" and "a player just created it" arrive as the same fact, and
  // subtraction always chose destruction. The server now names removals; nothing else goes.

  it('leaves a live child the server did NOT name alone — the player-dropped item survives', async () => {
    const live = liveActor({ itemIds: ['itemAAAAAAAAAAAA', 'itemPLAYERDROP01'] })
    seedActors({ [ACTOR_ID]: live })
    // The platform's view still lists only the Dagger; the second item appeared at the table
    // between two ticks. The server removed nothing, so it says so with an empty list.
    const a = api([planItem({ everPushed: true, removedEmbedded: { items: [], effects: [] } })])
    await new ActorPullSync(a, 'inst-1').tick()

    expect(live.deleteEmbeddedDocuments).not.toHaveBeenCalled()
  })

  it('deletes a live child the server DID name', async () => {
    const live = liveActor({ itemIds: ['itemAAAAAAAAAAAA', 'itemOLD00000000A'] })
    seedActors({ [ACTOR_ID]: live })
    const a = api([planItem({ everPushed: true, removedEmbedded: { items: ['itemOLD00000000A'] } })])
    await new ActorPullSync(a, 'inst-1').tick()

    // Named AND live — exactly that id, and only that id.
    expect(live.deleteEmbeddedDocuments).toHaveBeenCalledTimes(1)
    expect(live.deleteEmbeddedDocuments).toHaveBeenCalledWith('Item', ['itemOLD00000000A'])
  })

  it('deletes NOTHING when `removedEmbedded` is absent entirely (older core)', async () => {
    // The fail-safe, and the reason it is deliberate: this module ships on its own release
    // channel and may reach a world before core learns to send the field. "Stop deleting" is
    // the safe direction — a genuine platform removal just stops propagating until core ships.
    const live = liveActor({ itemIds: ['itemAAAAAAAAAAAA', 'itemOLD00000000A'], effectIds: ['effSTALE000001A'] })
    seedActors({ [ACTOR_ID]: live })
    const a = api([planItem({ everPushed: true })]) // no removedEmbedded key at all
    await new ActorPullSync(a, 'inst-1').tick()

    expect(live.deleteEmbeddedDocuments).not.toHaveBeenCalled()
    expect(a.ackActorSync.mock.calls[0][3][0].ok).toBe(true) // and the tick still succeeds
  })

  it('names one collection without touching the other — the key is per-collection', async () => {
    // `removedEmbedded` is keyed by DOCDATA FIELD (`items`, `effects`, `pages`, `tokens`, …).
    // A key present for one collection says nothing about a collection it omits.
    //
    // ⚠️ `effects: []` in docData IS the test (cs#417 follow-up). This case used to omit
    // `effects` entirely, which made it GREEN AGAINST THE PRE-CHANGE set-difference code too:
    // that code returned early on `!Array.isArray(desired)`, so the effect was spared by
    // "not managed", not by the per-collection key. A MANAGED-BUT-EMPTY array is the one shape
    // where subtraction deletes every live child, so it is the only fixture in which the
    // fail-safe is the sole thing standing between the server's silence and that effect.
    const live = liveActor({ itemIds: ['itemAAAAAAAAAAAA', 'itemOLD00000000A'], effectIds: ['effSTALE000001A'] })
    seedActors({ [ACTOR_ID]: live })
    const a = api([
      planItem({
        everPushed: true,
        removedEmbedded: { items: ['itemOLD00000000A'] }, // no `effects` key at all
        docData: {
          _id: ACTOR_ID,
          name: 'Aria Brightwood',
          type: 'character',
          items: [{ _id: 'itemAAAAAAAAAAAA', name: 'Dagger', type: 'weapon' }],
          effects: [], // the platform models effects and currently has none
        },
      }),
    ])
    await new ActorPullSync(a, 'inst-1').tick()

    expect(live.deleteEmbeddedDocuments).toHaveBeenCalledTimes(1)
    expect(live.deleteEmbeddedDocuments).toHaveBeenCalledWith('Item', ['itemOLD00000000A'])
    // The effect is stale by subtraction and untouched by name — which is the whole point.
    expect(live.deleteEmbeddedDocuments).not.toHaveBeenCalledWith('ActiveEffect', expect.anything())
  })

  it('re-creates, never updates, a child the plan both removes and still lists', async () => {
    // A contradictory plan item should not happen, but if the server names an id in
    // `removedEmbedded` while `docData` still carries it, the delete runs first — and the
    // create/update split must be computed AFTER it (cs#417). Splitting on the pre-delete
    // `haveIds` would route the id to updateEmbeddedDocuments, against a child that no longer
    // exists, and fail the whole document for a state the create path recovers from.
    const live = liveActor({ itemIds: ['itemAAAAAAAAAAAA', 'itemOLD00000000A'] })
    seedActors({ [ACTOR_ID]: live })
    const a = api([
      planItem({
        everPushed: true,
        removedEmbedded: { items: ['itemOLD00000000A'] },
        docData: {
          _id: ACTOR_ID,
          name: 'Aria Brightwood',
          type: 'character',
          items: [
            { _id: 'itemAAAAAAAAAAAA', name: 'Dagger', type: 'weapon' },
            { _id: 'itemOLD00000000A', name: 'Contradiction', type: 'weapon' },
          ],
        },
      }),
    ])
    await new ActorPullSync(a, 'inst-1').tick()

    expect(live.deleteEmbeddedDocuments).toHaveBeenCalledWith('Item', ['itemOLD00000000A'])
    expect(live.createEmbeddedDocuments).toHaveBeenCalledWith('Item', [expect.objectContaining({ _id: 'itemOLD00000000A' })], { keepId: true })
    expect(live.updateEmbeddedDocuments).not.toHaveBeenCalledWith('Item', expect.arrayContaining([expect.objectContaining({ _id: 'itemOLD00000000A' })]))
  })

  it('is a no-op for a named id that is not live — no throw, no empty delete call', async () => {
    // The GM got there first, or an earlier tick already applied it. Intersecting the server's
    // list with what is actually live keeps a stale name harmless instead of an error ack.
    const live = liveActor({ itemIds: ['itemAAAAAAAAAAAA'] })
    seedActors({ [ACTOR_ID]: live })
    const a = api([planItem({ everPushed: true, removedEmbedded: { items: ['itemGHOST00000A1'] } })])
    await new ActorPullSync(a, 'inst-1').tick()

    expect(live.deleteEmbeddedDocuments).not.toHaveBeenCalled()
    expect(a.ackActorSync.mock.calls[0][3][0].ok).toBe(true)
  })

  it('still creates and updates embedded children exactly as before', async () => {
    // The fix must narrow DELETION only. A child the platform added is still created with
    // keepId, and one it edited is still updated — both alongside a named removal.
    const live = liveActor({ itemIds: ['itemAAAAAAAAAAAA', 'itemOLD00000000A'] })
    seedActors({ [ACTOR_ID]: live })
    const a = api([
      planItem({
        everPushed: true,
        removedEmbedded: { items: ['itemOLD00000000A'] },
        docData: {
          _id: ACTOR_ID,
          name: 'Aria Brightwood',
          type: 'character',
          items: [
            { _id: 'itemAAAAAAAAAAAA', name: 'Dagger +1', type: 'weapon' },
            { _id: 'itemBBBBBBBBBBBB', name: 'Shield', type: 'equipment' },
          ],
        },
      }),
    ])
    await new ActorPullSync(a, 'inst-1').tick()

    expect(live.updateEmbeddedDocuments).toHaveBeenCalledWith('Item', [expect.objectContaining({ _id: 'itemAAAAAAAAAAAA', name: 'Dagger +1' })])
    expect(live.createEmbeddedDocuments).toHaveBeenCalledWith('Item', [expect.objectContaining({ _id: 'itemBBBBBBBBBBBB' })], { keepId: true })
    expect(live.deleteEmbeddedDocuments).toHaveBeenCalledWith('Item', ['itemOLD00000000A'])
  })
})

describe('ActorPullSync — refusals', () => {
  it('refuses a doc built for another game system instead of throw-looping', async () => {
    const a = api([planItem({ systemId: 'cyphersystem' })])
    await new ActorPullSync(a, 'inst-1').tick()

    expect(globalThis.Actor.create).not.toHaveBeenCalled()
    expect(a.ackActorSync.mock.calls[0][3][0]).toMatchObject({ ok: false, code: 'system_mismatch' })
  })

  it('acks a health-probe refusal as an error rather than throwing', async () => {
    globalThis.CONFIG.Actor.documentClass = function Bad() {
      throw new Error('bad field')
    }
    const a = api([planItem()])
    await new ActorPullSync(a, 'inst-1').tick()

    expect(globalThis.Actor.create).not.toHaveBeenCalled()
    expect(a.ackActorSync.mock.calls[0][3][0].ok).toBe(false)
  })
})

describe('ActorPullSync — the ack contract', () => {
  it('echoes the doc it wrote and the claim it satisfied', async () => {
    const item = planItem({ claimedAt: '2026-07-25T12:00:00.000Z' })
    const a = api([item])
    await new ActorPullSync(a, 'inst-1').tick()

    const [installId, worldId, systemId, results] = a.ackActorSync.mock.calls[0]
    expect(installId).toBe('inst-1')
    expect(worldId).toBe('world-folder')
    expect(systemId).toBe('dnd5e')
    expect(results[0]).toEqual({
      characterId: 'char_1',
      foundryActorId: ACTOR_ID,
      ok: true,
      docData: item.docData,
      claimedAt: '2026-07-25T12:00:00.000Z',
    })
  })

  it('one bad actor does not stop the rest', async () => {
    const good = planItem({ characterId: 'char_2', foundryActorId: 'DerivedActor0002' })
    const bad = planItem({ characterId: 'char_3', foundryActorId: 'DerivedActor0003', docData: null })
    const a = api([bad, good])
    await new ActorPullSync(a, 'inst-1').tick()

    const results = a.ackActorSync.mock.calls[0][3]
    expect(results.find((r) => r.characterId === 'char_3').ok).toBe(false)
    expect(results.find((r) => r.characterId === 'char_2').ok).toBe(true)
  })

  it('an empty plan does nothing and does not ack', async () => {
    const a = api([])
    await new ActorPullSync(a, 'inst-1').tick()
    expect(a.ackActorSync).not.toHaveBeenCalled()
    expect(globalThis.Actor.create).not.toHaveBeenCalled()
  })

  it('sends the world system so the server can plan for it', async () => {
    const a = api([planItem()])
    await new ActorPullSync(a, 'inst-1').tick()
    expect(a.getActorSyncPlan).toHaveBeenCalledWith('inst-1', 'world-folder', 'dnd5e')
  })

  it('does not overlap ticks', async () => {
    const a = api([planItem()])
    let release
    a.getActorSyncPlan = jest.fn(() => new Promise((r) => (release = () => r({ data: [] }))))
    const sync = new ActorPullSync(a, 'inst-1')
    const first = sync.tick()
    await sync.tick()
    expect(a.getActorSyncPlan).toHaveBeenCalledTimes(1)
    release()
    await first
  })
})

describe('withRemovals — marker syntax (fp#49)', () => {
  it('nests the marker into the payload tree, prefixing the FINAL segment', () => {
    // NOT a flat `system.attributes.-=ac` key: verified against Foundry v14.361, a flat
    // dotted marker sent alongside a nested `system` object is silently dropped.
    expect(withRemovals({}, ['system.attributes.ac'])).toEqual({ system: { attributes: { '-=ac': null } } })
  })

  it('handles a top-level path', () => {
    expect(withRemovals({}, ['img'])).toEqual({ '-=img': null })
  })

  it('merges into the desired value at the same level without clobbering it', () => {
    const out = withRemovals({ name: 'A', system: { hp: 1 } }, ['system.ac'])
    expect(out.name).toBe('A')
    expect(out.system).toEqual({ hp: 1, '-=ac': null })
  })

  it('does not mutate the caller’s payload', () => {
    const fields = { system: { hp: 1 } }
    withRemovals(fields, ['system.ac'])
    expect(fields.system).toEqual({ hp: 1 })
  })

  it('skips a path whose parent the platform set to a non-object', () => {
    expect(withRemovals({ system: 'scalar' }, ['system.ac'])).toEqual({ system: 'scalar' })
  })

  it('returns the payload untouched when there is nothing to remove', () => {
    const fields = { name: 'A' }
    expect(withRemovals(fields, [])).toBe(fields)
    expect(withRemovals(fields, undefined)).toBe(fields)
  })
})
