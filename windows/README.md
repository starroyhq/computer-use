# Windows 托盘宿主

`ComputerUse.WindowsHost` 是面向 Windows 10 / 11 ARM64 / x64 的交互式用户程序。当前源码的安装门槛为 Windows 10 1809（build 17763），与 `net10.0-windows10.0.17763.0` 目标对齐；这是兼容目标，尚无 Windows 10 实机验收。已有验收仍限于一台 Windows 11 ARM64 虚拟机，原生 x64 桌面也待验收；v0.5.0 的历史发布仅提供 Windows 11 便携 ZIP；v0.6.0 提供 ARM64 / x64 便携 ZIP 和 `-setup.exe` 安装器，历史验收范围不因此扩大。具体范围见[验证记录](../docs/validation-results.md)。

宿主从包根目录（便携目录或安装目录）启动 `bin/node.exe runtime/host.js --windows --driver-binary bin/cua-driver.exe --data-dir <用户 LocalAppData>`，由 Node/Cua 的私有 worker 操作桌面；托盘不开放原始驱动端口。

宿主创建仅当前用户可连接的随机命名管道，将完整管道名写入 `%LOCALAPPDATA%\Computer Use\runtime-pipe.json` 的 `pipeName` 字段。目录与发现文件使用受保护的当前用户 ACL，宿主退出时只移除自己写入的发现文件。管道每连接接收一条既有 `{version:1,id,token?,method,params}` RPC；宿主改用内部请求 ID 将其发给 Node stdin 的 `rpc_request`，把 Node stdout 的 `rpc_response` 改回调用者 ID。请求与响应上限均为 32 MiB。动作通道断开或超时返回 `unknown_outcome`，宿主不重放动作。

普通 Node 宿主命令和配对请求沿用 macOS 语义。托盘菜单只保留设置、暂停/恢复、紧急停止、重新启动、有新版本时的更新项、检查更新和退出；双击托盘图标打开设置窗口。设置窗口（`SettingsForm`）采用 6 区侧栏：状态、客户端、接入、通用、更新、关于。紧急停止常驻侧栏，在每一页均可操作；状态页展示服务和配对数量，并可进入接入页复制配对命令与 stdio 配置。客户端页列出授权范围并提供撤销确认；CLI 管道诊断和 HTTP 接入选项分别收在状态页、接入页的展开区。通用页保留登录时启动、CLI 命令与语言说明。界面文案在 `L10n.cs`，按 Windows 显示语言选择简体中文或英文。用户关闭设置窗口不会停止服务；退出托盘会先发 `stop`，随后有界等待并终止 Node 进程树。仅在当前交互登录会话运行；不要作为 Windows Service 启动。

首次配对默认请求所有桌面应用，弹窗与客户端列表明确显示“所有应用”，无需填写应用路径；批准后覆盖新应用与新窗口，重启后仍有效。`allApps` 随授权持久化，旧授权缺少此字段时保持原范围。已有桌面客户端可在“客户端”页选择“允许所有应用”，本地确认后扩为所有当前与未来桌面应用，并补齐前台鼠标和键盘权限，无需重新配对。独立浏览器权限和原凭据保持不变；仅浏览器客户端不提供此操作。界面等待运行时落盘确认，15 秒未收到确认时显示“结果尚未确认”，不会自动重试；暂停期间可以管理授权但不会恢复执行，停止或重启会清除待确认状态。受限测试仍可用 `--app <完整可执行文件路径>`；`--browser` 单独使用仅授权独立浏览器，`--all-apps --browser` 同时授权两者。前台权限随首次配对授予，不再逐窗口或逐会话审批；执行默认后台，显式指定前台才会切换。全应用授权不改变 Windows 权限级别及后端能力限制。

授权窗口分区展示客户端身份、桌面应用范围、独立浏览器权限、前台权限、有效期与执行方式；长路径可滚动查看，允许与拒绝按钮保持可见。默认按钮与初始焦点均为拒绝，Esc 或关闭窗口同样拒绝；超时、请求撤回或服务停止会关闭失效提示，点击允许后须等待运行时确认。

桌面全应用授权不包含独立浏览器。当前 Playwright 独立浏览器后端的[上游要求为 Windows 11 或更高版本](https://playwright.dev/docs/intro#system-requirements)；Windows 10 ARM64 没有 x64 模拟，不能运行此后端所用的 x64 Chromium。Windows 10 桌面兼容目标不代表独立浏览器兼容。

直接运行程序会打开设置窗口的“状态”页；已在运行时再次启动，只通知已运行的实例打开设置窗口。“登录时启动”写入 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `Computer Use` 值，命令带 `--background`（只在托盘运行，不打开窗口）；便携目录移动后旧值指向其他位置，或在系统“启动应用”里被关闭时，“通用”页会提示，重新勾选即改为当前位置。托盘偏好（自动检查、上次检查时间、跳过的版本）保存在 `%LOCALAPPDATA%\Computer Use\host-settings.json`，本机 HTTP 开关不保存。

更新：宿主运行 `bin\node.exe runtime\cli.js update check|download`，每小时判断一次是否满 24 小时，启动 1 分钟后首次判断。下载的文件须通过 SHA-256 与发布元数据校验，保存在 `%LOCALAPPDATA%\Computer Use\Updates\<版本>-<GUID>`；启动时删除不新于当前版本的旧下载。`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{6C2B9F4E-4B7A-4E0F-9C59-3B1D2F8A7E41}_is1` 的 `InstallLocation` 就是程序所在目录时为安装版：用 `--installer` 下载安装程序，“运行安装程序”以普通方式打开它，由用户按向导完成。否则为便携版：下载 ZIP 并在资源管理器中显示，用户退出托盘后解压并替换当前文件夹。

`ComputerUse.WindowsHost.exe --quit` 供安装与卸载程序使用：触发当前用户、当前会话里正在运行的实例的退出信号（`Local\ComputerUse.WindowsHost.Quit.<SID 哈希>`），该实例像菜单里选择“退出”一样先停止服务再退出；命令最多等 30 秒，实例已退出或本来没有运行时返回 0，否则返回 1。v0.5.0 及更早的版本把未知参数当作错误直接返回，不会退出。

安装程序脚本在 `installer/ComputerUse.iss`（Inno Setup 7.0.2+，带 BOM 的 UTF-8），由 `scripts/package-windows-installer.mjs` 从校验过的便携目录编译。AppId 固定，托盘程序靠它的卸载登记识别安装版，不能修改。安装前先对已安装的程序和当前会话里运行中的所有托盘程序（经 WMI 按进程名查找）执行 `--quit`，5 秒内仍未全部退出就提示用户从托盘退出后重试；静默安装时直接停止。升级时只在目标目录的 `build-receipt.json` 确认是本程序后，才删除旧的组件目录再复制新文件。卸载在用户确认后同样先关闭托盘程序，并删除指向安装目录的登录启动项。Windows 安装器仍未签名；从真实发布下载安装器并完成升级的完整流程仍待验收。

在对应架构 Windows 的 .NET 10 SDK 中发布（x64 示例，ARM64 改为 `win-arm64`）：

```powershell
dotnet publish windows/ComputerUse.WindowsHost/ComputerUse.WindowsHost.csproj -c Release -r win-x64 --self-contained true -o .cache/windows-host-publish
```

完整便携包由 `scripts/package-windows.mjs --arch x64` 或 `--arch arm64` 组装和验证，必须包含 `bin/node.exe`、`bin/cua-driver.exe`、`runtime/host.js` 与生产依赖。Windows 10 ARM64 构建与验证使用原生 ARM64 组件；ARM64 主机交叉构建或验证 x64 包要求 Windows 11 的 x64 模拟，脚本会在不满足时提前报错。x64 主机不能构建 ARM64 包。状态界面的“就绪”只表示服务通道可用；桌面截图和输入仍须通过已配对的测试应用实测。Windows 10 与原生 x64 桌面尚未验收。界面回归程序使用假后端，覆盖中英文、窄窗口和授权截图，见 [validation/windows](../validation/windows/README.md)。
