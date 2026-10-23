# Verification scope

The initial open-source preparation was checked locally on Apple Silicon on
2026-10-23. This is development evidence, not a signed-release certification.

| Check                                                        | Result                                     |
| ------------------------------------------------------------ | ------------------------------------------ |
| Clean dependency installation with `npm ci`                  | Passed                                     |
| Repository artifact patterns, local links, pins, action SHAs | Passed                                     |
| Engine/provider/policy/transport regression suite            | 88 passed, 0 failed                        |
| Installer copy, upgrade, rollback, incomplete bundle         | Passed; no UI launched                     |
| Native Apple Silicon build without obfuscation               | Passed                                     |
| Compiled service isolated package checks                     | Passed; localhost providers only           |
| Synthetic absent/null/empty replay                           | 3 cached compactions, no upstream requests |
| Production dependency advisory audit after `ws` update       | No reported vulnerabilities at check time  |
| Developer ZIP/DMG and SHA-256 checksums                      | Generated locally                          |

The replay timings in the local synthetic check were below 10 ms. That number
only measures the fixture path on the test machine; it does not predict provider
latency, client overhead, summary quality, or timing in another real chat.

The compiled checks exercise admin authentication, browser-origin rejection,
provider routing, Codex HTTP/WebSocket, Claude HTTP, usage recording, pause,
persistent settings, same-port restart, and reversible deactivation.

Not established by these checks: Developer ID notarization, installation of a
quarantined download on another Mac, full current-client protocol compatibility,
perfect summary fidelity, or Claude Code end-to-end behavior. GitHub CI results
must be inspected separately for the final commit.
