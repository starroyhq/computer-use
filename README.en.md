# Computer Use

[简体中文](README.md) | English

Give your existing AI agent screenshots and control of authorized application windows through MCP or CLI. Built on [Cua Driver](https://github.com/trycua/cua) and [Playwright](https://github.com/microsoft/playwright), Computer Use provides a macOS menu-bar app and a Windows tray host. Your chosen agent handles task understanding and planning.

**Development preview; build from source.** There is no official installer or published release package yet. See the platform status below for tested coverage.

## Features

- **Desktop operations**: window screenshots, accessibility elements, clicks, typing, hotkeys, scrolling and straight drags; support depends on platform, application and action.
- **Agent integration**: stdio MCP, optional loopback HTTP MCP and an independently usable CLI.
- **Pairing authorization**: explicitly select applications, approve foreground sessions locally, pause, revoke clients or stop execution.
- **Action records**: fresh snapshots and request IDs for tracking outcomes; uncertain actions are never automatically replayed.
- **Separate browser**: Playwright controls an isolated headless Chromium without inheriting your everyday browser's login state.

Cua Driver supplies desktop capture, accessibility and input; Playwright supplies browser automation; MCP transport uses the official TypeScript SDK. This project implements the hosts, authorization, sessions and snapshots, deduplication and outcome records, CLI/MCP integration, backend adapters and packaging. See [third-party notices](THIRD_PARTY_NOTICES.md).

## Platform status

| Platform | Build and connection | Validation |
|---|---|---|
| macOS Apple Silicon | macOS 14+ build target; menu-bar app, local CLI / MCP | Previous identifier tested with AppKit Fixture and Codex; current identifier passes build and signature checks, desktop regression pending |
| Windows 11 ARM64 | Portable tray development package; local CLI / MCP, Mac access over SSH | Previous identifier tested with Win32 / WinForms / WPF Fixture and Mac Codex in one VM; current source needs repackaging and regression |
| Windows 11 x64 | Separate x64 build target | Earlier package passed component checks under x64 emulation on ARM64; native x64 desktop acceptance pending |
| macOS Intel / Linux | No host package provided by this project | Not validated |

The current application identifier is `com.starroy.computeruse`. Desktop tests above used earlier development builds and do not establish acceptance for the renamed version. See the [validation record](docs/validation-results.md) (Chinese) for results and outstanding coverage.

## Quick start: build from source

Install Git, Node 24+ and pnpm 10, then get the source:

```sh
git clone https://github.com/starroyhq/computer-use.git
cd computer-use
pnpm install --frozen-lockfile
```

### macOS

Requires an Apple Silicon Mac and the Xcode/Swift toolchain. From the repository root:

```sh
pnpm package:app
open 'artifacts/Computer Use.app'
```

Request Accessibility and Screen Recording in the app, grant them to Computer Use, then fully quit and reopen it. Default builds use ad-hoc development signing and are not notarized; re-signing or changing the application identifier may require new grants. Do not replace the app while it is running.

Choose “安装 CLI 到 ~/.local/bin” in the menu bar (install CLI), then check the launcher in your current terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
command -v computer-use
computer-use --help
```

This `export` only affects the current terminal; new terminals need the same PATH setting. You can also invoke `artifacts/Computer Use.app/Contents/Resources/bin/computer-use` directly.

Open TextEdit with a new blank test document and pair the agent:

```sh
computer-use pair --profile codex --name 'Codex' --app com.apple.TextEdit
```

Approve in the app, then check the connection and generate configuration:

```sh
computer-use doctor --profile codex
computer-use targets --profile codex
computer-use config codex --profile codex
```

`targets` should include the test window. If Chromium is not installed, the browser section of `doctor` may be unavailable; check the desktop backend for desktop use. Import the configuration as described below.

### Windows 11

Also requires the .NET 10 SDK. In PowerShell at the Windows repository root (for ARM64, replace `x64` with `arm64` and the output directory suffix with `ARM64`):

```powershell
node scripts/package-windows.mjs --arch x64
& '.\artifacts\Computer Use Windows x64\ComputerUse.WindowsHost.exe'
```

Run the host in your interactive login session. The portable package includes Node, the driver and the .NET runtime; build tools are separate from the components needed to run the result.

Follow the [Windows guide](docs/WINDOWS.en.md) to pair executable paths, then choose local stdio MCP or Mac access to Windows HTTP MCP through an SSH tunnel. **Windows pairing uses a full executable path, not a macOS Bundle ID.**

## Connect an agent and observe

Add the TOML from `config codex` to Codex's user-level `~/.codex/config.toml` or a trusted project's `.codex/config.toml`. It contains absolute launch paths and a profile, not credentials. The project does not edit agent configuration automatically. See the [Codex MCP setup guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Reload the client's MCP configuration, then start with a read-only task:

> Use computer-use to check the connection, list authorized windows, open a session for the test window, capture and describe its screenshot, then close the session. Do not click or type during this task.

Expect a real window screenshot and description. Confirm that flow before trying input and clicks in a disposable document. Other agents can use `computer-use config stdio --profile codex` for a paired profile's generic JSON configuration; real model integration with other clients is still pending validation.

For manual CLI calls, browser setup and action parameters, see [Usage](docs/USAGE.md) and the bundled [CLI skill](skills/computer-use/SKILL.md).

## Permissions and limits

- This project's interface exposes only paired targets; foreground sessions require local approval. Background support depends on the control and does not guarantee zero focus changes.
- Query `action_status` and observe after uncertainty; do not blindly replay. `executed` is not task success: inspect the actual UI or output artifact.
- HTTP is off by default and listens only on `127.0.0.1:47631`. Cross-machine access uses a manual SSH tunnel, not direct LAN or public MCP exposure.
- Default action logs exclude screenshots, typed text, URLs and window titles. CLI screenshots remain local until removed; screenshots and results sent to a cloud agent are processed by its provider.
- Authorized browser clients share the controlled browser space. Local authorization does not isolate malicious processes running as the same OS user.
- Elevated Windows apps, the UAC secure desktop, and long text in canvases or terminals are outside validated coverage. See [Usage](docs/USAGE.md) for platform-specific action semantics.

## Development and documentation

```sh
pnpm check
pnpm native:test # macOS only
```

Browser integration tests require matching Chromium; missing components cause skips, not passes. Install the development test browser with `pnpm exec playwright install chromium`.

- [Usage](docs/USAGE.md): CLI, action semantics, browser setup and troubleshooting
- [Windows guide](docs/WINDOWS.en.md) / [Windows 接入](docs/WINDOWS.md)
- [Architecture](docs/ARCHITECTURE.md), [packaging](scripts/README.md) (Chinese)
- [Validation procedure](docs/VALIDATION.md), [results](docs/validation-results.md) (Chinese), [roadmap](docs/ROADMAP.md)

## License and acknowledgments

Original source and documentation are [MIT](LICENSE)-licensed, copyright Starroy; see [NOTICE](NOTICE). Thanks to Cua, Playwright, the MCP SDK and other upstream projects. Dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
