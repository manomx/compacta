# Privacy and data flow

Compacta runs locally, but model work is performed by your providers. Local
execution does not mean conversations stay off the network.

## What leaves the Mac

Normal client requests go through the loopback gateway to their upstream service.
Background summaries send conversation material, including tool outputs, to the
chosen summarizer. A third-party summarizer is an additional recipient. Codex's
opaque native state may still require a native provider request.

Provider listing, connection tests, account quota refreshes, and generation can
make network requests. Provider privacy/retention terms apply. This repository
does not operate its own hosted backend or include project analytics collection.

## What stays on disk

The default state directory is `~/Library/Application Support/Compacta`:

| Data                                           | Purpose                                               |
| ---------------------------------------------- | ----------------------------------------------------- |
| Settings and integration records               | Providers, model preferences, previous client routing |
| Client configuration backups                   | Reversible activation                                 |
| Checkpoints, source archives, and recent tails | Incremental summaries and recovery                    |
| Usage SQLite database and event logs           | Tokens, estimated costs, activity, errors             |
| Runtime file                                   | Ports and local admin/capability credentials          |

Directories/files are created with user-restricted permissions where implemented.
Compacta does **not** encrypt its full local state. Archives and recent tails can
contain plaintext tool results or messages. Treat backups and runtime files as
sensitive. Operating-system disk encryption is separate from Compacta.

The retention setting prunes usage/event ledger entries; it is **not** a promise
that every checkpoint, archive, configuration backup, or tail is removed after
that number of days. Complete local data removal is a separate operation.

## Credentials

Custom API keys are stored through the macOS Keychain helper and briefly cached
in service memory. Account-backed requests can read Codex's local auth file and
Claude Code credentials or its Keychain entry. Quota checks reuse those existing
client accounts. Compacta does not implement an independent account login service.

## Sharing diagnostics

Use synthetic reproductions. Redact tokens, capability URLs, account IDs, real
paths, user content, and tool outputs. Do not attach `runtime.json`, client auth
files, database dumps, or a complete state directory to an issue. Screenshots
should not expose quotas or model/provider names you consider private.

See [installation/removal](INSTALLATION.md) and [security reporting](../SECURITY.md).
