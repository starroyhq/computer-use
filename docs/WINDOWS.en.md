# Windows ARM64 / x64 development packages and agent setup

[简体中文](WINDOWS.md) | English · [Home](../README.en.md)

The current ARM64 package using `com.starroy.computeruse` passed limited acceptance on one **interactive Windows 11 ARM64 VM desktop**: 66 fixture input cases, one real Mac Codex model regression, and authorization, disconnect and exit checks. Native x64 acceptance remains pending. See the [validation record](validation-results.md) (Chinese) for full boundaries. A Windows agent can connect through stdio MCP; a Mac can connect through SSH to Windows HTTP MCP, which listens only on `127.0.0.1:47631`. Do not open this port to the LAN. Packages are development artifacts, not signed installers. Elevated applications and the UAC secure desktop are unsupported.

## Build and start on Windows

If someone supplies a portable ZIP, extract the entire package on Windows 11 of the matching architecture and launch `ComputerUse.WindowsHost.exe`. Do not copy only the EXE. Runtime components are bundled; build tools are not required to run the package. Start in your interactive login session. Packages do not include pairing credentials: each user must create and approve their own pairing.

To build, install .NET 10 SDK, Node 24+ and pnpm 10, then obtain the source as described in the [README](../README.en.md). From the repository root in PowerShell:

```powershell
pnpm install --frozen-lockfile
pnpm check
node scripts/package-windows.mjs --arch x64
node scripts/package-windows.mjs --arch x64 --verify-only
& '.\artifacts\Computer Use Windows x64\ComputerUse.WindowsHost.exe'
```

For ARM64, replace `x64` with `arm64` and use the `Computer Use Windows ARM64` output directory. An ARM64 host can also build x64 packages and run component checks through Windows x64 emulation. An x64 host cannot build ARM64 packages. Omitting `--arch` selects the current Node architecture.

Packaging downloads pinned Node 24.21.0 and Cua Driver 0.28.2 artifacts, checks official manifests and pinned SHA-256 values, and installs production dependencies for the selected architecture from the lockfile. It checks host, Node, driver and native SDK architecture and loads the SDK. License files are retained. The bundled CLI is `bin\node.exe runtime\cli.js`; no global Node is required. Quitting the tray stops the service and input. Do not replace a running package. Component checks do not establish desktop screenshot or input correctness.

Starting the program opens the settings window. Closing it leaves the service running in the notification area; double-click the tray icon or run the program again to reopen it. On the General page, “Start Computer Use when I sign in to Windows” adds a current-user startup entry that starts in the tray only; select it again after moving the portable folder. The Updates page checks stable GitHub releases once a day (this can be turned off). Portable packages are unsigned, so the host only downloads and verifies a package and shows it in File Explorer. To install it, quit the tray app, extract the whole package and replace the current folder with the new one at the same path so absolute paths in agent configuration stay valid. Paired clients are stored in `%LOCALAPPDATA%\Computer Use` and are kept.

## Local Windows agent: stdio MCP

Open an ordinary, non-elevated test application and pair its **full executable path**. The path below is a placeholder: substitute your own disposable test application. Local stdio and remote Mac access are alternatives; you do not need both.

```powershell
Set-Location '.\artifacts\Computer Use Windows x64' # For a supplied ZIP, run subsequent commands in its extracted directory
& .\bin\node.exe .\runtime\cli.js pair --profile codex --name 'Codex' --app 'C:\path\to\ComputerUseFixture.exe'
```

Approve the request in the tray, then run:

```powershell
& .\bin\node.exe .\runtime\cli.js doctor --profile codex
& .\bin\node.exe .\runtime\cli.js targets --profile codex
& .\bin\node.exe .\runtime\cli.js config codex --profile codex
```

Add the output to the Windows user's `~/.codex/config.toml` or a trusted project's `.codex/config.toml`. Reload client configuration and try the [read-only task in the README](../README.en.md#connect-an-agent-and-observe). The configuration contains no credentials and requires neither HTTP nor SSH. Real model validation with Windows-local Codex is pending; earlier cross-machine tests used Mac Codex. Other clients can use `config stdio` for generic JSON configuration.

## Remote Mac access: Windows pairing and credentials

From the repository root, enter the portable package directory. Skip `Set-Location` if already there. Create a separate remote client profile and approve it in the tray:

```powershell
Set-Location '.\artifacts\Computer Use Windows x64'
& .\bin\node.exe .\runtime\cli.js pair --profile mac-codex --name 'Mac Codex' --app 'C:\path\to\ComputerUseFixture.exe'
& .\bin\node.exe .\runtime\cli.js doctor --profile mac-codex
& .\bin\node.exe .\runtime\cli.js targets --profile mac-codex
```

Approve only intended executable paths. Revoking this client invalidates its Mac credentials. Host connection metadata, credentials and logs are kept in the current user's protected `%LOCALAPPDATA%\Computer Use` directory. Do not start the host from a service account or a noninteractive session.

Enable local HTTP MCP on the Connect page of Settings (it lasts for the current run only), then export a new private configuration file:

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

Copy `helpers/windows-remote-auth.mjs` from the package to `~/.config/computer-use/` on the Mac, or use the repository's `scripts/windows-remote-auth.mjs`. Add the following to Mac user-level `~/.codex/config.toml` or a trusted project's `.codex/config.toml`. Replace all three absolute paths with your actual Node executable, helper script and private JSON paths. The helper returns an Authorization header; the TOML contains no token. Codex supports the helper only in its local execution environment; see the [official MCP guide](https://learn.chatgpt.com/docs/extend/mcp).

```toml
[mcp_servers.computer-use-windows]
url = "http://127.0.0.1:47631/mcp"
http_headers_helper = "/opt/homebrew/bin/node /Users/yourname/.config/computer-use/windows-remote-auth.mjs /Users/yourname/.config/computer-use/windows-http.json"
startup_timeout_sec = 30
tool_timeout_sec = 90
```

Restart Codex and inspect `/mcp` or `codex mcp list`. Start with the README's read-only task, then use `doctor → targets → session_open → observe → act → observe → session_close`. Every action needs a UUID `requestId` and a fresh `snapshotId`. An action without a confirmed response after a tunnel failure is uncertain: reconnect, query `action_status` and observe before deciding what to do. Never automatically replay it. Screenshots are sent to the chosen agent; default action logs exclude images and typed text.

If noninteractive `codex exec` fails with `MCP tool call requires approval, but approval policy is never`, a **temporary configuration limited to a paired disposable fixture** can set `default_tools_approval_mode = "approve"` for this server. Do not change user-level configuration for that test. This only handles Codex tool approval; tray pairing approval still applies. In an interactive client, approve tools when prompted. See the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Troubleshooting

Pairing and foreground requests expire after 60 seconds. The host closes invalid prompts and removes expired requests from the queue. Clicking Allow submits a decision; approval is shown only after runtime confirmation. Closing the prompt or pressing its default button denies the request. An expired request requires a new request from the agent.

Run `dotnet run --project validation/windows/ComputerUse.WindowsHostTests` on an interactive Windows desktop to test prompt expiry, queued requests, confirmation, default denial, stop cleanup, both translation tables, the settings store, the six settings pages and the client list. Add `-- --screenshots <folder>` to save every settings page as PNG, or `-- --live-update <old-package-folder>` to check and download the real latest release through that package's CLI (network required). This harness uses a runtime double and cannot grant real permissions or control other applications. `pnpm test` covers runtime authorization semantics.

- `doctor` cannot connect: check that the tray runs in the logged-in desktop and that host and driver versions match.
- Codex connection refused: check HTTP is enabled, the SSH tunnel is alive and it owns Mac port 47631. Do not open Windows MCP firewall access to troubleshoot.
- `targets` blocked by MCP approval: check the Codex approval policy; dedicated noninteractive fixture tests can use the temporary setting above.
- `401`: check the Mac JSON belongs to the current, unrevoked pairing and has mode `0600`. The helper should output one JSON header object; do not paste that credential-bearing output into logs or chat.
- Missing application or rejected action: verify the executable path, window owner process and privilege level. Foreground sessions must be requested explicitly (granted at pairing, no per-session prompt); failed background operations never trigger an automatic foreground fallback.

Windows element-directed typing and clicks always use background accessibility, including in approved foreground sessions, with no automatic fallback or retry. Long foreground input without an element ID, canvases and terminals have no completeness guarantee. See [Usage](USAGE.md) for action semantics and the [validation record](validation-results.md) for actual test coverage.
