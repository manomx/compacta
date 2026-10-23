# Preparing a release

Repository visibility and release publication are deliberate maintainer actions.
No workflow changes visibility or publishes a GitHub Release automatically.

## Source readiness

- Review `README.md`, the Spanish introduction, changelog, and supported targets.
- Run `npm ci`, `npm run check`, and `npm test` from a clean checkout.
- On Apple Silicon, run `npm run test:installer`, `npm run build`,
  `npm run verify:package`, and `npm run verify:replay`.
- Confirm `LICENSE`, third-party notices, font license, and runtime distribution
  obligations. Keep private runtime state and personal logs outside git.
- Review GitHub Actions results. The manually dispatched artifact workflow creates
  developer packages, not public releases or notarized products.

## Binary distribution gate

A signed download needs a **Developer ID Application** identity available in the
maintainer's Keychain and an existing `notarytool` Keychain profile. Never commit
certificates, passwords, private keys, or exported signing profiles.

```sh
COMPACTA_SIGN_IDENTITY='Developer ID Application: YOUR NAME (TEAMID)' COMPACTA_NOTARY_PROFILE='compacta-notary' bash scripts/notarize.sh
```

The script signs the app, submits it to Apple's notarization service, staples the
app ticket, builds archives, notarizes/staples the DMG, validates the tickets, and
regenerates checksums. An ad hoc build is for local development, not a substitute
for those steps. Notarization requires your Apple Developer setup and network.

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
   [launch checklist](LAUNCH_CHECKLIST.md).
4. Create a version tag and a **draft** release with signed archives and checksums
   only after the preceding checks pass. Keep the notes explicit about limitations.
5. The owner decides when to change visibility and publish. Preparation is not approval.

Official references: [community health files](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions),
[GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
