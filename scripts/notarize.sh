#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${COMPACTA_SIGN_IDENTITY:?Set a Developer ID Application identity from your Keychain}"
: "${COMPACTA_NOTARY_PROFILE:?Set an existing notarytool Keychain profile name}"
if [[ "$COMPACTA_SIGN_IDENTITY" != "Developer ID Application:"* ]]; then
  echo 'A Developer ID Application identity is required.' >&2
  exit 1
fi
bash scripts/build.sh
APP="$PWD/build/Compacta.app"
VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json')).version")"
NAME="Compacta-${VERSION}-macOS-arm64"
ARCHIVE="$PWD/build/notarization.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ARCHIVE"
xcrun notarytool submit "$ARCHIVE" --keychain-profile "$COMPACTA_NOTARY_PROFILE" --wait --output-format json > build/notary-app.json
python3 -c 'import json; assert json.load(open("build/notary-app.json"))["status"] == "Accepted", "App notarization was not accepted"'
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
bash scripts/distribute.sh
xcrun notarytool submit "dist/$NAME.dmg" --keychain-profile "$COMPACTA_NOTARY_PROFILE" --wait --output-format json > build/notary-dmg.json
python3 -c 'import json; assert json.load(open("build/notary-dmg.json"))["status"] == "Accepted", "DMG notarization was not accepted"'
xcrun stapler staple "dist/$NAME.dmg"
xcrun stapler validate "dist/$NAME.dmg"
spctl --assess --type execute --verbose "$APP"
(cd dist && shasum -a 256 "$NAME.zip" "$NAME.dmg" > SHA256SUMS.txt)
echo 'Notarization completed. Test the downloaded archives on a separate Mac before publication.'
