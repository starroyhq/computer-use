# Windows ARM64 / x64: installation and agent setup

[简体中文](WINDOWS.md) | English · [Home](../README.en.md)

The locally installed ARM64 build using `com.starroy.computeruse` passed limited acceptance on one **interactive Windows 11 ARM64 VM desktop** on 2026-10-10: one all-app pairing, three windows across two fixtures, 7 background input rounds, pause, resume, emergency stop, restart, revocation and installation over an existing local build. The earlier 66 fixture input cases and one real Mac Codex model regression remain historical evidence. Native x64 acceptance remains pending. See the [validation record](validation-results.md) (Chinese) for full boundaries. A Windows agent can connect through stdio MCP; a Mac can connect through SSH to Windows HTTP MCP, which listens only on `127.0.0.1:47631`. Do not open this port to the LAN. The installer and the portable package are both unsigned. Elevated applications and the UAC secure desktop are unsupported.

Since v0.6.0, desktop compatibility targets Windows 10 version 1809 (build 17763) and later, including Windows 11, with x64 and ARM64 packages. The installer minimum matches the WinForms target `net10.0-windows10.0.17763.0`. **Windows 10 acceptance on a real system is still pending**: allowing installation does not establish desktop correctness.

The isolated browser has a separate boundary: the current Playwright backend's [upstream requirement is Windows 11 or later](https://playwright.dev/docs/intro#system-requirements). Windows 10 ARM64 lacks x64 emulation and cannot run the x64 Chromium used by this backend. All-desktop-application approval does not include the isolated browser, and the Windows 10 desktop compatibility target does not establish browser compatibility.

## Install and uninstall

Download `computer-use-0.7.0-windows-<arm64|x64>-setup.exe` for your system architecture from [Release v0.7.0](https://github.com/starroyhq/computer-use/releases/tag/v0.7.0). For a portable copy, download `computer-use-0.7.0-windows-<arm64|x64>.zip`, extract the entire package and launch `ComputerUse.WindowsHost.exe` from the extracted folder. Do not copy only the EXE. Each installer and ZIP has a `.sha256` checksum; each platform also has JSON metadata.

Installers are available starting with v0.6.0; v0.5.0 and earlier provide only portable packages. Installation over an existing local ARM64 build has been tested. The complete flow from downloading a real release to completing an installer upgrade, native x64 installation and SmartScreen behavior remain unverified; see the [validation record](validation-results.md#windows-安装版全应用授权与后台控制验收2026-10-10) (Chinese).

The setup wizard installs for the current user without administrator rights, by default into `%LOCALAPPDATA%\Programs\Computer Use`; a first install can choose another folder and upgrades keep the original one. It adds a Start menu shortcut, offers an optional desktop shortcut and can start the app when it finishes; silent installation skips that final-page launch. Before installing, setup runs `ComputerUse.WindowsHost.exe --quit` so that a tray app running in the current session (installed or portable) stops its service and quits; version 0.5.0 and earlier do not support `--quit`, so the wizard asks you to quit from the tray menu and try again.

Windows installers and portable packages remain unsigned. SmartScreen or Smart App Control (SAC) may warn or block execution based on signing, reputation and system policy. The new icons and on-demand startup do not remove those restrictions; macOS Developer ID and Apple notarization do not sign Windows packages. Keep the exact system message and follow local or organizational policy. Restarting, disabling protection or changing agent tool approval is not a general fix for a system block.

Uninstall from Settings → Apps. The uninstaller first has the tray app stop its service and quit, then removes the install folder and a sign-in startup entry that points to it. Pairing credentials, settings and logs in `%LOCALAPPDATA%\Computer Use` are kept; delete that folder yourself when you no longer need them.

For an installed copy the CLI is `bin\node.exe runtime\cli.js` in the install folder; the General page of the settings window copies the full command. The commands below run from the package folder; for an installed copy, enter the install folder first:

```powershell
Set-Location "$env:LOCALAPPDATA\Programs\Computer Use"
```

When you move from a portable copy to the installer, the program location changes, so regenerate agent configuration from the new location; pairing credentials stay valid.

Either way, runtime components are bundled; build tools are not required to run the package. Start in your interactive login session. Packages do not include pairing credentials: each user must create and approve their own pairing.

## Connect an agent with an installation prompt

In v0.7.0, the app's Connect page presents **Copy setup prompt** by default. Copy the installation prompt and paste it into your agent so it can install the Skill and complete the connection. The app only generates and copies the prompt; it does not install the Skill or write client configuration. Generating the prompt neither pairs a client nor starts the service. You still approve system permissions and initial client authorization locally, and existing profiles do not need pairing again.

**Advanced connection** is collapsed by default. Expand it to select an existing profile or enter a new name, copy pairing commands and stdio MCP configuration, or enable local HTTP MCP. The default profile is `default`; the installation prompt, pairing command and MCP configuration share the selected name, and copied content contains no pairing credentials. From the package folder, `bin\node.exe runtime\cli.js skill prompt --profile default` prints the same installation prompt.

## On-demand startup and pause protection

Since v0.6.1, complete Windows packages support on-demand startup. CLI and stdio MCP calls made with the package's own `bin\node.exe runtime\cli.js` first probe the default pipe. If unavailable, they invoke the same package’s startup check, which starts a host only when none is running and no pause/stop blocks it, then waits for readiness before the original RPC is sent. MCP `initialize` and `tools/list` neither connect to the runtime nor launch the tray app; the first actual tool call needs the host. Initial pairing still requires local approval and startup does not create a grant.

This requires the current user's interactive login desktop, not a service account or Session 0. Source execution, a custom `--socket`, HTTP and SSH tunnels do not use this automatic startup path. In v0.7.0, complete macOS apps also support controlled startup from the same bundle; missing system permissions return an explicit error requiring the user to open the app. Neither platform searches PATH or other installation folders for a host. Regenerate agent configuration after moving the package.

In v0.7.0, both Windows and macOS record pause and emergency stop in the current user's private `host-state.json`. They survive exit, reopening, login and update launches; only the local Resume/Restart Services buttons clear them. Opening the app shows its state without resuming. The helper also leaves a live failed or stopped host for local recovery. A startup failure sends no original business request; a connection failure after dispatch still has an uncertain outcome and is never automatically replayed.

To check startup separately, run this in PowerShell from the complete installed or portable folder:

```powershell
& .\ComputerUse.WindowsHost.exe --ensure-running | Out-String
```

The helper waits up to 35 seconds and writes exactly one JSON line to stdout. Success is `{"ok":true,"state":"ready"}` with exit code 0. Failure exits nonzero and returns `ok: false`, `code` and `message`; codes are `paused`, `stopped`, `failed`, `non_interactive`, `timeout` or `launch_failed`. Success requires a matching session and host process identity plus a successful probe of the published pipe; an EXE process alone does not establish readiness. This command neither approves pairing nor resumes a pause or emergency stop, and it cannot remove Windows system blocks.

This section describes v0.7.0 interface behavior. See the [validation record](validation-results.md) for historical local-build and VM checks; v0.7.0 release artifacts and CI require separate verification.

## Build and start from source

To build on Windows x64 or ARM64, install .NET 10 SDK and Node 24+ for the host architecture, plus pnpm 10, then obtain the source as described in the [README](../README.en.md). From the repository root in PowerShell:

```powershell
pnpm install --frozen-lockfile
pnpm check
node scripts/package-windows.mjs --arch x64
node scripts/package-windows.mjs --arch x64 --verify-only
& '.\artifacts\Computer Use Windows x64\ComputerUse.WindowsHost.exe'
```

For ARM64, replace `x64` with `arm64` and use the `Computer Use Windows ARM64` output directory. Windows 10 ARM64 builds and verifies native ARM64 components. Building or verifying an x64 package on an ARM64 host requires Windows 11 (build 22000 or later) for x64 emulation; the script fails early with an explanation otherwise. An x64 host cannot build ARM64 packages. Omitting `--arch` selects the current Node architecture.

Packaging downloads pinned Node 24.21.0 and Cua Driver 0.28.2 artifacts, checks official manifests and pinned SHA-256 values, and installs production dependencies for the selected architecture from the lockfile. It checks host, Node, driver and native SDK architecture and loads the SDK. License files are retained. The bundled CLI is `bin\node.exe runtime\cli.js`; no global Node is required. Quitting the tray stops the service and input. Do not replace a running package. Component checks do not establish desktop screenshot or input correctness.

The installer is built from the verified portable folder above and requires [Inno Setup](https://jrsoftware.org/isinfo.php) 7.0.2 or later: Simplified Chinese became an official language in that release, and Inno Setup 6 does not include it by default. The script looks for an `ISCC.exe` with Simplified Chinese in `Inno Setup 7`, then `Inno Setup 6`, under Program Files and the current user's programs folder; set `INNO_SETUP_COMPILER` to use another path:

```powershell
node scripts/package-windows-installer.mjs --arch x64
node scripts/package-windows-installer.mjs --arch x64 --verify-only --smoke-test
```

The result is `artifacts\Computer Use Windows x64 Setup.exe`. `--smoke-test` installs silently into a temporary folder, checks the installed components, uninstall registration and Start menu shortcut, then uninstalls silently. It shares the release AppId, so the script refuses to run when Computer Use is installed for the current user; CI runs it on disposable runners.

Starting the program opens the settings window. Closing it leaves the service running in the notification area; double-click the tray icon or run the program again to reopen it. On the General page, “Start Computer Use when I sign in to Windows” adds a current-user startup entry that starts in the tray only; select it again after moving the portable folder.

v0.6.1 introduced the complete warm-white and dark-charcoal cursor icon for the EXE, tray, settings and approval windows, and installer. The icon identifies the app; it does not indicate signing or change startup and authorization rules.

Since v0.6.0, the window uses a sidebar with six sections: Status, Clients, Connect, General, Updates and About. Emergency Stop stays visible on every page. Status shows the service and pairing count and links to Connect, where you can copy the installation prompt. Manual pairing commands and stdio configuration are under Advanced connection, which is collapsed by default. Clients shows scopes and offers revocation. The pairing dialog separates client identity, desktop scope, isolated browser access, foreground permission, duration and execution behavior. Long content scrolls while decision buttons stay visible. Deny remains the default button and has initial focus; closing the dialog or pressing Escape does not authorize access. Expiry or withdrawal closes the prompt, and an Allow decision requires runtime confirmation.

## Updates

The Updates page checks stable GitHub releases once a day (this can be turned off), and downloads must match the release SHA-256 checksum file and metadata. Since v0.6.0, the app supports both installed and portable update flows; v0.5.0 and earlier use the portable flow. Downloading and running an installer from a real release still needs full acceptance. When the program folder is the install folder in the current user's uninstall registration, the copy counts as installed; otherwise it is portable:

- **Installed**: when the release includes an installer, downloads and verifies it; choose Run Installer and follow the setup wizard. Setup first has the tray app stop its service and quit, installs over the original folder and can start the app when it finishes. Cancelling before you choose Install leaves the tray app running.
- **Portable**: only downloads and verifies the ZIP and shows it in File Explorer. Quit the tray app, extract the whole package and replace the current folder with the new one at the same path so absolute paths in agent configuration stay valid.

Paired clients and settings are stored in `%LOCALAPPDATA%\Computer Use` and are kept either way. Saved pause and emergency-stop states also remain in effect; launching the app after installation does not resume services automatically.

## Local Windows agent: stdio MCP

Since v0.6.0, new pairings grant all desktop applications through one initial approval by default, without an application path; existing restricted clients do not gain a wider scope automatically. The following is the manual setup flow under Advanced connection. Local stdio and remote Mac access are alternatives; you do not need both.

```powershell
Set-Location '.\artifacts\Computer Use Windows x64' # Installed copy or supplied ZIP: enter the install or extracted folder instead
& .\bin\node.exe .\runtime\cli.js pair --profile codex --name 'Codex'
```

Approve all applications in the tray. New apps, windows and host restarts need no further approval. Pairing includes foreground permission, but sessions remain in the background by default and foreground must be requested explicitly, without automatic fallback. Revocation, Pause/Resume and Emergency Stop remain available. Existing pairings keep their original scope; see [Usage](USAGE.md#配对范围--pairing-scope) to change it.

Open an ordinary, non-elevated test application, then run:

```powershell
& .\bin\node.exe .\runtime\cli.js doctor --profile codex
& .\bin\node.exe .\runtime\cli.js targets --profile codex
& .\bin\node.exe .\runtime\cli.js config codex --profile codex
```

Add the output to the Windows user's `~/.codex/config.toml` or a trusted project's `.codex/config.toml`. Reload client configuration and try the [read-only task in the README](../README.en.md#connect-an-agent-and-observe). The configuration contains no credentials and requires neither HTTP nor SSH. Real model validation with Windows-local Codex is pending; earlier cross-machine tests used Mac Codex. Other clients can use `config stdio` for generic JSON configuration.

For fixture-only acceptance, create a separate profile with `pair --profile fixture --name 'Fixture Agent' --app 'C:\path\to\ComputerUseFixture.exe'`, replacing the placeholder with the real full path. Use `fixture` consistently in later commands and agent configuration; repeat `--app` to allow several specific applications. Isolated browser access is separate; see [Pairing scope](USAGE.md#配对范围--pairing-scope).

## Remote Mac access: Windows pairing and credentials

From the repository root, enter the package directory. Skip `Set-Location` if already there. Create a separate remote client profile and approve it in the tray:

```powershell
Set-Location '.\artifacts\Computer Use Windows x64'
& .\bin\node.exe .\runtime\cli.js pair --profile mac-codex --name 'Mac Codex'
& .\bin\node.exe .\runtime\cli.js doctor --profile mac-codex
& .\bin\node.exe .\runtime\cli.js targets --profile mac-codex
```

Approve all applications for this client in the Windows tray. For fixture-only acceptance, add `--app 'C:\path\to\ComputerUseFixture.exe'` to restrict the pairing. Revoking this client invalidates its Mac credentials. Host connection metadata, credentials and logs are kept in the current user's protected `%LOCALAPPDATA%\Computer Use` directory. Do not start the host from a service account or a noninteractive session.

Expand Advanced connection on the Connect page of Settings and enable local HTTP MCP (it lasts for the current run only), then export a new private configuration file:

```powershell
& .\bin\node.exe .\runtime\cli.js config http --profile mac-codex --out "$env:LOCALAPPDATA\Computer Use\mac-codex-mcp.json"
```

This JSON **contains a Bearer credential**. Transfer it only through a trusted SSH/SFTP connection; never put it in Git, chat or a shared folder. Configure Windows OpenSSH Server and key login using Microsoft's [installation guide](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse) and [key management guide](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement).

On the Mac, prepare a private directory and connect with your authorized SSH key. Replace `<Windows-user>` and `<VM-IP>`; verify the host fingerprint on first connection:

```sh
install -d -m 700 "$HOME/.config/computer-use"
sftp -i "$HOME/.ssh/computer_use_windows_ed25519" '<Windows-user>@<VM-IP>'
```

At the SFTP prompt, run `cd "AppData/Local/Computer Use"`, `lcd /Users/<Mac-user>/.config/computer-use`, and `get mac-codex-mcp.json windows-http.json`, replacing the Mac username. Exit SFTP and run `chmod 600 "$HOME/.config/computer-use/windows-http.json"`. You may then delete the exported Windows JSON; the actual pairing credential remains in the host's private storage.

## Mac SSH tunnel and Codex

Keep this tunnel running in a Mac terminal, using your own key, Windows username and VM address:

```sh
ssh -i "$HOME/.ssh/computer_use_windows_ed25519" \
  -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -N \
  -L 127.0.0.1:47631:127.0.0.1:47631 '<Windows-user>@<VM-IP>'
```

If Mac port 47631 is occupied, stop the local service using it before connecting. The tunnel makes `http://127.0.0.1:47631/mcp` on the Mac reach Windows. Do not use `-g` or bind the forward to `0.0.0.0`.

Copy `helpers/windows-remote-auth.mjs` from the install folder or package to `~/.config/computer-use/` on the Mac, or use the repository's `scripts/windows-remote-auth.mjs`. Add the following to Mac user-level `~/.codex/config.toml` or a trusted project's `.codex/config.toml`. Replace all three absolute paths with your actual Node executable, helper script and private JSON paths. The helper returns an Authorization header; the TOML contains no token. Codex supports the helper only in its local execution environment; see the [official MCP guide](https://learn.chatgpt.com/docs/extend/mcp).

```toml
[mcp_servers.computer-use-windows]
url = "http://127.0.0.1:47631/mcp"
http_headers_helper = "/opt/homebrew/bin/node /Users/yourname/.config/computer-use/windows-remote-auth.mjs /Users/yourname/.config/computer-use/windows-http.json"
startup_timeout_sec = 30
tool_timeout_sec = 90
```

Restart Codex and inspect `/mcp` or `codex mcp list`. Start with the README's read-only task, then use `doctor → targets → session_open → observe → act → observe → session_close`. Every action needs a UUID `requestId` and a fresh `snapshotId`. An action without a confirmed response after a tunnel failure is uncertain: reconnect, query `action_status` and observe before deciding what to do. Never automatically replay it. Screenshots are sent to the chosen agent; default action logs exclude images and typed text.

If noninteractive `codex exec` fails with `MCP tool call requires approval, but approval policy is never`, a **temporary configuration connected only to an `--app`-restricted fixture profile** can set `default_tools_approval_mode = "approve"` for this server. Do not change user-level configuration for that test. This only handles Codex tool approval; initial tray pairing approval still applies. In an interactive client, approve tools when prompted. See the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Troubleshooting

Pairing requests expire after 60 seconds. The host closes invalid prompts and removes expired requests from the queue. Clicking Allow submits a decision; approval is shown only after runtime confirmation. Closing the prompt or pressing its default button denies the request. An expired request requires a new request from the agent.

Run `dotnet run --project validation/windows/ComputerUse.WindowsHostTests` on an interactive Windows desktop to test prompt expiry, withdrawal, queued requests, confirmation, default denial, stop cleanup, the settings store, the six sidebar sections, the client list and update actions for installed and portable copies. Default tests use an isolated fake backend and check English and Simplified Chinese layouts at normal and minimum window sizes, including the persistent Emergency Stop button. They cannot grant real permissions or control other applications. `pnpm test` covers runtime authorization semantics.

Add `-- --screenshots <folder>` to save PNGs of all six pages in both languages, the installed update state, narrow Clients/Connect/Updates windows, and all-application and multiple-path scoped pairing dialogs. These screenshots use simulated data and do not establish Windows 10 or desktop input acceptance. The separate `-- --live-update <old-package-folder>` mode checks and downloads the real latest release through that package's CLI, including its installer when the release has one (network required). See the [UI test instructions](../validation/windows/README.md).

- `doctor` cannot connect: the bundled default-pipe client starts the host on demand. Keep the error code and check the complete package, interactive login session and host status. `paused` / `stopped` require local user recovery; inspect Settings for `failed`, and use the login desktop for `non_interactive`. For `timeout` / `launch_failed`, check system block messages, bundled components and matching host/driver versions. Do not delete state files or repeatedly launch the app to clear a user's pause.
- Codex connection refused: check HTTP is enabled, the SSH tunnel is alive and it owns Mac port 47631. Do not open Windows MCP firewall access to troubleshoot.
- `targets` blocked by MCP approval: check the Codex approval policy; dedicated noninteractive fixture tests can use the temporary setting above.
- `401`: check the Mac JSON belongs to the current, unrevoked pairing and has mode `0600`. The helper should output one JSON header object; do not paste that credential-bearing output into logs or chat.
- Missing application or rejected action: verify the window owner process and privilege level; for a scoped pairing, also check the full executable path. Existing pairings do not automatically gain all-application access. Foreground sessions must be requested explicitly (granted at pairing, no per-session prompt); failed background operations never trigger an automatic foreground fallback.

Windows element-directed typing and clicks always use background accessibility, including in approved foreground sessions, with no automatic fallback or retry. Long foreground input without an element ID, canvases and terminals have no completeness guarantee. See [Usage](USAGE.md) for action semantics and the [validation record](validation-results.md) for actual test coverage.
