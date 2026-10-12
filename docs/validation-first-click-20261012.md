# macOS 文本控件首次点击修复验收（2026-10-12）

本轮修复普通文本框首次元素点击返回 `unknown` 的原因，不改变故障恢复、暂停、紧停、撤销及未知动作不重放规则。修改对所有 Agent 生效，没有 WorkBuddy、profile 或 Fixture 专属分支。

## 根因证据

在既有授权的测试窗口中，驱动只读观察得到：`Probe input` 的角色为 `AXTextField`，可执行动作只有 `AXShowMenu`、`AXConfirm`；`Record` 按钮则支持 `AXPress`。可寻址的元素 token 不代表元素支持 `AXPress`。

使用安装包内同版本 SDK / driver，在该可丢弃 Fixture 上单独诊断原始 token 点击：约 2,702 ms 返回 `isError: true`、`AXUIElementPerformAction(AXPress) returned -25206`，没有结构化错误码。这是 AX 不支持该动作，不是 Runtime 超时。诊断只保留错误分类、数值及耗时，不保存控件内容；没有将此失败改报成功或接着重试。随后正常退出旧 App，再安装新包。

0.28.2 驱动的 token 点击默认执行 `AXPress`；文本框不支持时返回普通工具错误。本项目无法从这种未分类错误证明输入没有发生，因此将其保守记为 `unknown` 并停止服务。需要修复的是派发路径，不能通过把错误强制当成功或移除停机规则解决。

## 实现与范围

`src/backends/cua.ts` 在派发前检查原始观察的控件能力。macOS 的 `AXTextField` / `AXTextArea` 明确不支持 `AXPress` 时，单次左键元素点击改用该截图内的控件中心，通过既有精确窗口像素路径派发一次。保留原请求的 background / foreground 模式；不会在失败后改坐标或前台重试。

缺失、非有限、零／负尺寸、超出截图的几何及禁用控件在派发前拒绝。需要截图预热时，再核对目标 PID、window ID、窗口位置尺寸、截图有效性与图像尺度；变化或无法核实时返回 `stale_snapshot`，不发送输入。按钮、支持 `AXPress` 的文本控件、能力未知的控件、右键、中键、Windows 与原坐标动作保持原路径。

这是适配器对当前驱动的兼容修复，没有升级依赖或重新编译上游 driver。像素投递仍具有截图坐标的固有限制：截图之后、实际点击之前的窗口内部布局变化无法获得原子身份保证。因此仍要求新鲜观察、精确窗口校验和实际效果验证；驱动报告 `unconfirmed` 时不会升级成 `confirmed`。

## 验证与产物

验收日志、原始能力摘要、驱动错误分类、动作记录与安装备份位于 `.cache/first-click-fix-20261012/`。实机验收时本机测试包沿用版本号 **0.7.0**，属于当时未发布的本地修改版。后续 v0.7.1 由对应提交的 CI 构建和发布流程验证；本记录不将本机测试包等同于正式发布附件。

### 自动检查及安装

- `pnpm check` 通过：11 个 Vitest 文件、277 项测试通过；平台脚本 40 项通过、17 项按平台条件跳过；npm 37 项通过。类型、Biome、Skill 生成一致性均通过。
- `src/backends/cua.test.ts` 共 79 项通过。新增覆盖文本角色／能力分流、Retina 与缩小图像的坐标、模式保留、无效或禁用控件、单次派发、未知结果不重试，以及预热后窗口／图像／身份变化的零派发拒绝。
- `pnpm package:app` 和 `pnpm package:dmg` 通过；Developer ID 签名、6 个原生组件、内置运行时及包内资源一致性、DMG 挂载内容和签名均通过。没有新增公证或正式发布。
- 完整替换 `/Applications/Computer Use.app` 前正常退出旧 App，旧包保存在任务缓存中。最终安装的 `runtime/backends/cua.js` 与构建结果逐字节一致，没有修改签名后的包内文件。
- 既有凭据及 clients 文件共 7 份的哈希在安装后完全一致；没有读取或记录 token，没有重新配对或扩权。

### 第一轮 WorkBuddy：首次点击派发完成，扩展替换流程未完成

WorkBuddy 5.7.7 / Space-Bunny 新任务“测试 Probe 输入与录制功能”读取通用 Skill 和安装指南，沿用既有 `workbuddy` profile，仅操作已授权的 Fixture。输入只要求点击普通输入框、替换文本、Record 一次并验证，没有提供故障恢复或底层路由提示。

原先必现 unknown 的首次元素点击 `9c0225ba-2dd5-4255-a309-441a59962b2f` 返回 `executed / unconfirmed`，未再 unknown；后续独立文本框点击也成功派发。Host 始终 ready，Host / Node / driver PID 保持不变，没有通过重启恢复掩盖错误。第一次附带观察失败后，WorkBuddy 通过新观察继续，没有把 `unconfirmed` 误当 unknown。

附加的“替换文本”流程中，全选快捷键的实际效果未成立，输入先追加到原文字后。另一次点击在派发前因校验超时失败；没有 unknown，也没有重放未知输入。WorkBuddy 随后尝试退格。本轮由验收操作方在 8 分 57 秒停止，确认动作日志没有 queued / running 项后才更新最终包。**本轮只证明首次及后续文本框点击不再触发 unknown，不能算整个替换／Record 业务验收通过。** 最终包还包含独立复审补充的预热几何一致性检查。

全选问题不能据此认定为驱动缺陷：上游源码对 `CMD` / `A` 的大小写进行了归一化，而 `validation/DesktopFixture.swift` 没有建立标准 Edit 菜单或 Select All 快捷键处理。本机 AppKit 的 `StandardKeyBinding.dict` 中，End 对应滚动到文档末尾，并非移动插入点；没有选区且插入点在开头时，向后删除也不会改变文本。独立无障碍观察及截图确认普通输入框获得焦点。本轮现象不足以证明后台键盘投递失败，没有增加焦点补丁或快捷键特判；后续快捷键验收应使用具备标准菜单的宿主，并核对实际选区。

### 最终包 WorkBuddy 复验

最终包安装后，WorkBuddy 新任务“验证 Probe 输入并记录”以同一 `workbuddy` profile 打开后台会话 `2e5ade17-e444-47db-91fe-1b298fbcce43`。首次输入框元素点击 `1fe7ef78-3d96-4784-8527-259e8c9ff9da` 返回 `executed / unconfirmed`，没有 unknown。追加文本流程仍混入 End／全选的上述验收问题；在 6 分 16 秒停止此分支，没有将其记为通过。

随后明确允许对可丢弃 Fixture 使用 Reset，收窄为不依赖文本选择快捷键的实际流程。WorkBuddy 自行新观察，按顺序完成：

1. Reset 一次，确认普通输入框为空。
2. 使用观察所得元素 ID 点击普通 `Probe input`：`d57720ce-cf0c-4189-83c8-4a16292dc253`，`executed / unconfirmed`。
3. 输入 `First click fixed`：`956b67ca-66bb-4e93-9cfb-7bf8c69ae446`，`executed / confirmed`；再次观察完整值严格相等。
4. Record 一次：`beb8e455-9a92-44b5-b4af-4afdc4fdcae4`，`executed / unconfirmed`；截图显示 `Recorded 4`。此前独立观察为 `Recorded 3`，实际增加一次。Fixture 的 Reset 只清空文字和状态标签，不重置内部计数，不能把显示 Ready 误读为内部计数归零。
5. 保存截图并关闭会话；独立 CLI 再观察同一 session 返回 `not_found`，确认已释放。

验收方独立读取真实窗口的无障碍树及截图，并查看 WorkBuddy 保存的 PNG，均确认完整文字 `First click fixed`、计数 4、密码框仍为遮罩。点击与 Record 的动作返回值保持 `unconfirmed`；实际业务效果由后续观察确认，没有篡改动作状态。WorkBuddy 在 2 分 50 秒完成这段流程。

最终这轮 18 条已入日志动作均为 `executed`，unknown 为 0，结束时无 queued／running 项；不将派发前 stale snapshot 拒绝算入这些已派发动作。Host 一直 ready，Host／driver／Node PID 及启动身份与安装后基线完全一致（90522／90527／90528），没有通过故障重启掩盖点击问题。`preflight --profile workbuddy` 返回 ready／valid；7 份既有凭据及 clients 文件哈希仍完全一致，没有重新配对或扩大权限。

证据包括缓存中的 `workbuddy-final-actions.json`、`host-final-before.json`／`host-final-after.json`、`preflight-final.json`、`closed-session-check.json`、`workbuddy-final.png` 和 `final-evidence-summary.json`。首次文本点击问题及清空后“点击→输入→Record→验证→关闭”闭环已通过；文本选择／追加流程不包含在通过范围内，也未据此宣称所有应用及快捷键都已验证。
