# Launch checklist

This file distinguishes preparation from a public launch. Leave incomplete checks
unchecked until there is direct evidence.

## Prepared in the source tree

- [x] Source code, MIT license, and third-party notices.
- [x] English README and Spanish introduction.
- [x] Installation, configuration, architecture, privacy, limitations, and roadmap.
- [x] Vector identity, wordmarks, README artwork, and social preview source.
- [x] Contribution and conduct guidance, CODEOWNERS, issue and PR templates.
- [x] Pinned build runtime, lockfile, CI, and dependency update configuration.
- [x] Portable synthetic verification; personal reports excluded.
- [x] Explicit signing/notarization procedure and manual artifact workflow.

## Maintainer verification before making public

- [ ] Green CI on the final commit.
- [ ] Final review of model defaults and native-client compatibility.
- [ ] Private vulnerability reporting enabled and tested after GitHub makes it available for the repository visibility.
- [ ] Social preview image uploaded in GitHub Settings.
- [ ] Repository visibility change explicitly authorized by the owner.

## Before offering general-user binaries

- [ ] Developer ID signed, notarized, and stapled release artifacts.
- [ ] Download/quarantine/first-launch test on a separate supported Mac.
- [ ] Real Codex manual and automatic compaction verification for the release candidate.
- [ ] Real Claude Code session and reversible activation verification.
- [ ] Review bundled-runtime redistribution obligations.
- [ ] Attach final checksums and clearly written release notes.

A source release can precede a consumer binary release, provided the README keeps
that distinction clear.
