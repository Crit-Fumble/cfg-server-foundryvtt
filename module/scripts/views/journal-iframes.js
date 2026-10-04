/**
 * Cross-origin iframes in journal pages: keep them working, take away top navigation
 * (cs#455).
 *
 * GMs embed 5e.tools and Google Docs / Sheets / Maps in journal pages, and that has to
 * keep working. But every hosted world shares one origin with a live platform seat key in
 * its cookies, and an unsandboxed frame may navigate the WHOLE TAB (`window.top.location`)
 * anywhere it likes, for example to a lookalike sign-in page. Foundry's own sanitizer already
 * sandboxes untrusted hosts (`allow-scripts allow-forms`), but it REMOVES the sandbox for
 * its trusted list (google.com, youtube.com: TRUSTED_IFRAME_DOMAINS in common/constants.mjs),
 * and content a GM pastes as raw HTML may never pass through it.
 *
 * So, for every iframe whose `src` is a cross-origin http(s) URL:
 *   - `sandbox`: the allowlist below when there is none. When there already is one, only
 *     the tokens it shares with the allowlist, so this never WIDENS what Foundry or the
 *     GM set. No `allow-top-navigation*`, and no `allow-modals` (nothing these embeds need).
 *   - `referrerpolicy`: `no-referrer`, so the embed never learns which world it is in.
 *     YouTube is the exception: since 2025 its player refuses an embed that sends no
 *     Referer at all ("Error 153"), so it gets `strict-origin`, the origin and no path.
 * Same-origin frames (Foundry's own pdf.js viewer) and non-http(s) frames are left alone.
 *
 * ⛔ A changed sandbox or referrer policy only takes effect at the frame's NEXT
 * navigation. A frame that is already in the document (and so already loading) is
 * re-navigated to its own `src`. A page sheet rendered for the first time is still
 * detached when its render hook runs (JournalEntrySheet appends it afterwards), so
 * that common case costs no second load.
 */

const MODULE_TAG = 'CFG Core'

/** What a cross-origin journal embed may do. Order is the attribute's order. */
export const EXTERNAL_IFRAME_SANDBOX = Object.freeze([
  'allow-scripts',
  'allow-same-origin',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-forms',
  'allow-presentation',
  'allow-downloads',
])

/** Hosts whose embeds refuse to play with no Referer at all. */
const REFERRER_REQUIRED_HOSTS = Object.freeze(['youtube.com', 'youtube-nocookie.com'])

function _hostIs(hostname, domains) {
  return domains.some((d) => hostname === d || hostname.endsWith(`.${d}`))
}

/**
 * The attributes a journal iframe should carry, or null to leave it alone.
 * Pure, so the whole policy is unit-testable without a DOM.
 *
 * @param {string|null} src            the iframe's `src` attribute, as written
 * @param {string} pageOrigin          `window.location.origin`
 * @param {string|null} currentSandbox the iframe's `sandbox` attribute, or null when absent
 * @returns {{ sandbox: string, referrerpolicy: string }|null}
 */
export function externalIframeAttributes(src, pageOrigin, currentSandbox) {
  if (typeof src !== 'string' || src.trim() === '') return null
  let url
  try {
    url = new URL(src, pageOrigin)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.origin === pageOrigin) return null

  let sandbox
  if (currentSandbox == null) {
    sandbox = EXTERNAL_IFRAME_SANDBOX.join(' ')
  } else {
    const present = new Set(currentSandbox.toLowerCase().split(/\s+/).filter(Boolean))
    sandbox = EXTERNAL_IFRAME_SANDBOX.filter((t) => present.has(t)).join(' ')
  }
  const referrerpolicy = _hostIs(url.hostname, REFERRER_REQUIRED_HOSTS) ? 'strict-origin' : 'no-referrer'
  return { sandbox, referrerpolicy }
}

/**
 * Apply `externalIframeAttributes` to every iframe under `root`.
 *
 * @param {ParentNode|null|undefined} root
 * @param {string} pageOrigin
 * @returns {number} how many frames changed
 */
export function hardenExternalIframes(root, pageOrigin) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0
  let changed = 0
  for (const frame of root.querySelectorAll('iframe[src]')) {
    const src = frame.getAttribute('src')
    const want = externalIframeAttributes(src, pageOrigin, frame.getAttribute('sandbox'))
    if (!want) continue
    if (frame.getAttribute('sandbox') === want.sandbox && frame.getAttribute('referrerpolicy') === want.referrerpolicy) continue
    frame.setAttribute('sandbox', want.sandbox)
    frame.setAttribute('referrerpolicy', want.referrerpolicy)
    // Setting `src`, even to the same value, starts a new navigation under the new flags.
    if (frame.isConnected) frame.setAttribute('src', src)
    changed++
  }
  return changed
}

/**
 * Wire it to journal page rendering. `renderJournalEntryPageSheet` fires for every
 * ApplicationV2 page sheet subclass (text, markdown, HTML, and system page types),
 * because Foundry dispatches render hooks up the class chain.
 *
 * Skipped: edit mode (the frame belongs to the editor's document model there, and the
 * attributes would only be thrown away), and video pages, whose YouTube frame Foundry
 * binds to its player API in the same render; reloading it would cut that binding.
 */
export function registerJournalIframeGuard() {
  if (typeof Hooks === 'undefined') return
  Hooks.on('renderJournalEntryPageSheet', (app, element) => {
    try {
      if (app?.isView === false) return
      if (app?.document?.type === 'video') return
      const root = typeof element?.querySelectorAll === 'function' ? element : app?.element
      const n = hardenExternalIframes(root, window.location.origin)
      if (n) console.debug(`${MODULE_TAG} | sandboxed ${n} cross-origin journal iframe(s)`)
    } catch (err) {
      console.warn(`${MODULE_TAG} | journal iframe guard failed (non-fatal):`, err?.message || err)
    }
  })
}
