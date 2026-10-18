#!/usr/bin/env bash
# Day 25: build a release tarball + checksum that installs offline (bundles production node_modules).
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./package.json').version")
NAME="khanakhajana-pos-$VER"
OUT="dist"
rm -rf "$OUT/$NAME" && mkdir -p "$OUT/$NAME"
npm run typecheck && npm test
cp -r server web scripts docs package.json package-lock.json CLAUDE.md README.md "$OUT/$NAME"/
(cd "$OUT/$NAME" && npm ci --omit=dev --ignore-scripts >/dev/null)
tar -czf "$OUT/$NAME.tar.gz" -C "$OUT" "$NAME"
(cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
rm -rf "${OUT:?}/$NAME"
echo "built $OUT/$NAME.tar.gz"; cat "$OUT/$NAME.tar.gz.sha256"
echo "Next: git tag v$VER"
