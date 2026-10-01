# Computer Use

[简体中文](README.md) | English

Give your existing AI agent screenshots and control of authorized application windows through MCP or CLI. Built on [Cua Driver](https://github.com/trycua/cua) and [Playwright](https://github.com/microsoft/playwright), Computer Use provides a macOS menu-bar app and a Windows tray host. Your chosen agent handles task understanding and planning.

**Development preview.** Download the macOS ARM64, Windows ARM64 or x64 portable package from [Releases](https://github.com/starroyhq/computer-use/releases), or build from source below. There is no installer yet; see the platform status below for tested coverage.

## Features

- **Desktop operations**: window screenshots, accessibility elements, clicks, typing, hotkeys, scrolling and straight drags; support depends on platform, application and action.
- **Agent integration**: stdio MCP, optional loopback HTTP MCP and an independently usable CLI.
- **Pairing authorization**: explicitly select applications; one pairing approval also grants foreground control and persists until the client is revoked; pause or stop execution.
- **Action records**: fresh snapshots and request IDs for tracking outcomes; uncertain actions are never automatically replayed.
- **Separate browser**: Playwright controls an isolated headless Chromium without inheriting your everyday browser's login state.
- **Settings and updates**: a settings window with General, Status, Clients, Connect, Updates and About pages, shown in Simplified Chinese or English to match the system; a daily check for stable GitHub releases, with SHA-256 and release-metadata verification of downloads.

Cua Driver supplies desktop capture, accessibility and input; Playwright supplies browser automation; MCP transport uses the official TypeScript SDK. This project implements the hosts, authorization, sessions and snapshots, deduplication and outcome records, CLI/MCP integration, backend adapters and packaging. See [third-party notices](THIRD_PARTY_NOTICES.md).

## Platform status

| Platform | Build and connection | Validation |
|---|---|---|
| macOS Apple Silicon | macOS 14+ build target; menu-bar app, local CLI / MCP | Previous identifier tested with AppKit Fixture and Codex; current identifier passes build and signature checks, desktop regression pending |
| Windows 11 ARM64 | Portable tray development package; local CLI / MCP, Mac access over SSH | Current build passed 66 fixture input cases, one Mac Codex model regression, authorization/disconnect/exit checks in one VM |
| Windows 11 x64 | Separate x64 build target | Earlier package passed component checks under x64 emulation on ARM64; native x64 desktop acceptance pending |
| macOS Intel / Linux | No host package provided by this project | Not validated |

The current application identifier is `com.starroy.computeruse`. Windows ARM64 passed the limited acceptance above; earlier macOS and x64 evidence does not establish current-build acceptance. See the [validation record](docs/validation-results.md) (Chinese) for results and outstanding coverage.

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

Open Settings… from the menu bar icon and choose Install in ~/.local/bin… on the General page, then check the launcher in your current terminal:

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

## Settings and updates

The menu bar icon (the notification-area icon on Windows) shows the service state; its menu keeps only Settings, Pause/Resume, Emergency Stop, Restart, Check for Updates and Quit. Pairing approvals still appear as dialogs. Paired clients, their scopes and revocation live on the Clients page of Settings; the local HTTP MCP switch and the stdio configuration live on the Connect page. Opening at login is off by default; macOS uses a system login item and Windows a current-user startup entry.

Automatic checks are on by default and run at most once a day. They read only this repository's latest stable GitHub release (never drafts, prereleases or older versions) and send no usage data. Turn them off on the Updates page or skip a version. Checks use the GitHub API first. The unauthenticated API allows 60 requests per hour per IP; when that is used up or the API is unreachable, the check reads the github.com release page instead, with the same result. A download must match the release's SHA-256 checksum file and metadata, and GitHub's recorded digest when read through the API:

- **macOS**: signed releases install in one step. The app extracts the new version, confirms that its bundle identifier, version and signing team match the running app and that it passes Gatekeeper, then after your confirmation stops the service, replaces the app in place and reopens it; system permissions and paired clients are kept. When the system runs the app from a translocated location (for example, opened straight from Downloads) or its folder is not writable, the verified new version is shown in Finder for a manual replacement instead. Development builds from source only check manually.
- **Windows**: portable packages are unsigned, so the host downloads and verifies the package and shows it in File Explorer. Quit the tray app, extract the package and replace the current folder with the new one, keeping the same path.

Both hosts run the check and download through the bundled CLI; you can also run `computer-use update check` directly. See [Usage](docs/USAGE.md#检查更新--updates).

## Permissions and limits

- This project's interface exposes only paired targets; pairing approval also grants foreground control (focus, pointer and keyboard) without further prompts; clients paired by earlier versions must pair again to use foreground. Background support depends on the control and does not guarantee zero focus changes.
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
- [GitHub CI and development artifacts](docs/CI.md) (Chinese): platform checks, downloads, checksums and acceptance limits
- [Validation procedure](docs/VALIDATION.md), [results](docs/validation-results.md) (Chinese), [roadmap](docs/ROADMAP.md)

## License and acknowledgments

Original source and documentation are [MIT](LICENSE)-licensed, copyright Starroy; see [NOTICE](NOTICE). Thanks to Cua, Playwright, the MCP SDK and other upstream projects. Dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
