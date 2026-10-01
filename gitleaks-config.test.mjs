// .gitleaks.toml, run through the real gitleaks binary.
//
// WHY (2026-10-01): the global allowlist carried '=\s*$' with the default
// regexTarget, which is the SECRET, not the line. So every base64 secret ending
// in '=' padding was silently allowlisted, and cfg-auth-secret took the KEY NAME
// as its secret, so --redact printed the value. These tests pin the semantics a
// regex reading of the TOML cannot show: what each allowlist entry is tested
// against. Same fix and test as cfg-core-dev-tools (dev/scripts/gitleaks-config.test.mjs).
//
// Skips (loudly) where gitleaks is absent, e.g. the ubuntu-latest CI runners.
// The pre-commit hook uses it when installed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const CONFIG = fileURLToPath(new URL('./.gitleaks.toml', import.meta.url))
const HAVE_GITLEAKS = spawnSync('gitleaks', ['version']).status === 0
const skip = HAVE_GITLEAKS ? false : 'gitleaks is not on PATH, so .gitleaks.toml is UNTESTED here (brew install gitleaks)'

// Generated, never literal. 32 random bytes encode to 44 chars ending in one '='.
const padded = () => {
  const v = randomBytes(32).toString('base64')
  assert.match(v, /[^=]=$/)
  return v
}

// Scan `files` ({ relativePath: text }) with --no-git from inside a temp dir, so
// reported paths are relative like a real scan's. Returns the findings and the
// raw report text (to check that redaction hid the value).
function scan(files, config = CONFIG) {
  const root = mkdtempSync(join(tmpdir(), 'gitleaks-cfg-'))
  try {
    const src = join(root, 'src')
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(src, path)), { recursive: true })
      writeFileSync(join(src, path), text)
    }
    const report = join(root, 'report.json')
    const r = spawnSync('gitleaks', [
      'detect', '--no-git', '--source', '.', '--config', config, '--redact', '--no-banner',
      '--report-format', 'json', '--report-path', report, '--exit-code', '0', '--log-level', 'error',
    ], { cwd: src, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const raw = readFileSync(report, 'utf8')
    const findings = JSON.parse(raw).map((f) => ({ rule: f.RuleID, file: f.File, line: f.StartLine }))
    return { findings, raw }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const AUTH = 'AUTH_SECRET'

const has = (findings, rule, file, line) => findings.some((f) => f.rule === rule && f.file === file && f.line === line)

test("a base64 secret ending in '=' is flagged by each CFG rule, and redacted", { skip }, () => {
  const [auth, livekit, quoted] = [padded(), padded(), padded()]
  const { findings, raw } = scan({
    'app.env': `${AUTH}=${auth}\nLIVEKIT_API_SECRET=${livekit}\nCORE_SECRET="${quoted}"\n`,
  })
  assert.ok(has(findings, 'cfg-auth-secret', 'app.env', 1), JSON.stringify(findings))
  assert.ok(has(findings, 'livekit-secret', 'app.env', 2), JSON.stringify(findings))
  assert.ok(has(findings, 'cfg-auth-secret', 'app.env', 3), JSON.stringify(findings))
  // --redact masks the rule's SECRET. If that were the key name (cfg-auth-secret
  // before 2026-10-01), CI logs would print the value in clear.
  for (const v of [auth, livekit, quoted]) assert.ok(!raw.includes(v.slice(0, 40)), 'a value survived --redact')
})

test('a value on the line after an empty key is not exempt', { skip }, () => {
  const { findings } = scan({ 'app.env': `${AUTH}=\n${padded()}\n` })
  assert.ok(has(findings, 'cfg-auth-secret', 'app.env', 1), JSON.stringify(findings))
})

test('genuinely empty assignments still pass', { skip }, () => {
  const empties = [`${AUTH}=`, 'export LIVEKIT_API_SECRET=', "CORE_SECRET=''"].join('\n')
  assert.deepEqual(scan({ 'app.env': `${empties}\n` }).findings, [])

  // No shipped rule matches a bare key, so on its own the case above passes
  // with or without the empty-assignment entry. A probe rule that DOES match
  // the key proves the entry is what exempts it, and only when the value is empty.
  const root = mkdtempSync(join(tmpdir(), 'gitleaks-probe-'))
  try {
    const probe = join(root, 'probe.toml')
    writeFileSync(probe, `${readFileSync(CONFIG, 'utf8')}
[[rules]]
id = "probe-key-name"
description = "test-only: flags the key, whatever its value"
regex = '''(?:PROBE_KEY|probeKey)["']?[ \\t]*[:=]'''
`)
    const ok = ['PROBE_KEY=', 'export PROBE_KEY=', "PROBE_KEY=''", 'PROBE_KEY: ""', '  "probeKey": "",', 'PROBE_KEY := ']
    for (const line of ok) assert.deepEqual(scan({ 'a.env': `${line}\n` }, probe).findings, [], line)
    for (const line of ['PROBE_KEY=x', '"probeKey": "v",', 'PROBE_KEY= # set me']) {
      assert.equal(scan({ 'a.env': `${line}\n` }, probe).findings.length, 1, line)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
