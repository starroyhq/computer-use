# 交接文档（handoff）

本文记录截至 2026-09-28 的收尾状态。接手前请先读 [README](README.md)、[架构说明](docs/ARCHITECTURE.md) 和 [验证结果](docs/validation-results.md)。

## 1. 当前状态

- 分支 `main`，收尾改动都在本地，**尚未推送**。
- 检查与真机：Biome 已接入 `pnpm check`。Windows 11 ARM64 虚拟机已完成 check、打包、配对文案、滚动方向和 `executed` + `effect`。macOS 已用重新打包的 CLI 跑过 `validation/macos-acceptance.sh`。
- **没有公证，没有推送。** 不要把本机签名身份写进受 git 跟踪的文件。

## 2. 本轮已收口

| 项 | 状态 |
|---|---|
| Biome lint/format，`pnpm check` | 已提交 |
| 动作结果 `executed` + `effect`；`unknown` 只表示送达不确定 | 已提交，macOS 打包 CLI 滚动返回 `executed` / `unconfirmed` |
| `act` 排队准入 15 秒，派发和验证共用 `timeoutMs` | 已提交 |
| `waitFor` 使用可注入时钟 | 已提交 |
| 动作日志 7 天 / 500 条，会话与快照定时回收，CLI 截图 24 小时 | 已提交 |
| 应用列表缓存 1 秒；新鲜截图后 1 秒内跳过坐标预热 | 已提交并打进当前 macOS 包 |
| Windows 配对文案、旧客户端缺前台字段时 `permission_denied`、记事本滚动方向 | 已在 ARM64 虚拟机验证 |
| macOS Safari 可重复验收 | `validation/macos-acceptance.sh` 通过 |

macOS 打包 CLI（Safari「Fulotia 后台」，后台会话）：`observe` 7.4 秒，紧接着向下 5 行 3.1 秒，元素上移 314 像素，状态 `executed` / `unconfirmed`。两个网页窗口上的后台 `pagedown` 为 `failed` / `background_unavailable`，之后 `observe` 7.2 秒，运行时未停。观察做不到 5 秒以内，驱动合并抓取的下限约 6.5 秒。

## 3. 仍未做

- macOS 公证，以及干净用户的安装 / 卸载。
- 推送到远程。
- 原生 Windows x64 桌面验收。
- 固定模型任务连续 10 次、成功率至少 80%。当前只有更早的 1 次 Mac Codex 回归。
- 锁屏、休眠、多显示器、普通第二用户隔离，以及中断时按键释放。

## 4. 本机环境

- 产物：`artifacts/Computer Use.app`。**运行中不要覆盖**：菜单栏完全退出后再 `pnpm package:app`，然后重新打开。
- CLI：`artifacts/Computer Use.app/Contents/Resources/bin/computer-use`。
- 验收：`validation/macos-acceptance.sh`。默认配置文件 `macos-accept`，只配对了 Safari。不需要时在菜单栏撤销。
- 验收时为了多窗口按键拒绝打开过 example.com。若还看得到「Example Domain」窗口，关掉即可；脚本只会关掉它自己记下的新窗口。
- Windows 虚拟机里有一个只配对记事本的 `win-accept` 客户端，可在托盘撤销。
- 签名身份只放在仓库根目录被忽略的 `.env.local`。

## 5. 常用命令

```sh
pnpm install --frozen-lockfile
pnpm check            # typecheck + lint + test + 打包脚本测试
pnpm native:test      # Swift（仅 macOS）
pnpm package:app      # 构建 App；读取 .env.local 的签名身份
validation/macos-acceptance.sh
```
