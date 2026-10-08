import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareRelease } from './prepare-release.mjs';

const commit = 'a'.repeat(40);
const platforms = ['macos-arm64', 'windows-arm64', 'windows-x64'];
const installerSuffix = platform => (platform === 'macos-arm64' ? '.dmg' : '-setup.exe');
const sourceBase = platform => `computer-use-0.2.0-${platform}-${commit.slice(0, 12)}-${platform === 'macos-arm64' ? 'notarized' : 'dev'}`;

async function fixture(root) {
  for (const platform of platforms) {
    const directory = join(root, 'input', platform);
    await mkdir(directory, { recursive: true });
    const mac = platform === 'macos-arm64';
    const base = sourceBase(platform);
    const bytes = Buffer.from(`archive for ${platform}`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(directory, `${base}.zip`), bytes);
    await writeFile(join(directory, `${base}.zip.sha256`), `${digest}  ${base}.zip\n`);
    const installer = `${base}${installerSuffix(platform)}`;
    const installerBytes = Buffer.from(`installer for ${platform}`);
    const installerDigest = createHash('sha256').update(installerBytes).digest('hex');
    await writeFile(join(directory, installer), installerBytes);
    await writeFile(join(directory, `${installer}.sha256`), `${installerDigest}  ${installer}\n`);
    await writeFile(join(directory, `${base}.json`), JSON.stringify({
      version: '0.2.0', platform, commit, sourceDirty: false, archive: `${base}.zip`,
      bytes: bytes.length, sha256: digest,
      signing: mac ? 'developer-id-notarized' : 'unsigned',
      ...(mac ? { notarization: 'stapled' } : {}),
      installer: { name: installer, bytes: installerBytes.length, sha256: installerDigest },
      verification: 'Archive extracted and verified.',
    }));
  }
}

test('renames verified CI artifacts and updates their checksum references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'computer-use-release-'));
  try {
    await fixture(root);
    const output = join(root, 'release');
    await prepareRelease(join(root, 'input'), output, '0.2.0', commit);
    assert.equal((await readdir(output)).length, 15);
    for (const platform of platforms) {
      const base = `computer-use-0.2.0-${platform}`;
      const archive = `${base}.zip`;
      const installer = `${base}${installerSuffix(platform)}`;
      const metadata = JSON.parse(await readFile(join(output, `${base}.json`), 'utf8'));
      assert.equal(metadata.archive, archive);
      assert.equal(metadata.bytes, (await stat(join(output, archive))).size);
      assert.equal(await readFile(join(output, `${archive}.sha256`), 'utf8'), `${metadata.sha256}  ${archive}\n`);
      assert.equal(metadata.installer.name, installer);
      assert.equal(metadata.installer.bytes, (await stat(join(output, installer))).size);
      assert.equal(await readFile(join(output, installer), 'utf8'), `installer for ${platform}`);
      assert.equal(await readFile(join(output, `${installer}.sha256`), 'utf8'), `${metadata.installer.sha256}  ${installer}\n`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a modified archive before moving any assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'computer-use-release-'));
  try {
    await fixture(root);
    const archive = join(root, 'input', 'windows-x64', `${sourceBase('windows-x64')}.zip`);
    await writeFile(archive, 'different bytes');
    const output = join(root, 'release');
    await assert.rejects(prepareRelease(join(root, 'input'), output, '0.2.0', commit), /archive checksum/);
    await assert.rejects(stat(output), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a modified installer before moving any assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'computer-use-release-'));
  try {
    await fixture(root);
    const installer = join(root, 'input', 'windows-arm64', `${sourceBase('windows-arm64')}-setup.exe`);
    await writeFile(installer, 'different bytes');
    const output = join(root, 'release');
    await assert.rejects(prepareRelease(join(root, 'input'), output, '0.2.0', commit), /installer checksum/);
    await assert.rejects(stat(output), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects artifacts without an installer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'computer-use-release-'));
  try {
    await fixture(root);
    const dmg = join(root, 'input', 'macos-arm64', `${sourceBase('macos-arm64')}.dmg`);
    await rm(dmg);
    await rm(`${dmg}.sha256`);
    await assert.rejects(prepareRelease(join(root, 'input'), join(root, 'release'), '0.2.0', commit), /Unexpected macos-arm64 artifact contents/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an ad-hoc macOS package from release input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'computer-use-release-'));
  try {
    await fixture(root);
    const path = join(root, 'input', 'macos-arm64', `${sourceBase('macos-arm64')}.json`);
    const metadata = JSON.parse(await readFile(path, 'utf8'));
    metadata.signing = 'ad-hoc-development';
    await writeFile(path, JSON.stringify(metadata));
    await assert.rejects(prepareRelease(join(root, 'input'), join(root, 'release'), '0.2.0', commit), /metadata/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
