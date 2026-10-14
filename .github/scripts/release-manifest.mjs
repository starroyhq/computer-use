import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const repository = 'starroyhq/computer-use';
export const mirrorBase = 'https://computer-use-download-1308799022.cos.ap-guangzhou.myqcloud.com/computer-use';
export const platforms = ['macos-arm64', 'windows-arm64', 'windows-x64'];
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
export function compareVersions(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !versionPattern.test(a) || !versionPattern.test(b)) throw new Error('Invalid release version.');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
export function validateManifest(m) {
  if (!m || m.schemaVersion !== 1 || m.repository !== repository || typeof m.version !== 'string' || !versionPattern.test(m.version) ||
      m.tag !== `v${m.version}` || typeof m.commit !== 'string' || !/^[a-f0-9]{40}$/.test(m.commit) ||
      typeof m.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(m.publishedAt) || !Number.isFinite(Date.parse(m.publishedAt)) ||
      !Array.isArray(m.assets) || m.assets.length < 18 || m.assets.length > 128) throw new Error('Invalid release manifest.');
  const seen = new Set();
  for (const a of m.assets) {
    if (!a || typeof a.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(a.name) || seen.has(a.name) ||
        !Number.isSafeInteger(a.bytes) || a.bytes <= 0 || a.bytes > 2_147_483_648 || typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256))
      throw new Error('Invalid release asset.');
    seen.add(a.name);
  }
  for (const name of [...releaseNames(m.version), 'SKILL.md', 'LICENSE.md', 'release-notes.md']) {
    if (!seen.has(name)) throw new Error(`Missing release asset: ${name}`);
  }
  return m;
}
export function releaseNames(version) {
  if (typeof version !== 'string' || !versionPattern.test(version)) throw new Error('Invalid release version.');
  return platforms.flatMap(platform => {
    const base = `computer-use-${version}-${platform}`;
    const installer = base + (platform === 'macos-arm64' ? '.dmg' : '-setup.exe');
    return [`${base}.zip`, `${base}.zip.sha256`, `${base}.json`, installer, `${installer}.sha256`];
  });
}
export async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { bytes: (await stat(path)).size, sha256: hash.digest('hex') };
}
export async function prepareMirror({ input, output, version, commit, publishedAt, readSource }) {
  if (typeof version !== 'string' || !versionPattern.test(version) || typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid release source.');
  const names = releaseNames(version);
  if (JSON.stringify((await readdir(input)).sort()) !== JSON.stringify([...names].sort()))
    throw new Error('Expected exactly the 15 verified release files.');
  const assets = [];
  for (const name of names) assets.push({ name, ...await digestFile(join(input, name)) });
  for (const platform of platforms) {
    const base = `computer-use-${version}-${platform}`;
    const m = JSON.parse(await readFile(join(input, `${base}.json`), 'utf8'));
    const installer = base + (platform === 'macos-arm64' ? '.dmg' : '-setup.exe');
    if (m.version !== version || m.commit !== commit || m.platform !== platform || m.sourceDirty !== false ||
        m.archive !== `${base}.zip` || m.installer?.name !== installer ||
        m.signing !== (platform === 'macos-arm64' ? 'developer-id-notarized' : 'unsigned') ||
        (platform === 'macos-arm64' && m.notarization !== 'stapled')) throw new Error('Release metadata/source mismatch.');
    for (const [name, hash, bytes] of [[m.archive, m.sha256, m.bytes], [installer, m.installer.sha256, m.installer.bytes]]) {
      const a = assets.find(a => a.name === name);
      if (a.sha256 !== hash || a.bytes !== bytes || (await readFile(join(input, `${name}.sha256`), 'utf8')) !== `${hash}  ${name}\n`)
        throw new Error(`Release checksum mismatch: ${name}`);
    }
  }
  // Read docs from the exact release commit, never a dirty checkout or moving main.
  const source = readSource ?? (path => execFileSync('git', ['show', `${commit}:${path}`]));
  const docs = new Map([
    ['SKILL.md', await source('skills/computer-use/SKILL.md')],
    ['LICENSE.md', await source('LICENSE')],
    ['release-notes.md', await source(`.github/release-notes/v${version}.md`)],
  ]);
  for (const [name, value] of docs) {
    const bytes = Buffer.from(value);
    assets.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  // The field name is shared with consumers; its stable value is GitHub release.created_at, including while still a draft.
  const manifest = validateManifest({ schemaVersion: 1, repository, version, tag: `v${version}`, commit, publishedAt,
    assets: assets.sort((a, b) => a.name.localeCompare(b.name, 'en')) });
  await mkdir(output, { recursive: true });
  for (const a of assets) {
    const path = join(output, a.name);
    try {
      const existing = await digestFile(path);
      if (existing.sha256 !== a.sha256 || existing.bytes !== a.bytes) throw new Error(`Refusing to replace ${a.name}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (docs.has(a.name)) await writeFile(path, docs.get(a.name), { flag: 'wx' });
      else await copyFile(join(input, a.name), path, 1);
    }
  }
  const text = JSON.stringify(manifest, null, 2) + '\n';
  try {
    const previous = await readFile(join(output, 'manifest.json'), 'utf8');
    if (previous !== text) throw new Error('Refusing to replace the release manifest.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(join(output, 'manifest.json'), text, { flag: 'wx' });
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output, version, commit, publishedAt] = process.argv.slice(2);
  if (!publishedAt || process.argv.length !== 7) throw new Error('Usage: release-manifest.mjs INPUT OUTPUT VERSION COMMIT PUBLISHED_AT');
  prepareMirror({ input, output, version, commit, publishedAt }).then(m => console.log(`Prepared ${m.tag}: ${m.assets.length} verified mirror files.`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
