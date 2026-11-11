/**
 * CFGCore module contract — what a member's page exposes: the running version, and
 * no platform client or credential (cs#543). Retired settings stay retired.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const MODULE_ID = 'crit-fumble-core'

test.describe('CFGCore module contract', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore, { timeout: 30_000 })
  })

  test('exposes the running version and no API client', async ({ page }) => {
    const c = await page.evaluate(() => ({ version: window.CFGCore.version, keys: Object.keys(window.CFGCore) }))
    expect(c.version).toBeTruthy()
    expect(c.keys).toEqual(['version'])
  })

  test('no platform setting is registered: no endpoint, no key, no installation id', async ({ page }) => {
    // Reading an unregistered setting throws. `campaignId` is the older retiree: linkage is
    // core's N:M world grants, never a per-world setting.
    const registered = await page.evaluate(([mod]) => {
      const out = {}
      for (const key of ['coreApiUrl', 'apiKey', 'installationId', 'campaignId']) {
        try {
          game.settings.get(mod, key)
          out[key] = true
        } catch {
          out[key] = false
        }
      }
      return out
    }, [MODULE_ID])
    expect(registered).toEqual({ coreApiUrl: false, apiKey: false, installationId: false, campaignId: false })
  })
})
