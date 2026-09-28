# 使用说明 / Usage

[中文首页](../README.md) · [English home](../README.en.md) · [Windows 中文](WINDOWS.md) · [Windows English](WINDOWS.en.md)

先按首页完成构建、启动和配对。以下示例使用已配对的 `codex` profile；替换返回的 ID，不要直接执行占位符。Windows 在便携包目录中将 `computer-use` 换为 `& .\bin\node.exe .\runtime\cli.js`。

Build, start and pair as described in the README first. Examples use an existing `codex` profile. Replace placeholder IDs with returned values. On Windows, run from the portable package directory and replace `computer-use` with `& .\bin\node.exe .\runtime\cli.js`.

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
  "action": { "type": "type", "elementId": "ELEMENT_ID", "text": "Hello，世界！" }
}
```

```sh
computer-use act --profile codex --input request.json
computer-use observe --profile codex --json '{"sessionId":"SESSION_ID"}'
computer-use session_close --profile codex --json '{"sessionId":"SESSION_ID"}'
```

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
| 快照 / Snapshots | 坐标是截图像素；动作消费快照，下次操作前重新观察。有效期 30 秒，不能检测所有视觉变化。 / Coordinates are screenshot pixels. Actions consume snapshots; observe again before the next action. Snapshots expire after 30 seconds and cannot detect every visual change. |
| 会话 / Sessions | 默认后台、独占，两分钟无活动过期。`mode: "foreground"` 需要本地宿主批准；不自动切换模式。 / Background and exclusive by default; expire after two idle minutes. Foreground requires local host approval, with no automatic mode fallback. |
| 元素 / Elements | 使用当前快照中的 `elementId`。`elementsComplete: false` 时，没列出某元素不能证明它不存在，负向验证会被拒绝。 / Use an element ID from the current snapshot. An incomplete element tree cannot establish absence; negative verification is rejected. |
| 点击 / Click | `elementId` 与 `point` 二选一。Windows 元素点击始终走后台辅助功能路径；批准的前台会话中坐标点击走前台指针路径。 / Choose either an element or a point. Windows element clicks use background accessibility; point clicks use the pointer in an approved foreground session. |
| 输入 / Type | Windows 元素定向输入即使在前台会话也走后台辅助功能路径；不确定或拒绝后不换路径、不重发。无元素 ID 的前台长文本未获完整性保证。 / Windows element-directed typing uses background accessibility even in foreground sessions, without fallback or retry. Long foreground text without an element ID is not guaranteed. |
| 文本效果 / Text effects | 后端和控件决定具体文本行为，需读回完整内容；不要假定所有路径都追加或替换。浏览器路径使用 `insertText`。 / Read back the full value: do not assume all controls append or replace text identically. The browser uses `insertText`. |
| 拖拽 / Drag | 仅两个端点的直线手势。macOS 拒绝后台拖拽；Windows 向驱动传递会话模式，实际支持仍需验证。 / Two-endpoint straight gestures only. macOS rejects background dragging; Windows passes the session mode to the driver, with actual support still requiring validation. |
| 时限 / Deadlines | `timeoutMs`（默认 15 秒、最多 30 秒）同时限定派发和 `verify`；排队超过 15 秒仍未开始的动作直接取消、不派发。 / `timeoutMs` (default 15 s, max 30 s) bounds dispatch and `verify` together; an action still queued after 15 seconds is cancelled without dispatch. |
| 保留 / Retention | CLI 截图文件保留 24 小时，之后在下次观察时删除；动作日志只保留 7 天内、最多 500 条已结束记录；过期会话和快照在后台定时回收。 / CLI screenshot files are kept for 24 hours and removed on a later observe; the action journal keeps at most 500 finished records from the last 7 days; expired sessions and snapshots are reclaimed in the background. |
| 滚动 / Scroll | 方向加 `line` / `page` 单位与 1–50 的数量；浏览器每行 40 CSS 像素。 / Direction, line/page unit and amount 1–50; browser lines are 40 CSS pixels. |

暂停阻止新动作。紧急停止取消工作并关闭执行器；输入中断或超时引起的不确定结果会停止执行。`unknown` 只表示输入是否送达本身不确定；驱动已完成派发但效果无法确认时返回 `executed` 加 `effect: "unconfirmed"`，不停止执行。重启不重放动作。完整参数以 `computer-use schema <method>` 为准。

Pause blocks new actions. Emergency stop cancels work and closes executors; uncertain interrupted or timed-out input stops execution. `unknown` means delivery itself is uncertain; completed dispatch with an unconfirmed effect returns `executed` with `effect: "unconfirmed"` and does not stop execution. Restart never replays actions. Use `computer-use schema <method>` for full parameters.

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
- HTTP 需在宿主主动启用。macOS 可用 `computer-use config http --profile codex --out private-mcp.json` 导出新文件；Windows 必须导出到宿主私有目录，见 Windows 指南。导出的 JSON 含凭据，不能提交或分享。 / Enable HTTP in the host first. On macOS the command above exports a new private file; Windows requires the host's private data directory. Exported HTTP JSON contains credentials and must not be committed or shared.
- 桌面不可达先检查宿主状态、登录会话和系统权限；浏览器不可用先检查匹配的 Chromium。旧快照或元素被拒绝时重新观察，不复用旧坐标。 / For desktop failures check the host, login session and OS grants; for browser failures check matching Chromium. Re-observe after stale snapshot or element rejection rather than reusing coordinates.

平台实测范围以 [验证记录](validation-results.md) 为准；以上接口说明不扩大支持声明。 / The [validation record](validation-results.md) defines tested coverage; API descriptions do not expand it.
