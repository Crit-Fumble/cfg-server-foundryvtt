/**
 * Boot loading overlay — covers the black screen a cfg-hosted world shows while
 * Foundry evaluates modules and streams world data + assets on first join.
 *
 * A joining player otherwise stares at a black rectangle for the whole cold
 * load (prod evidence: ~250 asset requests bursting through the vtt-proxy — see
 * the `_staggerStart` note in module.js). This is purely cosmetic reassurance:
 * a full-viewport panel with a spinner and a status line so they can see work
 * is happening.
 *
 * Mounted as early as this esmodule evaluates — before `init`, while the screen
 * is still black — and torn down on the `ready` hook (see module.js). A safety
 * timer removes it even if `ready` never fires, so a failed load surfaces
 * Foundry's own error screen rather than staying hidden behind us.
 *
 * Inline-styled with self-injected keyframes (same philosophy as
 * connection-banner.js): no module.json `styles` entry, and teardown removes
 * both the overlay and the style node.
 */

'use strict'

const OVERLAY_ID = 'cfg-core-loading-overlay'
const STYLE_ID = 'cfg-core-loading-overlay-style'

// Long enough to cover a heavy cold load, short enough that a stuck/failed
// boot uncovers Foundry's own UI (or error) rather than hiding behind us.
const SAFETY_TIMEOUT_MS = 60_000
const FADE_MS = 400

let _safetyTimer = null

/**
 * Mount the overlay. Idempotent — a second call while one is up is a no-op.
 * Safe to call before `document.body` exists; it defers to `DOMContentLoaded`.
 */
export function mountLoadingOverlay() {
  if (typeof document === 'undefined') return

  const attach = () => {
    if (!document.body || document.getElementById(OVERLAY_ID)) return
    _injectStyle()

    const el = document.createElement('div')
    el.id = OVERLAY_ID
    el.setAttribute('role', 'status')
    el.setAttribute('aria-live', 'polite')
    el.setAttribute('aria-label', 'Loading your game')
    el.innerHTML = [
      '<div class="cfg-loading__box">',
      '<div class="cfg-loading__spinner" aria-hidden="true"></div>',
      '<div class="cfg-loading__title">Loading your game…</div>',
      '<div class="cfg-loading__hint">Fetching world data and modules. First join can take a moment.</div>',
      '</div>',
    ].join('')

    document.body.appendChild(el)
    _safetyTimer = setTimeout(unmountLoadingOverlay, SAFETY_TIMEOUT_MS)
  }

  if (document.body) attach()
  else document.addEventListener('DOMContentLoaded', attach, { once: true })
}

/**
 * Remove the overlay (fading it out first). Safe to call when nothing is
 * mounted, and safe to call more than once.
 */
export function unmountLoadingOverlay() {
  if (typeof document === 'undefined') return
  if (_safetyTimer) {
    clearTimeout(_safetyTimer)
    _safetyTimer = null
  }

  const el = document.getElementById(OVERLAY_ID)
  const style = document.getElementById(STYLE_ID)
  if (!el) {
    style?.remove()
    return
  }

  const cleanup = () => {
    el.remove()
    style?.remove()
  }
  el.classList.add('cfg-loading--out')
  // Remove after the fade; the timeout is a hard backstop in case a
  // `transitionend` never arrives (reduced motion, detached tab, etc.).
  el.addEventListener('transitionend', cleanup, { once: true })
  setTimeout(cleanup, FADE_MS + 150)
}

function _injectStyle() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    `#${OVERLAY_ID}{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;`,
    `justify-content:center;background:#0b0d12;color:#e8eaf0;`,
    `font-family:var(--font-primary,'Signika',sans-serif);opacity:1;transition:opacity ${FADE_MS}ms ease}`,
    `#${OVERLAY_ID}.cfg-loading--out{opacity:0}`,
    `#${OVERLAY_ID} .cfg-loading__box{display:flex;flex-direction:column;align-items:center;`,
    `gap:14px;padding:0 24px;max-width:420px;text-align:center}`,
    `#${OVERLAY_ID} .cfg-loading__spinner{width:44px;height:44px;border-radius:50%;`,
    `border:3px solid rgba(255,255,255,.15);border-top-color:#c8a24a;`,
    `animation:cfg-loading-spin 1s linear infinite}`,
    `#${OVERLAY_ID} .cfg-loading__title{font-size:18px;font-weight:600;letter-spacing:.3px}`,
    `#${OVERLAY_ID} .cfg-loading__hint{font-size:13px;line-height:1.4;color:#9aa0ad}`,
    `@keyframes cfg-loading-spin{to{transform:rotate(360deg)}}`,
    `@media (prefers-reduced-motion:reduce){#${OVERLAY_ID} .cfg-loading__spinner{animation-duration:2.4s}}`,
  ].join('')
  document.head.appendChild(style)
}

/**
 * Exposed for tests — not part of the public overlay API.
 * @internal
 */
export const __internals = { OVERLAY_ID, STYLE_ID, SAFETY_TIMEOUT_MS }
