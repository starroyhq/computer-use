# Computer Use

基于 [Cua Driver](https://github.com/trycua/cua) 和 [Playwright](https://github.com/microsoft/playwright)，为现有 AI Agent 提供带配对授权与会话管理的跨平台电脑操作运行时。macOS 提供菜单栏 App；Windows ARM64 / x64 开发版提供托盘宿主。两者复用 CLI＋Skill、stdio MCP、本机 HTTP MCP，以及权限、会话、调度与结果记录。

Cua Driver 提供底层桌面截图、辅助功能与输入能力，Playwright 提供受控浏览器操作，MCP 通信使用官方 TypeScript SDK。本项目实现原生宿主、配对与撤销、会话和快照管理、动作去重与结果记录、CLI/MCP 接入、后端适配及打包；上游依赖及其许可证见 [第三方声明](THIRD_PARTY_NOTICES.md)。

**当前为开发预览。** 已实现的接口、自动化测试与真实软件验收分别列在 [验证说明](docs/VALIDATION.md)。构建成功不等于已通过 Blender、Final Cut Pro 或后台人机共存验收。

## 构建与运行

开发要求：Apple Silicon Mac、Xcode/Swift、Node 24+、pnpm 10。App 的构建目标为 macOS 14+；仅在实际验证过的系统上声明兼容。构建过程中下载固定版本的 Cua Driver 和 Node，核对 SHA-256。终端不需要系统桌面权限；权限应授予安装包中的 App。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm native:test
pnpm package:app
open 'artifacts/Computer Use.app'
```

启动后会显示状态与权限窗口，选择“请求系统权限”，在系统设置中允许辅助功能和屏幕录制，再完全退出并重新打开 App。关闭窗口后仍驻留菜单栏，再次打开 App 可重新显示窗口。菜单栏中选择“安装 CLI”可在 `~/.local/bin` 建立链接，不覆盖已有命令；也可以直接使用 App 内的 CLI：

```sh
'artifacts/Computer Use.app/Contents/Resources/bin/computer-use' --help
```

默认打包使用 ad-hoc 开发签名，**不是经过公证的公众发行包**。Developer ID 签名、签名后实测和公证是独立分发门槛，见 [打包说明](scripts/README.md)。运行中不要覆盖 App；重新构建后应退出旧实例再打开。

## CLI：无需 MCP

先打开目标应用。以下以专用 TextEdit 测试文档为例；本工具不自动取得所有应用权限：

```sh
computer-use pair --name 'My Agent' --app com.apple.TextEdit
computer-use doctor
computer-use targets
computer-use schema act
```

配对会在菜单栏 App 中展示请求的应用清单。接受后，CLI 将凭据存入权限为 0600 的本地文件，不打印密钥。不同客户端使用不同 `--profile` 配对；授权可以在 App 中撤销。

```sh
computer-use session_open --json '{"targetId":"从 targets 返回的 ID"}'
computer-use observe --json '{"sessionId":"从 session_open 返回的 ID"}'
computer-use act --input request.json
computer-use session_close --json '{"sessionId":"会话 ID"}'
```

`request.json` 使用 `schema act` 中的参数。CLI 可自动添加 `requestId`；连接中断时返回该 ID，以便查询 `action_status`。截图以私有文件路径返回。每次动作消费一个快照，下一次动作前重新 `observe`。`executed` 只表示执行阶段结束；只有显式结果条件通过才返回 `verified`。

配套 [CLI Skill](skills/computer-use/SKILL.md) 随 App 打包，也可按 Agent 的安装方式放入其 skills 目录。Skill 是指导，不是权限执行层。

## MCP

Codex：先为这个 Agent 建立独立配对，在 App 中批准明确的应用清单，然后生成配置：

```sh
computer-use pair --profile codex --name 'Codex' --app com.apple.TextEdit
computer-use config codex --profile codex
```

将输出的 TOML 片段添加到 Codex 的用户级 `~/.codex/config.toml`，或受信任项目的 `.codex/config.toml`，然后重启客户端并检查 MCP 工具。配置只含本机启动路径和 profile 名称；凭据仍由本机 CLI 私下读取，不写入 Agent 配置。Codex 的 [MCP 配置说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) 列出这两种位置。项目不会自动编辑 Agent 配置。客户端通过 `doctor → targets → session_open → observe → act → observe → session_close` 使用工具；`act` 需要 UUID `requestId` 和当前快照 ID，截图作为 MCP 图片内容返回。遇到不确定结果时先查 `action_status` 并观察实际界面，不直接重放。

其他接受通用 JSON 配置的 Agent 可运行 `computer-use config stdio --profile <名称>`，或使用 App 的复制配置菜单。服务命令为 `computer-use mcp stdio`；不要把 Agent 指向底层 Cua 原始端口。

HTTP：在 App 中主动开启，地址固定为 `http://127.0.0.1:47631/mcp`。使用 `computer-use config http --out private-mcp.json` 生成带凭据的私有文件；不要提交或分享该文件。服务器只监听 IPv4 回环地址，检查 Host、Origin 和独立客户端凭据；不支持云端直接连接，不提供公网监听选项。

两种 MCP 使用官方 SDK v2，返回结构化结果及图片内容。协议自动化测试和“真实 Agent 已接入”是不同验收项；实际客户端测试范围见验证记录。

### 从 Mac 控制 Windows 虚拟机

Windows ARM64 / x64 便携开发包在交互桌面运行，HTTP MCP 仍只监听 Windows 回环地址。Mac 通过 SSH 转发 `127.0.0.1:47631`，再以本地 Codex HTTP MCP 连接；Mac 的私有凭据由 `http_headers_helper` 读取，不写进 Codex 配置。构建、配对、凭据安全传输与隧道命令见 [Windows 接入说明](docs/WINDOWS.md)。ARM64 已完成桌面实测，x64 包已构建并校验，但截图与输入仍需在原生 x64 Windows 上验收。

## 受控浏览器

先显式安装匹配组件：

```sh
computer-use browser install
computer-use pair --profile browser --name 'Browser Agent' --browser
computer-use targets --profile browser
```

首次发现浏览器目标会创建一个独立、空白的 **headless Chromium**。通过截图反馈工作，不打开用户日常浏览器或继承登录状态。所有获准使用受控浏览器的客户端共享此运行时中的浏览器空间；该授权不适用于互不信任的用户。只支持 HTTP(S) 与 `about:blank` 导航，下载落在独立文件夹。

## 能力与边界

- 桌面固定 Cua Driver 0.28.2；观察同时提供 AX 元素和窗口截图。后台支持取决于实际应用与动作。
- 坐标使用快照图片像素；窗口移动、几何变化或元素过期会拒绝旧引用，不能检测一切视觉变化。
- 首版拖拽为两端点直线完整手势；桌面拖拽要求显式前台会话。滚动单位为行/页；浏览器一行定义为 40 CSS 像素。
- `type` 插入文字；需要替换时先执行明确的全选动作。浏览器 JS 对话框自动取消，不代表确认或接受。
- Windows 常规文本框若指定最新快照的 `elementId`，即使会话已批准前台操作，文字也走可读回的后台辅助功能路径；拒绝或不确定时不自动切换或重发。无 `elementId` 的前台长文本和画布、终端输入尚未获得完整性保证。
- Windows 带 `elementId` 的点击也走后台辅助功能路径；截图坐标点击在前台会话仍走前台指针。驱动拒绝或结果不确定时不自动换路径或重发。
- 会话默认独占，两分钟无活动后过期；快照有效期 30 秒。修改动作串行，完整手势不交错。
- 暂停阻止新动作；紧急停止取消工作并关闭执行器。输入中断或超时导致的不确定结果会停止执行；驱动已完成派发但无法确认效果时，保留不确定状态并允许只读检查。重启后不重放动作。
- 观察返回 `elementsComplete`。当前后端仅返回部分元素树，不能用“没列出”来验证元素不存在；此类负向条件会被明确拒绝。
- 默认日志和动作记录不保存截图、输入、URL 或窗口标题。CLI 截图在本地保留，需主动清理。发给云端 Agent 的结果仍由用户选择的模型服务处理。
- 本地授权不是针对同一系统用户的恶意进程隔离，也无法约束 Agent 自己拥有的终端或其他工具。

## 维护与许可

运行 `pnpm check`、`pnpm native:test`；有匹配 Chromium 时会运行真实浏览器测试。源码分为原生宿主、运行时/接口、桌面/浏览器后端和验证工具；设计与实施状态见 [架构记录](docs/ARCHITECTURE.md) 和 [阶段清单](docs/ROADMAP.md)。

本项目原创源码和文档采用 [MIT](LICENSE)，版权署名为 Starroy，见 [NOTICE](NOTICE)。允许商业使用、修改和再分发，须在软件副本或实质性部分中保留版权及许可声明；完整条款以 LICENSE 为准。Cua Driver、Playwright、Node.js、.NET 等依赖保留各自许可证，见 [第三方声明](THIRD_PARTY_NOTICES.md)。

English quick start: [README.en.md](README.en.md).
