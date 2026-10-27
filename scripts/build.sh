#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "Compacta's native app requires an Apple Silicon Mac." >&2
  exit 1
fi
APP="$PWD/build/Compacta.app"
BUN="$PWD/node_modules/.bin/bun"
IDENTITY="${COMPACTA_SIGN_IDENTITY:--}"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers" "$APP/Contents/Resources/Licenses"
# Compile the readable source directly. No obfuscation or hidden build input.
"$BUN" build service/index.ts --compile --minify --outfile "$APP/Contents/Helpers/compacta-engine"
xcrun swiftc -O -whole-module-optimization -swift-version 5 -target arm64-apple-macos14.0 Sources/Compacta/*.swift -o "$APP/Contents/MacOS/Compacta" -framework SwiftUI -framework AppKit -framework Charts
xcrun swiftc -O -swift-version 5 -target arm64-apple-macos14.0 Sources/Vault.swift -o "$APP/Contents/Helpers/compacta-vault" -framework Security
python3 - "$APP" <<'PLIST'
import sys,plistlib,pathlib,json,os
p=pathlib.Path(sys.argv[1])/'Contents'
version=json.loads(pathlib.Path('package.json').read_text())['version']
info={'CFBundleName':'Compacta','CFBundleDisplayName':'Compacta','CFBundleIdentifier':'io.compacta.app','CFBundleExecutable':'Compacta','CFBundlePackageType':'APPL','CFBundleShortVersionString':version,'CFBundleVersion':os.environ.get('COMPACTA_BUILD_NUMBER','11'),'CFBundleDevelopmentRegion':'en','CFBundleLocalizations':['en','es','zh-Hans'],'LSMinimumSystemVersion':'14.0','LSUIElement':True,'NSHighResolutionCapable':True,'CFBundleIconFile':'Compacta','NSAppleEventsUsageDescription':'Compacta can open a session in your client when you choose to connect your account.','NSHumanReadableCopyright':'Copyright 2026. Compacta contributors.'}
(p/'Info.plist').write_bytes(plistlib.dumps(info))
PLIST
xcrun swift scripts/icon.swift "$APP/Contents/Resources"
cp Resources/Fonts/PlusJakartaSans.ttf "$APP/Contents/Resources/PlusJakartaSans.ttf"
# Interface languages: English (base), Spanish, Simplified Chinese.
for strings in Resources/Localization/*.lproj/*.strings; do plutil -lint -s "$strings"; done
cp -R Resources/Localization/*.lproj "$APP/Contents/Resources/"
cp LICENSE "$APP/Contents/Resources/LICENSE.txt"
cp node_modules/ws/LICENSE "$APP/Contents/Resources/Licenses/ws.txt"
cp node_modules/@iarna/toml/LICENSE "$APP/Contents/Resources/Licenses/toml.txt"
cp docs/licenses/*.txt "$APP/Contents/Resources/Licenses/"
cat > build/engine-entitlements.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>
PLIST
SIGN_ARGS=(--force --sign "$IDENTITY" --options runtime)
if [[ "$IDENTITY" != - ]]; then SIGN_ARGS+=(--timestamp); fi
codesign "${SIGN_ARGS[@]}" --entitlements build/engine-entitlements.plist --identifier io.compacta.engine "$APP/Contents/Helpers/compacta-engine"
codesign "${SIGN_ARGS[@]}" --identifier io.compacta.vault "$APP/Contents/Helpers/compacta-vault"
codesign "${SIGN_ARGS[@]}" "$APP"
codesign --verify --deep --strict "$APP"
printf 'Built %s\n' "$APP"
