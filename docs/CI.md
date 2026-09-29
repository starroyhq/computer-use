# GitHub Actions

工作流参考 `agentkib` 的检查与打包分离方式，复用本项目已有构建脚本。常规 CI 只生成开发产物；发布工作流另行签名、公证 macOS App，并创建 GitHub Release。不注册 MCP 或配置桌面权限。

## 触发与检查

- 向 `main` 提交 PR 或推送：运行 `CI` 和 `Workflow Lint`。
- PR：只检查，不上传便携包。
- `main` 推送：三个平台的检查全部通过后，调用 `Desktop Package Artifacts` 构建并上传开发包。
- Actions → CI → Run workflow：选择分支；`build_packages` 默认开启，关闭后只运行检查。无需推版本标签。

| 环境 | runner | 检查 |
|---|---|---|
| macOS ARM64 | `macos-15` | `pnpm check`、Chromium 集成、Swift 单元测试 |
| Windows x64 | `windows-2025` | `pnpm check`、Chromium 集成、宿主和两个测试项目的 .NET 编译 |
| Windows ARM64 | `windows-11-arm` | `pnpm check`、宿主和两个测试项目的 .NET 编译；不安装 Chromium |

使用 Node 24.21.0、`packageManager` 固定的 pnpm 10.8.1 和 .NET 10 SDK；依赖按锁文件安装，pnpm 缓存由 Actions 管理。常规 CI 只有 `contents: read` 权限，无 Apple secrets。新提交取消同一分支的旧任务，矩阵任务独立报告失败，并设置执行超时。

macOS 和 Windows x64 在测试前实际启动无头 Chromium；浏览器安装或启动失败会令检查失败。Windows ARM64 的浏览器测试、Windows 的 Unix IPC 测试仍按项目现有条件跳过，不计作通过。Windows 托盘与授权 UI 测试项目仅编译；实际运行命令和交互桌面要求见 [Windows 文档](WINDOWS.md)。

runner 标签适用于公有与私有仓库，但私有仓库会消耗 Actions 配额，详见 [GitHub runner 文档](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。矩阵可用性、镜像和托管桌面条件不代表用户机器兼容性。

## 下载与核验产物

从成功的 CI run 的 Artifacts 下载对应 `computer-use-<平台>-<完整提交 SHA>`。产物保留 14 天，每个平台包含：

- `computer-use-<版本>-<平台>-<短 SHA>-dev.zip`
- 同名 `.zip.sha256`
- 同名前缀的 `.json`，记录源码提交、平台、版本、文件大小、哈希和签名状态

Actions 下载外层归档后，再解压其中的开发包 ZIP。macOS ZIP 使用 `ditto` 保留执行权限、内部符号链接和 ad-hoc 签名；Windows ZIP 包含整个便携目录。不要只取单个 EXE。macOS 包未经公证，Windows 包未签名；这是开发包，不是正式发行。

每个包先执行现有打包校验，再由 `.github/scripts/archive-package.mjs` 压缩到 ZIP、解压到独立临时目录，并对解压后的包复验架构、依赖链接、版本、CLI 和原生 SDK。成功后才生成 SHA-256 和元数据并上传。上传路径限定为 `artifacts/ci/*`，不上传测试凭据、用户目录或整个工作区。CI 若发现源码被构建修改或生成未忽略文件，会拒绝生成产物。

## 发布时的 macOS 签名与公证

`Publish verified Release` 先核对版本标签与成功的 `main` CI run 指向同一提交。随后 macOS runner 从该提交重新构建，用 Developer ID Application 证书签名，将 App 送交 Apple 公证并把票据装订进 App。归档脚本对原 App 和解压后的 App 分别校验代码签名、签名身份、Team ID、票据和 Gatekeeper；只有这些检查通过才标记为 `developer-id-notarized`。Windows 发布包仍来自核对过的 CI run。发布工作流会核对三个包的 SHA-256，先创建草稿、核对上传内容，再转成正式 Release。

仓库 Actions secrets 需要 `APPLE_CERTIFICATE`（Developer ID Application 的 PKCS#12 文件 Base64）、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`（完整证书名称）、`APPLE_TEAM_ID`、`APPLE_API_ISSUER`、`APPLE_API_KEY` 和 `APPLE_API_PRIVATE_KEY`（一次性下载的 `.p8` 全文）。私钥与证书只进入发布作业的临时文件和临时钥匙串，作业结束时清理；不要提交到仓库。缺失任何一项会令发布失败，不会降级为 ad-hoc 包。发布输入需要已有版本标签和该标签提交的成功 CI run ID；运行该工作流本身会创建并公开 Release，应只在准备发布时触发。

校验下载文件：

```sh
# macOS：在解压后的 Actions 下载目录
shasum -a 256 -c computer-use-*.zip.sha256
```

```powershell
# Windows：比较结果与相邻 .sha256 文件
Get-FileHash .\computer-use-*.zip -Algorithm SHA256
```

## 本地检查与限制

`actionlint` 1.7.12 校验所有工作流，Linux CI 同时使用镜像自带的 ShellCheck 检查内嵌 shell。可在本地运行 `actionlint`、`pnpm check`，并在目标系统执行已有打包脚本及 `node .github/scripts/archive-package.mjs <macos-arm64|windows-x64|windows-arm64>`。本地有未提交修改时，元数据的 `sourceDirty` 为 `true`，不能将提交 SHA 当作包的完整源码标识。

CI 通过仅表示自动化检查、构建和组件加载通过，不代表截图、中文输入、授权、断线、紧急停止或真实模型流程通过。桌面与模型验收仍按 [验证方法](VALIDATION.md) 独立执行并记入 [验证记录](validation-results.md)。公证签名流程需在实际发布作业中验证；本地语法和归档逻辑检查不能代替 Apple 公证服务的结果。
