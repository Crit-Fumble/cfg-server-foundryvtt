# Contributing to cfg-server-foundryvtt

This is CFG's **server-side wrapper image** for FoundryVTT hosting — a strict
*additive* superset of the upstream `felddy/foundryvtt` image (see the README's
"Design" section) — plus the **CFG Server Manager** Foundry module under
`module/` (see the README's module section). There is no long-running
`npm run dev`.

## What you need

- **Docker** (with BuildKit) — the primary artifact is a container image.
- **Node.js >= 24** (see `.nvmrc`) — for the e2e harness and the module's
  jest suite.

## Build & run the image

```bash
npm run image:build      # DOCKER_BUILDKIT=1 docker build -t cfg-server-foundryvtt:local .
# runs exactly like felddy/foundryvtt (same FOUNDRY_* env contract):
docker run --rm -p 30000:30000 -v "$PWD/data:/data" cfg-server-foundryvtt:local
```

The base build is a pure passthrough and needs no npm auth or secrets. Keep every
change **additive and reversible** — the README's migration section is the
contract; a wrapper that diverges from felddy's env/volume contract is a bug.

## End-to-end tests

The e2e environment brings up the wrapper in Docker and drives it with Playwright.

```bash
cp e2e/.env.example e2e/.env    # e2e config (Foundry credentials, etc.)
npm run e2e                     # bash e2e/run.sh — full up → test → down
npm run e2e:up                  # bring the compose stack up (--wait)
npm run e2e:logs                # follow logs
npm run e2e:down                # tear down (-v)
```

`e2e/` bakes a real dnd5e system fixture and serves Foundry on `:30000`. See
`e2e/run.sh` for the flow.

## The Server Manager module (`module/`)

The module has its own npm install (`@crit-fumble/shared` comes from GitHub
Packages — see `module/.npmrc` for the local auth one-liner) and its own suites:

```bash
cd module
env "npm_config_//npm.pkg.github.com/:_authToken=$(gh auth token)" npm ci
npm test                 # jest unit suite — this is what CI Gate runs
npm run build:zip        # pack smoke: dist/module.json + dist/module.zip
npm run test:foundry:up  # integration stack (needs a licensed Foundry account —
npm run test:foundry     #   see module/tests/.env.test.example)
```

Husky pre-commit/pre-push at the repo root run the module's unit tests. The
module id `crit-fumble-core` must never change (worlds key their enable flag on
it), and `module.json` is the module's **only** version source.

## Commit messages & PRs

Use [Conventional Commits](https://www.conventionalcommits.org/)
(`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`). Fork, branch
from `next` (the release-candidate branch — `main` is released truth and is
only ever fast-forwarded to), keep changes additive/reversible, run the e2e suite for anything that
touches the image or its entrypoint, and explain the *why* in the PR description.

## License

Contributions are accepted under [AGPL-3.0-only](./LICENSE). By submitting a PR
you agree your contribution may be distributed under that license.
