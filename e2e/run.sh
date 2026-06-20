#!/usr/bin/env bash
# Boot the wrapper image, wait for Foundry to serve, run the Playwright suite,
# tear the container down (data + cache copies kept so re-runs are fast and the
# license isn't re-activated).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PORT="${E2E_FOUNDRY_PORT:-30001}"
COMPOSE="docker compose -f $HERE/compose.yml"
# Source Foundry release cache to seed an isolated writable copy from (so the dev
# cache is never mutated). Override via FOUNDRY_CACHE_DIR in e2e/.env.
DEV_CACHE="${FOUNDRY_CACHE_DIR:-$REPO/../../.dev-state/cfg_user_storage/platform/foundry/cache}"

if [ ! -f "$HERE/.env" ]; then
  echo "✗ $HERE/.env missing — copy e2e/.env.example and set FOUNDRY_LICENSE_KEY" >&2
  exit 1
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
