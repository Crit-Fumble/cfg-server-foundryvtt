#!/usr/bin/env bash
# Boot the wrapper image, wait for Foundry to serve, run the Playwright suite,
# tear the container down (data + cache copies kept so re-runs are fast and the
# license isn't re-activated).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# Load e2e/.env into THIS shell (`set -a` = export, so compose interpolation
# and the Playwright process both inherit it). It must load before ANY of the
# resolution below — E2E_FOUNDRY_PORT, FOUNDRY_STORAGE_ROOTS, FOUNDRY_CACHE_DIR,
# FOUNDRY_WORLD_SRC and E2E_LICENSED_MODULES are all documented as .env-settable,
# but the file was only ever CHECKED for existence, never loaded: a .env-only
# override silently fell back to its default, exactly the quiet-wrong-resolution
# failure the storage-root block below exists to prevent.
if [ ! -f "$HERE/.env" ]; then
  echo "✗ $HERE/.env missing — copy e2e/.env.example and set FOUNDRY_LICENSE_KEY" >&2
  exit 1
fi
set -a; . "$HERE/.env"; set +a

PORT="${E2E_FOUNDRY_PORT:-30001}"
COMPOSE="docker compose -f $HERE/compose.yml"
# ── Where the seed fixtures come from ───────────────────────────────────────
# ⛔ THE PROVISIONED INSTALL MOVES BETWEEN STORAGE ROOTS, so resolve across the
# known ones and SAY which won — never hardcode a single root again.
#
# Both defaults here pointed at `cfg_user_storage`, the DEV stack's root
# (docker-compose.dev.yml). That stack's storage is now EMPTY — 0 users — while
# the same install (same user id, same installation id, and crucially the same
# SIGNED, host-bound license.json) sits under `e2e_cfg_user_storage`. The old
# default resolved to a path that no longer exists, so the suite could not run
# at all.
#
# Unrunnable is the mild failure. Resolving QUIETLY to the wrong place is the
# bad one — see the plugin-source note further down, where a default that
# silently resolved to a sibling checkout left every rung of this suite green
# against a module this repo does not publish. Hence: echo the winner, and fail
# listing every candidate tried.
STATE_DIR="${CFG_DEV_STATE:-$REPO/../../.dev-state}"
# Newest-known root first.
STORAGE_ROOTS="${FOUNDRY_STORAGE_ROOTS:-$STATE_DIR/e2e_cfg_user_storage $STATE_DIR/cfg_user_storage}"
INSTALL_REL="users/d637ce7b-fdad-454c-bfcd-041a5a9c3dec/installations/cmpj7j1on0000lhlpas58x149/data"

# Source Foundry release cache to seed an isolated writable copy from (so the dev
# cache is never mutated). Override via FOUNDRY_CACHE_DIR in e2e/.env.
DEV_CACHE="${FOUNDRY_CACHE_DIR:-}"
if [ -z "$DEV_CACHE" ]; then
  for _root in $STORAGE_ROOTS; do
    if ls "$_root/platform/foundry/cache"/foundryvtt-*.zip >/dev/null 2>&1; then
      DEV_CACHE="$_root/platform/foundry/cache"
      echo "→ Foundry cache source: $DEV_CACHE"
      break
    fi
  done
fi

# Seed the isolated, writable cache once (felddy writes CACHEDIR.TAG/backoff here).
if [ ! -d "$HERE/.e2e-cache" ] || [ -z "$(ls -A "$HERE/.e2e-cache" 2>/dev/null)" ]; then
  if [ -d "$DEV_CACHE" ]; then
    echo "→ seeding e2e/.e2e-cache from $DEV_CACHE (one-time)"
    mkdir -p "$HERE/.e2e-cache"; cp -R "$DEV_CACHE/." "$HERE/.e2e-cache/"
  else
    echo "→ no source cache at $DEV_CACHE — felddy will download (needs FOUNDRY_USERNAME/PASSWORD in .env)"
    mkdir -p "$HERE/.e2e-cache"
  fi
fi

# Seed the test world + its system (dnd5e) + the CFG plugin + the SIGNED license
# once, so the standalone Foundry can launch a REAL world for the provisioning
# suite. Source = a provisioned Foundry install's data dir (the dev install by
# default); override via FOUNDRY_WORLD_SRC. globalSetup launches the world via
# the admin API. The license is the dev install's signed, host-bound one; the
# container hostname (compose) matches its host so Foundry accepts it without a
# fresh activation (which would hit Foundry's per-license activation limit).
WORLD_SRC="${FOUNDRY_WORLD_SRC:-}"
if [ -z "$WORLD_SRC" ]; then
  for _root in $STORAGE_ROOTS; do
    if [ -d "$_root/$INSTALL_REL/Data/worlds/test-world" ]; then
      WORLD_SRC="$_root/$INSTALL_REL"
      echo "→ world/license source: $WORLD_SRC"
      break
    fi
  done
fi
if [ ! -d "$HERE/.e2e-data/Data/worlds/test-world" ]; then
  if [ -d "$WORLD_SRC/Data/worlds/test-world" ]; then
    echo "→ seeding test-world + dnd5e + crit-fumble-core plugin + signed license from $WORLD_SRC (one-time)"
    mkdir -p "$HERE/.e2e-data/Data/worlds" "$HERE/.e2e-data/Data/systems" "$HERE/.e2e-data/Data/modules" "$HERE/.e2e-data/Config"
    cp -R "$WORLD_SRC/Data/worlds/test-world" "$HERE/.e2e-data/Data/worlds/"
    cp -R "$WORLD_SRC/Data/systems/dnd5e" "$HERE/.e2e-data/Data/systems/"
    [ -f "$WORLD_SRC/Config/license.json" ] && cp "$WORLD_SRC/Config/license.json" "$HERE/.e2e-data/Config/license.json"
  else
    echo "✗ no world source found — set FOUNDRY_WORLD_SRC to a provisioned Foundry data dir." >&2
    echo "  Needs <src>/Data/worlds/test-world; tried (in order):" >&2
    for _root in $STORAGE_ROOTS; do echo "    $_root/$INSTALL_REL" >&2; done
    exit 1
  fi
fi

# Re-seed the crit-fumble-core module from LOCAL SOURCE every run — the dev
# install's copy predates the ProvisionDrain (added in plugin v2.2.0); the source
# is the current code. Only the Foundry-served files (not node_modules/tests/dist).
#
# ⛔ THE SOURCE IS THIS REPO'S OWN `module/`, AND THAT IS THE WHOLE POINT.
# It defaulted to `$REPO/../cfg-foundry-plugin` until 2026-08-07 — a sibling
# checkout that still exists on every dev machine, so the default resolved
# silently and this suite proved the PRE-SPLIT plugin (2.48.3, 3D included)
# while the image and the release channel shipped `module/` (CFG Server Manager
# 3.0.0). Every rung below — world-active, service-gm-join, provision-drain,
# session-epoch-restart, driver — was green against a module this repo does not
# publish. Nothing failed, which is exactly why it survived the merge.
PLUGIN_SRC="${CFG_PLUGIN_SRC:-$REPO/module}"
if [ ! -f "$PLUGIN_SRC/module.json" ]; then
  echo "✗ no module source at $PLUGIN_SRC (expected module.json) — set CFG_PLUGIN_SRC" >&2
  exit 1
fi
echo "→ seeding crit-fumble-core module from $PLUGIN_SRC"
MOD="$HERE/.e2e-data/Data/modules/crit-fumble-core"
rm -rf "$MOD"; mkdir -p "$MOD"
# No `|| true` here: `rm -rf` already ran, so a swallowed copy failure leaves a
# PARTIAL module and the suite reports on something that was never installed.
cp -R "$PLUGIN_SRC/module.json" "$PLUGIN_SRC/scripts" "$PLUGIN_SRC/styles" "$PLUGIN_SRC/lang" "$MOD/"
# Say which module actually landed. The bug above was invisible for want of one
# line of output — both sources carry id `crit-fumble-core`, so only the VERSION
# distinguishes the shipped module from the retiring plugin.
echo "  installed $(node -p "require('$MOD/module.json').title + ' ' + require('$MOD/module.json').version")"

# ── Licensed / extra modules ─────────────────────────────────────────────────
# Seed every OTHER module the source install carries (premium 5e content and
# its utility dependencies) so the suite can exercise real licensed data
# models and sheets. Per-module and one-time: a module already present in
# .e2e-data is left alone, so a re-run never clobbers state.
#
# ⛔ LICENSED CONTENT NEVER ENTERS THIS REPO. The source install and .e2e-data
# are both gitignored; this copy is local plumbing for content the fixture
# license already owns. To add content: put the module into the source
# install's Data/modules/, then list the ids in E2E_LICENSED_MODULES
# (e2e/.env) — licensed-modules.spec.ts fails on any listed id that did not
# land, and SKIPS (loudly, as UNVERIFIED) when the variable is unset, so
# machines without the content stay honest.
#
# ⚠️ PROTECTED (premium) MODULES CANNOT BE COPIED IN FROM ANOTHER INSTALL.
# Their signature.json is bound to the license that installed them; under any
# other license Foundry logs "Invalid signature file for protected module"
# (Logs/debug-*.log) and silently EXCLUDES the module from its package index —
# game.modules never sees it. Measured 2026-08-15: all 7 premium modules
# rsync'd from a prod install failed exactly this way. Install them ONCE
# through THIS container's setup UI (compose up, /setup, Premium Content) so
# foundryvtt.com issues signatures for the fixture license, then copy the
# freshly-signed dirs back to the source install so reseeds survive.
if [ -n "${WORLD_SRC:-}" ] && [ -d "$WORLD_SRC/Data/modules" ]; then
  SEEDED_MODS=""
  for _mod in "$WORLD_SRC"/Data/modules/*/; do
    [ -d "$_mod" ] || continue
    _id="$(basename "$_mod")"
    [ "$_id" = "crit-fumble-core" ] && continue # always re-seeded from module/ above
    if [ ! -d "$HERE/.e2e-data/Data/modules/$_id" ]; then
      cp -R "$_mod" "$HERE/.e2e-data/Data/modules/$_id"
      SEEDED_MODS="$SEEDED_MODS $_id"
    fi
  done
  [ -n "$SEEDED_MODS" ] && echo "→ seeded extra modules from source install:$SEEDED_MODS"
fi

# Pin the Foundry version to whatever release the cache actually holds, so felddy
# installs from cache instead of trying to fetch the build it defaults to.
ZIP="$(ls "$HERE/.e2e-cache"/foundryvtt-*.zip 2>/dev/null | head -1 || true)"
if [ -n "$ZIP" ]; then
  export FOUNDRY_VERSION="$(basename "$ZIP" | sed -E 's/foundryvtt-([0-9.]+)\.zip/\1/')"
  echo "→ cache holds Foundry $FOUNDRY_VERSION"
fi

cleanup() { $COMPOSE down >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "→ building wrapper image (cfg-server-foundryvtt:local)"
(cd "$REPO" && DOCKER_BUILDKIT=1 docker build -q -t cfg-server-foundryvtt:local . >/dev/null)

# ⛔ CLEAR A STALE FOUNDRY DATA-DIR LOCK BEFORE BOOTING.
# Foundry guards /data with a proper-lockfile-style lock DIRECTORY
# (Config/options.json.lock) and refuses to start while it looks live:
#   "Foundry VTT cannot start in this directory which is already locked by
#    another process"
# felddy answers that with "Failure 1 detected (exit code 1). Exiting
# immediately" — no retry — so the container never serves and the whole run dies
# in the wait loop below, before a single spec executes.
#
# A shutdown that does not finish in time leaves that lock behind with a fresh
# mtime, and the next boot lands inside the staleness window. Measured
# 2026-08-15 this alternated exactly: a passing run left the lock, the next run
# failed to boot, its ~4min timeout aged the lock past stale, the run after
# passed. Clearing it here is safe by construction — `down` first, so no
# container can still hold /data.
$COMPOSE down >/dev/null 2>&1 || true
rm -rf "$HERE/.e2e-data/Config/options.json.lock"

echo "→ starting Foundry"
$COMPOSE up -d

echo "→ waiting for Foundry to serve on :$PORT"
for i in $(seq 1 80); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" 2>/dev/null || true)"
  case "$code" in
    2*|3*|4*) echo "  up (HTTP $code)"; break ;;
  esac
  if [ "$i" = 80 ]; then echo "✗ Foundry did not serve — logs:"; $COMPOSE logs --tail=40; exit 1; fi
  sleep 3
done

echo "→ running Playwright suite"
(cd "$REPO" && npx playwright test "$@")
