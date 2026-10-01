import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdate, compareVersions, downloadUpdate, updatePlatform, type UpdateOptions } from './update.js';

const RELEASE_PATH = '/repos/starroyhq/computer-use/releases/latest';
const WEB_LATEST_PATH = '/starroyhq/computer-use/releases/latest';
const NOTES_PATH = '/raw/starroyhq/computer-use/v0.5.0/.github/release-notes/v0.5.0.md';
const RELEASE_NOTES = '## 更新\r\n- 修复\u0007\u202e问题';
const zipName = 'computer-use-0.5.0-macos-arm64.zip';
let server: Server;
let base: string;
let directory: string;
// 每个用例可改写：发布信息、各文件内容，以及按路径返回的特殊响应。
let release: { status: number; body: string };
// 发布页 /releases/latest 的响应：GitHub 用 302 跳到最新正式版的标签页。
let web: { status: number; location?: string };
let files: Map<string, Buffer>;
let routes: Map<string, (response: import('node:http').ServerResponse) => void>;
let packageBytes: Buffer;

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}
function metadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '0.5.0',
    platform: 'macos-arm64',
    commit: 'a'.repeat(40),
    sourceDirty: false,
    archive: zipName,
    bytes: packageBytes.length,
    sha256: sha256(packageBytes),
    signing: 'developer-id-notarized',
    notarization: 'stapled',
    verification: 'test',
    ...overrides,
  });
}
function releaseBody(overrides: Record<string, unknown> = {}, assetOverrides: Record<string, unknown> = {}): string {
  const asset = (name: string, content: Buffer | string, extra: Record<string, unknown> = {}) => ({
    name,
    size: Buffer.byteLength(content),
    browser_download_url: `${base}/downloads/v0.5.0/${name}`,
    ...extra,
  });
  return JSON.stringify({
    tag_name: 'v0.5.0',
    html_url: 'https://github.com/starroyhq/computer-use/releases/tag/v0.5.0',
    draft: false,
    prerelease: false,
    published_at: '2026-10-01T08:00:00Z',
    body: RELEASE_NOTES,
    assets: [
      asset(zipName, packageBytes, { digest: `sha256:${sha256(packageBytes)}`, ...assetOverrides }),
      asset(`${zipName}.sha256`, files.get(`${zipName}.sha256`)!),
      asset('computer-use-0.5.0-macos-arm64.json', files.get('computer-use-0.5.0-macos-arm64.json')!),
      asset('computer-use-0.5.0-windows-x64.zip', 'other platform'),
    ],
    ...overrides,
  });
}
const options = (overrides: Partial<UpdateOptions> = {}): UpdateOptions => ({
  current: '0.4.0',
  platform: 'macos-arm64',
  apiBase: base,
  webBase: base,
  rawBase: `${base}/raw`,
  downloadBase: `${base}/downloads`,
  trustedOrigins: [base],
  ...overrides,
});

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', base);
    const special = routes.get(url.pathname);
    if (special) return special(response);
    if (url.pathname === RELEASE_PATH) {
      response.writeHead(release.status, { 'Content-Type': 'application/json' }).end(release.body);
      return;
    }
    if (url.pathname === WEB_LATEST_PATH) {
      response.writeHead(web.status, web.location ? { Location: web.location } : {}).end();
      return;
    }
    if (url.pathname === NOTES_PATH) {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(RELEASE_NOTES);
      return;
    }
    const name = decodeURIComponent(url.pathname.replace('/downloads/v0.5.0/', ''));
    const content = url.pathname.startsWith('/downloads/v0.5.0/') ? files.get(name) : undefined;
    if (!content) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Length': content.length }).end(content);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cu-update-test-'));
  packageBytes = randomBytes(200_000);
  routes = new Map();
  files = new Map();
  files.set(zipName, packageBytes);
  files.set(`${zipName}.sha256`, Buffer.from(`${sha256(packageBytes)}  ${zipName}\n`));
  files.set('computer-use-0.5.0-macos-arm64.json', Buffer.from(metadata()));
  release = { status: 200, body: releaseBody() };
  web = { status: 302, location: `${base}/starroyhq/computer-use/releases/tag/v0.5.0` };
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('release versions and platforms', () => {
  it('compares plain versions numerically and names the installed platform package', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.4.0', '0.4.1')).toBe(-1);
    expect(() => compareVersions('0.5.0-beta.1', '0.4.0')).toThrow();
    expect(updatePlatform('darwin', 'arm64')).toBe('macos-arm64');
    expect(updatePlatform('win32', 'arm64')).toBe('windows-arm64');
    expect(updatePlatform('win32', 'x64')).toBe('windows-x64');
    expect(() => updatePlatform('darwin', 'x64')).toThrow();
    expect(() => updatePlatform('linux', 'x64')).toThrow();
  });
});

describe('update check', () => {
  it('offers only a newer stable release and describes its package and notes as plain text', async () => {
    const check = await checkForUpdate(options());
    expect(check).toEqual({
      current: '0.4.0',
      latest: '0.5.0',
      available: true,
      platform: 'macos-arm64',
      tag: 'v0.5.0',
      url: 'https://github.com/starroyhq/computer-use/releases/tag/v0.5.0',
      publishedAt: '2026-10-01T08:00:00Z',
      notes: '## 更新\n- 修复问题',
      asset: { name: zipName, size: packageBytes.length, sha256: sha256(packageBytes) },
    });
    expect((await checkForUpdate(options({ current: '0.5.0' }))).available).toBe(false);
    // 不降级：最新正式版比当前还旧时不提供。
    expect((await checkForUpdate(options({ current: '0.6.0' }))).available).toBe(false);
    release.body = releaseBody({ prerelease: true });
    expect((await checkForUpdate(options())).available).toBe(false);
    // 最新版没有本平台的包时仍报告版本，但不提供安装包。
    release.body = releaseBody();
    expect((await checkForUpdate(options({ platform: 'windows-arm64' }))).asset).toBeUndefined();
  });

  it('reports rate limits, server errors and unexpected release data as unavailable', async () => {
    // API 与发布页都受限或出错时才报告失败。
    release = { status: 403, body: '{}' };
    web = { status: 429 };
    await expect(checkForUpdate(options())).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('rate limit') });
    release = { status: 500, body: '{}' };
    web = { status: 503 };
    await expect(checkForUpdate(options())).rejects.toMatchObject({ code: 'unavailable' });
    web = { status: 302, location: `${base}/starroyhq/computer-use/releases/tag/v0.5.0` };
    release = { status: 200, body: '{not json' };
    await expect(checkForUpdate(options())).rejects.toMatchObject({ code: 'unavailable' });
    for (const overrides of [
      { tag_name: 'v0.5.0-beta.1' },
      { tag_name: 'latest' },
      { html_url: 'https://github.com/someone/else/releases/tag/v0.5.0' },
    ]) {
      release = { status: 200, body: releaseBody(overrides) };
      await expect(checkForUpdate(options())).rejects.toMatchObject({ code: 'unavailable' });
    }
    await expect(checkForUpdate(options({ current: 'dev' }))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('never contacts a host outside the trusted list, even through a redirect', async () => {
    routes.set(RELEASE_PATH, response => response.writeHead(302, { Location: 'http://127.0.0.2:9/steal' }).end());
    await expect(checkForUpdate(options())).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('unexpected host'),
    });
    // 默认白名单只接受 GitHub 的 HTTPS 主机。
    const fetch = vi.fn(async () => new Response('{}'));
    await expect(checkForUpdate({ current: '0.4.0', platform: 'macos-arm64', fetch, apiBase: base })).rejects.toMatchObject({
      message: expect.stringContaining('unexpected host'),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back to the release page when the API is rate limited, failing or unreachable, with the same result', async () => {
    const { publishedAt: _publishedAt, ...expected } = await checkForUpdate(options());
    for (const failure of [{ status: 403 }, { status: 429 }, { status: 502 }]) {
      release = { ...failure, body: '{}' };
      expect(await checkForUpdate(options()), String(failure.status)).toEqual(expected);
    }
    // API 主机连不上时同样改读发布页。用替身模拟连接失败：Windows 上连接本机未监听端口要等约 2 秒。
    const unreachable = 'http://127.0.0.1:9';
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(input)).origin === unreachable ? Promise.reject(new TypeError('fetch failed')) : globalThis.fetch(input, init),
    );
    expect(await checkForUpdate(options({ apiBase: unreachable, trustedOrigins: [base, unreachable], fetch }))).toEqual(expected);
    expect(fetch.mock.calls.some(([input]) => new URL(String(input)).origin === unreachable)).toBe(true);
    // 没有更新时不读取发布说明。
    expect(await checkForUpdate(options({ current: '0.5.0' }))).toMatchObject({ available: false, notes: '' });

    // 发布页路径下载同样核对校验文件与元数据（没有 API 提供的摘要）。
    const result = await downloadUpdate({ ...options(), directory, expectedVersion: '0.5.0' });
    expect(result).toMatchObject({ version: '0.5.0', sha256: sha256(packageBytes), bytes: packageBytes.length });
    expect((await readFile(result.path)).equals(packageBytes)).toBe(true);
    await rm(result.path);
    files.set(zipName, randomBytes(packageBytes.length));
    await expect(downloadUpdate({ ...options(), directory })).rejects.toMatchObject({ message: expect.stringContaining('SHA-256') });
    expect(await readdir(directory)).toEqual([]);
  });

  it('reads the release page as strictly as the API', async () => {
    release = { status: 403, body: '{}' };
    const releases = `${base}/starroyhq/computer-use/releases`;
    // 还没有正式版时 GitHub 跳到发布列表。
    web = { status: 302, location: releases };
    await expect(checkForUpdate(options())).rejects.toMatchObject({ code: 'not_found' });
    for (const [location, message] of [
      [`${releases}/tag/v0.5.0-beta.1`, 'stable version tag'],
      [`${releases}/tag/latest`, 'stable version tag'],
      ['http://127.0.0.2:9/starroyhq/computer-use/releases/tag/v0.5.0', 'unexpected host'],
    ] as const) {
      web = { status: 302, location };
      await expect(checkForUpdate(options()), location).rejects.toMatchObject({
        code: 'unavailable',
        message: expect.stringContaining(message),
      });
    }
    web = { status: 200 };
    await expect(checkForUpdate(options())).rejects.toMatchObject({ code: 'unavailable' });

    web = { status: 302, location: `${releases}/tag/v0.5.0` };
    // 最新版没有本平台的包：仍报告版本，但不提供安装包。
    const windows = await checkForUpdate(options({ platform: 'windows-arm64' }));
    expect(windows).toMatchObject({ latest: '0.5.0', available: true });
    expect(windows.asset).toBeUndefined();
    await expect(downloadUpdate({ ...options({ platform: 'windows-arm64' }), directory })).rejects.toMatchObject({ code: 'not_found' });
    // 元数据描述的不是这个版本或这个包。
    for (const overrides of [{ version: '0.4.9' }, { platform: 'windows-arm64' }, { archive: 'other.zip' }, { sourceDirty: true }]) {
      files.set('computer-use-0.5.0-macos-arm64.json', Buffer.from(metadata(overrides)));
      await expect(checkForUpdate(options()), JSON.stringify(overrides)).rejects.toMatchObject({ code: 'unavailable' });
    }
  });
});

describe('update download', () => {
  it('downloads the confirmed version, checks it against the checksum, metadata and API digest, and reports progress', async () => {
    const progress = vi.fn();
    // 下载地址在可信来源内跳转一次，模拟 GitHub 跳到对象存储。
    routes.set(`/downloads/v0.5.0/${zipName}`, response => response.writeHead(302, { Location: '/storage/package' }).end());
    routes.set('/storage/package', response => response.writeHead(200).end(packageBytes));
    const result = await downloadUpdate({ ...options(), directory, expectedVersion: '0.5.0', onProgress: progress });
    expect(result).toEqual({
      version: '0.5.0',
      platform: 'macos-arm64',
      path: join(directory, zipName),
      sha256: sha256(packageBytes),
      bytes: packageBytes.length,
      signing: 'developer-id-notarized',
      commit: 'a'.repeat(40),
    });
    expect((await readFile(result.path)).equals(packageBytes)).toBe(true);
    if (process.platform !== 'win32') expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    expect(progress).toHaveBeenLastCalledWith(packageBytes.length, packageBytes.length);
    expect(await readdir(directory)).toEqual([zipName]);
  });

  it('rejects any package that does not match what the release published, leaving nothing behind', async () => {
    const cases: Array<[string, () => void, string]> = [
      ['tampered bytes', () => files.set(zipName, randomBytes(packageBytes.length)), 'SHA-256'],
      ['longer package', () => files.set(zipName, Buffer.concat([packageBytes, Buffer.from('x')])), 'larger than published'],
      [
        'checksum for another package',
        () => files.set(`${zipName}.sha256`, Buffer.from(`${sha256('other')}  ${zipName}\n`)),
        'metadata does not match',
      ],
      [
        'checksum naming another file',
        () => files.set(`${zipName}.sha256`, Buffer.from(`${sha256(packageBytes)}  other.zip\n`)),
        'checksum file',
      ],
      [
        'unsigned macOS metadata',
        () => files.set('computer-use-0.5.0-macos-arm64.json', Buffer.from(metadata({ signing: 'unsigned' }))),
        'metadata',
      ],
      ['dirty source', () => files.set('computer-use-0.5.0-macos-arm64.json', Buffer.from(metadata({ sourceDirty: true }))), 'metadata'],
      [
        'metadata for another version',
        () => files.set('computer-use-0.5.0-macos-arm64.json', Buffer.from(metadata({ version: '0.4.9' }))),
        'metadata',
      ],
      ['API digest mismatch', () => (release.body = releaseBody({}, { digest: `sha256:${sha256('other')}` })), 'digest'],
      [
        'asset hosted elsewhere',
        () => (release.body = releaseBody({}, { browser_download_url: `${base}/downloads/v0.4.0/${zipName}` })),
        'unexpected location',
      ],
    ];
    for (const [name, arrange, message] of cases) {
      files.set(zipName, packageBytes);
      files.set(`${zipName}.sha256`, Buffer.from(`${sha256(packageBytes)}  ${zipName}\n`));
      files.set('computer-use-0.5.0-macos-arm64.json', Buffer.from(metadata()));
      release.body = releaseBody();
      arrange();
      await expect(downloadUpdate({ ...options(), directory }), name).rejects.toMatchObject({
        message: expect.stringContaining(message),
      });
      expect(await readdir(directory), name).toEqual([]);
    }
  });

  it('refuses when there is nothing newer, the release changed, or the destination is not usable', async () => {
    await expect(downloadUpdate({ ...options({ current: '0.5.0' }), directory })).rejects.toMatchObject({
      message: expect.stringContaining('up to date'),
    });
    await expect(downloadUpdate({ ...options(), directory, expectedVersion: '0.4.9' })).rejects.toMatchObject({
      message: expect.stringContaining('changed'),
    });
    await expect(downloadUpdate({ ...options(), directory: join(directory, 'missing') })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(downloadUpdate({ ...options({ platform: 'windows-arm64' }), directory })).rejects.toMatchObject({ code: 'not_found' });
    await downloadUpdate({ ...options(), directory });
    await expect(downloadUpdate({ ...options(), directory })).rejects.toMatchObject({ message: expect.stringContaining('already exists') });
  });
});
