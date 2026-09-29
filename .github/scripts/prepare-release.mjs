import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const platforms = ['macos-arm64', 'windows-arm64', 'windows-x64'];

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function prepareRelease(inputRoot, outputRoot, version, commit) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid release version or commit.');
  const prepared = [];
  for (const platform of platforms) {
    const directory = join(inputRoot, platform);
    const mac = platform === 'macos-arm64';
    const sourceName = `computer-use-${version}-${platform}-${commit.slice(0, 12)}-${mac ? 'notarized' : 'dev'}`;
    const expected = [`${sourceName}.json`, `${sourceName}.zip`, `${sourceName}.zip.sha256`].sort();
    const actual = (await readdir(directory)).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Unexpected ${platform} artifact contents: ${actual.join(', ')}`);
    const sourceArchive = join(directory, `${sourceName}.zip`);
    const metadata = JSON.parse(await readFile(join(directory, `${sourceName}.json`), 'utf8'));
    const checksum = await readFile(join(directory, `${sourceName}.zip.sha256`), 'utf8');
    if (metadata.version !== version || metadata.platform !== platform || metadata.commit !== commit || metadata.sourceDirty !== false ||
      metadata.archive !== basename(sourceArchive) || metadata.signing !== (mac ? 'developer-id-notarized' : 'unsigned') ||
      (mac && metadata.notarization !== 'stapled') ||
      typeof metadata.verification !== 'string' || !metadata.verification) throw new Error(`Invalid ${platform} build metadata.`);
    const digest = await sha256(sourceArchive);
    if (metadata.sha256 !== digest || metadata.bytes !== (await stat(sourceArchive)).size ||
      checksum !== `${digest}  ${basename(sourceArchive)}\n`) throw new Error(`Invalid ${platform} archive checksum.`);
    prepared.push({ platform, sourceArchive, metadata, digest });
  }
  await mkdir(outputRoot);
  for (const { platform, sourceArchive, metadata, digest } of prepared) {
    const name = `computer-use-${version}-${platform}.zip`;
    await rename(sourceArchive, join(outputRoot, name));
    await writeFile(join(outputRoot, `${name}.sha256`), `${digest}  ${name}\n`);
    await writeFile(join(outputRoot, `computer-use-${version}-${platform}.json`), JSON.stringify({ ...metadata, archive: name }, null, 2) + '\n');
    console.log(`Prepared ${name} (${digest})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 4) throw new Error('Usage: prepare-release.mjs INPUT OUTPUT VERSION COMMIT');
  prepareRelease(...args).catch(error => { console.error(error.message); process.exitCode = 1; });
}
