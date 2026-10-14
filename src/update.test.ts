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
const MIRROR_BASE = 'https://computer-use-download-1308799022.cos.ap-guangzhou.myqcloud.com/computer-use';
const zipName = 'computer-use-0.5.0-macos-arm64.zip';
const dmgName = 'computer-use-0.5.0-macos-arm64.dmg';
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
let installerBytes: Buffer;
let mirrorFiles: Map<string, Buffer>;
let requests: string[];

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
    installer: { name: dmgName, bytes: installerBytes.length, sha256: sha256(installerBytes) },
    ...overrides,
  });
}
function releaseBody(
  overrides: Record<string, unknown> = {},
  assetOverrides: Record<string, unknown> = {},
  installerOverrides: Record<string, unknown> = {},
): string {
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
      asset(dmgName, installerBytes, { digest: `sha256:${sha256(installerBytes)}`, ...installerOverrides }),
      asset(`${dmgName}.sha256`, files.get(`${dmgName}.sha256`)!),
      asset('computer-use-0.5.0-windows-x64.zip', 'other platform'),
    ],
    ...overrides,
  });
}

function publishMirror(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const assets = new Map(files);
  assets.set('release-notes.md', Buffer.from(RELEASE_NOTES));
  assets.set('SKILL.md', Buffer.from('# Computer Use\n'));
  assets.set('LICENSE.md', Buffer.from('MIT\n'));
  const manifest = {
    schemaVersion: 1,
    repository: 'starroyhq/computer-use',
    version: '0.5.0',
    tag: 'v0.5.0',
    commit: 'a'.repeat(40),
    publishedAt: '2026-10-01T08:00:00Z',
    assets: [...assets].map(([name, content]) => ({ name, bytes: content.length, sha256: sha256(content) })),
    ...overrides,
  };
  for (const [name, content] of assets) mirrorFiles.set(`releases/v0.5.0/${name}`, content);
  const json = Buffer.from(JSON.stringify(manifest));
  mirrorFiles.set('latest.json', json);
  mirrorFiles.set('releases/v0.5.0/manifest.json', json);
  return manifest;
}
const options = (overrides: Partial<UpdateOptions> = {}): UpdateOptions => ({
  current: '0.4.0',
  platform: 'macos-arm64',
  apiBase: base,
  webBase: base,
  rawBase: `${base}/raw`,
  downloadBase: `${base}/downloads`,
  trustedOrigins: [base],
  fetch: (input, init) => {
    const url = String(input);
    return globalThis.fetch(url.startsWith(`${MIRROR_BASE}/`) ? `${base}/mirror/${url.slice(MIRROR_BASE.length + 1)}` : input, init);
  },
  ...overrides,
});

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', base);
    requests.push(url.pathname);
    const special = routes.get(url.pathname);
    if (special) return special(response);
    if (url.pathname === RELEASE_PATH) {
      response
        .writeHead(release.status, {
          'Content-Type': 'application/json',
          ...(release.status === 403 ? { 'x-ratelimit-remaining': '0' } : {}),
        })
        .end(release.body);
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
    if (url.pathname.startsWith('/mirror/')) {
      const content = mirrorFiles.get(url.pathname.slice('/mirror/'.length));
      if (!content) {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, { 'Content-Length': content.length }).end(content);
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
  installerBytes = randomBytes(150_000);
  routes = new Map();
  requests = [];
  mirrorFiles = new Map();
  files = new Map();
  files.set(zipName, packageBytes);
  files.set(`${zipName}.sha256`, Buffer.from(`${sha256(packageBytes)}  ${zipName}\n`));
  files.set(dmgName, installerBytes);
  files.set(`${dmgName}.sha256`, Buffer.from(`${sha256(installerBytes)}  ${dmgName}\n`));
  files.set('computer-use-0.5.0-macos-arm64.json', Buffer.from(metadata()));
  release = { status: 200, body: releaseBody() };
  web = { status: 302, location: `${base}/starroyhq/computer-use/releases/tag/v0.5.0` };
});
afterEach(async () => {
  vi.restoreAllMocks();
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
      installer: { name: dmgName, size: installerBytes.length, sha256: sha256(installerBytes) },
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
    await expect(checkForUpdate(options())).rejects.toMatchObject({ code: 'unavailable' });
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
        'digest does not match',
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
      release = { status: 200, body: releaseBody() };
      arrange();
      await expect(downloadUpdate({ ...options(), directory }), name).rejects.toMatchObject({
        message: expect.stringContaining(message),
      });
      expect(await readdir(directory), name).toEqual([]);
    }
  });

  it('downloads the installer instead of the ZIP when asked, with the same checks through the API or the release page', async () => {
    for (const label of ['api', 'release page']) {
      if (label === 'release page') release = { status: 403, body: '{}' };
      const result = await downloadUpdate({ ...options(), directory, installer: true, expectedVersion: '0.5.0' });
      expect(result, label).toMatchObject({ path: join(directory, dmgName), sha256: sha256(installerBytes), bytes: installerBytes.length });
      expect((await readFile(result.path)).equals(installerBytes), label).toBe(true);
      expect(await readdir(directory), label).toEqual([dmgName]);
      await rm(result.path);
    }
    release = { status: 200, body: releaseBody() };
    const cases: Array<[string, () => void, string]> = [
      ['tampered installer', () => files.set(dmgName, randomBytes(installerBytes.length)), 'SHA-256'],
      [
        'installer checksum naming another file',
        () => files.set(`${dmgName}.sha256`, Buffer.from(`${sha256(installerBytes)}  other.dmg\n`)),
        'checksum file',
      ],
      [
        'metadata describing another installer',
        () =>
          files.set(
            'computer-use-0.5.0-macos-arm64.json',
            Buffer.from(metadata({ installer: { name: dmgName, bytes: installerBytes.length, sha256: sha256('other') } })),
          ),
        'metadata does not match',
      ],
      ['installer API digest mismatch', () => (release.body = releaseBody({}, {}, { digest: `sha256:${sha256('other')}` })), 'digest'],
    ];
    for (const [name, arrange, message] of cases) {
      files.set(dmgName, installerBytes);
      files.set(`${dmgName}.sha256`, Buffer.from(`${sha256(installerBytes)}  ${dmgName}\n`));
      files.set('computer-use-0.5.0-macos-arm64.json', Buffer.from(metadata()));
      release.body = releaseBody();
      arrange();
      await expect(downloadUpdate({ ...options(), directory, installer: true }), name).rejects.toMatchObject({
        message: expect.stringContaining(message),
      });
      expect(await readdir(directory), name).toEqual([]);
    }

    // 早于安装包的发布：检查结果没有 installer，按安装包下载时报告不存在，ZIP 照常可用。
    files.set('computer-use-0.5.0-macos-arm64.json', Buffer.from(metadata({ installer: undefined })));
    release.body = JSON.stringify({
      ...JSON.parse(releaseBody()),
      assets: JSON.parse(releaseBody()).assets.filter((asset: { name: string }) => !asset.name.startsWith(dmgName)),
    });
    for (const label of ['api', 'release page']) {
      if (label === 'release page') release = { status: 403, body: '{}' };
      expect((await checkForUpdate(options())).installer, label).toBeUndefined();
      await expect(downloadUpdate({ ...options(), directory, installer: true }), label).rejects.toMatchObject({ code: 'not_found' });
      expect((await downloadUpdate({ ...options(), directory })).path, label).toBe(join(directory, zipName));
      await rm(join(directory, zipName));
    }
    // 发布页路径同样拒绝描述了别的安装包名称的元数据。
    files.set(
      'computer-use-0.5.0-macos-arm64.json',
      Buffer.from(metadata({ installer: { name: 'other.dmg', bytes: installerBytes.length, sha256: sha256(installerBytes) } })),
    );
    await expect(checkForUpdate(options())).rejects.toMatchObject({ message: expect.stringContaining('metadata does not match') });
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

describe('COS release fallback', () => {
  it('discovers a complete mirrored release only when both GitHub entrypoints have transport failures', async () => {
    publishMirror();
    release = { status: 429, body: '{}' };
    web = { status: 503 };
    expect(await checkForUpdate(options())).toMatchObject({
      latest: '0.5.0',
      available: true,
      publishedAt: '2026-10-01T08:00:00Z',
      notes: '## 更新\n- 修复问题',
      asset: { name: zipName, sha256: sha256(packageBytes) },
    });
    expect(requests).toContain('/mirror/latest.json');
    expect(requests).toContain('/mirror/releases/v0.5.0/manifest.json');
    expect((await checkForUpdate(options({ current: '0.6.0' }))).available).toBe(false);

    // 用户已经确认版本时，不能因为主源离线重新选择镜像的 latest。
    requests = [];
    mirrorFiles.set('latest.json', Buffer.from('{}'));
    const result = await downloadUpdate({ ...options(), directory, expectedVersion: '0.5.0' });
    expect(result).toMatchObject({ version: '0.5.0', sha256: sha256(packageBytes) });
    expect(requests).not.toContain('/mirror/latest.json');
    expect((await readFile(result.path)).equals(packageBytes)).toBe(true);
  });

  it('pins the version discovered from the release-page redirect before its metadata request fails', async () => {
    publishMirror();
    release = { status: 403, body: '{}' };
    routes.set('/downloads/v0.5.0/computer-use-0.5.0-macos-arm64.json', response => response.writeHead(503).end());
    mirrorFiles.set('latest.json', Buffer.from('{}'));
    expect(await checkForUpdate(options())).toMatchObject({ latest: '0.5.0', asset: { name: zipName } });
    expect(requests).not.toContain('/mirror/latest.json');
  });

  it('recovers from HTTP 408 at discovery and at a pinned asset without selecting another version', async () => {
    publishMirror();
    release = { status: 408, body: '{}' };
    web = { status: 408 };
    expect(await checkForUpdate(options())).toMatchObject({ latest: '0.5.0' });
    release = { status: 200, body: releaseBody() };
    routes.set(`/downloads/v0.5.0/${zipName}`, response => response.writeHead(408).end());
    requests = [];
    const result = await downloadUpdate({ ...options(), directory, expectedVersion: '0.5.0' });
    expect((await readFile(result.path)).equals(packageBytes)).toBe(true);
    expect(requests).not.toContain('/mirror/latest.json');
  });

  it('uses the same version for optional release notes when the raw GitHub host is unavailable', async () => {
    publishMirror();
    release = { status: 403, body: '{}' };
    routes.set(NOTES_PATH, response => response.writeHead(502).end());
    expect((await checkForUpdate(options())).notes).toBe('## 更新\n- 修复问题');
    expect(requests).not.toContain('/mirror/latest.json');
    expect(requests).toContain('/mirror/releases/v0.5.0/release-notes.md');
  });

  it('recovers from an interrupted ZIP download after removing its partial file, without consulting mirror latest', async () => {
    publishMirror();
    mirrorFiles.set('latest.json', Buffer.from('{}'));
    const progress = vi.fn();
    routes.set(`/downloads/v0.5.0/${zipName}`, response => {
      response.writeHead(200, { 'Content-Length': packageBytes.length });
      response.write(packageBytes.subarray(0, 50_000));
      setTimeout(() => response.destroy(), 20);
    });
    let cleanBeforeFallback = false;
    routes.set('/mirror/releases/v0.5.0/manifest.json', async response => {
      cleanBeforeFallback = (await readdir(directory)).length === 0;
      response.writeHead(200).end(mirrorFiles.get('releases/v0.5.0/manifest.json'));
    });
    const result = await downloadUpdate({ ...options(), directory, onProgress: progress });
    expect(cleanBeforeFallback).toBe(true);
    expect(progress.mock.calls.some(([bytes]) => bytes > 0 && bytes < packageBytes.length)).toBe(true);
    expect(requests).not.toContain('/mirror/latest.json');
    expect((await readFile(result.path)).equals(packageBytes)).toBe(true);
    expect(await readdir(directory)).toEqual([zipName]);
  });

  it('can retry a mirrored binary at the exact GitHub version without rechecking latest', async () => {
    publishMirror();
    release = { status: 503, body: '{}' };
    web = { status: 503 };
    routes.set(`/mirror/releases/v0.5.0/${dmgName}`, response => response.writeHead(502).end());
    const result = await downloadUpdate({ ...options(), directory, installer: true });
    expect((await readFile(result.path)).equals(installerBytes)).toBe(true);
    expect(requests.filter(path => path === RELEASE_PATH)).toHaveLength(1);
    expect(requests.filter(path => path === '/mirror/latest.json')).toHaveLength(1);
    expect(requests.filter(path => path === `/downloads/v0.5.0/${dmgName}`)).toHaveLength(1);
  });

  it.each(['windows-arm64', 'windows-x64'] as const)('downloads and verifies the mirrored %s installer', async platform => {
    const archive = `computer-use-0.5.0-${platform}.zip`;
    const installer = `computer-use-0.5.0-${platform}-setup.exe`;
    files = new Map([
      [archive, packageBytes],
      [`${archive}.sha256`, Buffer.from(`${sha256(packageBytes)}  ${archive}\n`)],
      [installer, installerBytes],
      [`${installer}.sha256`, Buffer.from(`${sha256(installerBytes)}  ${installer}\n`)],
      [
        `computer-use-0.5.0-${platform}.json`,
        Buffer.from(
          metadata({
            platform,
            archive,
            signing: 'unsigned',
            notarization: undefined,
            installer: { name: installer, bytes: installerBytes.length, sha256: sha256(installerBytes) },
          }),
        ),
      ],
    ]);
    publishMirror();
    release = { status: 503, body: '{}' };
    web = { status: 503 };
    const result = await downloadUpdate({ ...options({ platform }), directory, installer: true });
    expect(result).toMatchObject({ platform, signing: 'unsigned', bytes: installerBytes.length, sha256: sha256(installerBytes) });
    expect((await readFile(result.path)).equals(installerBytes)).toBe(true);
  });

  it('rejects a mirror that changes a known size, digest, or commit', async () => {
    routes.set(`/downloads/v0.5.0/${zipName}`, response => response.writeHead(503).end());
    for (const change of ['size', 'hash', 'commit']) {
      const manifest = publishMirror();
      const assets = manifest.assets as Array<{ name: string; bytes: number; sha256: string }>;
      const archive = assets.find(asset => asset.name === zipName)!;
      if (change === 'size') archive.bytes++;
      if (change === 'hash') archive.sha256 = '0'.repeat(64);
      if (change === 'commit') manifest.commit = 'b'.repeat(40);
      mirrorFiles.set('releases/v0.5.0/manifest.json', Buffer.from(JSON.stringify(manifest)));
      await expect(downloadUpdate({ ...options(), directory }), change).rejects.toMatchObject({
        code: 'unavailable',
        message: expect.stringContaining('mirror'),
      });
      expect(await readdir(directory)).toEqual([]);
    }
  });

  it('validates every manifest field and requires latest to match the immutable version manifest', async () => {
    release = { status: 503, body: '{}' };
    web = { status: 503 };
    const invalid = [
      { schemaVersion: 2 },
      { repository: 'someone/else' },
      { version: '0.5.0-beta' },
      { tag: 'v0.4.9' },
      { commit: 'HEAD' },
      { publishedAt: 'yesterday' },
      { extra: 'unrecognized' },
      { assets: [{ name: '../package.zip', bytes: 1, sha256: 'a'.repeat(64) }] },
      { assets: [{ name: 'package.zip', bytes: 4 * 1024 ** 3 + 1, sha256: 'a'.repeat(64) }] },
      { assets: [{ name: 'package.zip', bytes: 1, sha256: 'not-a-hash' }] },
      { assets: Array(2).fill({ name: 'package.zip', bytes: 1, sha256: 'a'.repeat(64) }) },
      { assets: [{ name: 'computer-use-0.6.0-macos-arm64.zip', bytes: 1, sha256: 'a'.repeat(64) }] },
    ];
    for (const override of invalid) {
      publishMirror(override);
      await expect(checkForUpdate(options()), JSON.stringify(override)).rejects.toMatchObject({ code: 'unavailable' });
    }
    publishMirror();
    const manifest = JSON.parse(mirrorFiles.get('latest.json')!.toString());
    manifest.commit = 'c'.repeat(40);
    mirrorFiles.set('latest.json', Buffer.from(JSON.stringify(manifest)));
    await expect(checkForUpdate(options())).rejects.toMatchObject({ message: expect.stringContaining('commit') });
    mirrorFiles.set('latest.json', Buffer.alloc(1024 * 1024 + 1, 'x'));
    await expect(checkForUpdate(options())).rejects.toMatchObject({ message: expect.stringContaining('large response') });
  });

  it('rejects tampered mirror metadata, checksum, notes and binary without falling back to GitHub', async () => {
    release = { status: 503, body: '{}' };
    web = { status: 503 };
    for (const name of ['computer-use-0.5.0-macos-arm64.json', `${zipName}.sha256`, 'release-notes.md', zipName]) {
      publishMirror();
      requests = [];
      const path = `releases/v0.5.0/${name}`;
      mirrorFiles.set(path, randomBytes(mirrorFiles.get(path)!.length));
      await expect(downloadUpdate({ ...options(), directory }), name).rejects.toMatchObject({
        message: expect.stringContaining('SHA-256'),
      });
      expect(requests.some(path => path.startsWith('/downloads/'))).toBe(false);
      expect(await readdir(directory)).toEqual([]);
    }
  });

  it('does not treat generic 403, invalid release data, untrusted redirects or checksum errors as network failures', async () => {
    publishMirror();
    routes.set(RELEASE_PATH, response => response.writeHead(403).end('Forbidden'));
    await expect(checkForUpdate(options())).rejects.toMatchObject({ message: expect.stringContaining('HTTP 403') });
    expect(requests).toEqual([RELEASE_PATH]);
    routes.clear();
    release.body = '{invalid';
    requests = [];
    await expect(checkForUpdate(options())).rejects.toMatchObject({ code: 'unavailable' });
    expect(requests).toEqual([RELEASE_PATH]);
    release.body = releaseBody();
    for (const location of ['https://evil.example/release', `${MIRROR_BASE}/../private/file`, `${MIRROR_BASE}.evil.example/latest.json`]) {
      requests = [];
      routes.set(RELEASE_PATH, response => response.writeHead(302, { Location: location }).end());
      await expect(checkForUpdate(options())).rejects.toMatchObject({ message: expect.stringContaining('unexpected host') });
      expect(requests).toEqual([RELEASE_PATH]);
    }
    routes.clear();
    files.set(zipName, randomBytes(packageBytes.length));
    requests = [];
    await expect(downloadUpdate({ ...options(), directory })).rejects.toMatchObject({ message: expect.stringContaining('SHA-256') });
    expect(requests.some(path => path.startsWith('/mirror/'))).toBe(false);
  });

  it('rejects redirects out of the pinned COS path before sending a request', async () => {
    publishMirror();
    release = { status: 503, body: '{}' };
    web = { status: 503 };
    for (const location of [
      `${MIRROR_BASE}/releases/v0.6.0/manifest.json`,
      `${MIRROR_BASE}/../private/manifest.json`,
      'https://other-1308799022.cos.ap-guangzhou.myqcloud.com/computer-use/latest.json',
    ]) {
      requests = [];
      routes.set('/mirror/latest.json', response => response.writeHead(302, { Location: location }).end());
      await expect(checkForUpdate(options())).rejects.toMatchObject({ message: expect.stringContaining('unexpected host') });
      expect(requests.filter(path => path.startsWith('/mirror/'))).toEqual(['/mirror/latest.json']);
    }
  });

  it('never retries certificate failures or invalid published digest formats at another source', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('Untrusted certificate'), { code: 'CERT_HAS_EXPIRED' }) });
    });
    await expect(checkForUpdate(options({ fetch }))).rejects.toMatchObject({ message: expect.stringContaining('TLS identity') });
    expect(fetch).toHaveBeenCalledTimes(1);
    publishMirror();
    release.body = releaseBody({}, { digest: 'sha256:not-a-sha256' });
    await expect(checkForUpdate(options())).rejects.toMatchObject({ message: expect.stringContaining('digest is invalid') });
    expect(requests).toEqual([RELEASE_PATH]);
  });

  it('verifies API digests for metadata and checksum files before using their contents', async () => {
    for (const name of ['computer-use-0.5.0-macos-arm64.json', `${zipName}.sha256`]) {
      files.set('computer-use-0.5.0-macos-arm64.json', Buffer.from(metadata()));
      files.set(`${zipName}.sha256`, Buffer.from(`${sha256(packageBytes)}  ${zipName}\n`));
      publishMirror();
      const body = JSON.parse(releaseBody());
      body.assets.find((asset: { name: string }) => asset.name === name).digest = `sha256:${sha256(files.get(name)!)}`;
      release.body = JSON.stringify(body);
      files.set(
        name,
        name.endsWith('.json') ? Buffer.from(metadata({ commit: 'b'.repeat(40) })) : Buffer.from(`${sha256(packageBytes)}  ${zipName}`),
      );
      requests = [];
      await expect(downloadUpdate({ ...options(), directory }), name).rejects.toMatchObject({
        message: expect.stringContaining('SHA-256'),
      });
      expect(requests.some(path => path.startsWith('/mirror/'))).toBe(false);
      expect(await readdir(directory)).toEqual([]);
    }
  });

  it('can recover from bounded discovery timeouts, but user cancellation never changes source', async () => {
    publishMirror();
    const timeout = AbortSignal.abort(new DOMException('Timed out', 'TimeoutError'));
    const original = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(timeout).mockReturnValueOnce(timeout).mockImplementation(original);
    expect(await checkForUpdate(options())).toMatchObject({ latest: '0.5.0' });
    vi.restoreAllMocks();
    requests = [];
    const controller = new AbortController();
    await expect(
      downloadUpdate({ ...options({ signal: controller.signal }), directory, onProgress: () => controller.abort() }),
    ).rejects.toMatchObject({ code: 'timeout', message: expect.stringContaining('cancelled') });
    expect(requests.some(path => path.startsWith('/mirror/'))).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });
});
