# Roadmap

This is a direction for contributions, not a delivery schedule.

## Before general binary distribution

- Clean-machine installation test of a downloaded release. The tag workflow notarizes when the Apple secrets in [releasing](RELEASING.md) are set.
- Confirm default model availability and compatibility against documented client versions.
- Enable private vulnerability reporting and review the public repository settings.
- Review a real Codex manual and automatic compaction flow from the release candidate.

## Next areas

- Broader replay/protocol regression fixtures using synthetic data.
- Stronger Claude Code end-to-end coverage.
- English UI localization.
- Explicit cleanup controls for checkpoint/archive/backup data.
- More provider integration fixtures and clear quota/backoff behavior.

## Outside the current scope

Cross-platform native apps, guaranteed instant compaction, and perfect or infinite
memory are not current release promises.
