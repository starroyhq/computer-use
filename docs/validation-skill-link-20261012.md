# App ↔ Skill 接入验收（2026-10-12）

本记录描述 v0.7.0 实施阶段的本地验收，桌面实测时工作区包版本仍为 0.6.1；正式发布产物由 v0.7.0 对应提交的 CI 构建和发布流程验证。最终用户入口为“复制安装提示词”：用户粘贴给自己的 Agent，由 Agent 获取完整 Skill 并按自身支持的方式安装。profile、手动配对及 MCP 配置位于默认收起的“高级接入”。App 不写入任何 Agent 专属目录。

## 代码与隔离检查

| 检查 | 结果 |
|---|---|
| macOS `pnpm check` | 类型、Biome、226 项 Vitest 通过；脚本 37 项通过、13 项平台跳过 |
| Windows `pnpm check` | 201 项 Vitest 通过、25 项平台跳过；脚本 31 项通过、19 项平台跳过 |
| `swift test --package-path native --jobs 2` | 80 项中 77 项通过、3 项条件跳过；无失败 |
| Windows Host / UI harness | 编译零警告、零错误，交互 harness 退出 0；24 张双语截图，包含默认折叠、profile 共用、复制/取消/错误反馈和停止生命周期 |
| 单文件 Skill | 生成一致性及 skill-creator 结构校验通过；实际从 Markdown 提取脚本测试，Windows PowerShell 13 项在 VM 中通过 |
| 包校验 | macOS App / DMG 签名和内容校验通过；Windows ARM64 便携包、安装器及 ZIP 解压校验通过 |

安装脚本测试覆盖无包、旧 v0.6.1、重复/并发、特殊字符路径、错误架构、重定向/发布元数据/大小/哈希/签名失败及锁超时。隔离 fixture 对网络、签名工具或安装器进行了替换，不能据此宣称完成真实发布包首装。

`skill prompt`、`skill export`、`instructions` 和 `preflight` 均可在未配对时运行，不启动 Host。测试覆盖内容不含凭据、路径 JSON 转义、profile 一致性、文件拒绝覆盖、离线凭据未验证、撤销凭据拒绝，以及可连接但响应损坏的 Host 不被误报为正常。

## macOS 安装版实测

在已解锁的 Apple Silicon 桌面更新 `/Applications/Computer Use.app`。系统辅助功能和屏幕录制权限此前已授予，本轮没有代替用户授权。用户在 App 内批准专用测试客户端后，使用同一 profile 完成：

- 两个测试应用、三个窗口的默认后台输入。每个窗口独立文件均确认预期文本和 Record 计数 1，其他窗口输出未被修改，全程没有再次配对。
- 最终安装版实际 `observe` 返回窗口截图，人工查看确认文本与记录计数；安全文本框只呈现掩码。45 秒、781 次前台采样未见测试窗口激活，不能排除采样间隙内的瞬态变化。
- 暂停后已准备的动作返回 `paused`，三个输出文件保持不变。退出后 helper 拒绝恢复；覆盖安装新版及重新打开仍显示暂停。仅点击 App 内恢复按钮后服务重新就绪。
- 空闲状态紧急停止后，helper 返回 `stopped`；退出和重开仍保持停止，测试输出没有额外变化。仅 App 内“重新启动服务”恢复。
- App 内撤销专用客户端后，旧凭据请求返回 `unauthorized`，输出文件保持不变；`preflight` 标记所选凭据为 `unauthorized`，没有重新配对。
- 新界面默认只显示复制提示词与折叠高级入口。实际复制内容为提示词和非秘密本机信息，不含安装脚本或凭据；高级区切换 profile 后各命令保持一致。

首次四并发冷启动曾复现一个 helper 提前 `launch_failed`。定位为首次创建目录/启动锁的竞争；改为原子创建私有目录、排他创建锁并单独打开既有锁，保留所有者、权限和符号链接检查。三组隔离场景共 960 次并发通过。最终安装版连续三轮冷启动，每轮三个原生 helper 与一个 CLI `doctor` 同时发起，全部成功且只启动一个 Host；helper 输出单行 JSON、退出后输出句柄关闭，CLI 返回就绪。

环境高负荷时曾出现桌面后端不可用；待环境恢复后的相同用例通过，保留首次失败记录。暂停验证的第一次准备与另一个测试窗口输出重叠，测试守卫在派发前拒绝；改为串行准备后通过，未重放动作。

收尾已撤销并删除专用测试 profile、关闭三个测试窗口，App 保持就绪。原有五份本地凭据和客户端文件共六个文件的 SHA-256 与测试前完全一致。

## Windows 安装版实测

Windows 11 ARM64 的已登录交互桌面使用新安装器覆盖安装，安装前先在 App 内暂停。安装后 2,247 个文件与构建产物逐个核对，原有凭据与客户端文件保持一致。实际验证：

- 暂停状态在覆盖安装和普通退出/重开后保留，CLI `targets` 返回 `paused`；只有本地恢复按钮解除。
- 紧急停止在退出/重开后仍为 `stopped` 且禁止自动启动，CLI 返回 `unavailable`；只有本地重启按钮恢复就绪。
- 复用已有 `mac-codex` 受限授权，通过安装版 Node/CLI 对同一 Fixture 的两个窗口进行后台观察、输入和 Record；第二窗口由后台操作新建。两个 `type` 均为 `verified`，独立文件确认各计数 1，第一窗口的守卫输出未被第二窗口操作改变。
- 调用没有重新配对、重复批准或重放动作；目标间隔 20 毫秒的前台采样持续为 Host 窗口，不能排除采样间隙内的瞬态变化。

现有 `mac-codex` 只授权指定 Fixture，另一个 profile 仅授权 Notepad，两者都不是全应用授权。本轮没有扩权或新配对，因此 Windows 的新客户端首次配对、同一全应用授权跨应用及实际撤销未覆盖；撤销的本轮真实验收在 macOS 完成，Windows 仅有隔离 harness 覆盖。

旧 Fixture 不支持多窗口，本轮在确认没有旧进程后私有备份其测试目录，以当前测试源码构建的 Fixture 临时放入相同已授权路径；不改变授权范围。收尾已关闭测试进程、恢复原测试目录及输出，原有两份凭据及客户端文件哈希未变，临时计划任务为零。安装版 Host 保持就绪，虚拟机已恢复原来的空闲自动暂停设置。

## 产物与覆盖限制

本地验收产物位于 `artifacts/Computer Use.app`、`artifacts/Computer Use.dmg`、`artifacts/Computer Use Windows ARM64`、同名 `.zip` 及 `Computer Use Windows ARM64 Setup.exe`。Windows 包仍未签名；macOS 本地验收包使用 Developer ID 签名，未上传新的公证。正式 Release 独立要求 macOS App 与 DMG 通过签名、公证、装订及校验，本记录不将本地产物视为正式发布附件。

未在本轮完成：另一个 Agent 的真实 Skill 安装、无 App 且无全局 Node/Git 的全新系统从官方发布下载到首次观察的完整流程、首次 macOS 系统授权、实际注销/登录或系统重启、Windows 10、原生 Windows x64、系统安全拦截以及输入已派发期间的紧急停止。已有单元/隔离检查只按上述范围记录，不替代这些验收。

原始证据保存在被忽略的 `.cache/skill-link-20261012`：`final-prompt-check.log`、`mac-native-prompt-startup-tests.log`、`mac-final-cold-*.json`、`mac-*-rejected*.json`、`mac-final-observe.png`、`mac-ui-install-prompt-check.json`、`mac-cleanup.json`、`prompt-ui`、`prompt-package` 及各打包日志。Windows 安装版证据位于其 `windows-acceptance` 子目录，包括 `new-install-result.json`、`lifecycle-real-result.json`、`actual-focus.json`、`final-real-state.json` 和 `tasks-final.json`。记录不导出凭据内容。
