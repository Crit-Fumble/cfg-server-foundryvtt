import { test, expect, type Page } from '@playwright/test'
import { SERVICE_GM } from '../helpers/service-gm'
import { joinWorldAsUser } from '../helpers/foundry-admin'

/**
 * Licensed 5e content compatibility — the premium modules seeded from the
 * fixture license's own install (see run.sh "Licensed / extra modules")
 * genuinely work in the wrapper: installed on disk, activatable in the world,
 * compendium packs readable, and a real document's sheet renders. This is the
 * rung that proves content produced for this platform coexists with the data
 * models and sheets those modules register.
 *
 * ⛔ The content itself NEVER enters this repo — every path involved is
 * gitignored, and this spec names no product. The ids under test come from
 * E2E_LICENSED_MODULES (e2e/.env), so each machine verifies exactly the
 * licensed content its fixture install owns. Unset, the spec SKIPS: that run
 * proves nothing about licensed content (UNVERIFIED, not green).
 *
 * Enablement persists in .e2e-data on purpose: after the first run the world
 * boots with the licensed modules on, which is how a real campaign world runs
 * — the rest of the suite then exercises the wrapper under that load.
 */

const MODULE_IDS = (process.env.E2E_LICENSED_MODULES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** Same readiness bar joinWorldAsUser ends on — reused after the enable reload. */
async function waitForGameReady(page: Page): Promise<void> {
  await page.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => typeof (globalThis as any).game !== 'undefined' && (globalThis as any).game.ready === true && !!(globalThis as any).game.user,
    undefined,
    { timeout: 90_000 },
  )
}

test.describe('licensed modules', () => {
  test.skip(
    MODULE_IDS.length === 0,
    'E2E_LICENSED_MODULES unset — licensed-content compatibility UNVERIFIED on this run',
  )

  test('fixture-licensed modules install, activate, and their content renders', async ({ page }) => {
    // Index loads + one sheet render per module; budget beyond the global 120s.
    test.setTimeout(120_000 + MODULE_IDS.length * 30_000)

    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(String(err)))

    await joinWorldAsUser(page, SERVICE_GM.nativeUserId, SERVICE_GM.password)

    // 1. On disk — run.sh's seed actually landed every id we were told to test.
    const status = await page.evaluate(
      (ids) =>
        ids.map((id) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mod = (globalThis as any).game.modules.get(id)
          return { id, installed: !!mod, active: !!mod?.active }
        }),
      MODULE_IDS,
    )
    for (const m of status) {
      expect(m.installed, `'${m.id}' present in Data/modules — is it in the source install run.sh seeds from?`).toBe(true)
    }

    // 2. Activate any that aren't — one settings write, one reload. A module
    //    whose dependency is missing stays inactive; step 3 names it.
    const inactive = status.filter((m) => !m.active).map((m) => m.id)
    if (inactive.length > 0) {
      await page.evaluate(async (ids) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = (globalThis as any).game
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cfg = (globalThis as any).foundry.utils.deepClone(g.settings.get('core', 'moduleConfiguration'))
        for (const id of ids) cfg[id] = true
        await g.settings.set('core', 'moduleConfiguration', cfg)
      }, inactive)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForGameReady(page)
    }

    // 3. All active now.
    const active = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ids) => ids.filter((id) => !(globalThis as any).game.modules.get(id)?.active),
      MODULE_IDS,
    )
    expect(
      active,
      `modules that did not activate — a missing hard dependency? add it to E2E_LICENSED_MODULES: ${active.join(', ')}`,
    ).toEqual([])

    // 4. Content is real: for each module with packs, open its first Actor (or
    //    Item, or any) compendium, load the first document, render its sheet.
    //    Utility modules legitimately ship zero packs — asserted per-result.
    for (const id of MODULE_IDS) {
      const result = await page.evaluate(async (moduleId) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = (globalThis as any).game
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const packs = g.packs.filter((p: any) => p.metadata.packageName === moduleId)
        if (packs.length === 0) return { packCount: 0 }
        const byType = (name: string) => packs.find((p: { metadata: { type: string } }) => p.metadata.type === name)
        const pack = byType('Actor') ?? byType('Item') ?? packs[0]
        const index = await pack.getIndex()
        const first = index.contents?.[0] ?? [...index][0]
        if (!first) return { packCount: packs.length, packId: pack.metadata.id, error: 'pack index is empty' }
        const doc = await pack.getDocument(first._id)
        if (!doc) return { packCount: packs.length, packId: pack.metadata.id, error: `getDocument(${first._id}) returned nothing` }
        await doc.sheet.render(true)
        // Render settles async in both AppV1 and AppV2 — poll the flag.
        const start = Date.now()
        while (!doc.sheet.rendered && Date.now() - start < 15_000) {
          await new Promise((res) => setTimeout(res, 250))
        }
        const rendered = doc.sheet.rendered === true
        await doc.sheet.close().catch(() => {})
        return { packCount: packs.length, packId: pack.metadata.id, docName: doc.name, rendered }
      }, id)

      if (result.packCount === 0) continue // utility module — nothing to render
      expect(result.error, `'${id}' pack ${result.packId ?? ''}: ${result.error ?? ''}`).toBeUndefined()
      expect(result.rendered, `'${id}': sheet for '${result.docName}' (${result.packId}) rendered`).toBe(true)
    }

    // 5. Nothing threw along the way — an uncaught error during init or a
    //    sheet render is exactly the incompatibility this spec exists to catch.
    expect(pageErrors, `uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([])
  })
})
