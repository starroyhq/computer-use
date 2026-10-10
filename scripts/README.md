# macOS 开发 App 打包

两端打包均要求仓库根目录存在 `LICENSE`、`NOTICE` 和 `THIRD_PARTY_NOTICES.md`，并将其复制到包内 `licenses` 目录；缺失时构建失败。分发源码或二进制时保留适用的项目及第三方许可声明。

要求 Apple Silicon、macOS 14+、项目所需 Swift 工具链和 pnpm。运行 `pnpm package:app`，产物为 `artifacts/Computer Use.app`。脚本构建 TypeScript 与 Swift release host，下载并校验固定运行组件，在独立临时目录使用锁文件安装生产依赖，最后按内层 Mach-O → App 顺序签名及验证。

固定组件：

- [Node.js 24.21.0 官方校验文件](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt)，arm64 包 SHA-256：`bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`。
- [Cua Driver 0.28.2 官方校验文件](https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.2/checksums.txt)，universal 裸二进制包 SHA-256：`386db225a3080714a0f9f935525e61efaf46709587ef8b94dd2df81aeb2f6daa`。

`node scripts/fetch-runtime.mjs` 仅下载至 `.cache/runtime-downloads`，同时比对官方清单与脚本内固定哈希；已有缓存仍重新计算哈希。不会执行远程安装脚本或安装至系统目录。

默认 ad-hoc 签名仅用于本机开发，关闭 hardened runtime：ad-hoc 代码没有 Team ID，开启库验证会阻止 Node 加载原生 SDK。Developer ID 构建启用 hardened runtime，并将原生组件统一签名。生产签名需要显式提供本机钥匙串内身份：

```sh
node scripts/package-app.mjs --identity "Developer ID Application: Your Name (TEAMID)"
node scripts/package-app.mjs --verify-only
```

若本机长期使用同一身份，可写入被 git 忽略的 `.env.local`（脚本只读取这一项）：`COMPUTER_USE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"`。之后 `pnpm package:app` 默认使用该身份；Team ID 固定后，重新打包不再使辅助功能和屏幕录制授权失效。命令行 `--identity` 优先。

本地脚本本身不做公证、上传或发布；这些步骤由 `.github/workflows/release.yml` 在 CI 中完成（见 [CI 说明](../docs/CI.md)），实际 release 运行成功前不应视为已公证。开发产物不代表可供其他用户直接通过 Gatekeeper 的发行包。Node 使用上游 [24.21.0 entitlements](https://github.com/nodejs/node/blob/v24.21.0/tools/osx-entitlements.plist) 中的 JIT 和可执行内存权限；不启用调试器、DYLD 环境变量或跳过库签名校验。嵌入式 `.node`、`.dylib` 和 executable 使用同一签名身份。

验证包含 App 结构、全部包内符号链接、arm64 架构、每个 Mach-O 与 App 签名、内置 Node/驱动版本、CLI `--help` 及原生 SDK import。不会启动 App、申请 TCC 权限或操作其他软件。Chromium 不内置，使用者通过 `computer-use browser install` 显式下载匹配浏览器。CLI 包装器可经 `~/.local/bin` 的符号链接运行；创建链接和首次授权由 App 的显式用户操作完成。

临时产物只使用 `.cache/package-app-*`；最终产物只替换带本脚本归属标记的 `artifacts/Computer Use.app`。源码与用户设置不变。固定的是版本和依赖锁，时间戳、Swift 工具链及 Developer ID 签名可能使二进制不逐字节一致。

## Windows ARM64 / x64 便携开发包

在 Windows 11 上准备 .NET 10 SDK、Node 24+ 与 pnpm 10，运行 `node scripts/package-windows.mjs --arch arm64` 或 `--arch x64`。ARM64 主机也可交叉打包 x64；x64 主机只构建 x64。省略 `--arch` 时使用当前 Node 架构；`--verify-only` 可重验所选架构的包。产物分别为 `artifacts/Computer Use Windows ARM64/` 和 `artifacts/Computer Use Windows x64/`，归属标记独立，互不覆盖。脚本不会触碰 macOS App。

固定组件来自官方校验文件：ARM64 使用 Node.js 24.21.0 `node-v24.21.0-win-arm64.zip`（SHA-256 `8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921`）及 Cua Driver 0.28.2 `cua-driver-rs-0.28.2-windows-arm64-binary.zip`（`578b88ff2dd56f06eb7e984d73aaf5e76f59c6fde9542c967d6a30d00213c680`）；x64 使用 `node-v24.21.0-win-x64.zip`（`158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541`）及 `cua-driver-rs-0.28.2-windows-x86_64-binary.zip`（`1f4bfceeab64cb7f56be7aad774c3dc2d2910d1427e4be1d79939c706e8029ba`）。缓存包每次重算哈希，生产依赖在隔离目录由锁文件安装，Windows 托盘按所选 RID 自包含发布。产物保留 Node、Cua、.NET 与项目许可证；验证检查关键 PE 架构、Node 与驱动版本、CLI 帮助及 Cua 原生 SDK 实际加载，不自动操作桌面。ARM64 已完成桌面验证，x64 仍需在 Win11 x64 上实测；具体启动和 Mac SSH/MCP 接入见 [Windows 说明](../docs/WINDOWS.md)。

## 安装包：macOS DMG 与 Windows 安装程序

v0.6.0 提供 macOS ARM64、Windows ARM64 和 x64 的 ZIP，以及 macOS DMG 和两种 Windows 架构的安装程序。每个二进制产物附 `.sha256` 校验文件，每个平台另附 JSON 元数据，共 15 个发布附件。macOS DMG 用于首次安装，Windows 安装程序用于首次安装和安装版升级；macOS 一键更新和 Windows 便携版更新仍使用 ZIP。正式发布工作流要求同一提交的 CI 成功，分别完成 macOS App 与 DMG 的 Developer ID 签名、公证、装订和校验，再核对全部发布附件；开发 CI 产物不等同于已公证的正式包。Windows 安装器与便携包仍未签名，本地 Windows 11 ARM64 覆盖安装已验收，从真实发布下载到完成安装版升级的完整流程仍待验证，见 [验收记录](../docs/validation-results.md)。Windows 10 与原生 x64 桌面尚无实机验收。

macOS 运行 `pnpm package:dmg`，把 `artifacts/Computer Use.app` 做成 `artifacts/Computer Use.dmg`：HFS+、UDZO 压缩，内含 App 与指向 `/Applications` 的快捷方式。身份的来源与 `package-app.mjs` 相同（`--identity`，其次 `.env.local`）；有 Developer ID 时用 `--timestamp` 签名映像，ad-hoc 开发版本的映像不签名。校验会只读挂载映像，确认其中只有 App 与快捷方式并复验 App，签名时再核对映像的签名者；`--verify-only` 只重验已有映像。公证和装订只在发布作业里进行。

Windows 在打好便携目录后运行 `node scripts/package-windows-installer.mjs --arch arm64` 或 `--arch x64`，需要 [Inno Setup](https://jrsoftware.org/isinfo.php) 7.0.2 或更高版本（简体中文从这个版本起是官方语言；先找 `Inno Setup 7`，其次补装过简体中文的 `Inno Setup 6`，也可用 `INNO_SETUP_COMPILER` 指定 `ISCC.exe`）。脚本 `windows/installer/ComputerUse.iss` 必须保存为带 BOM 的 UTF-8，打包脚本会检查。产物为 `artifacts/Computer Use Windows <ARM64|x64> Setup.exe`：按当前用户安装到 `%LOCALAPPDATA%\Programs\Computer Use`，不需要管理员权限，升级前用 `ComputerUse.WindowsHost.exe --quit` 关闭正在运行的托盘程序，卸载保留 `%LOCALAPPDATA%\Computer Use`。打包前会复验便携目录并要求它的版本与源码一致。`--verify-only` 只检查已有安装程序；`--smoke-test` 静默安装到临时目录、复验组件、卸载登记与开始菜单快捷方式后再卸载，因与正式安装共用 AppId，当前用户已安装时拒绝运行。
