# Contributing to Compacta

Thank you for helping make long coding sessions easier to continue. Contributions
in English or Spanish are welcome. This is an early project maintained by
[@manomx](https://github.com/manomx); response times are not guaranteed.

## Before you start

Read the [architecture](docs/ARCHITECTURE.md), [limitations](docs/LIMITATIONS.md),
and [code of conduct](CODE_OF_CONDUCT.md). Open a focused issue before a large
behavioral change. Documentation fixes and small reproducible bug fixes can go
straight to a pull request. Use private reporting for [security issues](SECURITY.md).

## Set up and verify

Use Node.js 22+ and `npm ci`. macOS 14+ on Apple Silicon and Xcode Command Line
Tools are required to compile the app. Engine tests can run on Linux using the
pinned Bun dependency.

```sh
npm ci
npm run check
npm run format:check
npm test
# On a supported Mac:
npm run test:installer
npm run test:localization
npm run build
npm run verify:package
npm run verify:replay
```

Tests must use synthetic data, temporary directories, and local mock providers.
Do not add tests that silently read real client credentials, contact paid
providers, or activate an installed integration. New integration checks should
exercise the compiled binary with an isolated home.

## Interface text

User-facing strings live in `Resources/Localization/<language>.lproj/Localizable.strings`.
English (`en`) is the base language; add every new key to `en`, `es`, and `zh-Hans`, and
use it from Swift with `L("key")`. Messages produced by the engine are Spanish and are
translated for display through `ServiceMessages.strings`. `npm test` fails when a key or
an engine message is missing in any language.

## Pull requests

Keep the change focused and describe the trigger, expected behavior, and observed
result. Include the relevant verification commands and explain any remaining
limits. UI changes should include screenshots with synthetic data, light/dark
appearance, and the existing app design preserved.

Preserve these invariants:

- User instructions and real content edits must invalidate incompatible checkpoints.
- Tool calls and results must remain complete and ordered.
- Recent assistant/tool content must survive native client compaction.
- One ordered summary chain per chat; do not race duplicate foreground work.
- Configuration changes must remain reversible and preserve unrelated settings.
- Do not log credentials, raw conversations, or provider response bodies in errors.

The release build is intentionally not obfuscated. Prefer small, readable changes
and use `npm run format` to apply the repository style. Dependency updates must include the
lockfile. GitHub Actions are pinned to full commit SHAs.

## License and attribution

By submitting a contribution, you agree that your contribution is licensed under
the project's MIT license. Retain third-party notices. Do not include code,
images, transcripts, or fonts you do not have permission to contribute.
