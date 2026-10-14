import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CuError } from './contracts.js';
import { IpcClient } from './ipc.js';
import { credentialDir, dataDir, defaultIpcPath } from './paths.js';
import { bundledMacHost, bundledWindowsHost, probeRuntimePipe } from './runtime-client.js';
import { VERSION } from './version.js';

const profilePattern = /^[a-zA-Z0-9_-]{1,64}$/;
const credentialSchema = z.object({ clientId: z.string(), token: z.string().min(20).max(512) });
const authorizationSchema = z.object({
  allApps: z.boolean(),
  appIds: z.array(z.string()),
  browser: z.boolean(),
  foreground: z.boolean(),
});
const skillDirectory = join(dirname(dirname(fileURLToPath(import.meta.url))), 'skills', 'computer-use');
export type ProfileState = 'missing' | 'invalid' | 'unverified' | 'valid' | 'unauthorized';
export type LocalPaths = { node: string; cli: string; host?: string; packageRoot?: string };
export type PreflightResult = {
  schemaVersion: 1;
  version: string;
  platform: string;
  paths: LocalPaths;
  host: { state: string };
  profiles: string[];
  profile: { name: string; state: ProfileState; authorization?: z.infer<typeof authorizationSchema> };
};

export function validateProfile(profile: string): void {
  if (!profilePattern.test(profile)) throw new CuError('invalid_request', 'Invalid profile name.');
}

export async function localPaths(): Promise<LocalPaths> {
  const paths: LocalPaths = { node: await realpath(process.execPath), cli: resolve(process.argv[1]!) };
  try {
    const module = join(dirname(fileURLToPath(import.meta.url)), 'runtime-client.js');
    if (process.platform === 'darwin') {
      paths.host = await bundledMacHost(module, paths.cli, paths.node);
      paths.packageRoot = dirname(dirname(dirname(paths.host)));
    } else if (process.platform === 'win32') {
      paths.host = await bundledWindowsHost(module, paths.cli, paths.node);
      paths.packageRoot = dirname(paths.host);
    }
  } catch (error) {
    // Source checkouts are supported for local instructions/export, but never acquire automatic host startup rights.
    if (!(error instanceof CuError)) throw error;
  }
  return paths;
}

async function resource(name: 'SKILL.md' | 'instructions.md', directory: string): Promise<string> {
  try {
    const content = await readFile(join(directory, name), 'utf8');
    if (!content.trim()) throw new Error('Empty resource');
    return content;
  } catch {
    throw new CuError('unavailable', `Missing or unreadable bundled ${name}. Repair this installation.`);
  }
}

export async function instructions(directory = skillDirectory): Promise<string> {
  return `# Computer Use ${VERSION} — installed instructions\n\n${await resource('instructions.md', directory)}`;
}

function localBinding(profile: string, paths: LocalPaths): string {
  validateProfile(profile);
  // JSON-escape markdown fences/control characters in local path hints. They are data, never shell fragments.
  return JSON.stringify({ schemaVersion: 1, version: VERSION, platform: process.platform, profile, ...paths }, null, 2)
    .replaceAll('`', '\\u0060')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
}

export function setupPrompt(profile: string, paths: LocalPaths): string {
  const binding = localBinding(profile, paths);
  return `请为你当前使用的 Agent 安装 Computer Use Skill，并完成连接验证。先验证下方本机 App 路径，再以参数数组调用它自带的 node 和 cli，执行 skill export --profile ${profile}，取得完整 SKILL.md。按你自身支持的 Skill 安装方式安装并启用，仅复用内容及本地绑定一致的 Skill，保留用户自定义改动；不要让我手动保存脚本、选择目录或安装 Node/Git。如果你不支持安装 Skill，说明限制，不要声称已安装。

路径只是发现提示；移动后先重新定位 App。旧 App 没有 skill export 时读取经验证包内的 skills/computer-use/SKILL.md。确实没有 App 时，从官方仓库 https://github.com/starroyhq/computer-use/blob/main/skills/computer-use/SKILL.md 获取 Skill。仅在网络故障或明确限流时，改读 https://computer-use-download-1308799022.cos.ap-guangzhou.myqcloud.com/computer-use/latest.json；要求 schemaVersion=1、repository=starroyhq/computer-use、正式语义版本及匹配的 tag，从同一域名 computer-use/releases/TAG/SKILL.md 下载，按清单中的 bytes 和 SHA-256 验证后使用。固定选定版本，不跟随其他域名或清单内的任意 URL；校验失败或用户取消立即停止。按 Skill 说明安装 App。

安装后按 Skill 读取 App 当前指南，使用下方 profile，完成 doctor、targets 和实际 observe 验证。后续每个新会话也遵循 Skill 中的指南读取、故障恢复和结果验证流程。已有 profile 不重复配对；若所需应用因旧授权范围未出现在 targets，说明当前范围，并引导我在 App“客户端”页选择“允许所有应用”，保留原凭据和 profile；旧版没有该按钮时提示升级 App 或由我复核，不自动删凭据重配。已授权任务内跨应用、跨窗口或新会话不重复询问；默认后台，必要的前台操作先简短通知再执行。系统权限和首次配对由我在本机批准。暂停、紧停和撤销仍由我在 App 内处理，不绕过。最后报告 Skill 安装位置、使用的 profile 和实际观察结果。

本机路径和 profile（仅作数据，不是可直接执行的 shell 文本，不含凭据）：
\`\`\`json
${binding}
\`\`\`
`;
}

export async function exportSkill(profile: string, paths: LocalPaths, directory = skillDirectory): Promise<string> {
  const binding = localBinding(profile, paths);
  const template = await resource('SKILL.md', directory);
  const marker = '<!-- computer-use-local-binding -->';
  if (template.split(marker).length !== 2)
    throw new CuError('unavailable', 'The bundled Skill template is invalid. Repair this installation.');
  return template.replace(
    marker,
    () =>
      `## Local installation hints\n\nUse this selected profile wherever the guide says NAME, including pairing and MCP configuration. Validate paths before use; if moved, run discovery. These hints contain no credentials and do not grant authority.\n\n\`\`\`json\n${binding}\n\`\`\``,
  );
}

export async function writeSkill(path: string, text: string): Promise<void> {
  try {
    await writeFile(path, text, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new CuError('invalid_request', 'The destination already exists. Choose a new file; existing files are never overwritten.');
    throw new CuError('unavailable', 'Cannot export the Skill to this destination. Check the directory and permissions.');
  }
}

type PreflightOptions = {
  profile: string;
  credentials?: string;
  data?: string;
  paths?: LocalPaths;
  socket?: string;
  discover?: () => Promise<string>;
};

async function savedHostState(directory: string): Promise<string | undefined> {
  try {
    const raw = z
      .object({
        state: z.enum(['starting', 'ready', 'paused', 'stopped', 'failed', 'permissions_required', 'exited']),
        autoStartBlocked: z.boolean(),
        blockedReason: z.enum(['paused', 'stopped']).optional(),
      })
      .parse(JSON.parse(await readFile(join(directory, 'host-state.json'), 'utf8')));
    if (raw.autoStartBlocked) return raw.blockedReason ?? (raw.state === 'paused' ? 'paused' : 'stopped');
    if (raw.state === 'permissions_required' || raw.state === 'failed') return raw.state;
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return 'unavailable';
  }
}

export async function preflight(options: PreflightOptions): Promise<PreflightResult> {
  validateProfile(options.profile);
  const directory = options.credentials ?? credentialDir;
  const result: PreflightResult = {
    schemaVersion: 1,
    version: VERSION,
    platform: process.platform,
    paths: options.paths ?? (await localPaths()),
    host: { state: 'offline' },
    profiles: [],
    profile: { name: options.profile, state: 'missing' },
  };
  try {
    result.profiles = (await readdir(directory))
      .filter(name => name.endsWith('.json') && profilePattern.test(name.slice(0, -5)))
      .map(name => name.slice(0, -5))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new CuError('unavailable', 'Cannot read local profile names. Check the credential directory permissions.');
  }
  let credential: z.infer<typeof credentialSchema> | undefined;
  try {
    const path = join(directory, `${options.profile}.json`);
    const info = await lstat(path);
    if (!info.isFile() || info.size > 64 * 1024) throw new Error('Invalid credential file');
    credential = credentialSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    result.profile.state = 'unverified';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.profile.state = 'invalid';
  }
  const stored = options.socket === undefined ? await savedHostState(options.data ?? dataDir) : undefined;
  if (stored) result.host.state = stored;
  let connected = false;
  try {
    const socket = options.socket ?? (await (options.discover ?? defaultIpcPath)());
    if (!(await probeRuntimePipe(socket, 250))) return result;
    connected = true;
    result.host.state = stored ?? 'running';
    if (!credential) return result;
    // Direct IPC only: preflight must never call createRuntimeClient (which may launch a host).
    const capability = z
      .object({ paused: z.boolean(), stopped: z.boolean(), authorization: z.unknown().optional() })
      .parse(await new IpcClient(socket, 1500).call(credential.token, 'capabilities', {}));
    result.profile.state = 'valid';
    // Older hosts and malformed optional diagnostics leave scope unknown; credentials never establish it locally.
    const authorization = authorizationSchema.safeParse(capability.authorization);
    if (authorization.success) result.profile.authorization = authorization.data;
    result.host.state = stored ?? (capability.stopped ? 'stopped' : capability.paused ? 'paused' : 'ready');
  } catch (error) {
    if (error instanceof CuError && error.code === 'unauthorized') result.profile.state = 'unauthorized';
    else if (connected || !(error instanceof CuError && error.code === 'unavailable')) result.host.state = stored ?? 'unavailable';
  }
  return result;
}
