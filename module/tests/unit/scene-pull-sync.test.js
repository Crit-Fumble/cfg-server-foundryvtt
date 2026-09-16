/**
 * Scene pull-sync (dt#246) — embedded-deletion coverage for the SCENE config (cs#417 rec 2).
 *
 * The server-named-removals change landed in the shared engine (`doc-pull-sync.js`), so it is
 * generic across all seven pull-syncs, but until now only actor and journal pinned it. Scenes
 * are where the blast radius is largest: a Scene carries EIGHT embedded collections (tokens,
 * walls, lights, sounds, drawings, notes, tiles, regions), every one of them a thing a GM
 * places by hand at the table, and none of them removable through a parent update — so the
 * old `liveIds - platformIds` subtraction wiped GM-placed tokens and walls on the next 30s
 * tick (reproduced live 2026-09-15, cfs PR #33).
 *
 * Two tests, deliberately: "nothing is deleted" alone would also pass against an engine that
 * never deletes anything, so the second one is the population control that proves deletion
 * still works here when the server actually names an id.
 */

import { jest } from '@jest/globals'
import { ScenePullSync } from '../../scripts/services/scene-pull-sync.js'

/** Array-backed game.users collection that also exposes Foundry's `.get(id)`. */
function makeUsers(list) {
  const arr = [...list]
  arr.get = (id) => arr.find((u) => u.id === id)
  return arr
}

const SCENE_ID = 'DerivedScene0001'
const PLATFORM_TOKEN = 'tokPLATFORM00001'

const planItem = (over = {}) => ({
  sceneId: 'scn_1',
  foundrySceneId: SCENE_ID,
  everPushed: true,
  docData: {
    _id: SCENE_ID,
    name: 'The Drowned Chapel',
    // The platform models tokens and walls; it currently knows about one token and no walls.
    tokens: [{ _id: PLATFORM_TOKEN, name: 'Aria', x: 100, y: 100 }],
    walls: [],
  },
  ...over,
})

function api(plan = []) {
  return {
    getSceneSyncPlan: jest.fn(async () => ({ data: plan })),
    ackSceneSync: jest.fn(async () => ({ data: { recorded: plan.length } })),
  }
}

/** A live Scene with the given embedded ids. Scenes have no `type`, so none is set. */
function liveScene({ tokenIds = [], wallIds = [] } = {}) {
  return {
    id: SCENE_ID,
    tokens: tokenIds.map((id) => ({ id })),
    walls: wallIds.map((id) => ({ id })),
    update: jest.fn(async () => {}),
    delete: jest.fn(async () => {}),
    deleteEmbeddedDocuments: jest.fn(async () => {}),
    updateEmbeddedDocuments: jest.fn(async () => {}),
    createEmbeddedDocuments: jest.fn(async () => {}),
  }
}

function seedScenes(byId = {}) {
  globalThis.game.scenes = { get: (id) => byId[id] ?? undefined }
}

beforeEach(() => {
  globalThis.Scene = { create: jest.fn(async (d) => ({ id: d._id })) }
  globalThis.CONFIG = { Scene: { documentClass: function SceneClass() {} } }
  globalThis.foundry = { utils: { deepClone: (v) => JSON.parse(JSON.stringify(v)) } }
  globalThis.game = {
    world: { id: 'world-folder' },
    system: { id: 'dnd5e' }, // scenes are system-agnostic (`checkSystem: false`), but the engine reads it
    user: { id: 'gm-a', isGM: true },
    users: makeUsers([{ id: 'gm-a', active: true, isGM: true }]),
  }
  seedScenes({})
})

describe('ScenePullSync — server-named embedded removals (cs#417 rec 2)', () => {
  it('KEEPS the tokens and walls a GM placed when the plan names no removals at all', async () => {
    // The live repro at unit altitude: the GM drops an ambush token and walls off a corridor
    // mid-session. The platform's arrays still list only its own token and no walls, and the
    // plan carries NO `removedEmbedded` — so the fail-safe is the only thing protecting them.
    const live = liveScene({ tokenIds: [PLATFORM_TOKEN, 'tokGMPLACED00001'], wallIds: ['wallGMPLACED0001'] })
    seedScenes({ [SCENE_ID]: live })
    const a = api([planItem()])

    await new ScenePullSync(a, 'inst-1').tick()

    expect(live.deleteEmbeddedDocuments).not.toHaveBeenCalled()
    // …and the rest of the tick still ran: the platform's own token was reconciled as an update.
    expect(live.updateEmbeddedDocuments).toHaveBeenCalledWith('Token', [expect.objectContaining({ _id: PLATFORM_TOKEN })])
    expect(a.ackSceneSync.mock.calls[0][2][0].ok).toBe(true)
  })

  it('still deletes a token the server DID name — the fail-safe narrows deletion, not removes it', async () => {
    const live = liveScene({ tokenIds: [PLATFORM_TOKEN, 'tokRETIRED000001'], wallIds: ['wallGMPLACED0001'] })
    seedScenes({ [SCENE_ID]: live })
    const a = api([planItem({ removedEmbedded: { tokens: ['tokRETIRED000001'] } })])

    await new ScenePullSync(a, 'inst-1').tick()

    expect(live.deleteEmbeddedDocuments).toHaveBeenCalledTimes(1)
    expect(live.deleteEmbeddedDocuments).toHaveBeenCalledWith('Token', ['tokRETIRED000001'])
    // The GM's wall is stale by subtraction and unnamed by the server, so it survives.
    expect(live.deleteEmbeddedDocuments).not.toHaveBeenCalledWith('Wall', expect.anything())
  })
})
