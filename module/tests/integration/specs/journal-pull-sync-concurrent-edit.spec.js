/**
 * Journal pull-sync vs CONCURRENT EDITING, against a REAL FoundryVTT v14 world (cs#417 H3).
 *
 * `journal-pull-sync.spec.js` proves the courier writes what the platform asked for. This
 * spec asks the opposite question — what happens to what the GM wrote — and it can only be
 * asked here. A mocked test has no world state that PRE-DATES the tick: it can only observe
 * which Foundry API we called, and in every case below we call exactly the right API with
 * the wrong payload. The mock is green; the GM's session notes are gone.
 *
 * ── (i) PAGE TEXT — a race we lose ──────────────────────────────────────────────────
 * The platform writes `pages[].text.content` through `updateEmbeddedDocuments`, entirely
 * OUTSIDE the ProseMirror collaborative authority the journal sheet edits through. Two
 * observable halves, both reproduced here:
 *
 *   · A page the GM ADDED in Foundry is absent from the platform's `pages` array, so
 *     `_reconcileEmbedded` (doc-pull-sync.js:311-325) computes `toDelete = liveIds -
 *     platformArrayIds` and removes it. Foundry itself NEVER deletes a child through a
 *     parent update (common/data/fields.mjs:3062-3105 matches by `_id`, creates unmatched,
 *     deletes nothing) — that deletion is ours alone, and nothing else in the stack would
 *     have done it.
 *   · A page text the GM EDITED in Foundry is overwritten by the next push, which carries
 *     the text as of the platform's last change.
 *
 * Today the courier cannot tell those from the legitimate case, because the only signal it
 * has is "an id in the live world that the platform array does not carry", and that is
 * true both when the PLATFORM removed a child and when a USER added one. Same for text:
 * "the platform's content differs from the live content" is true both when the platform
 * holds a newer edit and when the GM does.
 *
 * ⚠️ WHAT THIS SPEC DELIBERATELY DOES NOT COVER, and why it is the worse half. Driving the
 * live ProseMirror editor needs a SECOND connected client plus the server-side collab
 * authority, which a single Playwright page cannot stand up — so these cases model the GM
 * with the editor CLOSED (a plain page update, which is what the sheet commits on save).
 * With the editor OPEN it is worse, not better: Foundry's journal ProseMirror sheet refuses
 * to re-render a dirty editor (journal-pm-sheet.mjs:43-46, per the cs#417 audit against
 * 14.367), so the typing GM sees their own untouched draft while the stored page has
 * already been overwritten underneath them. The data loss is real AND invisible until the
 * next open. Reproducing that needs a two-client harness; it is not a reason to believe the
 * single-client cases below are the whole exposure.
 *
 * ── (ii) OWNERSHIP — not a race at all ──────────────────────────────────────────────
 * `cs:journal-doc.ts:40-56` puts `ownership` in EVERY materialized doc and
 * `journal-doc.ts:182-200` rebuilds it from the `visibility` column on every push, so a
 * push of ANYTHING — a rename, one page edit — re-asserts the platform's permission map
 * over the GM's. No concurrency, no timing, no second client: it reverts every time. The
 * cheapest half of cs#417 to prove, and the cheapest to fix.
 *
 * ── WHY SOME TESTS ARE `test.fail()` ────────────────────────────────────────────────
 * The repros FAIL on today's code by design — they assert the outcome a player cares
 * about (my page is still there; my text is still mine; my permission still holds), which
 * is exactly what the bug destroys. `test.fail()` keeps the suite green while the bug
 * stands AND turns the suite RED the moment the behaviour is fixed without deleting the
 * marker, so the fix cannot land un-noticed. `test.skip`/`test.fixme` would prove nothing:
 * a skipped test stays green whatever the code does.
 *
 * ⛔ The marker is called INSIDE the test body, and that placement is load-bearing. A bare
 * `test.fail()` between two tests is not a per-test annotation — it applies to the whole
 * enclosing `describe`, INCLUDING tests declared above it, so every control in this file
 * would report "Expected to fail, but passed". Measured against the pinned Playwright, not
 * recalled. Keep it in the body.
 *
 * ⛔ And it sits IMMEDIATELY ABOVE THE FINAL ASSERTION BLOCK, never at the top of the body.
 * The annotation marks the whole test wherever it is called, so a top-of-body marker hands
 * the expected failure to the SETUP as well — and the setup is exactly what can fail for
 * reasons that are not this bug: `tick()` RETURNS SILENTLY when this page is not the
 * elected reporter or the world is not ready, so a tick that did nothing at all would be
 * booked as "the bug reproduced". Each repro therefore asserts its preconditions first —
 * the seed landed, the GM's edit is in place, the platform's own change (the rename)
 * arrived — with those assertions OUTSIDE the marker, where a no-op fails loudly.
 *
 * Every repro is PAIRED with a control that must keep passing, because a repro without its
 * control licenses the wrong fix: "never delete an embedded document" and "never push
 * ownership" would both turn the repros green while breaking the platform's authority over
 * its own data (`journal-sync-plan.ts` is explicit that a REVOKE must propagate).
 *
 * Transport is stubbed, Foundry is real: the REAL JournalPullSync is constructed with a
 * fake api returning a fixed plan, so this needs no Core stack — a failure means the world
 * disagrees with us, never "the fixtures aren't seeded".
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const MODULE_URL = '/modules/crit-fumble-core/scripts/services/journal-pull-sync.js'

// Foundry's DocumentIdField requires exactly 16 alphanumerics — the same shape
// deriveFoundryEntryId emits server-side.
const ENTRY_ID = 'CfgJrnConcur0001'
const PAGE_A = 'CfgJrnPageAAAA01'
const PAGE_B = 'CfgJrnPageBBBB01'
const SOURCE_ID = 'cjy_concurrent_1'

const PLATFORM_TEXT = '<p>Flooded. Two exits.</p>'
const PLATFORM_TEXT_NEWER = '<p>Flooded. Two exits, one barred.</p>'
const GM_TEXT = '<p>Flooded. Two exits, and the east one collapsed during play.</p>'
const GM_PAGE_NAME = 'Session 12 notes'

function textPage(id, name, content, sort = 0) {
  return { _id: id, name, type: 'text', title: { show: false, level: 1 }, sort, text: { format: 1, content } }
}

/**
 * A plan item shaped like the server's materializeJournalDocForWorld output.
 *
 * `everPushed` is read by the engine (doc-pull-sync.js — absent + never-pushed → create)
 * but is NOT emitted by the journal route today: the live journal plan item is exactly
 * `{journalEntryId, foundryEntryId, docData, partyId}` (cs:journal-sync-plan.ts:31-40).
 */
function planItem(over = {}) {
  const { docData: docOver, ...rest } = over
  return {
    journalEntryId: SOURCE_ID,
    foundryEntryId: ENTRY_ID,
    partyId: 'party-live',
    everPushed: false,
    docData: {
      _id: ENTRY_ID,
      name: 'The Sunken Library',
      ownership: { default: 0 },
      sort: 0,
      folder: null,
      flags: { playtable: { sourceJournalEntryId: SOURCE_ID } },
      pages: [textPage(PAGE_A, 'Overview', PLATFORM_TEXT)],
      ...docOver,
    },
    ...rest,
  }
}

/**
 * Model the server-side BASELINE: what the platform believes it last wrote into this world.
 *
 * `lastPushedData` is not invented for this spec — `FoundryJournalSync.lastPushedData`
 * already holds precisely this (cs:journal-sync.ts:189-211 records the doc the reporter
 * echoed back), which is why cs#417 rec 2 needs no new column: `removedEmbedded` is
 * computable from ids present in `lastPushedData[field]` and absent from `docData[field]`.
 * `platformChangedAt` is rec 1's side of the comparison.
 *
 * The module ignores all three keys today; carrying them is what makes each case below
 * state WHICH history produced the divergence, instead of leaving it ambiguous.
 *
 * ⚠️ An ABSENT `platformChangedAt` must mean "no baseline — APPLY", never "skip". Both
 * ownership cases below omit it deliberately (ownership is not clock-compared), so a rec 1
 * that reads a missing clock as "cannot compare, leave the world alone" would stop the
 * CONTROL's revoke from propagating — the one thing `journal-sync-plan.ts` is explicit must
 * always reach the world. Stated here so that post-fix behaviour is not an unstated default.
 */
function alreadyPushed(item, { lastPushedData = item.docData, platformChangedAt, removedEmbedded } = {}) {
  return {
    ...item,
    everPushed: true,
    lastPushedData,
    ...(platformChangedAt === undefined ? {} : { platformChangedAt }),
    ...(removedEmbedded === undefined ? {} : { removedEmbedded }),
  }
}

/** Drive ONE real tick of the real service against the live world. */
async function runTick(page, plan) {
  return page.evaluate(
    async ({ plan, moduleUrl }) => {
      const { JournalPullSync } = await import(moduleUrl)
      const acked = []
      const api = {
        getJournalSyncPlan: async () => ({ data: plan }),
        ackJournalSync: async (_inst, _world, results) => {
          acked.push(...results)
          return { data: { recorded: results.length } }
        },
      }
      await new JournalPullSync(api, 'inst-live-test').tick()
      return { acked }
    },
    { plan, moduleUrl: MODULE_URL },
  )
}

/**
 * Read the live entry as a player/GM would see it. Kept separate from runTick because the
 * concurrency cases need the SAME reader before and after a tick.
 */
async function snapshot(page) {
  return page.evaluate(
    ({ entryId, sourceId }) => {
      // Flags RAW, never via getFlag: Foundry validates the scope against active module ids
      // (common/abstract/document.mjs:952-954) and ours is `playtable` while the module id is
      // `crit-fumble-core` — getFlag THROWS. Writing via document data is unvalidated, which
      // is why the sync works at all.
      const sourceOf = (j) => j.flags?.playtable?.sourceJournalEntryId
      const doc = game.journal.get(entryId)
      const sourceCount = game.journal.filter((j) => sourceOf(j) === sourceId).length
      if (!doc) return { found: false, pageIds: [], pageNames: [], text: {}, pageModified: {}, sourceCount }
      const pages = [...doc.pages]
      return {
        found: true,
        name: doc.name,
        ownership: foundry.utils.deepClone(doc.ownership),
        entryModified: doc._stats?.modifiedTime ?? null,
        pageIds: pages.map((p) => p.id).sort(),
        pageNames: pages.map((p) => p.name).sort(),
        text: Object.fromEntries(pages.map((p) => [p.id, p.text?.content ?? ''])),
        pageModified: Object.fromEntries(pages.map((p) => [p.id, p._stats?.modifiedTime ?? null])),
        sourceCount,
      }
    },
    { entryId: ENTRY_ID, sourceId: SOURCE_ID },
  )
}

/** What a GM does through the sheet's "+ Page": a RANDOM id, exactly like the UI mints. */
async function gmAddsPage(page, name, content) {
  return page.evaluate(
    async ({ entryId, name, content }) => {
      const [created] = await game.journal.get(entryId).createEmbeddedDocuments('JournalEntryPage', [
        { name, type: 'text', title: { show: false, level: 1 }, sort: 100, text: { format: 1, content } },
      ])
      return created.id
    },
    { entryId: ENTRY_ID, name, content },
  )
}

/** What a GM does by typing in a page and closing the sheet. */
async function gmEditsPageText(page, pageId, content) {
  await page.evaluate(
    async ({ entryId, pageId, content }) => {
      await game.journal.get(entryId).pages.get(pageId).update({ 'text.content': content })
    },
    { entryId: ENTRY_ID, pageId, content },
  )
}

/** What a GM does in the Ownership dialog — e.g. sharing the entry with the whole table. */
async function gmSetsOwnership(page, ownership) {
  await page.evaluate(
    async ({ entryId, ownership }) => {
      await game.journal.get(entryId).update({ ownership })
    },
    { entryId: ENTRY_ID, ownership },
  )
}

async function cleanup(page) {
  // By id AND by source flag: an entry that ever landed under a random id would otherwise
  // survive and poison `sourceCount` in a later test.
  await page.evaluate(
    async ({ entryId, sourceId }) => {
      const doomed = game.journal.filter((j) => j.id === entryId || j.flags?.playtable?.sourceJournalEntryId === sourceId)
      for (const j of doomed) await j.delete()
    },
    { entryId: ENTRY_ID, sourceId: SOURCE_ID },
  )
}

test.describe('Journal pull-sync vs concurrent world edits (cs#417 H3)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore && game?.ready, { timeout: 30_000 })
    await cleanup(page) // a prior failed run must not poison this one
  })

  test.afterEach(async ({ page }) => {
    await cleanup(page)
  })

  // ── (i) PAGES ────────────────────────────────────────────────────────────────────

  test('CONTROL: a page the PLATFORM removed is still deleted', async ({ page }) => {
    // The case the deletion exists for, and the one a "stop deleting embedded docs" fix
    // would silently break. PAGE_B is in the baseline and NOT in the desired doc, so its
    // absence is a real platform removal — named both ways so this keeps passing whichever
    // shape rec 2 lands on.
    const bothPages = [textPage(PAGE_A, 'Overview', PLATFORM_TEXT), textPage(PAGE_B, 'Secrets', '<p>Shh.</p>', 1)]
    const withBoth = planItem({ docData: { pages: bothPages } })

    await runTick(page, [withBoth])
    expect((await snapshot(page)).pageIds).toEqual([PAGE_A, PAGE_B].sort())

    await runTick(page, [
      alreadyPushed(planItem(), { lastPushedData: withBoth.docData, removedEmbedded: { pages: [PAGE_B] } }),
    ])

    const after = await snapshot(page)
    // A parent update MERGES embedded collections by _id and never removes, so this can
    // only pass because pages are reconciled explicitly.
    expect(after.pageIds).toEqual([PAGE_A])
    expect(after.sourceCount).toBe(1)
  })

  // cs#417 · REGRESSION GUARD. This FAILED until rec 2 (server-named removals) landed on
  // 2026-09-15 — a page the GM added was deleted for being absent from the platform array.
  // It passes now, and goes red again if a delete is ever inferred rather than named.
  // ⚠️ The two repros BELOW are still marked: they are UPDATE overwrites, which rec 2 does
  // not touch. They need rec 1 (child clock check) and rec 3 (ownership create-only).
  test('a page the GM ADDED in Foundry survives the next tick', async ({ page }) => {
    await runTick(page, [planItem()])

    // PRECONDITION, not the bug: `tick()` returns silently when this page is not the
    // elected reporter, so without this the adopt could no-op and everything below would
    // be measuring an empty world.
    const seeded = await snapshot(page)
    expect(seeded.found).toBe(true)
    expect(seeded.pageIds).toEqual([PAGE_A])

    // The GM adds session notes mid-game. The platform has never heard of this page, so
    // its id is in the live world and not in `docData.pages` — byte-identical, from the
    // courier's side, to a page the platform deleted.
    const gmPageId = await gmAddsPage(page, GM_PAGE_NAME, '<p>Rolled a 1 on the door.</p>')
    const withNotes = await snapshot(page)
    expect(withNotes.pageIds).toContain(gmPageId)
    expect(withNotes.pageNames).toContain(GM_PAGE_NAME)

    // Now the platform pushes something unrelated — a rename. The baseline proves the
    // platform never had this page, so nothing in this plan asked for its removal.
    await runTick(page, [alreadyPushed(planItem({ docData: { name: 'The Drained Library' } }))])

    const after = await snapshot(page)
    // PRECONDITION AGAIN — deliberately above the marker, doing double duty: it proves the
    // second tick really ran, and it is the guard against a bad fix, because protecting the
    // GM's page by dropping the whole update is not a fix.
    expect(after.name).toBe('The Drained Library')
    // THE OUTCOME A PLAYER CARES ABOUT: the notes are still there.
    expect(after.pageIds).toContain(gmPageId)
    expect(after.pageNames).toContain(GM_PAGE_NAME)
  })

  test('CONTROL: a genuine platform text change still lands on an untouched page', async ({ page }) => {
    // The other half of the pair: if the fix skips on ANY divergence, the platform loses
    // the ability to edit its own journal. Nobody edited this page in the world, and the
    // platform changed it after we last wrote it.
    await runTick(page, [planItem()])
    const seeded = await snapshot(page)
    // `snapshot()` coerces a missing clock to null, and `null + 1000` is a perfectly usable
    // 1000 — so without this the case could silently stop being "the platform edited after
    // our last write" and start being "the platform edited in 1970".
    expect(typeof seeded.pageModified[PAGE_A]).toBe('number')

    await runTick(page, [
      alreadyPushed(planItem({ docData: { pages: [textPage(PAGE_A, 'Overview', PLATFORM_TEXT_NEWER)] } }), {
        platformChangedAt: seeded.pageModified[PAGE_A] + 1000, // the platform edited AFTER our last write
      }),
    ])

    expect((await snapshot(page)).text[PAGE_A]).toBe(PLATFORM_TEXT_NEWER)
  })

  // cs#417 · EXPECTED TO FAIL until rec 1 (skip when the child is newer than
  // platformChangedAt) lands. When it does, DELETE the `test.fail()` line ABOVE THE FINAL
  // BLOCK of this body — nothing else here changes.
  test('a page text the GM EDITED in Foundry survives a tick carrying older text', async ({ page }) => {
    await runTick(page, [planItem()])

    // PRECONDITIONS, not the bug: the adopt landed (`tick()` returns silently when this
    // page is not the elected reporter), and the clock the whole case turns on is real —
    // `snapshot()` coerces a missing one to null, which would make `platformChangedAt` a
    // baseline of 1970 that every later edit trivially beats.
    const seeded = await snapshot(page)
    expect(seeded.found).toBe(true)
    expect(typeof seeded.pageModified[PAGE_A]).toBe('number')
    expect(seeded.text[PAGE_A]).toBe(PLATFORM_TEXT)
    const platformChangedAt = seeded.pageModified[PAGE_A] // when the platform last wrote it

    // The GM retypes the page during the session. The platform's copy is now STALE — and
    // the platform has not changed since, so `platformChangedAt` stays put.
    await gmEditsPageText(page, PAGE_A, GM_TEXT)
    expect((await snapshot(page)).text[PAGE_A]).toBe(GM_TEXT)

    // A push of something else (a rename) drags the stale page text along with it, because
    // the whole materialized doc is pushed every time.
    await runTick(page, [
      alreadyPushed(planItem({ docData: { name: 'The Drained Library' } }), { platformChangedAt }),
    ])

    const after = await snapshot(page)
    // PRECONDITION AGAIN, above the marker: the second tick really ran, and a fix that
    // spares the GM's text by dropping the whole update is not a fix.
    expect(after.name).toBe('The Drained Library')

    test.fail()
    // THE OUTCOME A PLAYER CARES ABOUT: what the GM typed is what the page says.
    expect(after.text[PAGE_A]).toBe(GM_TEXT)
  })

  test('a page edit does NOT bump the PARENT entry modifiedTime — rec 1 must read the child', async ({ page }) => {
    // The Foundry contract rec 1 rests on, and the reason "compare the entry's
    // _stats.modifiedTime" is not a shortcut: a child edit leaves the parent's stamp
    // untouched, so a parent-level comparison would wave every page overwrite through.
    // This is also the feasibility check — rec 1 is only implementable if an embedded
    // JournalEntryPage carries a usable `_stats.modifiedTime` at all.
    // Already covered live from the PUSH side, on the same Foundry contract, by
    // `world-journal-snapshot.spec.js:85` ("a PAGE edit advances only the PAGE clock") —
    // cs#186's `worldEditWinsDeep`. Kept here because rec 1 reads the clock on the PULL
    // side, and a spec that would go green if the contract flipped is worth its few lines.
    await runTick(page, [planItem()])
    const before = await snapshot(page)
    expect(typeof before.pageModified[PAGE_A]).toBe('number')
    expect(typeof before.entryModified).toBe('number')

    // KEPT DELIBERATELY: the assertion below is strictly-greater on a ms-resolution clock.
    // The two round trips in between probably already clear a millisecond — "probably" is
    // the problem, and a flaky clock test reads as a broken contract. 50ms, once.
    await page.waitForTimeout(50)
    await gmEditsPageText(page, PAGE_A, GM_TEXT)

    const after = await snapshot(page)
    expect(after.pageModified[PAGE_A]).toBeGreaterThan(before.pageModified[PAGE_A])
    expect(after.entryModified).toBe(before.entryModified)
  })

  // ── (ii) OWNERSHIP ───────────────────────────────────────────────────────────────

  // NEITHER case here carries `platformChangedAt` — ownership is not clock-compared. See
  // `alreadyPushed`: absent must read as "no baseline, APPLY", never as "skip".

  // cs#417 · REGRESSION GUARD. This FAILED until rec 3 landed on 2026-09-16: core rebuilt
  // `ownership` from the `visibility` column on EVERY push, so any write — a rename, a page
  // edit — re-asserted the platform's permission map over the GM's. Not a race; it reverted
  // every time. Core now PRUNES ownership/sort/folder from a push whose baseline already
  // agrees on them, which is why `renamed` below carries four keys and not seven.
  test('a permission the GM set in Foundry survives a platform push of something else', async ({ page }) => {
    await runTick(page, [planItem()]) // adopt-time ownership: GM-only

    // PRECONDITION, not the bug: `tick()` returns silently when this page is not the
    // elected reporter, and an absent entry reports `ownership: undefined`, which would
    // then "fail" the last assertion for a reason that has nothing to do with cs#417.
    const seeded = await snapshot(page)
    expect(seeded.found).toBe(true)
    expect(seeded.ownership).toMatchObject({ default: 0 })

    // The GM shares the entry with the table mid-session.
    await gmSetsOwnership(page, { default: 2 })
    expect((await snapshot(page)).ownership).toMatchObject({ default: 2 })

    // The platform pushes a RENAME — in the shape core ACTUALLY sends since rec 3. The
    // materializer still rebuilds the full doc (it is the comparand for change detection),
    // but `buildJournalSyncPlan` then PRUNES any of ownership/sort/folder the baseline
    // already agrees on, and `visibility` has not changed. So the module is handed four
    // keys, and the fields it is not given are fields it cannot revert — Foundry merges.
    // The pruning itself is pinned core-side in
    // cfg-core-server tests/unit/services/foundry/journal-sync-plan.test.ts; what this
    // asserts is the OUTCOME at the table.
    const renamed = alreadyPushed(planItem({ docData: { name: 'The Drained Library' } }))
    for (const field of ['ownership', 'sort', 'folder']) delete renamed.docData[field]
    await runTick(page, [renamed])

    const after = await snapshot(page)
    // The second tick really ran — a fix that spared the GM's permission by dropping the
    // whole update would not be a fix, and this is what tells the two apart.
    expect(after.name).toBe('The Drained Library')

    // THE OUTCOME A PLAYER CARES ABOUT: they can still read the entry.
    expect(after.ownership).toMatchObject({ default: 2 })
  })

  test('CONTROL: a platform visibility change still propagates — grant AND revoke', async ({ page }) => {
    // The reason ownership is pushed at all. `visibility` is the platform's read authority
    // (cs:journal-doc.ts:182-200), and journal-sync-plan.ts is explicit that a REVOKE must
    // reach the world — so "make ownership create-only" would fix the repro above by
    // reintroducing the bug that comment exists to prevent. Both directions, cheaply.
    await runTick(page, [planItem()])
    const granted = planItem({ docData: { ownership: { default: 2 } } })

    await runTick(page, [alreadyPushed(granted, { lastPushedData: planItem().docData })])
    expect((await snapshot(page)).ownership).toMatchObject({ default: 2 })

    await runTick(page, [alreadyPushed(planItem(), { lastPushedData: granted.docData })])
    expect((await snapshot(page)).ownership).toMatchObject({ default: 0 })
  })
})
