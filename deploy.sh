#!/usr/bin/env bash
# Publishes the latest commit to https://posture-buddy.pages.dev (Cloudflare Pages).
# Uploads committed files only (so data/ and anything uncommitted never leave this Mac), minus the Pi, ESP32 and
# local-server files the hosted site can't use. Needs Node 18+ (uses Homebrew's node@20 if the default is older).
set -euo pipefail
cd "$(dirname "$0")"
[ -x /usr/local/opt/node@20/bin/node ] && export PATH="/usr/local/opt/node@20/bin:$PATH"
[ -x /opt/homebrew/opt/node@20/bin/node ] && export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
if [ -n "$(git status --porcelain)" ]; then echo "Note: uncommitted changes are not deployed (commit them first)."; fi
SITE="$(mktemp -d)"
trap 'rm -rf "$SITE"' EXIT
git archive HEAD | tar -x -C "$SITE"
rm -rf "$SITE/esp32" "$SITE/pi" "$SITE/serve.py" "$SITE/deploy.sh" "$SITE/.gitignore"
npx --yes wrangler@3 pages deploy "$SITE" --project-name posture-buddy --branch main --commit-hash "$(git rev-parse HEAD)" --commit-message "$(git log -1 --format=%s)"
