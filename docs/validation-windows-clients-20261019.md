# Windows 客户端卡片页验证（2026-10-19）

对齐 macOS 提交 `2c7e572` 的客户端授权入口。Windows 使用既有 WinForms 风格及 Windows 10 1809 兼容目标，不修改 Host 授权状态机、凭据、CLI/MCP/RPC 或持久化格式。

## 实现与回归范围

- 每客户端一张卡片，显示名称、短标识、范围徽标与摘要，直接提供“允许所有应用”；完整授权显示状态，仅浏览器客户端无桌面扩权入口。
- 搜索名称、完整/短标识及原始/展示应用路径；高级区展示完整范围和撤销，展开状态跨刷新与搜索保留，移除客户端后清理。
- 复用自动尺寸栈，长路径与反馈随可用宽度换行；测试覆盖同一客户端范围变化、收起重开、滚动可达、完整按钮边界和原生窗口命中。
- 全局 pending 包含搜索隐藏及暂时消失的请求归属者；反馈按客户端 ID 呈现，消失客户端的终态带身份显示在页脚。
- 确认默认取消；授权与撤销确认期间服务 revision 改变后不发送操作；暂停期间升级不恢复执行。保留既有保存回执、失败、15 秒超时、撤销竞态和旧实例隔离测试。
- 使用指南、Windows 说明及生成 Skill 已同步；仅旧版列表界面仍需先选择行。

## 已完成检查

| 检查 | 结果 |
|---|---|
| `pnpm check` | 通过：TypeScript、Biome、13 个 Vitest 文件 / 404 项测试；脚本测试 135 通过 / 38 条件跳过；npm 测试 37 通过 |
| Windows Host / UI / Transport 三个工程 × `win-arm64` / `win-x64` | 最终源码交叉编译共 6 项通过，均为 0 warnings / 0 errors |
| Windows Transport 实际运行 | Windows 11 ARM64 通过：进程 Job 清理、连续探测与请求、1,000 次并发探测、容量与空闲超时、取消和监听失败 |
| 临时 .NET SDK | 微软官方 10.0 发布元数据提供的 `10.0.402` / `osx-arm64`，下载归档 SHA512 校验一致 |
| Skill 生成与结构校验 | `node scripts/build-skill.mjs --check` 与 skill-creator `quick_validate.py` 通过 |
| `git diff --check` | 通过 |

交叉编译使用 `EnableWindowsTargeting=true`，构建输出、NuGet 缓存及 SDK 均隔离在 `.cache/windows-clients-20261019-144812/`，未增加项目依赖或安装全局 SDK。结果与完整命令见 `crossbuild-results.json`、`crossbuild-*.log`；最终 22 个源码/工程文件 SHA256 见 `crossbuild-source-sha256.json`。编译不代表 Windows 运行测试通过。

## Windows 交互验收状态

**100% 全量 Host/UI、150% 定向 UI 均已通过；150% 全量的既有存储压力用例失败另行记录。**

原 Windows 11 ARM64 虚拟机启动时已登录并解锁（Session 1，WTS sessionFlags=1），实际 DPI 为 192（200%），已有 .NET SDK 10.0.402。首轮生产宿主 ARM64/x64 在该虚拟机编译通过。

Parallels 来宾执行与图形桥接曾失联。用户批准注销以调整真实 DPI，并在正常重启未完成、ACPI 关机被取消后，另行批准强制重置；重置后执行通道与已登录桌面恢复。

100% 运行命令为 `ComputerUse.WindowsHostTests.exe --expected-dpi 96 --screenshots <临时共享目录>\snapshots-96`，`ui-96-result.json` 记录退出码 0（07:47:30–07:59:14 UTC），真实 `DeviceDpi=96`，全部 Host/UI 检查通过并生成 60 张双语快照。已视觉检查其中 17 张客户端关键图，覆盖中英文、默认/最小窗口、长路径、失败/未确认反馈、搜索和滚动后的撤销按钮，没有发现可见裁切或反馈错挂。

150% 的前两次尝试均确认真实 `DeviceDpi=144`，但在既有 `CheckStartupState` 并发发布压力用例中，读取方等待私有文件互斥锁超过 2 秒，按现有语义抛出 `0x800705B4` 的 `IOException`，尚未进入卡片测试。该方法与 `HEAD 2c7e572` 一致，`PrivateData.cs` 没有修改；默认测试断言和生产超时未放宽。失败日志保留为 `ui-144-lock-timeout.*` 和 `ui-144-lock-timeout-2.*`，不计为通过。

后续 150% 改用 `--clients-only --expected-dpi 144 --screenshots <临时共享目录>\snapshots-144` 进行 DPI/UI 定向验收，退出码 0（08:13:21–08:29:36 UTC），真实 `DeviceDpi=144`，生成 36 张卡片快照。该模式明确跳过 startup-state（含文件并发压力）、startup-lifecycle、fault-recovery 三项启动检查，保留配对、全部客户端卡片、Host 授权 ACK/错误/15 秒超时、撤销、暂停、紧停、旧实例、设置交互与布局检查。默认全量及专用 `--startup-state-checks` 入口保持原检查内容。定向隔离不代表修复并发锁问题，也不能替代全量结果。运行前探针确认 Session 1 已解锁（WTS sessionFlags=1），运行中的托管 DLL SHA256 与本地最终编译产物一致：`90d1e7e9f7c88972ed648dc3a918e7d219560c285e625cf8cab0be7fb47e742e`。

两轮共生成 96 张快照，实际查看 33 张关键图（100%：17 张，150%：16 张）。中英文默认/最小窗口、长范围、失败和未确认反馈、搜索均未发现明确裁切、横向溢出或反馈错挂；滚动后的撤销按钮完整位于卡片和视口内。动态高度、重复展开收起、原生点击命中及正确客户端操作以 harness 断言为依据。

## 关键快照

以下均为假后端及临时数据，不包含真实客户端或桌面内容。默认图实际为 896×689（100%）与 1342×1031（150%），未通过放大图像模拟 DPI。

| 缩放 / 语言 | 默认窗口 | 最小窗口 | 长范围滚动后的撤销 |
|---|---|---|---|
| 100% / English | [默认](assets/windows-clients-20261019/100/en-default.png) | [最小](assets/windows-clients-20261019/100/en-minimum.png) | [撤销](assets/windows-clients-20261019/100/en-revoke.png) |
| 100% / 简体中文 | [默认](assets/windows-clients-20261019/100/zh-default.png) | [最小](assets/windows-clients-20261019/100/zh-minimum.png) | [撤销](assets/windows-clients-20261019/100/zh-revoke.png) |
| 150% / English | [默认](assets/windows-clients-20261019/150/en-default.png) | [最小](assets/windows-clients-20261019/150/en-minimum.png) | [撤销](assets/windows-clients-20261019/150/en-revoke.png) |
| 150% / 简体中文 | [默认](assets/windows-clients-20261019/150/zh-default.png) | [最小](assets/windows-clients-20261019/150/zh-minimum.png) | [撤销](assets/windows-clients-20261019/150/zh-revoke.png) |

## 测试夹具修正与环境恢复

200% 前期定向运行（`ui-progress-192.stdout.log`）也通过新卡片的双语、默认/最小窗口、直接授权、全局 pending、反馈归属、搜索、展开保持、长范围动态高度、收起重开、原生 `WindowFromPoint` 命中和正确客户端撤销，以及原授权回执、超时、暂停、紧停、撤销竞态、旧实例和接入提示词回归。末尾既有更新页测试失败，因此该次进程整体失败，未产生最终截图。原全量运行另暴露既有故障恢复测试未等待前一实例异步退场的竞态；测试现增加有界退场屏障、保留原断言并核对新实例确实启动。更新页测试改为使用未启动自动检查的独立服务、临时设置和窗口，避免模拟状态被计时器覆盖；生产状态机未改。这两项测试修正已由后续 100% 全量运行确认。

原始设置已备份为 `original-dpi-settings.json`、`original-video-settings.json`：LogPixels=192、Win8DpiScaling=1，Parallels NativeScalingInGuest=0。第一次写入 96 并正常重启后，真实探针仍为 192，失败记录保留在 `ui-96-retina-fixed.*`，不计为 100% 通过。Parallels 的 [Retina 模式固定 200%](https://kb.parallels.com/en/123198)；测试时通过受支持的 `prlctl set --native-scaling-in-guest on` 临时允许 Windows 管理缩放，分别重启后确认真实 DPI 96/144 再运行 harness。

已恢复原始缩放值及原来不存在的可选属性，恢复 Parallels `NativeScalingInGuest=0`；四项视频配置与备份一致。正常重启后实际探针确认 `dpi=192`、`scaleRegistry=192`、Session 1 解锁（WTS sessionFlags=1）。4 个注册表属性逐项比对备份一致；10 个测试任务及最后的环境核对任务均已注销，剩余本轮任务数 0、测试进程数 0（08:35:23 UTC）。证据为 `restored-environment.json`、`cleanup-verification.json`。核对后已将虚拟机恢复为开始时的 suspended 状态。临时源码、运行目录与日志均使用本轮专用名称，未覆盖原安装目录。

本次未主动变更真实配对、授权、凭据或安装版 App；未改版本、commit、push 或发布。Windows 10、原生 x64 桌面及真实 Agent/driver 跨应用操作未在本轮验收。
