# CFG Server Manager module — tests

Two suites live here, and they have nothing in common except the directory:

| suite | what it is | needs a licensed Foundry? |
|---|---|---|
| `unit/` | jest, pure decision logic | no — this is what CI Gate runs |
| `integration/` | Playwright against a REAL Foundry in Docker | **yes** |

If a command below stops matching `module/package.json`, fix the doc rather than
adding the script.

## Unit suite

```bash
cd module
npm ci
npm test              # jest — also run by the repo-root husky hooks and CI Gate
```

## Integration suite

Drives the specs in `integration/specs/` — the JSON editor, the document health
probe, API-key auth, the module contract, the system-schema descriptor, quest
sync and world/campaign links.

**One-time setup.** Copy `.env.test.example` to `.env.test` and fill it in.
⛔ Two of its keys are **host paths with no defaults** — `FOUNDRY_CACHE_DIR` and
`FOUNDRY_SYSTEMS_DIR`. Miss them and compose fails with a bare "variable is not
set" that names neither this file nor what it wanted. The example explains what
each should point at.

```bash
cd module
npm run test:foundry:all     # up → test → down, the usual entry point
```

Or step through it:

```bash
npm run test:foundry:up      # stage the runtime world, start compose, run foundry-setup
npm run test:foundry         # playwright
npm run test:foundry:ui      # playwright --ui, for development
npm run test:foundry:down    # tear down AND delete fixtures/.worlds-runtime
```

**The world you test against is a disposable copy.** `test:foundry:stage` copies
`fixtures/worlds/` to `fixtures/.worlds-runtime/`, which is what gets mounted —
Foundry mutates it freely and the tracked template stays clean. `down` deletes
it, so a re-run starts from the template again.

**Iterating on module source.** The module dir is bind-mounted live, but a
cache-busted `import(url + '?v=…')`, the pattern `document-health-probe.spec.js`
uses, re-fetches only that one file. Its own imports stay cached in the page's
module map, so reload the page before trusting a re-test of an edited dependency.

## Two pins that are deliberate, not drift

- **The base image** is the same digest `../../Dockerfile` pins, not the rolling
  `felddy/foundryvtt:14`. felddy rolls that tag (14.361 → 14.364 stranded
  installs once), so a floating base could make this suite green against
  something the platform does not ship. `check-felddy-contract.mjs` (C7) fails
  if the two ever disagree.
- **`FOUNDRY_VERSION` is 14.361**, which is *older* than the base image's own
  default. That is on purpose: 14.361 is what `module.json` declares
  `compatibility.verified` and what the fixture world pins as `coreVersion` and
  `minimum`. Bumping it is a **compatibility bump** — move `module.json`, the
  fixture world and the compose default together — not a version tidy-up.

## When something breaks

The two failures worth naming because they look like bugs and are not:

- **compose exits immediately, "variable is not set"** — `.env.test` is missing
  one of the two host paths above.
- **felddy bails on its README scan (EACCES)** — a mounted parent ended up
  root-owned. Mount the *whole* systems dir, never a subdir.
