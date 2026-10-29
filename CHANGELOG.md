# Changelog

User-visible changes are recorded here. Public releases are not created by this
file; the initial source publication is still being prepared.

## Unreleased

## 1.1.3 — 2026-10-28

### Fixed

- Share compressed copies of repeated images, instructions and tool output between durable checkpoints and archives. Existing records migrate only after exact recovery verification; all conversation checkpoints remain available.
- Move incremental response history out of the resident response cache and load it only when its response ID is used. A disk error retains the in-memory fallback.
- Release inactive in-memory histories and retain compact checkpoint fingerprints instead of duplicated source transcripts. Preserve the full saved context and exact continuation after restarting the service.
- Automatically remove only unreferenced stored objects. Keep simultaneous summaries unlimited when configured to zero.

## 1.1.2 — 2026-10-28

### Fixed

- Restore recent assistant and tool steps when native replay assigns image detail settings or drops a generated interruption marker. Image bytes, authored text, and actual history changes remain protected.
- Preserve recent interruption warnings while keeping native replay comparison independent of the client's generated markers.
- Recover existing saved tails only when the archived source proves the full retained history and the exact opaque summary. Leave previous records intact for rollback.
- Verify continuation after replay changes with the compiled app, alongside rejection of edited messages and changed images.

## 1.1.1 — 2026-10-27

### Fixed

- Claim Compacta's route independently of OpenCodex's generated routing marker, so catalog synchronization preserves the compaction connection.
- Recover an enabled integration if its configuration reverts to its known upstream. Report the actual configured connection instead of a stale activation flag, and preserve unrelated provider changes.
- Preserve completed recent tool results larger than 64 KiB when the prepared prefix still substantially reduces the context window. This avoids waiting for several pending summaries on long chats.

## 1.1.0 — 2026-10-24

### Added

- English (default) and Simplified Chinese interface alongside Spanish. The first launch
  follows the macOS language (English when it is not supported); a language menu in
  Settings changes it right away and is remembered.
- GitHub Release downloads for Apple Silicon: a DMG (drag Compacta to Applications) and a ZIP, built when a `v*` tag is pushed. Developer ID signing and notarization run when the Apple secrets are configured; otherwise the archive is ad hoc signed.
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
