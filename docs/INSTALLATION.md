# Installation and removal

## Supported target

- Apple Silicon (arm64), macOS 14 or later.
- Node.js 22+ and Xcode Command Line Tools for a source build.
- A coding client already installed and authenticated, or a supported API provider.
- The app UI is currently Spanish. Intel, Windows, and Linux app builds are not supported.

## Download

Download `Compacta-<version>-macOS-arm64.dmg` from
[GitHub Releases](https://github.com/manomx/compacta/releases). Open the image
and drag **Compacta** to **Applications**. The release also includes a `.zip` of
the same app and `SHA256SUMS.txt`.

A notarized build opens with the usual macOS prompt. An ad hoc build, or a
Developer ID build that is not notarized yet, is quarantined. Open that copy
once with any of these:

- Right-click `Compacta.app` and choose **Open**, then **Open**.
- **System Settings → Privacy & Security → Open Anyway**.
- Remove only this app's quarantine flag:

```sh
xattr -dr com.apple.quarantine /Applications/Compacta.app
```

That command does not turn off Gatekeeper. Drag the app to Applications first,
so the path above is the copy you open.

## Source build

```sh
npm ci
npm run check
npm test
npm run test:installer
npm run build
npm run verify:package
npm run verify:replay
open build/Compacta.app
```

Building and running verification do not install into your Applications directory.
**Opening the app does**: its bootstrap copies it to `~/Applications/Compacta.app`,
registers the user's launch agent, and opens the installed copy. No administrator
password is required for that user-scoped location.

A source build is ad hoc signed. Opening it from the build folder usually does
not set a quarantine flag. If macOS blocks it, use the same first-open steps as
a downloaded ad hoc build. See [releasing](RELEASING.md).

## Activate

1. Choose clients in Compacta's setup screen.
2. Configure a model available to your account. Model names are not access grants.
3. Test the selected provider. Connection tests make a real request.
4. Enable the desired integration.
5. Start a **new Codex chat** or **new Claude Code session**.

Existing connections keep their original route. The legacy router can change the
worker behind a stable listener without restarting Codex; this is not a universal
promise that every previously open connection migrates immediately.

## Pause, disable, and remove

- **Pause:** stops new preparation; the gateway remains available.
- **Disable integration:** use the app's client controls to restore that client's
  previous base URL. Unrelated configuration is preserved.
- **Close window / quit UI:** the background service continues for open sessions.

For complete removal, disable both integrations first and start fresh client
sessions so they stop using the local route. Then unload the launch agent shown
in `~/Library/LaunchAgents/` for Compacta and remove the app from
`~/Applications/`. The current fresh-install label is `io.compacta.service.v2`; older local
setups may have `io.compacta.service` or other labels. Inspect the installed plist and process;
do not blindly terminate unrelated services.

Local data remains under `~/Library/Application Support/Compacta` until explicitly
removed. It can include transcripts and backups. API keys remain in Keychain
until removed through the app or Keychain Access. Back up anything needed before
removing these separately. Never delete `.codex` or `.claude` as an uninstall step.
