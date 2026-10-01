# macOS 原生宿主

`ComputerUseHost` 是 macOS 14+ 的 AppKit 菜单栏程序。生产 bundle ID 固定为 `com.starroy.computeruse`；发行时把 `Info.plist` 放入 App 的 `Contents`，将 Swift 可执行文件放入 `Contents/MacOS`。通过 Finder 或 `open` 启动完整 App，才能验证真实的系统权限归属。直接 `swift run` 只适合开发，不证明 TCC 归属正确。

```sh
swift build --package-path native
swift test --package-path native
```

App 需要以下资源，缺失时显示错误并停止启动执行层：

```text
Contents/Resources/
  bin/cua-driver       # 固定版本 0.28.2
  bin/node
  bin/computer-use     # CLI 包装脚本
  runtime/host.js      # 编译后的统一运行时
  node_modules/       # 运行时依赖
```

只有 debug 构建（`swift build` 默认配置）读取 `CU_RESOURCES_DIR` 覆盖资源目录。release 构建（打包脚本使用 `-c release`）忽略该变量：同一用户的其他进程可以用 `launchctl setenv` 注入环境变量，不能借此让持有系统权限的宿主启动任意程序。运行时数据目录固定为 `~/Library/Application Support/Computer Use`，权限 0700，并使用文件锁阻止重复宿主。HTTP 开关每次启动默认关闭。

宿主直接用 `Process` 启动 `cua-driver serve --embedded --parent-liveness-stdio --socket …`，宿主持有独立 stdin 管道写端，宿主异常退出时 EOF 通知驱动退出；不使用 LaunchServices 启动驱动、不启动 MCP 代理。设置嵌入标识、稳定宿主 ID、标准权限模式，禁用遥测及更新检查，并清除继承的 Cua/Node/DYLD 配置。收到 socket 就绪后启动 Node 运行时，传入 `--socket`、`--driver-socket`、`--data-dir`。驱动默认输出丢弃，避免把界面内容写到日志；Node stderr 由运行时遵守仅诊断元数据约定。

菜单栏图标用 SF Symbol 表示状态（启动中、就绪、正在操作、已暂停、需要处理），菜单只保留状态行、设置…（⌘,）、暂停/恢复、紧急停止、重新启动服务、有新版本时的更新项、检查更新和退出。其余功能在设置窗口：`NSTabViewController` 的工具栏样式，6 个分区（通用、权限与状态、客户端、接入、更新、关于），窗口高度随分区变化，标题固定为“设置”。缺少权限时启动即打开“权限与状态”，其余情况只驻留菜单栏；再次打开 App 回到设置窗口。缺少 Accessibility 或 Screen Recording 时不启动驱动；该分区提供“请求系统权限”和系统设置入口，窗口打开期间每 2 秒刷新授权状态。权限变化后须完整退出并重新打开 App。`computer-use doctor` 检查权限归属和预检状态；它不调用实际截图，后续必须通过 `observe` 验证截图。首次授权并不会自动替用户改动系统设置。

界面文案在 `HostCore/Localization.swift`：简体中文与英文两张表，按系统首选语言选择（任何 `zh` 变体用简体中文，其余用英文），测试检查两张表的键与占位符一致。“登录时打开”使用 `SMAppService.mainApp`，默认关闭；系统要求批准时显示登录项设置入口。

Node stdin 接收 NDJSON 控制消息（`pair_allow` / `pair_deny` + `clientId`，`pause` / `resume` / `stop`，`revoke` + `clientId`，`http_enable` / `http_disable`，`control_ready` + `pid`；`foreground_allow` / `foreground_deny` 仅为兼容旧宿主保留）。stdout 仅接收 `pair_request`、`decision_finished`、`ready`、`status`、`clients`、`fatal`、`control_begin` / `control_end` 事件。配对请求结束（批准、拒绝或 60 秒过期）时运行时发送 `decision_finished`，宿主据此撤回尚未处理的弹窗，不再发送迟到的决定。权限窗口先列出客户端与目标，再由本机用户决定；拒绝是默认按钮。显示内容与 Agent 提供名称不是身份验证依据，真正的凭据验证由运行时完成。

紧急停止先发送 `stop`，允许运行时在一秒内释放手势并关闭会话，再终止全部子进程；无响应进程被强制终止。驱动、运行时崩溃或无效事件均停止整个执行层。恢复必须使用“重新启动服务”，不会重放任何动作。普通“暂停”只阻止新动作，不用于终止手势。

“通用”分区的“安装到 ~/.local/bin…”只在用户点击按钮后创建 `~/.local/bin/computer-use` 符号链接，不覆盖已有文件或其他链接；“接入”分区的“复制 stdio 配置”提供指向当前安装包的配置，不包含 token；本机 HTTP 开关只在本次运行有效。“客户端”分区列出运行时 `clients` 事件里的名称与授权范围（只用于展示，不含凭据），撤销前需确认。App 退出时清理子进程。

更新：宿主用内置 Node 运行 `runtime/cli.js update check|download`（逻辑见 `src/update.ts`），不另写一套网络代码。自动检查每小时判断一次是否距上次成功检查满 24 小时，启动 1 分钟后首次判断；只有带 Developer ID 团队的正式签名版本才自动检查和一键安装，ad-hoc 开发版本只能手动检查。一键安装的步骤：下载到 `~/Library/Caches/com.starroy.computeruse/Updates/<版本>-<UUID>`（0700）→ `ditto` 解压 → 核对包内恰好一个 `Computer Use.app`、Bundle ID、版本且比当前新 → 用当前进程的团队 ID 生成签名要求，`SecStaticCodeCheckValidity` 严格校验（含嵌套代码）→ `spctl --assess` → 用户确认（有 Agent 正在操作时额外提示）→ 启动替换脚本后按正常流程退出。脚本等旧进程退出，把旧 App 移到更新目录、新 App 放回原路径，失败时还原，最后重新打开；新版本启动时清理更新目录。App 被系统隔离运行或所在目录不可写时不替换，改为在访达中显示校验过的新版本。因为 Bundle ID 和签名团队不变，系统权限按设计保留。

自动测试覆盖纯逻辑：环境净化、启动参数、NDJSON 分帧、请求必需字段、配置转义、目录/单实例锁、socket 边界、审批队列的撤回规则、文案表、更新结果解析与错误本地化、检查调度、签名要求、安装包内容核对和替换脚本（含失败还原与超时）；`ComputerUseHostTests` 在两种语言、三种状态下检查 6 个分区的布局（设置 `CU_SETTINGS_SNAPSHOTS=<目录>` 可导出各分区与整窗截图），并用假 CLI 检查更新状态机（自动检查、跳过、失败提示、取消、校验失败后清理、开发版本不下载）。两项人工验收默认跳过：`CU_LIVE_UPDATE_ZIP` + `CU_LIVE_UPDATE_VERSION` 用真实发布包走安装前校验；再加 `CU_LIVE_INSTALL_APP` 与 `CU_LIVE_INSTALL_PID` 会对该路径上正在运行的 App 执行同样的原位替换（会结束并替换这个 App）。尚需通过完整安装包进行真实验证：权限归属、截图、中文输入、前后台操作、授权弹窗、退出与紧急停止、登录项、更新安装、打包签名及公证。编译通过不代表这些系统行为已通过。
