import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { z } from 'zod';
import { CuError, type Screenshot, type TextLine } from './contracts.js';

const execFileAsync = promisify(execFile);
// 识别结果和剪贴板会话的回复都很小；超过上限说明输出异常，直接放弃。
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const RECOGNIZE_MS = 15_000;
// 一台 Mac 第一次识别文字时，系统要先准备识别模型（实测约 50 秒），之后每次只要几百毫秒。
// 调用方超时后让识别进程继续运行到这个上限，中途结束会让下一次从头准备。
const RECOGNIZE_LIMIT_MS = 120_000;
const STAGE_MS = 20_000;
const FINISH_MS = 10_000;
const IDLE_MS = 5_000;
const RECOGNIZE_TIMEOUT =
  'Text recognition did not finish in time. The first use on a computer can take about a minute while the system prepares its text model; try again shortly, or read the screenshot instead.';
const RECOGNIZE_BUSY =
  'Text recognition is still finishing an earlier request (the first use on a computer can take about a minute); try again shortly, or read the screenshot instead.';

/** 一次粘贴的剪贴板会话：先暂存用户的剪贴板并写入要粘贴的文字，粘贴后再恢复。 */
export interface PasteSession {
  /** 暂存剪贴板（restore 为 false 时不读取）并写入文字。失败时剪贴板保持原样。 */
  stage(text: string, restore: boolean): Promise<{ complete: boolean }>;
  /** 等待 delayMs 后恢复剪贴板；期间用户复制了新内容时保留新内容。 */
  finish(delayMs: number): Promise<{ restored: boolean }>;
  /** 立即结束：已写入的文字尽量换回用户原来的内容。 */
  abort(): void;
}

/** 由同包宿主进程提供的本机能力：截图文字识别、剪贴板会话、用户最近一次输入距今的时间。 */
export interface NativeHelper {
  recognizeText(image: Screenshot, signal?: AbortSignal): Promise<TextLine[]>;
  /** 在后台识别一张内置示例图，提前完成系统第一次识别时的模型准备。不需要时什么也不做。 */
  warmUp(): void;
  openPasteSession(): Promise<PasteSession>;
  /** 距离用户最近一次键盘或鼠标输入的毫秒数；读不到时为 undefined。 */
  inputIdleMs(): Promise<number | undefined>;
}

const lineSchema = z.object({
  text: z.string().max(10_000),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
const recognizedSchema = z.object({ lines: z.array(lineSchema).max(10_000) });
const replySchema = z.object({
  ok: z.boolean(),
  code: z.string().max(64).optional(),
  complete: z.boolean().optional(),
  restored: z.boolean().optional(),
});
const idleSchema = z.object({ idleMs: z.number().finite().nonnegative() });

// 宿主辅助模式的固定错误码换成可读的说明；不转述辅助进程自己的文字。
const stageMessages: Record<string, string> = {
  read_denied:
    'Computer Use could not read the clipboard (the user or the system declined), so it could not keep what the user copied; nothing was pasted. Tell the user, or pass restoreClipboard: false after telling them their clipboard will be overwritten.',
  write_failed: 'The clipboard could not be written; nothing was pasted.',
};

type RunOptions = {
  input?: Buffer | undefined;
  milliseconds: number;
  signal?: AbortSignal | undefined;
  timeoutMessage?: string;
  // 调用方超时或取消后，子进程最多再运行到启动后的这个时刻；默认立即结束。
  limitMs?: number;
};

/** 运行一次辅助模式。result 是输出；exited 在子进程结束（或被结束）后完成。 */
function run(binary: string, args: string[], options: RunOptions): { result: Promise<string>; exited: Promise<void> } {
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const exited = new Promise<void>(resolve => {
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
  const result = new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: CuError, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) {
        const remaining = (options.limitMs ?? 0) - (Date.now() - started);
        if (remaining > 0) setTimeout(() => child.kill(), remaining).unref();
        else child.kill();
        reject(error);
      } else resolve(output!);
    };
    const started = Date.now();
    const onAbort = () => finish(new CuError('cancelled', 'Operation cancelled.'));
    const timer = setTimeout(
      () => finish(new CuError('unavailable', options.timeoutMessage ?? 'The local helper did not finish in time.')),
      options.milliseconds,
    );
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', () => finish(new CuError('unavailable', 'The local helper could not be started.')));
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) finish(new CuError('unavailable', 'The local helper returned too much output.'));
      else chunks.push(chunk);
    });
    child.on('close', code => {
      if (code === 0) finish(undefined, Buffer.concat(chunks).toString('utf8'));
      else finish(new CuError('unavailable', 'The local helper failed.'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
  return { result, exited };
}

class HelperPasteSession implements PasteSession {
  private readonly replies: Array<(value: unknown) => void> = [];
  private ended = false;
  constructor(private readonly child: ReturnType<typeof spawn>) {
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', line => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        value = undefined;
      }
      this.replies.shift()?.(value);
    });
    child.on('close', () => {
      this.ended = true;
      for (const reply of this.replies.splice(0)) reply(undefined);
    });
    child.on('error', () => {});
    child.stdin!.on('error', () => {});
  }
  private request(message: object, milliseconds: number): Promise<z.infer<typeof replySchema>> {
    if (this.ended) return Promise.reject(new CuError('unavailable', 'The clipboard helper is not running.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.abort();
        reject(new CuError('unavailable', 'The clipboard helper did not answer in time.'));
      }, milliseconds);
      this.replies.push(value => {
        clearTimeout(timer);
        const parsed = replySchema.safeParse(value);
        if (parsed.success) resolve(parsed.data);
        else reject(new CuError('unavailable', 'The clipboard helper stopped unexpectedly.'));
      });
      this.child.stdin!.write(`${JSON.stringify(message)}\n`);
    });
  }
  async stage(text: string, restore: boolean): Promise<{ complete: boolean }> {
    const reply = await this.request({ op: 'stage', text, restore }, STAGE_MS);
    if (!reply.ok) {
      this.abort();
      throw new CuError(
        reply.code === 'read_denied' ? 'permission_denied' : 'unavailable',
        stageMessages[reply.code ?? ''] ?? 'The clipboard could not be prepared; nothing was pasted.',
      );
    }
    return { complete: reply.complete !== false };
  }
  async finish(delayMs: number): Promise<{ restored: boolean }> {
    const reply = await this.request({ op: 'finish', delayMs }, delayMs + FINISH_MS);
    this.child.stdin!.end();
    return { restored: reply.ok && reply.restored === true };
  }
  abort(): void {
    // 关闭输入即请求辅助进程立刻恢复并退出。
    if (!this.ended) this.child.stdin!.end();
  }
}

/** 用同包宿主可执行文件的辅助模式提供本机能力。路径必须来自已校验的完整包布局。 */
export function createNativeHelper(
  hostBinary: string,
  platform: NodeJS.Platform = process.platform,
  limits: { recognizeMs?: number } = {},
): NativeHelper {
  const recognizeMs = limits.recognizeMs ?? RECOGNIZE_MS;
  // 还在运行、但已经没有调用方等待结果的识别进程（预热，或调用方超时后留下的）。
  // 新请求先等它结束：模型已就绪时只要几百毫秒；首次准备模型时不再并发启动第二个。
  let lingering: Promise<void> | undefined;
  const linger = (exited: Promise<void>) => {
    const pending: Promise<void> = exited.then(() => {
      if (lingering === pending) lingering = undefined;
    });
    lingering = pending;
  };
  const settled = async (signal?: AbortSignal) => {
    const pending = lingering;
    if (!pending) return;
    if (signal?.aborted) throw new CuError('cancelled', 'Operation cancelled.');
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const finished = await Promise.race([
        pending.then(() => true),
        new Promise<boolean>((resolve, reject) => {
          timer = setTimeout(() => resolve(false), recognizeMs);
          onAbort = () => reject(new CuError('cancelled', 'Operation cancelled.'));
          signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      if (!finished) throw new CuError('unavailable', RECOGNIZE_BUSY);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  };
  return {
    async recognizeText(image, signal) {
      await settled(signal);
      const { result, exited } = run(hostBinary, ['--recognize-text'], {
        input: Buffer.from(image.data, 'base64'),
        milliseconds: recognizeMs,
        signal,
        timeoutMessage: RECOGNIZE_TIMEOUT,
        limitMs: RECOGNIZE_LIMIT_MS,
      });
      let output: string;
      try {
        output = await result;
      } catch (error) {
        linger(exited);
        throw error;
      }
      let parsed: z.infer<typeof recognizedSchema>;
      try {
        parsed = recognizedSchema.parse(JSON.parse(output));
      } catch {
        throw new CuError('unavailable', 'Text recognition returned an invalid result.');
      }
      return parsed.lines.map(({ text, ...bounds }) => ({ text, bounds }));
    },
    warmUp() {
      // 只有 macOS 的识别器需要在本机先编译模型；Windows 的系统识别器不需要预热。
      if (platform !== 'darwin' || lingering) return;
      const { result, exited } = run(hostBinary, ['--recognize-text'], { milliseconds: RECOGNIZE_LIMIT_MS });
      result.catch(() => {});
      linger(exited);
    },
    async openPasteSession() {
      const child = spawn(hostBinary, ['--paste-session'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      return new HelperPasteSession(child);
    },
    async inputIdleMs() {
      try {
        if (platform === 'darwin') {
          // HIDIdleTime 是距离最近一次硬件输入的纳秒数；读取不需要额外权限。
          const { stdout } = await execFileAsync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], {
            timeout: IDLE_MS,
            maxBuffer: OUTPUT_LIMIT,
          });
          const match = /"HIDIdleTime" = (\d+)/.exec(stdout);
          return match ? Number(BigInt(match[1]!) / 1_000_000n) : undefined;
        }
        const output = await run(hostBinary, ['--input-idle'], { milliseconds: IDLE_MS }).result;
        return idleSchema.parse(JSON.parse(output)).idleMs;
      } catch {
        return undefined;
      }
    },
  };
}
