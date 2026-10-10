# Computer Use

[简体中文](README.md) | English

Give your existing AI agent screenshots and control of authorized application windows through MCP or CLI. Built on [Cua Driver](https://github.com/trycua/cua) and [Playwright](https://github.com/microsoft/playwright), Computer Use provides a macOS menu-bar app and a Windows tray host. Your chosen agent handles task understanding and planning.

**Development preview.** Release v0.6.0 provides ZIP packages for macOS ARM64 and Windows ARM64 and x64, plus a macOS disk image and Windows installers; see [Install a release](#install-a-release). You can also build from source below. See the platform status below for tested coverage.

## Features

- **Desktop operations**: window screenshots, accessibility elements, clicks, typing, hotkeys, scrolling and straight drags; support depends on platform, application and action.
- **Agent integration**: stdio MCP, optional loopback HTTP MCP and an independently usable CLI.
- **Pairing authorization**: one initial approval grants all desktop applications by default, including future apps and windows, and survives restarts. It includes foreground control while execution remains in the background by default. Revoke clients, pause or emergency-stop execution, or explicitly restrict the application scope.
- **Action records**: fresh snapshots and request IDs for tracking outcomes; uncertain actions are never automatically replayed.
- **Separate browser**: Playwright controls an isolated headless Chromium without inheriting your everyday browser's login state.
- **Settings and updates**: a settings window with General, Status, Clients, Connect, Updates and About pages, shown in Simplified Chinese or English to match the system; a daily check for stable GitHub releases, with SHA-256 and release-metadata verification of downloads.

Cua Driver supplies desktop capture, accessibility and input; Playwright supplies browser automation; MCP transport uses the official TypeScript SDK. This project implements the hosts, authorization, sessions and snapshots, deduplication and outcome records, CLI/MCP integration, backend adapters and packaging. See [third-party notices](THIRD_PARTY_NOTICES.md).

## Platform status

| Platform | Build and connection | Validation |
|---|---|---|
| macOS Apple Silicon | macOS 14+ build target; menu-bar app, local CLI / MCP | Locally installed build with the current identifier passed all-app pairing, background input across apps/new windows, pause, emergency stop, restart and revocation checks; earlier Codex tests remain in the historical record |
| Windows 11 ARM64 | Installed and portable tray host; local CLI / MCP, Mac access over SSH | Locally installed build passed 7 background input rounds across two fixtures and three windows, plus authorization controls, in one VM; earlier 66 input cases and Mac Codex tests remain in the historical record |
| Windows 11 x64 | Separate x64 build target | Earlier package passed component checks under x64 emulation on ARM64; native x64 desktop acceptance pending |
| macOS Intel / Linux | No host package provided by this project | Not validated |

The current application identifier is `com.starroy.computeruse`. The local installation checks above were completed on 2026-10-10; they do not establish acceptance of every published artifact or arbitrary third-party applications. Windows desktop compatibility targets Windows 10 version 1809 (build 17763) and later, but Windows 10 and native x64 desktops remain untested. See the [validation record](docs/validation-results.md) (Chinese) for methods, historical results and outstanding coverage.

## Install a release

Download the package for your platform from [Release v0.6.0](https://github.com/starroyhq/computer-use/releases/tag/v0.6.0):

- **macOS (Apple Silicon)**: `computer-use-0.6.0-macos-arm64.dmg`. Open it, drag Computer Use to Applications, then open it from Applications. Alternatively, extract `computer-use-0.6.0-macos-arm64.zip` and move the app to Applications. The release workflow signs the app and DMG with Developer ID, notarizes and staples each separately, and verifies them before publication.
- **Windows**: choose `computer-use-0.6.0-windows-arm64-setup.exe` or `computer-use-0.6.0-windows-x64-setup.exe` for your system architecture. The setup wizard installs for the current user without administrator rights, by default into `%LOCALAPPDATA%\Programs\Computer Use`; open it from the Start menu and uninstall it from Settings → Apps. For a portable copy, extract the complete matching `computer-use-0.6.0-windows-<arm64|x64>.zip` and run `ComputerUse.WindowsHost.exe`; see the [Windows guide](docs/WINDOWS.en.md).

Each ZIP, DMG and installer has a `.sha256` checksum, and each platform has JSON release metadata. Windows installers and portable packages are unsigned; SmartScreen behavior has not been tested. Native x64 installation and the complete flow from downloading a real release to completing an installer upgrade remain unverified.

System permissions work as described below. New v0.6.0 pairings grant all desktop applications by default; existing restricted clients keep their scope. Revoke and pair once again to expand it. ZIPs remain available for macOS one-step updates and Windows portable copies. See the [validation record](docs/validation-results.md) for installation and desktop coverage.

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

Pair the agent once to authorize all desktop applications:

```sh
computer-use pair --profile codex --name 'Codex'
```

Approve all applications in the app, open TextEdit with a new blank test document, then check the connection and generate configuration:

```sh
computer-use doctor --profile codex
computer-use targets --profile codex
computer-use config codex --profile codex
```

`targets` should include the test window. If Chromium is not installed, the browser section of `doctor` may be unavailable; check the desktop backend for desktop use. Import the configuration as described below.

The grant persists without per-window or per-session approval. Existing pairings keep their original scope. To grant all applications, revoke the old client on the Clients page, remove its local profile credential and pair once again. For a restricted test, add `--app com.apple.TextEdit`; for all desktop applications plus the isolated browser, add `--all-apps --browser`. See [Usage](docs/USAGE.md#配对范围--pairing-scope) for all scope options.

### Windows 11

Also requires the .NET 10 SDK. In PowerShell at the Windows repository root (for ARM64, replace `x64` with `arm64` and the output directory suffix with `ARM64`):

```powershell
node scripts/package-windows.mjs --arch x64
& '.\artifacts\Computer Use Windows x64\ComputerUse.WindowsHost.exe'
```

Run the host in your interactive login session. The portable package includes Node, the driver and the .NET runtime; build tools are separate from the components needed to run the result.

Follow the [Windows guide](docs/WINDOWS.en.md) to pair all applications once, then choose local stdio MCP or Mac access to Windows HTTP MCP through an SSH tunnel. No application path is required by default. For an explicit `--app` restriction, Windows uses a full executable path and macOS uses a Bundle ID.

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
- **Windows**: portable copies, including version 0.5.0 and earlier, download and verify the ZIP and show it in File Explorer; quit the tray app, extract the package and replace the current folder with the new one, keeping the same path. An installed v0.6.0 copy can download and verify a new version's installer; choose Run Installer and follow the setup wizard. Setup first asks the tray app to stop its service and quit, upgrades keep the original install location, and paired clients and settings are kept. The complete flow from downloading a real release to completing an installer upgrade remains unverified.

Both hosts run the check and download through the bundled CLI; you can also run `computer-use update check` directly. See [Usage](docs/USAGE.md#检查更新--updates).

## Permissions and limits

- Agents must present a paired client's credential. The default grant covers current and future desktop applications and windows; it does not expand existing pairings or replace macOS system permissions. Pairing approval also grants foreground control (focus, pointer and keyboard) without further prompts, but using it requires explicit `mode: "foreground"`; background execution never falls back automatically. Background support depends on the control and does not guarantee zero focus changes.
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
