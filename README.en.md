# Computer Use

A local, agent-independent computer-use runtime built on [Cua Driver](https://github.com/trycua/cua) and [Playwright](https://github.com/microsoft/playwright), with pairing authorization and session management. macOS has a menu-bar app; Windows ARM64 and x64 have development tray hosts. Both expose a CLI, stdio MCP and optional authenticated loopback HTTP MCP. The user supplies the planning/vision agent; no additional model account is required.

Cua Driver supplies desktop screenshots, accessibility and input; Playwright supplies controlled browser automation; MCP transport uses the official TypeScript SDK. This project implements the native hosts, pairing and revocation, session and snapshot management, action deduplication and outcome recording, CLI/MCP integration, backend adapters and packaging. See [third-party notices](THIRD_PARTY_NOTICES.md) for upstream dependencies and licenses.

**Development preview, not a validated general-purpose release.** See [validation](docs/VALIDATION.md) for checks actually run and remaining desktop, creative-application and distribution gates.

## Build

On an Apple Silicon Mac with Xcode, Node 24+ and pnpm 10:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm native:test
pnpm package:app
open 'artifacts/Computer Use.app'
```

The package includes pinned Node and Cua Driver binaries verified by SHA-256. Default signing is ad-hoc development signing, not Developer ID notarization. The deployment target is macOS 14; tested OS support is recorded separately.

The app opens a status and permissions window. Use it to request Accessibility and Screen Recording, then fully quit and reopen after granting permissions. Closing the window keeps the menu-bar app running; opening the app again restores the window. Install the CLI from the menu, or call `Contents/Resources/bin/computer-use` directly. The installer does not overwrite existing commands.

## Connect an agent

```sh
computer-use pair --name 'My Agent' --app com.apple.TextEdit
computer-use doctor
computer-use targets
computer-use schema act
computer-use config stdio
```

Approve the explicit target list in the app. Use a separate `--profile` for each client. The CLI stores credentials privately and never prints them. For Codex, pair a separate profile and run `computer-use config codex --profile codex`. Paste its TOML output into user-level `~/.codex/config.toml` or a trusted project's `.codex/config.toml`, then restart the client. The project does not edit agent configuration automatically; see the [Codex MCP setup guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). `config stdio` remains the generic JSON format. MCP stdio starts with `computer-use mcp stdio`; the CLI itself does not use MCP. The generated config contains a launch path and profile name, not a credential.

The agent can call `doctor → targets → session_open → observe → act → observe → session_close`. `act` requires a UUID `requestId` and the current `snapshotId`; `observe` returns an MCP image. After an uncertain action, query `action_status` and inspect the actual result before considering another action. See the bundled [skill](skills/computer-use/SKILL.md) for the full workflow.

HTTP is off until enabled in the app, listens only on `127.0.0.1:47631`, and validates bearer credentials, Host and Origin. `computer-use config http --out private-mcp.json` writes a private configuration file; never commit it. Direct LAN or cloud listening is outside this release.

To control Windows from Mac Codex, run Computer Use in the Windows interactive desktop and forward its loopback MCP port over SSH. A local `http_headers_helper` reads a private credential file on the Mac, leaving the bearer token out of Codex configuration. See the [Windows build and connection guide](docs/WINDOWS.md) for pairing, secure credential transfer, tunneling and validation. This does not expose the Windows MCP port on the LAN. ARM64 desktop actions have been tested; the x64 package has been built and verified but still needs native x64 desktop testing.

For web tasks, explicitly run `computer-use browser install`, then pair a profile with `--browser`. The runtime creates isolated headless Chromium, without user browser profiles. Authorized browser clients share the runtime's browser space. Downloads use unique private directories.

## Semantics and limits

Observe before acting. Element references and image-pixel coordinates belong to one snapshot; each action consumes it. The runtime serializes mutations and defaults to exclusive sessions. `executed` is not task success; `verified` only indicates the supplied observable condition passed. Query the original request ID after a connection loss; never blindly replay unknown actions.

Background is the default. Desktop dragging requires explicit foreground approval and supports straight two-endpoint gestures. Typing inserts; select existing content first to replace it. Browser dialogs are dismissed. Emergency stop shuts down input. Interrupted input requires a restart; completed dispatch with unconfirmed effects permits read-only inspection and explicit verification. Partial element trees cannot prove an element is absent.

On Windows, `type` with an `elementId` from the latest snapshot uses the driver's background accessibility text path even in an approved foreground session. A refusal or uncertain result is never retried through foreground input. Long foreground text without `elementId`, canvas editors and terminals are not covered by this guarantee.

On Windows, `click` with an `elementId` also uses the background accessibility path in an approved foreground session. Screenshot-coordinate clicks still use foreground pointer delivery. A refused or uncertain element click is not retried through another route.

No screenshot, typed-text, window-title or URL content is stored in the default action journal. CLI screenshots remain private local files until removed. Results sent to a cloud agent are still processed by that agent's provider. Local authorization is not isolation from other processes running as the same OS user.

Original source and documentation are licensed under [MIT](LICENSE), copyright Starroy, with attribution in [NOTICE](NOTICE). Commercial use, modification and redistribution are permitted provided the copyright and permission notices are included in copies or substantial portions of the software. LICENSE contains the complete terms. Dependencies, including Cua Driver, Playwright, Node.js and .NET, retain their own licenses. See [third-party notices](THIRD_PARTY_NOTICES.md), [packaging](scripts/README.md), [architecture](docs/ARCHITECTURE.md) and [roadmap](docs/ROADMAP.md).
