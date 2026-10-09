// .gitleaks.toml, run through the real gitleaks binary.
//
// WHY: an allowlist regex is tested against its regexTarget — by default the
// SECRET, not the line — so an anchored '=\s*$' silently allowlists every base64
// secret ending in '=' padding, and a rule whose first capture group is the KEY
// NAME makes --redact print the value. These tests pin the semantics a regex
// reading of the TOML cannot show: what each allowlist entry is tested against.
// Same test as cfg-core-dev-tools (dev/scripts/gitleaks-config.test.mjs).
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
  // --redact masks the rule's SECRET. If that were the key name, CI logs would
  // print the value in clear.
  for (const v of [auth, livekit, quoted]) assert.ok(!raw.includes(v.slice(0, 40)), 'a value survived --redact')
})

test('a value on the line after an empty key is not exempt', { skip }, () => {
  const { findings } = scan({ 'app.env': `${AUTH}=\n${padded()}\n` })
  assert.ok(has(findings, 'cfg-auth-secret', 'app.env', 1), JSON.stringify(findings))
})

test('genuinely empty assignments pass because no rule matches a bare key', { skip }, () => {
  const empties = [`${AUTH}=`, 'export LIVEKIT_API_SECRET=', "CORE_SECRET=''"].join('\n')
  assert.deepEqual(scan({ 'app.env': `${empties}\n` }).findings, [])
})

// dt#724: a line-target entry exempting any line that ends in '=' or ':' also
// exempted a token alone on such a line. No allowlist entry may test the line.
test("a token alone on a line before '=' or ':' is flagged", { skip }, () => {
  const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const pat = () => `ghp_${Array.from(randomBytes(36), (b) => alnum[b % alnum.length]).join('')}`
  const { findings } = scan({ 'a.env': `${pat()}=\n${pat()}:\n  ${pat()} =\n` })
  for (const line of [1, 2, 3]) assert.ok(has(findings, 'github-pat', 'a.env', line), JSON.stringify(findings))
  assert.doesNotMatch(readFileSync(CONFIG, 'utf8'), /regexTarget\s*=\s*"line"/)
})

test('the path allowlist is anchored at the repo root', { skip }, () => {
  const env = `${AUTH}=${padded()}\n`
  // Exempt: the paths as written.
  assert.deepEqual(scan({ '.env.local.example': env, 'module/package-lock.json': env }).findings, [])
  // Not exempt: lookalikes the unanchored patterns used to match, and entries this repo dropped.
  const near = ['tests/a.env', 'config/a.json', 'docs/a.env']
  const { findings } = scan(Object.fromEntries(near.map((p) => [p, env])))
  for (const p of near) assert.ok(has(findings, 'cfg-auth-secret', p, 1), `${p} ${JSON.stringify(findings)}`)
})
