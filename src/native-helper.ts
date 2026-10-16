import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { CuError } from './contracts.js';

const execFileAsync = promisify(execFile);
// 辅助模式的输出都很小；超过上限说明输出异常，直接放弃。
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const IDLE_MS = 5_000;

/** 由同包宿主进程提供的本机能力：用户最近一次输入距今的时间。 */
export interface NativeHelper {
  /** 距离用户最近一次键盘或鼠标输入的毫秒数；读不到时为 undefined。 */
  inputIdleMs(): Promise<number | undefined>;
}

const idleSchema = z.object({ idleMs: z.number().finite().nonnegative() });

/** 运行一次辅助模式，返回它的输出。 */
function run(binary: string, args: string[], milliseconds: number): Promise<string> {
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: CuError, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(output!);
    };
    const timer = setTimeout(() => finish(new CuError('unavailable', 'The local helper did not finish in time.')), milliseconds);
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
    child.stdin.end();
  });
}

/** 用同包宿主可执行文件的辅助模式提供本机能力。路径必须来自已校验的完整包布局。 */
export function createNativeHelper(hostBinary: string, platform: NodeJS.Platform = process.platform): NativeHelper {
  return {
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
        const output = await run(hostBinary, ['--input-idle'], IDLE_MS);
        return idleSchema.parse(JSON.parse(output)).idleMs;
      } catch {
        return undefined;
      }
    },
  };
}
