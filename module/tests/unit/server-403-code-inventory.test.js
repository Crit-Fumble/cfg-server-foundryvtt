/**
 * The cfg-core-server 403 CODE INVENTORY — is FORBIDDEN_CODES still the right set?
 *
 * Why this file exists
 * ────────────────────
 * `FORBIDDEN_CODES` (scripts/auth/connection-state.js) lists the server error
 * codes meaning "the credential is ALIVE but lacks a right", so a 403 carrying one
 * must NOT be read as a dead key. Its docblock claimed the list "MIRRORS the core
 * server, which is the source of truth for it", and that the unit tests "carry
 * those bodies verbatim, so a change on either side has a named counterpart".
 *
 * The promise failed in the only direction that mattered. Core `ddd280a`
 * (v1.213.0) made a seat key authorized by its BINDING rather than by ownership,
 * deleting both sites that emitted `INSTALLATION_OWNER_REQUIRED` — and every
 * module test stayed green, because they feed `forbiddenCode()` hand-written
 * bodies. A mock cannot notice the server stopped producing what it mocks.
 *
 * This test reads the server's SOURCE and derives the set of 403 codes it can
 * actually emit. The derived set is the INPUT, so the input changes when the
 * server changes — the whole difference from a mock.
 *
 * ⚠️ THE ASYMMETRY IS THE DESIGN — read this before touching the table
 * ────────────────────────────────────────────────────────────────────
 *   server → module  A code the server emits that the table does not classify
 *                    FAILS. No allowlist. This catches a NEW server code the
 *                    module has never heard of — the failure a fixture cannot
 *                    see, because a fixture holds only what someone already knew.
 *   module → server  A code in the table the server emits NOWHERE also FAILS —
 *                    UNLESS the row says `emitted: false` and names the commit
 *                    that retired it. That "retained for older cores" allowance
 *                    is deliberately NARROW: per-code, costing a sentence and a
 *                    SHA, unreachable by accident.
 *
 * ⛔ The allowance cannot blunt the guard: it lives entirely on the module→server
 * side. It excuses "the server stopped sending X", never "the server started
 * sending Y" — a different assertion over a different set. And `emitted: false`
 * still has teeth: a retired row must ALSO stay in FORBIDDEN_CODES (a code nobody
 * handles is a stale line, not legacy retention), and a retired code that comes
 * BACK fails too, forcing a re-read rather than a silent widening.
 *
 * PROVEN against the real drift, not asserted: scanning `ddd280a^` finds
 * INSTALLATION_OWNER_REQUIRED at foundry-installed-modules.ts and
 * foundry-system-schema.ts; `ddd280a` and later, NOWHERE. With the table as it
 * stood when PR #29 was raised (`emitted: true`) the "still emitted" assertion
 * goes red on exactly that commit.
 *
 * ⛔ WHAT THIS TEST DOES NOT CATCH — do not let a green run imply any of it
 * ────────────────────────────────────────────────────────────────────────
 *  1. BODY SHAPE beyond `code`. The module branches on `code` but RENDERS
 *     `body.error` (api-client.js, cfg-campaign-links.js) and reads `body.scope`
 *     (pair-flow.js). Rename or drop `error` server-side and each degrades to a
 *     generic message with zero assertions moving. This guards the field nothing
 *     renders and ignores the two that drive the UI.
 *  2. STATUS ORDERING. pair-flow.js checks `status === 401` before reading the
 *     body, so a future code-carrying 401 is unconditionally `auth-failed`.
 *     Correct today (INVALID_KEY); nothing holds it there.
 *  3. RUNTIME REACHABILITY. It reads source text: a route can be unmounted, a
 *     guard can short-circuit earlier, `code: someVar` is invisible. The
 *     `unreachable` verdicts are partly mechanical (`pathMarkers`) and partly
 *     human prose this test prints but cannot check.
 *  4. WHICH SERVER THE USER IS TALKING TO. It scans ONE checkout — in practice
 *     the branch on disk, which is AHEAD of prod. The honest target is a union
 *     over every core version in the wild (self-hosted Foundry servers included),
 *     and a scan of a point cannot describe a union. Nothing here can ever say a
 *     retained code is safe to delete, so retained codes accumulate forever.
 *  5. A WRONG JUDGEMENT. Re-labelling a live rights code `dead-credential` or
 *     `rights-unhandled` with plausible prose stays green. The guard is against
 *     accidents, not against a bad call.
 *  6. THE CONSEQUENCE. Nothing here auto-re-pairs today (cfg-link-settings.js:
 *     "only the Unlink button ever clears the key") and the banner surfaces only
 *     `offline`, so a misclassification currently costs a worse message, not a
 *     loop. The loop is LATENT — it arrives the first time someone wires
 *     automatic re-pair to `auth-failed`, at which point every already-installed
 *     copy is loop-prone against every future server code.
 *  7. A HELPER REFACTOR. Moving all 403 sends behind `forbid(reply, code)`, or the
 *     code strings into a shared constant, breaks shape matching. The positive
 *     control catches a blackout and the RESHAPE hint catches the common partial
 *     case; a subtle one would not be.
 *
 * ⚠️ Two files under the server's src/ contain literal NUL bytes. `grep` treats
 * them as binary and SKIPS THEM SILENTLY (`grep -c` prints nothing where `grep
 * -ac` prints 1). This scanner uses fs.readFileSync(…, 'utf8'), so NUL is just
 * another character. Do not "simplify" it into a shell grep. */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MODULE_SCRIPTS = resolve(HERE, '../../scripts')

/** Jest's `expect()` takes no message argument (that is Vitest), and a bare
 * `expected [] to equal [...]` says nothing about what to DO — so failures throw,
 * with the whole remedy in the text. */
function check(condition, message) {
  if (!condition) throw new Error(`\n${message}\n`)
}

/**
 * ⛔ DO NOT use console.log/warn here. tests/setup.js replaces console.log/.warn/
 * .error/.info with `jest.fn()` ("console — quiet by default"), so anything
 * printed through console is SWALLOWED — the loud skip banner below would be
 * silent, the precise failure this file exists to avoid. process.stdout is
 * untouched by that mock, and the `describe` TITLES carry the same information
 * as a second channel, since a title shows in the reporter tree regardless.
 */
function say(text) {
  process.stdout.write(`${text}\n`)
}

/* ══ 1. THE INVENTORY ══════════════════════════════════════════════════════════
 *
 * Every 403 code cfg-core-server can emit, and what this module does about it.
 * Adding a row is a deliberate act with a reason attached; that is the point.
 *
 * handling:
 *   'rights'            credential alive, lacks a right → MUST be in FORBIDDEN_CODES
 *   'dead-credential'   indistinguishable from a dead key → MUST NOT be
 *   'unreachable'       this module's callers cannot receive it → MUST NOT be
 *   'rights-unhandled'  IS a rights code and IS reachable, but unhandled today →
 *                       MUST NOT be (a known gap, kept loud, never quietly promoted)
 * emitted:
 *   true   the server's source must still contain at least one emission site
 *   false  deliberately retained for older cores in the wild; `retiredBy` names
 *          the commit that removed it. THE ONLY legacy allowance in this file.
 * unreachableBecause (required on every 'unreachable' row):
 *   'route-not-called'  the module never requests that route. CHECKED — give
 *                       `pathMarkers`; the test fails if any path literal in this
 *                       module's scripts/ contains one.
 *   'auth-branch'       the route IS called but the emitting branch needs another
 *                       credential kind. NOT CHECKABLE from source; printed as
 *                       UNVERIFIED every run so it cannot go quiet.
 */
const SERVER_403_CODES = {
  SCOPE_REQUIRED: {
    handling: 'rights',
    emitted: true,
    why:
      'requireScope / requireScopeIfApiKey in src/routes/v1/_lib/auth.ts. Body: ' +
      "{ error: 'Scope required: <scope>', code, scope }. Pairing filters granted scopes against the " +
      "account's role, so re-pairing cannot mint the missing scope.",
  },

  INSTALLATION_OWNER_REQUIRED: {
    handling: 'rights',
    emitted: false,
    retiredBy:
      'ddd280a (released v1.213.0) — "a seat key is authorized by its BINDING, not by ownership" (cs#392). ' +
      'It deleted both sites: foundry-installed-modules.ts and foundry-system-schema.ts.',
    why:
      'RETAINED ON PURPOSE. v1.212.0 and earlier DID send it, installed copies of this module are ' +
      'long-lived, and one talking to an older core must still read it as a rights problem rather than ' +
      'a dead key. This row is the whole reason the `emitted: false` allowance exists.',
  },

  FORBIDDEN: {
    handling: 'dead-credential',
    emitted: true,
    why:
      'The generic 403. Post-ddd280a it is also what an UNBOUND api key gets from ' +
      'foundry-installed-modules.ts / foundry-system-schema.ts, whose own message says "re-pair the ' +
      'plugin" — so mapping it to auth-failed is correct, not a gap. ⚠️ That is a RUNTIME claim resting ' +
      'on a static reading: this test checks only that the code is emitted, never which condition emits it.',
  },

  NOT_GM: {
    handling: 'rights',
    emitted: true,
    why:
      'resolveCourierWorld (src/routes/v1/_lib/courier-auth.ts:146) sends it to every ' +
      '/installations/:id/foundry/*-sync courier when the caller is not a world GM — routes this module ' +
      'polls on a timer — plus six /account/game-world-* routes. The key is alive and the world-GM seat ' +
      'is missing; re-pairing cannot grant a seat, so a re-pair is the wrong response. ' +
      '⚠️ This row was born as a KNOWN GAP: the test derived the server code set, found NOT_GM absent ' +
      'from FORBIDDEN_CODES, and printed it every run until it was promoted (2026-09-11). Recorded ' +
      'because it is the evidence this guard works — it caught a live instance of the failure the PR ' +
      'that introduced it was written to fix. Body is { error: "Forbidden", code } — the text is the ' +
      'bare word, so the CODE carries the whole signal and there is no prose worth relaying.',
  },

  INSTALLATION_MISMATCH: {
    handling: 'unreachable',
    emitted: true,
    unreachableBecause: 'auth-branch',
    why:
      'courier-auth.ts, reached only on the service-GM JWT branch (verifyFoundryServiceGmJwt). That token ' +
      'is minted by the launcher for the headless service GM; this module authenticates with a cfk_ api ' +
      'key and never presents one. ⚠️ The module DOES call those routes — only the branch is out of reach, ' +
      'which source scanning cannot verify. Human reasoning, reported every run, never checked.',
  },

  OWNER_ONLY: {
    handling: 'unreachable',
    emitted: true,
    unreachableBecause: 'route-not-called',
    pathMarkers: ['/data-ops'],
    why: 'installation-data-ops.ts, mounted at /api/v1/installations/:installationId/data-ops. This module calls no data-ops route.',
  },

  WORLD_NOT_GRANTED: {
    handling: 'unreachable',
    emitted: true,
    unreachableBecause: 'route-not-called',
    pathMarkers: ['/data-ops'],
    why:
      'A typed refusal object ({ ok: false, status: 403, code }) from services/data-ops/paths.ts, re-sent by ' +
      'installation-data-ops.ts. Same route family as OWNER_ONLY, and NOT a .status(403).send() — it is why ' +
      'this scanner needs its second shape. ⚠️ Shape B also matches the TYPE ALIAS at paths.ts:46, so this ' +
      "code's presence would survive deletion of the real send. An over-count, but worth knowing.",
  },

  no_access: {
    handling: 'unreachable',
    emitted: true,
    unreachableBecause: 'route-not-called',
    pathMarkers: ['/api/foundry/auth'],
    why:
      'routes/v1/public/foundry-auth.ts, mounted at POST /api/foundry/auth/validate — the Foundry SSO validate ' +
      'endpoint, called by the Foundry SERVER during login, never by this module. Lowercase by local convention.',
  },
}

const RIGHTS_HANDLING = 'rights'
const ALL_HANDLING = ['rights', 'dead-credential', 'unreachable', 'rights-unhandled']
const TABLE_CODES = Object.keys(SERVER_403_CODES)


/* ══ 2. LOCATING cfg-core-server — SEARCH, never assume a depth ═══════════════
 *
 * ⛔ `../../cfg-core-server` is true from a worktree and false from the main
 * checkout (or the reverse). That is exactly the bug PR #30 fixed in the husky
 * trademark hook: a fixed relative path that resolved from one layout, missed
 * from the other, and SKIPPED SILENTLY. So: walk UP from this file to the root,
 * trying `<ancestor>/cfg-core-server` and `<ancestor>/workspaces/cfg-core-server`
 * at each level. A candidate counts only if the MARKER file is present —
 * existence-of-directory is never mistaken for existence-of-checkout, the half of
 * #30's bug that made it silent. Three outcomes, kept distinct on purpose:
 *   found      → run the scan
 *   absent     → SKIP (a fork has no private sibling; see the banner in §6)
 *   near-miss  → FAIL. A directory named cfg-core-server with no marker is a
 *                broken or empty checkout, and calling that "standalone" is the
 *                #30 failure wearing a new hat.
 */
const MARKER = join('src', 'routes', 'v1', '_lib', 'auth.ts')

function isServerCheckout(dir) {
  try { return statSync(join(dir, MARKER)).isFile() } catch { return false }
}

function dirExists(dir) {
  try { return statSync(dir).isDirectory() } catch { return false }
}

function locateCoreServer() {
  const override = process.env.CFG_CORE_SERVER_DIR
  if (override) {
    const dir = resolve(override)
    // An explicit pointer that misses is a broken configuration, never an absence.
    if (!isServerCheckout(dir)) return { dir: null, nearMisses: [dir], how: `CFG_CORE_SERVER_DIR=${override}` }
    return { dir, nearMisses: [], how: `CFG_CORE_SERVER_DIR=${override}` }
  }

  const nearMisses = []
  let levels = 0
  let cur = HERE
  for (;;) {
    for (const rel of ['cfg-core-server', join('workspaces', 'cfg-core-server')]) {
      const cand = join(cur, rel)
      if (isServerCheckout(cand)) {
        return { dir: cand, nearMisses: [], how: `upward search from ${HERE} (${levels} levels)` }
      }
      if (dirExists(cand)) nearMisses.push(cand)
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
    levels += 1
  }
  return { dir: null, nearMisses, how: `upward search from ${HERE} (${levels} levels, no marker found)` }
}

const LOCATED = locateCoreServer()
const HAVE_SERVER = LOCATED.dir !== null
const BROKEN_CHECKOUT = !HAVE_SERVER && LOCATED.nearMisses.length > 0

/**
 * Best-effort git ref of the scanned checkout, so a run is ATTRIBUTABLE. Printed,
 * never asserted: pinning to a commit would red on every unrelated server commit
 * and be baselined away within a week. See limitation 4 above.
 */
function refOf(dir) {
  try {
    const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref:')) return head.slice(0, 12)
    const branch = head.slice(4).trim()
    let sha = ''
    try {
      sha = readFileSync(join(dir, '.git', branch), 'utf8').trim().slice(0, 12)
    } catch {
      sha = '(packed)'
    }
    return `${branch.replace('refs/heads/', '')} @ ${sha}`
  } catch {
    return '(ref unreadable)'
  }
}

/* ══ 3. THE SCANNER ═══════════════════════════════════════════════════════════ */

/**
 * Blank out `//` and block comments, preserving offsets and newlines so line
 * numbers survive.
 *
 * What this buys, MEASURED rather than assumed (checked by disabling it): it is
 * NOT what rejects the surviving INSTALLATION_OWNER_REQUIRED mentions in
 * cfg-core-server — those are PROSE, and the structural match below
 * (`.status(403)` → `.send({` → a top-level `code:`) already refuses them. A
 * plain grep finds all three and reads the code as alive; that is the trap, and
 * structure is what avoids it. What stripping DOES reject is a commented-out
 * emission, and it is what keeps the RESHAPE hint honest — that one is a plain
 * substring test and would otherwise match prose. Cheap insurance; do not delete
 * it, and do not overstate it either.
 *
 * String and template literals are tracked so a `//` inside one is not a comment.
 * A regex literal holding a lone quote could desync it; the failure direction is
 * "finds less" — a loud red plus a tripped positive control, never a silent pass.
 */
function stripComments(src) {
  let out = ''
  let i = 0
  let mode = 'code'
  let quote = ''
  while (i < src.length) {
    const c = src[i]
    const d = src[i + 1]
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && d === '*') { mode = 'block'; out += '  '; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') { mode = 'str'; quote = c; out += c; i += 1; continue }
      out += c; i += 1; continue
    }
    if (mode === 'line') {
      out += c === '\n' ? '\n' : ' '
      if (c === '\n') mode = 'code'
      i += 1; continue
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; out += '  '; i += 2; continue }
      out += c === '\n' ? '\n' : ' '
      i += 1; continue
    }
    // inside a string / template literal
    if (c === '\\') { out += '  '; i += 2; continue }
    if (c === quote) { mode = 'code'; out += c; i += 1; continue }
    out += c === '\n' ? '\n' : c
    i += 1
  }
  return out
}

const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', 'coverage', 'generated', '__tests__']
function sourceFilesUnder(dir, extRe, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.includes(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) sourceFilesUnder(p, extRe, acc)
    else if (extRe.test(e.name) && !/\.(test|spec)\.[cm]?[jt]s$/.test(e.name)) acc.push(p)
  }
  return acc
}

/** The object literal enclosing `at`, or null. Brace-balanced both ways. */
function enclosingObject(src, at) {
  let depth = 0
  for (let i = at; i >= 0; i--) {
    const c = src[i]
    if (c === '}') depth++
    else if (c === '{') {
      if (depth === 0) {
        let e = 0
        for (let j = i; j < src.length; j++) {
          const k = src[j]
          if (k === '{') e++
          else if (k === '}') { e--; if (e === 0) return { text: src.slice(i, j + 1), start: i } }
        }
        return null
      }
      depth--
    }
  }
  return null
}

/** A top-level `code: '<LITERAL>'` inside an object literal, or null. */
function topLevelCodeLiteral(objText) {
  let depth = 0
  for (let i = 0; i < objText.length; i++) {
    const c = objText[i]
    if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') depth--
    else if (depth === 1 && objText.startsWith('code:', i)) {
      const m = /^code:\s*(['"`])([A-Za-z0-9_]+)\1/.exec(objText.slice(i))
      return m ? m[2] : null
    }
  }
  return null
}

/**
 * Every 403 emission site carrying a literal `code`, in two shapes:
 *
 *   A  reply.status(403).send({ …, code: 'X' })      — the common one
 *   B  { ok: false, status: 403, code: 'X', … }      — a typed refusal object
 *                                                      re-sent by a route later
 *
 * Shape B is not theoretical: WORLD_NOT_GRANTED reaches the wire only that way,
 * and "missed" reads as "not emitted". Also records, per table code, whether the
 * bare string appears in COMMENT-FREE source — the RESHAPE hint:
 * present-but-unstructured means the body was probably reshaped rather than the
 * code removed, which has a different remedy from the legacy allowance.
 */
function scanServer403Codes(serverDir) {
  const srcRoot = join(serverDir, 'src')
  const found = new Map()
  const bare = new Set()
  const add = (code, where) => { found.set(code, [...(found.get(code) ?? []), where]) }
  let fileCount = 0

  for (const file of sourceFilesUnder(srcRoot, /\.[cm]?ts$/)) {
    fileCount += 1
    // utf8 read, NOT grep: two files here carry literal NUL bytes and grep skips
    // them silently as "binary". See the header.
    const src = stripComments(readFileSync(file, 'utf8'))
    const rel = relative(serverDir, file).split(sep).join('/')
    const lineAt = (idx) => src.slice(0, idx).split('\n').length

    for (const code of TABLE_CODES) if (src.includes(code)) bare.add(code)

    // shape A
    for (const m of src.matchAll(/(?:\.status|\.code)\(\s*403\s*\)/g)) {
      const sendAt = src.indexOf('.send(', m.index)
      if (sendAt < 0 || sendAt - m.index > 200) continue
      const braceAt = src.indexOf('{', sendAt)
      if (braceAt < 0 || braceAt - sendAt > 40) continue
      const obj = enclosingObject(src, braceAt)
      if (!obj) continue
      const code = topLevelCodeLiteral(obj.text)
      if (code) add(code, `${rel}:${lineAt(m.index)} [send]`)
    }

    // shape B
    for (const m of src.matchAll(/status:\s*403\b/g)) {
      const obj = enclosingObject(src, m.index)
      if (!obj) continue
      const code = topLevelCodeLiteral(obj.text)
      if (code) add(code, `${rel}:${lineAt(m.index)} [refusal-object]`)
    }
  }

  return { found, bare, fileCount }
}

/**
 * Every literal API path this module requests, read from its OWN scripts/ with
 * comments stripped (so a path in a docblock is not a call). This turns the
 * `unreachable` verdicts from unchecked prose into a checked claim: the day the
 * module grows a data-ops call, OWNER_ONLY stops being unreachable and the table
 * has to say so.
 */
function scanModuleRequestPaths() {
  const paths = new Set()
  for (const file of sourceFilesUnder(MODULE_SCRIPTS, /\.m?js$/)) {
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const m of src.matchAll(/['"`](\/api\/[^'"`\s]*)/g)) paths.add(m[1])
  }
  return [...paths].sort()
}

/* ══ 4. ALWAYS-RUN HALF: the table is internally coherent ═════════════════════
 * No server needed, never skips: a malformed table would make every server-side
 * verdict below meaningless. */

describe('server 403 inventory — the table and FORBIDDEN_CODES agree (no server needed)', () => {
  it('every row is well-formed, and a retired row names the commit that retired it', () => {
    const rows = Object.entries(SERVER_403_CODES)
    expect(rows.length).toBeGreaterThan(0)
    for (const [code, row] of rows) {
      check(ALL_HANDLING.includes(row.handling), `${code}: unknown handling "${row.handling}"`)
      check(typeof row.why === 'string' && row.why.length > 40, `${code}: every row must say WHY, in prose`)
      check(typeof row.emitted === 'boolean', `${code}: emitted must be a boolean`)
      if (!row.emitted) {
        // The legacy allowance costs a sentence and a commit SHA. That price is the guard.
        check(
          typeof row.retiredBy === 'string' && /[0-9a-f]{7,40}/.test(row.retiredBy),
          `${code}: emitted:false must name the commit that retired it, sha included`,
        )
      }
      if (row.handling === 'unreachable') {
        check(
          ['route-not-called', 'auth-branch'].includes(row.unreachableBecause),
          `${code}: an unreachable row must say WHY it is unreachable — 'route-not-called' (checked) or ` +
            "'auth-branch' (prose, reported). Unqualified unreachability is how a verdict rots silently.",
        )
        if (row.unreachableBecause === 'route-not-called') {
          check(
            Array.isArray(row.pathMarkers) && row.pathMarkers.length > 0,
            `${code}: 'route-not-called' must list pathMarkers so the claim can be checked against this ` +
              "module's own request paths.",
          )
        }
      }
    }
  })

  it('FORBIDDEN_CODES is exactly the rows marked "rights" — no more, no less', async () => {
    const { FORBIDDEN_CODES } = await import('../../scripts/auth/connection-state.js')
    const wanted = Object.entries(SERVER_403_CODES)
      .filter(([, r]) => r.handling === RIGHTS_HANDLING)
      .map(([c]) => c)
      .sort()
    expect([...FORBIDDEN_CODES].sort()).toEqual(wanted)
  })

  it('a retired code is still handled — otherwise the row is dead weight, not legacy retention', async () => {
    const { FORBIDDEN_CODES } = await import('../../scripts/auth/connection-state.js')
    for (const [code, row] of Object.entries(SERVER_403_CODES)) {
      if (row.emitted) continue
      check(
        FORBIDDEN_CODES.includes(code),
        `${code} is marked retired but is not in FORBIDDEN_CODES. Keeping a row for a code nobody handles ` +
          'is not legacy retention — delete it from the table.',
      )
    }
  })

  it('known gaps and unverifiable verdicts stay visible in the output', () => {
    const gaps = Object.entries(SERVER_403_CODES).filter(([, r]) => r.handling === 'rights-unhandled')
    const prose = Object.entries(SERVER_403_CODES).filter(([, r]) => r.unreachableBecause === 'auth-branch')
    if (gaps.length > 0) {
      say(
        `\n  [403-inventory] ${gaps.length} rights code(s) the server CAN send and this module does NOT handle:\n` +
          gaps.map(([c, r]) => `    ${c} — ${r.why.split('.')[0]}.`).join('\n') +
          '\n  Not a failure: each is a deliberate, documented gap. Promote one by changing its handling to\n' +
          '  "rights" AND adding it to FORBIDDEN_CODES in the same commit.\n',
      )
    }
    if (prose.length > 0) {
      say(
        `  [403-inventory] ${prose.length} verdict(s) rest on UNVERIFIED human reasoning (auth-branch):\n` +
          prose.map(([c]) => `    ${c}`).join('\n') +
          '\n  Source scanning cannot check these. Re-read the call site when the module changes how it\n' +
          '  authenticates.\n',
      )
    }
    expect(gaps.every(([, r]) => typeof r.why === 'string' && r.why.length > 40)).toBe(true)
  })
})

/* ══ 5. SERVER-DEPENDENT HALF ══════════════════════════════════════════════ */
const TITLE = HAVE_SERVER
  ? `server 403 inventory — SCANNING ${LOCATED.dir}`
  : 'server 403 inventory — SKIPPED: no cfg-core-server checkout, so NOTHING about the server was verified'

const describeScan = HAVE_SERVER ? describe : describe.skip

describeScan(TITLE, () => {
  /** @type {Map<string, string[]>} */
  let found
  /** @type {Set<string>} */
  let bare
  let fileCount = 0
  /** @type {string[]} */
  let modulePaths = []

  beforeAll(() => {
    const r = scanServer403Codes(LOCATED.dir)
    found = r.found
    bare = r.bare
    fileCount = r.fileCount
    modulePaths = scanModuleRequestPaths()
    say(
      `\n  [403-inventory] ACTIVE — ${fileCount} .ts files under ${LOCATED.dir}/src (${LOCATED.how})\n` +
        `  [403-inventory] server checkout ref: ${refOf(LOCATED.dir)}  ⚠️ whatever is on disk, NOT the deployed tag\n` +
        `  [403-inventory] codes found: ${[...found.keys()].sort().join(', ') || '(none)'}\n` +
        `  [403-inventory] module request paths read from scripts/: ${modulePaths.length}\n`,
    )
  })

  // positive control first, because every verdict below depends on it
  it('the scanners can see both repos at all (positive control)', () => {
    check(fileCount > 100, `scanned only ${fileCount} .ts files — wrong directory, or a pruned checkout?`)
    check(
      found.size > 0,
      'The scan found ZERO 403 codes. A scanner that matches nothing must never read as agreement — the ' +
        'server changed its reply shape, or the comment stripper desynced. Fix the scanner before believing ' +
        'anything else in this file.',
    )
    // A code we KNOW is there, measured over HTTP the day this test was written.
    // Believing a zero without a known-present control is how an empty result gets trusted.
    check(
      (found.get('SCOPE_REQUIRED') ?? []).length > 0,
      'SCOPE_REQUIRED has no emission site. It is the positive control: if it is gone, distrust every other ' +
        'verdict in this file before acting on one.',
    )
    // Same discipline for the module-side scanner that backs the reachability check.
    check(
      modulePaths.length > 20 && modulePaths.some((p) => p.includes('/api/v1/foundry/modules')),
      `The module path scanner found ${modulePaths.length} paths and no /api/v1/foundry/modules. It is blind, ` +
        'so every "route-not-called" verdict below would pass vacuously.',
    )
    expect(found.size).toBeGreaterThan(0)
  })

  // server → module: nothing unclassified. NO allowlist here, on purpose.
  it('every 403 code the server emits is classified in the table', () => {
    const unclassified = [...found.keys()].filter((c) => !(c in SERVER_403_CODES)).sort()
    check(
      unclassified.length === 0,
      [
        `cfg-core-server emits ${unclassified.length} 403 code(s) this module has never heard of:`,
        ...unclassified.map((c) => `  ${c}  at ${found.get(c).join(', ')}`),
        '',
        'Read each call site and add a row to SERVER_403_CODES with a handling verdict:',
        '  rights           → credential alive, lacks a right. ALSO add it to FORBIDDEN_CODES.',
        '  dead-credential  → indistinguishable from a dead key; leave it out of FORBIDDEN_CODES.',
        '  unreachable      → this module never calls that route, or never takes that auth branch.',
        '                     Say which, in unreachableBecause, and give pathMarkers when it is the route.',
        '  rights-unhandled → a real gap you are choosing not to close yet. Say so out loud.',
        '',
        'There is no allowlist for this direction. A new server code is exactly the drift a captured-fixture',
        'test cannot see, because a fixture holds only what someone already knew to put in it.',
      ].join('\n'),
    )
    expect(unclassified).toEqual([])
  })

  // module → server: the ddd280a catch. Narrow, explicit legacy allowance.
  it('every code the table marks as emitted is still emitted by the server', () => {
    const vanished = Object.entries(SERVER_403_CODES)
      .filter(([code, row]) => row.emitted && !found.has(code))
      .map(([code]) => code)
      .sort()
    // Present in comment-free source but with no structured emission site: the body was probably
    // RESHAPED (code nested, status changed, moved behind a helper), which has a different remedy
    // from the legacy allowance. Saying so here stops a reader marking a live code retired.
    const reshaped = vanished.filter((c) => bare.has(c))
    check(
      vanished.length === 0,
      [
        `The table says these are live, but ${LOCATED.dir} emits them from NOWHERE:`,
        ...vanished.map((c) => `  ${c}${bare.has(c) ? '   ← still mentioned in comment-free source' : ''}`),
        '',
        ...(reshaped.length > 0
          ? [
              '⚠️ READ THIS FIRST. The marked codes still appear in live (non-comment) server source, so this is',
              'most likely a RESHAPE, not a removal — `code` moved out of the top level, the status changed, or',
              'the body moved behind a helper. The remedy is to teach this scanner the new shape, NOT to mark a',
              'live code retired. Marking it retired would pin the bug as correct.',
              '',
            ]
          : []),
        '⛔ THE ddd280a SHAPE. That commit deleted both INSTALLATION_OWNER_REQUIRED call sites and every mocked',
        'module test stayed green, because a mock cannot notice that the thing it mocks is gone.',
        '',
        'If the removal was deliberate and older cores in the wild still send it, set',
        '  emitted: false  and  retiredBy: "<sha> — <why>"',
        'on that row and KEEP the code in FORBIDDEN_CODES. If nobody sends it any more and no old core does',
        'either, delete it from both the table and FORBIDDEN_CODES.',
        '',
        'If SEVERAL rows vanished at once, suspect the scanner before the server and check the positive control.',
      ].join('\n'),
    )
    expect(vanished).toEqual([])
  })

  // a retired code coming back must force a re-read, never widen silently
  it('no code marked retired has come back', () => {
    const revived = Object.entries(SERVER_403_CODES)
      .filter(([code, row]) => !row.emitted && found.has(code))
      .map(([code]) => `${code} at ${found.get(code).join(', ')}`)
      .sort()
    check(
      revived.length === 0,
      [
        'These rows are marked retired but the server emits them again:',
        ...revived.map((r) => `  ${r}`),
        '',
        'Re-read the call site rather than shrugging: a revived code may not mean what the old one meant.',
        'Flip emitted back to true and re-justify the handling verdict.',
      ].join('\n'),
    )
    expect(revived).toEqual([])
  })

  // the `unreachable` excuse must stay true as the MODULE changes
  it('every "route-not-called" verdict is still true of this module\'s own request paths', () => {
    const broken = []
    for (const [code, row] of Object.entries(SERVER_403_CODES)) {
      if (row.unreachableBecause !== 'route-not-called') continue
      for (const marker of row.pathMarkers) {
        const hits = modulePaths.filter((p) => p.includes(marker))
        if (hits.length > 0) broken.push({ code, marker, hits })
      }
    }
    check(
      broken.length === 0,
      [
        'These codes are excluded from FORBIDDEN_CODES on the claim that this module never calls the route',
        'that emits them — and the module now calls it:',
        ...broken.map((b) => `  ${b.code}  (marker "${b.marker}")  →  ${b.hits.join(', ')}`),
        '',
        'That claim was the ONLY reason the code was left unhandled. Re-read the call site and either give the',
        'row a real handling verdict (rights / dead-credential / rights-unhandled) or explain why the new call',
        'still cannot receive it. ⚠️ Do not just widen the marker to make this pass.',
      ].join('\n'),
    )
    expect(broken).toEqual([])
  })

  it('reports where each classified code is emitted, for the reader', () => {
    const lines = Object.keys(SERVER_403_CODES)
      .sort()
      .map((c) => {
        const sites = found.get(c)
        return `    ${c.padEnd(28)} ${sites ? sites.join(', ') : '(not emitted — retired)'}`
      })
    say(`\n  [403-inventory] emission map:\n${lines.join('\n')}\n`)
    expect(lines.length).toBe(Object.keys(SERVER_403_CODES).length)
  })
})

/* ══ 6. THE SKIP MUST NOT LOOK LIKE A PASS ════════════════════════════════════
 * This repo is PUBLIC and must `npm ci && npm test` TOKENLESS on any fork, where
 * cfg-core-server (private) does not exist. So the scan skips there — a test that
 * reds a stranger's fork is unacceptable.
 *
 * ⚠️ STATED PLAINLY: this repo's own CI runs on a fork-shaped checkout with no
 * sibling, so THE SCAN ALWAYS SKIPS IN CI, and this test gates NOTHING on GitHub
 * today. What still runs on a fork is §4 — four tests proving the table agrees
 * with FORBIDDEN_CODES, i.e. the module agreeing with itself.
 *
 * Accepted with eyes open: the drift it catches is AUTHORED on machines holding
 * both checkouts — an owner session, or dev-tools CI — which is where it does
 * run, and .husky/pre-push runs `npm test`. But an honour-system check decays.
 * To make it a guard rather than a good intention, set CFG_CONTRACT_REQUIRE=1 in
 * a job that has both repos (dev-tools CI Gate is the natural home — check what
 * it materialises first, the workspaces/ gitlinks are skip-worktree'd, and a
 * workflow change there is owner-tier). Until then this is a LOCAL guard; do not
 * claim CI coverage for it.
 */

describe('server 403 inventory — coverage report', () => {
  it('says out loud whether the server was actually read', () => {
    if (HAVE_SERVER) {
      say(`\n  [403-inventory] SCAN RAN against ${LOCATED.dir} (${refOf(LOCATED.dir)})\n`)
      return
    }

    if (BROKEN_CHECKOUT) {
      // A directory by the right name with no marker file is NOT "standalone".
      // Silently skipping on it is the PR #30 failure mode wearing a new hat.
      throw new Error(
        [
          'A candidate path was rejected — it is not a cfg-core-server checkout:',
          ...LOCATED.nearMisses.map((d) => `  ${d}  (missing ${MARKER})`),
          '',
          'That is a broken or empty checkout, not an absent sibling. Fix the checkout, remove the empty',
          'directory, or point CFG_CORE_SERVER_DIR at a real one. Refusing to guess here is deliberate:',
          'treating it as "no server" would skip the scan while looking perfectly green.',
        ].join('\n'),
      )
    }

    say(
      [
        '',
        '  ┌─────────────────────────────────────────────────────────────────────────────┐',
        '  │ [403-inventory] THE SERVER SCAN DID NOT RUN.                                │',
        '  │                                                                             │',
        '  │ No cfg-core-server checkout was found, so NOTHING in this file was checked  │',
        '  │ against a server. The table-coherence tests above passed — that proves the  │',
        '  │ table agrees with FORBIDDEN_CODES, not that either matches reality.         │',
        '  │                                                                             │',
        "  │ Expected on a fork and in this repo's own CI (both are fork-shaped).        │",
        '  │ To run it:      CFG_CORE_SERVER_DIR=/path/to/cfg-core-server                │',
        '  │ To require it:  CFG_CONTRACT_REQUIRE=1  (absence then FAILS)                │',
        '  └─────────────────────────────────────────────────────────────────────────────┘',
        // Outside the box so nothing truncates it — the path is what a reader needs.
        `  [403-inventory] looked: ${LOCATED.how}`,
        '',
      ].join('\n'),
    )

    if (process.env.CFG_CONTRACT_REQUIRE === '1') {
      throw new Error(
        'CFG_CONTRACT_REQUIRE=1 demands the server-side scan, but no cfg-core-server checkout was found ' +
          `(${LOCATED.how}). Set CFG_CORE_SERVER_DIR, or unset CFG_CONTRACT_REQUIRE.`,
      )
    }
  })
})
