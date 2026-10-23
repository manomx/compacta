#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
xcrun swiftc -swift-version 5 Sources/Compacta/BundleInstaller.swift scripts/test-installer.swift -o build/test-installer
build/test-installer
