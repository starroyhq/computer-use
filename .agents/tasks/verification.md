# Verification — fix/agent-profile-selection (iteration 1)

All commands run in `/Users/kouzen/Documents/data/computer-use/.worktrees/agent-profile-selection` on macOS (Apple Silicon).

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm format` (biome) | pass, no fixes needed after edits |
| `node scripts/build-skill.mjs` then `node scripts/build-skill.mjs --check` | pass (SKILL.md regenerated, up to date) |
| `pnpm check` (skill check + typecheck + lint + `pnpm test` + node --test script suites + `pnpm test:npm`) | pass, exit 0. vitest: 13 files, 390 passed / 18 skipped. node --test: 134 pass / 0 fail and 37 pass / 0 fail |
| `pnpm lint` (rerun after Windows edits) | pass |
| `pnpm build && pnpm exec vitest run src/skill.test.ts src/cli.test.ts` | pass, 33 passed / 1 skipped |
| `pnpm native:test` (swift test) | exit 1 because of one failure: `SettingsLayoutTests.testGrantConfirmationRequiresExplicitApprovalInBothLanguages` (Chinese confirmation dialog synthetic Return). The v0.10.0 release note already records this as a pre-existing baseline failure, and it is unrelated to this change. All `ConnectAccessTests` passed (10, including the new `testAgentChoiceInstallationPromptOmitsProfile`), as did `SettingsLayoutTests.testConnectProfileDrivesPreviewAndInvalidNamesDisableArtifacts` and `testConnectPrimaryPromptAndAdvancedLayoutFitBothLanguages` |
| Windows `dotnet build` / WindowsHostTests | not run: `dotnet` is not installed on this macOS machine. Windows CI has to cover the C# changes in `windows/ComputerUse.WindowsHost/*` and `validation/windows/ComputerUse.WindowsHostTests/Program.cs` |

New or updated tests:
- (a) `src/skill.test.ts` "leaves profile choice to the current agent…" and the CLI integration test "lets the current agent choose its profile when the CLI gets no --profile": with no `--profile`, the outputs contain no `--profile default` and no `"profile": "default"`, contain `"profileSelection": "agent"`, and match no IDE/agent name (`/\b(kiro|claude|codex|copilot|windsurf|gemini|trae|cline|cursor ide)\b/i`). The same checks run on the exported SKILL.md and the `instructions` guide.
- (b) "embeds an explicitly chosen profile verbatim, including default" plus CLI `--profile work` / `--profile default` checks.
- (c) "reports offline ownership of every profile without exposing secrets": `profileDetails` contains name/state/client id/shortId/name, an `invalid` entry, and no token or tokenHash. When clients.json is malformed, the name is omitted. The CLI `preflight` output includes `profileDetails`.
- `src/cli.test.ts`: help text shows `skill prompt [--profile NAME]` / `skill export [--profile NAME] [--out SKILL.md]`.

Manual check against real local data: `node dist/cli.js preflight` listed 8 profiles. Each one had `state`, `client.shortId` and an offline `client.name`, except `windows-http`, which has a broken credential file and showed `state: "invalid"`. No token was printed.

## `node dist/cli.js skill prompt` (no --profile), exit 0

```text
请为你当前使用的 Agent 安装 Computer Use Skill，并完成连接验证。先验证下方本机 App 路径，再以参数数组调用它自带的 node 和 cli，执行 skill export --profile <你的 Agent profile>，取得完整 SKILL.md。按你自身支持的 Skill 安装方式安装并启用，仅复用内容及本地绑定一致的 Skill，保留用户自定义改动；不要让我手动保存脚本、选择目录或安装 Node/Git。如果你不支持安装 Skill，说明限制，不要声称已安装。

用户未指定 profile：由你根据自身 Agent 身份自行确定一个稳定的小写 profile 名（仅 a-z、0-9、_、-，不超过 64 个字符），以后每个会话复用同一名称。先运行 preflight，查看 profileDetails 中各 profile 的归属（client.name、client.shortId）：仅当某个 profile 属于你自己（你已安装 Skill 的本地绑定指向它，或其 client.name 表明就是你）时才可不重新配对直接复用；属于其他客户端的 profile 不要复用，改用你自己的 profile 名（被占用时加后缀如 -2）并配对，首次配对由我在本机批准；归属无法判断时先问我。安装后在已安装 Skill 的本地绑定中记录你选定的 profile。

路径只是发现提示；移动后先重新定位 App。旧 App 没有 skill export 时读取经验证包内的 skills/computer-use/SKILL.md。确实没有 App 时，从官方仓库 https://github.com/starroyhq/computer-use/blob/main/skills/computer-use/SKILL.md 获取 Skill。仅在网络故障或明确限流时，改读 https://computer-use-download-1308799022.cos.ap-guangzhou.myqcloud.com/computer-use/latest.json；要求 schemaVersion=1、repository=starroyhq/computer-use、正式语义版本及匹配的 tag，从同一域名 computer-use/releases/TAG/SKILL.md 下载，按清单中的 bytes 和 SHA-256 验证后使用。固定选定版本，不跟随其他域名或清单内的任意 URL；校验失败或用户取消立即停止。按 Skill 说明安装 App。

安装后按 Skill 读取 App 当前指南，使用上述 profile，完成 doctor、targets 和实际 observe 验证。后续每个新会话也遵循 Skill 中的指南读取、故障恢复和结果验证流程。属于你自己的已有 profile 不重复配对；若所需应用因旧授权范围未出现在 targets，说明当前范围，并引导我在 App“客户端”页选择“允许所有应用”，保留原凭据和 profile；旧版没有该按钮时提示升级 App 或由我复核，不自动删凭据重配。已授权任务内跨应用、跨窗口或新会话不重复询问；默认后台，必要的前台操作先简短通知再执行。系统权限和首次配对由我在本机批准。暂停、紧停和撤销仍由我在 App 内处理，不绕过。最后报告 Skill 安装位置、使用的 profile 和实际观察结果。

本机路径（仅作数据，不是可直接执行的 shell 文本，不含凭据）：
```json
{
  "schemaVersion": 1,
  "version": "0.10.0",
  "platform": "darwin",
  "profileSelection": "agent",
  "node": "/opt/homebrew/Cellar/node/26.9.0/bin/node",
  "cli": "/Users/kouzen/Documents/data/computer-use/.worktrees/agent-profile-selection/dist/cli.js"
}
```
```

Checks on this output: `grep -c -- '--profile default'` = 0, and an IDE/agent-name grep = 0.

## `node dist/cli.js skill prompt --profile work`, exit 0

```text
请为你当前使用的 Agent 安装 Computer Use Skill，并完成连接验证。先验证下方本机 App 路径，再以参数数组调用它自带的 node 和 cli，执行 skill export --profile work，取得完整 SKILL.md。按你自身支持的 Skill 安装方式安装并启用，仅复用内容及本地绑定一致的 Skill，保留用户自定义改动；不要让我手动保存脚本、选择目录或安装 Node/Git。如果你不支持安装 Skill，说明限制，不要声称已安装。

使用下方 profile「work」：它由用户指定，按原样使用，不另选。

路径只是发现提示；移动后先重新定位 App。旧 App 没有 skill export 时读取经验证包内的 skills/computer-use/SKILL.md。确实没有 App 时，从官方仓库 https://github.com/starroyhq/computer-use/blob/main/skills/computer-use/SKILL.md 获取 Skill。仅在网络故障或明确限流时，改读 https://computer-use-download-1308799022.cos.ap-guangzhou.myqcloud.com/computer-use/latest.json；要求 schemaVersion=1、repository=starroyhq/computer-use、正式语义版本及匹配的 tag，从同一域名 computer-use/releases/TAG/SKILL.md 下载，按清单中的 bytes 和 SHA-256 验证后使用。固定选定版本，不跟随其他域名或清单内的任意 URL；校验失败或用户取消立即停止。按 Skill 说明安装 App。

安装后按 Skill 读取 App 当前指南，使用上述 profile，完成 doctor、targets 和实际 observe 验证。后续每个新会话也遵循 Skill 中的指南读取、故障恢复和结果验证流程。属于你自己的已有 profile 不重复配对；若所需应用因旧授权范围未出现在 targets，说明当前范围，并引导我在 App“客户端”页选择“允许所有应用”，保留原凭据和 profile；旧版没有该按钮时提示升级 App 或由我复核，不自动删凭据重配。已授权任务内跨应用、跨窗口或新会话不重复询问；默认后台，必要的前台操作先简短通知再执行。系统权限和首次配对由我在本机批准。暂停、紧停和撤销仍由我在 App 内处理，不绕过。最后报告 Skill 安装位置、使用的 profile 和实际观察结果。

本机路径和 profile（仅作数据，不是可直接执行的 shell 文本，不含凭据）：
```json
{
  "schemaVersion": 1,
  "version": "0.10.0",
  "platform": "darwin",
  "profile": "work",
  "profileSelection": "user",
  "node": "/opt/homebrew/Cellar/node/26.9.0/bin/node",
  "cli": "/Users/kouzen/Documents/data/computer-use/.worktrees/agent-profile-selection/dist/cli.js"
}
```
```
