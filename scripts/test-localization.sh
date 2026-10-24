#!/bin/bash
# Compiles the Foundation-only localization code with a small checker and runs it.
# Works on macOS (xcrun) and on Linux with a Swift toolchain on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
if [[ "$(uname -s)" == Darwin ]]; then SWIFTC=(xcrun swiftc); else SWIFTC=(swiftc); fi
"${SWIFTC[@]}" -swift-version 5 Sources/Compacta/Localization.swift scripts/test-localization.swift -o build/test-localization
build/test-localization "$PWD"
