import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeHelper } from './native-helper.js';

const image = { mimeType: 'image/png' as const, data: Buffer.from('fake image').toString('base64') };

// 宿主辅助模式的替身：一个按参数行事的 Node 脚本。Windows 不能直接执行脚本，只在 POSIX 上测。
describe.skipIf(process.platform === 'win32')('native helper process protocol', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cu-native-helper-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  async function helper(body: string): Promise<string> {
    const path = join(directory, `helper-${Math.random().toString(16).slice(2)}`);
    await writeFile(path, `#!${process.execPath}\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  it('maps recognized lines and rejects malformed output', async () => {
    const good = createNativeHelper(
      await helper(
        `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ lines: [{ text: 'ls -la', x: 1.5, y: 2, width: 30, height: 10 }] })));`,
      ),
    );
    await expect(good.recognizeText(image)).resolves.toEqual([{ text: 'ls -la', bounds: { x: 1.5, y: 2, width: 30, height: 10 } }]);
    const bad = createNativeHelper(
      await helper(`process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{"lines":"x"}'));`),
    );
    await expect(bad.recognizeText(image)).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('invalid') });
  });

  it('lets an abandoned recognition finish before starting another one', async () => {
    // 首次使用时系统准备识别模型很慢：调用方放弃后识别进程继续运行，新的请求先等它，等不到就报告忙。
    const marker = join(directory, 'prepared');
    const slow = createNativeHelper(
      await helper(`
const fs = require('node:fs');
const first = !fs.existsSync(${JSON.stringify(marker)});
if (first) fs.writeFileSync(${JSON.stringify(marker)}, '');
process.stdin.resume();
process.stdin.on('end', () => setTimeout(() => process.stdout.write(JSON.stringify({ lines: [] })), first ? 4000 : 0));`),
      'darwin',
      // 留足进程启动时间：机器繁忙时启动 Node 也可能要一秒以上。
      { recognizeMs: 2_500 },
    );
    const controller = new AbortController();
    const first = slow.recognizeText(image, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(first).rejects.toMatchObject({ code: 'cancelled' });
    await expect(slow.recognizeText(image)).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('still finishing'),
    });
    await vi.waitFor(async () => expect(await slow.recognizeText(image)).toEqual([]), { timeout: 10_000, interval: 200 });
  }, 15_000);

  it('warms the recognizer up on macOS and makes the next request wait for it', async () => {
    const log = join(directory, 'calls.log');
    const script = await helper(`
const fs = require('node:fs');
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const warm = Buffer.concat(chunks).length === 0;
  setTimeout(() => {
    fs.appendFileSync(${JSON.stringify(log)}, warm ? 'warm\\n' : 'image\\n');
    process.stdout.write(JSON.stringify({ lines: [] }));
  }, warm ? 300 : 0);
});`);
    const windows = createNativeHelper(script, 'win32');
    windows.warmUp();
    const mac = createNativeHelper(script, 'darwin');
    mac.warmUp();
    mac.warmUp();
    await expect(mac.recognizeText(image)).resolves.toEqual([]);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['warm', 'image']);
  });
});
