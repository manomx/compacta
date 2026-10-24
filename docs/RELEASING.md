# Preparing a release

Repository visibility stays a deliberate maintainer action. The release workflow
does not change visibility. Pushing a `v*` tag builds the macOS app and attaches
a DMG and ZIP to the GitHub Release for that tag.

The app is compiled with `scripts/build.sh` (`swiftc -O` and a compiled service),
then packed by `scripts/distribute.sh`. There is no Xcode project.

## Source readiness

- Review `README.md`, the Spanish introduction, changelog, and supported targets.
- Run `npm ci`, `npm run check`, and `npm test` from a clean checkout.
- On Apple Silicon, run `npm run test:installer`, `npm run build`,
  `npm run verify:package`, and `npm run verify:replay`.
- Confirm `LICENSE`, third-party notices, font license, and runtime distribution
  obligations. Keep private runtime state and personal logs outside git.
- Review GitHub Actions results. `npm run distribute` writes local archives under
  `dist/` and does not publish them.

## Cut a release

`package.json` `version` must be the release number. For the current tree that is
`1.0.5`, so the tag is `v1.0.5`.

```sh
git checkout main
git pull origin main
git tag v1.0.5
git push origin v1.0.5
```

The tag push runs the Release workflow on a GitHub-hosted Apple Silicon runner
(`macos-15`). It runs the repository checks, builds, and uploads:

- `Compacta-<version>-macOS-arm64.dmg` (Compacta, an Applications alias, and a short README)
- `Compacta-<version>-macOS-arm64.zip`
- `SHA256SUMS.txt`

The workflow creates the GitHub Release when that tag does not have one yet.
Re-running it replaces those assets. It does not create a git tag. To rebuild
without a new tag:

```sh
gh workflow run release.yml --ref v1.0.5
```

A manual run from a branch needs the `tag` input, and that tag must already
point at the selected commit. `draft` creates a new release as a draft; an
existing release keeps its draft or published state. Add maintainer notes after
the generated block's end marker if they should survive a rebuild. Notes that
no longer contain the generated marker are left unchanged.

The manual Developer artifacts workflow still uploads an ad hoc package as a
workflow artifact for 7 days. It does not create a GitHub Release.

## Code signing and notarization

Signing is optional. With none of the secrets below, the workflow ad hoc signs
the app the same way a local `npm run build` does, and still publishes the
archives. Set every secret in a group. A partial group fails the job instead of
publishing an ad hoc build that was meant to be signed.

Do not enable Actions step debug on this workflow. A debug trace can print
secret values.

Signing secrets (all three):

- `APPLE_CERTIFICATE_BASE64` — base64 of the Developer ID Application `.p12`, including its private key. On a Mac: `base64 -i DeveloperID.p12 | pbcopy`.
- `APPLE_CERTIFICATE_PASSWORD` — password for that `.p12`.
- `APPLE_SIGNING_IDENTITY` — exact identity from `security find-identity -v -p codesigning`, for example `Developer ID Application: YOUR NAME (TEAMID)`.

Notarization secrets (all three, and only together with the signing secrets).
Create an App Store Connect API key with the Developer role, download the `.p8`
once, and paste the file:

- `APPLE_NOTARY_KEY_ID` — key ID.
- `APPLE_NOTARY_ISSUER_ID` — issuer ID.
- `APPLE_NOTARY_KEY_P8` — contents of the downloaded `.p8` file, including its header and footer lines.

The workflow imports the certificate into a temporary keychain, stores a
temporary `notarytool` profile, then runs `scripts/notarize.sh`. That script
submits the app, staples the ticket, builds the archives, and notarizes and
staples the DMG. The same script still works on a maintainer Mac with a
Keychain profile:

```sh
COMPACTA_SIGN_IDENTITY='Developer ID Application: YOUR NAME (TEAMID)' COMPACTA_NOTARY_PROFILE='compacta-notary' bash scripts/notarize.sh
```

Never commit certificates, passwords, private keys, or exported signing profiles.

## What an unsigned download looks like

An ad hoc release, and a Developer ID release that was not notarized, is
quarantined by Gatekeeper. A normal double-click fails the first time. The
release notes and the README tell people to right-click the app and choose
Open, to use System Settings → Privacy & Security → Open Anyway, or to run
`xattr -dr com.apple.quarantine` on `/Applications/Compacta.app`. That removes
the quarantine flag from this app. It does not turn off Gatekeeper.

A notarized, stapled build opens with the normal macOS prompt.

Test the **downloaded** ZIP and DMG on a separate Apple Silicon Mac with a clean
user account, Gatekeeper enabled, and a supported macOS version. Verify first
launch, Keychain prompts, a new Codex chat, a new Claude Code session, manual and
automatic compaction, pause, disable, and restoration of client settings. Record
which client versions were tested. Do not infer this from a build succeeding.

## GitHub launch gate

1. Confirm the repository is still private while preparing.
2. Enable private vulnerability reporting when GitHub makes it available for the
   repository visibility, and select the social preview PNG under
   repository Settings. SVG source is under `docs/assets/`; GitHub's social image
   upload requires a rendered PNG/JPEG.
3. Review description, topics, branch rules, Actions permissions, and the
   [launch checklist](LAUNCH_CHECKLIST.md). The release workflow requests
   `contents: write` so it can create the Release. Repository settings must
   allow that token permission.
4. Push the version tag only after the preceding checks pass. The workflow
   publishes the archives and writes notes that say whether the build was
   notarized. Keep any extra limitations in the release notes.
5. The owner decides when to change visibility. Preparation is not approval.

Official references: [community health files](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions),
[GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
