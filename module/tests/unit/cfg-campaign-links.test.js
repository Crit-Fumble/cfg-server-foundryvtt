/**
 * Linked Campaigns dialog — what a failed campaigns load tells the GM.
 *
 * The dialog is where a rights 403 used to end as a bare "HTTP 403". With a
 * rights code the server has written the explanation FOR the user (which
 * right is missing, and never "re-pair"), so the dialog relays it; every
 * other failure keeps the status-only wording. The bodies below are verbatim
 * what cfg-core-server sends — file named on each — same as the fetchCfg
 * fixtures in connection-state.test.js.
 */

import { jest } from '@jest/globals'

async function loadDialog() {
  jest.resetModules()
  return await import('../../scripts/views/cfg-campaign-links.js')
}

function settingsStore(initial = {}) {
  const map = new Map(Object.entries(initial))
  game.settings.get = jest.fn((_mod, key) => map.get(key))
  game.settings.set = jest.fn(async (_mod, key, value) => {
    map.set(key, value)
  })
  return map
}

function respond(status, text) {
  globalThis.fetch = jest.fn(async () => ({ ok: status < 300, status, text: async () => text, json: async () => JSON.parse(text) }))
}

describe('CfgCampaignLinksDialog — _loadData failure copy', () => {
  beforeEach(() => {
    settingsStore({ coreApiUrl: 'https://cfg.test', apiKey: 'cfk_secret', installationId: 'inst_1' })
    globalThis.window = globalThis.window || {}
    globalThis.window.location = { origin: 'https://foundry.local' }
    game.user.isGM = true
  })

  it('relays the server explanation on a 403 INSTALLATION_OWNER_REQUIRED — not "HTTP 403", not a re-pair', async () => {
    // cfg-core-server src/routes/v1/account/foundry-installed-modules.ts (+ foundry-system-schema.ts twin)
    respond(
      403,
      '{"error":"Installation-level sync is owner-only — this key is bound to an installation you do not own","code":"INSTALLATION_OWNER_REQUIRED"}',
    )
    const { CfgCampaignLinksDialog } = await loadDialog()
    const dialog = new CfgCampaignLinksDialog()
    await dialog._loadData()

    expect(dialog.errorMessage).toBe(
      "Couldn't load campaigns: Installation-level sync is owner-only — this key is bound to an installation you do not own",
    )
    expect(dialog.errorMessage).not.toMatch(/HTTP 403|re-pair|regenerate/i)
    expect(dialog.campaigns).toEqual([])
    expect(dialog.loading).toBe(false)
  })

  it('relays the server explanation on a 403 SCOPE_REQUIRED', async () => {
    // cfg-core-server src/routes/v1/_lib/auth.ts, requireScope / requireScopeIfApiKey
    respond(403, '{"error":"Scope required: foundry:write","code":"SCOPE_REQUIRED","scope":"foundry:write"}')
    const { CfgCampaignLinksDialog } = await loadDialog()
    const dialog = new CfgCampaignLinksDialog()
    await dialog._loadData()

    expect(dialog.errorMessage).toBe("Couldn't load campaigns: Scope required: foundry:write")
  })

  it('keeps "HTTP 403" for a 403 with code FORBIDDEN — the unbound-key case where re-pairing IS the answer', async () => {
    // cfg-core-server src/routes/v1/account/foundry-installed-modules.ts, key bound to no installation
    respond(403, '{"error":"API key is not bound to a Foundry installation — re-pair the plugin","code":"FORBIDDEN"}')
    const { CfgCampaignLinksDialog } = await loadDialog()
    const dialog = new CfgCampaignLinksDialog()
    await dialog._loadData()

    expect(dialog.errorMessage).toBe("Couldn't load campaigns: HTTP 403")
  })

  it('keeps the status-only wording for a 401 and a 5xx', async () => {
    const { CfgCampaignLinksDialog } = await loadDialog()

    respond(401, '{"error":"Invalid API key"}')
    let dialog = new CfgCampaignLinksDialog()
    await dialog._loadData()
    expect(dialog.errorMessage).toBe("Couldn't load campaigns: HTTP 401")

    respond(503, 'Service Unavailable')
    dialog = new CfgCampaignLinksDialog()
    await dialog._loadData()
    expect(dialog.errorMessage).toBe("Couldn't load campaigns: HTTP 503")
  })

  it('names the reason when there is no status at all (offline)', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError('NetworkError when attempting to fetch resource.')
    })
    const { CfgCampaignLinksDialog } = await loadDialog()
    const dialog = new CfgCampaignLinksDialog()
    await dialog._loadData()

    expect(dialog.errorMessage).toBe("Couldn't load campaigns: offline")
  })

  it('loads the campaign list on a 2xx', async () => {
    respond(200, '{"data":[{"id":"c1","name":"Tomb"}]}')
    const { CfgCampaignLinksDialog } = await loadDialog()
    const dialog = new CfgCampaignLinksDialog()
    await dialog._loadData()

    expect(dialog.errorMessage).toBeNull()
    expect(dialog.campaigns).toEqual([{ id: 'c1', name: 'Tomb' }])
    expect(dialog.installationId).toBe('inst_1')
  })
})

/**
 * The SAVE path — what a failed link update tells the GM.
 *
 * `_loadData` above was taught to relay a rights 403's server-written
 * explanation; saving was not, and reported only a count. A GM whose key lacks
 * the right then saw "1 of 1 updates failed" and went looking at the
 * credential — the one thing that cannot fix a missing right. These pin the two
 * halves of the rule: relay the explanation when the server wrote one, keep the
 * count-only wording when it did not.
 */
describe('CfgCampaignLinksDialog — _handleSave failure copy', () => {
  // A checkbox the diff will read as an ADDITION (was unchecked, now checked).
  function addedBox(campaignId = 'c1') {
    return { checked: true, dataset: { campaignId, initialChecked: 'false' } }
  }

  // `element` is a getter on the ApplicationV2 base, so it has to be shadowed
  // with an own property rather than assigned.
  function stage(Dialog, boxes) {
    const dialog = new Dialog()
    dialog.installationId = 'inst_1'
    Object.defineProperty(dialog, 'element', { value: { querySelectorAll: () => boxes }, configurable: true })
    dialog.render = jest.fn(async () => {})
    return dialog
  }

  const button = () => ({ disabled: false, style: {} })

  beforeEach(() => {
    settingsStore({ coreApiUrl: 'https://cfg.test', apiKey: 'cfk_secret', installationId: 'inst_1' })
    globalThis.window = globalThis.window || {}
    globalThis.window.location = { origin: 'https://foundry.local' }
    game.user.isGM = true
    ui.notifications.warn.mockClear()
    ui.notifications.info.mockClear()
  })

  it('relays the server explanation on a rights 403 — not the failure count alone', async () => {
    // Verbatim what the link route answers when the key lacks the scope.
    respond(403, '{"error":"Scope required: foundry:write","code":"SCOPE_REQUIRED","scope":"foundry:write"}')
    const { CfgCampaignLinksDialog } = await loadDialog()
    const dialog = stage(CfgCampaignLinksDialog, [addedBox()])

    await dialog._handleSave(button())

    expect(ui.notifications.warn).toHaveBeenCalledTimes(1)
    const [message] = ui.notifications.warn.mock.calls[0]
    expect(message).toContain('1 of 1 updates failed')
    expect(message).toContain('Scope required: foundry:write')
    expect(message).not.toMatch(/re-pair|regenerate/i)
  })

  it('relays an ownership explanation the same way', async () => {
    // Verbatim what an installation-scoped route answers a key whose owner is not the owner.
    const body =
      '{"error":"Installation-level sync is owner-only — this key is bound to an installation you do not own","code":"INSTALLATION_OWNER_REQUIRED"}'
    respond(403, body)
    const { CfgCampaignLinksDialog } = await loadDialog()
    const dialog = stage(CfgCampaignLinksDialog, [addedBox()])

    await dialog._handleSave(button())

    const [message] = ui.notifications.warn.mock.calls[0]
    expect(message).toContain('Installation-level sync is owner-only')
  })

  it('keeps the count-only wording for a 403 with no rights code', async () => {
    // A 403 with no rights code — the unbound-key case, where re-pairing IS the answer.
    respond(403, '{"error":"API key is not bound to a Foundry installation — re-pair the plugin","code":"FORBIDDEN"}')
    const { CfgCampaignLinksDialog } = await loadDialog()
    const dialog = stage(CfgCampaignLinksDialog, [addedBox()])

    await dialog._handleSave(button())

    expect(ui.notifications.warn).toHaveBeenCalledWith('1 of 1 updates failed; some links may not have saved.')
  })

  it('reports success without a warning when every update lands', async () => {
    respond(200, '{"data":{"id":"link_1"}}')
    const { CfgCampaignLinksDialog } = await loadDialog()
    const dialog = stage(CfgCampaignLinksDialog, [addedBox()])

    await dialog._handleSave(button())

    expect(ui.notifications.warn).not.toHaveBeenCalled()
    expect(ui.notifications.info).toHaveBeenCalledWith('Updated 1 link.')
  })
})
