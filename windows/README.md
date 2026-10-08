# Windows 托盘宿主

`ComputerUse.WindowsHost` 是 Windows 11 ARM64 / x64 的交互式用户程序。它从包根目录（便携目录或安装目录）启动 `bin/node.exe runtime/host.js --windows --driver-binary bin/cua-driver.exe --data-dir <用户 LocalAppData>`，由 Node/Cua 的私有 worker 操作桌面；托盘不开放原始驱动端口。

宿主创建仅当前用户可连接的随机命名管道，将完整管道名写入 `%LOCALAPPDATA%\Computer Use\runtime-pipe.json` 的 `pipeName` 字段。目录与发现文件使用受保护的当前用户 ACL，宿主退出时只移除自己写入的发现文件。管道每连接接收一条既有 `{version:1,id,token?,method,params}` RPC；宿主改用内部请求 ID 将其发给 Node stdin 的 `rpc_request`，把 Node stdout 的 `rpc_response` 改回调用者 ID。请求与响应上限均为 32 MiB。动作通道断开或超时返回 `unknown_outcome`，宿主不重放动作。

普通 Node 宿主命令、配对请求和前台批准事件沿用 macOS 语义。托盘菜单只保留设置、暂停/恢复、紧急停止、重新启动、有新版本时的更新项、检查更新和退出；双击托盘图标打开设置窗口。设置窗口（`SettingsForm`，`TabControl` 6 页）与 macOS 分区对应：通用（登录时启动、CLI 命令、语言）、状态（服务、CLI 管道、控制按钮；Windows 没有系统权限）、客户端（名称与授权范围、撤销确认）、接入（本机 HTTP MCP 开关与地址、复制 stdio 配置）、更新、关于。界面文案在 `L10n.cs`，按 Windows 显示语言选择简体中文或英文。用户关闭设置窗口不会停止服务；退出托盘会先发 `stop`，随后有界等待并终止 Node 进程树。仅在当前交互登录会话运行；不要作为 Windows Service 启动。

直接运行程序会打开设置窗口的“状态”页；已在运行时再次启动，只通知已运行的实例打开设置窗口。“登录时启动”写入 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `Computer Use` 值，命令带 `--background`（只在托盘运行，不打开窗口）；便携目录移动后旧值指向其他位置，或在系统“启动应用”里被关闭时，“通用”页会提示，重新勾选即改为当前位置。托盘偏好（自动检查、上次检查时间、跳过的版本）保存在 `%LOCALAPPDATA%\Computer Use\host-settings.json`，本机 HTTP 开关不保存。

更新：宿主运行 `bin\node.exe runtime\cli.js update check|download`，每小时判断一次是否满 24 小时，启动 1 分钟后首次判断。下载的文件须通过 SHA-256 与发布元数据校验，保存在 `%LOCALAPPDATA%\Computer Use\Updates\<版本>-<GUID>`；启动时删除不新于当前版本的旧下载。`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{6C2B9F4E-4B7A-4E0F-9C59-3B1D2F8A7E41}_is1` 的 `InstallLocation` 就是程序所在目录时为安装版：用 `--installer` 下载安装程序，“运行安装程序”以普通方式打开它，由用户按向导完成。否则为便携版：下载 ZIP 并在资源管理器中显示，用户退出托盘后解压并替换当前文件夹。

`ComputerUse.WindowsHost.exe --quit` 供安装与卸载程序使用：触发当前用户、当前会话里正在运行的实例的退出信号（`Local\ComputerUse.WindowsHost.Quit.<SID 哈希>`），该实例像菜单里选择“退出”一样先停止服务再退出；命令最多等 30 秒，实例已退出或本来没有运行时返回 0，否则返回 1。v0.5.0 及更早的版本把未知参数当作错误直接返回，不会退出。

安装程序脚本在 `installer/ComputerUse.iss`（Inno Setup 7.0.2+，带 BOM 的 UTF-8），由 `scripts/package-windows-installer.mjs` 从校验过的便携目录编译。AppId 固定，托盘程序靠它的卸载登记识别安装版，不能修改。安装前先对已安装的程序和当前会话里运行中的所有托盘程序（经 WMI 按进程名查找）执行 `--quit`，5 秒内仍未全部退出就提示用户从托盘退出后重试；静默安装时直接停止。升级时只在目标目录的 `build-receipt.json` 确认是本程序后，才删除旧的组件目录再复制新文件。卸载在用户确认后同样先关闭托盘程序，并删除指向安装目录的登录启动项。

在对应架构 Windows 的 .NET 10 SDK 中发布（x64 示例，ARM64 改为 `win-arm64`）：

```powershell
dotnet publish windows/ComputerUse.WindowsHost/ComputerUse.WindowsHost.csproj -c Release -r win-x64 --self-contained true -o .cache/windows-host-publish
```

完整便携包由 `scripts/package-windows.mjs --arch x64` 或 `--arch arm64` 组装和验证，必须包含 `bin/node.exe`、`bin/cua-driver.exe`、`runtime/host.js` 与生产依赖。状态界面的“就绪”只表示服务通道可用；桌面截图和输入仍须通过已配对的测试应用实测。x64 尚未完成桌面实测。界面回归程序见 [validation/windows](../validation/windows/README.md)。
