# Windows ARM64 / x64 开发包与 Agent 接入

简体中文 | [English](WINDOWS.en.md) · [返回首页](../README.md)

当前 `com.starroy.computeruse` 的 ARM64 包已在一台 Windows 11 ARM64 虚拟机的**交互式登录桌面**完成限定验收：66 个 Fixture 输入用例、一次真实 Mac Codex 模型回归及授权、断线与退出检查。原生 x64 桌面未验收，完整边界见[验证记录](validation-results.md)。Computer Use 在 Windows 内运行，本机 Agent 可使用 stdio MCP；Mac 可通过 SSH 本地转发访问 Windows HTTP MCP。HTTP 只监听 Windows 的 `127.0.0.1:47631`，无需开放该端口到局域网。便携包是开发产物，不是已签名安装器；UAC 安全桌面和高完整性应用不在支持范围内。

## Windows 构建与启动

如果拿到预构建的便携 ZIP，请在对应架构的 Windows 11 上完整解压，再从解压目录运行 `ComputerUse.WindowsHost.exe`；不要只复制单个 EXE。预构建包已内置运行组件，无需安装下段所述的构建工具。首次运行需在当前用户的交互登录桌面，后续配对命令也在该目录执行。该包不包含别人的配对凭据，需要由使用者在本机新建并批准自己的配对。

在 Windows 11 x64 或 ARM64 上安装 .NET 10 SDK、Node 24+ 和 pnpm 10，获取本项目后于 PowerShell 中运行。ARM64 主机也可交叉打包 x64：.NET 发布目标、内置 Node/Cua 和 pnpm 原生可选依赖都按 x64 选择，再借助 Windows 11 的 x64 模拟运行包内检查。以 x64 包为例；构建 ARM64 包时将 `x64` 改为 `arm64`，包目录改为 `Computer Use Windows ARM64`。x64 主机不能构建 ARM64 包。

```powershell
pnpm install --frozen-lockfile
pnpm check
node scripts/package-windows.mjs --arch x64
node scripts/package-windows.mjs --arch x64 --verify-only
& '.\artifacts\Computer Use Windows x64\ComputerUse.WindowsHost.exe'
```

省略 `--arch` 时默认使用当前 Node 的架构。打包脚本从官方来源下载对应架构的固定 Node 24.21.0 与 Cua Driver 0.28.2 包，同时核对官方清单和固定 SHA-256；在隔离目录按锁文件安装该架构的生产依赖。它检查托盘程序、Node、驱动与原生 SDK 的架构，实际加载 SDK，并保留 Node、Cua 与项目的许可文件。包内 CLI 为 `bin\node.exe runtime\cli.js`，无需全局 Node。退出托盘会停止服务和输入；便携包运行时不要覆盖。x64 构建和静态校验通过后，还需在 x64 桌面验证配对、截图与输入，才能视作 x64 验收。

## Windows 本机 Agent：stdio MCP

打开希望控制的普通权限应用，用其**完整可执行文件路径**配对。以下测试程序路径是占位符，须替换为自己的测试应用路径。本节与后面的 Mac 远程接入是两种选择，无需都做。

```powershell
Set-Location '.\artifacts\Computer Use Windows x64' # 预构建 ZIP：直接在解压目录执行后续命令
& .\bin\node.exe .\runtime\cli.js pair --profile codex --name 'Codex' --app 'C:\path\to\ComputerUseFixture.exe'
```

配对和前台授权请求须在 60 秒内处理。过期或失效后弹窗自动关闭，排队的失效请求不会再次弹出。点击“是”仅提交决定，宿主收到运行时确认后才显示“已批准请求”；未授权时需由 Agent 发起新请求。关闭弹窗或按默认按钮均为拒绝。

在托盘批准配对，然后运行：

```powershell
& .\bin\node.exe .\runtime\cli.js doctor --profile codex
& .\bin\node.exe .\runtime\cli.js targets --profile codex
& .\bin\node.exe .\runtime\cli.js config codex --profile codex
```

将输出添加到 Windows 用户的 `~/.codex/config.toml` 或受信任项目的 `.codex/config.toml`，重新加载客户端配置后按[首页的只读任务](../README.md#接入-agent-与首次观察)验证。配置不含凭据，不需要启用 HTTP 或 SSH。本机 Windows Codex 的真实模型验证仍待完成；已有跨机器实测使用 Mac Codex。其他客户端可将 `config codex` 换为 `config stdio` 获取通用 JSON。

## Mac 远程接入：Windows 配对与凭据

以下从仓库根目录进入便携包目录；如果已在包目录中，跳过 `Set-Location`。另建远程客户端 profile，并在托盘批准：

```powershell
Set-Location '.\artifacts\Computer Use Windows x64' # 使用预构建 ZIP 时跳过此行，直接在解压目录执行
& .\bin\node.exe .\runtime\cli.js pair --profile mac-codex --name 'Mac Codex' --app 'C:\path\to\ComputerUseFixture.exe'
& .\bin\node.exe .\runtime\cli.js doctor --profile mac-codex
& .\bin\node.exe .\runtime\cli.js targets --profile mac-codex
```

在 Windows 托盘中批准配对。只批准明确的应用路径；撤销后 Mac 的旧凭据应立即失效。Windows 宿主及 CLI 的管道、凭据和日志位于当前用户的 `%LOCALAPPDATA%\Computer Use`，不要从服务账号或未登录的后台会话启动宿主。

在托盘中启用本机 HTTP MCP，然后生成供 Mac 使用的私有配置文件：

```powershell
& .\bin\node.exe .\runtime\cli.js config http --profile mac-codex --out "$env:LOCALAPPDATA\Computer Use\mac-codex-mcp.json"
```

该 JSON **含 Bearer 凭据**，只通过可信的 SSH/SFTP 通道转移到 Mac，不放入仓库、聊天或共享文件夹。为连接配置 Windows OpenSSH Server 和密钥登录时，参照[微软安装说明](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)及[密钥说明](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)。Mac 上可先执行 `install -d -m 700 "$HOME/.config/computer-use"`，再用 `sftp -i "$HOME/.ssh/computer_use_windows_ed25519" '<Windows 用户>@<VM IP>'`（或换成自己授权的密钥）：在 SFTP 提示符执行 `cd "AppData/Local/Computer Use"`、`lcd /Users/<Mac 用户>/.config/computer-use`、`get mac-codex-mcp.json windows-http.json`。传输后执行 `chmod 600 "$HOME/.config/computer-use/windows-http.json"`。此后可以删除 Windows 中为传输而导出的 JSON；配对凭据本身仍保存在宿主私有目录。

## Mac SSH 隧道与 Codex

在 Mac 终端保持下列隧道运行，将 `<Windows 用户>` 和 `<VM IP>` 替换为实际值；首次连接先核对 SSH 主机指纹：

```sh
ssh -i "$HOME/.ssh/computer_use_windows_ed25519" \
  -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -N \
  -L 127.0.0.1:47631:127.0.0.1:47631 '<Windows 用户>@<VM IP>'
```

Mac 的 47631 端口若已被占用，请先关闭占用它的本机服务。隧道建立后，Mac 上 `http://127.0.0.1:47631/mcp` 才会到达 Windows。不要使用 `-g` 或将转发绑定到 `0.0.0.0`。

将以下配置加入 Mac 的用户级 `~/.codex/config.toml` 或受信任项目的 `.codex/config.toml`。预构建 ZIP 的 `helpers/windows-remote-auth.mjs` 可复制到 Mac 的 `~/.config/computer-use/`；源码构建也可直接使用仓库 `scripts/windows-remote-auth.mjs`。把 helper 命令中的三个绝对路径换成 Mac 的实际 Node、helper 脚本和私有 JSON 路径；`http_headers_helper` 是一条本地命令，输出 `{"Authorization":"Bearer …"}`，配置本身不含令牌。Codex 仅在**本地执行环境**支持该 helper，详见[官方 MCP 配置](https://learn.chatgpt.com/docs/extend/mcp)。

```toml
[mcp_servers.computer-use-windows]
url = "http://127.0.0.1:47631/mcp"
http_headers_helper = "/opt/homebrew/bin/node /Users/yourname/.config/computer-use/windows-remote-auth.mjs /Users/yourname/.config/computer-use/windows-http.json"
startup_timeout_sec = 30
tool_timeout_sec = 90
```

重启 Codex 并查看 `/mcp` 或 `codex mcp list`。实际调用按 `doctor → targets → session_open → observe → act → observe → session_close`；每次动作带 UUID `requestId` 和最新 `snapshotId`。跨隧道断线时，未收到确定结果的动作视为 `unknown`，重连后先查 `action_status` 并重新观察，不能自动重放。目标截图会发送给所选 Agent；默认日志不保存截图和输入。

非交互 `codex exec` 若在 `targets` 报 `MCP tool call requires approval, but approval policy is never`，可在**仅用于已配对测试程序的临时配置**中为此服务器加 `default_tools_approval_mode = "approve"`；不要因此改动用户级配置。该设置只处理 Codex 的 MCP 工具审批，Windows 托盘的配对和前台批准仍然生效。交互运行时可按提示批准工具调用。Codex 支持的字段见[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 故障排查

- `doctor` 无法连接：确认 Windows 托盘已启动、在登录用户桌面运行，驱动与宿主版本匹配。
- Codex 连接拒绝：检查 Windows 托盘是否启用 HTTP、SSH 隧道是否仍在运行，以及 Mac 47631 端口是否由隧道占用。不要为排错开放 Windows MCP 防火墙端口。
- `targets` 被 MCP 工具审批阻止：检查当前 Codex 审批策略；非交互专用测试可按上文只为临时服务器配置工具审批。
- `401`：确认 Mac 私有 JSON 来自当前配对、文件权限为 `0600`，托盘中未撤销该客户端；在 Mac 直接运行 helper 应只输出一个 JSON header 对象，勿将输出粘贴到日志或聊天。
- 配对程序不可见或动作拒绝：确认可执行文件路径、窗口所属进程及应用权限级别。后台动作不能送达时，可显式打开前台会话（配对时已授予，不再逐次批准）；不会自动切换。

自动化测试和真实 Windows 虚拟机结果分别记在 [验证记录](validation-results.md)；静态打包检查不代表截图和输入已通过实测。

授权窗口回归测试可在 Windows 交互桌面运行 `dotnet run --project validation/windows/ComputerUse.WindowsHostTests`。该程序使用隔离的运行时替身，覆盖超时关闭、过期队列、确认结果、默认拒绝及停止清理，不授予真实权限或操作其他应用；运行时授权语义由 `pnpm test` 覆盖。

Windows 元素定向输入与点击始终使用后台辅助功能路径，包括已批准的前台会话；拒绝或不确定时不自动切换或重发。无元素 ID 的前台长文本、画布和终端不在完整性保证范围内。具体动作语义见[使用说明](USAGE.md)。
