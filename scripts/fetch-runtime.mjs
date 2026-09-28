import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RUNTIMES = Object.freeze({
  node: {
    version: '24.21.0',
    filename: 'node-v24.21.0-darwin-arm64.tar.gz',
    baseUrl: 'https://nodejs.org/dist/v24.21.0',
    checksumFile: 'SHASUMS256.txt',
    sha256: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
  },
  cua: {
    version: '0.28.2',
    filename: 'cua-driver-rs-0.28.2-darwin-universal-binary.tar.gz',
    baseUrl: 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.2',
    checksumFile: 'checksums.txt',
    sha256: '386db225a3080714a0f9f935525e61efaf46709587ef8b94dd2df81aeb2f6daa',
  },
});

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, path) {
  const temporary = `${path}.partial-${process.pid}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Fetch immutable upstream archives, never remote installers or system installs. */
export async function fetchRuntimes() {
  const cache = join(ROOT, '.cache', 'runtime-downloads');
  await mkdir(cache, { recursive: true });
  const result = {};
  for (const [name, runtime] of Object.entries(RUNTIMES)) {
    const checksumPath = join(cache, `${name}-${runtime.version}-${runtime.checksumFile}`);
    if (!(await exists(checksumPath))) await download(`${runtime.baseUrl}/${runtime.checksumFile}`, checksumPath);
    const listed = (await readFile(checksumPath, 'utf8')).split(/\r?\n/).find(line => line.trim().split(/\s+/)[1] === runtime.filename);
    if (!listed || listed.trim().split(/\s+/)[0] !== runtime.sha256)
      throw new Error(`Pinned hash does not match upstream ${name} checksum manifest.`);
    const archive = join(cache, runtime.filename);
    if (!(await exists(archive))) {
      console.log(`Downloading ${name} ${runtime.version}…`);
      await download(`${runtime.baseUrl}/${runtime.filename}`, archive);
    }
    if ((await sha256(archive)) !== runtime.sha256)
      throw new Error(`Checksum mismatch: ${archive}. Remove this corrupted cache file before retrying.`);
    console.log(`Verified ${name} ${runtime.version} SHA-256.`);
    result[name] = archive;
  }
  const license = join(cache, 'cua-0.28.2-LICENSE.md');
  if (!(await exists(license))) await download('https://raw.githubusercontent.com/trycua/cua/cua-driver-rs-v0.28.2/LICENSE.md', license);
  if ((await sha256(license)) !== 'c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9')
    throw new Error('Cua license checksum mismatch.');
  result.cuaLicense = license;
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchRuntimes().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
