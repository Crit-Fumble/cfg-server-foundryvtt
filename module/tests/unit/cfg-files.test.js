/**
 * services/cfg-files.js — the file picker's Personal and Old files sources (cs#869).
 */

import { jest } from '@jest/globals'
import {
  installFileSources,
  OLD_SOURCE,
  PERSONAL_SOURCE,
  sourcesFor,
  loadFileList,
} from '../../scripts/services/cfg-files.js'

const LIST_URL = '/game/cfg-files.json'
const link = (path) => `https://usercdn.example/f/user/Servers/s/${path}?s=sig`

const fixture = {
  version: 1,
  folder: 'Servers/s',
  generatedAt: '2026-11-17T16:00:00.000Z',
  files: [
    { path: 'maps/day.webp', sizeBytes: 10, link: link('maps/day.webp') },
    { path: 'maps/night.webp', sizeBytes: 11, link: link('maps/night.webp') },
    { path: 'maps/dungeon/level1.png', sizeBytes: 12, link: link('maps/dungeon/level1.png') },
    { path: 'theme.mp3', sizeBytes: 13, link: link('theme.mp3') },
  ],
  oldFiles: [],
  truncated: false,
}

const respond = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

/**
 * A stand-in for Foundry's picker class: stock Data browsing, upload and render, and tabs
 * drawn from the static `TABS.sources.tabs` then dropped when `sources` has no entry for them.
 */
function makePicker() {
  class FakePicker {
    static TABS = {
      sources: {
        tabs: [
          {
            id: 'data',
            group: 'sources',
            icon: 'fa-solid fa-file',
            label: 'FILES.TABS.data',
          },
          {
            id: 'public',
            group: 'sources',
            icon: 'fa-solid fa-file',
            label: 'FILES.TABS.public',
          },
          {
            id: 's3',
            group: 'sources',
            icon: 'fa-solid fa-cloud',
            label: 'FILES.TABS.s3',
          },
        ],
        initial: 'data',
      },
    }
    static browse = jest.fn(async () => ({
      target: 'data',
      dirs: [],
      files: ['stock.png'],
    }))
    static upload = jest.fn(async () => ({ path: 'uploaded' }))
    static createDirectory = jest.fn(async () => true)
    sources = { data: { target: '', label: 'Data' } }
    activeSource = 'data'
    pickedFiles = []

    _prepareTabs(group) {
      const tabs = {}
      for (const tab of this.constructor.TABS[group].tabs) {
        if (tab.id in this.sources) tabs[tab.id] = { ...tab }
      }
      return tabs
    }

    /**
     * As Foundry names a file: the last segment of its path, query string and all. The form's
     * Upload row is drawn from `canUpload`.
     */
    async _prepareContext() {
      const result = await this.constructor.browse('cfg-personal', 'maps', {})
      return {
        canUpload: true,
        files: result.files.map((url) => ({
          name: url.split('/').pop(),
          url,
          img: url,
        })),
      }
    }
  }
  FakePicker.prototype.render = jest.fn(async function () {
    return this
  })
  return FakePicker
}

describe('cfg-files — the picker sources', () => {
  beforeEach(() => {
    foundry.utils.getRoute = jest.fn((path) => `/game/${path}`)
    globalThis.fetch = jest.fn(async () => respond(fixture))
    globalThis.ui.notifications.info.mockClear()
    globalThis.ui.notifications.warn.mockClear()
  })

  it('Personal lists the list by folder, and a picked file is its link', async () => {
    const FP = makePicker()
    installFileSources(FP)

    const root = await FP.browse(PERSONAL_SOURCE, '', {})
    expect(root.dirs).toEqual(['maps'])
    expect(root.files).toEqual([link('theme.mp3')])

    const maps = await FP.browse(PERSONAL_SOURCE, 'maps', {})
    expect(maps.dirs).toEqual(['maps/dungeon'])
    expect(maps.files).toEqual([link('maps/day.webp'), link('maps/night.webp')])

    const dungeon = await FP.browse(PERSONAL_SOURCE, 'maps/dungeon', {})
    expect(dungeon.dirs).toEqual([])
    // The picker hands a picked entry to the document as the chosen path: it is the link.
    expect(dungeon.files).toEqual([link('maps/dungeon/level1.png')])
  })

  it("filters by the picker's extensions", async () => {
    const FP = makePicker()
    installFileSources(FP)
    const audio = await FP.browse(PERSONAL_SOURCE, '', { extensions: ['.mp3', '.ogg'] })
    expect(audio.files).toEqual([link('theme.mp3')])
    const images = await FP.browse(PERSONAL_SOURCE, 'maps', { extensions: ['.PNG'] })
    expect(images.files).toEqual([])
  })

  it('Old files browses oldFiles, and is a source only when it has entries', async () => {
    const FP = makePicker()
    installFileSources(FP)

    const hidden = await new FP().render(true)
    expect(Object.keys(hidden.sources)).toEqual(['data', PERSONAL_SOURCE])

    const oldLink = 'https://usercdn.example/old/portrait.png'
    globalThis.fetch = jest.fn(async () =>
      respond({ ...fixture, oldFiles: [{ path: 'portrait.png', sizeBytes: 5, link: oldLink }] }),
    )
    const shown = await new FP().render(true)
    expect(Object.keys(shown.sources)).toEqual(['data', PERSONAL_SOURCE, OLD_SOURCE])
    expect(shown.sources[OLD_SOURCE].label).toBe('Old files')

    const old = await FP.browse(OLD_SOURCE, '', {})
    expect(old.files).toEqual([oldLink])
    // Personal does not show them.
    expect((await FP.browse(PERSONAL_SOURCE, '', {})).files).toEqual([link('theme.mp3')])
  })

  it("each source has its own tab, drawn from the picker's static TABS, with its label", async () => {
    const FP = makePicker()
    installFileSources(FP)

    const personal = await new FP().render(true)
    const tabs = personal._prepareTabs('sources')
    expect(Object.keys(tabs)).toEqual(['data', PERSONAL_SOURCE])
    expect(tabs[PERSONAL_SOURCE]).toMatchObject({
      id: PERSONAL_SOURCE,
      group: 'sources',
      label: 'Personal',
    })

    globalThis.fetch = jest.fn(async () =>
      respond({
        ...fixture,
        oldFiles: [
          {
            path: 'portrait.png',
            sizeBytes: 5,
            link: 'https://usercdn.example/old/p.png',
          },
        ],
      }),
    )
    const both = (await new FP().render(true))._prepareTabs('sources')
    expect(Object.keys(both)).toEqual(['data', PERSONAL_SOURCE, OLD_SOURCE])
    expect(both[OLD_SOURCE].label).toBe('Old files')

    // Installing again adds no second tab.
    installFileSources(FP)
    expect(FP.TABS.sources.tabs.filter((tab) => tab.id === PERSONAL_SOURCE)).toHaveLength(1)
  })

  it('the picker shows a clean file name while a pick stays the signed link', async () => {
    const FP = makePicker()
    installFileSources(FP)

    const { files } = await new FP()._prepareContext()
    expect(files.map((f) => f.name)).toEqual(['day.webp', 'night.webp'])
    // The value a pick hands to the document, and the preview, are still the link.
    expect(files.map((f) => f.url)).toEqual([link('maps/day.webp'), link('maps/night.webp')])
    expect(files.map((f) => f.img)).toEqual([link('maps/day.webp'), link('maps/night.webp')])
  })

  it('the Upload row is offered for Data and not while Personal or Old files is open', async () => {
    const FP = makePicker()
    installFileSources(FP)

    const picker = new FP()
    expect((await picker._prepareContext()).canUpload).toBe(true)
    for (const source of [PERSONAL_SOURCE, OLD_SOURCE]) {
      picker.activeSource = source
      expect((await picker._prepareContext()).canUpload).toBe(false)
    }
    // Back on Data, the stock offer returns.
    picker.activeSource = 'data'
    expect((await picker._prepareContext()).canUpload).toBe(true)
  })

  it('a stock file keeps the name the picker gave it', async () => {
    const FP = makePicker()
    FP.prototype._prepareContext = async () => ({
      files: [{ name: 'a.png', url: 'worlds/w/a.png' }],
    })
    installFileSources(FP)
    expect((await new FP()._prepareContext()).files).toEqual([{ name: 'a.png', url: 'worlds/w/a.png' }])
  })

  it('sourcesFor leaves Old files out of an empty oldFiles', () => {
    expect(Object.keys(sourcesFor({ files: [], oldFiles: [] }))).toEqual([PERSONAL_SOURCE])
  })

  it('a 404 shows empty sources with one short line, not one per browse', async () => {
    globalThis.fetch = jest.fn(async () => respond({}, 404))
    const FP = makePicker()
    installFileSources(FP)

    for (const source of [PERSONAL_SOURCE, OLD_SOURCE, PERSONAL_SOURCE]) {
      const result = await FP.browse(source, '', {})
      expect(result.dirs).toEqual([])
      expect(result.files).toEqual([])
    }
    expect(ui.notifications.info).toHaveBeenCalledTimes(1)
    expect(ui.notifications.info).toHaveBeenCalledWith(expect.stringMatching(/not available/))
    // Personal is still a source to open; Old files is not.
    expect(Object.keys((await new FP().render(true)).sources)).toEqual(['data', PERSONAL_SOURCE])
  })

  it('an unknown version or a fetch error is the same empty list', async () => {
    globalThis.fetch = jest.fn(async () => respond({ ...fixture, version: 2 }))
    expect(await loadFileList()).toEqual({ available: false, files: [], oldFiles: [] })
    globalThis.fetch = jest.fn(async () => {
      throw new Error('network down')
    })
    expect(await loadFileList()).toEqual({ available: false, files: [], oldFiles: [] })
  })

  it('the only request is the same-origin list', async () => {
    const FP = makePicker()
    installFileSources(FP)
    await new FP().render(true)
    await FP.browse(PERSONAL_SOURCE, 'maps', {})
    await FP.browse('data', 'worlds', {})

    expect(fetch).toHaveBeenCalled()
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe(LIST_URL)
      expect(init.credentials).toBe('same-origin')
      expect(init.headers).toBeUndefined()
    }
  })

  it('stock sources browse, upload and render as before', async () => {
    const FP = makePicker()
    const stock = { browse: FP.browse, upload: FP.upload, createDirectory: FP.createDirectory }
    installFileSources(FP)

    expect(await FP.browse('data', 'worlds', { extensions: ['.png'] })).toEqual({
      target: 'data',
      dirs: [],
      files: ['stock.png'],
    })
    expect(stock.browse).toHaveBeenCalledWith('data', 'worlds', { extensions: ['.png'] })
    await FP.upload('data', 'worlds/w', 'file', {}, {})
    expect(stock.upload).toHaveBeenCalledWith('data', 'worlds/w', 'file', {}, {})
    await FP.createDirectory('data', 'worlds/w/new', {})
    expect(stock.createDirectory).toHaveBeenCalledWith('data', 'worlds/w/new', {})
    expect(fetch).not.toHaveBeenCalled()
  })

  it('neither source takes an upload or a new folder', async () => {
    const FP = makePicker()
    const stock = { upload: FP.upload, createDirectory: FP.createDirectory }
    installFileSources(FP)

    for (const source of [PERSONAL_SOURCE, OLD_SOURCE]) {
      expect(await FP.upload(source, 'maps', 'file', {}, {})).toBeNull()
      expect(await FP.createDirectory(source, 'maps/new', {})).toBeNull()
    }
    expect(stock.upload).not.toHaveBeenCalled()
    expect(stock.createDirectory).not.toHaveBeenCalled()
    expect(ui.notifications.warn).toHaveBeenCalledTimes(4)
  })
})
