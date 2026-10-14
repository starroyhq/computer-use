import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  if (!url.startsWith(`${mirrorBase}/releases/`)) throw new Error('Unexpected public mirror path.');
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
function cosStore() {
  if (!process.env.COS_SECRET_ID || !process.env.COS_SECRET_KEY || !process.env.COS_SDK_DIRECTORY)
    throw new Error('Missing COS publishing secrets or SDK directory.');
  // CI-only official SDK; no cloud SDK or credentials are bundled in the App or npm launcher.
  const require = createRequire(join(resolve(process.env.COS_SDK_DIRECTORY), 'package.json'));
  const COS = require('cos-nodejs-sdk-v5');
  // This is a connection/socket idle timeout, not a limit on a progressing large transfer.
  // The pinned SDK retries network failures itself; MaxRetryTimes is not a supported option.
  const client = new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY,
    ...(process.env.COS_SECURITY_TOKEN ? { SecurityToken: process.env.COS_SECURITY_TOKEN } : {}),
    Protocol: 'https:', Timeout: 60_000 });
  const common = { Bucket: 'computer-use-download-1308799022', Region: 'ap-guangzhou' };
  const progress = (method, key) => {
    const started = Date.now();
    console.log(`COS ${method} ${key}: started`);
    return result => console.log(`COS ${method} ${key}: ${result} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  };
  const failure = error => {
    // SDK errors may contain signed requests. Only report bounded codes, never the raw error.
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 'unknown';
    const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(error.code) ? error.code : 'UNKNOWN';
    return `HTTP ${status}, ${code}`;
  };
  console.log(`Mirror runtime: ${process.version} (${process.execPath})`);
  return {
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
      let lastProgressAt = 0;
      try {
        await client.putObject({ ...common, Key, Body, ContentLength: Body.length, CacheControl,
          ServerSideEncryption: 'AES256', ContentType: Key.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          onProgress({ loaded, total }) {
            const now = Date.now();
            if (now - lastProgressAt >= 15_000 || loaded === total) {
              report(`transferred ${loaded}/${total} bytes`);
              lastProgressAt = now;
            }
          },
        });
        report(`${Body.length} bytes`);
      } catch (error) {
        report(`failed (${failure(error)})`);
        throw new Error(`COS upload failed for ${Key} (${failure(error)}).`);
      }
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, directory] = process.argv.slice(2);
  if (!['upload', 'promote'].includes(command) || !directory || process.argv.length !== 4)
    throw new Error('Usage: publish-mirror.mjs upload|promote DIRECTORY');
  const run = async () => {
    const store = cosStore();
    const m = command === 'upload' ? await uploadMirror(directory, store) : await promoteMirror(directory, store, verifyGitHubRelease, verifyPublicAsset);
    console.log(`${command}: ${m.tag} verified.`);
  };
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
