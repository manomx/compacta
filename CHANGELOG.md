# Changelog

User-visible changes are recorded here. Public releases are not created by this
file; the initial source publication is still being prepared.

## Unreleased

### Added

- Open-source project documentation in English and Spanish.
- Portable synthetic replay verification and repository hygiene checks.
- Vector logo, wordmarks, README artwork, and social preview sources.
- Contribution guidelines, issue forms, security policy, and release procedures.
- CI for engine tests and the macOS build; manual developer artifact packaging.

### Changed

- Build directly from the service source without obfuscation.
- Pin the build runtime and keep distribution artifacts under `dist/`.
- Update `ws` to 8.22.0 to address known WebSocket advisories.
- Keep personal verification reports and account-specific harnesses out of the repository.

## 1.0.5 — 2026-10-23

### Fixed

- Restore recent assistant and tool steps when Codex drops generated Page snapshots during native compaction. Pending process identifiers and completed tool results remain available to the next inference.
- Preserve exact matching for authored user instructions, including messages that mix generated Page context with user text.
- Add a compiled-service replay check for continuing an already launched operation without regenerating its prepared summary.

## 1.0.4 — local development baseline

- Progressive per-chat checkpoint preparation for Codex.
- Recent assistant/tool context preservation across native compaction.
- No global concurrency cap when the Codex setting is `0`.
- Treat absent, null, and empty reasoning content consistently during checkpoint replay.

This baseline describes local development history; it is not a claim of a prior
public 1.0.4 release or a guarantee for every installed client.
