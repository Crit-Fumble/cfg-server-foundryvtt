/**
 * felddy-contract-rules — the PURE decisions behind check-felddy-contract.
 *
 * Split out of check-felddy-contract.mjs on 2026-08-15 at 793 of the 800-line
 * hard max. The cut is the one that file's own header already described, not a
 * new idea: every function here takes plain facts and returns problem strings,
 * and every docker call lives in the IO shell next door. That split is what lets
 * felddy-contract-rules.test.mjs mutate facts offline — no Docker, no registry,
 * no network — and prove each rule can actually go RED.
 *
 * Read check-felddy-contract.mjs first: it carries the WHY (the three families,
 * the three traps, and what a green here does not mean).
 *
 * ⚠️ Nothing in this file may import node:child_process, node:fs, or anything
 * else with IO. The moment it does, the offline suite stops being offline and
 * the mutation tests start needing a Docker daemon to run.
 */

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
