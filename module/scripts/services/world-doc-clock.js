/**
 * The world's own edit clock, read from a LIVE Foundry document (cs#417 rec 1).
 *
 * ⛔ TWIN FILE — THE RULE MUST NOT DRIFT.
 * The other copy is `cfg-core-server/src/services/foundry/world-doc-clock.ts`, which applies
 * the same rule at snapshot INGEST (cs#186). This one applies it at APPLY time, inside the
 * module. They are two files only because they sit in two repos on two release channels;
 * they are ONE rule, and the two sides of the cs#417 comparison. Change one, change both — a
 * module that reads the clock differently from core is how a last-write-wins system starts
 * losing writes in a way nobody can reproduce.
 *
 * ── THE PROPERTIES THAT MATTER ──────────────────────────────────────────────────
 *
 *  1. `_stats.modifiedTime` is epoch MILLISECONDS stamped SERVER-SIDE by Foundry. It is an
 *     absolute instant, so comparing it against a platform timestamp is timezone-free: a UTC
 *     container and a local-tz container yield the same number.
 *
 *  2. ⚠️ MEASURED on v14.361, and it is not what you would assume: editing an EMBEDDED
 *     document does NOT advance the parent's `_stats.modifiedTime`. Editing a JournalEntry
 *     page bumped only the page's clock and left the entry's byte-identical; only editing the
 *     parent itself (a rename) moved the parent's. A journal's CONTENT lives in its pages and
 *     an actor's lives partly in its items, so a PARENT-ONLY check would silently fail to
 *     protect the most common edit there is. The effective clock is therefore the NEWEST of
 *     the document and everything embedded in it.
 *
 *  3. NULL-SAFE, AND THE DIRECTION IS LOAD-BEARING: an absent or unreadable world clock NEVER
 *     wins. Absence is not evidence of a newer edit. Erring toward applying keeps sync
 *     working; erring toward skipping would silently stall every push on any doc type whose
 *     clock we cannot read.
 *
 *  4. ⛔ SCENES CANNOT USE THIS AND MUST NOT BE GIVEN A CLOCK CHECK. MEASURED: no scene CHILD
 *     (token, wall, light, …) declares a `DocumentStatsField` at all, and property 2 means the
 *     parent's clock does not move for a child — so the comparison would call a world full of
 *     fresh GM work "older". Scenes took cs#417 rec 4 instead. Core enforces this by never
 *     sending `platformChangedAt` on a scene item; nothing here needs a per-type list.
 */

'use strict'

/** Foundry's server-stamped write time (epoch-ms), or null when the doc carries no usable clock. */
export function worldModifiedTime(doc) {
  const t = doc?._stats?.modifiedTime
  return typeof t === 'number' && Number.isFinite(t) ? t : null
}

/**
 * The NEWEST clock across a document and its embedded collections — see property 2 above.
 *
 * `embeddedFields` are the docData field names the caller's config already declares
 * (`items` + `effects` for an Actor, `pages` for a JournalEntry). On a live document those
 * same names resolve to Foundry `EmbeddedCollection`s, which iterate over their VALUES
 * (`common/utils/collection.mjs` overrides `[Symbol.iterator]` to return `values()`), so one
 * `for...of` covers both a live collection and the plain array a test or a raw payload holds.
 *
 * Returns null when nothing in the tree carries a readable clock — which the caller must read
 * as "no world edit to defer to", never as "skip".
 */
export function effectiveWorldModifiedTime(doc, embeddedFields) {
  let newest = worldModifiedTime(doc)
  for (const field of embeddedFields ?? []) {
    const collection = doc?.[field]
    if (!collection || typeof collection !== 'object' || typeof collection[Symbol.iterator] !== 'function') continue
    for (const child of collection) {
      const t = worldModifiedTime(child)
      if (t != null && (newest == null || t > newest)) newest = t
    }
  }
  return newest
}
