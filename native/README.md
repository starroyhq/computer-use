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

启动和重新打开 App 时显示状态与权限窗口；关闭窗口后仍驻留菜单栏。窗口及菜单均提供明确的“请求系统权限”操作，缺少 Accessibility 或 Screen Recording 时不启动驱动。权限变化后须完整退出并重新打开 App。`computer-use doctor` 检查权限归属和预检状态；它不调用实际截图，后续必须通过 `observe` 验证截图。首次授权并不会自动替用户改动系统设置。

Node stdin 接收 NDJSON 控制消息（`pair_allow` / `pair_deny` + `clientId`，`pause` / `resume` / `stop`，`revoke` + `clientId`，`http_enable` / `http_disable`，`control_ready` + `pid`；`foreground_allow` / `foreground_deny` 仅为兼容旧宿主保留）。stdout 仅接收 `pair_request`、`decision_finished`、`ready`、`status`、`clients`、`fatal`、`control_begin` / `control_end` 事件。配对请求结束（批准、拒绝或 60 秒过期）时运行时发送 `decision_finished`，宿主据此撤回尚未处理的弹窗，不再发送迟到的决定。权限窗口先列出客户端与目标，再由本机用户决定；拒绝是默认按钮。显示内容与 Agent 提供名称不是身份验证依据，真正的凭据验证由运行时完成。

紧急停止先发送 `stop`，允许运行时在一秒内释放手势并关闭会话，再终止全部子进程；无响应进程被强制终止。驱动、运行时崩溃或无效事件均停止整个执行层。恢复必须使用“重新启动服务”，不会重放任何动作。普通“暂停”只阻止新动作，不用于终止手势。

“安装 CLI”只在用户点击按钮后创建 `~/.local/bin/computer-use` 符号链接，不覆盖已有文件或其他链接；“复制 MCP stdio 配置”提供指向当前安装包的配置，不包含 token。App 退出时清理子进程。

自动测试只覆盖纯逻辑：环境净化、启动参数、NDJSON 分帧、请求必需字段、配置转义、目录/单实例锁、socket 边界及审批队列的撤回规则。尚需通过完整安装包进行真实验证：权限归属、截图、中文输入、前后台操作、授权弹窗、退出与紧急停止、打包签名及公证。编译通过不代表这些系统行为已通过。
