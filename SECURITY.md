# Security policy

## Supported code

Security fixes target the latest code on `main`. There is no long-term support
branch or promised response SLA yet. Review the [privacy model](docs/PRIVACY.md)
and [known limitations](docs/LIMITATIONS.md) before enabling an integration.

## Report a vulnerability privately

Use **Security → Report a vulnerability** in this repository:
https://github.com/manomx/compacta/security/advisories/new

Private vulnerability reporting must be enabled before the public launch. If the
form is unavailable, do not publish exploitation details, tokens, or transcripts
in an issue; request a private reporting channel from the maintainer without
including sensitive material.

Include the affected version/commit, macOS and client versions, prerequisites,
minimal synthetic reproduction, and impact. Redact provider credentials, account
identifiers, capability URLs, runtime files, and personal chat/tool contents.

Please allow the maintainer time to investigate and coordinate a fix before
public disclosure. There is no bug bounty program.

## Particularly relevant areas

- Loopback gateway capability checks and admin authentication.
- Client credential handling and Keychain access.
- Checkpoint branch/identity validation and recent-context recovery.
- Prompt injection and preservation of actual user instructions.
- Configuration backups, local file permissions, and package signing.

An automated scan is only one check. It does not establish that a release is
secure or that all client/protocol versions are supported.
