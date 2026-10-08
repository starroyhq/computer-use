import { createHash } from 'node:crypto';
import { open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CuError } from './contracts.js';

// 更新只读取本项目 GitHub 的最新正式版，不上传任何标识或使用数据。
export const RELEASE_REPOSITORY = 'starroyhq/computer-use';
const API_BASE = 'https://api.github.com';
const WEB_BASE = 'https://github.com';
const RAW_BASE = 'https://raw.githubusercontent.com';
const DOWNLOAD_BASE = `${WEB_BASE}/${RELEASE_REPOSITORY}/releases/download`;
const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
const RELEASE_JSON_LIMIT = 1024 * 1024;
const SMALL_FILE_LIMIT = 64 * 1024;
const NOTES_FILE_LIMIT = 256 * 1024;
const NOTES_TIMEOUT_MS = 5_000;
const NOTES_LIMIT = 20_000;
const MAX_REDIRECTS = 5;

export type UpdatePlatform = 'macos-arm64' | 'windows-arm64' | 'windows-x64';
export type UpdateAsset = { name: string; size: number; sha256?: string };
export type UpdateCheck = {
  current: string;
  latest: string;
  available: boolean;
  platform: UpdatePlatform;
  tag: string;
  url: string;
  publishedAt?: string;
  notes: string;
  /** 该平台的 ZIP 包（macOS 一键更新与 Windows 便携版使用）；最新版没有这个平台的包时为空。 */
  asset?: UpdateAsset;
  /** 首次安装用的安装包：macOS 为 DMG，Windows 为安装程序；较早的发布没有。 */
  installer?: UpdateAsset;
};
export type UpdateDownload = {
  version: string;
  platform: UpdatePlatform;
  path: string;
  sha256: string;
  bytes: number;
  signing: string;
  commit: string;
};
export type UpdateOptions = {
  current: string;
  platform: UpdatePlatform;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  // 以下各项只供测试替换为本机服务；CLI 从不设置。
  apiBase?: string;
  webBase?: string;
  rawBase?: string;
  downloadBase?: string;
  trustedOrigins?: string[];
};

export function updatePlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): UpdatePlatform {
  if (platform === 'darwin' && arch === 'arm64') return 'macos-arm64';
  if (platform === 'win32' && arch === 'arm64') return 'windows-arm64';
  if (platform === 'win32' && arch === 'x64') return 'windows-x64';
  throw new CuError('unavailable', 'No release package exists for this platform.');
}

const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
export function compareVersions(left: string, right: string): number {
  const a = versionPattern.exec(left);
  const b = versionPattern.exec(right);
  if (!a || !b) throw new CuError('invalid_request', 'Versions must use the form MAJOR.MINOR.PATCH.');
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

const assetSchema = z.object({
  name: z.string().min(1).max(200),
  size: z.number().int().nonnegative(),
  browser_download_url: z.string().max(2048),
  digest: z.string().max(200).nullish(),
});
const releaseSchema = z.object({
  tag_name: z.string().max(100),
  html_url: z.string().max(2048),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().max(100).nullish(),
  body: z.string().max(1_000_000).nullish(),
  assets: z.array(assetSchema).max(500),
});
const metadataSchema = z.object({
  version: z.string(),
  platform: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  sourceDirty: z.literal(false),
  archive: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  signing: z.string(),
  notarization: z.string().optional(),
  // v0.6.0 起的发布才描述安装包；旧版本读到这个字段时忽略。
  installer: z.object({ name: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
});
type ReleaseFile = { name: string; url: string };
// digest 只有 GitHub API 提供；改读发布页时为空，元数据已读过时带上原文。
type PackageFile = ReleaseFile & { size: number; digest?: string };
type ReleaseFiles = {
  archive: PackageFile;
  checksum: ReleaseFile;
  metadata: ReleaseFile & { text?: string };
  installer?: { file: PackageFile; checksum: ReleaseFile };
};
type Release = { check: UpdateCheck; files?: ReleaseFiles };

/** 发布中安装包的文件名：macOS 为 DMG，Windows 为安装程序。 */
export function installerName(version: string, platform: UpdatePlatform): string {
  return platform === 'macos-arm64' ? `computer-use-${version}-${platform}.dmg` : `computer-use-${version}-${platform}-setup.exe`;
}

function trusted(url: URL, options: UpdateOptions): boolean {
  if (options.trustedOrigins) return options.trustedOrigins.includes(url.origin);
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (url.hostname === 'github.com' || url.hostname === 'api.github.com' || url.hostname.endsWith('.githubusercontent.com'))
  );
}

// 手动跟随跳转：每一跳都先核对地址，不向未列入白名单的主机发出请求。follow 为 false 时直接返回第一跳的响应。
async function request(url: string, options: UpdateOptions, signal: AbortSignal, accept: string, follow = true): Promise<Response> {
  const fetcher = options.fetch ?? globalThis.fetch;
  let next = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!trusted(next, options)) throw new CuError('unavailable', 'The update server redirected to an unexpected host.');
    let response: Response;
    try {
      response = await fetcher(next, {
        redirect: 'manual',
        signal,
        headers: {
          Accept: accept,
          'User-Agent': `computer-use/${options.current} (${options.platform})`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      if (signal.aborted) throw new CuError('timeout', 'The update server did not respond in time.');
      throw new CuError('unavailable', 'Cannot reach the update server; check the network connection.');
    }
    if (follow && response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) throw new CuError('unavailable', 'The update server returned an invalid redirect.');
      next = new URL(location, next);
      continue;
    }
    return response;
  }
  throw new CuError('unavailable', 'The update server redirected too many times.');
}

// 逐块读取响应体；调用方提前结束（超限、校验失败）时取消剩余下载。
async function* chunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        finished = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readLimited(response: Response, limit: number): Promise<string> {
  const parts: Uint8Array[] = [];
  let size = 0;
  if (response.body)
    for await (const chunk of chunks(response.body)) {
      size += chunk.byteLength;
      if (size > limit) throw new CuError('unavailable', 'The update server returned an unexpectedly large response.');
      parts.push(chunk);
    }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
  } catch {
    throw new CuError('unavailable', 'The update server returned unreadable data.');
  }
}

function httpFailure(response: Response): CuError {
  if (response.status === 403 || response.status === 429) return new CuError('unavailable', 'GitHub rate limit reached; try again later.');
  if (response.status === 404) return new CuError('not_found', 'No published release was found.');
  return new CuError('unavailable', `The update server returned HTTP ${response.status}.`);
}

// 发布说明按纯文本展示：统一换行，去掉控制字符，限制长度。
function plainNotes(body: string | null | undefined): string {
  const text = (body ?? '')
    .replace(/\r\n?/g, '\n')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 有意删除控制字符。
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  return text.length > NOTES_LIMIT ? `${text.slice(0, NOTES_LIMIT)}…` : text;
}

function sha256Digest(digest: string | null | undefined): string | undefined {
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest ?? '');
  return match?.[1];
}

function parseMetadata(text: string): z.infer<typeof metadataSchema> {
  try {
    return metadataSchema.parse(JSON.parse(text));
  } catch {
    fail('The release metadata is invalid.');
  }
}

function timeoutSignal(milliseconds: number, options: UpdateOptions): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(milliseconds), ...(options.signal ? [options.signal] : [])]);
}

async function resolveRelease(options: UpdateOptions): Promise<Release> {
  if (!versionPattern.test(options.current)) fail('This build has no comparable release version.');
  const signal = timeoutSignal(CHECK_TIMEOUT_MS, options);
  let response: Response;
  try {
    response = await request(
      `${options.apiBase ?? API_BASE}/repos/${RELEASE_REPOSITORY}/releases/latest`,
      options,
      signal,
      'application/vnd.github+json',
    );
  } catch (error) {
    // api.github.com 不可达或超时时，github.com 可能仍然可用。
    const unreachable = error instanceof CuError && (error.code === 'timeout' || error.message.startsWith('Cannot reach'));
    if (unreachable && !options.signal?.aborted) return releaseFromWeb(options);
    throw error;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    // 未认证的 API 每个 IP 每小时只能调用 60 次，共享网络很容易用完；超限或服务异常时改读发布页，结果相同。
    if (response.status === 403 || response.status === 429 || response.status >= 500) return releaseFromWeb(options);
    throw httpFailure(response);
  }
  let parsed: z.infer<typeof releaseSchema>;
  try {
    parsed = releaseSchema.parse(JSON.parse(await readLimited(response, RELEASE_JSON_LIMIT)));
  } catch (error) {
    if (error instanceof CuError) throw error;
    throw new CuError('unavailable', 'The update server returned unexpected release information.');
  }
  const latest = /^v(\d+\.\d+\.\d+)$/.exec(parsed.tag_name)?.[1];
  if (!latest || !versionPattern.test(latest)) fail('The latest release does not have a stable version tag.');
  if (!parsed.html_url.startsWith(`https://github.com/${RELEASE_REPOSITORY}/releases/`))
    fail('The latest release points to an unexpected page.');
  // 草稿与预发布不作为更新提供；比当前版本旧或相同的版本也不提供（不降级）。
  const available = !parsed.draft && !parsed.prerelease && compareVersions(latest, options.current) > 0;
  const prefix = `computer-use-${latest}-${options.platform}`;
  const find = (name: string) => parsed.assets.find(asset => asset.name === name);
  const archive = find(`${prefix}.zip`);
  const checksum = find(`${prefix}.zip.sha256`);
  const metadata = find(`${prefix}.json`);
  const installer = find(installerName(latest, options.platform));
  const installerChecksum = installer && find(`${installer.name}.sha256`);
  const describe = (asset: z.infer<typeof assetSchema>): UpdateAsset => ({
    name: asset.name,
    size: asset.size,
    ...(sha256Digest(asset.digest) ? { sha256: sha256Digest(asset.digest)! } : {}),
  });
  const check: UpdateCheck = {
    current: options.current,
    latest,
    available,
    platform: options.platform,
    tag: parsed.tag_name,
    url: parsed.html_url,
    ...(parsed.published_at ? { publishedAt: parsed.published_at } : {}),
    notes: plainNotes(parsed.body),
    ...(archive ? { asset: describe(archive) } : {}),
    ...(installer && installerChecksum ? { installer: describe(installer) } : {}),
  };
  if (!archive || !checksum || !metadata) return { check };
  const file = (asset: z.infer<typeof assetSchema>) => ({ name: asset.name, url: asset.browser_download_url });
  const packageFile = (asset: z.infer<typeof assetSchema>): PackageFile => ({
    ...file(asset),
    size: asset.size,
    ...(asset.digest ? { digest: asset.digest } : {}),
  });
  return {
    check,
    files: {
      archive: packageFile(archive),
      checksum: file(checksum),
      metadata: file(metadata),
      ...(installer && installerChecksum ? { installer: { file: packageFile(installer), checksum: file(installerChecksum) } } : {}),
    },
  };
}

// 不经过 API：/releases/latest 跳转到最新正式版的标签页（GitHub 的“最新”不含草稿与预发布），
// 发布元数据给出本平台安装包的名称、大小与 SHA-256。这些地址都不计入 API 配额。
async function releaseFromWeb(options: UpdateOptions): Promise<Release> {
  const signal = timeoutSignal(CHECK_TIMEOUT_MS, options);
  const web = options.webBase ?? WEB_BASE;
  const releases = `${web}/${RELEASE_REPOSITORY}/releases`;
  const response = await request(`${releases}/latest`, options, signal, 'text/html', false);
  await response.body?.cancel().catch(() => {});
  const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
  if (!location) {
    if (response.ok) fail('The update server returned unexpected release information.');
    throw httpFailure(response);
  }
  const target = new URL(location, `${releases}/latest`);
  if (target.origin !== new URL(web).origin) fail('The update server redirected to an unexpected host.');
  // 还没有正式版时，GitHub 跳到发布列表页。
  if (target.href === releases || target.href === `${releases}/`) throw new CuError('not_found', 'No published release was found.');
  const tag = target.href.startsWith(`${releases}/tag/`) ? decodeURIComponent(target.href.slice(`${releases}/tag/`.length)) : '';
  const latest = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
  if (!latest || !versionPattern.test(latest)) fail('The latest release does not have a stable version tag.');

  const prefix = `computer-use-${latest}-${options.platform}`;
  const url = (name: string) => `${options.downloadBase ?? DOWNLOAD_BASE}/v${latest}/${encodeURIComponent(name)}`;
  const metadataResponse = await request(url(`${prefix}.json`), options, signal, 'application/octet-stream');
  let files: ReleaseFiles | undefined;
  let asset: UpdateAsset | undefined;
  let installer: UpdateAsset | undefined;
  if (metadataResponse.ok) {
    const text = await readLimited(metadataResponse, SMALL_FILE_LIMIT);
    const metadata = parseMetadata(text);
    if (
      metadata.version !== latest ||
      metadata.platform !== options.platform ||
      metadata.archive !== `${prefix}.zip` ||
      (metadata.installer && metadata.installer.name !== installerName(latest, options.platform))
    )
      fail('The release metadata does not match the package.');
    asset = { name: metadata.archive, size: metadata.bytes, sha256: metadata.sha256 };
    if (metadata.installer)
      installer = { name: metadata.installer.name, size: metadata.installer.bytes, sha256: metadata.installer.sha256 };
    files = {
      archive: { name: metadata.archive, url: url(metadata.archive), size: metadata.bytes },
      checksum: { name: `${metadata.archive}.sha256`, url: url(`${metadata.archive}.sha256`) },
      metadata: { name: `${prefix}.json`, url: url(`${prefix}.json`), text },
      ...(installer
        ? {
            installer: {
              file: { name: installer.name, url: url(installer.name), size: installer.size },
              checksum: { name: `${installer.name}.sha256`, url: url(`${installer.name}.sha256`) },
            },
          }
        : {}),
    };
  } else {
    await metadataResponse.body?.cancel().catch(() => {});
    // 404：最新版没有这个平台的安装包，仍然报告版本。
    if (metadataResponse.status !== 404) throw httpFailure(metadataResponse);
  }
  const available = compareVersions(latest, options.current) > 0;
  const check: UpdateCheck = {
    current: options.current,
    latest,
    available,
    platform: options.platform,
    tag: `v${latest}`,
    url: `${WEB_BASE}/${RELEASE_REPOSITORY}/releases/tag/v${latest}`,
    // 只有提供更新时才显示发布说明。
    notes: available ? await releaseNotes(latest, options) : '',
    ...(asset ? { asset } : {}),
    ...(installer ? { installer } : {}),
  };
  return { check, ...(files ? { files } : {}) };
}

// 发布说明取自该标签下的说明文件（发布时使用同一文件）；读取失败只缺少说明，不影响检查结果。
async function releaseNotes(version: string, options: UpdateOptions): Promise<string> {
  const path = `${RELEASE_REPOSITORY}/v${version}/.github/release-notes/v${version}.md`;
  try {
    const response = await request(
      `${options.rawBase ?? RAW_BASE}/${path}`,
      options,
      timeoutSignal(NOTES_TIMEOUT_MS, options),
      'text/plain',
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return '';
    }
    return plainNotes(await readLimited(response, NOTES_FILE_LIMIT));
  } catch {
    return '';
  }
}

function fail(message: string): never {
  throw new CuError('unavailable', message);
}

export async function checkForUpdate(options: UpdateOptions): Promise<UpdateCheck> {
  return (await resolveRelease(options)).check;
}

function assetUrl(file: ReleaseFile, version: string, options: UpdateOptions): string {
  // 只接受本仓库该版本标签下的下载地址。
  const expected = `${options.downloadBase ?? DOWNLOAD_BASE}/v${version}/${encodeURIComponent(file.name)}`;
  if (file.url !== expected) fail('A release asset points to an unexpected location.');
  return expected;
}

async function fetchSmall(file: ReleaseFile, version: string, options: UpdateOptions, signal: AbortSignal): Promise<string> {
  const response = await request(assetUrl(file, version, options), options, signal, 'application/octet-stream');
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw httpFailure(response);
  }
  return readLimited(response, SMALL_FILE_LIMIT);
}

export async function downloadUpdate(
  options: UpdateOptions & {
    directory: string;
    /** 用户确认过的版本：最新版在此期间变了就拒绝，避免安装用户没看过的版本。 */
    expectedVersion?: string;
    /** 下载安装包（macOS 为 DMG，Windows 为安装程序）而不是 ZIP。Windows 安装版用它更新。 */
    installer?: boolean;
    onProgress?: (downloaded: number, total: number) => void;
  },
): Promise<UpdateDownload> {
  if (options.expectedVersion !== undefined && !versionPattern.test(options.expectedVersion))
    throw new CuError('invalid_request', 'The confirmed release must use the form MAJOR.MINOR.PATCH.');
  const { check, files } = await resolveRelease(options);
  if (!check.available) throw new CuError('invalid_request', 'This build is already up to date.');
  if (options.expectedVersion !== undefined && options.expectedVersion !== check.latest)
    throw new CuError('invalid_request', 'The latest release changed; check for updates again.');
  if (!files) throw new CuError('not_found', `The latest release has no package for ${options.platform}.`);
  if (options.installer && !files.installer) throw new CuError('not_found', `The latest release has no installer for ${options.platform}.`);
  const target = options.installer && files.installer ? files.installer.file : files.archive;
  const checksumFile = options.installer && files.installer ? files.installer.checksum : files.checksum;
  const directory = await stat(options.directory).catch(() => undefined);
  if (!directory?.isDirectory()) throw new CuError('invalid_request', 'Specify an existing directory with --out.');
  const destination = join(options.directory, target.name);
  if (await stat(destination).catch(() => undefined)) throw new CuError('invalid_request', 'The package already exists in --out.');
  const signal = AbortSignal.any([AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);

  const checksum = /^([0-9a-f]{64}) {2}(\S+)\n?$/.exec(await fetchSmall(checksumFile, check.latest, options, signal));
  const expectedHash = checksum?.[2] === target.name ? checksum[1] : undefined;
  if (!expectedHash) fail('The release checksum file is invalid.');
  const metadata = parseMetadata(files.metadata.text ?? (await fetchSmall(files.metadata, check.latest, options, signal)));
  const mac = options.platform === 'macos-arm64';
  // 元数据同时描述 ZIP 与安装包：下载哪一个，就核对它的名称、大小与 SHA-256。
  const described = options.installer ? metadata.installer : { name: metadata.archive, bytes: metadata.bytes, sha256: metadata.sha256 };
  if (
    metadata.version !== check.latest ||
    metadata.platform !== options.platform ||
    metadata.archive !== files.archive.name ||
    described?.name !== target.name ||
    described.sha256 !== expectedHash ||
    described.bytes !== target.size ||
    metadata.signing !== (mac ? 'developer-id-notarized' : 'unsigned') ||
    (mac && metadata.notarization !== 'stapled')
  )
    fail('The release metadata does not match the package.');
  // GitHub 记录的摘要只在经 API 读取时可用。
  if (target.digest && sha256Digest(target.digest) !== expectedHash) fail('The release package digest does not match its checksum.');

  const partial = `${destination}.partial`;
  const response = await request(assetUrl(target, check.latest, options), options, signal, 'application/octet-stream');
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw httpFailure(response);
  }
  const file = await open(partial, 'wx', 0o600).catch(async () => {
    await response.body?.cancel().catch(() => {});
    throw new CuError('invalid_request', 'Cannot write the package into --out.');
  });
  const hash = createHash('sha256');
  let downloaded = 0;
  let reported = 0;
  try {
    for await (const chunk of chunks(response.body)) {
      downloaded += chunk.byteLength;
      if (downloaded > target.size) fail('The release package is larger than published.');
      hash.update(chunk);
      await file.write(chunk);
      if (options.onProgress && (downloaded - reported >= target.size / 100 || downloaded === target.size)) {
        reported = downloaded;
        options.onProgress(downloaded, target.size);
      }
    }
    await file.sync();
    await file.close();
    if (downloaded !== target.size) fail('The release package download was incomplete.');
    if (hash.digest('hex') !== expectedHash) fail('The downloaded package failed its SHA-256 check.');
    await rename(partial, destination);
  } catch (error) {
    await file.close().catch(() => {});
    await rm(partial, { force: true });
    if (error instanceof CuError) throw error;
    if (signal.aborted) throw new CuError('timeout', 'The package download did not finish in time.');
    throw new CuError('unavailable', 'The package download was interrupted.');
  }
  return {
    version: check.latest,
    platform: options.platform,
    path: destination,
    sha256: expectedHash,
    bytes: downloaded,
    signing: metadata.signing,
    commit: metadata.commit,
  };
}
