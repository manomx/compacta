# Known limitations

- **Early release:** the native Codex path and client internals can change upstream.
  Protocol compatibility is not a stable API guarantee.
- **Availability:** macOS 14+ and Apple Silicon only. The current UI is Spanish.
- **Installer trust:** a local/ad hoc build is not Developer ID signed and notarized.
  A general-download release is blocked until those distribution checks pass.
- **Client connections:** new installations apply to new Codex chats / Claude Code
  sessions. Existing sockets do not necessarily migrate immediately.
- **Latency:** preparation, provider rate limits, an incompatible checkpoint,
  unfinished tool groups, or a recent suffix larger than 64 KiB can add a pause.
- **Summary quality:** summaries are lossy. Tests preserve specific references and
  constraints, but do not prove perfect recall for every conversation.
- **Different integrations:** Claude uses textual prefix replacement. Its real-client
  validation is less complete; Codex results must not be generalized to Claude.
- **Providers/models:** an editable model ID or successful settings save is not proof
  of API access. Account limits and supported model identifiers vary.
- **Usage:** extra requests consume quota/credit. Prices are editable estimates.
  Budgets are advisory and do not cancel every in-flight charge atomically.
- **Prompt cache:** applying a summary changes the input prefix and can reduce
  provider prompt-cache reuse. Background preparation also has its own usage.
- **Local data:** some context is plaintext on disk. Ledger retention does not
  prune every cache/archive/backup file.

Report a small synthetic reproduction through the issue templates. For sensitive
security findings, follow [SECURITY.md](../SECURITY.md).
