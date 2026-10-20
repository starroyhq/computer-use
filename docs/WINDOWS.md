# Windows ARM64 / x64：安装与 Agent 接入

简体中文 | [English](WINDOWS.en.md) · [返回首页](../README.md)

当前 `com.starroy.computeruse` 的 ARM64 本地安装包于 2026-10-10 在一台 Windows 11 ARM64 虚拟机的**交互式登录桌面**完成限定验收：一次全应用配对、两个 Fixture 的三个窗口、7 轮后台输入及暂停、恢复、紧停、重启、撤销和覆盖安装。早期 66 个 Fixture 输入用例与一次真实 Mac Codex 模型回归保留为历史记录；原生 x64 桌面未验收，完整边界见[验证记录](validation-results.md)。Computer Use 在 Windows 内运行，本机 Agent 可使用 stdio MCP；Mac 可通过 SSH 本地转发访问 Windows HTTP MCP。HTTP 只监听 Windows 的 `127.0.0.1:47631`，无需开放该端口到局域网。安装程序与便携包都未签名；UAC 安全桌面和高完整性应用不在支持范围内。

从 v0.6.0 起，桌面兼容目标为 Windows 10 1809（build 17763）及之后版本、Windows 11，提供 x64 与 ARM64 包。安装器最低版本与 WinForms 的 `net10.0-windows10.0.17763.0` 目标对齐；**Windows 10 尚无实机验收**，安装门槛不等于桌面功能已通过测试。

独立浏览器另有边界：当前 Playwright 后端的[上游要求为 Windows 11 或更高版本](https://playwright.dev/docs/intro#system-requirements)。Windows 10 ARM64 没有 x64 模拟，不能运行此后端所用的 x64 Chromium。桌面全应用授权不包含独立浏览器，Windows 10 桌面兼容目标也不代表独立浏览器兼容。

## 安装与卸载

从 [v0.10.1 Release](https://github.com/starroyhq/computer-use/releases/tag/v0.10.1) 下载对应架构的 `computer-use-0.10.1-windows-<arm64|x64>-setup.exe`。如需便携版，下载 `computer-use-0.10.1-windows-<arm64|x64>.zip`，完整解压后从目录中运行 `ComputerUse.WindowsHost.exe`；不要只复制单个 EXE。安装程序和 ZIP 各附 `.sha256` 校验文件，每个平台另附 JSON 元数据。

v0.6.0 开始提供安装程序，v0.5.0 及更早版本只提供便携包。本地 ARM64 覆盖安装已验收，但从真实发布下载到完成安装版升级的完整流程、原生 x64 安装和 SmartScreen 表现仍待验证，见[验证记录](validation-results.md#windows-安装版全应用授权与后台控制验收2026-10-10)。

安装向导按当前用户安装，不需要管理员权限，默认位置为 `%LOCALAPPDATA%\Programs\Computer Use`；首次安装可以换目录，升级沿用原目录。向导会建立开始菜单快捷方式，桌面快捷方式可选，完成页可直接启动；静默安装不会自动运行完成页启动项。开始安装前，安装程序用 `ComputerUse.WindowsHost.exe --quit` 让当前会话里正在运行的托盘程序（安装版或便携版）停止服务并退出；v0.5.0 及更早的版本不支持 `--quit`，向导会提示先从托盘菜单退出再重试。

Windows 安装器和便携包仍未签名，SmartScreen 或 Smart App Control（SAC）可能根据签名、信誉和系统策略提示或阻止运行。新版图标及按需启动不会消除这类限制；macOS 的 Developer ID、Apple 公证不提供 Windows 签名。遇到阻止时保留系统提示原文，按本机或组织策略处理，不把重新启动、关闭防护或更改 Agent 工具审批当作通用修复。

在系统“设置 → 应用”中卸载。卸载程序先让托盘程序停止服务并退出，再删除安装目录和指向它的登录启动项；`%LOCALAPPDATA%\Computer Use` 里的配对凭据、设置与日志保留，不再需要时可手动删除。

安装版的 CLI 为安装目录下的 `bin\node.exe runtime\cli.js`，设置窗口“通用”页可复制完整命令。下文的命令都在包目录中执行；安装版先进入安装目录：

```powershell
Set-Location "$env:LOCALAPPDATA\Programs\Computer Use"
```

从便携版改用安装版时，程序位置会变，需要在新位置重新生成 Agent 配置；配对凭据不变。

无论哪种方式，预构建包都已内置运行组件，无需安装下节所述的构建工具。首次运行需在当前用户的交互登录桌面。包内不含别人的配对凭据，需要由使用者在本机新建并批准自己的配对。

## 复制安装提示词接入 Agent

v0.7.0 的 App“接入”页默认提供“复制安装提示词”。点击后把提示词粘贴给你的 Agent，由它安装 Skill 并完成连接。App 只生成并复制提示词，不替 Agent 安装 Skill 或写入客户端配置；生成提示词不发起配对、不启动服务。系统权限和首次客户端授权仍须由你在本机批准，已有 profile 不必重复配对。

“高级接入”默认收起；展开后可选择已有 profile 或输入新名称、复制配对命令与 stdio MCP 配置，以及启用本机 HTTP MCP。默认 profile 为 `default`，安装提示词、配对命令与 MCP 配置共用所选名称，复制内容不包含配对凭据。在包目录中也可用 `bin\node.exe runtime\cli.js skill prompt --profile default` 输出同样的安装提示词。

## 按需启动与暂停保护

从 v0.6.1 起，完整 Windows 包支持按需启动：用同包 `bin\node.exe runtime\cli.js` 的 CLI 或 stdio MCP 访问默认管道时，先检查管道是否可连接；不可达时调用同包 Host 的启动检查，仅在没有已运行宿主且无暂停/紧停阻止时启动，等待就绪后发送原 RPC。MCP `initialize` 和 `tools/list` 不连接运行时、不启动托盘，首次实际工具调用才需要宿主。首次配对仍需用户在托盘批准，自动启动不创建授权。

启动只适用于当前用户的交互式登录桌面，不适用于服务账号或 Session 0。源码运行、自定义 `--socket`、HTTP 和 SSH 隧道不使用这一自动启动路径。v0.7.0 的 macOS 完整 App 也支持同包受控启动，缺少系统权限时返回明确错误，需用户打开 App 处理；两平台均不会从 PATH 或其他安装目录搜索宿主。移动安装目录后仍需重新生成 Agent 配置。

自 v0.7.0 起，Windows 与 macOS 均将暂停和紧停写入当前用户私有目录的 `host-state.json`。退出、重新打开 App、登录及更新重开都保留阻止状态，只有用户在本机 App 内点击“恢复／重启服务”才能解除；再次打开只显示状态，不自动恢复。启动 helper 不重启已运行但失败或停止的 Host；v0.7.1 增加下述显式故障恢复命令。就绪前失败不会发送原业务请求；已发送动作的连接失败仍按不确定结果处理，不自动重放。

需要单独检查启动时，在完整安装或便携目录的 PowerShell 中运行：

```powershell
& .\ComputerUse.WindowsHost.exe --ensure-running | Out-String
```

helper 最多等待 35 秒，stdout 只返回一行 JSON；成功为 `{"ok":true,"state":"ready"}` 并退出 0。失败退出非零，包含 `ok: false`、`code` 和 `message`；代码为 `paused`、`stopped`、`failed`、`non_interactive`、`timeout` 或 `launch_failed`。成功要求匹配当前会话和宿主进程身份，并实际探测已公布的管道；仅看到 EXE 进程不算就绪。这一命令不批准配对、不恢复暂停或紧停，也不解除 Windows 系统拦截。

本节说明 v0.7.1 的接口行为；历史本地构建与 VM 验收见[验证记录](validation-results.md)，每版发布产物与 CI 需独立验证。

## Agent 通用故障恢复

每个新的 Agent 对话首次使用时，先读取同包 CLI 的 `--help`，再执行并阅读受支持的 `instructions`；已有 Skill / profile 不替代当前指南。遇到故障先保留不确定动作的原 requestId 并查询 `action_status`，再查看 `preflight --profile NAME`。在已授权任务中，Host 为 `failed`，或桌面动作 unknown 后连接丢失且没有用户停止状态时，可自主执行一次：

```powershell
& .\bin\node.exe .\runtime\cli.js recover --profile NAME
```

`recover` 从 v0.7.1 起可用，只恢复同包默认本地管道的服务故障；源码运行、自定义 `--socket`、远程 HTTP 和 SSH 隧道不支持。它保留现有凭据及授权，不重启健康服务、不重新配对，也不能绕过暂停、紧停、撤销或系统权限。缺少 profile、无效或撤销凭据、用户停止、系统拦截及非交互桌面需本机处理。旧版缺少命令时仍由用户在 App 内处理，不通过删除状态或普通启动绕过。失败、限流或下一步再故障时报告具体原因，不循环恢复。

成功仅表示服务可用，返回 `actionsReplayed: false`、`requiresNewSession: true` 和 `requiresFreshObservation: true`。恢复后补查原 requestId，建立新后台会话并重新观察；旧会话、元素 ID 与快照不能复用。`unknown` 不会因恢复变成成功，不能换 UUID、坐标或等价动作重放；画面没变化不证明输入未送达。`executed` / `unconfirmed` 和过期快照只需重新观察。完整流程见[使用说明](USAGE.md#通用故障恢复--general-fault-recovery)。

本次 Windows 已通过 Host / UI、进程和传输隔离检查，**尚未完成真实 Agent / driver 故障恢复验收**，不把隔离测试当作桌面业务验收。覆盖范围见[故障恢复记录](validation-fault-recovery-20261012.md#windows-隔离验收)。

## 从源码构建与启动

在 Windows x64 或 ARM64 上安装对应架构的 .NET 10 SDK、Node 24+ 和 pnpm 10，获取本项目后于 PowerShell 中运行。Windows 10 ARM64 构建与验证使用原生 ARM64 组件；ARM64 主机交叉打包或验证 x64 包要求 Windows 11（build 22000 起）的 x64 模拟，脚本会在不满足时提前报错。以 x64 包为例；构建 ARM64 包时将 `x64` 改为 `arm64`，包目录改为 `Computer Use Windows ARM64`。x64 主机不能构建 ARM64 包。

```powershell
pnpm install --frozen-lockfile
pnpm check
node scripts/package-windows.mjs --arch x64
node scripts/package-windows.mjs --arch x64 --verify-only
& '.\artifacts\Computer Use Windows x64\ComputerUse.WindowsHost.exe'
```

省略 `--arch` 时默认使用当前 Node 的架构。打包脚本从官方来源下载对应架构的固定 Node 24.21.0 与 Cua Driver 0.28.2 包，同时核对官方清单和固定 SHA-256；在隔离目录按锁文件安装该架构的生产依赖。它检查托盘程序、Node、驱动与原生 SDK 的架构，实际加载 SDK，并保留 Node、Cua 与项目的许可文件。包内 CLI 为 `bin\node.exe runtime\cli.js`，无需全局 Node。退出托盘会停止服务和输入；便携包运行时不要覆盖。x64 构建和静态校验通过后，还需在 x64 桌面验证配对、截图与输入，才能视作 x64 验收。

安装程序由上面校验过的便携目录生成，需要 [Inno Setup](https://jrsoftware.org/isinfo.php) 7.0.2 或更高版本：简体中文从这个版本起才是官方语言，Inno Setup 6 默认不带。脚本在 Program Files 与当前用户的程序目录下依次查找 `Inno Setup 7` 与 `Inno Setup 6` 中带简体中文的 `ISCC.exe`，也可用环境变量 `INNO_SETUP_COMPILER` 指定：

```powershell
node scripts/package-windows-installer.mjs --arch x64
node scripts/package-windows-installer.mjs --arch x64 --verify-only --smoke-test
```

产物为 `artifacts\Computer Use Windows x64 Setup.exe`。`--smoke-test` 静默安装到临时目录，复验安装后的组件、卸载登记与开始菜单快捷方式，再静默卸载。它与正式安装共用同一 AppId，当前用户已安装 Computer Use 时脚本拒绝运行，CI 在一次性 runner 上自动执行。

运行后会打开设置窗口；关闭窗口后服务仍在托盘运行，双击托盘图标或再次运行程序可重新打开。“通用”页可勾选“登录 Windows 时启动”（写入当前用户的启动项，登录后只在托盘运行）；移动便携目录后需重新勾选。

v0.6.1 为 EXE、托盘、设置与授权窗口、安装器加入完整的暖白与深炭色光标图标。图标用于识别程序，不代表文件已经签名，也不改变启动或授权规则。

从 v0.6.0 起，窗口采用状态、客户端、接入、通用、更新、关于 6 区侧栏，紧急停止在每一页常驻。状态页展示服务与配对数量，可进入接入页复制安装提示词；手动配对命令与 stdio 配置位于默认收起的“高级接入”中。客户端页可查看范围并撤销授权。配对窗口分区列出客户端身份、桌面范围、独立浏览器、前台权限、有效期与执行方式，长内容可以滚动，决定按钮保持可见。默认按钮与初始焦点仍为拒绝；关闭窗口或按 Esc 不会授权，超时或请求撤回会关闭提示，允许决定以运行时确认为准。

## 更新

“更新”页每天检查一次 GitHub 正式版（可关闭），下载的文件须与发布里的 SHA-256 校验文件和元数据一致。从 v0.6.0 起支持安装版和便携版两种更新流程；v0.5.0 及更早版本使用便携版流程。从真实发布下载并运行安装程序的完整流程仍待验收。程序所在目录就是当前用户卸载登记里的安装目录时按安装版处理，否则按便携版处理：

- **安装版**：发布包含安装程序时，下载并校验新版本的安装程序，点“运行安装程序”后按向导完成。安装程序先让托盘程序停止服务并退出，再覆盖安装到原目录，完成页可直接启动；在点“安装”之前取消，托盘程序照常运行。
- **便携版**：只下载并校验 ZIP，然后在资源管理器中显示。退出托盘程序，完整解压，用新文件夹替换当前文件夹并保持同一路径，这样 Agent 配置中的绝对路径仍然有效。

已配对的客户端和设置保存在 `%LOCALAPPDATA%\Computer Use`，两种方式都不受影响。已保存的暂停或紧停同样保留，安装完成后启动 App 不会自动恢复服务。

## Windows 本机 Agent：stdio MCP

从 v0.6.0 起，新配对默认首次一次授权所有桌面应用，无需填写应用路径；已有受限客户端不会自动扩大范围。以下是“高级接入”的手动配置流程；本节与后面的 Mac 远程接入是两种选择，无需都做。

```powershell
Set-Location '.\artifacts\Computer Use Windows x64' # 安装版或预构建 ZIP：改为进入安装目录或解压目录
& .\bin\node.exe .\runtime\cli.js pair --profile codex --name 'Codex'
```

配对请求须在 60 秒内处理。过期或失效后弹窗自动关闭，排队的失效请求不会再次弹出。点击“允许”仅提交决定，宿主收到运行时确认后才显示“已批准请求”；未授权时需由 Agent 发起新请求。关闭弹窗或按默认按钮均为拒绝。

在托盘批准“所有应用”后，新应用、新窗口及重启都不需要再次批准。前台权限在配对时一并授予，会话默认后台，使用前台需显式指定，不自动切换。设置中的撤销、菜单中的暂停/恢复与紧急停止继续有效。旧配对保留原范围；改为全应用的步骤见[使用说明](USAGE.md#配对范围--pairing-scope)。

打开一个普通权限的测试应用，然后运行：

```powershell
& .\bin\node.exe .\runtime\cli.js doctor --profile codex
& .\bin\node.exe .\runtime\cli.js targets --profile codex
& .\bin\node.exe .\runtime\cli.js config codex --profile codex
```

将输出添加到 Windows 用户的 `~/.codex/config.toml` 或受信任项目的 `.codex/config.toml`，重新加载客户端配置后按[首页的只读任务](../README.md#接入-agent-与首次观察)验证。配置不含凭据，不需要启用 HTTP 或 SSH。本机 Windows Codex 的真实模型验证仍待完成；已有跨机器实测使用 Mac Codex。其他客户端可将 `config codex` 换为 `config stdio` 获取通用 JSON。

需要只授权 Fixture 的验收 profile 时，另用 `pair --profile fixture --name 'Fixture Agent' --app 'C:\path\to\ComputerUseFixture.exe'`，把占位路径替换为真实完整路径。后续命令和 Agent 配置统一使用 `fixture`；可重复 `--app` 限定多个应用。独立浏览器单独授权，详见[配对范围](USAGE.md#配对范围--pairing-scope)。

## Mac 远程接入：Windows 配对与凭据

以下从仓库根目录进入包目录；如果已在包目录中，跳过 `Set-Location`。另建远程客户端 profile，并在托盘批准：

```powershell
Set-Location '.\artifacts\Computer Use Windows x64' # 安装版或预构建 ZIP：改为进入安装目录或解压目录
& .\bin\node.exe .\runtime\cli.js pair --profile mac-codex --name 'Mac Codex'
& .\bin\node.exe .\runtime\cli.js doctor --profile mac-codex
& .\bin\node.exe .\runtime\cli.js targets --profile mac-codex
```

在 Windows 托盘中批准此客户端的全应用配对；如只做 Fixture 验收，在配对命令加 `--app 'C:\path\to\ComputerUseFixture.exe'` 限定范围。撤销后 Mac 的旧凭据应立即失效。Windows 宿主及 CLI 的管道、凭据和日志位于当前用户的 `%LOCALAPPDATA%\Computer Use`，不要从服务账号或未登录的后台会话启动宿主。

在设置窗口的“接入”页展开“高级接入”，启用本机 HTTP MCP（仅本次运行有效），然后生成供 Mac 使用的私有配置文件：

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

将以下配置加入 Mac 的用户级 `~/.codex/config.toml` 或受信任项目的 `.codex/config.toml`。安装目录或预构建 ZIP 中的 `helpers/windows-remote-auth.mjs` 可复制到 Mac 的 `~/.config/computer-use/`；源码构建也可直接使用仓库 `scripts/windows-remote-auth.mjs`。把 helper 命令中的三个绝对路径换成 Mac 的实际 Node、helper 脚本和私有 JSON 路径；`http_headers_helper` 是一条本地命令，输出 `{"Authorization":"Bearer …"}`，配置本身不含令牌。Codex 仅在**本地执行环境**支持该 helper，详见[官方 MCP 配置](https://learn.chatgpt.com/docs/extend/mcp)。

```toml
[mcp_servers.computer-use-windows]
url = "http://127.0.0.1:47631/mcp"
http_headers_helper = "/opt/homebrew/bin/node /Users/yourname/.config/computer-use/windows-remote-auth.mjs /Users/yourname/.config/computer-use/windows-http.json"
startup_timeout_sec = 30
tool_timeout_sec = 90
```

重启 Codex 并查看 `/mcp` 或 `codex mcp list`。实际调用按 `doctor → targets → session_open → observe → act → observe → session_close`；每次动作带 UUID `requestId` 和最新 `snapshotId`。跨隧道断线时，未收到确定结果的动作视为 `unknown`，重连后先查 `action_status` 并重新观察，不能自动重放。目标截图会发送给所选 Agent；默认日志不保存截图和输入。

非交互 `codex exec` 若在 `targets` 报 `MCP tool call requires approval, but approval policy is never`，可在**仅连接 `--app` 受限 Fixture profile 的临时配置**中为此服务器加 `default_tools_approval_mode = "approve"`；不要因此改动用户级配置。该设置只处理 Codex 的 MCP 工具审批，Windows 托盘的首次配对批准仍然生效。交互运行时可按提示批准工具调用。Codex 支持的字段见[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 故障排查

- `doctor` 无法连接：同包默认管道会按需启动；先保留错误代码，核对完整包、交互登录会话及宿主状态。`paused` / `stopped` 需用户本机恢复或重启；`failed` 查看设置中的失败原因；`non_interactive` 需换到登录桌面。`timeout` / `launch_failed` 再检查系统拦截提示、包内组件及宿主/驱动版本，不删除状态文件或反复启动来解除用户暂停。
- Codex 连接拒绝：检查 Windows 设置窗口“接入”页是否已启用 HTTP、SSH 隧道是否仍在运行，以及 Mac 47631 端口是否由隧道占用。不要为排错开放 Windows MCP 防火墙端口。
- `targets` 被 MCP 工具审批阻止：检查当前 Codex 审批策略；非交互专用测试可按上文只为临时服务器配置工具审批。
- `401`：确认 Mac 私有 JSON 来自当前配对、文件权限为 `0600`，设置窗口“客户端”页中未撤销该客户端；在 Mac 直接运行 helper 应只输出一个 JSON header 对象，勿将输出粘贴到日志或聊天。
- 应用不可见或动作拒绝：检查窗口所属进程及应用权限级别；受限配对另核对完整可执行文件路径，旧配对不会自动获得全应用范围。后台动作不能送达时，可显式打开前台会话（配对时已授予，不再逐次批准）；不会自动切换。

自动化测试和真实 Windows 虚拟机结果分别记在 [验证记录](validation-results.md)；静态打包检查不代表截图和输入已通过实测。

授权窗口与设置窗口回归测试可在 Windows 交互桌面运行 `dotnet run --project validation/windows/ComputerUse.WindowsHostTests`。默认测试使用隔离的假后端，覆盖超时关闭、请求撤回、过期队列、确认结果、默认拒绝、停止清理、托盘偏好存储、6 区侧栏与客户端列表、安装版与便携版的更新操作，并检查中英文在正常和最小窗口尺寸下的布局及常驻紧急停止。它不授予真实权限或操作其他应用；运行时授权语义由 `pnpm test` 覆盖。

加 `-- --screenshots <目录>` 会保存中英文的全部 6 页、安装版更新状态、客户端/接入/更新的窄窗口，以及全应用与多路径受限配对窗口 PNG；这些截图使用模拟数据，不构成 Windows 10 或桌面输入验收。加 `-- --live-update <旧版本便携包目录>` 则通过该包的 CLI 联网检查并下载真实的最新发布（发布带安装程序时也下载校验安装程序；需要网络）。运行方式见[窗口测试说明](../validation/windows/README.md)。

Windows 元素定向输入与点击始终使用后台辅助功能路径，包括已批准的前台会话；拒绝或不确定时不自动切换或重发。无元素 ID 的前台长文本、画布和终端不在完整性保证范围内。具体动作语义见[使用说明](USAGE.md)。
