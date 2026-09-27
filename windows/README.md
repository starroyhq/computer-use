# Windows 托盘宿主

`ComputerUse.WindowsHost` 是 Windows 11 ARM64 / x64 的交互式用户程序。它从便携包根目录启动 `bin/node.exe runtime/host.js --windows --driver-binary bin/cua-driver.exe --data-dir <用户 LocalAppData>`，由 Node/Cua 的私有 worker 操作桌面；托盘不开放原始驱动端口。

宿主创建仅当前用户可连接的随机命名管道，将完整管道名写入 `%LOCALAPPDATA%\Computer Use\runtime-pipe.json` 的 `pipeName` 字段。目录与发现文件使用受保护的当前用户 ACL，宿主退出时只移除自己写入的发现文件。管道每连接接收一条既有 `{version:1,id,token?,method,params}` RPC；宿主改用内部请求 ID 将其发给 Node stdin 的 `rpc_request`，把 Node stdout 的 `rpc_response` 改回调用者 ID。请求与响应上限均为 32 MiB。动作通道断开或超时返回 `unknown_outcome`，宿主不重放动作。

普通 Node 宿主命令、配对请求和前台批准事件沿用 macOS 语义。托盘提供暂停、恢复、紧急停止、重启、撤销和本机 HTTP MCP 开关。用户关闭状态窗口不会停止服务；退出托盘会先发 `stop`，随后有界等待并终止 Node 进程树。仅在当前交互登录会话运行；不要作为 Windows Service 启动。

在对应架构 Windows 的 .NET 10 SDK 中发布（x64 示例，ARM64 改为 `win-arm64`）：

```powershell
dotnet publish windows/ComputerUse.WindowsHost/ComputerUse.WindowsHost.csproj -c Release -r win-x64 --self-contained true -o .cache/windows-host-publish
```

完整便携包由 `scripts/package-windows.mjs --arch x64` 或 `--arch arm64` 组装和验证，必须包含 `bin/node.exe`、`bin/cua-driver.exe`、`runtime/host.js` 与生产依赖。状态界面的“就绪”只表示服务通道可用；桌面截图和输入仍须通过已配对的测试应用实测。x64 尚未完成桌面实测。
