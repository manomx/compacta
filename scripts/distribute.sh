#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$PWD/build/Compacta.app"
DEST="${1:-$PWD/dist}"
VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json')).version")"
NAME="Compacta-${VERSION}-macOS-arm64"
mkdir -p "$DEST" "$PWD/build"
codesign --verify --deep --strict "$APP"
STAGING="$(mktemp -d "$PWD/build/distribution.XXXXXX")"
MOUNT=""
cleanup() {
  if [[ -n "$MOUNT" ]]; then
    hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
    MOUNT=""
  fi
  rm -rf "$STAGING"
}
trap cleanup EXIT
# Zip the signed app itself. The DMG adds the drag-to-Applications layout.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$DEST/$NAME.zip"
RAW="$STAGING/rw.dmg"
MOUNT="$STAGING/mnt"
mkdir -p "$MOUNT"
hdiutil create -size 200m -fs HFS+ -volname Compacta "$RAW"
if [[ ! -f "$RAW" && -f "${RAW}.dmg" ]]; then
  RAW="${RAW}.dmg"
fi
if [[ ! -f "$RAW" ]]; then
  printf 'Could not create the temporary disk image.\n' >&2
  exit 1
fi
hdiutil attach "$RAW" -mountpoint "$MOUNT" -nobrowse -noverify -noautoopen
ditto "$APP" "$MOUNT/Compacta.app"
for lang in en es zh-Hans; do
  if [[ ! -f "$MOUNT/Compacta.app/Contents/Resources/$lang.lproj/Localizable.strings" ]]; then
    printf 'Interface language %s is missing from the disk image.\n' "$lang" >&2
    exit 1
  fi
done
cp docs/DOWNLOAD_README.txt "$MOUNT/README.txt"
ln -s /Applications "$MOUNT/Applications"
if [[ "$(readlink "$MOUNT/Applications")" != /Applications ]]; then
  printf 'Applications alias was not created on the disk image.\n' >&2
  exit 1
fi
sync
hdiutil detach "$MOUNT"
MOUNT=""
rm -f "$DEST/$NAME.dmg"
hdiutil convert "$RAW" -format UDZO -ov -o "$DEST/$NAME.dmg"
if [[ ! -f "$DEST/$NAME.dmg" && -f "$DEST/$NAME.dmg.dmg" ]]; then
  mv "$DEST/$NAME.dmg.dmg" "$DEST/$NAME.dmg"
fi
if [[ ! -f "$DEST/$NAME.dmg" ]]; then
  printf 'DMG was not written to %s.\n' "$DEST/$NAME.dmg" >&2
  exit 1
fi
if [[ -n "${COMPACTA_SIGN_IDENTITY:-}" && "$COMPACTA_SIGN_IDENTITY" != - ]]; then
  codesign --force --sign "$COMPACTA_SIGN_IDENTITY" --timestamp "$DEST/$NAME.dmg"
fi
(cd "$DEST" && shasum -a 256 "$NAME.zip" "$NAME.dmg" > SHA256SUMS.txt)
printf 'Developer archives written to %s; notarization is a separate step.\n' "$DEST"
