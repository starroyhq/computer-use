# 既有客户端全应用授权升级验收（2026-10-14）

本轮验证“旧客户端保留凭据与 profile，在 App 内一次升级桌面授权”的实现，以及实际授权范围诊断和 Agent 不再逐窗询问的通用指南。macOS 已完成真实跨应用、跨窗口观察和暂停、紧停、撤销验证；Windows 已完成 Host / UI、传输隔离测试及 ARM64、x64 打包，并在最终 ARM64 包中验证原 profile 的跨应用、三窗口后台观察。

## 源码与验证边界

检查及打包使用隔离源码：基线 `512f59780cbb5d2f683ef1c61155ef17fe926d31` 加本任务的 32 个文件修改。主工作区另一个任务并行进行的镜像相关改动被保留，未混入本轮测试包；具体文件与排除边界见 `source-manifest.json`。本次产物是本地修改版，没有提交、发布或新增公证，不等同于正式发布附件。

可复现源码归档为 `artifacts/grant-upgrade-20261014/source-snapshot.tar.gz`，包含 171 个源码文件，不含凭据、`.env.local`、依赖或构建缓存。后续并行镜像改动也涉及 Skill 模板和接入提示词，因此主工作区的混合状态与本次测试包不完全相同；详见 `evidence/source-isolation.json`。

已脱敏的 macOS 结果、测试截图、日志与源码清单位于仓库根目录下的 `artifacts/grant-upgrade-20261014/evidence/`。Windows 交付证据位于其 `windows/` 子目录；原始检查证据保留于 `.cache/grant-all-apps-windows-20261014/`。交付日志统一转为 UTF-8，原始编码保留在缓存中；观察记录中的截图路径改为交付目录的相对路径，原始响应仍保留在缓存中。本文不记录真实用户客户端名称、token、凭据内容或凭据文件元数据。

## 实现与权限边界

- 新配对仍默认授权所有桌面应用；高级 `--app` 受限模式继续可用。已有受限客户端不会因更新自动扩权，范围外的窗口仍完全不出现在 `targets`。
- 用户在 App“客户端”页选择“允许所有应用”并确认后，Host 才能升级已有桌面客户端。原客户端身份、token、profile 和 MCP 配置保留，独立浏览器权限不变；仅独立浏览器的客户端不能通过此入口取得桌面权限。
- 升级不暴露为 CLI 或 MCP 操作。候选授权先写入临时文件，最终校验、原子替换和内存提交之间没有异步间隙。准备期间的撤销会使旧快照失效；存储失败不能提前扩权。App 等待运行时通过现有 `clients.operation` 回执确认，不以管道写入成功代替保存成功。
- `capabilities`、`doctor` 返回当前已鉴权客户端的 `authorization`；在线 `preflight.profile.authorization` 只复制合法响应。离线、旧服务缺少字段或字段无效时，范围保持未知。
- 指南明确同一已授权任务内跨应用、窗口、会话和重连不重复询问；默认后台，确有必要且已获准的前台操作先通知再执行，用户同时操作时暂停协调。该文案不会解除运行时的受限范围、暂停、紧停、撤销或系统权限要求。

## 自动化与隔离检查

| 检查 | 实际结果 |
|---|---|
| 隔离源码 `pnpm check` | Skill 生成同步、TypeScript、Biome 均通过；12 个 Vitest 文件、348 项测试通过；平台脚本 40 项通过、17 项条件跳过；npm 37 项通过 |
| Swift 完整测试 | 共 96 项，0 失败、5 项条件跳过；其中 HostCore 63 项、Host App 33 项 |
| Developer ID 团队约束补测 | 打包后单独重跑 1 项，通过；该项在上述完整测试时因尚无签名产物而跳过 |
| macOS UI 截图 | 前一轮已生成中英文设置窗口、授权确认、待处理、成功、失败和未确认状态截图；最终完整 Swift 回归未重复启用截图生成 |
| Windows Host / UI | Windows ARM64 虚拟机内完整程序退出码为 0；16 组检查通过，覆盖本地确认、保存回执、失败、超时、暂停、生命周期隔离及双语布局 |
| Windows 传输 / 进程 | 程序退出码为 0；真实命名管道的 500 轮探测 / 请求、1,000 次并发探测、容量与空闲恢复、取消和子进程清理检查通过 |

Swift 剩余跳过项涉及真实发布包安装校验、运行中 App 的真实原位更新，以及两项截图生成；截图已有本轮前置检查，真实更新安装未执行。Windows 传输检查不调用桌面 worker，也不读取生产用户数据，不能替代跨应用截图和输入验收。

实际 Windows 启动还发现并修复了 worker 经 `--eval` 导入时误将 `host.js` 路径当作位置参数的问题。Host stdin 控制命令原先共用等待队列，会让撤销、暂停和紧停等待授权保存；现仅串行化 HTTP 监听器变更，执行控制立即进入 Runtime，授权文件仍由存储队列串行更新。新增 8 项真实子进程测试覆盖普通入口、Windows 同款启动引导、预启动 EOF，以及写盘挂起时停止、撤销和暂停的行为。正常关闭时先停止执行，再等待已排队的客户端写入，避免 EOF 截断撤销；Host 现有 1500ms 关闭上限及原生宿主的有界终止策略保留，写盘失败仍由原操作报告，无法保证强制终止或存储永久阻塞后的持久化。新增回归包含延迟 1 秒写盘及关闭中的保存失败。最终检查日志为 `evidence/check-final.log`。

新增存储回归及独立复核确认：保存前内存不出现扩大范围；准备期间停止或撤销不会提交候选授权；临时文件清理失败后重新加载仍是原范围；升级一个客户端时撤销另一个客户端，不会从旧快照恢复被撤销客户端；重复升级幂等。公共 RPC 调用升级命令被拒绝，旧凭据在合法升级后继续有效。

## macOS 真实调用

本轮使用临时专用 profile 和两个可丢弃 Fixture 应用 alpha、beta。首次受限配对和后续“允许所有应用”均在本机 App 内批准。以下结果由本次签名测试 App 的实际 CLI、Runtime、driver 及截图返回验证，不使用模拟后端。之后发现的 worker 参数与 stdin 调度修复已纳入最终包并通过子进程回归；macOS 的本地界面及授权实现未变，未重新执行整套图形验收。

| 场景 | 结果与证据 |
|---|---|
| 升级前受限范围 | `authorization.allApps` 为 false，应用清单仅 alpha；`targets` 不包含 beta。见 `macos-before-upgrade.json` |
| 本地升级后跨应用 | `allApps` 为 true、`appIds` 为空、`browser` 仍为 false；原 profile 凭据文件未被重写。沿用原 profile 分别观察 alpha、beta，均返回真实截图。见 `macos-after-upgrade.json` 及配套 PNG |
| 升级后新增窗口 | 新 beta 窗口可直接建立后台会话并观察，没有再次配对或逐窗批准。见 `macos-new-window.json` |
| 退出后按需启动 | 正常退出 Host，随后由同包 CLI 受控启动；原授权保留，后台观察成功。见 `macos-after-reopen.json` |
| 暂停与退出重开 | App 暂停后会话请求返回 `paused`；退出及重新打开后暂停仍保留，CLI 不自行解除。仅 App 内恢复后回到 ready。见 `macos-paused.json`、`macos-paused-after-exit.json`、`macos-resumed.json` |
| 紧停与退出重开 | 紧停后 Host 为 stopped，CLI 拒绝启动服务；退出和重开不解除。通过 App 内重启服务后恢复 ready，原全应用授权仍保留。见 `macos-stopped.json`、`macos-stopped-after-exit.json`、`macos-restarted-after-stop.json` |
| 撤销与再次打开 Host | 撤销专用客户端后原凭据立即返回 `unauthorized`；重新打开 Host 后仍被拒绝。见 `macos-revoked.json`、`macos-cleanup.json` |

凭据保留结论来自升级前后的文件身份、修改时间和大小核对，以及同一 profile 持续成功鉴权；交付记录不包含这些文件元数据或 token。跨应用链路本轮验证的是目标发现、后台会话与实际观察，没有把它扩写成所有应用的点击、键盘或业务操作都已验收。

收尾已完成：恢复原 `/Applications/Computer Use.app`，状态为 ready，原有默认 profile 仍有效；确认专用客户端撤销跨 Host 重开有效后，仅通过 CLI 删除本轮新建的本地 profile，alpha / beta Fixture 进程均已退出。没有迁移或扩大真实用户的既有客户端。见 `macos-cleanup.json`。

## Windows 真实调用

Windows 11 ARM64 虚拟机使用临时专用 profile `windows-grant-20261014`、客户端 `Win Grant 20261014` 和 alpha / beta 两个 Fixture。受限配对和扩权确认均由用户在 App 内完成，没有删除或重建原 profile。

- 升级前，`authorization` 仅包含 alpha；`targets` 只返回 alpha，后台会话和实际观察成功，已检查截图。见 `real-before-upgrade-retry.json`。
- 用户确认升级后，原 profile 返回 `allApps=true`、空 `appIds`、`foreground=true`、`browser=false`。退出并重新启动 Host、等待 runtime ready 后，`preflight` 仍验证原凭据有效且范围相同。见 `real-preflight-reopened-ready.json`。
- 同时保留失败证据：首次 `targets` 返回 `unavailable`；一次重试中 doctor 的 desktop 检查失败，但随后 alpha 发现和观察成功；扩权后的另一次 `targets` 也返回 `unavailable`。独立同包 worker 的全应用枚举、进程身份校验及两个 Fixture 窗口枚举成功。尚无证据将瞬时错误归因于特定窗口，也没有通过吞掉错误或调整授权绕过。
- 暂停后退出重开仍为 paused，Runtime 不自行恢复，凭据离线时如实显示 unverified；通过本地恢复按钮才能回到 ready。见 `real-preflight-paused-before-reopen.json`、`real-preflight-paused-after-reopen.json`。
- 紧停后退出重开仍为 stopped；原 profile 调用 `targets` 明确要求在 App 重启服务，CLI 未自行启动 Runtime。见 `real-preflight-stopped-after-reopen.json`、`real-stopped-call-after-reopen.json`。
- 切换到最终 ARM64 包后仍保持 stopped，仅经本地“重新启动服务”回到 ready，原 profile 仍 valid 且范围不变。见 `real-preflight-final-stopped.json`、`real-preflight-final-ready.json`。
- 构建结束后，最终包的 doctor 桌面检查全部通过；沿用原 profile 分别为 alpha、beta 两个独立可执行文件建立后台会话并取得实际截图，每个窗口返回 10 个元素。观察前后前台窗口和进程均未改变。见 `real-final-observe.json`、`focus-final-observe.json` 及配套 PNG。
- 后台点击一次 alpha 的 New Window 按钮，动作返回 executed / unconfirmed；随后通过目标发现和观察验证新窗口确实出现，没有重发该动作。三个窗口均可沿用原 profile 后台观察，无新的配对或扩权提示，观察期间焦点未改变。见 `real-final-new-window-action.json`、`real-final-three-windows.json`、`focus-final-three-windows.json`。

- 本地撤销专用客户端后，原 profile 调用返回 `unauthorized`；退出重开后仍拒绝该凭据。随后仅删除本次 profile，关闭测试 Host、两个 Fixture 进程及其三个窗口，移除本任务计划任务。见 `real-final-revoked.json`、`real-final-revoked-reopened.json` 和 `windows-real-acceptance.json` 中的 cleanup。虚拟机保持运行以供另一个任务使用。

完整结果见交付目录的 `windows-real-acceptance.json`；Windows 段的证据文件名均位于 `evidence/windows/`。凭据保留检查只记录比较结果，不附凭据文件内容或元数据。

本轮最终观察已通过；之前的间歇失败原因未确定，不能宣称已根治。原始结果与规范化诊断分别保留；`targets-diagnostic-original.log` 保留临时诊断日志混排原文，`.json` 副本仅修复格式以便读取。

## 打包与尚未完成的范围

macOS 的 `pnpm package:app` 与 `pnpm package:dmg` 均通过：ARM64 包、6 个已签名原生组件、内置 Node / driver 版本、CLI help、SDK 加载，以及 DMG 内容、挂载后的 App 和磁盘映像签名均通过检查。交付产物位于 `artifacts/grant-upgrade-20261014/Computer Use.app` 和 `Computer Use.dmg`，日志为交付证据中的 `macos-app-package-final.log`、`macos-dmg-package-final.log`。包内 Skill 与隔离源码逐字节一致，`instructions` 除正常版本标题外与维护指南一致，导出 Skill 和接入提示词均含升级入口与不重复询问规则，见 `macos-packaged-guides.json`。本轮使用 Developer ID 签名，但没有进行新的 Apple 公证或发布。

Windows ARM64、x64 的 ZIP、Setup.exe 和各自 SHA-256 均已产出，位于同一交付目录。两个架构都验证了 PE 架构、内含 Node / Cua 版本、CLI、原生 SDK 及 Skill 一致性，每个 ZIP 解压后再次校验。工具链使用 .NET 10.0.402、Node 24.21.0、pnpm 10.8.1、Inno Setup 7.1.0，详见 `windows-package-verification.json`。x64 检查使用 Windows 11 ARM64 的仿真运行，不代表原生 x64 或 Windows 10 桌面验收。

Windows 实际运行和验收使用便携目录；Setup.exe 经过打包校验，但未执行安装器覆盖安装。两个架构的最终包均实际验证同包启动引导可达到 ready、正常 EOF 退出码为 0；原生 x64 / Windows 10 桌面以及真实安装更新仍未验收。

本轮也未执行干净系统的首次系统权限批准、系统注销 / 重启、真实发布包覆盖更新，或第三方 Agent 新会话中对修订指南的端到端行为验收。文案检查与运行时测试分别证明其覆盖范围，不据此保证所有 Agent 都不会重复询问。

## Review 修复回归（同日）

以上打包验收完成后，review 发现并修复两项原生 UI 问题。本节检查使用当前工作区，不改写前述隔离源码、打包产物及真实授权验收证据。

- macOS 升级授权确认默认取消，初始焦点位于取消按钮；Return 和 Esc 均取消，明确选择“允许所有应用”才批准。为保留取消按钮的双键行为，仅在当前模态窗口中临时处理 Esc，退出时移除事件处理器；其他确认框保持原有默认行为。回归实际向中英文测试弹窗投递键盘事件，并单独验证点击批准，不调用真实授权服务。
- Windows 本地撤销先取消对应升级请求、清除成功反馈并移除客户端；当前服务实例的迟到回执或旧快照不能恢复该客户端。重启后依据新服务的实际快照显示授权，避免撤销未送达时永久隐藏客户端；发送失败沿用停止服务处理。新增回归覆盖升级成功后撤销、处理中撤销、延迟与失败发送、迟到事件、暂停保留，以及重启后的新旧实例隔离。

验证结果：`swift test --package-path native` 退出码 0，共 97 项、0 失败、4 项条件跳过（真实发布包安装、运行中 App 原位更新、两项截图生成）。Windows 11 ARM64 虚拟机中的真实 Host 与 fake UI harness Release 构建各 0 警告、0 错误；完整 UI 17 组全部通过，退出码 0。`git diff --check` 通过。日志位于 `.cache/review-fixes-20261014/macos-swift.log`、`windows-build.log`、`windows-ui.utf8.log` 及 `windows-ui-result.json`。

本次没有操作真实客户端或凭据，没有提交、发布或重新打包；前述 `artifacts/grant-upgrade-20261014/` 产物不包含这两项 review 修复。
