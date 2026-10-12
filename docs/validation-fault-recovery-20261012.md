# 通用故障恢复验收（2026-10-12）

后续文本控件首次点击根因与修复验收另见 [首次点击修复记录](validation-first-click-20261012.md)。本文保留修复前的真实失败及恢复证据，不把历史 unknown 改报成功。

本记录包含代码检查、macOS 本机安装、WorkBuddy 真实故障恢复、macOS 暂停／紧停拒绝验证，以及 Windows Host / UI、进程与传输隔离验收。各检查的实际覆盖和限制分别记录如下。

实机验收时本机测试包沿用版本号 **0.7.0**，包含当时尚未发布的本地修改。已发布的 v0.7.0 不包含本次 `recover` 能力；后续 v0.7.1 由对应提交的 CI 构建和发布流程验证，本记录保留实机验收时的包版本与覆盖边界。

## 设计与授权边界

`recover --profile NAME` 是所有 Agent 共用的显式 CLI 操作，不包含 WorkBuddy 专属分支、安装目录或授权规则。WorkBuddy 仅作为本轮真实调用方。CLI 验证自身与 Node、原生 Host 属于同一完整安装包后，调用 `--recover-fault`，不通过普通打开 App 或本地“重新启动服务”按钮的实现清除用户停止状态。

| 当前情况 | 恢复行为 |
|---|---|
| 服务故障，用户未暂停或紧停 | 原生协调器确认旧执行进程退出后重建服务，并限制并发与恢复频率 |
| 服务已正常运行 | 不重启健康服务，验证当前凭据与状态 |
| 用户暂停或紧急停止 | 拒绝恢复；仍须由用户在 App 内恢复 |
| 在线服务明确拒绝凭据 | helper 执行前立即返回授权错误，不重新配对 |
| 服务离线，暂时无法验证凭据 | 仅尝试恢复服务可用性；恢复后必须重新鉴权，撤销凭据不会获得访问权 |
| 缺少有效 profile、源码执行或自定义 socket | 拒绝故障恢复，不自动配对、不切换安装目标 |

恢复接口不接收动作参数，不发送 `act`，也不提供 force、凭据重置或动作重放选项。成功结果明确包含 `actionsReplayed: false`、`requiresNewSession: true`、`requiresFreshObservation: true`。恢复服务不代表先前动作执行成功。

Runtime 重建后，旧会话和快照失效。持久动作记录中的 `queued` / `running` 转为 `unknown`，原有 `unknown` 保留；相同 `requestId` 只返回已有记录，不再次派发。Agent 必须查询原请求状态、建立新会话并重新观察，再决定下一步动作。

`preflight` 能区分原生服务故障与用户主动停止。即使故障 Runtime 的 capabilities 同时标记 paused/stopped，已保存的故障状态仍报告为 `failed`；离线凭据保持 `unverified`，不会因本地文件存在而被报告为有效授权。

## 已完成的代码与隔离检查

| 检查 | 结果与范围 |
|---|---|
| `pnpm check` | Skill 生成一致性、类型和 Biome 检查通过；243 项 Vitest 通过；脚本测试 37 项通过、14 项条件跳过、0 失败 |
| Swift 完整测试 | 两套 XCTest 共 87 项：84 项通过、3 项条件跳过、0 失败；HostCore 57 项含 2 项跳过，Host App 30 项含 1 项跳过 |
| CLI / runtime-client / Skill 针对性测试 | 84/84 通过；覆盖恢复前后鉴权、helper 拒绝和限流、最终状态校验、自定义 endpoint 拒绝、未配对处理、无动作参数以及故障预检 |
| Runtime / Storage 针对性测试 | 74/74 通过；覆盖已派发动作故障后重建、同请求不重放、旧会话和快照拒绝、重新观察后继续、撤销跨重建以及重复加载 unknown 记录 |
| 原生与 CLI 独立检查 | 已检查恢复入口与本地解除停止入口的分离、旧进程退出边界、停止状态优先级、鉴权顺序和业务 RPC 不重放；CLI 初审提出的“在线撤销应在 helper 前拒绝”已补入并通过回归 |
| Windows Host / UI、进程与传输验收 | Windows 11 ARM64 交互桌面运行，两个测试程序退出码均为 0；三套最终构建均为 0 警告、0 错误；未更新生产安装版 App，未进行 Windows 真实 Agent / driver 业务恢复验收 |

Swift 三项跳过分别为真实发布包安装校验、运行中 App 的真实覆盖安装、整窗口截图生成，均缺少对应显式测试环境变量。单元测试中的进程、后端或 IPC fixture 只证明其覆盖的边界，不替代已解锁桌面的真实操作验证。

针对性 Runtime 回归确认：故障前后端派发次数为 1；恢复后的新后端在重复提交旧请求、使用旧会话或旧快照时派发次数仍为 0。只有完成新会话的实际观察后，新请求才派发一次。撤销后的 doctor、session、action_status 和 act 均返回 unauthorized，未调用新后端。

主要测试证据位于 `src/runtime-client.test.ts`、`src/cli.test.ts`、`src/runtime.test.ts`、`src/storage.test.ts`、`src/skill.test.ts` 及 `native/Tests`。完整日志为 `.cache/fault-recovery-check.log` 和 `.cache/fault-recovery-swift.log`。

## macOS 本机安装

已重新打包并更新本机 `/Applications/Computer Use.app`，使用 Developer ID 签名，签名校验通过。本记录仅确认本地修改版安装及签名，不将其表述为已发布、公证或已通过干净系统首装的正式产物。打包日志为 `.cache/fault-recovery-package.log`。

DMG 产物为 `artifacts/Computer Use.dmg`，已完成签名打包及只读挂载校验。

更新前后，原有凭据及 clients 文件共 **7 份**的 SHA-256 完全一致；没有删除、重建或扩大既有授权。记录中不保存凭据内容或 token。

## WorkBuddy 实测

下述首次恢复验收的任务提示中明确提供了恢复步骤，证明 CLI 恢复链路可用，不能单独作为“仅凭 Skill 自主恢复”的证据。后续新会话验收另行记录。

在 WorkBuddy 5.7.7、Space-Bunny 模型中完成本轮真实调用，界面记录耗时 2 分 57 秒。复用既有 `workbuddy` profile，其权限仍仅覆盖测试 Fixture；没有重新配对或扩大到其他应用。

1. 旧会话 `48e21ef4-4833-4f43-a2cf-f85fb6638262` 中的点击请求 `55fde9fc-1634-4bd6-b85f-15d1fd467c62` 返回 unknown 并触发保护性停机。本轮复现的是实际点击故障，不是通过修改持久状态或终止进程制造的故障。
2. WorkBuddy 自行执行一次通用 CLI `recover --profile workbuddy`，收到六字段成功结果：`ok: true`、`state: ready`、`actionsReplayed: false`、`requiresNewSession: true`、`requiresFreshObservation: true`、`profile: workbuddy`。没有要求用户在 App 中手动重启。
3. 恢复后原请求的 `action_status` 仍为 unknown；主验收流程使用独立 CLI 查询复核，未将其改报成功或重放。
4. WorkBuddy 建立以 `3b06f553` 开头的新会话并重新观察，直接输入 `Generic recovery OK`，结果为 verified；随后点击 Record，结果为 executed、effect 为 unconfirmed。最终再次观察的截图实际显示 `Generic recovery OK` 和 `Recorded 2`，测试前计数为 `Recorded 1`。主验收流程已独立打开该截图核实；点击动作自身的 unconfirmed 与最终可见结果分别记录。WorkBuddy 报告已关闭新会话。

恢复期间 GUI Host 的 PID 保持为 `39650`，旧 worker `39652` / `39654` 被新 worker `79283` / `79293` 替换。恢复后 Host 为 ready，所选 profile 为 valid。用户唯一协助是将 WorkBuddy 界面前置以解除刷新延迟；没有在 Computer Use App 内手动重启或重新授权。

最终观察原图标识为 `b037ee98-16a9-4ab0-8fb8-a6611c1f7b09.png`，证据副本为 `.cache/fault-recovery-20261012/workbuddy-recovered.png`，副本内容与原图一致。只复制该测试窗口截图，不移动原图或读取凭据。

WorkBuddy 曾报告 wrapper 与直接 CLI 的 help 不一致。主验收流程对同一新版的两种入口分别执行 `--help` 和 `instructions`，输出逐字节相同；本轮差异来自跨更新历史混淆，未复现当前安装版入口不一致。

最初及本轮文本框点击返回 unknown 的根因尚未修复。本次修改验证的是故障后的受控恢复流程，不能称为修复该点击异常，也不能把原未知动作改报成功。

## 仅由 Skill 驱动的新会话验收

后续按用户要求，将操作规则集中在通用 `template.md` / `instructions.md`，由同一生成器产出仓库与 App 的 `SKILL.md`。每个新会话必须读取已验证安装包的 `--help` 与受支持的 `instructions`，再连接；故障状态自行执行一次受控恢复，用户暂停、紧停、撤销、缺少系统权限及旧版本不支持恢复则交回本机处理。没有新增 Agent 专属分支。

WorkBuddy 原安装副本去除本地绑定后，与原发布包模板逐字节一致，没有用户自定义修改。更新时保留 `workbuddy` profile 及全部路径绑定，旧文件和旧 App 均备份在 `.cache/skill-autorecovery-20261012/`。最终安装副本与新 App 的 `skill export --profile workbuddy` 输出逐字节一致，共 45,811 字节。App 经完整重新打包签名后替换，没有修改已签名包内文件。

### 第一轮：暴露对未知动作的误判

新任务“操作 Computer Use 测试窗口”只选择 computer-use Skill 并要求点击普通输入框、替换为 `Skill autonomous OK`、点击 Record 一次及提供截图，没有附带恢复命令或故障提示。WorkBuddy 自行识别 `failed` 并恢复一次，但随后把“字段文字没变化”解释为焦点点击未生效，在新会话又点击同一字段。两个请求 `307ce79a-0be4-4b0a-b5cb-e4cd62313047`、`b4e3e335-4e87-47e1-be4f-ab1af826bae6` 均为 unknown，第二次故障后它停止，没有执行输入或 Record。本轮证明自主恢复可用，但**不通过未知动作不重放验收**。

据此补充通用规则：画面或文字不变不能证明点击／焦点切换／按键未送达；更换 UUID、会话、快照、坐标或等价输入方式仍是重放当前未知步骤。后续动作必须真正推进剩余目标，并且无论原输入是否发生都安全；这不构成重复未知输入的例外。不能安全继续时报告部分结果并交回用户。此限制不影响将来无关的新任务操作同一控件。

### 最终复验：自主恢复后完成业务目标

补强规则后重新签名打包、更新本机 App 和 WorkBuddy Skill。第一轮结束后，验收操作方退出旧 App、安装新版并通过 App 的常规入口打开，确认初始状态为 ready；该准备步骤发生在新任务之前，不能算作新任务中的 Agent 自动恢复。最终新任务“验证 Probe 输入与 Record 操作”使用同一 Space-Bunny 模型，只给普通业务目标，没有追加纠偏或恢复提示。WorkBuddy 编辑器输入延迟使同一描述重复并出现局部字符交错，实际已发送的原文为：

> Use the computer-use skill. In the Computer Use Fixture test window only, click the ordinary Probe input field, replace its text with Skill rules OK, then click RecoUrd once. Verify the result and show its screenshot.se the computer-use skill. In the Computer Use Fixture test window only, click the ordinary Probe input field, replace its text with Skill rules OK, then click Record once. Verify the result and show its screenshot.

实测记录如下：

1. WorkBuddy 自行读取 Skill、CLI `--help` 和当前 App 的 `instructions`，完成 preflight、doctor 与目标选择，仅操作已授权的 Fixture 窗口。
2. 初始会话 `d761de95-5df5-4447-85c4-039c24e53657` 的点击请求 `7737b987-bc66-4ff0-b49d-9e4a0999d4c1` 返回 unknown。WorkBuddy 查询原请求并检查 Host 为 failed，执行一次 `recover --profile workbuddy`，没有请求人工重启、重新配对或扩权。
3. 恢复后再次查询原请求，仍为 unknown；新建会话 `dc1a674c-a435-45d2-9a7f-afd1e891d62d` 并重新观察。它明确拒绝根据“文字未变”重放原点击，改为独立的全选、输入步骤。一次 stale snapshot 请求被拒绝后，它刷新观察，未因此再次恢复服务。
4. 已接受动作日志恰有四项：原点击 unknown；全选 `47433244-513f-4608-a42f-abebc57d0df5` 为 executed / unconfirmed；输入 `90ddedcb-3870-4e7b-bcb0-f59126ae4451` 为 verified / confirmed；Record 点击 `5c6c7917-0957-472f-acc1-bb39957ef1d6` 为 executed / unconfirmed。后两种状态没有混为同一验证强度。
5. 最终截图实际显示输入 `Skill rules OK`、计数 `Recorded 3`，相比初始 `Recorded 2` 正好增加 1。主验收流程独立打开截图并读取真实 Fixture 窗口，确认二者一致。WorkBuddy 报告会话已关闭，界面记录耗时 5 分 48 秒。

截图产物为 WorkBuddy 本轮任务目录中的 `fixture-record-result.png`，与 CLI 原图 `e00f7ac8-32c3-4b8d-a89e-0c2cc93921c4.png` 的 SHA-256 完全一致。证据副本、原请求状态与最终动作日志保存在 `.cache/skill-autorecovery-20261012/`。最终 Host ready、workbuddy valid，7 份既有凭据及 clients 文件与本轮开始前完全一致。

最终 Skill 的导出集成测试 16/16 通过，生成一致性和 Skill 结构检查通过；App 与 DMG 均完成签名及包内资源一致性校验。最终完整 `pnpm check` 通过：243 项 Vitest、40 项平台脚本、37 项 npm 测试通过，17 项按平台条件跳过。日志为上述缓存目录中的 `check-final.log`。Swift / Windows 原生代码在本次 Skill 修订中没有再次修改，沿用前述原生测试证据。

该结果验证了本次 WorkBuddy 新会话中的指南读取、自主单次恢复、新会话观察及不重放原点击，不能推论所有模型都必然遵守文档；暂停／紧停／鉴权与原 UUID 去重仍由运行时落实。文本框首次点击的底层 unknown 缺陷仍然存在。

## macOS 暂停、紧停与撤销边界

- 在 App 中点击暂停后，CLI `recover` 退出码为 1，`error.code` 为 `paused`，原 worker PID 不变。退出 App 后，`recover` 仍拒绝，`preflight` 返回 Host paused、profile unverified。重新打开 App 仍显示暂停，`recover` 继续拒绝；只有 App 内恢复按钮解除暂停。
- 在 App 中执行紧急停止后，CLI `recover` 退出码为 1，`error.code` 为 `unavailable`，消息包含 `recovery stopped`；`preflight` 返回 Host stopped、profile unverified。退出 App 后，`recover` 仍拒绝启动服务。
- 本轮没有撤销既有 `workbuddy` 客户端，也没有为测试删除凭据或重新配对。撤销边界由 Runtime / Storage 的跨重建回归，以及 CLI 对在线已撤销凭据的恢复前拒绝、对离线后恢复服务的重新鉴权隔离测试覆盖；这不等同于本轮执行了真实客户端撤销／重配验收。

紧停后再次打开 App，界面仍显示“服务已停止”，CLI `recover` 再次拒绝。验收结束时仅通过 App 的“重新启动服务”按钮解除本次测试紧停；最终 `preflight` 为 Host ready、workbuddy valid。原有凭据及 clients 文件共 7 份的 SHA-256 在完整验收前后仍完全一致。

## Windows 隔离验收

在 Windows 11 ARM64 虚拟机中复用已有 .NET SDK，于独立验收目录构建 Host、Host / UI 测试及传输／进程测试。最终三套构建均为 0 警告、0 错误；两个测试程序在已登录的 Session 1 交互桌面完成，退出码均为 0。

新增用例覆盖服务 failed 后恢复、持久暂停／紧停优先、并发请求、等待旧 Runtime 释放、释放结果不确定时拒绝新旧执行层重叠、忽略旧 ready/fatal 事件、恢复／启动期间用户停止、撤销后不重放控制／动作／批准消息，以及每 60 秒最多三次恢复和时钟回拨边界。

真实的隔离子进程和孙进程验证 Job 管理、父进程崩溃后的后代跟踪、冷启动保护、全部退出后才能重用，以及最后一个 Job 句柄关闭时终止进程。既有真实命名管道测试通过，包括 500 轮探测／请求和 1,000 次并发探测；测试不调用桌面 worker 或读取生产凭据。原生 `--recover-fault` 在 Session 0 中以重定向 stdout 执行，返回单行 JSON `non_interactive`，退出码为 1。

Node 启动桥接另在 macOS 隔离检查：stdin 释放前不导入 worker，特殊字符参数边界保持，控制 stdin 保留，提前关闭 stdin 时退出且不导入 worker。传输后的 21 个源码文件已与清单核对哈希。

首次传输测试的“必须恰好两个进程”断言过严。最终测试允许额外的受控后代，但仍要求两个记录进程全部退出且 Job 活跃进程数降为零；原失败证据以 `.initial` 后缀保留，没有弱化退出与隔离条件。

测试计划任务 `ComputerUseFaultRecovery20261012` 已删除。虚拟机因后台反复自动暂停而临时关闭的 Pause idle 已恢复为 on，关闭窗口行为未改变。生产 Windows App 未更新；系统权限、profile、授权存储和凭据均未改动。本轮是 Host / UI 与进程／传输验收，不是 Windows 真实桌面 Agent / driver 故障恢复验收。

证据位于 `.cache/fault-recovery-windows-20261012/acceptance.md`、`test-done.json`、各构建和运行日志，以及 `windows-source-manifest.json`。

## 剩余覆盖限制

WorkBuddy 本轮仅使用已获批准的 Fixture 范围，不能据此宣称验证了跨应用授权。Windows 真实 Agent / driver 恢复、真实客户端撤销／重配、全部 Agent、系统注销／重启、首次系统权限批准及其他未知输入故障不在本轮已完成覆盖内。首次点击故障的根因仍需另行定位，成功恢复不能替代根因修复。
