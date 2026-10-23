# Third-party notices

Compacta's own source is MIT licensed. Keep these notices with source and binary
distributions. The build copies runtime dependency, font, and Bun notices into
`Compacta.app/Contents/Resources/Licenses/`.

| Component         | Use                          | License / source                                                                 |
| ----------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `ws`              | WebSocket transport          | MIT, installed package `LICENSE`                                                 |
| `@iarna/toml`     | Client configuration parsing | ISC, installed package `LICENSE`                                                 |
| Plus Jakarta Sans | Bundled app font             | SIL OFL 1.1, [notice](docs/licenses/PlusJakartaSans-OFL.txt)                     |
| Bun               | Compiled service runtime     | MIT runtime with additional bundled components; [notices](docs/licenses/Bun.txt) |

Bun embeds third-party libraries with their own terms, including JavaScriptCore.
Do not describe every byte of a compiled service as MIT-only. Before distributing
binaries, review the pinned runtime's complete notices and applicable source /
relinking requirements. The readable service source and pinned build are retained
to support rebuilding; they do not waive third-party obligations.

Upstream references: https://github.com/websockets/ws,
https://github.com/iarna/iarna-toml, https://github.com/oven-sh/bun,
https://github.com/tokotype/PlusJakartaSans.
