# Architecture

Compacta is a native menu bar app plus a per-user background service. The app uses
SwiftUI/AppKit. The service uses TypeScript/JavaScript compiled with Bun; it
provides a loopback HTTP/WebSocket gateway, a usage ledger, and provider clients.
A small Swift helper performs Keychain operations.

## Codex path

1. Activation backs up client configuration and routes new sessions through the
   local gateway. A legacy router, when present, can retain its listener.
2. Normal requests are forwarded with the conversation intact. Completed output
   items, tool results, and final answers trigger background preparation.
3. Each chat has one ordered chain. A matching prior checkpoint plus the new
   suffix becomes the next summary input. Pending updates are coalesced.
4. A native compaction request first attempts the prepared checkpoint. Comparison
   ignores known transport decoration, but preserves actual message content,
   encrypted state, tool identifiers, and unknown meaningful fields.
5. Native v2 clients retain user/developer instructions but can drop assistant/tool
   items returned beside an opaque compaction item. Compacta durably stores a
   complete recent suffix before acknowledging compaction and restores it on replay.
6. A complete suffix up to 64 KiB can use this preservation path. Otherwise the
   service finishes pending preparation or falls back to native provider compaction.

Checkpoint state and recovery records survive worker replacement. Reuse depends
on the identity/policy/history checks; a stored checkpoint is not automatically
valid for a changed branch or provider identity.

## Claude Code path

The Claude integration has a separate threshold-based prefix replacement engine.
It keeps recent messages and complete tool groups and inserts a textual handoff.
It does not use Codex's opaque native checkpoint format. Do not assume Codex
latency measurements or native replay guarantees apply to Claude.

## Providers and local API

Provider adapters support Responses, compatible Chat Completions, and Anthropic
Messages. External Codex summarizers produce a textual assistant handoff, while
opaque native state is retained through the native provider.

The gateway listens on `127.0.0.1`. Client routes use a random capability in their
path. The separate local admin API requires a bearer token and rejects browser
Origin requests. Runtime secrets are generated locally, never compiled into the
app. These controls do not protect against a fully compromised user account.

## Source map

| Component                   | Entry point                                     |
| --------------------------- | ----------------------------------------------- |
| UI and process bootstrap    | `Sources/Compacta/Main.swift`, `AppModel.swift` |
| Bundle installation         | `Sources/Compacta/BundleInstaller.swift`        |
| Service                     | `service/index.ts`                              |
| Gateway and native protocol | `service/native/server.mjs`                     |
| Ordered checkpoint chain    | `service/native/engine.mjs`                     |
| Provider handoffs           | `service/policy.ts`, `providers.ts`             |
| Client activation/reversal  | `service/integrations.ts`                       |
| Keychain/accounts           | `service/vault.ts`, `Sources/Vault.swift`       |
| Claude prefix replacement   | `service/claude.ts`                             |
| Usage and limits            | `service/ledger.ts`, `quotas.ts`                |

The compatibility router under `support/router-compatibility/` is optional legacy
support. A clean installation does not require that preexisting router.
