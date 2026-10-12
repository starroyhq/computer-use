import { spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CuError, type RpcService } from './contracts.js';
import { IpcClient } from './ipc.js';
import { defaultIpcPath } from './paths.js';

const READY_TIMEOUT_MS = 35_000;
const HELPER_TIMEOUT_MS = 40_000;
const MAX_HELPER_OUTPUT = 8 * 1024;
const helperResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), state: z.literal('ready') }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(['paused', 'stopped', 'failed', 'non_interactive', 'timeout', 'launch_failed', 'permissions_required']),
      message: z.string().min(1).max(1024),
    })
    .strict(),
]);

function systemCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'UNKNOWN';
}

// 只信任正在执行的完整包布局；不从 PATH、注册表或当前工作目录寻找宿主。
export async function bundledWindowsHost(modulePath: string, entrypoint: string, executable: string): Promise<string> {
  try {
    const module = await realpath(modulePath);
    const runtime = dirname(module);
    if (basename(runtime) !== 'runtime') throw new Error('Not a packaged runtime.');
    const root = dirname(runtime);
    const host = join(root, 'ComputerUse.WindowsHost.exe');
    const paths: Array<[string, string]> = [
      [module, join(runtime, 'runtime-client.js')],
      [resolve(entrypoint), join(runtime, 'cli.js')],
      [executable, join(root, 'bin', 'node.exe')],
      [host, host],
    ];
    for (const [actual, expected] of paths) {
      if ((await realpath(actual)) !== expected || !(await stat(actual)).isFile()) throw new Error('Package paths do not match.');
    }
    const receipt = z
      .object({ owner: z.string(), arch: z.enum(['win-arm64', 'win-x64']) })
      .parse(JSON.parse(await readFile(join(root, 'build-receipt.json'), 'utf8')));
    if (receipt.owner !== `computer-use-windows-${receipt.arch.slice(4)}-package-v1`) throw new Error('Invalid package receipt.');
    return host;
  } catch (error) {
    throw new CuError(
      'unavailable',
      `Cannot locate the Windows host in this CLI's verified bundle (${systemCode(error)}). Use the packaged bin/node.exe and runtime/cli.js, or open the local app manually.`,
    );
  }
}

export async function bundledMacHost(modulePath: string, entrypoint: string, executable: string): Promise<string> {
  try {
    const module = await realpath(modulePath);
    const runtime = dirname(module);
    const resources = dirname(runtime);
    const contents = dirname(resources);
    if (basename(runtime) !== 'runtime' || basename(resources) !== 'Resources' || basename(contents) !== 'Contents')
      throw new Error('Not a packaged runtime.');
    const host = join(contents, 'MacOS', 'ComputerUseHost');
    for (const [actual, expected] of [
      [module, join(runtime, 'runtime-client.js')],
      [resolve(entrypoint), join(runtime, 'cli.js')],
      [executable, join(resources, 'bin', 'node')],
      [host, host],
    ] as const) {
      if ((await realpath(actual)) !== expected || !(await stat(actual)).isFile()) throw new Error('Package paths do not match.');
    }
    const receipt = JSON.parse(await readFile(join(resources, 'build-receipt.json'), 'utf8'));
    if (receipt.owner !== 'computer-use-package-v1' || receipt.arch !== 'arm64') throw new Error('Invalid package receipt.');
    // The packager preserves our XML plist. Reject other representations instead of guessing an application by bundle id.
    const plist = await readFile(join(contents, 'Info.plist'), 'utf8');
    if (
      !/<key>CFBundleIdentifier<\/key>\s*<string>com\.starroy\.computeruse<\/string>/.test(plist) ||
      !/<key>CFBundleExecutable<\/key>\s*<string>ComputerUseHost<\/string>/.test(plist)
    )
      throw new Error('Invalid application identity.');
    return host;
  } catch (error) {
    throw new CuError(
      'unavailable',
      `Cannot locate the macOS host in this CLI's verified bundle (${systemCode(error)}). Use the installed app's CLI, or open the local app manually.`,
    );
  }
}

// 探测不发送 RPC，因此不会配对、恢复暂停或派发动作。
export function probeRuntimePipe(path: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveProbe, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => finish(false), timeoutMs);
    let complete = false;
    function finish(ready: boolean, error?: Error) {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolveProbe(ready);
    }
    socket.once('connect', () => finish(true));
    socket.once('error', error => {
      const code = systemCode(error);
      if (['ENOENT', 'ECONNREFUSED', 'EBUSY'].includes(code)) finish(false);
      else finish(false, new CuError('unavailable', `Cannot probe the runtime endpoint (${code}). Check the local app.`));
    });
    socket.once('close', () => finish(false));
  });
}

export function ensureWindowsHost(host: string, timeoutMs = HELPER_TIMEOUT_MS): Promise<void> {
  return ensurePackagedHost(host, 'Windows', timeoutMs);
}

export function ensureMacHost(host: string, timeoutMs = HELPER_TIMEOUT_MS): Promise<void> {
  return ensurePackagedHost(host, 'macOS', timeoutMs);
}

function ensurePackagedHost(host: string, platform: string, timeoutMs: number): Promise<void> {
  return new Promise((resolveStart, reject) => {
    // 一次性 helper 等待就绪；长期后台宿主由 native 创建。
    const child = spawn(host, ['--ensure-running'], {
      cwd: dirname(host),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith('DYLD_') && !key.startsWith('NODE_') && !key.startsWith('CUA_') && key !== 'CU_RESOURCES_DIR',
        ),
      ),
    });
    let output = Buffer.alloc(0);
    let complete = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let outputEnded = false;
    const timer = setTimeout(() => {
      if (exited) invalidResponse();
      else {
        child.kill();
        finish(new CuError('timeout', `${platform} host startup helper timed out. Check the local app; no request was sent.`));
      }
    }, timeoutMs);
    function finish(error?: Error) {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      // 旧宿主可能把 stdout 的额外可继承句柄传给 GUI；close 会等到 GUI 退出。
      // exit 与完整结果已足以判定 helper，本地读端必须同时释放。
      child.stdout.destroy();
      if (error) reject(error);
      else resolveStart();
    }
    function exitDescription(): string {
      return exited?.signal ? `signal ${exited.signal}` : `exit ${exited?.code}`;
    }
    function invalidResponse() {
      finish(
        new CuError(
          'unavailable',
          `${platform} host startup helper returned an invalid response (${exitDescription()}). Check the local app.`,
        ),
      );
    }
    child.once('error', error => finish(new CuError('unavailable', `Cannot launch the ${platform} host (${systemCode(error)}).`)));
    child.stdout.on('data', (chunk: Buffer) => {
      if (complete) return;
      if (output.length + chunk.length > MAX_HELPER_OUTPUT) {
        if (!exited) child.kill();
        finish(new CuError('unavailable', `${platform} host startup helper exceeded its response limit.`));
      } else {
        output = Buffer.concat([output, chunk]);
        settle();
      }
    });
    child.stdout.once('error', error =>
      finish(new CuError('unavailable', `Cannot read the ${platform} host startup response (${systemCode(error)}).`)),
    );
    child.stdout.once('end', () => {
      outputEnded = true;
      settle();
    });
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      settle();
    });
    child.once('close', () => {
      outputEnded = true;
      settle();
    });
    function settle() {
      if (complete || !exited) return;
      const newline = output.indexOf(10);
      if (newline < 0) {
        if (outputEnded) invalidResponse();
        return;
      }
      let result: z.infer<typeof helperResult>;
      try {
        const line = output.subarray(0, newline).toString('utf8').replace(/\r$/, '');
        if (newline !== output.length - 1 || line.includes('\r')) throw new Error('Multiple lines.');
        result = helperResult.parse(JSON.parse(line));
      } catch {
        invalidResponse();
        return;
      }
      if (!result.ok) {
        const message = result.message.replace(/\p{Cc}/gu, ' ');
        finish(
          new CuError(
            result.code === 'paused' ? 'paused' : result.code === 'timeout' ? 'timeout' : 'unavailable',
            `${platform} host startup ${result.code} (${exitDescription()}): ${message}`,
          ),
        );
      } else if (exited.code !== 0) finish(new CuError('unavailable', `${platform} host startup helper failed (${exitDescription()}).`));
      else finish();
    }
  });
}

// 可注入平台和本地依赖以测试冷启动，无需改变实际用户的宿主或授权。
export interface RuntimeClientOptions {
  platform?: NodeJS.Platform;
  modulePath?: string;
  entrypoint?: string;
  executable?: string;
  defaultPath?: () => Promise<string>;
  probe?: typeof probeRuntimePipe;
  launch?: typeof ensureWindowsHost;
  readyTimeoutMs?: number;
  helperTimeoutMs?: number;
  retryMs?: number;
}

export function createRuntimeClient(socket?: string, options: RuntimeClientOptions = {}): RpcService {
  const discover = options.defaultPath ?? defaultIpcPath;
  if (socket !== undefined) return new IpcClient(socket);
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' && platform !== 'darwin') {
    return { call: async (token, method, params) => new IpcClient(await discover()).call(token, method, params) };
  }
  const probe = options.probe ?? probeRuntimePipe;
  let preparing: Promise<string> | undefined;
  async function prepare(): Promise<string> {
    const deadline = Date.now() + (options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    async function available(): Promise<string | undefined> {
      let path: string;
      try {
        path = await discover();
      } catch (error) {
        if (error instanceof CuError && error.code === 'unavailable') return undefined;
        throw error;
      }
      return (await probe(path, Math.max(1, Math.min(250, deadline - Date.now())))) ? path : undefined;
    }
    const existing = await available();
    if (existing) return existing;
    const host = await (platform === 'win32' ? bundledWindowsHost : bundledMacHost)(
      options.modulePath ?? fileURLToPath(import.meta.url),
      options.entrypoint ?? process.argv[1] ?? '',
      options.executable ?? process.execPath,
    );
    await (options.launch ?? (platform === 'win32' ? ensureWindowsHost : ensureMacHost))(
      host,
      options.helperTimeoutMs ?? HELPER_TIMEOUT_MS,
    );
    // helper 的退出码不能替代管道就绪；每次重读以覆盖冷启动和手动重启更换 pipe 的情形。
    do {
      const path = await available();
      if (path) return path;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(options.retryMs ?? 200, remaining));
    } while (Date.now() < deadline);
    throw new CuError('unavailable', 'Runtime did not become ready. Check the local app; no request was sent.');
  }
  return {
    async call(token, method, params) {
      preparing ??= prepare().finally(() => {
        preparing = undefined;
      });
      const path = await preparing;
      // 就绪之后仍可能断线；只发一次业务 RPC，不重放 act，也不重试暂停或撤销错误。
      return new IpcClient(path).call(token, method, params);
    },
  };
}
