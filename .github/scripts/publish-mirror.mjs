import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { uploadOnce } from './cos-upload.mjs';
import { compareVersions, mirrorBase, validateManifest } from './release-manifest.mjs';
import { githubReleases, inspectRelease } from './verify-release.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const prefix = 'computer-use';
async function currentIndex(manifest, bytes, store) {
  const latest = await store.get(`${prefix}/latest.json`);
  if (!latest) return null;
  const previous = validateManifest(JSON.parse(latest));
  if (compareVersions(previous.version, manifest.version) > 0) throw new Error('Refusing to downgrade the mirror index.');
  if (previous.version === manifest.version && !latest.equals(bytes))
    throw new Error('The published version already has a different manifest.');
  return latest;
}
export async function uploadMirror(directory, store) {
  const manifestBytes = await readFile(join(directory, 'manifest.json'));
  const manifest = validateManifest(JSON.parse(manifestBytes));
  // Stop old-release retries before staging bytes or publishing GitHub latest.
  await currentIndex(manifest, manifestBytes, store);
  const files = [...manifest.assets, { name: 'manifest.json', bytes: manifestBytes.length, sha256: sha256(manifestBytes) }];
  // Validate all local files before the first write. Version prefixes never change once present.
  for (const asset of files) {
    const bytes = await readFile(join(directory, asset.name));
    if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) throw new Error(`Local file changed: ${asset.name}`);
    const key = `${prefix}/releases/${manifest.tag}/${asset.name}`;
    const existing = await store.get(key);
    if (existing && (existing.length !== asset.bytes || sha256(existing) !== asset.sha256))
      throw new Error(`Refusing to overwrite immutable release file: ${asset.name}`);
  }
  for (const asset of files) {
    const key = `${prefix}/releases/${manifest.tag}/${asset.name}`;
    if (!(await store.get(key))) await store.put(key, await readFile(join(directory, asset.name)), 'public, max-age=31536000, immutable');
    const uploaded = await store.get(key);
    if (!uploaded || uploaded.length !== asset.bytes || sha256(uploaded) !== asset.sha256)
      throw new Error(`Mirror readback failed: ${asset.name}`);
  }
  return manifest;
}
export async function promoteMirror(directory, store, verifyPublished, verifyPublic) {
  const bytes = await readFile(join(directory, 'manifest.json'));
  const manifest = validateManifest(JSON.parse(bytes));
  await verifyPublished(manifest);
  // Both the authenticated and anonymous readers must see exactly the staged release.
  const staged = await store.get(`${prefix}/releases/${manifest.tag}/manifest.json`);
  if (!staged?.equals(bytes)) throw new Error('Staged mirror manifest does not match.');
  for (const asset of manifest.assets) await verifyPublic(`${mirrorBase}/releases/${manifest.tag}/${asset.name}`, asset);
  const latest = await currentIndex(manifest, bytes, store);
  if (latest?.equals(bytes)) return manifest;
  await store.put(`${prefix}/latest.json`, bytes, 'no-cache, max-age=0, must-revalidate');
  if (!(await store.get(`${prefix}/latest.json`))?.equals(bytes))
    throw new Error('Mirror index readback failed; promotion outcome is uncertain. Retry this release to verify it; do not roll back the index.');
  return manifest;
}
export async function verifyPublicAsset(url, asset) {
  if (!url.startsWith(`${mirrorBase}/releases/`) && !url.startsWith(`${mirrorBase}/verification/uploads/`))
    throw new Error('Unexpected public mirror path.');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Public mirror read failed: HTTP ${response.status}`);
  let bytes = 0;
  const hash = createHash('sha256');
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > asset.bytes) throw new Error('Oversized mirror response.');
    hash.update(chunk);
  }
  if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) throw new Error('Public mirror checksum mismatch.');
}
export async function verifyGitHubRelease(manifest, { list = githubReleases, resolveCommit } = {}) {
  const { execFileSync } = await import('node:child_process');
  const release = inspectRelease(manifest.tag, await list());
  if (!release || release.draft || release.prerelease || release.tag_name !== manifest.tag || !release.published_at)
    throw new Error('Expected a published stable GitHub release.');
  const commit = resolveCommit ? await resolveCommit(manifest.tag)
    : execFileSync('git', ['rev-parse', `${manifest.tag}^{commit}`], { encoding: 'utf8' }).trim();
  if (release.created_at !== manifest.publishedAt) throw new Error('Mirror snapshot time differs from GitHub release creation time.');
  if (commit !== manifest.commit) throw new Error('GitHub release source mismatch.');
  for (const asset of manifest.assets.filter(a => a.name.startsWith('computer-use-'))) {
    const remote = release.assets.find(a => a.name === asset.name);
    if (!remote || remote.size !== asset.bytes || remote.digest !== `sha256:${asset.sha256}`)
      throw new Error(`GitHub release asset mismatch: ${asset.name}`);
  }
}
// Existing release objects are deliberately skipped. An explicit operator check
// uses one unique key containing public release bytes, never overwrites a release.
export async function verifyUpload(directory, probeId, store, verifyPublished, verifyPublic) {
  if (!/^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$/.test(probeId ?? '')) throw new Error('Invalid upload verification run ID.');
  const manifest = validateManifest(JSON.parse(await readFile(join(directory, 'manifest.json'))));
  await verifyPublished(manifest);
  const asset = manifest.assets.reduce((largest, item) => item.bytes > largest.bytes ? item : largest);
  const bytes = await readFile(join(directory, asset.name));
  if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) throw new Error('Upload verification source changed.');
  const key = `${prefix}/verification/uploads/${probeId}/${asset.name}`;
  if (await store.get(key)) throw new Error('Upload verification key already exists; use a new workflow attempt.');
  await store.put(key, bytes, 'public, max-age=31536000, immutable');
  const uploaded = await store.get(key);
  if (!uploaded || uploaded.length !== asset.bytes || sha256(uploaded) !== asset.sha256)
    throw new Error('Upload verification readback failed.');
  await verifyPublic(`${mirrorBase}/verification/uploads/${probeId}/${asset.name}`, asset);
  console.log(`Upload verification retained public release bytes at ${key}; ${asset.bytes} bytes, SHA-256 ${asset.sha256}.`);
  return manifest;
}

const retryable = error => [408, 429, 500, 502, 503, 504].includes(error.statusCode) ||
  ['ESOCKETTIMEDOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'UPLOAD_DEADLINE'].includes(error.code);
const failure = error => {
  // SDK errors may contain signed requests. Never log the raw error or its cause.
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 'unknown';
  const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(error.code) ? error.code : 'UNKNOWN';
  return `HTTP ${status}, ${code}`;
};

export function createCosStore(client, { signal, timeoutMs, heartbeatMs, wait = delay, log = console.log } = {}) {
  const common = { Bucket: 'computer-use-download-1308799022', Region: 'ap-guangzhou' };
  const progress = (method, key) => {
    const started = Date.now();
    log(`COS ${method} ${key}: started`);
    return result => log(`COS ${method} ${key}: ${result} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  };
  const storage = {
    async get(Key) {
      const report = progress('GET', Key);
      try {
        const bytes = Buffer.from((await client.getObject({ ...common, Key })).Body);
        report(`${bytes.length} bytes`);
        return bytes;
      } catch (error) {
        if (error.statusCode === 404) { report('not found'); return null; }
        report(`failed (${failure(error)})`);
        throw new Error(`COS read failed for ${Key} (${failure(error)}).`);
      }
    },
    async put(Key, Body, CacheControl) {
      const report = progress('PUT', Key);
      // Index writes can have an uncertain outcome. Do not replay them inside the
      // transport: retrying the release must first recheck the monotonic index.
      const attempts = Key === `${prefix}/latest.json` ? 1 : 3;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (signal?.aborted) throw new Error('COS upload interrupted (UPLOAD_ABORTED).');
        report(`attempt ${attempt}/${attempts}`);
        try {
          await uploadOnce(client, { ...common, Key, Body, ContentLength: Body.length, CacheControl,
            ServerSideEncryption: 'AES256', ContentType: Key.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          }, { timeoutMs, heartbeatMs, signal, report });
          report(`${Body.length} bytes`);
          return;
        } catch (error) {
          report(`attempt ${attempt} failed (${failure(error)})`);
          if (signal?.aborted || error.code === 'UPLOAD_ABORTED' || attempt === attempts || !retryable(error))
            throw new Error(`COS upload failed for ${Key} (${failure(error)}).`);
          // A timed-out PUT may already be committed. Only an authenticated 404
          // permits another PUT; equal bytes are success, any other bytes stop.
          const existing = await storage.get(Key);
          if (signal?.aborted) throw new Error('COS upload interrupted (UPLOAD_ABORTED).');
          if (existing) {
            if (existing.length !== Body.length || sha256(existing) !== sha256(Body))
              throw new Error(`Refusing to overwrite immutable release file after uncertain upload: ${Key}`);
            report('confirmed committed bytes after uncertain upload');
            return;
          }
          await wait(1000 * 2 ** (attempt - 1), undefined, { signal });
        }
      }
    },
  };
  return storage;
}

function cosStore(signal) {
  if (!process.env.COS_SECRET_ID || !process.env.COS_SECRET_KEY || !process.env.COS_SDK_DIRECTORY)
    throw new Error('Missing COS publishing secrets or SDK directory.');
  // CI-only official SDK; no cloud SDK or credentials are bundled in the App or npm launcher.
  const require = createRequire(join(resolve(process.env.COS_SDK_DIRECTORY), 'package.json'));
  const COS = require('cos-nodejs-sdk-v5');
  // Read operations retain SDK retries. Streamed PUTs have explicit retries and
  // a cancellable total deadline in addition to this socket idle timeout.
  const client = new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY,
    ...(process.env.COS_SECURITY_TOKEN ? { SecurityToken: process.env.COS_SECURITY_TOKEN } : {}),
    Protocol: 'https:', Timeout: 60_000 });
  console.log(`Mirror runtime: ${process.version} (${process.execPath})`);
  return createCosStore(client, { signal });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, directory] = process.argv.slice(2);
  if (!['upload', 'promote', 'verify-upload'].includes(command) || !directory || process.argv.length !== 4)
    throw new Error('Usage: publish-mirror.mjs upload|promote|verify-upload DIRECTORY');
  const abort = new AbortController();
  const interrupted = () => {
    abort.abort();
    console.error('Mirror interrupted. Retry the same release to check any uncertain writes.');
    process.exit(130);
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  const run = async () => {
    const store = cosStore(abort.signal);
    const m = command === 'upload' ? await uploadMirror(directory, store) : command === 'promote'
      ? await promoteMirror(directory, store, verifyGitHubRelease, verifyPublicAsset)
      : await verifyUpload(directory, process.env.MIRROR_UPLOAD_PROBE_ID, store, verifyGitHubRelease, verifyPublicAsset);
    console.log(`${command}: ${m.tag} verified.`);
  };
  run().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  });
}
