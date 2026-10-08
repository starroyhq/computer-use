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

// 首次安装用的安装包：macOS 为 DMG，Windows 为安装程序。与 src/update.ts 的 installerName() 一致。
const installerSuffix = platform => (platform === 'macos-arm64' ? '.dmg' : '-setup.exe');

export async function prepareRelease(inputRoot, outputRoot, version, commit) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid release version or commit.');
  const prepared = [];
  for (const platform of platforms) {
    const directory = join(inputRoot, platform);
    const mac = platform === 'macos-arm64';
    const sourceName = `computer-use-${version}-${platform}-${commit.slice(0, 12)}-${mac ? 'notarized' : 'dev'}`;
    const sourceInstallerName = `${sourceName}${installerSuffix(platform)}`;
    const expected = [
      `${sourceName}.json`,
      `${sourceName}.zip`,
      `${sourceName}.zip.sha256`,
      sourceInstallerName,
      `${sourceInstallerName}.sha256`,
    ].sort();
    const actual = (await readdir(directory)).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Unexpected ${platform} artifact contents: ${actual.join(', ')}`);
    const sourceArchive = join(directory, `${sourceName}.zip`);
    const sourceInstaller = join(directory, sourceInstallerName);
    const metadata = JSON.parse(await readFile(join(directory, `${sourceName}.json`), 'utf8'));
    const checksum = await readFile(join(directory, `${sourceName}.zip.sha256`), 'utf8');
    const installerChecksum = await readFile(`${sourceInstaller}.sha256`, 'utf8');
    if (metadata.version !== version || metadata.platform !== platform || metadata.commit !== commit || metadata.sourceDirty !== false ||
      metadata.archive !== basename(sourceArchive) || metadata.signing !== (mac ? 'developer-id-notarized' : 'unsigned') ||
      (mac && metadata.notarization !== 'stapled') || metadata.installer?.name !== sourceInstallerName ||
      typeof metadata.verification !== 'string' || !metadata.verification) throw new Error(`Invalid ${platform} build metadata.`);
    const digest = await sha256(sourceArchive);
    if (metadata.sha256 !== digest || metadata.bytes !== (await stat(sourceArchive)).size ||
      checksum !== `${digest}  ${basename(sourceArchive)}\n`) throw new Error(`Invalid ${platform} archive checksum.`);
    const installerDigest = await sha256(sourceInstaller);
    if (metadata.installer.sha256 !== installerDigest || metadata.installer.bytes !== (await stat(sourceInstaller)).size ||
      installerChecksum !== `${installerDigest}  ${sourceInstallerName}\n`) throw new Error(`Invalid ${platform} installer checksum.`);
    prepared.push({ platform, sourceArchive, sourceInstaller, metadata, digest, installerDigest });
  }
  await mkdir(outputRoot);
  for (const { platform, sourceArchive, sourceInstaller, metadata, digest, installerDigest } of prepared) {
    const name = `computer-use-${version}-${platform}.zip`;
    const installer = `computer-use-${version}-${platform}${installerSuffix(platform)}`;
    await rename(sourceArchive, join(outputRoot, name));
    await writeFile(join(outputRoot, `${name}.sha256`), `${digest}  ${name}\n`);
    await rename(sourceInstaller, join(outputRoot, installer));
    await writeFile(join(outputRoot, `${installer}.sha256`), `${installerDigest}  ${installer}\n`);
    await writeFile(
      join(outputRoot, `computer-use-${version}-${platform}.json`),
      JSON.stringify({ ...metadata, archive: name, installer: { ...metadata.installer, name: installer } }, null, 2) + '\n',
    );
    console.log(`Prepared ${name} (${digest}) and ${installer} (${installerDigest})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 4) throw new Error('Usage: prepare-release.mjs INPUT OUTPUT VERSION COMMIT');
  prepareRelease(...args).catch(error => { console.error(error.message); process.exitCode = 1; });
}
