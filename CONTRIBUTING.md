# Contributing to cfg-server-foundryvtt

This is CFG's **server-side wrapper image** for FoundryVTT hosting — a strict
*additive* superset of the upstream `felddy/foundryvtt` image (see the README's
"Design" section). Most of the repo is a Dockerfile plus a Playwright e2e
environment; there is no long-running `npm run dev`.

## What you need

- **Docker** (with BuildKit) — the primary artifact is a container image.
- **Node.js >= 24** (see `.nvmrc`) — only for the e2e harness
  (`@playwright/test`, `classic-level`).

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

## Commit messages & PRs

Use [Conventional Commits](https://www.conventionalcommits.org/)
(`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`). Fork, branch
from `main`, keep changes additive/reversible, run the e2e suite for anything that
touches the image or its entrypoint, and explain the *why* in the PR description.

## License

Contributions are accepted under [AGPL-3.0-only](./LICENSE). By submitting a PR
you agree your contribution may be distributed under that license.
