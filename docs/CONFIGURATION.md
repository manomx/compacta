# Configuration

Use the app for routine configuration. Do not edit `runtime.json`: it contains
local administrative credentials and the active ports.

| Setting                  | Meaning                                                                           |
| ------------------------ | --------------------------------------------------------------------------------- |
| Model/provider           | The account or endpoint that creates summaries; test access first                 |
| Instructions             | What evidence, corrections, and constraints the summary must retain               |
| Continuous / threshold   | Prepare on completed progress or after a configured token threshold               |
| Codex concurrency        | `0` means no global cap; each chat still has one ordered chain                    |
| Cooldown / minimum delta | Control the interval and amount of new content before another update              |
| Keep recent              | Recent messages preserved by integrations that use a recent window                |
| Summary tokens           | Output budget for external textual summaries; provider limits still apply         |
| Budget                   | Advisory spending control; not an atomic hard limit across all in-flight requests |
| Prices                   | Editable cost estimates; not a statement of your subscription charges             |

Native opaque compaction has its own output behavior; do not assume an external
summarizer token setting changes the native endpoint's exact output size.

Provider formats:

- **OpenAI Responses:** a base ending at the versioned API root.
- **OpenAI-compatible:** a base such as `https://api.example.com/v1`; the adapter
  appends `/chat/completions`.
- **Anthropic:** the adapter appends `/v1/messages`.

HTTPS is required except for localhost development endpoints. Store keys with
the app's Keychain controls, not in URLs, custom headers, issue reports, or git.
Account-backed providers are constrained to their built-in service hosts.

Model identifiers and account-backed transports depend on the installed client
and provider. Replace defaults with identifiers your account actually supports.
Changing provider/policy can invalidate existing prepared summaries.

For gateway diagnosis, share only a redacted excerpt of an event name and error
code. Do not upload the entire application support directory.
