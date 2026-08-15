#!/usr/bin/env node
/**
 * check-felddy-contract — this image's contract, as an executable check.
 *
 * ## Why this exists
 *
 * The Dockerfile is `FROM` + four `LABEL`s, and its load-bearing rule —
 *
 *   > DO NOT add an ENTRYPOINT here. [...] felddy's entrypoint + bash supervisor
 *   > stays PID 1 — load-bearing: a clean SIGTERM is the only thing that unlocks
 *   > the world's LevelDB on shutdown.
 *
 * — was enforced by that comment and nothing else. The README calls this image a
 * "strict ADDITIVE SUPERSET [...] provably byte-identical to felddy until a
 * capability is turned on", and CONTRIBUTING says "a wrapper that diverges from
 * felddy's env/volume contract is a bug". Nothing proved any of it. Same shape as
 * the two guards this repo already ships (agent/check-playwright-pin.mjs,
 * module/check-version-bump.test.mjs): a comment is not a guard.
 *
 * ## THREE FAMILIES, and none is redundant
 *
 *   C. DOCKERFILE TEXT — the SOURCE stayed additive. No Docker, runs first, fails
 *      in <1s. This is the only family that can see a forbidden instruction whose
 *      value happens to equal the base's (see the ENTRYPOINT trap below).
 *   P. PASSTHROUGH — wrapper vs the base it names. Guards US. Structurally BLIND
 *      to upstream regressions: both sides move together on a digest bump.
 *   H. HARD CONTRACT — wrapper vs absolute values + live probes. Guards UPSTREAM.
 *      This is the family that goes red on the daily upstream-watch bump PR, which
 *      rewrites the FROM digest by sed and until now had nothing inspecting what
 *      came back.
 *
 * P alone would bless a base that dropped the HEALTHCHECK (both sides identical).
 * H alone would bless a wrapper that ships correct values while ALSO adding a dead
 * ENTRYPOINT. C alone cannot see a base bump at all.
 *
 * ## ⛔ THREE TRAPS THIS FILE IS BUILT AROUND — all three observed, not theorised
 *
 * 1. `docker image inspect` returns a JSON **ARRAY**. So `jq '.Config.Entrypoint'`
 *    is `null` for EVERY image, and a comparison written that way reports
 *    "IDENTICAL" for every field — including against an image with an injected
 *    ENTRYPOINT. Always `--format '{{json .}}'`, which emits one OBJECT.
 * 2. **Config comparison cannot enforce the no-ENTRYPOINT rule.** Adding
 *    `ENTRYPOINT ["./entrypoint.sh"]` leaves `Config.Entrypoint` deep-equal to the
 *    base — green. And `   entrypoint [...]`, lowercase and indented, builds and
 *    applies. Hence family C, case-insensitive and indentation-tolerant.
 * 3. **A COPY can hijack felddy's own scripts with zero Config drift.**
 *    `COPY entrypoint.sh /home/node/entrypoint.sh` passes Config comparison, every
 *    literal assertion and every probe. Only H_SCRIPTS (a sha256 map of felddy's
 *    13 /home/node files, wrapper vs base, exact key set) sees it.
 *
 * ## The uid the docs get wrong
 *
 * The image runs uid **1000:1000**, not the "1000:1001" README.md and the
 * Dockerfile header both claim. 1001 is CFG_DATA_GID — a SUPPLEMENTARY group
 * cfg-core-server adds at launch (`groupAdd`), never the image's own gid. A check
 * written from the prose fails against a correct image and invites "fixing" the
 * image to match a wrong doc.
 *
 * ## What a green here does NOT mean
 *
 * NO LICENSE is involved, so none of this is proven: license host-binding
 * (`license.json.signature`), admin.txt AUTHENTICATING against /auth, the
 * /join /setup surface, the world's LevelDB actually unlocking on shutdown, or the
 * /data runtime tree. Those need a licensed Foundry and live in e2e/, which is
 * deliberately not in CI. A green means: the committed Dockerfile still produces an
 * additive superset of the base it names, carrying the values cfg-core-server
 * depends on at launch. It does not mean Foundry works.
 *
 * Structure: pure decision functions (checkDockerfile / checkPassthrough /
 * checkHardContract) take plain facts and return problem strings; every docker call
 * lives in main(). That split is what lets the .test.mjs mutate facts offline.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = dirname(fileURLToPath(import.meta.url))
const CHECK_TAG = 'cfg-server-foundryvtt:contract-check'

// ── THE DECLARED ADDITIVE SURFACE ───────────────────────────────────────────
// The ONE place a legitimately-added capability is declared. Everything else is
// compared against the base and must be identical. Adding a capability means
// editing THIS object — which is the point: the addition becomes reviewable.
export const ADDITIONS = {
  /** LABELs the wrapper sets. Four of these deliberately OVERRIDE felddy's own. */
  labels: {
    'org.opencontainers.image.title': 'cfg-server-foundryvtt',
    'org.opencontainers.image.description':
      'CFG server-side wrapper for FoundryVTT hosting — additive felddy superset',
    'org.opencontainers.image.source': 'https://github.com/Crit-Fumble/cfg-server-foundryvtt',
    'org.opencontainers.image.licenses': 'AGPL-3.0-only',
  },
  /**
   * ENV the wrapper adds, name -> its REQUIRED DEFAULT-OFF value. Empty today.
   * This is what makes "byte-identical until a capability is turned on"
   * machine-checked rather than aspirational: a capability shipping ON fails here.
   */
  env: {},
  /** Filesystem layers the wrapper adds. Zero today — the image is pure passthrough. */
  layers: 0,
  /**
   * Dockerfile instruction forms that may appear. A line matching none of these is
   * an undeclared instruction and fails. Comments and blanks are stripped first.
   */
  instructions: [/^FROM\s/i, /^LABEL\s/i],
}

/**
 * Instructions that may NEVER appear, no matter what ADDITIONS declares — each
 * would override part of the felddy contract this image exists to inherit.
 * `checkDockerfile` also refuses to let ADDITIONS.instructions whitelist one of
 * these, so the allowlist cannot be widened to sneak an ENTRYPOINT past family C.
 */
export const NEVER_IN_DOCKERFILE = [
  'ENTRYPOINT', // the whole reason this check exists — felddy's supervisor must stay PID 1
  'CMD', // core-server re-supplies Cmd from image config; an override desyncs it
  'USER', // uid 1000 is what every install tree on disk is owned by
  'WORKDIR', // `exec ./entrypoint.sh` is RELATIVE to /home/node
  'VOLUME', // /data is felddy's; a second VOLUME shadows bind mounts
  'EXPOSE',
  'HEALTHCHECK', // health `none` is read as READY by foundry-management.ts
  'ARG', // ⛔ `ARG FOUNDRY_VERSION` is a permanent anti-pattern here (Dockerfile header)
  'ONBUILD',
  'SHELL',
  'STOPSIGNAL', // SIGTERM is the only thing that unlocks the world's LevelDB
]

/** Absolute values cfg-core-server depends on at launch. Guards UPSTREAM drift. */
export const HARD_CONTRACT = {
  user: 'node',
  uid: 1000,
  gid: 1000,
  entrypoint: ['./entrypoint.sh'],
  workingDir: '/home/node',
  cmdMustContain: '--dataPath=/data',
  /** felddy's own files. An exact key set — a new or removed script fails too. */
  scripts: [
    'authenticate.js',
    'backoff.sh',
    'check_health.sh',
    'entrypoint.sh',
    'get_license.js',
    'get_release_url.js',
    'image_version.txt',
    'launcher.sh',
    'logging.js',
    'logging.sh',
    'patch_lang.js',
    'set_options.js',
    'set_password.js',
  ],
}

/**
 * cfg-core-server's container entrypoint override, VERBATIM from
 * foundry-management.ts:568. Copied rather than imported — this repo has no
 * dependency on core-server, and a copy that drifts is caught by H_OVERRIDE
 * failing, which is louder than a stale import would be.
 */
export const CORE_SERVER_ENTRYPOINT_OVERRIDE =
  'umask 0002; chmod -R g+w /data/Data/worlds /data/Config 2>/dev/null || true; exec ./entrypoint.sh "$@"'

// ═══════════════════════════════════════════════════════════════════════════
// PURE CORE — no IO. Every function takes facts and returns problem strings.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Split a Dockerfile into LOGICAL lines: comments and blanks dropped, backslash
 * continuations joined. Parser directives (`# syntax=`) are comments to this, and
 * are returned separately because they are not instructions but do affect builds.
 */
export function parseDockerfile(text) {
  const directives = []
  const logical = []
  let pending = ''
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!pending && /^\s*#/.test(line)) {
      const m = line.match(/^\s*#\s*(syntax|escape|check)\s*=\s*(.+?)\s*$/i)
      if (m) directives.push({ name: m[1].toLowerCase(), value: m[2] })
      continue
    }
    if (!pending && line.trim() === '') continue
    const joined = pending + line.replace(/\\\s*$/, '')
    if (/\\\s*$/.test(line)) {
      pending = joined
      continue
    }
    pending = ''
    if (joined.trim() !== '') logical.push(joined.trim())
  }
  if (pending.trim() !== '') logical.push(pending.trim())
  return { directives, logical }
}

/** Parse `LABEL key="value"` (single-pair form, which is all this Dockerfile uses). */
export function parseLabelLine(line) {
  const m = line.match(/^LABEL\s+([\w.\-]+)\s*=\s*"([^"]*)"\s*$/i)
  if (!m) return null
  return { key: m[1], value: m[2] }
}

/**
 * FAMILY C — the SOURCE stayed additive.
 * Returns [] when clean, else one string per problem.
 */
export function checkDockerfile(text, additions = ADDITIONS) {
  const problems = []
  const { logical } = parseDockerfile(text)

  // C6 first: the allowlist itself must not permit a NEVER instruction. Checked
  // before anything uses ADDITIONS.instructions, so widening it cannot help.
  for (const pat of additions.instructions) {
    for (const never of NEVER_IN_DOCKERFILE) {
      if (pat.test(`${never} x`)) {
        problems.push(
          `C6 ADDITIONS.instructions declares a pattern (${pat}) that would permit ${never}, ` +
            `which may never appear. The allowlist cannot be widened to admit it.`,
        )
      }
    }
  }

  // C4 — forbidden instructions, case-insensitive and indentation-tolerant.
  // `   entrypoint ["/x"]` builds and applies; matching /^ENTRYPOINT/ would miss it.
  for (const line of logical) {
    const keyword = (line.match(/^([A-Za-z]+)\b/) || [])[1]
    if (!keyword) continue
    const upper = keyword.toUpperCase()
    if (NEVER_IN_DOCKERFILE.includes(upper)) {
      problems.push(
        `C4 forbidden instruction ${upper} in the Dockerfile: ${JSON.stringify(line)}. ` +
          (upper === 'ENTRYPOINT'
            ? 'felddy\'s entrypoint + bash supervisor must stay PID 1 — a clean SIGTERM is the ' +
              'only thing that unlocks the world\'s LevelDB on shutdown.'
            : `${upper} overrides part of the felddy contract this image inherits.`),
      )
    }
  }

  // C1 — exactly one FROM, digest-pinned to felddy.
  const froms = logical.filter((l) => /^FROM\s/i.test(l))
  if (froms.length !== 1) {
    problems.push(`C1 expected exactly 1 FROM, found ${froms.length}`)
  } else if (!/^FROM\s+felddy\/foundryvtt@sha256:[0-9a-f]{64}\s*$/i.test(froms[0])) {
    problems.push(
      `C1 FROM must be felddy/foundryvtt pinned by DIGEST, got ${JSON.stringify(froms[0])}. ` +
        'A tag form floats: felddy rolled 14.361 -> 14.364 under this project once already.',
    )
  }

  // C2 — the declared LABELs, exactly: no missing, no extra, no duplicates, no drift.
  const seen = new Map()
  for (const line of logical.filter((l) => /^LABEL\s/i.test(l))) {
    const parsed = parseLabelLine(line)
    if (!parsed) {
      problems.push(`C2 unparseable LABEL (expected LABEL key="value"): ${JSON.stringify(line)}`)
      continue
    }
    if (seen.has(parsed.key)) problems.push(`C2 duplicate LABEL ${parsed.key}`)
    seen.set(parsed.key, parsed.value)
  }
  for (const [key, want] of Object.entries(additions.labels)) {
    if (!seen.has(key)) problems.push(`C2 declared LABEL ${key} missing from the Dockerfile`)
    else if (seen.get(key) !== want) {
      problems.push(`C2 LABEL ${key}: Dockerfile has ${JSON.stringify(seen.get(key))}, ADDITIONS declares ${JSON.stringify(want)}`)
    }
  }
  for (const key of seen.keys()) {
    if (!(key in additions.labels)) problems.push(`C2 undeclared LABEL ${key} — add it to ADDITIONS.labels or remove it`)
  }

  // C3 — no undeclared instruction of any kind.
  for (const line of logical) {
    if (!additions.instructions.some((p) => p.test(line))) {
      problems.push(`C3 undeclared instruction: ${JSON.stringify(line)} — declare it in ADDITIONS.instructions`)
    }
  }

  return problems
}

/**
 * FAMILY C, second file — the module's integration harness must run the SAME base
 * the wrapper ships.
 *
 * `module/tests/docker-compose.yml` used the rolling `felddy/foundryvtt:14` while
 * the Dockerfile pinned a digest. Both resolved identically the day this was
 * written, which is exactly why it was safe to pin and exactly why the drift would
 * have been invisible: felddy rolls `:14` (14.361 -> 14.364 stranded installs
 * once), so the licensed integration suite could go green against a base the
 * platform does not ship, and nothing would say so.
 *
 * Compares digests only. The harness's FOUNDRY_VERSION is deliberately NOT checked
 * — the Foundry APP version is per-install platform state resolved at launch, and
 * pinning it to the image would be the `ARG FOUNDRY_VERSION` anti-pattern the
 * Dockerfile forbids.
 */
export function checkHarnessBase(dockerfileText, composeText) {
  const problems = []
  const fromDigest = (dockerfileText.match(/^FROM\s+felddy\/foundryvtt@(sha256:[0-9a-f]{64})/im) || [])[1]
  const composeRef = (composeText.match(/^\s*image:\s*(felddy\/foundryvtt\S*)/im) || [])[1]

  if (!composeRef) {
    problems.push(
      'C7 module/tests/docker-compose.yml no longer names a felddy/foundryvtt image — ' +
        'if the harness moved to another base, update this check rather than deleting it',
    )
    return problems
  }
  const composeDigest = (composeRef.match(/@(sha256:[0-9a-f]{64})$/) || [])[1]
  if (!composeDigest) {
    problems.push(
      `C7 module/tests/docker-compose.yml uses ${composeRef} — a FLOATING tag. felddy rolls ` +
        '`:14`, so the licensed integration suite would silently test a base this repo does ' +
        'not ship. Pin it to the Dockerfile\'s digest.',
    )
  } else if (fromDigest && composeDigest !== fromDigest) {
    problems.push(
      `C7 the integration harness pins ${composeDigest.slice(0, 19)}… but the Dockerfile ships ` +
        `${fromDigest.slice(0, 19)}… — bump both together, or the suite proves the wrong base`,
    )
  }
  return problems
}

/** Deep structural equality for the plain JSON `docker image inspect` emits. */
export function deepEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
}

/** Split ["K=V", ...] into an ordered list of [k, v]. */
export function parseEnv(list) {
  return (list || []).map((e) => {
    const i = e.indexOf('=')
    return i === -1 ? [e, ''] : [e.slice(0, i), e.slice(i + 1)]
  })
}

/**
 * FAMILY P — the wrapper is an additive superset of the base it names.
 * `wrapper`/`base` are the OBJECTS from `docker image inspect --format '{{json .}}'`.
 */
export function checkPassthrough(wrapper, base, additions = ADDITIONS) {
  const problems = []

  // P1 — same platform, else every other comparison is noise. The pinned base is a
  // 4-platform manifest list; comparing two children of it finds nothing real.
  if (wrapper.Architecture !== base.Architecture || wrapper.Os !== base.Os) {
    problems.push(
      `P1 platform mismatch: wrapper ${wrapper.Os}/${wrapper.Architecture} vs base ${base.Os}/${base.Architecture}. ` +
        'Resolve both on the same host before comparing.',
    )
    return problems // everything downstream would be noise
  }

  // P2 — the base's layers are an unmodified PREFIX; additions are exactly declared.
  const wl = wrapper.RootFS?.Layers || []
  const bl = base.RootFS?.Layers || []
  const sharedOk = bl.every((l, i) => wl[i] === l)
  if (!sharedOk) {
    problems.push('P2 the base\'s own layers were MODIFIED — this is no longer a superset of the base, it is a fork of it')
  }
  const added = wl.length - bl.length
  if (added !== additions.layers) {
    problems.push(
      `P2 wrapper adds ${added} filesystem layer(s), ADDITIONS.layers declares ${additions.layers}`,
    )
  }

  // P3 — UNION SWEEP over Config, so a field nobody enumerated is still compared.
  // Labels and Env are handled separately (both have declared additions).
  const skip = new Set(['Labels', 'Env'])
  const keys = new Set([...Object.keys(wrapper.Config || {}), ...Object.keys(base.Config || {})])
  for (const k of keys) {
    if (skip.has(k)) continue
    if (!deepEqual(wrapper.Config?.[k], base.Config?.[k])) {
      problems.push(
        `P3 Config.${k} differs from the base: wrapper ${JSON.stringify(wrapper.Config?.[k])} vs base ${JSON.stringify(base.Config?.[k])}`,
      )
    }
  }

  // P4 — labels: base labels pass through; declared ones carry CFG values; no extras.
  const wLabels = wrapper.Config?.Labels || {}
  const bLabels = base.Config?.Labels || {}
  for (const [k, v] of Object.entries(bLabels)) {
    if (k in additions.labels) continue // deliberately overridden
    if (wLabels[k] !== v) {
      problems.push(`P4 inherited label ${k} changed: ${JSON.stringify(wLabels[k])} (base: ${JSON.stringify(v)})`)
    }
  }
  for (const [k, v] of Object.entries(additions.labels)) {
    if (wLabels[k] !== v) {
      problems.push(`P4 declared label ${k} is ${JSON.stringify(wLabels[k])}, expected ${JSON.stringify(v)}`)
    }
  }
  for (const k of Object.keys(wLabels)) {
    if (!(k in bLabels) && !(k in additions.labels)) {
      problems.push(`P4 undeclared label ${k} on the image`)
    }
  }

  // P5 — env: the base's env is an ordered PREFIX; additions exactly declared, each
  // carrying its default-OFF value. This is the "until a capability is turned on" half.
  const wEnv = parseEnv(wrapper.Config?.Env)
  const bEnv = parseEnv(base.Config?.Env)
  for (let i = 0; i < bEnv.length; i++) {
    const [bk, bv] = bEnv[i]
    const got = wEnv[i]
    if (!got || got[0] !== bk || got[1] !== bv) {
      const gotText = got ? `${got[0]}=${got[1]}` : 'nothing'
      problems.push(`P5 base ENV ${bk}=${bv} is missing or changed at position ${i} (got ${gotText})`)
    }
  }
  const extra = wEnv.slice(bEnv.length)
  for (const [k, v] of extra) {
    if (!(k in additions.env)) {
      problems.push(
        `P5 undeclared ENV ${k} added by the wrapper — declare it in ADDITIONS.env with its default-OFF value`,
      )
    } else if (additions.env[k] !== v) {
      problems.push(
        `P5 ENV ${k} ships as ${JSON.stringify(v)} but must default OFF as ${JSON.stringify(additions.env[k])}`,
      )
    }
  }
  for (const k of Object.keys(additions.env)) {
    if (!extra.some(([ek]) => ek === k)) {
      problems.push(`P5 declared ENV ${k} is not on the image`)
    }
  }

  return problems
}

/**
 * FAMILY H — absolute values + live-probe results. `probes` is the object main()
 * assembles; every field is REQUIRED, and a missing one is a FAILURE, never a skip
 * (empty output parsing as clean is this project's signature bug).
 */
export function checkHardContract(wrapper, probes, baseScripts, hard = HARD_CONTRACT, dockerfileText = '') {
  const problems = []
  const cfg = wrapper.Config || {}

  const need = (name, value) => {
    if (value === undefined || value === null || value === '') {
      problems.push(`H_PROBE ${name} produced no result — treat as FAILURE, never as a pass`)
      return false
    }
    return true
  }

  // H_USER — uid 1000:1000. Note: NOT 1000:1001; 1001 is CFG_DATA_GID, a
  // supplementary group core-server adds at launch, and the docs say otherwise.
  if (cfg.User !== hard.user) {
    problems.push(`H_USER Config.User is ${JSON.stringify(cfg.User)}, expected ${JSON.stringify(hard.user)}`)
  }
  if (need('uid', probes.uid) && Number(probes.uid) !== hard.uid) {
    problems.push(`H_USER runtime uid is ${probes.uid}, expected ${hard.uid} — every install tree on disk is owned by it`)
  }
  if (need('gid', probes.gid) && Number(probes.gid) !== hard.gid) {
    problems.push(`H_USER runtime gid is ${probes.gid}, expected ${hard.gid} (1001 is CFG_DATA_GID, a supplementary group added at launch — not this)`)
  }

  // H_ENTRYPOINT / H_WORKDIR — `exec ./entrypoint.sh` is RELATIVE.
  if (!deepEqual(cfg.Entrypoint, hard.entrypoint)) {
    problems.push(`H_ENTRYPOINT Config.Entrypoint is ${JSON.stringify(cfg.Entrypoint)}, expected ${JSON.stringify(hard.entrypoint)}`)
  }
  if (cfg.WorkingDir !== hard.workingDir) {
    problems.push(
      `H_WORKDIR Config.WorkingDir is ${JSON.stringify(cfg.WorkingDir)}, expected ` +
        `${JSON.stringify(hard.workingDir)} — the entrypoint path is relative to it`,
    )
  }

  // H_CMD — non-empty (entrypoint.sh dereferences $1 under `set -u`), and the data root.
  const cmd = cfg.Cmd || []
  if (!Array.isArray(cmd) || cmd.length === 0) {
    problems.push('H_CMD Config.Cmd is empty — entrypoint.sh reads "$1" under nounset, so this crash-loops with nothing in core-server\'s logs')
  } else {
    if (!/main\.mjs$/.test(cmd[0])) {
      problems.push(`H_CMD Cmd[0] is ${JSON.stringify(cmd[0])}, expected to end in main.mjs`)
    }
    if (!cmd.includes(hard.cmdMustContain)) {
      problems.push(
        `H_CMD Cmd lacks ${hard.cmdMustContain} — a moved data root makes every host-side ` +
          'read (license.json, module.json, world.json) silently see an empty tree',
      )
    }
  }

  // H_HEALTH — RANK 1. foundry-management.ts treats health `none` as READY, so an
  // image without a healthcheck makes EVERY launch platform-wide report ready early.
  const hc = cfg.Healthcheck
  if (!hc || !Array.isArray(hc.Test) || hc.Test.length === 0 || hc.Test[0] === 'NONE') {
    problems.push(
      'H_HEALTH the image declares no HEALTHCHECK — core-server reads health `none` as READY, ' +
        'so every launch would report ready before Foundry serves',
    )
  }

  // H_DATA_EMPTY — nothing baked under the VOLUME. This is why issue #1 was rejected:
  // the bind mount shadows anything COPY'd to /data.
  if (probes.dataEntries === undefined) problems.push('H_PROBE dataEntries missing — treat as FAILURE')
  else if (probes.dataEntries !== '') {
    problems.push(
      `H_DATA_EMPTY /data is not empty in the image: ${JSON.stringify(probes.dataEntries)} — a bind ` +
        'mount shadows it, so this ships nothing and hides that it ships nothing',
    )
  }

  // H_EXEC — the entrypoint is present and executable at the WORKDIR.
  if (need('entrypointExecutable', probes.entrypointExecutable) && probes.entrypointExecutable !== 'yes') {
    problems.push('H_EXEC ./entrypoint.sh is missing or not executable at the WORKDIR — `docker create` accepts this and it fails only at run time')
  }

  // H_SCRIPTS — THE COPY HIJACK. Config-identical, probe-identical, and still wrong.
  if (!probes.scriptDigests || Object.keys(probes.scriptDigests).length === 0) {
    problems.push('H_PROBE scriptDigests missing — treat as FAILURE')
  } else {
    const want = new Set(hard.scripts)
    const got = new Set(Object.keys(probes.scriptDigests))
    for (const s of want) if (!got.has(s)) problems.push(`H_SCRIPTS felddy script ${s} is missing from the image`)
    for (const s of got) if (!want.has(s)) problems.push(`H_SCRIPTS unexpected file /home/node/${s} — declare it or remove it`)
    for (const [name, digest] of Object.entries(probes.scriptDigests)) {
      const baseDigest = baseScripts?.[name]
      if (baseDigest && baseDigest !== digest) {
        problems.push(
          `H_SCRIPTS /home/node/${name} DIFFERS from the base (${baseDigest.slice(0, 12)}… -> ${digest.slice(0, 12)}…). ` +
            'A COPY over felddy\'s own scripts leaves Config deep-equal to the base and passes every other assertion here.',
        )
      }
    }
  }

  // H_OVERRIDE — core-server's VERBATIM entrypoint override still runs. Proves
  // WORKDIR resolution, the relative ./entrypoint.sh, and "$@" forwarding at once.
  if (need('overrideExit', probes.overrideExit) && Number(probes.overrideExit) !== 0) {
    problems.push(`H_OVERRIDE cfg-core-server's entrypoint override exited ${probes.overrideExit}, expected 0 — the hosted launch chain is broken`)
  }

  // H_VERSION — the Dockerfile's own stated felddy version vs the image's ENV.
  // Self-checking by design: upstream-watch rewrites the FROM digest and NOTHING
  // else, so a bump that moves the Foundry version goes red until a human reconciles
  // the header. No literal to rot in this file.
  const stated = (dockerfileText.match(/THE PIN BELOW IS felddy\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i) || [])[1]
  const envVersion = (parseEnv(cfg.Env).find(([k]) => k === 'FOUNDRY_VERSION') || [])[1]
  if (!stated) {
    problems.push(
      'H_VERSION the Dockerfile header no longer states the pinned felddy version ' +
        '("THE PIN BELOW IS felddy <x.y>") — that line is the check\'s only record of ' +
        'what the digest is supposed to be',
    )
  } else if (!envVersion) {
    problems.push('H_VERSION the image has no ENV FOUNDRY_VERSION — it decides which foundryvtt-<ver>.zip a fresh platform downloads')
  } else if (stated !== envVersion) {
    problems.push(
      `H_VERSION the Dockerfile header says felddy ${stated} but the image ships FOUNDRY_VERSION=${envVersion}. ` +
        'A digest bump moves this in total silence. While you are here, check that release.yml publishes a tag core-server will actually pull.',
    )
  }

  // H_PID1 / H_SIGTERM — felddy's bash supervisor is PID 1 and handles TERM promptly.
  if (need('pid1', probes.pid1) && !/entrypoint\.sh/.test(probes.pid1)) {
    problems.push(`H_PID1 PID 1 is ${JSON.stringify(probes.pid1)} — felddy's supervisor must be PID 1 or SIGTERM never reaches Foundry`)
  }
  if (probes.stopExitCode === undefined) problems.push('H_PROBE stopExitCode missing — treat as FAILURE')
  else if (Number(probes.stopExitCode) === 137) {
    problems.push(
      'H_SIGTERM the container was FORCE-KILLED (exit 137) instead of handling SIGTERM — ' +
        'a clean SIGTERM is the only thing that unlocks the world\'s LevelDB',
    )
  }
  if (probes.stopMs !== undefined && Number(probes.stopMs) > 5000) {
    problems.push(`H_SIGTERM the container took ${probes.stopMs}ms to stop — it is not handling SIGTERM promptly`)
  }

  return problems
}

// ═══════════════════════════════════════════════════════════════════════════
// IO SHELL
// ═══════════════════════════════════════════════════════════════════════════

/** Synchronous sleep — no subprocess, no async plumbing in a linear script. */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })

function inspect(ref) {
  return JSON.parse(sh('docker', ['image', 'inspect', '--format', '{{json .}}', ref]))
}

/** Read felddy's /home/node file digests out of an image. One container. */
function scriptDigests(ref) {
  const out = sh('docker', [
    'run', '--rm', '--entrypoint', 'sh', ref, '-c',
    'cd /home/node && sha256sum *.sh *.js image_version.txt 2>/dev/null',
  ])
  const map = {}
  for (const line of out.trim().split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/)
    if (m) map[m[2].trim()] = m[1]
  }
  return map
}

function fatal(msg) {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

function main() {
  const dockerfileText = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8')

  // ── FAMILY C first: no Docker, no pull. A forbidden instruction fails in <1s.
  // ⛔ A MISSING HARNESS IS A FAILURE, NOT A SKIP. Reading this with an
  // `existsSync ? … : ''` fallback meant deleting or moving the file silently
  // switched C7 off and the check still printed green — the same
  // empty-output-parses-as-clean shape H_PROBE exists to prevent. If the harness
  // genuinely moves, this check gets updated; it does not get to quietly lapse.
  const composePath = join(REPO_ROOT, 'module', 'tests', 'docker-compose.yml')
  const cProblems = [...checkDockerfile(dockerfileText)]
  if (existsSync(composePath)) {
    cProblems.push(...checkHarnessBase(dockerfileText, readFileSync(composePath, 'utf8')))
  } else {
    cProblems.push(
      `C7 ${composePath} is missing — the module integration harness is what C7 pins to the ` +
        'shipped base. If it moved, point this check at the new path rather than losing the guard.',
    )
  }

  // ⛔ STOP HERE IF THE SOURCE IS ALREADY INVALID. Family C needs no Docker, so a
  // forbidden instruction fails in <1s with no pull and no build. This is also a
  // correctness fix, not just a speed one: a Dockerfile with a bad ENTRYPOINT
  // produces an image whose probe containers cannot start, and the crash that
  // caused USED TO REPLACE the diagnosis with an execFileSync stack trace. The
  // mutation suite caught exactly that — the check failed for the wrong reason.
  if (cProblems.length > 0) {
    console.log('✗ C  Dockerfile source')
    for (const problem of cProblems) console.log(`    ${problem}`)
    console.error(`\n✗ felddy contract: ${cProblems.length} problem(s) in the Dockerfile itself. Image not built.`)
    process.exit(1)
  }
  console.log('✓ C  Dockerfile source')

  const from = (parseDockerfile(dockerfileText).logical.find((l) => /^FROM\s/i.test(l)) || '').replace(/^FROM\s+/i, '').trim()
  if (!from) fatal('no FROM line in the Dockerfile — cannot resolve the base to compare against')

  // ── Pull the base (retry: this is a required check and Docker Hub is a dependency)
  let pulled = false
  for (let attempt = 1; attempt <= 3 && !pulled; attempt++) {
    try {
      sh('docker', ['pull', '--quiet', from], { stdio: ['ignore', 'ignore', 'inherit'] })
      pulled = true
    } catch {
      if (attempt === 3) fatal(`could not pull the pinned base ${from} after 3 attempts`)
    }
  }

  sh('docker', ['build', '--quiet', '-t', CHECK_TAG, REPO_ROOT], { stdio: ['ignore', 'ignore', 'inherit'] })

  const wrapper = inspect(CHECK_TAG)
  const base = inspect(from)

  const pProblems = checkPassthrough(wrapper, base)

  // ── Probes. Every value is required; a missing one is a failure, never a skip.
  /**
   * Run a probe, converting ANY failure into a missing value.
   *
   * ⛔ NEVER let a probe throw. A broken image is precisely when probe containers
   * fail to start, so throwing here means the check crashes on the images it most
   * needs to diagnose. A missing value is not silently tolerated either — every
   * field is required, and `checkHardContract`'s `need()` turns absence into an
   * H_PROBE FAILURE. Missing must fail; it must never read as clean.
   */
  const probe = (name, fn) => {
    try {
      return fn()
    } catch (err) {
      console.error(`    (probe ${name} could not run: ${String(err.message || err).split('\n')[0]})`)
      return undefined
    }
  }

  const probes = {}
  // ⛔ KEY=VALUE, never positional lines. The first cut of this probe read results
  // by line INDEX, and `ls -A /data` on an empty dir emits NOTHING — not even a
  // newline — so every field below it shifted up by one and `/data is not empty:
  // "yes"` was reported against a perfectly good image. Positional parsing of
  // possibly-empty command output is a bug generator; the markers make a missing
  // value read as missing (which H_PROBE fails on) instead of as its neighbour.
  const PROBE_SCRIPT = [
    'echo "uid=$(id -u)"',
    'echo "gid=$(id -g)"',
    'echo "pwd=$(pwd)"',
    String.raw`echo "data=$(ls -A /data 2>/dev/null | tr '\n' ',')"`,
    'if test -x ./entrypoint.sh; then echo "exec=yes"; else echo "exec=no"; fi',
  ].join('; ')
  const idOut = probe('identity', () => sh('docker', ['run', '--rm', '--entrypoint', 'sh', CHECK_TAG, '-c', PROBE_SCRIPT])) || ''
  const kv = {}
  for (const line of idOut.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  probes.uid = kv.uid
  probes.gid = kv.gid
  probes.dataEntries = kv.data
  probes.entrypointExecutable = kv.exec

  probes.scriptDigests = probe('scriptDigests', () => scriptDigests(CHECK_TAG)) || {}
  const baseScripts = probe('baseScriptDigests', () => scriptDigests(from)) || {}

  // core-server's VERBATIM override; `--version` short-circuits entrypoint.sh
  // before any license, network or backoff work.
  try {
    sh(
      'docker',
      ['run', '--rm', '--entrypoint', '/bin/sh', CHECK_TAG, '-c', CORE_SERVER_ENTRYPOINT_OVERRIDE, 'cfg-perms', '--version'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    probes.overrideExit = 0
  } catch (err) {
    probes.overrideExit = err.status ?? 'no-exit-code'
  }

  // PID 1 + SIGTERM. CONTAINER_CACHE='' makes felddy's backoff sleep indefinitely
  // after its (expected, license-free) startup failure, which is what gives a
  // long-lived container with the real supervisor as PID 1 and no license.
  const name = `cfg-contract-probe-${process.pid}`
  try {
    probe('startForPid1', () => sh('docker', ['run', '-d', '--name', name, '-e', 'CONTAINER_CACHE=', CHECK_TAG], { stdio: ['ignore', 'ignore', 'pipe'] }))
    // Wait for PID 1 to settle into the supervisor.
    for (let i = 0; i < 40; i++) {
      try {
        const cmdline = sh('docker', ['exec', name, 'cat', '/proc/1/cmdline']).replace(/\0/g, ' ').trim()
        if (cmdline) { probes.pid1 = cmdline; break }
      } catch { /* container not ready yet */ }
      sleepSync(500)
    }
    const t0 = Date.now()
    if (probe('stop', () => sh('docker', ['stop', '-t', '30', name], { stdio: ['ignore', 'ignore', 'pipe'] })) !== undefined) {
      probes.stopMs = Date.now() - t0
      probes.stopExitCode = probe('exitCode', () => sh('docker', ['inspect', '-f', '{{.State.ExitCode}}', name]).trim())
    }
  } finally {
    try { sh('docker', ['rm', '-f', name], { stdio: 'ignore' }) } catch { /* already gone */ }
  }

  const hProblems = checkHardContract(wrapper, probes, baseScripts, HARD_CONTRACT, dockerfileText)

  // ── Report
  const families = [
    ['P  passthrough vs base', pProblems],
    ['H  hard contract', hProblems],
  ]
  let failed = 0
  for (const [label, problems] of families) {
    if (problems.length === 0) {
      console.log(`✓ ${label}`)
    } else {
      failed += problems.length
      console.log(`✗ ${label}`)
      for (const p of problems) console.log(`    ${p}`)
    }
  }
  console.log(`\nbase:    ${from}`)
  console.log(`platform: ${wrapper.Os}/${wrapper.Architecture} (the pinned base is a multi-platform list; this proves ONE platform)`)
  console.log(
    `probes:  uid=${probes.uid}:${probes.gid} pid1=${JSON.stringify(probes.pid1)} ` +
      `stop=${probes.stopMs}ms exit=${probes.stopExitCode} scripts=${Object.keys(probes.scriptDigests).length}`,
  )

  if (failed) {
    console.error(`\n✗ felddy contract: ${failed} problem(s). This image is not the additive superset it claims to be.`)
    process.exit(1)
  }
  console.log('\n✓ felddy contract holds — additive superset of the pinned base, and the values core-server depends on are intact.')
  console.log('  ⚠️  NOT proven here (needs a licensed Foundry, lives in e2e/): license host-binding,')
  console.log('      admin.txt authenticating, the LevelDB unlock on shutdown, the /join /setup surface.')
}

if (import.meta.url === `file://${process.argv[1]}`) main()
