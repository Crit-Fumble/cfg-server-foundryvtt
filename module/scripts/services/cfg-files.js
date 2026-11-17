/**
 * services/cfg-files.js — Foundry's file picker gets two read-only sources beside
 * stock Data (cs#869): Personal and Old files.
 *
 * Both read `cfg-files.json`, which the platform writes into this server's data on every
 * launch and which Foundry serves at the route prefix's root. It lists one folder of the
 * host's files. This page makes ONE request, to that same-origin file, and no platform
 * call (cs#543): everything a member installs runs in this page.
 *
 *   { version: 1, files: [{ path, sizeBytes, link }], oldFiles: [...], truncated }
 *
 * The picker browses folders made from each `path`'s segments. A picked file is its
 * `link`, so the document stores the link itself, while the picker shows the file's clean
 * name (`day.webp`, not `day.webp?s=<signature>`). Neither source takes an upload, and the
 * picker offers none while one of them is open.
 */

const LIST_ROUTE = 'cfg-files.json'
const LIST_VERSION = 1

export const PERSONAL_SOURCE = 'cfg-personal'
export const OLD_SOURCE = 'cfg-old'

const SOURCE_LABELS = {
  [PERSONAL_SOURCE]: { label: 'Personal', icon: 'fa-solid fa-user' },
  [OLD_SOURCE]: { label: 'Old files', icon: 'fa-solid fa-box-archive' },
}

const EMPTY_LINE = 'Personal files are not available on this server yet.'
const NO_UPLOAD_LINE = 'Personal and Old files are read-only. Upload into Data instead.'

export const isCfgSource = (source) => source === PERSONAL_SOURCE || source === OLD_SOURCE

const entriesOf = (value) =>
  Array.isArray(value) ? value.filter((e) => typeof e?.path === 'string' && e.path && typeof e?.link === 'string') : []

/**
 * Fetch the list. Never throws: a missing list (404), an unknown `version` or a fetch
 * error is an empty list with `available: false`.
 * @returns {Promise<{available: boolean, files: object[], oldFiles: object[]}>}
 */
export async function loadFileList() {
  try {
    const res = await fetch(foundry.utils.getRoute(LIST_ROUTE), { cache: 'no-store', credentials: 'same-origin' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const list = await res.json()
    if (list?.version !== LIST_VERSION) throw new Error(`unknown version ${list?.version}`)
    return { available: true, files: entriesOf(list.files), oldFiles: entriesOf(list.oldFiles) }
  } catch (err) {
    console.warn('CFG Core | no file list for the picker:', err?.message || err)
    return { available: false, files: [], oldFiles: [] }
  }
}

const trimSlashes = (path) => String(path ?? '').replace(/^\/+|\/+$/g, '')
const hasExtension = (name, extensions) => {
  if (!extensions?.length) return true
  const lower = name.toLowerCase()
  return extensions.some((ext) => lower.endsWith(String(ext).toLowerCase()))
}

/**
 * The result of browsing one folder of a list, in the shape Foundry's own browse returns:
 * `dirs` are full folder paths, and each of `files` is the file's link.
 */
export function browseEntries(entries, target = '', options = {}) {
  const folder = trimSlashes(target)
  const prefix = folder ? `${folder}/` : ''
  const dirs = new Set()
  const files = []
  for (const entry of entries) {
    const path = trimSlashes(entry.path)
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash > -1) dirs.add(prefix + rest.slice(0, slash))
    else if (rest && hasExtension(rest, options.extensions)) files.push({ name: rest, link: entry.link })
  }
  files.sort((a, b) => a.name.localeCompare(b.name))
  return {
    target: folder,
    dirs: [...dirs].sort((a, b) => a.localeCompare(b)),
    files: files.map((f) => f.link),
    gridSize: null,
    private: false,
    privateDirs: [],
    extensions: options.extensions ?? [],
  }
}

/**
 * The picker draws its tabs from the class's static `TABS.sources.tabs` (filtered in its
 * `_prepareTabs`), not from its `sources`, so each source needs its own tab and label.
 */
function addSourceTabs(FP) {
  const tabs = FP.TABS?.sources?.tabs
  if (!Array.isArray(tabs)) return
  for (const id of [PERSONAL_SOURCE, OLD_SOURCE]) {
    if (tabs.some((tab) => tab.id === id)) continue
    const { label, icon } = SOURCE_LABELS[id]
    tabs.push({ id, group: 'sources', icon, label })
  }
}

/** The picker's source entries for a list: Personal always, Old files only when it has some. */
export function sourcesFor(list) {
  const sources = { [PERSONAL_SOURCE]: { target: '', ...SOURCE_LABELS[PERSONAL_SOURCE] } }
  if (list.oldFiles.length) sources[OLD_SOURCE] = { target: '', ...SOURCE_LABELS[OLD_SOURCE] }
  return sources
}

/**
 * Add the sources to the picker class: each has a tab, browsing them reads the list,
 * uploading into them is refused (and not offered), and an opened picker lists them.
 * Everything else in the picker stays stock.
 * @param {typeof FilePicker} FP
 */
export function installFileSources(FP) {
  const browse = FP.browse.bind(FP)
  const upload = FP.upload?.bind(FP)
  const createDirectory = FP.createDirectory?.bind(FP)
  const render = FP.prototype.render
  const prepareContext = FP.prototype._prepareContext
  const names = new Map() // link -> the file's clean name, for what the picker shows
  let toldEmpty = false

  addSourceTabs(FP)

  FP.browse = async function (source, target, options = {}) {
    if (!isCfgSource(source)) return browse(source, target, options)
    const list = await loadFileList()
    if (!list.available && !toldEmpty) {
      toldEmpty = true
      ui.notifications?.info(EMPTY_LINE)
    }
    if (list.available) toldEmpty = false
    const entries = source === OLD_SOURCE ? list.oldFiles : list.files
    for (const { path, link } of entries) names.set(link, path.split('/').pop())
    return browseEntries(entries, target, options)
  }

  const refuse = (stock) =>
    function (source, ...rest) {
      if (!isCfgSource(source)) return stock(source, ...rest)
      ui.notifications?.warn(NO_UPLOAD_LINE)
      return Promise.resolve(null)
    }
  if (upload) FP.upload = refuse(upload)
  if (createDirectory) FP.createDirectory = refuse(createDirectory)

  FP.prototype.render = async function (...args) {
    const list = await loadFileList()
    if (this.sources && typeof this.sources === 'object') {
      delete this.sources[OLD_SOURCE]
      Object.assign(this.sources, sourcesFor(list))
    }
    return render.apply(this, args)
  }

  // The picker names a file from the last segment of its path, which for a link carries the
  // signature. Show the clean name; the file's value (what a pick hands back) stays the link.
  // Its form draws the Upload row from `canUpload`, so a source that takes no upload clears it
  // (the refusal above stays as a guard).
  if (prepareContext) {
    FP.prototype._prepareContext = async function (...args) {
      const context = await prepareContext.apply(this, args)
      if (context && isCfgSource(this.activeSource)) context.canUpload = false
      for (const file of Array.isArray(context?.files) ? context.files : []) {
        if (names.has(file?.url)) file.name = names.get(file.url)
      }
      return context
    }
  }
}
