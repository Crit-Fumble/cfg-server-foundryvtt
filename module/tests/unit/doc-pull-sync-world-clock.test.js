/**
 * cs#417 rec 1 + rec 8 — the apply-time guards on the platform→Foundry write path.
 *
 * REC 1. The last live reproduction still failing after recs 2/3: page text a GM edited in
 * Foundry is OVERWRITTEN by a platform tick carrying OLDER text. Rec 2 stopped the courier
 * deleting embedded children; rec 3 stopped ownership being re-asserted. Neither touches a
 * plain UPDATE, which is the common case. Rec 1 does: before applying, compare the LIVE
 * document's effective Foundry clock against the item's `platformChangedAt`, and when the
 * world is STRICTLY NEWER, skip the write and ack it NOT APPLIED. Core leaves its baseline
 * alone on a failed ack, so the item is simply re-planned next tick.
 *
 * ⚠️ THE DEEP CASE IS THE WHOLE POINT. MEASURED on v14.361: editing an EMBEDDED document
 * does NOT advance the parent's `_stats.modifiedTime`. A parent-only check would silently
 * never protect a journal page edit — the most common edit there is — so the child-newer
 * test below is the one that proves the guard is real rather than decorative.
 *
 * ⚠️ NULL NEVER WINS, IN BOTH DIRECTIONS. An absent world clock is not evidence of a newer
 * world edit, and an absent `platformChangedAt` means "no baseline — APPLY", never "skip".
 * Erring toward applying keeps sync working; erring toward skipping would silently stall
 * every push on any doc type whose clock we cannot read.
 *
 * REC 8. `Document#update()` RESOLVES WITH `undefined` — it does not reject — when a
 * `preUpdate` hook vetoes or validation fails: `client/data/client-backend.mjs` drops the
 * doc with `continue`, and `common/abstract/document.mjs:750` returns `updates.shift()`.
 * So a system hook could silently swallow a platform edit while the module reported success
 * and core baselined a doc the world never received. An EMPTY diff is dropped by the very
 * same `continue` and is NOT a failure, so the two must be told apart — by the dry-run
 * `updateSource` diff Foundry itself computes one line above that check.
 */

import { jest } from '@jest/globals'
import { ActorPullSync } from '../../scripts/services/actor-pull-sync.js'
import { JournalPullSync } from '../../scripts/services/journal-pull-sync.js'

/** Array-backed game.users collection that also exposes Foundry's `.get(id)`. */
function makeUsers(list) {
  const arr = [...list]
  arr.get = (id) => arr.find((u) => u.id === id)
  return arr
}

const ACTOR_ID = 'DerivedActor0001'
const ENTRY_ID = 'DerivedEntry0001'

const PLATFORM_ISO = '2026-09-15T12:00:00.000Z'
const PLATFORM_MS = Date.parse(PLATFORM_ISO)

const stats = (modifiedTime) => ({ _stats: { modifiedTime } })

const actorItem = (over = {}) => ({
  characterId: 'char_1',
  foundryActorId: ACTOR_ID,
  everPushed: true,
  systemId: 'dnd5e',
  removedPaths: [],
  platformChangedAt: PLATFORM_ISO,
  docData: {
    _id: ACTOR_ID,
    name: 'Aria Brightwood',
    type: 'character',
    system: { attributes: { hp: { value: 10, max: 10 } } },
    items: [],
    effects: [],
  },
  ...over,
})

const journalItem = (over = {}) => ({
  journalEntryId: 'cjy_entry_1',
  foundryEntryId: ENTRY_ID,
  everPushed: true,
  platformChangedAt: PLATFORM_ISO,
  docData: {
    _id: ENTRY_ID,
    name: 'The Sunken Library',
    pages: [{ _id: 'pageAAAAAAAAAAAA', name: 'Overview', type: 'text' }],
  },
  ...over,
})

function actorApi(plan = []) {
  return {
    getActorSyncPlan: jest.fn(async () => ({ data: plan })),
    ackActorSync: jest.fn(async () => ({ data: { recorded: plan.length } })),
  }
}

function journalApi(plan = []) {
  return {
    getJournalSyncPlan: jest.fn(async () => ({ data: plan })),
    ackJournalSync: jest.fn(async () => ({ data: { recorded: plan.length } })),
  }
}

/**
 * A live Actor. `clock` is the PARENT's `_stats.modifiedTime` (undefined = no `_stats` at
 * all, which is the "absence never wins" case); `itemClocks`/`effectClocks` give each child
 * its own, which is how the deep case is built.
 */
function liveActor({ clock, itemClocks = [], effectClocks = [] } = {}) {
  return {
    id: ACTOR_ID,
    type: 'character',
    ...(clock === undefined ? {} : stats(clock)),
    toObject: () => ({ _id: ACTOR_ID, name: 'Stale', type: 'character', system: {}, items: [], effects: [] }),
    items: itemClocks.map((t, i) => ({ id: `item${i}`, ...(t === undefined ? {} : stats(t)) })),
    effects: effectClocks.map((t, i) => ({ id: `effect${i}`, ...(t === undefined ? {} : stats(t)) })),
    update: jest.fn(async () => {}),
    delete: jest.fn(async () => {}),
    deleteEmbeddedDocuments: jest.fn(async () => {}),
    updateEmbeddedDocuments: jest.fn(async () => {}),
    createEmbeddedDocuments: jest.fn(async () => {}),
  }
}

/** A live JournalEntry whose pages carry their own clocks — the measured deep case. */
function liveEntry({ clock, pageClocks = [] } = {}) {
  return {
    id: ENTRY_ID,
    ...(clock === undefined ? {} : stats(clock)),
    pages: pageClocks.map((t, i) => ({ id: `page${i}`, ...(t === undefined ? {} : stats(t)) })),
    update: jest.fn(async () => {}),
    deleteEmbeddedDocuments: jest.fn(async () => {}),
    updateEmbeddedDocuments: jest.fn(async () => {}),
    createEmbeddedDocuments: jest.fn(async () => {}),
  }
}

const seedActors = (byId) => { globalThis.game.actors = { get: (id) => byId[id] ?? undefined } }
const seedJournal = (byId) => { globalThis.game.journal = { get: (id) => byId[id] ?? undefined } }

beforeEach(() => {
  globalThis.Actor = { create: jest.fn(async (d) => ({ id: d._id })) }
  globalThis.JournalEntry = { create: jest.fn(async (d) => ({ id: d._id })) }
  globalThis.CONFIG = {
    Actor: { documentClass: function ActorClass() {} },
    JournalEntry: { documentClass: function JournalEntryClass() {} },
  }
  globalThis.foundry = { utils: { deepClone: (v) => JSON.parse(JSON.stringify(v)) } }
  globalThis.game = {
    world: { id: 'world-folder' },
    system: { id: 'dnd5e' },
    user: { id: 'gm-a', isGM: true },
    users: makeUsers([{ id: 'gm-a', active: true, isGM: true }]),
  }
  seedActors({})
  seedJournal({})
})

describe('cs#417 rec 1 — a world edit newer than the platform copy defers the push', () => {
  it('does NOT write, and acks WORLD_NEWER, when the live doc is strictly newer', async () => {
    const live = liveActor({ clock: PLATFORM_MS + 1000 })
    seedActors({ [ACTOR_ID]: live })
    const a = actorApi([actorItem()])

    await new ActorPullSync(a, 'inst-1').tick()

    expect(live.update).not.toHaveBeenCalled()
    expect(live.updateEmbeddedDocuments).not.toHaveBeenCalled()
    expect(live.createEmbeddedDocuments).not.toHaveBeenCalled()
    const [[, , , results]] = a.ackActorSync.mock.calls
    expect(results[0]).toMatchObject({ characterId: 'char_1', ok: false, code: 'WORLD_NEWER' })
  })

  it('WRITES when the live doc is older than platformChangedAt', async () => {
    const live = liveActor({ clock: PLATFORM_MS - 1000 })
    seedActors({ [ACTOR_ID]: live })
    const a = actorApi([actorItem()])

    await new ActorPullSync(a, 'inst-1').tick()

    expect(live.update).toHaveBeenCalled()
    const [[, , , results]] = a.ackActorSync.mock.calls
    expect(results[0]).toMatchObject({ ok: true })
  })

  it('WRITES on an exactly equal clock — the rule is STRICTLY newer, not newer-or-equal', async () => {
    const live = liveActor({ clock: PLATFORM_MS })
    seedActors({ [ACTOR_ID]: live })
    const a = actorApi([actorItem()])

    await new ActorPullSync(a, 'inst-1').tick()

    expect(live.update).toHaveBeenCalled()
  })

  it('APPLIES when platformChangedAt is absent — no baseline means apply, never skip', async () => {
    const live = liveActor({ clock: PLATFORM_MS + 60_000 })
    seedActors({ [ACTOR_ID]: live })
    const a = actorApi([actorItem({ platformChangedAt: null })])

    await new ActorPullSync(a, 'inst-1').tick()

    expect(live.update).toHaveBeenCalled()
    const [[, , , results]] = a.ackActorSync.mock.calls
    expect(results[0]).toMatchObject({ ok: true })
  })

  it('APPLIES when the live doc carries no _stats — absence is not a newer edit', async () => {
    const live = liveActor({ clock: undefined })
    seedActors({ [ACTOR_ID]: live })
    const a = actorApi([actorItem()])

    await new ActorPullSync(a, 'inst-1').tick()

    expect(live.update).toHaveBeenCalled()
  })

  it('APPLIES when platformChangedAt is unparseable — a NaN comparison must not decide', async () => {
    const live = liveActor({ clock: PLATFORM_MS + 60_000 })
    seedActors({ [ACTOR_ID]: live })
    const a = actorApi([actorItem({ platformChangedAt: 'Invalid Date' })])

    await new ActorPullSync(a, 'inst-1').tick()

    expect(live.update).toHaveBeenCalled()
  })

  it('SKIPS when a CHILD is newer though the parent is older — the deep case', async () => {
    // Measured v14.361: a page edit bumps ONLY the page. A parent-only check misses it.
    const live = liveEntry({ clock: PLATFORM_MS - 60_000, pageClocks: [PLATFORM_MS + 1000] })
    seedJournal({ [ENTRY_ID]: live })
    const a = journalApi([journalItem()])

    await new JournalPullSync(a, 'inst-1').tick()

    expect(live.update).not.toHaveBeenCalled()
    const [[, , results]] = a.ackJournalSync.mock.calls
    expect(results[0]).toMatchObject({ journalEntryId: 'cjy_entry_1', ok: false, code: 'WORLD_NEWER' })
  })

  it('SKIPS on a newer Item even when the parent Actor has no clock at all', async () => {
    const live = liveActor({ clock: undefined, itemClocks: [PLATFORM_MS + 1000] })
    seedActors({ [ACTOR_ID]: live })
    const a = actorApi([actorItem()])

    await new ActorPullSync(a, 'inst-1').tick()

    expect(live.update).not.toHaveBeenCalled()
  })

  it('IGNORES a non-numeric _stats.modifiedTime rather than coercing it', async () => {
    // A string clock is unreadable, and unreadable must mean "no world edit". Comparing it
    // raw would let JS coerce `'9999999999999' > platformMs` to TRUE and freeze the doc for
    // ever on data we never validated — absence-of-evidence promoted to evidence.
    const live = liveActor({ clock: String(PLATFORM_MS + 60_000) })
    seedActors({ [ACTOR_ID]: live })
    const a = actorApi([actorItem()])

    await new ActorPullSync(a, 'inst-1').tick()

    expect(live.update).toHaveBeenCalled()
  })

  it('reads children out of a Foundry EmbeddedCollection, not just a plain array', async () => {
    // What prod actually hands us. `common/utils/collection.mjs` overrides [Symbol.iterator]
    // to return values() — a bare Map would yield [key, value] PAIRS, whose `_stats` is
    // undefined, and the deep check would silently degrade to the parent-only one it exists
    // to replace. The unit fixtures use arrays, so only this test touches the real shape.
    const live = liveActor({ clock: PLATFORM_MS - 60_000 })
    class EmbeddedCollection extends Map {
      [Symbol.iterator]() { return this.values() }
    }
    const pages = new EmbeddedCollection()
    pages.set('item0', { id: 'item0', ...stats(PLATFORM_MS + 1000) })
    live.items = pages
    seedActors({ [ACTOR_ID]: live })
    const a = actorApi([actorItem()])

    await new ActorPullSync(a, 'inst-1').tick()

    expect(live.update).not.toHaveBeenCalled()
    const [[, , , results]] = a.ackActorSync.mock.calls
    expect(results[0]).toMatchObject({ ok: false, code: 'WORLD_NEWER' })
  })

  it('CREATES a missing doc regardless of platformChangedAt — there is no world clock to read', async () => {
    seedActors({})
    const a = actorApi([actorItem({ everPushed: false })])

    await new ActorPullSync(a, 'inst-1').tick()

    expect(Actor.create).toHaveBeenCalledWith(expect.objectContaining({ _id: ACTOR_ID }), { keepId: true })
  })
})

describe('cs#417 rec 8 — an update Foundry never applied must not ack ok', () => {
  it('acks NOT APPLIED when a preUpdate veto drops the update', async () => {
    const live = liveActor({ clock: PLATFORM_MS - 1000 })
    // A real veto: Foundry computes a NON-EMPTY diff, then `continue`s past the dispatch,
    // so `update()` resolves undefined and `_source` is untouched.
    live._source = { _id: ACTOR_ID, name: 'Stale' }
    live.updateSource = jest.fn(() => ({ name: 'Aria Brightwood' }))
    seedActors({ [ACTOR_ID]: live })
    const a = actorApi([actorItem()])

    await new ActorPullSync(a, 'inst-1').tick()

    const [[, , , results]] = a.ackActorSync.mock.calls
    expect(results[0]).toMatchObject({ ok: false, code: 'UPDATE_REJECTED' })
    expect(live.updateEmbeddedDocuments).not.toHaveBeenCalled()
  })

  it('acks OK when the update was an EMPTY diff — dropped by the same `continue`, not a failure', async () => {
    const live = liveActor({ clock: PLATFORM_MS - 1000 })
    live._source = { _id: ACTOR_ID, name: 'Aria Brightwood' }
    live.updateSource = jest.fn(() => ({}))
    seedActors({ [ACTOR_ID]: live })
    const a = actorApi([actorItem()])

    await new ActorPullSync(a, 'inst-1').tick()

    const [[, , , results]] = a.ackActorSync.mock.calls
    expect(results[0]).toMatchObject({ ok: true })
  })

  it('dry-runs the diff WITHOUT committing it — never a second write', async () => {
    const live = liveActor({ clock: PLATFORM_MS - 1000 })
    live._source = { _id: ACTOR_ID, name: 'Stale' }
    live.updateSource = jest.fn(() => ({ name: 'Aria Brightwood' }))
    live.update = jest.fn(async function () { live._source = { _id: ACTOR_ID, name: 'Aria Brightwood' }; return live })
    seedActors({ [ACTOR_ID]: live })

    await new ActorPullSync(actorApi([actorItem()]), 'inst-1').tick()

    expect(live.updateSource).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ dryRun: true }))
  })

  it('acks OK when the doc source changed even though update() returned nothing', async () => {
    const live = liveActor({ clock: PLATFORM_MS - 1000 })
    live._source = { _id: ACTOR_ID, name: 'Stale' }
    live.updateSource = jest.fn(() => ({ name: 'Aria Brightwood' }))
    live.update = jest.fn(async function () { live._source = { _id: ACTOR_ID, name: 'Aria Brightwood' } })
    seedActors({ [ACTOR_ID]: live })
    const a = actorApi([actorItem()])

    await new ActorPullSync(a, 'inst-1').tick()

    const [[, , , results]] = a.ackActorSync.mock.calls
    expect(results[0]).toMatchObject({ ok: true })
  })

  it('acks OK on a bare live doc that exposes no dry-run — unknown must degrade to applied', async () => {
    // Every pre-cs#417 fixture, and any doc class we cannot dry-run, lands here. Reporting
    // a failure we cannot substantiate would stall the push forever.
    const live = liveActor({ clock: PLATFORM_MS - 1000 })
    seedActors({ [ACTOR_ID]: live })
    const a = actorApi([actorItem()])

    await new ActorPullSync(a, 'inst-1').tick()

    const [[, , , results]] = a.ackActorSync.mock.calls
    expect(results[0]).toMatchObject({ ok: true })
  })
})
