---
name: computer-use
description: Set up and use the local Computer Use App to operate authorized macOS or Windows application windows and isolated browser pages. Use for screenshot-based desktop interaction, GUI checks, and cross-application workflows, including first use when the App is not installed.
---

# Computer Use

This file is a complete first-use guide. No repository clone, other Skill files, global Node, or MCP server is required. Installation uses the official [Computer Use releases](https://github.com/starroyhq/computer-use/releases/latest). The App supplies its own CLI runtime.

The embedded installers use GitHub and the official [release mirror](https://computer-use-download-1308799022.cos.ap-guangzhou.myqcloud.com/computer-use/latest.json). Only a network failure, timeout, server error or explicit rate limit permits switching sources. Once a release is selected, its version, source commit, size and SHA-256 stay fixed; an incomplete alternate source cannot silently select an older release. Verification failures, invalid metadata, certificate errors and cancellation stop installation. Do not override these checks or substitute a third-party mirror. Official release and download services receive the corresponding network requests. An installed App remains discoverable without network access. The isolated browser's Chromium download is separate and is not mirrored here.

<!-- computer-use-local-binding -->

## Start each conversation

Complete these steps before opening a session or sending any action in every new Agent conversation, even when this Skill and its profile are already installed:

1. Validate the installed package using First connection below. Keep the local binding's selected profile unless the user explicitly chooses another; refreshing the guide does not require reinstalling or pairing again.
2. Read that package's CLI `--help`, then run `instructions` when supported and read the returned guide. Reading this Skill, `--help`, or `doctor` alone does not replace this step. Do not use commands remembered from an earlier conversation as the current guide.
3. Run `preflight --profile NAME` when supported, then follow the current guide to connect or handle the reported state. Read `profile.authorization` when present; it is verified only while the host is online. A missing field leaves scope unknown.

Use the installed guide for version-specific commands and fault recovery. If an operation reveals a command or service compatibility problem, reread that guide before handling it. When `instructions` is unsupported, use the embedded guide and CLI schemas as the fallback. Reading a newer guide never expands the user's task or grants permission to bypass pause, emergency stop, revoked access, or system permissions.

## First connection

1. If this file contains a local binding, use its paths and profile as discovery hints, never as commands to execute blindly. Default to profile `default`; preserve an explicitly chosen profile. Validate the complete package using the matching bootstrap below. Save only that fenced script to a private temporary file and execute it with `/bin/bash` on macOS or a normal PowerShell 5+ process on Windows. Prefer the binding’s `packageRoot` (App bundle on macOS, package directory on Windows); otherwise use `cli` or `node`. Supply that path as the script’s first argument (`-Hint` on Windows). With no hint, omit the argument. If a previously exported path is now missing because the App moved, rerun the same script without the hint to discover standard locations; do not treat the stale hint alone as evidence that installation is required. These scripts discover an existing package first and install only when none exists. They do not start the Host, approve permissions, or pair. Multiple packages, incomplete installations and failed checks require review; do not delete them or silently choose another.
2. Use the returned absolute CLI paths: macOS invokes `cli` directly; Windows invokes `node` with `cli` as its first argument. Pass arguments as an array, never interpolate a path into evaluated shell text. Read `--help`. If supported, run `preflight --profile NAME`, then `instructions` and use its current operating guide. These local commands do not require pairing and do not launch the Host. `preflight` is JSON, without a `--json` flag.
3. For a preflight `valid` or `unverified` profile, go directly to `doctor --profile NAME`; do not pair again. A `missing` profile permits first pairing only when there is no known revocation: `pair --profile NAME --name "My Agent"`. `invalid` or `unauthorized` credentials require local review, not automatic replacement. Let the default-IPC CLI perform controlled startup. The user grants macOS Accessibility/Screen Recording and approves the first pairing locally. Never auto-approve those prompts. A service fault follows the autonomous fault-recovery flow below. User pause/stop, revoked access, missing system permissions, and malformed state require local review; none is a reason to reinstall or silently re-pair.
4. After first pairing approval, or directly for an existing profile, run `doctor --profile NAME`, inspect its `authorization` when present, then run `targets --profile NAME`, open a background session for an authorized target, and `observe`. Windows outside the client's grant are omitted from `targets`; a missing window is not by itself evidence that the application is closed. For a restricted profile that excludes the task's application, explain its scope and point the user to the App's Clients → Allow all apps control. If that control or the authorization diagnostics are absent in an older App, use local user review or an App upgrade; do not delete credentials or automatically re-pair. Open the returned screenshot with the Agent’s image reader. Confirm this actual observation before claiming setup works.

An existing v0.6.1 package is still an installation even though it lacks `preflight` and `instructions`. Use its `--help`, `schema`, and the guide below. Check only whether the selected credential file exists; never print its contents. macOS profiles live in `~/.config/computer-use/NAME.json`; Windows profiles live in `%LOCALAPPDATA%\Computer Use\credentials\NAME.json`. Pair only if missing. Existing credentials may be invalid or revoked: let `doctor` report authentication failure and have the user review the profile. Windows v0.6.1 supports controlled startup. On an older macOS package without controlled startup, use an already-running Host or ask the user to review its state and upgrade in the App; do not run `open` or the GUI executable to bypass a stop. An unsupported command is never evidence that the App needs installing again.

The first copied Skill remains usable offline with an installed App. It cannot update itself: bootstrap and recovery rules below remain the fallback, while `instructions` and method schemas provide the installed version’s current behavior. Newer instructions may support explicit service-fault recovery through `recover`, but do not authorize broader grants or bypass the user’s pause, stop or task scope. Detect command support from the installed CLI instead of inferring it from the Skill’s age.

{{INSTRUCTIONS}}

## macOS discovery and first installation

Run only on Apple Silicon macOS. Save this block as a temporary `.sh` file and invoke `/bin/bash FILE [APP_OR_CLI_HINT]`. The script emits one JSON result containing the validated App and CLI paths. Its fixed download sources cannot be overridden by environment variables.

<!-- computer-use-bootstrap:macos -->
```bash
{{MACOS_BOOTSTRAP}}
```

## Windows discovery and first installation

Run in the signed-in user’s normal PowerShell on Windows 10 build 17763 or newer. Save this block as a temporary `.ps1` file and invoke it normally, optionally with `-Hint 'PACKAGE_OR_CLI_PATH'`. Do not use `ExecutionPolicy Bypass`; if the host’s policy blocks scripts, have the user follow their normal trusted-script process. The script emits JSON containing the validated package, embedded Node and CLI paths. It uses the native OS architecture, including when PowerShell itself is emulated on ARM64.

<!-- computer-use-bootstrap:windows -->
```powershell
{{WINDOWS_BOOTSTRAP}}
```
