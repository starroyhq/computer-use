# npm 入口验证记录 · 2026-10-12

验证对象为 `@starroy/computer-use@0.7.0`。npm 包只包含启动器、共享安装脚本与许可文件，桌面操作仍使用安装后的 App 内置 CLI。本次未修改已有配对、系统权限或服务停止状态。

## 本地自动化

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | 通过：类型、格式、243 项业务测试、40 项脚本测试；17 项 Windows 专用脚本测试在 macOS 跳过；当时的 28 项 npm 测试通过 |
| 最终 `pnpm test:npm` | 29/29 通过，包括新增的真实孙进程保留输出管道时的有界超时回归 |
| `node scripts/build-skill.mjs --check` | 通过，共享脚本与生成的 Skill 一致 |
| 包文件与源码校验 | 通过：严格 9 个文件，无生产依赖、生命周期脚本或凭据；两份 bootstrap 与维护源逐字节一致 |
| `npm publish <tgz> --dry-run --ignore-scripts --access public` | 通过 |
| 本地 tgz 的 `npm exec --offline`、`pnpm dlx` | 帮助或版本入口通过，版本为 0.7.0 |

测试覆盖：发现时不安装、缺失/损坏 App、特殊字符路径、多个安装、旧版命令兼容、profile 一致、输出字段筛选、暂停/紧停/撤销不自动恢复、参数与退出码转发、stdio 无额外输出、错误架构、下载失败及校验失败。安装测试使用隔离 fixture；不代表本次重新进行了真实系统首装与授权。

macOS 本地工具链为 Node 26.9.0、pnpm 10.8.1。Node 22 兼容性与 Windows x64 检查已配置到新增 CI，本次未在远端执行。

## 已安装 App 验证

- macOS ARM64：实际 tgz 经 npm 调用 `/Applications/Computer Use.app`；`setup --profile npm-readonly-check --json` 与转发 `preflight` 均成功。App 版本 0.7.0，`installed:false`、profile `missing`、Host `running`，没有创建 profile 或发起配对。
- Windows 11 ARM64 VM：使用当前登录用户与独立临时目录；真实 tgz 的离线 npm 帮助、版本、指定 App 路径的只读 `setup --json` 均退出 0。既有 App 保留 0.6.1 版本号，但属于含新命令的本机功能构建；结果为 `installed:false`、profile `missing`、Host `offline`。官方旧版本缺少新命令的分支另由 fixture 验证。
- Windows bootstrap 测试 17/17；launcher 测试 21 通过、1 项符号链接权限测试跳过；包测试 6 通过、1 项符号链接权限测试跳过。Windows 打包会规范化 tar 执行位并重新校验文件内容，实际归档验证通过。
- VM 验证前后均为暂停状态；测试期间未启动真实 Host、安装 App 或改变授权。

未重新验收 Windows 10、原生 Windows x64、真实干净系统下载首装、系统权限、首次配对或跨窗口输入。此次变化复用既有 App 安装与授权流程，相关 fixture 和已安装 App 的只读转发不能替代这些图形验收。

## 产物

`artifacts/npm/starroy-computer-use-0.7.0.tgz` 的 SHA-256：

```text
3d3dc1ade85d1ee45a814c31506e236add195e307aa00e283448e6d42e0b5634
```

本地详细日志保存在 `.cache/npm-validation/` 与 `.cache/npm-windows-validation/`。

## 公开发布

`npm publish` 在用户完成网页身份验证后退出 0；registry 随后公开提供 [@starroy/computer-use@0.7.0](https://www.npmjs.com/package/@starroy/computer-use/v/0.7.0)，`latest` 指向 `0.7.0`。

- 从公开 registry 重新下载的 tgz 与本地审核产物 SHA-256 完全一致，且通过源码内容、文件白名单及 registry SHA-512 integrity 校验。
- 公开的 `npx @starroy/computer-use … setup --profile npm-readonly-check --json` 成功发现本机 App，返回 App 0.7.0、profile `missing`、Host `running`；没有执行安装或创建配对。
- `pnpm dlx @starroy/computer-use --version` 从公开 registry 下载并输出 `@starroy/computer-use 0.7.0`。
- 首发包大小 18,261 字节，解压 53,064 字节，共 9 个文件。

`0.7.0` 首发采用手动发布；本节记录不代表 OIDC 发布验收。后续的独立 npm 版本、标签触发及 Trusted Publisher 配置见 [npm 发布说明](NPM.md)。
