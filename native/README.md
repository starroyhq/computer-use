# macOS 原生宿主

`ComputerUseHost` 是 macOS 14+ 的 AppKit 菜单栏程序。生产 bundle ID 固定为 `com.starroy.computeruse`；发行时把 `Info.plist` 放入 App 的 `Contents`，将 Swift 可执行文件放入 `Contents/MacOS`。通过 Finder 或 `open` 启动完整 App，才能验证真实的系统权限归属。直接 `swift run` 只适合开发，不证明 TCC 归属正确。

```sh
swift build --package-path native
swift test --package-path native
```

App 需要以下资源，缺失时显示错误并停止启动执行层：

```text
Contents/Resources/
  bin/cua-driver       # 固定版本 0.38.0
  bin/node
  bin/computer-use     # CLI 包装脚本
  runtime/host.js      # 编译后的统一运行时
  node_modules/       # 运行时依赖
```

只有 debug 构建（`swift build` 默认配置）读取 `CU_RESOURCES_DIR` 覆盖资源目录。release 构建（打包脚本使用 `-c release`）忽略该变量：同一用户的其他进程可以用 `launchctl setenv` 注入环境变量，不能借此让持有系统权限的宿主启动任意程序。运行时数据目录固定为 `~/Library/Application Support/Computer Use`，权限 0700，并使用文件锁阻止重复宿主。HTTP 开关每次启动默认关闭。

宿主直接用 `Process` 启动 `cua-driver serve --embedded --parent-liveness-stdio --socket …`，宿主持有独立 stdin 管道写端，宿主异常退出时 EOF 通知驱动退出；不使用 LaunchServices 启动驱动、不启动 MCP 代理。设置嵌入标识、稳定宿主 ID、标准权限模式，禁用遥测及更新检查，并清除继承的 Cua/Node/DYLD 配置。收到 socket 就绪后启动 Node 运行时，传入 `--socket`、`--driver-socket`、`--data-dir`。驱动输出与 Node stderr 均丢弃，避免把界面内容写到日志或保留调用方的输出管道。

菜单栏就绪图标使用包内光标图案，其余阶段用 SF Symbol 表示状态（启动中、已暂停、需要处理），菜单只保留状态行、设置…（⌘,）、暂停/恢复、紧急停止、重新启动服务、有新版本时的更新项、检查更新和退出。其余功能在设置窗口：`NSTabViewController` 的工具栏样式，6 个分区（通用、权限与状态、客户端、接入、更新、关于），窗口高度随分区变化，标题固定为“设置”。手动启动且缺少权限或处于持续暂停/紧停时打开“权限与状态”，后台启动不打开窗口；再次打开已有 App 只显示设置，不恢复服务。缺少 Accessibility 或 Screen Recording 时不启动驱动；该分区提供“请求系统权限”和系统设置入口，窗口打开期间每 2 秒刷新授权状态。权限变化后可在 App 中重新启动服务；系统仍要求重开时完整退出并重新打开。`computer-use doctor` 检查权限归属和预检状态；它不调用实际截图，后续必须通过 `observe` 验证截图。首次授权并不会自动替用户改动系统设置。

安装包内的 CLI 在默认 socket 未连通时，可调用同一 App 的 `ComputerUseHost --ensure-running`。helper 最多等待 35 秒，stdout 仅输出一行就绪/失败 JSON；核对包身份、真实执行路径、PID/进程启动时间/用户/图形会话、私有 socket 及二次状态快照后才报告 ready。冷启动通过 LaunchServices 对精确 App 路径传入 `--background`，不打开主窗口、不请求 TCC 权限，长期 GUI 的标准流独立于 Agent。缺权限返回 `permissions_required`；活的失败实例要求本地重启，暂停/紧停即使原进程退出也不自动恢复。源码运行和显式自定义 socket 不触发安装版自动启动。

界面文案在 `HostCore/Localization.swift`：简体中文与英文两张表，按系统首选语言选择（任何 `zh` 变体用简体中文，其余用英文），测试检查两张表的键与占位符一致。“登录时打开”使用 `SMAppService.mainApp`，默认关闭；系统要求批准时显示登录项设置入口。

Node stdin 接收 NDJSON 控制消息（`pair_allow` / `pair_deny` + `clientId`，`pause` / `resume` / `stop`，`revoke` + `clientId`，`http_enable` / `http_disable`，`control_ready` + `pid`；`foreground_allow` / `foreground_deny` 仅为兼容旧宿主保留）。stdout 仅接收 `pair_request`、`decision_finished`、`ready`、`status`、`clients`、`fatal`、`control_begin` / `control_end` 事件。配对请求结束（批准、拒绝或 60 秒过期）时运行时发送 `decision_finished`，宿主据此撤回尚未处理的弹窗，不再发送迟到的决定。权限窗口先列出客户端与目标，再由本机用户决定；拒绝是默认按钮。显示内容与 Agent 提供名称不是身份验证依据，真正的凭据验证由运行时完成。

首次 `computer-use pair --profile my-agent --name 'My Agent'` 默认请求所有桌面应用，配对弹窗和客户端列表明确显示“所有应用”；批准一次后覆盖新应用与新窗口，重启后持续有效。`allApps` 随授权保存，旧授权缺少此字段时保留原应用范围。旧桌面客户端可在“客户端”页对应卡片上直接点击“允许所有应用”，本机确认后升级全应用及前台能力，原 token、profile 和独立浏览器权限不变；应用清单、浏览器、前台与撤销在默认折叠的“高级”区；仅浏览器客户端不能通过此按钮扩大为桌面授权。`--app` 保留受限配对；`--browser` 单独使用只授权独立浏览器，`--all-apps --browser` 同时授权两者。前台权限在配对时一并授予，但会话默认后台，不逐窗口或逐会话审批；全应用授权不替代系统权限。

本地升级授权发送 `grant_all_apps`（`clientId`、UUID `requestId`），等待 `clients` 事件附带的 `operation` 结果；只有匹配当前服务 generation、请求及客户端的成功回执，并且客户端快照确认全应用和前台能力后，才显示保存成功。15 秒超时显示结果未确认，不自动重发；停止或重启清除等待状态，旧 generation 的回执被忽略。同代迟到回执仍更新客户端快照，但不把已超时的请求反馈改为成功；已在本机撤销的客户端不会被旧快照恢复。服务暂停但仍运行时可以管理授权，不解除暂停；离线时卡片操作禁用并显示原因。

暂停与紧停先将阻断原因写入当前用户私有的 `host-state.json`，普通退出、登录项、更新重开和 Agent 调用均保留；只有 App 内“恢复/重新启动服务”按钮清除。紧急停止随后发送 `stop`，允许运行时在一秒内释放手势并关闭会话，再终止全部子进程；无响应进程被强制终止。驱动、运行时崩溃或无效事件均停止整个执行层。恢复必须使用“重新启动服务”，不会重放任何动作。普通“暂停”只阻止新动作，不用于终止手势。

“通用”分区的“安装到 ~/.local/bin…”只在用户点击按钮后创建 `~/.local/bin/computer-use` 符号链接，不覆盖已有文件或其他链接；“接入”分区默认只显示“复制安装提示词”，通过 `skill prompt --profile` 获取文本，交给目标 Agent 自行安装和验证。profile 选择、手动配对、stdio 配置和本机 HTTP 放在默认收起的“高级接入”；同一 profile（默认 `default`）用于提示词与所有命令。展开高级区域后才使用只读 `preflight` 加载 profile 名称与状态。App 不直接安装 Skill；生成内容使用当前安装路径，不包含 token。本机 HTTP 开关只在本次运行有效。“客户端”分区以卡片列出运行时 `clients` 事件里的名称、短标识和授权范围摘要（只用于展示，不含凭据）；卡片上的主按钮直接发起全应用升级，应用清单、浏览器、前台与撤销放在默认折叠的“高级”区，搜索可按名称、短标识或应用过滤。撤销前需确认。App 退出时清理子进程。

更新：宿主用内置 Node 运行 `runtime/cli.js update check|download`（逻辑见 `src/update.ts`），不另写一套网络代码。自动检查每小时判断一次是否距上次成功检查满 24 小时，启动 1 分钟后首次判断；只有带 Developer ID 团队的正式签名版本才自动检查和一键安装，ad-hoc 开发版本只能手动检查。一键安装的步骤：下载到 `~/Library/Caches/com.starroy.computeruse/Updates/<版本>-<UUID>`（0700）→ `ditto` 解压 → 核对包内恰好一个 `Computer Use.app`、Bundle ID、版本且比当前新 → 用当前进程的团队 ID 生成签名要求，`SecStaticCodeCheckValidity` 严格校验（含嵌套代码）→ `spctl --assess` → 用户确认（有 Agent 正在操作时额外提示）→ 启动替换脚本后按正常流程退出。脚本等旧进程退出，把旧 App 移到更新目录、新 App 放回原路径，失败时还原，最后重新打开；新版本启动时清理更新目录。App 被系统隔离运行或所在目录不可写时不替换，改为在访达中显示校验过的新版本。因为 Bundle ID 和签名团队不变，系统权限按设计保留。v0.6.0 提供 ZIP 和 DMG；DMG（`scripts/package-dmg.mjs` 生成，含 App 与 `/Applications` 快捷方式）用于首次安装，一键更新仍下载 ZIP。App 与 DMG 的公证、装订由发布 CI 验证，本次结果仍待确认；包内 App 已公证不代表 DMG 已公证。

自动测试覆盖纯逻辑：持久暂停/紧停、紧停取消排队重启、迟到 ready、旧 PID/路径/会话、原子私有状态及非普通文件拒绝、helper 输出、接入 profile 一致性及受限 CLI 子进程、环境净化、启动参数、NDJSON 分帧、请求必需字段、配置转义、目录/单实例锁、socket 边界、审批队列的撤回规则、文案表、更新结果解析与错误本地化、检查调度、签名要求、安装包内容核对和替换脚本（含失败还原与超时）；`ComputerUseHostTests` 在两种语言、三种状态下检查 6 个分区的布局（设置 `CU_SETTINGS_SNAPSHOTS=<目录>` 可导出各分区与整窗截图），并用假 CLI 检查更新状态机（自动检查、跳过、失败提示、取消、校验失败后清理、开发版本不下载）。两项人工验收默认跳过：`CU_LIVE_UPDATE_ZIP` + `CU_LIVE_UPDATE_VERSION` 用真实发布包走安装前校验；再加 `CU_LIVE_INSTALL_APP` 与 `CU_LIVE_INSTALL_PID` 会对该路径上正在运行的 App 执行同样的原位替换（会结束并替换这个 App）。打包 App 的当前本机实测范围见[验证记录](../docs/validation-results.md)；登录项、从真实发布升级及更广支持矩阵仍待验收，签名、公证与装订由发布 CI 验证。编译通过不代表这些系统行为已通过。
