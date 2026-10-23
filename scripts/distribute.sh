#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$PWD/build/Compacta.app"
DEST="${1:-$PWD/dist}"
VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json')).version")"
NAME="Compacta-${VERSION}-macOS-arm64"
mkdir -p "$DEST"
codesign --verify --deep --strict "$APP"
STAGING="$(mktemp -d "$PWD/build/distribution.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
ditto "$APP" "$STAGING/Compacta.app"
cp docs/DOWNLOAD_README.txt "$STAGING/README.txt"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$DEST/$NAME.zip"
hdiutil create -ov -size 200m -fs HFS+ -volname Compacta -srcfolder "$STAGING" -format UDZO "$DEST/$NAME.dmg"
if [[ -n "${COMPACTA_SIGN_IDENTITY:-}" && "$COMPACTA_SIGN_IDENTITY" != - ]]; then
  codesign --force --sign "$COMPACTA_SIGN_IDENTITY" --timestamp "$DEST/$NAME.dmg"
fi
(cd "$DEST" && shasum -a 256 "$NAME.zip" "$NAME.dmg" > SHA256SUMS.txt)
printf 'Developer archives written to %s; notarization is a separate step.\n' "$DEST"
