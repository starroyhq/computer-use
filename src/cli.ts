#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rm, realpath, readdir, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { IpcClient } from './ipc.js';
import { CuError, errorResult } from './contracts.js';
import { credentialDir, dataDir, defaultIpcPath } from './paths.js';
import { atomicJson, privateDirectory, readJson } from './storage.js';
import { schemas, type Method } from './schema.js';
import { VERSION } from './version.js';

const SCREENSHOT_RETENTION_MS = 24 * 60 * 60_000;
let pruned: Promise<void> | undefined;
// 截图只由 CLI 写入且以 UUID 命名；清理只动这类文件，失败不影响本次输出。
async function pruneScreenshots(directory: string): Promise<void> {
  const cutoff = Date.now() - SCREENSHOT_RETENTION_MS;
  const names = await readdir(directory).catch(() => []);
  await Promise.all(
    names
      .filter(name => /^[0-9a-f-]{36}\.(png|jpg)$/.test(name))
      .map(async name => {
        const path = join(directory, name);
        if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
      })
      .map(task => task.catch(() => {})),
  );
}

const help = `Computer Use ${VERSION} — local desktop runtime

computer-use pair --name "My Agent" --app com.apple.TextEdit [--browser]
computer-use <method> --json '<JSON>' [--profile default]
computer-use call <method> --input request.json
computer-use schema <method>
computer-use mcp stdio [--profile default]
computer-use config stdio
computer-use config codex [--profile default]
computer-use config http --out private-config.json
computer-use browser install
computer-use credentials remove [--profile default]

Methods: ${Object.keys(schemas).join(', ')}

Global options: --socket PATH, --profile NAME
Pairing requires local app approval. Enable HTTP in the app before using its
loopback endpoint. Credentials are stored in private files, never printed.
CLI operation does not depend on MCP. Images are written to private files.
`;
const credentialSchema = z.object({ clientId: z.string(), token: z.string().min(20) });
const pairResultSchema = credentialSchema;
function commandLine() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        socket: { type: 'string' },
        profile: { type: 'string', default: 'default' },
        name: { type: 'string' },
        app: { type: 'string', multiple: true },
        browser: { type: 'boolean' },
        json: { type: 'string' },
        input: { type: 'string' },
        out: { type: 'string' },
      },
    });
  } catch (error) {
    // 参数错误也走统一的 JSON 错误输出，而不是打印 Node 堆栈。
    const detail = error instanceof Error ? `${error.message} ` : '';
    throw new CuError('invalid_request', `${detail}Use --help.`);
  }
}
let submittedRequestId: string | undefined;

async function main(): Promise<void> {
  const { values, positionals } = commandLine();
  if (values.help || positionals.length === 0) {
    process.stdout.write(help);
    return;
  }
  const profile = values.profile!;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new CuError('invalid_request', 'Invalid profile name.');
  const credentialsPath = join(credentialDir, `${profile}.json`);
  const command = positionals[0]!;
  if (command === 'schema') {
    const method = positionals[1];
    if (!method || !Object.hasOwn(schemas, method)) throw new CuError('invalid_request', 'Unknown method.');
    process.stdout.write(JSON.stringify(z.toJSONSchema(schemas[method as Method]), null, 2) + '\n');
    return;
  }
  if (command === 'browser' && positionals[1] === 'install') {
    const modulePath = fileURLToPath(import.meta.resolve('playwright/package.json'));
    const status = await new Promise<number>((resolveStatus, reject) => {
      const child = spawn(process.execPath, [join(dirname(modulePath), 'cli.js'), 'install', 'chromium'], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      child.on('error', reject);
      child.on('exit', code => resolveStatus(code ?? 1));
    });
    process.exitCode = status;
    return;
  }
  if (command === 'credentials' && positionals[1] === 'remove') {
    await rm(credentialsPath, { force: true });
    process.stdout.write(
      JSON.stringify({ removed: profile, note: 'Revoke the client in the local app to invalidate copied credentials.' }) + '\n',
    );
    return;
  }
  // 只在需要运行时的命令里解析 IPC 路径：Windows 上生成配置不应要求托盘程序正在运行。
  const connect = async () => new IpcClient(values.socket ?? (await defaultIpcPath()));
  if (command === 'pair') {
    if ((await readJson(credentialsPath)) !== undefined)
      throw new CuError('invalid_request', 'Profile already exists; choose another profile or remove it explicitly.');
    const client = await connect();
    const result = pairResultSchema.parse(
      await client.call(undefined, 'pair', { name: values.name ?? profile, appIds: values.app ?? [], browser: values.browser ?? false }),
    );
    await privateDirectory(credentialDir);
    await atomicJson(credentialsPath, result);
    process.stdout.write(JSON.stringify({ clientId: result.clientId, profile, paired: true }) + '\n');
    return;
  }
  const credential = credentialSchema.safeParse(await readJson(credentialsPath));
  if (!credential.success) throw new CuError('unauthorized', 'No valid credential profile. Run computer-use pair first.');
  if (command === 'mcp' && positionals[1] === 'stdio') {
    const { runStdio } = await import('./mcp.js');
    await runStdio(await connect(), credential.data.token);
    return;
  }
  if (command === 'config') {
    if (positionals[1] === 'stdio' || positionals[1] === 'codex') {
      const entrypoint = resolve(process.argv[1]!);
      // Source builds use Node; installed wrappers can use this equally portable configuration.
      const settings = {
        command: process.execPath,
        args: [entrypoint, 'mcp', 'stdio', '--profile', profile, ...(values.socket ? ['--socket', values.socket] : [])],
      };
      if (positionals[1] === 'codex') {
        // JSON string literals are also valid TOML basic strings for these paths and arguments.
        process.stdout.write(
          `[mcp_servers.computer-use]\ncommand = ${JSON.stringify(settings.command)}\nargs = [${settings.args.map(arg => JSON.stringify(arg)).join(', ')}]\n`,
        );
      } else process.stdout.write(JSON.stringify({ mcpServers: { 'computer-use': settings } }, null, 2) + '\n');
      return;
    }
    if (positionals[1] === 'http' && values.out) {
      const path = resolve(values.out);
      if (process.platform === 'win32') {
        // chmod is not a Windows access-control boundary. The tray host protects
        // its data directory with a current-user ACL before publishing the pipe.
        const parent = await realpath(dirname(path));
        if (parent !== (await realpath(dataDir))) {
          throw new CuError('invalid_request', 'On Windows, export HTTP credentials only into the host private data directory.');
        }
      }
      await writeFile(
        path,
        JSON.stringify(
          {
            mcpServers: {
              'computer-use': { url: 'http://127.0.0.1:47631/mcp', headers: { Authorization: `Bearer ${credential.data.token}` } },
            },
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      process.stdout.write(JSON.stringify({ configFile: path, containsCredential: true }) + '\n');
      return;
    }
    throw new CuError('invalid_request', 'Use config stdio, config codex, or config http --out <new-private-file>.');
  }
  const method = command === 'call' ? positionals[1] : command;
  if (!method || !Object.hasOwn(schemas, method)) throw new CuError('invalid_request', 'Unknown command; use --help.');
  if (values.json && values.input) throw new CuError('invalid_request', 'Choose --json or --input.');
  const raw = values.input ? await readFile(resolve(values.input), 'utf8') : (values.json ?? '{}');
  let params: unknown;
  try {
    params = JSON.parse(raw) as unknown;
  } catch {
    throw new CuError('invalid_request', 'Input is not valid JSON.');
  }
  if (method === 'act' && params !== null && typeof params === 'object' && !Array.isArray(params)) {
    const object = params as Record<string, unknown>;
    object.requestId ??= randomUUID();
    if (typeof object.requestId === 'string') submittedRequestId = object.requestId;
  }
  const result = await (await connect()).call(credential.data.token, method, params);
  async function materialize(input: unknown): Promise<unknown> {
    if (Array.isArray(input)) return Promise.all(input.map(materialize));
    if (!input || typeof input !== 'object') return input;
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const image =
        key === 'screenshot' ? z.object({ data: z.string(), mimeType: z.enum(['image/png', 'image/jpeg']) }).safeParse(value) : undefined;
      if (image?.success) {
        const directory = join(credentialDir, 'screenshots');
        await privateDirectory(directory);
        pruned ??= pruneScreenshots(directory);
        await pruned;
        const path = join(directory, `${randomUUID()}.${image.data.mimeType === 'image/png' ? 'png' : 'jpg'}`);
        await writeFile(path, Buffer.from(image.data.data, 'base64'), { mode: 0o600, flag: 'wx' });
        output[key] = { mimeType: image.data.mimeType, path };
      } else output[key] = await materialize(value);
    }
    return output;
  }
  process.stdout.write(JSON.stringify(await materialize(result)) + '\n');
}
try {
  await main();
} catch (error) {
  process.stderr.write(
    JSON.stringify({ error: errorResult(error), ...(submittedRequestId ? { requestId: submittedRequestId } : {}) }) + '\n',
  );
  process.exitCode = 1;
}
