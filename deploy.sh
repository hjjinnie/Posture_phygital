#!/usr/bin/env bash
# Publishes the latest commit to https://posture-buddy.pages.dev (Cloudflare Pages): the static app plus the study
# data API (functions/, D1 database in wrangler.toml). Uploads committed files only, so data/ and anything uncommitted
# never leave this Mac, minus the Pi, ESP32 and local-server files the hosted site can't use.
# Needs Node 18+ (uses Homebrew's node@20 if the default is older).
#   ./deploy.sh          deploy
#   ./deploy.sh --dev    run the same bundle locally (wrangler pages dev, local test database) instead
set -euo pipefail
cd "$(dirname "$0")"
[ -x /usr/local/opt/node@20/bin/node ] && export PATH="/usr/local/opt/node@20/bin:$PATH"
[ -x /opt/homebrew/opt/node@20/bin/node ] && export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
if [ -n "$(git status --porcelain)" ]; then echo "Note: uncommitted changes are not deployed (commit them first)."; fi
OUT="${BUNDLE_DIR:-$(mktemp -d)}"
[ -z "${BUNDLE_DIR:-}" ] && trap 'rm -rf "$OUT"' EXIT
rm -rf "$OUT/site" "$OUT/functions"; mkdir -p "$OUT/site"
git archive HEAD | tar -x -C "$OUT/site"
mv "$OUT/site/functions" "$OUT/functions"
mv "$OUT/site/wrangler.toml" "$OUT/wrangler.toml"
rm -rf "$OUT/site/esp32" "$OUT/site/pi" "$OUT/site/serve.py" "$OUT/site/deploy.sh" "$OUT/site/.gitignore"
cd "$OUT"
if [ "${1:-}" = "--dev" ]; then
  exec npx --yes wrangler@3 pages dev --port "${PORT:-8788}"
fi
npx --yes wrangler@3 pages deploy --branch main --commit-hash "$(git -C "$OLDPWD" rev-parse HEAD)" \
  --commit-message "$(git -C "$OLDPWD" log -1 --format=%s)"
