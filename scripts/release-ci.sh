#!/bin/bash
# Build Compacta and attach dist archives to a GitHub Release.
# GitHub's macOS runners ship bash 3.2; keep this script compatible with it.
# Secret names and the tag flow are documented in docs/RELEASING.md.
# Usage: release-ci.sh package|publish
set +x
set -euo pipefail

SIGNING_SECRET_NAMES="APPLE_CERTIFICATE_BASE64 APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY"
NOTARY_SECRET_NAMES="APPLE_NOTARY_KEY_ID APPLE_NOTARY_ISSUER_ID APPLE_NOTARY_KEY_P8"
NOTES_START='<!-- compacta-release-notes -->'
NOTES_END='<!-- compacta-release-notes-end -->'

is_set() {
  local name="$1"
  local value
  case "$name" in
    *[!A-Z0-9_]*)
      printf 'Unexpected variable name.\n' >&2
      exit 1
      ;;
  esac
  # Indirect expansion via eval is limited to validated names so bash 3.2 can
  # read unset secrets without treating their values as code.
  eval "value=\${$name-}"
  [[ -n "${value//[[:space:]]/}" ]]
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

group_state() {
  local set_count=0 total=0 name
  for name in "$@"; do
    total=$((total + 1))
    if is_set "$name"; then
      set_count=$((set_count + 1))
    fi
  done
  if [[ "$set_count" -eq 0 ]]; then
    printf '%s' 'none'
  elif [[ "$set_count" -eq "$total" ]]; then
    printf '%s' 'all'
  else
    printf '%s' 'partial'
  fi
}

print_unset() {
  local name
  for name in "$@"; do
    if ! is_set "$name"; then
      printf '  - %s\n' "$name" >&2
    fi
  done
}

resolve_tag() {
  VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")"
  # Avoid =~ here. GitHub's macOS runners still ship bash 3.2, and its regex quoting differs.
  local major remain minor patch
  major="${VERSION%%.*}"
  remain="${VERSION#*.}"
  minor="${remain%%.*}"
  patch="${remain#*.}"
  if [[ -z "$major" || -z "$minor" || -z "$patch" || "$major" == "$VERSION" || "$minor" == "$remain" || "$patch" == *.* ]]; then
    printf 'package.json version %s is not a plain numeric version.\n' "$VERSION" >&2
    exit 1
  fi
  case "${major}${minor}${patch}" in
    *[!0-9]*)
      printf 'package.json version %s is not a plain numeric version.\n' "$VERSION" >&2
      exit 1
      ;;
  esac
  local ref="${GITHUB_REF:-}"
  local input="${COMPACTA_RELEASE_TAG_INPUT:-}"
  if [[ "$ref" == refs/tags/v* ]]; then
    TAG="${ref#refs/tags/}"
  elif [[ -n "$input" ]]; then
    TAG="$input"
  else
    printf 'Publish from a v* tag, or rerun the workflow on that tag.\n' >&2
    printf 'First release:\n  git tag v%s\n  git push origin v%s\n' "$VERSION" "$VERSION" >&2
    exit 1
  fi
  if [[ "$TAG" != "v${VERSION}" ]]; then
    printf 'Release tag %s does not match package.json version %s.\n' "$TAG" "$VERSION" >&2
    exit 1
  fi
}

assert_tag_commit() {
  local sha="${GITHUB_SHA:-}"
  if [[ -z "$sha" ]]; then
    sha="$(git rev-parse HEAD)"
  fi
  if ! git rev-parse -q --verify "refs/tags/${TAG}^{commit}" >/dev/null; then
    printf 'This checkout does not contain tag %s.\n' "$TAG" >&2
    printf 'Push it from the release commit:\n  git tag %s\n  git push origin %s\n' "$TAG" "$TAG" >&2
    exit 1
  fi
  local tag_sha
  tag_sha="$(git rev-parse "refs/tags/${TAG}^{commit}")"
  if [[ "$tag_sha" != "$sha" ]]; then
    printf 'Tag %s points at %s, but this checkout is %s.\n' "$TAG" "$tag_sha" "$sha" >&2
    printf 'Run the workflow on that tag: gh workflow run release.yml --ref %s\n' "$TAG" >&2
    exit 1
  fi
}

choose_mode() {
  local sign_state notary_state
  # shellcheck disable=SC2086
  sign_state="$(group_state $SIGNING_SECRET_NAMES)"
  # shellcheck disable=SC2086
  notary_state="$(group_state $NOTARY_SECRET_NAMES)"
  case "${sign_state}:${notary_state}" in
    none:none) MODE=adhoc ;;
    all:none) MODE=signed ;;
    all:all) MODE=notarized ;;
    *)
      printf 'Signing secrets: %s. Notarization secrets: %s.\n' "$sign_state" "$notary_state" >&2
      printf 'Set every signing secret or none of them. Notarization needs all of its secrets plus signing.\n' >&2
      printf 'Missing:\n' >&2
      # shellcheck disable=SC2086
      print_unset $SIGNING_SECRET_NAMES $NOTARY_SECRET_NAMES
      exit 1
      ;;
  esac
  if [[ "$MODE" != adhoc ]]; then
    APPLE_SIGNING_IDENTITY="$(trim "$APPLE_SIGNING_IDENTITY")"
    if [[ "$APPLE_SIGNING_IDENTITY" != "Developer ID Application:"* ]]; then
      printf 'APPLE_SIGNING_IDENTITY must be the full Developer ID Application name.\n' >&2
      exit 1
    fi
  fi
  if [[ "$MODE" == notarized ]]; then
    APPLE_NOTARY_KEY_ID="$(trim "$APPLE_NOTARY_KEY_ID")"
    APPLE_NOTARY_ISSUER_ID="$(trim "$APPLE_NOTARY_ISSUER_ID")"
    APPLE_NOTARY_KEY_P8="${APPLE_NOTARY_KEY_P8-}"
  fi
}

write_meta() {
  mkdir -p build
  printf 'TAG=%s\nVERSION=%s\nMODE=%s\n' "$TAG" "$VERSION" "$MODE" > build/release-meta.env
}

read_meta() {
  TAG=""
  VERSION=""
  MODE=""
  local key value
  if [[ ! -f build/release-meta.env ]]; then
    printf 'build/release-meta.env is missing. Run the package step first.\n' >&2
    exit 1
  fi
  while IFS='=' read -r key value; do
    case "$key" in
      TAG) TAG="$value" ;;
      VERSION) VERSION="$value" ;;
      MODE) MODE="$value" ;;
    esac
  done < build/release-meta.env
  case "$MODE" in
    adhoc | signed | notarized) ;;
    *)
      printf 'build/release-meta.env has an unknown mode.\n' >&2
      exit 1
      ;;
  esac
  if [[ -z "$TAG" || -z "$VERSION" ]]; then
    printf 'build/release-meta.env is incomplete.\n' >&2
    exit 1
  fi
}

cleanup_secrets() {
  if [[ -n "${KEYCHAIN_PATH:-}" ]]; then
    security delete-keychain "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
  fi
  if [[ -n "${CERT_PATH:-}" ]]; then
    rm -f "$CERT_PATH"
  fi
  if [[ -n "${NOTARY_KEY_PATH:-}" ]]; then
    rm -f "$NOTARY_KEY_PATH"
  fi
}

install_signing_keychain() {
  local old_umask password existing line
  KEYCHAIN_PATH="${RUNNER_TEMP:-$PWD/build}/compacta-signing.keychain-db"
  CERT_PATH="${RUNNER_TEMP:-$PWD/build}/developer-id.p12"
  password="$(openssl rand -hex 32)"
  old_umask="$(umask)"
  umask 077
  if ! printf '%s' "$APPLE_CERTIFICATE_BASE64" | tr -d '[:space:]' | /usr/bin/base64 -D > "$CERT_PATH"; then
    umask "$old_umask"
    printf 'Could not decode APPLE_CERTIFICATE_BASE64.\n' >&2
    exit 1
  fi
  umask "$old_umask"
  if [[ ! -s "$CERT_PATH" ]]; then
    printf 'APPLE_CERTIFICATE_BASE64 decoded to an empty file.\n' >&2
    exit 1
  fi
  security create-keychain -p "$password" "$KEYCHAIN_PATH"
  security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
  security unlock-keychain -p "$password" "$KEYCHAIN_PATH"
  security import "$CERT_PATH" -k "$KEYCHAIN_PATH" -P "$APPLE_CERTIFICATE_PASSWORD" -f pkcs12 -t cert -A -T /usr/bin/codesign -T /usr/bin/security
  rm -f "$CERT_PATH"
  CERT_PATH=""
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$KEYCHAIN_PATH"
  existing=""
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%\"}"
    line="${line#\"}"
    if [[ -n "$line" ]]; then
      existing="${existing} ${line}"
    fi
  done < <(security list-keychains -d user)
  # Leave the login keychain in the search list. notarytool keeps its profile
  # there, and codesign finds the Developer ID key in the temporary keychain.
  set -f
  # shellcheck disable=SC2086
  security list-keychains -d user -s "$KEYCHAIN_PATH" $existing
  set +f
  if ! security find-identity -p codesigning -v "$KEYCHAIN_PATH" | grep -F "$APPLE_SIGNING_IDENTITY" >/dev/null; then
    printf 'The imported certificate does not contain APPLE_SIGNING_IDENTITY.\n' >&2
    printf 'Copy it from: security find-identity -v -p codesigning\n' >&2
    security find-identity -p codesigning -v "$KEYCHAIN_PATH" >&2 || true
    exit 1
  fi
  export COMPACTA_SIGN_IDENTITY="$APPLE_SIGNING_IDENTITY"
}

store_notary_credentials() {
  local old_umask
  NOTARY_KEY_PATH="${RUNNER_TEMP:-$PWD/build}/AuthKey.p8"
  old_umask="$(umask)"
  umask 077
  printf '%s' "$APPLE_NOTARY_KEY_P8" > "$NOTARY_KEY_PATH"
  if [[ "$APPLE_NOTARY_KEY_P8" != *$'\n' ]]; then
    printf '\n' >> "$NOTARY_KEY_PATH"
  fi
  umask "$old_umask"
  if ! grep -q 'PRIVATE KEY' "$NOTARY_KEY_PATH"; then
    printf 'APPLE_NOTARY_KEY_P8 does not look like an App Store Connect API key.\n' >&2
    exit 1
  fi
  COMPACTA_NOTARY_PROFILE="compacta-notary-${GITHUB_RUN_ID:-local}-$$"
  export COMPACTA_NOTARY_PROFILE
  xcrun notarytool store-credentials "$COMPACTA_NOTARY_PROFILE" \
    --key "$NOTARY_KEY_PATH" \
    --key-id "$APPLE_NOTARY_KEY_ID" \
    --issuer "$APPLE_NOTARY_ISSUER_ID"
}

package() {
  resolve_tag
  assert_tag_commit
  choose_mode
  write_meta
  printf 'Release %s mode: %s\n' "$TAG" "$MODE"
  if [[ "${COMPACTA_RELEASE_DRY_RUN:-}" == 1 ]]; then
    printf 'Dry run: skipping keychain, build, and packaging.\n'
    return 0
  fi
  if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
    printf 'Packaging requires an Apple Silicon Mac.\n' >&2
    exit 1
  fi
  trap cleanup_secrets EXIT
  case "$MODE" in
    adhoc)
      unset COMPACTA_SIGN_IDENTITY || true
      bash scripts/build.sh
      npm run verify:package
      npm run verify:replay
      bash scripts/distribute.sh
      ;;
    signed)
      install_signing_keychain
      bash scripts/build.sh
      npm run verify:package
      npm run verify:replay
      bash scripts/distribute.sh
      ;;
    notarized)
      install_signing_keychain
      store_notary_credentials
      bash scripts/build.sh
      npm run verify:package
      npm run verify:replay
      COMPACTA_ASSUME_BUILT=1 bash scripts/notarize.sh
      ;;
  esac
}

compose_notes() {
  local sums notes="$1"
  if [[ ! -f dist/SHA256SUMS.txt ]]; then
    printf 'dist/SHA256SUMS.txt is missing.\n' >&2
    exit 1
  fi
  sums="$(cat dist/SHA256SUMS.txt)"
  {
    printf '%s\n' "$NOTES_START"
    printf 'Compacta %s for Apple Silicon (macOS 14 or later).\n\n' "$TAG"
    printf 'Open the DMG and drag Compacta to Applications. The ZIP is the same app.\n\n'
    case "$MODE" in
      notarized)
        printf 'This build is Developer ID signed, notarized, and stapled.\n\n'
        ;;
      signed)
        printf 'This build is Developer ID signed and is not notarized. Gatekeeper can block the first open.\n\n'
        printf -- '- Right-click Compacta.app and choose Open, then Open.\n'
        printf -- '- System Settings → Privacy & Security → Open Anyway.\n'
        printf -- '- Or clear this app'\''s quarantine flag:\n\n'
        printf '```sh\n'
        printf 'xattr -dr com.apple.quarantine /Applications/Compacta.app\n'
        printf '```\n\n'
        printf 'That command does not turn off Gatekeeper.\n\n'
        ;;
      adhoc)
        printf 'This build is ad hoc signed and is not notarized. Gatekeeper quarantines the download.\n\n'
        printf -- '- Right-click Compacta.app and choose Open, then Open.\n'
        printf -- '- System Settings → Privacy & Security → Open Anyway.\n'
        printf -- '- Or clear this app'\''s quarantine flag:\n\n'
        printf '```sh\n'
        printf 'xattr -dr com.apple.quarantine /Applications/Compacta.app\n'
        printf '```\n\n'
        printf 'That command does not turn off Gatekeeper.\n\n'
        ;;
    esac
    printf 'Opening the app copies it to ~/Applications and starts the per-user service. Start a new Codex chat or Claude Code session after you enable an integration. The app UI is in Spanish.\n\n'
    printf 'SHA-256:\n\n'
    printf '%s\n' '```'
    printf '%s\n' "$sums"
    printf '%s\n' '```'
    printf '%s\n' "$NOTES_END"
  } > "$notes"
}

# Rewrites generated notes and keeps text the maintainer added after the end marker.
# Returns 2 when the existing body was written by hand and should be left alone.
apply_notes() {
  local notes="$1"
  local existing="$2"
  local generated suffix
  if [[ -n "$existing" && "$existing" != *"$NOTES_START"* ]]; then
    return 2
  fi
  suffix=""
  if [[ "$existing" == *"$NOTES_END"* ]]; then
    suffix="${existing#*"$NOTES_END"}"
  fi
  generated="$(cat "$notes")"
  printf '%s%s' "$generated" "$suffix" > "$notes"
}

publish() {
  local meta_tag meta_version name dmg zip sums notes existing status
  read_meta
  meta_tag="$TAG"
  meta_version="$VERSION"
  resolve_tag
  assert_tag_commit
  if [[ "$TAG" != "$meta_tag" || "$VERSION" != "$meta_version" ]]; then
    printf 'Release metadata does not match this checkout.\n' >&2
    exit 1
  fi
  name="Compacta-${VERSION}-macOS-arm64"
  dmg="dist/${name}.dmg"
  zip="dist/${name}.zip"
  sums="dist/SHA256SUMS.txt"
  if [[ "${COMPACTA_RELEASE_DRY_RUN:-}" == 1 ]]; then
    printf 'Dry run: would publish %s (%s) from %s and %s.\n' "$TAG" "$MODE" "$dmg" "$zip"
    return 0
  fi
  for file in "$dmg" "$zip" "$sums"; do
    if [[ ! -f "$file" ]]; then
      printf 'Missing release archive %s.\n' "$file" >&2
      exit 1
    fi
  done
  if [[ -z "${GH_TOKEN:-}" ]]; then
    printf 'GH_TOKEN is required to publish the GitHub Release.\n' >&2
    exit 1
  fi
  if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
    export GH_REPO="$GITHUB_REPOSITORY"
  fi
  notes="build/RELEASE_NOTES.md"
  compose_notes "$notes"
  if gh release view "$TAG" >/dev/null 2>&1; then
    gh release upload "$TAG" "$dmg" "$zip" "$sums" --clobber
    existing="$(gh release view "$TAG" --json body --jq .body)"
    if [[ "$existing" == "null" ]]; then
      existing=""
    fi
    set +e
    apply_notes "$notes" "$existing"
    status=$?
    set -e
    if [[ "$status" -eq 0 ]]; then
      gh release edit "$TAG" --notes-file "$notes"
    elif [[ "$status" -eq 2 ]]; then
      printf 'Release notes were edited by hand, so they were left unchanged.\n'
    else
      exit "$status"
    fi
  else
    if [[ "${COMPACTA_RELEASE_DRAFT:-}" == "true" ]]; then
      gh release create "$TAG" "$dmg" "$zip" "$sums" --title "Compacta ${TAG}" --notes-file "$notes" --draft
    else
      gh release create "$TAG" "$dmg" "$zip" "$sums" --title "Compacta ${TAG}" --notes-file "$notes"
    fi
  fi
  printf 'Published %s (%s).\n' "$TAG" "$MODE"
}

main() {
  cd "$(dirname "$0")/.."
  local cmd="${1:-}"
  case "$cmd" in
    package) package ;;
    publish) publish ;;
    *)
      printf 'Usage: %s package|publish\n' "$0" >&2
      exit 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
