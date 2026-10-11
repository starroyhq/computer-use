# 使用说明 / Usage

[中文首页](../README.md) · [English home](../README.en.md) · [Windows 中文](WINDOWS.md) · [Windows English](WINDOWS.en.md)

先按首页完成构建、启动和配对。以下示例使用已配对的 `codex` profile；替换返回的 ID，不要直接执行占位符。Windows 在便携包目录中将 `computer-use` 换为 `& .\bin\node.exe .\runtime\cli.js`。

Build, start and pair as described in the README first. Examples use an existing `codex` profile. Replace placeholder IDs with returned values. On Windows, run from the portable package directory and replace `computer-use` with `& .\bin\node.exe .\runtime\cli.js`.

## Windows 按需启动 / Windows on-demand startup

v0.6.1 中，同一完整 Windows 包的 `bin\node.exe runtime\cli.js` 在默认管道不可达时，按需启动同包宿主，等待就绪后才发出实际 RPC。stdio MCP 的初始化与工具列表保持懒连接，不启动宿主；首次实际工具调用才检查。该行为不适用于源码运行、macOS、自定义 `--socket` 或远程 HTTP。 / In v0.6.1, the complete Windows package's own `bin\node.exe runtime\cli.js` starts its bundled host when the default pipe is unavailable and waits for readiness before sending an actual RPC. stdio MCP initialization and tool listing remain lazy and do not start the host; the first actual tool call checks it. This does not apply to source execution, macOS, a custom `--socket` or remote HTTP.

暂停和紧停在宿主退出后仍阻止自动启动，需由用户本机恢复、重启服务，或在宿主退出后主动打开 App。已运行但失败或停止的 Host 不会被自动重启。不要通过删除 `host-state.json`、换管道或反复启动来解除这些状态。启动失败时没有发送原 RPC；已发送动作的失败仍需按原 `requestId` 查询，不能重放。 / Pause and emergency stop continue to block automatic startup after the host exits. The user must resume or restart services locally, or deliberately open the app after exit. An existing failed or stopped host is not automatically restarted. Do not delete `host-state.json`, change pipes or repeatedly launch the app to clear these states. A startup failure sends no original RPC; failures after action dispatch still require querying the original `requestId`, never replaying it.

同包 `ComputerUse.WindowsHost.exe --ensure-running` 可单独检查启动，最多等待 35 秒，stdout 返回单行 JSON：成功 `{"ok":true,"state":"ready"}`，退出 0；失败 `{"ok":false,"code":"…","message":"…"}`，退出非零。`paused` / `stopped` 需用户恢复，`failed` 查看宿主状态，`non_interactive` 表示应在当前用户交互桌面运行，`timeout` / `launch_failed` 需检查错误及系统提示。它不会批准配对或解除 SmartScreen / Smart App Control 拦截，详见 [Windows 指南](WINDOWS.md#按需启动与暂停保护)。 / The bundled `ComputerUse.WindowsHost.exe --ensure-running` checks startup separately, waiting up to 35 seconds and returning one JSON line: `{"ok":true,"state":"ready"}` with exit 0, or `{"ok":false,"code":"…","message":"…"}` with a nonzero exit. `paused` / `stopped` require user recovery; inspect host status for `failed`; `non_interactive` requires the current user's interactive desktop; inspect errors and system messages for `timeout` / `launch_failed`. It does not approve pairing or remove SmartScreen / Smart App Control blocks. See the [Windows guide](WINDOWS.en.md#on-demand-startup-and-pause-protection).

## 配对范围 / Pairing scope

当前源码默认一次授权所有桌面应用；首次在本机宿主批准后，新应用、新窗口、会话过期和宿主重启都不需要重复配对。macOS 的辅助功能与屏幕录制权限仍需在系统中授予 Computer Use。 / The current source defaults to one grant for all desktop applications. After initial approval in the local host, new apps, new windows, expired sessions and host restarts do not require pairing again. macOS Accessibility and Screen Recording still need to be granted to Computer Use in system settings.

```sh
computer-use pair --profile my-agent --name 'My Agent'
```

| 配对参数 / Pairing options | 授权范围 / Scope |
|---|---|
| 无 / None | 所有桌面应用，等同 `--all-apps`。 / All desktop applications, equivalent to `--all-apps`. |
| `--all-apps --browser` | 所有桌面应用及独立浏览器。 / All desktop applications and the isolated browser. |
| `--app <app-id>` | 仅指定应用，可重复；macOS 用 Bundle ID，Windows 用完整可执行文件路径，可加 `--browser`。 / Only the specified apps; repeat as needed. Use Bundle IDs on macOS and full executable paths on Windows; optionally add `--browser`. |
| `--browser` | 仅独立浏览器，不包含桌面应用。 / Only the isolated browser, without desktop applications. |

`--all-apps` 与 `--app` 不能同时使用。全应用授权包含桌面浏览器窗口，但不自动包含 Playwright 独立浏览器。配对批准包含前台权限，执行默认仍为 `background`，不自动切换前台。可随时在“客户端”页撤销授权，菜单中的暂停/恢复与紧急停止继续有效。 / `--all-apps` cannot be combined with `--app`. All-application access includes desktop browser windows but does not automatically include the isolated Playwright browser. Pairing includes foreground permission; execution still defaults to `background` without automatic fallback. Revoke access on the Clients page, or use Pause/Resume and Emergency Stop from the host menu.

旧版本配对与显式受限配对保留原授权范围，不自动扩权。要改为全应用，先在“客户端”页撤销旧客户端，再执行 `computer-use credentials remove --profile codex`，最后以同一 profile 重新配对一次并批准。`credentials remove` 只删除本地凭据，不撤销其他副本。现有全应用 profile 不需要再次配对。 / Existing pairings and explicit scoped pairings keep their original grants without automatic expansion. To grant all applications, revoke the old client on the Clients page, run `computer-use credentials remove --profile codex`, then pair and approve the same profile once again. Removing a local credential does not revoke other copies. An existing all-application profile does not need to pair again.

## 手动 CLI 流程 / Manual CLI flow

```sh
computer-use doctor --profile codex
computer-use targets --profile codex
computer-use schema act
computer-use session_open --profile codex --json '{"targetId":"TARGET_ID"}'
computer-use observe --profile codex --json '{"sessionId":"SESSION_ID"}'
```

在一次性测试文档中操作：将下面内容保存为 `request.json`，填入当前会话、新快照和该快照中的文本控件 ID。每个新动作使用新的 UUID。CLI 可在省略 `requestId` 时自动生成；MCP 调用必须提供。

Use a disposable test document. Save the following as `request.json` with the current session, a fresh snapshot and its text element ID. Use a new UUID for each new action. CLI generates `requestId` if omitted; MCP callers must supply it.

```json
{
  "sessionId": "SESSION_ID",
  "snapshotId": "SNAPSHOT_ID",
  "requestId": "be9fefc8-ff22-46a8-80b0-05cd50c54129",
  "action": { "type": "type", "elementId": "ELEMENT_ID", "text": "Hello，世界！" },
  "verify": { "type": "element", "valueIncludes": "Hello，世界！", "present": true },
  "observe": { "changes": true }
}
```

```sh
computer-use act --profile codex --input request.json
computer-use session_close --profile codex --json '{"sessionId":"SESSION_ID"}'
```

`verify` 按控件读回的值确认文本已写入；`observe` 让结果直接带上动作后的新快照，`changes: true` 时只列出相对所用快照新增或变化的元素。不带 `observe` 时，下一步前另行调用 `observe`。

`verify` confirms the text through the control's read-back value. `observe` returns the next snapshot with the result; with `changes: true` it lists only elements added or changed since the acted snapshot. Without `observe`, call `observe` before the next step.

CLI 返回截图的本机私有文件路径；MCP 返回图片内容。用新观察或目标程序独立输出确认结果。`executed` 只表示执行阶段结束；大多数桌面动作同时带 `effect: "unconfirmed"`，表示输入已派发但驱动无法证明效果，重新观察即可继续。显式可观察条件通过才返回 `verified`；它也只证明所指定条件，不证明整个任务成功。

CLI returns a private local screenshot path; MCP returns image content. Confirm effects with a fresh observation or the application's independent output. `executed` means execution ended; most desktop actions also carry `effect: "unconfirmed"`, meaning input was dispatched but the driver could not prove its effect, so observe and continue. `verified` requires an explicit observable condition and only establishes that condition.

若连接中断或结果不确定，保留原请求 ID，查询后再观察，不以新 ID 重发同一操作：

After a disconnect or uncertain result, retain the original request ID, query it and observe; do not resubmit the same operation with a new ID:

```sh
computer-use action_status --profile codex --json '{"requestId":"be9fefc8-ff22-46a8-80b0-05cd50c54129"}'
```

## 会话与动作 / Sessions and actions

| 规则 / Rule | 说明 / Behavior |
|---|---|
| 快照 / Snapshots | 坐标是截图像素；动作消费快照，下次操作前重新观察，或在 `act` 里带 `observe` 直接取回新快照。有效期 30 秒，不能检测所有视觉变化。 / Coordinates are screenshot pixels. Actions consume snapshots; observe again before the next action, or pass `observe` to `act` to receive the next snapshot. Snapshots expire after 30 seconds and cannot detect every visual change. |
| 会话 / Sessions | 默认后台、独占，两分钟无活动过期；重新打开会话无需再次授权。前台权限在首次配对时一并授予，使用时显式指定 `mode: "foreground"`，不再逐会话批准，不自动切换模式。 / Background and exclusive by default; expire after two idle minutes without requiring a new grant to reopen. Foreground permission is granted at initial pairing and requires explicit `mode: "foreground"`, with no per-session prompt or automatic fallback. |
| 元素 / Elements | 元素 id 由运行时分配：同一会话内角色、标签和位置不变的元素沿用原 id，但动作仍要使用当前 `snapshotId`。可读时给出 `value`（最多 2000 字符，截断时附 `valueLength`）、`enabled: false`、`selected: true` 和 `min`/`max`。密码内容不会返回：macOS 安全文本框和浏览器密码框没有 `value`，只含掩码字符的值也会丢弃；Windows 上 UI Automation 读不到密码框内容，但 WinForms 密码框会把本地化的“拒绝访问”占位文字当作值上报。桌面驱动不报告空文本框的值，`value: ""` 只在独立浏览器中能验证。`elementsComplete: false` 时，没列出某元素不能证明它不存在，负向验证会被拒绝。 / Element IDs are assigned by the runtime and stay the same within a session while an element's role, label and position are unchanged; actions still need the current `snapshotId`. When readable, elements carry `value` (up to 2000 characters, with `valueLength` when truncated), `enabled: false`, `selected: true` and `min`/`max`. Password contents are never returned: macOS secure text fields and browser password inputs carry no `value`, and mask-only values are dropped; on Windows, UI Automation cannot read password boxes, but WinForms reports a localized "access denied" placeholder as the value. Desktop drivers omit empty text values, so `value: ""` can only be verified in the controlled browser. An incomplete element tree cannot establish absence; negative verification is rejected. |
| 观察内容 / Observation parts | `observe` 的 `screenshot: false` 或 `elements: false` 只省略返回内容，快照照常可用。`since` 填你已拿到元素列表的快照 ID，结果只含新增或变化的元素，`changes.removed` 列出消失的 id；没有 `changes` 字段时列表是完整的。`act` 带 `observe` 时结果附带动作后的观察，但结果为 `unknown` 时不附带；观察失败时给 `observationError`，重复提交同一请求不再附带。 / `screenshot: false` or `elements: false` only omits that part; the snapshot stays usable. `since` takes the snapshot ID whose element list you already have and returns only added or changed elements, with `changes.removed` listing IDs that disappeared; without a `changes` field the list is complete. `act` with `observe` attaches the next observation, except after an `unknown` outcome; `observationError` explains a failed observation, and a repeated request does not attach one. |
| 验证条件 / Conditions | 元素条件可按 `label`、`value`（完整值相等）或 `valueIncludes` 匹配，并可加 `role`、`enabled`、`selected`。值比较不受观察截断影响，换行符统一处理；未报告的值或状态不算满足。这些状态条件只能配 `present: true`。 / Element conditions match `label`, `value` (exact full value) or `valueIncludes`, optionally with `role`, `enabled` and `selected`. Value checks use the full value regardless of observation truncation and normalize line endings; unreported values or states never match. State checks require `present: true`. |
| 点击 / Click | `elementId` 与 `point` 二选一。Windows 元素点击始终走后台辅助功能路径；批准的前台会话中坐标点击走前台指针路径。 / Choose either an element or a point. Windows element clicks use background accessibility; point clicks use the pointer in an approved foreground session. |
| 输入 / Type | Windows 元素定向输入即使在前台会话也走后台辅助功能路径；不确定或拒绝后不换路径、不重发。无元素 ID 的前台长文本未获完整性保证。 / Windows element-directed typing uses background accessibility even in foreground sessions, without fallback or retry. Long foreground text without an element ID is not guaranteed. |
| 文本效果 / Text effects | 后端和控件决定具体文本行为，需读回完整内容（元素的 `value`，或 `value` / `valueIncludes` 条件）；不要假定所有路径都追加或替换。浏览器路径使用 `insertText`。 / Read back the full value (the element's `value`, or a `value` / `valueIncludes` condition): do not assume all controls append or replace text identically. The browser uses `insertText`. |
| 拖拽 / Drag | 仅两个端点的直线手势。macOS 拒绝后台拖拽；Windows 向驱动传递会话模式，实际支持仍需验证。 / Two-endpoint straight gestures only. macOS rejects background dragging; Windows passes the session mode to the driver, with actual support still requiring validation. |
| 时限 / Deadlines | `timeoutMs`（默认 15 秒、最多 30 秒）同时限定派发和 `verify`；排队超过 15 秒仍未开始的动作直接取消、不派发。输入发出前就到时限时，动作以 `failed` / `timeout` 结束且未发送任何输入；输入已经发出时，再给它最多 5 秒完成，仍未完成才记为 `unknown`。 / `timeoutMs` (default 15 s, max 30 s) bounds dispatch and `verify` together; an action still queued after 15 seconds is cancelled without dispatch. If the deadline passes before input is dispatched, the action ends as `failed` / `timeout` and nothing was sent; input already dispatched gets up to 5 more seconds to finish before it is recorded as `unknown`. |
| 保留 / Retention | CLI 截图文件保留 24 小时，之后在下次观察时删除；动作日志只保留 7 天内、最多 500 条已结束记录；过期会话和快照在后台定时回收。 / CLI screenshot files are kept for 24 hours and removed on a later observe; the action journal keeps at most 500 finished records from the last 7 days; expired sessions and snapshots are reclaimed in the background. |
| 滚动 / Scroll | 方向加 `line` / `page` 单位与 1–50 的数量；浏览器每行 40 CSS 像素。 / Direction, line/page unit and amount 1–50; browser lines are 40 CSS pixels. |

暂停阻止新动作。紧急停止取消工作并关闭执行器；桌面输入发出后被中断或超时引起的不确定结果会停止执行。独立浏览器的输入限于隔离页面：不确定结果记为 `unknown`，但不停止执行；导航遇到网络错误时直接返回 `failed`。`unknown` 只表示输入是否送达本身不确定；驱动已完成派发但效果无法确认时返回 `executed` 加 `effect: "unconfirmed"`，不停止执行。重启不重放动作。完整参数以 `computer-use schema <method>` 为准。

Pause blocks new actions. Emergency stop cancels work and closes executors; desktop input that is interrupted or times out after dispatch stops execution. Controlled-browser input is confined to an isolated page: an uncertain outcome is recorded as `unknown` without stopping execution, and a navigation network error returns `failed`. `unknown` means delivery itself is uncertain; completed dispatch with an unconfirmed effect returns `executed` with `effect: "unconfirmed"` and does not stop execution. Restart never replays actions. Use `computer-use schema <method>` for full parameters.

## 独立浏览器 / Separate browser

```sh
computer-use browser install
computer-use pair --profile browser --name 'Browser Agent' --browser
computer-use targets --profile browser
computer-use config codex --profile browser
```

在本地 App 批准浏览器配对后，全程使用 `--profile browser`。首次列目标会创建独立的空白 headless Chromium；不读取日常浏览器登录状态。多个获准客户端共享此浏览器空间。只支持 HTTP(S) 和 `about:blank` 导航，下载到独立目录。JS 对话框自动取消，不代表接受。

Approve browser pairing locally and consistently use the `browser` profile. Listing targets first creates a separate blank headless Chromium without your regular browser login state. Authorized clients share this browser space. Navigation supports HTTP(S) and `about:blank`; downloads use a separate directory. JavaScript dialogs are automatically dismissed, not accepted.

## 配置与排错 / Configuration and troubleshooting

- 所有命令与 Agent 配置使用同一 profile；已有 profile 不重复配对。更换授权先在 App 撤销。`credentials remove` 只删除本地文件，不使凭据副本失效。 / Use the same profile in commands and agent configuration. Do not pair an existing profile again. Revoke in the app to invalidate copies; `credentials remove` only removes the local file.
- 移动安装目录后重新生成 `config codex` / `config stdio`，因为配置使用绝对路径。 / Regenerate configuration after moving the installation: launch paths are absolute.
- HTTP 需在宿主设置窗口的“接入”页启用，只在本次运行有效。macOS 可用 `computer-use config http --profile codex --out private-mcp.json` 导出新文件；Windows 必须导出到宿主私有目录，见 Windows 指南。导出的 JSON 含凭据，不能提交或分享。 / Enable HTTP on the Connect page of the host settings first; it lasts for the current run only. On macOS the command above exports a new private file; Windows requires the host's private data directory. Exported HTTP JSON contains credentials and must not be committed or shared.
- 桌面不可达先检查宿主状态、登录会话和系统权限；浏览器不可用先检查匹配的 Chromium。旧快照或元素被拒绝时重新观察，不复用旧坐标。 / For desktop failures check the host, login session and OS grants; for browser failures check matching Chromium. Re-observe after stale snapshot or element rejection rather than reusing coordinates.

## 检查更新 / Updates

```sh
computer-use update check
computer-use update download --out <existing-private-dir> --release 0.6.1 --progress
computer-use update download --out <existing-private-dir> --release 0.6.1 --installer --progress
```

两条命令不需要配对凭据，也不需要宿主在运行。`check` 输出 JSON：当前与最新版本、`available`、发布页、纯文本发布说明和本平台安装包（名称、大小、SHA-256）。GitHub API 返回 403、429、5xx 或连不上时（未认证调用每个 IP 每小时 60 次），改由 `github.com/starroyhq/computer-use/releases/latest` 的跳转确定最新正式版，从该版本的元数据资产读取安装包信息，从该标签的 `.github/release-notes/` 读取说明；此时没有 `publishedAt`，下载时也没有 GitHub 摘要可核对。只比较 `MAJOR.MINOR.PATCH` 正式版，草稿、预发布和旧版本都不提供。`download` 会重新读取最新发布；`--release` 与最新版本不同时拒绝下载（避免下载用户没看过的版本）。它下载本平台的 `.zip.sha256` 与 `.json` 元数据，核对版本、平台、提交、干净源码标记、大小、签名方式（macOS 须为已公证的 Developer ID，Windows 为未签名）以及 SHA-256，全部一致才把安装包写入目录；失败时不留下文件。从 v0.6.0 起，在 ZIP 之外提供额外安装包（macOS `.dmg` 用于首次安装，Windows `-setup.exe` 用于首次安装和安装版升级），`check` 的 `installer` 字段描述它；v0.5.0 的历史发布仅提供 ZIP，没有这个字段。macOS App 与 DMG 的公证、装订由发布 CI 验证，本次结果仍待确认；Windows 安装版从真实发布升级的完整流程仍待验收。`--installer` 改为下载安装包，按它自己的 `.sha256`、元数据中的 `installer` 项和 GitHub 摘要校验，最新版没有安装包时拒绝。`--progress` 在 stderr 逐行输出 `{"event":"progress","downloaded":N,"total":M}`。请求只发往 `api.github.com`、`github.com` 与 `*.githubusercontent.com` 的 HTTPS 地址，每次跳转都重新核对主机。 / Neither command needs pairing credentials or a running host. `check` prints JSON with the current and latest versions, `available`, the release page, plain-text notes and this platform's package (name, size, SHA-256). When the GitHub API answers 403, 429 or 5xx or cannot be reached (unauthenticated calls are limited to 60 per hour per IP), the latest stable tag comes from the `github.com/starroyhq/computer-use/releases/latest` redirect, package details from that release's metadata asset and notes from the tag's `.github/release-notes/` file; `publishedAt` is then omitted and downloads have no GitHub digest to compare. Only plain `MAJOR.MINOR.PATCH` releases are compared; drafts, prereleases and older versions are never offered. `download` re-reads the latest release and refuses when `--release` no longer matches it, so a user never receives a version they did not review. It fetches this platform's `.zip.sha256` and `.json` metadata and checks version, platform, commit, clean-source flag, size, signing (notarized Developer ID on macOS, unsigned on Windows) and SHA-256 before writing the package; failures leave nothing behind. Since v0.6.0, additional packages are provided alongside ZIPs (`.dmg` for first installs on macOS, `-setup.exe` for first installs and installed-copy upgrades on Windows), described by the `installer` field of `check`; the historical v0.5.0 release provides ZIPs only and has no such field. Release CI verifies notarization and stapling of the macOS App and DMG; this release's result remains to be confirmed. The complete Windows upgrade flow from a real release still needs acceptance testing. `--installer` downloads that installer instead and checks it against its own `.sha256`, the `installer` entry of the metadata and the GitHub digest, refusing when the latest release has none. `--progress` writes `{"event":"progress","downloaded":N,"total":M}` lines to stderr. Requests go only to HTTPS `api.github.com`, `github.com` and `*.githubusercontent.com`; every redirect is re-checked.

宿主的“更新”页调用同一组命令：自动检查默认每天一次，可关闭或跳过某个版本；macOS 正式版在额外核对 Bundle ID、版本、签名团队和 Gatekeeper 后原位替换并重新打开；Windows 安装版用 `--installer` 下载安装程序，由用户点“运行安装程序”按向导完成，便携版只下载校验 ZIP 并在资源管理器中显示。 / The hosts' Updates page runs the same commands: automatic checks run at most daily and can be turned off or skip a version. Signed macOS releases additionally verify the bundle identifier, version, signing team and Gatekeeper before replacing the app in place and relaunching it. An installed Windows copy downloads the installer with `--installer` and the user runs it through the setup wizard; a portable copy only downloads, verifies and reveals the ZIP.

平台实测范围以 [验证记录](validation-results.md) 为准；以上接口说明不扩大支持声明。 / The [validation record](validation-results.md) defines tested coverage; API descriptions do not expand it.
