# Computer Use · npm launcher

**Connect your existing Agent to the native Computer Use App on macOS or Windows.**

This is the lightweight launcher for [Computer Use](https://github.com/starroyhq/computer-use), published by **Starroy**. It discovers or installs the official App and delegates commands to that App's bundled CLI and runtime. It contains no second desktop host, production dependencies or install scripts.

The launcher and native App are versioned independently. Updating this npm package does not automatically update an existing App; use the App's update controls for that. New launcher versions are checked and published by GitHub Actions through npm Trusted Publishing.

## Start here

Requires **Node.js 22+** for this launcher. The App itself bundles its runtime. Supported App platforms: macOS 14+ on Apple Silicon, and Windows ARM64/x64. Windows targets Windows 10 1809+, with limited desktop validation on Windows 11 ARM64; native x64 and Windows 10 desktop acceptance remain pending.

```sh
npx @starroy/computer-use setup
# Or use the same package through pnpm:
pnpm dlx @starroy/computer-use setup
```

`setup` discovers an existing App or downloads, verifies and installs the latest official stable release. It then prints a setup prompt to give your Agent. The Agent follows that prompt to install the Skill and verify the connection. System permissions and first pairing approval still happen locally in the App.

`setup` does not launch desktop services, request pairing, clear a stopped state, or edit your Agent's configuration. It only calls the installed App's help, preflight and prompt commands. Existing profiles are preserved. Readiness of a real desktop session is verified afterwards with `doctor`, `targets` and an actual observation.

Want to use the App without Node? [Download the native installer](https://github.com/starroyhq/computer-use/releases/latest) and copy the setup prompt from **Settings → Connect** instead.

## CLI and MCP

Install the launcher globally if you prefer a persistent command:

```sh
npm install -g @starroy/computer-use
# Or: pnpm add -g @starroy/computer-use
computer-use setup --profile default
computer-use preflight --profile default
```

After local approval and pairing, use the App CLI through the same launcher:

```sh
computer-use doctor --profile default
computer-use targets --profile default
computer-use instructions
computer-use config codex --profile default
computer-use mcp stdio --profile default
```

`config codex` (or `config stdio` for generic JSON) produces configuration pointing directly to the App's bundled runtime. Your Agent does not need to invoke npm on each MCP startup. You can also configure the globally installed launcher itself with `mcp stdio`; it forwards stdin/stdout without adding text to the protocol stream.

Every ordinary command performs discovery only. If the App is missing it exits with an installation instruction; only **`setup`** may download or install. Desktop calls retain the App's controlled background startup and authorization behavior. Pause, emergency stop and revoked grants are not bypassed. Actions are never retried by this launcher.

## Options

```sh
computer-use --help
computer-use --version
computer-use setup --profile my-agent --json
computer-use --app-path '/Applications/Computer Use.app' setup --profile my-agent
computer-use --app-path '/Applications/Computer Use.app' targets --profile my-agent
```

- `--help` and `--version` work without an App. `--version` identifies the **npm launcher**; `setup --json` also reports the selected App version.
- `--profile` defaults to `default` for setup and follows the App CLI for other commands.
- `--app-path PATH` must come **before the command**. Supply the App/package directory or the packaged Node/CLI path accepted by discovery. It is required if multiple installations cannot be disambiguated. On Windows a portable package directory is supported.
- `setup --json` prints a single JSON object with installation paths, versions and selected profile/host status. It does not print tokens or treat an offline credential as verified. Exit 0 means setup discovery/reporting succeeded, **not** that desktop access has been granted.
- An older App lacking `preflight` or `skill prompt` is recognized and reported as requiring an upgrade (exit 2), never mistaken for a missing installation. Existing `pair`, `doctor` and `schema` commands can still be forwarded. The launcher does not use ordinary App launch to bypass stopped states.
- Forwarded commands preserve their arguments, output and exit status. For full options, read the App's `instructions` and [usage guide](https://github.com/starroyhq/computer-use/blob/main/docs/USAGE.md).

## Installation checks and permissions

The maintained bootstrap scripts are shared with the standalone Skill. They select the native architecture and verify official HTTPS download addresses, release metadata, size and SHA-256. macOS additionally checks the publisher signature, Bundle ID and notarization. Unknown or incomplete installations are not overwritten. Windows packages remain unsigned and may be blocked by system policy; the launcher does not disable protections.

macOS system permissions and pairing require your local approval. Pairing defaults to all desktop applications and includes foreground permission, while execution defaults to background mode without automatic foreground fallback. Existing restricted pairings keep their scope. Review, pause or revoke access in the App.

## 中文说明

这是 `@starroy/computer-use` 的轻量 npm 入口，GitHub 项目托管在 `starroyhq/computer-use`。npm 与 pnpm 使用同一个发布包。

运行 `npx @starroy/computer-use setup` 发现或安装官方 App，再将输出的提示词交给 Agent 完成 Skill 接入。首次系统授权和配对仍在 App 内批准；已有 profile、暂停、紧停和撤销状态保留。普通 CLI 调用只发现安装，不自动下载。无需 Node 的用户可以直接安装原生 App。

## License

MIT. See [the project](https://github.com/starroyhq/computer-use) and the bundled LICENSE, NOTICE and THIRD_PARTY_NOTICES.md files for attribution.
