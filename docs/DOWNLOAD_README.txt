Compacta — Apple Silicon, macOS 14 or later

Drag Compacta.app to Applications, then open it. The app installs its
user-scoped copy in ~/Applications and starts a background service. Choose
your client and a model available to your account. Start a new Codex chat or
Claude Code session after a fresh activation.

Notarized builds open normally. If macOS blocks the first open, right-click
Compacta.app and choose Open, or use System Settings → Privacy & Security →
Open Anyway. You can also clear this app's quarantine flag:

xattr -dr com.apple.quarantine /Applications/Compacta.app

That does not turn off Gatekeeper.

Source: https://github.com/manomx/compacta
Documentation and privacy: see the repository before enabling an integration.

Summary preparation uses provider quota/API credit. Conversation content goes to
the selected provider. API keys use macOS Keychain; local context caches are not
fully encrypted by Compacta. Close-window and quit-UI actions leave the service
running. Disable integrations in the app before removing it.
