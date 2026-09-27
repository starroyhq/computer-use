# Computer Use

简体中文 | [English](README.en.md)

让现有 AI Agent 通过 MCP 或 CLI 观察和操作已授权的应用窗口。基于 [Cua Driver](https://github.com/trycua/cua) 和 [Playwright](https://github.com/microsoft/playwright)，提供 macOS 菜单栏 App 和 Windows 托盘程序，由你选择的 Agent 负责理解任务和规划操作。

**开发预览，当前从源码构建。** 尚未提供正式安装器或公开发布包，已验证范围见下表。

## 主要功能

- **桌面操作**：窗口截图、辅助功能元素、点击、输入、快捷键、滚动和直线拖拽；支持程度取决于平台、应用和动作。
- **Agent 接入**：stdio MCP、可选本机 HTTP MCP，以及可独立使用的 CLI。
- **配对授权**：明确选择可控制的应用，前台会话单独批准；支持暂停、撤销和紧急停止。
- **动作记录**：每次操作使用新快照，通过请求 ID 查询结果；不自动重放结果不确定的动作。
- **独立浏览器**：通过 Playwright 操作单独的 headless Chromium，不继承日常浏览器的登录状态。

Cua Driver 提供底层桌面截图、辅助功能与输入能力，Playwright 提供浏览器操作，MCP 通信使用官方 TypeScript SDK。本项目实现宿主、授权、会话与快照管理、动作去重和结果记录、CLI/MCP 接入、后端适配与打包。上游许可见 [第三方声明](THIRD_PARTY_NOTICES.md)。

## 平台状态

| 平台 | 构建与接入 | 验证范围 |
|---|---|---|
| macOS Apple Silicon | macOS 14+ 构建目标；菜单栏 App、本机 CLI / MCP | 旧标识版本完成 AppKit Fixture 与 Codex 桌面实测；新标识已通过构建、签名校验，桌面回归待完成 |
| Windows 11 ARM64 | 托盘便携开发包；本机 CLI / MCP，Mac 可经 SSH 连接 | 旧标识版本在一台虚拟机完成 Win32 / WinForms / WPF Fixture 和 Mac Codex 实测；当前源码需重新打包回归 |
| Windows 11 x64 | 独立 x64 构建目标 | 旧开发包在 ARM64 系统的 x64 模拟环境通过组件校验；原生 x64 桌面未验收 |
| macOS Intel / Linux | 暂无本项目宿主交付 | 未验证 |

应用标识现为 `com.starroy.computeruse`。上述桌面实测来自更名前的开发版本，不能代替当前版本验收。测试方法、结果及未覆盖项见 [验证记录](docs/validation-results.md)。

## 快速开始：从源码构建

先安装 Git、Node 24+ 和 pnpm 10，然后获取源码：

```sh
git clone https://github.com/starroyhq/computer-use.git
cd computer-use
pnpm install --frozen-lockfile
```

### macOS

另需 Apple Silicon Mac 和 Xcode/Swift 工具链。在仓库根目录运行：

```sh
pnpm package:app
open 'artifacts/Computer Use.app'
```

在 App 中请求“辅助功能”和“屏幕录制”权限，授权给 Computer Use 后完全退出并重新打开。默认构建使用 ad-hoc 开发签名，未经公证；重新签名或更换应用标识后可能需要重新授权。运行中不要覆盖 App。

从菜单栏选择“安装 CLI 到 ~/.local/bin”，然后在当前终端验证入口：

```sh
export PATH="$HOME/.local/bin:$PATH"
command -v computer-use
computer-use --help
```

这条 `export` 只影响当前终端；新终端需要相同的 PATH 设置。也可直接调用 `artifacts/Computer Use.app/Contents/Resources/bin/computer-use`。

打开 TextEdit 并新建一个空白测试文档，为 Agent 配对：

```sh
computer-use pair --profile codex --name 'Codex' --app com.apple.TextEdit
```

在 App 中批准后，检查连接并生成配置：

```sh
computer-use doctor --profile codex
computer-use targets --profile codex
computer-use config codex --profile codex
```

`targets` 应包含已打开的测试窗口。未安装 Chromium 时，`doctor` 的浏览器项可以显示不可用；桌面接入应检查桌面后端。接着按下节导入配置。

### Windows 11

另需 .NET 10 SDK。在 Windows 仓库根目录的 PowerShell 中运行（ARM64 将 `x64` 改为 `arm64`，产物目录改为 `ARM64`）：

```powershell
node scripts/package-windows.mjs --arch x64
& '.\artifacts\Computer Use Windows x64\ComputerUse.WindowsHost.exe'
```

宿主应在当前交互登录桌面运行。便携包包含 Node、驱动和 .NET 运行时；构建所需 SDK 与最终运行所需组件不同。

按 [Windows 指南](docs/WINDOWS.md)完成应用路径配对，再选择本机 Agent 的 stdio MCP，或 Mac 经 SSH 隧道连接 Windows HTTP MCP。**Windows 使用可执行文件完整路径配对，不能照抄 macOS 的 Bundle ID。**

## 接入 Agent 与首次观察

将 `config codex` 输出的 TOML 片段添加到 Codex 用户级 `~/.codex/config.toml`，或受信任项目的 `.codex/config.toml`。配置含绝对启动路径和 profile，不含凭据；项目不会自动修改 Agent 配置。详见 [Codex MCP 配置说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

重新加载客户端的 MCP 配置后，可以先给 Agent 一个只读任务：

> 使用 computer-use 检查连接，列出已授权窗口，打开测试窗口的会话，获取截图并描述看到的内容，然后关闭会话。此次不要点击或输入。

正常结果应包括真实窗口截图及描述。先确认这一过程，再在一次性测试文档中尝试输入和点击。其他 Agent 可对已配对 profile 运行 `computer-use config stdio --profile codex` 获取通用 JSON 配置；其他客户端的真实模型接入尚待验证。

需要手动调用 CLI、安装独立浏览器或理解动作参数时，见 [使用说明](docs/USAGE.md) 和配套 [CLI Skill](skills/computer-use/SKILL.md)。

## 权限与限制

- Agent 只能通过本项目接口访问已配对目标；前台会话需要本地 App 批准。后台能力依赖实际控件，不保证完全不影响焦点。
- 不确定动作先查询 `action_status` 并观察，不直接重放。`executed` 不代表任务成功，仍需核对实际界面或输出文件。
- HTTP 默认关闭，只监听 `127.0.0.1:47631`。跨机器接入通过手动 SSH 隧道，不直接开放 MCP 到局域网或公网。
- 默认动作日志不保存截图、输入、URL 和窗口标题；CLI 截图会留在本机，需要自行清理。发给云端 Agent 的截图与结果由所选模型服务处理。
- 所有获准使用独立浏览器的客户端共享浏览器空间；本地授权不隔离同一系统用户的恶意进程。
- Windows 提权窗口、UAC 安全桌面、画布和终端长文本不在已验证范围内。平台动作差异及更多限制见 [使用说明](docs/USAGE.md)。

## 开发与文档

```sh
pnpm check
pnpm native:test # 仅 macOS
```

浏览器集成测试需要匹配的 Chromium；缺少时会跳过相应测试，不能计作通过。可用 `pnpm exec playwright install chromium` 安装开发测试所需组件。

- [使用说明 / Usage](docs/USAGE.md)：CLI、动作语义、浏览器与排错
- [Windows 接入](docs/WINDOWS.md) / [Windows guide](docs/WINDOWS.en.md)
- [架构](docs/ARCHITECTURE.md)、[构建与打包](scripts/README.md)
- [验证方法](docs/VALIDATION.md)、[验证结果](docs/validation-results.md)、[路线图](docs/ROADMAP.md)

## 许可与致谢

原创源码和文档采用 [MIT](LICENSE)，版权署名为 Starroy，见 [NOTICE](NOTICE)。感谢 Cua、Playwright、MCP SDK 及其他上游项目；依赖保留各自许可证，见 [第三方声明](THIRD_PARTY_NOTICES.md)。
