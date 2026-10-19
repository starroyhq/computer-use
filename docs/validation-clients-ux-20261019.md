# 客户端授权页 UX 改造验证（2026-10-19）

本轮把 macOS 设置窗口的“客户端”分区从“表格 + 底部按钮（需先选中行）”改为“每客户端一张卡片，卡片内直接提供主操作，应用清单/浏览器/前台/撤销收进高级区”。不改运行时协议、凭据、授权范围或 Windows 宿主。

## 范围与边界

- 只改 macOS 原生宿主 UI：新增 `native/Sources/ComputerUseHost/ClientsPane.swift`，从 `SettingsPanes.swift` 移除旧表格实现。
- 授权命令、`ClientGrantTracker`、默认取消的确认框、15 秒回执超时、暂停/紧停/撤销边界均未改动。
- 不新增 App 内任意应用范围编辑；受限应用范围仍由配对时 `--app` 决定，卡片高级区只展示当前范围与说明。
- Windows 宿主仍使用原有列表 + 按钮流程；`docs/USAGE.md` 与 Skill 指南已注明平台差异。
- 未替换 `/Applications` 下已安装的 App，未打包、未签名、未改版本号。

## 自动化结果

| 检查 | 结果 |
|---|---|
| `swift test --package-path native` | 通过；0 failures；2 个仅快照测试按默认跳过 |
| `CU_SETTINGS_SNAPSHOTS=artifacts/clients-ux-20261019/snapshots swift test --package-path native --filter 'testClientGrantSnapshotsAndConfirmationLayout\|testEveryPaneFitsThePageInBothLanguagesAndStates\|testWholeWindowSnapshotsWithToolbar'` | 通过；生成 64 张中英文快照（客户端卡片、pending/failed/unconfirmed/success、确认框、6 个分区整窗） |
| `node scripts/build-skill.mjs --check` | 通过（`skills/computer-use/SKILL.md` 与 `instructions.md` 同步） |
| `pnpm check` | 通过（Skill 生成检查、TypeScript、Biome、Vitest、脚本测试、npm 测试） |
| `git diff --check` | 通过 |

新增/更新的回归覆盖（`native/Tests/ComputerUseHostTests/SettingsLayoutTests.swift`）：

- 无预选行即可点击卡片主按钮；浏览器专用客户端无可用升级按钮；已全应用状态显示文字而非按钮。
- 暂停时仍可管理授权；离线显示原因且不渲染卡片。
- pending 时全部升级按钮禁用，反馈只出现在所属卡片；超时/失败/成功/撤销后消失的兜底反馈。
- 搜索按名称、短标识、应用 ID 过滤；高级展开状态跨刷新与搜索保持。
- 撤销必须经过确认；取消确认不改动客户端。
- 展开高级后行高增加，收起后恢复（防止表格行高卡在展开状态）。
- 中英文、三种服务状态的分区布局、整窗快照与无歧义布局检查。

## 视觉验收

证据目录：`artifacts/clients-ux-20261019/snapshots/`。已逐张检查以下关键快照：

- `clients-en-collapsed.png` / `clients-zh-Hans-collapsed.png`：卡片默认态；主按钮直接可见，无需选中行。
- `clients-en-ready.png` / `clients-zh-Hans-ready.png`：受限客户端高级区；桌面应用、浏览器、前台、完整标识、限制说明与撤销均在卡片内。
- `clients-en-pending.png`：保存中按钮禁用、反馈落在所属卡片；其他客户端不受影响。
- `clients-en-success.png` / `clients-zh-Hans-success.png`：成功后显示保存结果与已授权状态。
- `clients-en-failed.png` / `clients-en-unconfirmed.png`：失败/未确认反馈位置与颜色（文字同时表达状态）。
- `en-idle-clients.png` / `zh-Hans-idle-clients.png`：服务未运行时只显示原因说明，不出现可操作按钮。
- `en-busy-clients.png` / `zh-Hans-busy-clients.png`：浏览器专用客户端显示范围与不可升级说明。
- `window-en-clients.png` / `window-zh-Hans-clients.png`：整窗工具栏与分区高度。

结论：成功标准中的“无预选操作、卡片内主操作、高级区范围、离线/暂停/pending 状态、中英文布局”均通过本地快照与自动化检查。Windows 对等改造、任意应用范围编辑、真实 App 打包安装不在本轮范围。

## Review 修复复验（2026-10-19）

修复固定 300pt 展开行高导致长应用范围把“撤销”按钮挤出卡片的问题。保留原来的最小高度，按卡片实际换行内容提前测量并缓存；范围、反馈、展开状态和列宽改变时重新计算。行高查询只读取缓存，避免布局重入；连续展开/收起不叠加行高动画。

新增三项真实 `ClientsPane` / `NSTableView` 回归，覆盖中英文、8 个 67 字符及 9 个 200 字符的合法应用 ID、无反馈及未确认反馈。检查撤销按钮完整位于卡片内、真实 hit test 能命中、确认后撤销正确的客户端，并覆盖收起后重新展开、同一客户端范围与反馈变化。

| 本次检查 | 结果 |
|---|---|
| 修复前源码 + 新回归（独立临时 Swift 包） | 3 项测试失败，9 处断言，复现按钮越过真实 300pt 卡片边界、无法命中及刷新不增高 |
| `swift test --package-path native --filter 'testLongClientScope\|testExpandedClientRowRemeasures\|testCollapsingAdvancedShrinksTheRow'` | 4 项通过，无布局重入警告 |
| `swift test --package-path native` | 共 120 项：115 项通过、4 项按环境跳过、1 项已有测试失败，详情见下文；新增回归全部通过 |
| 设置 `CU_SETTINGS_SNAPSHOTS` 后运行长范围、授权卡片及整窗快照测试 | 3 项通过；生成 30 张 PNG，已检查中英文长范围卡片、未确认反馈及中文客户端整窗 |
| `node scripts/build-skill.mjs --check`、`git diff --check` | 通过 |

完整 Swift 检查的唯一失败为 `testGrantConfirmationRequiresExplicitApprovalInBothLanguages`：中文确认框的合成回车事件未在超时前关闭窗口。该测试与 `HEAD` 完全相同，之前已在未经本轮 UI 改动的 `cc662966972da1f78ea2ac460cce5e26b6384dc0` 基线整组测试中复现；本次不修改此无关的键盘事件测试。上表为本次复验结果，不代表完整 Swift 检查全部通过。

本次日志及 30 张快照位于 `.cache/clients-fix-20261019.tgX0Cp/`，长范围证据为 `snapshots/clients-long-scope-en.png` 和 `snapshots/clients-long-scope-zh-Hans.png`。测试使用虚构客户端与离屏窗口，没有启动真实服务、变更凭据或授权，也没有替换已安装 App。
