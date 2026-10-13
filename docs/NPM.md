# npm 接入与发布

`@starroy/computer-use` 是独立的轻量入口，提供 App 发现、安装引导与命令转发。桌面服务和业务 CLI 仍由完整 App 提供，不把原生 Host 或根项目依赖发布到 npm。npm 与 pnpm 使用同一个包，不需要分别发布。

公开包为 [@starroy/computer-use](https://www.npmjs.com/package/@starroy/computer-use)，首次版本为 `0.7.0`。npm 启动器与 App 独立版本管理；GitHub Release 继续提供完整 App 安装包。更新 npm 入口不会自动升级已有 App。

首发测试、两端只读验证与公开归档核验见 [npm 验证记录](validation-npm-20261012.md)。

## 使用方式

需要 Node.js 22 或更新版本；安装后的 App 使用自己的内置运行时。

```sh
npx @starroy/computer-use setup
# 或使用 pnpm，无需重复安装
pnpm dlx @starroy/computer-use setup
```

`setup` 优先发现已有 App；确实未安装时，复用 Skill 中维护的安装脚本，下载并校验官方最新正式版。支持 macOS Apple Silicon、Windows ARM64 / x64，不提供 Intel Mac 或 Linux App。只在显式运行 `setup` 时安装，不使用 `postinstall` 等安装钩子。

`setup` 输出可粘贴给 Agent 的安装接入提示词，由 Agent 继续完成 Skill 安装、连接和观察验证。系统权限与首次配对仍需用户在本机批准；npm 安装不会代替这些批准，也不会解除暂停、紧急停止或撤销状态。

```sh
# 保持 profile 一致
npx @starroy/computer-use setup --profile default

# 已安装多份 App 时显式选定目标
npx @starroy/computer-use --app-path '/Applications/Computer Use.app' setup

# 给程序读取的安装与只读预检状态，不输出安装提示词
npx @starroy/computer-use setup --profile default --json

# 普通命令转交已安装 App，不会自动安装 App
npx @starroy/computer-use doctor --profile default
npx @starroy/computer-use targets --profile default
```

也可以安装命令入口：

```sh
npm install --global @starroy/computer-use
# 或 pnpm add --global @starroy/computer-use
computer-use setup
```

App 已有的 CLI 链接与 npm 提供的入口都叫 `computer-use`。若全局安装提示同名命令冲突，保留现有链接，使用 `npx` / `pnpm dlx` 即可；不需要用 `--force` 覆盖。`--help`、`--version` 可离线运行，后者表示 npm 入口版本；App 版本通过其 `preflight` 查看。

旧版 v0.6.1 App 会被识别为已安装，不会另装一份或覆盖凭据；若缺少当前接入命令，会提示升级。完整接入、后台执行和恢复说明见 [使用指南](USAGE.md)。

## 构建与核验

根 `package.json` 保持 `private: true`。唯一发布源目录为 `packages/npm`，由脚本组装缺失的维护资源，不能直接在源码目录执行 `npm publish`。

```sh
pnpm test:npm
node scripts/package-npm.mjs
# 可选：node scripts/package-npm.mjs --out /path/to/output
```

脚本输出一行 JSON，包含实际归档路径、版本、SHA-256 和文件列表。默认产物是 `artifacts/npm/starroy-computer-use-0.7.2.tgz`，版本由 `packages/npm/package.json` 决定。构建不要求安装根项目依赖，也不依赖 TypeScript 编译。

归档仅允许以下文件：

```text
package.json
README.md
LICENSE
NOTICE
THIRD_PARTY_NOTICES.md
bin/computer-use.mjs
lib/launcher.mjs
resources/bootstrap-macos.sh
resources/bootstrap-windows.ps1
```

两份 bootstrap 从 `skills/computer-use` 原样复制。打包拒绝缺资源、版本不一致、生产依赖、生命周期脚本、宽泛 `files` 配置或归档额外文件，并核对归档资源与源码字节一致。用户凭据、`.npmrc`、缓存、桌面应用和根 `node_modules` 不在复制范围内。

可对实际 tgz 做最后一次离线检查：

```sh
npm exec --offline --ignore-scripts --yes --package ./artifacts/npm/starroy-computer-use-0.7.2.tgz -- computer-use --help
npm publish ./artifacts/npm/starroy-computer-use-0.7.2.tgz --dry-run --ignore-scripts --access public --registry https://registry.npmjs.org
```

## 发布与账号配置

`@starroy` 是 npm scope，与 GitHub 的 `starroyhq` 名称可以不同。`0.7.0` 通过账号登录与本机网页验证完成首发；后续默认由 GitHub Actions 通过包级 Trusted Publisher 发布。人工发布仅用于必要的维护场景；登录及 2FA 由账号所有者完成，不把验证码或 token 写入项目、命令参数或 CI 日志。

```sh
npm login --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org
# 先更新版本并重新打包；将 X.Y.Z 替换为通过校验且尚未发布的版本：
npm publish ./artifacts/npm/starroy-computer-use-X.Y.Z.tgz --ignore-scripts --access public --registry https://registry.npmjs.org
```

这会真正发布公开包；`--dry-run` 不会。版本一旦发布，不能用相同版本覆盖内容。参见 [npm 官方公开 scoped 包发布说明](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)。

`.github/workflows/npm.yml` 使用 OIDC 发布，不保存长期 npm token。Trusted Publisher 的精确配置如下：

| 配置项 | 值 |
| --- | --- |
| Organization or user | `starroyhq` |
| Repository | `computer-use` |
| Workflow filename | `npm.yml` |
| Environment name | `npm` |
| Allowed actions | 允许直接 `npm publish` |

GitHub 的 `npm` environment 仅允许 `main` 分支与 `npm-v*` 标签，不设置人工 reviewer。npm 要求新 Trusted Publisher 在创建后两天内完成首次成功发布，否则需重新创建。OIDC 要求 npm 11.5.1+，工作流使用 Node 24 和 GitHub 托管 runner，发布 job 具有 `id-token: write`。公开仓库的公开包会自动带 provenance。参见 [npm 官方 Trusted Publisher 文档](https://docs.npmjs.com/trusted-publishers/)。

## CI 与后续版本

相关 `main` push / PR 和未勾选发布的手动运行只验证。检查矩阵覆盖 macOS ARM64、Windows x64、Windows ARM64，并以 Node 22 在 Linux 运行入口兼容性检查；最后一项不代表支持 Linux 桌面服务。

后续发布步骤：

1. 更新 `packages/npm/package.json` 的版本及相关文档，完成测试，将改动提交并推送到 `main`。
2. 在该提交上创建并推送 `npm-vX.Y.Z` 标签。版本必须与 npm manifest 完全一致，标签提交必须属于 `origin/main` 历史。
3. **npm launcher** 自动完成平台检查、打包和 publish dry-run，上传 tgz 及文件清单；发布 job 下载同一份归档，重新校验源码、文件清单和 SHA-256，再通过 OIDC 发布，不重新打包。
4. 发布后，CI 等待 registry 可见，核对公开归档与来源证明元数据。重跑已发布的版本时，只有内容与当前源码完全一致才跳过；网络错误或内容不一致会明确失败。

必要时可以在 `main` 手动运行 **npm launcher** 并勾选 `publish` 恢复发布。普通 `vX.Y.Z` App 标签及 App Release 不触发 npm 发布；两者无需同步版本。CI 的 fixture、归档和命令测试不能代替本机系统授权、首次配对以及跨应用操作验收。
