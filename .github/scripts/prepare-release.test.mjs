import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareRelease } from './prepare-release.mjs';

const commit = 'a'.repeat(40);
const platforms = ['macos-arm64', 'windows-arm64', 'windows-x64'];

async function fixture(root) {
  for (const platform of platforms) {
    const directory = join(root, 'input', platform);
    await mkdir(directory, { recursive: true });
    const base = `computer-use-0.2.0-${platform}-${commit.slice(0, 12)}-dev`;
    const bytes = Buffer.from(`archive for ${platform}`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(directory, `${base}.zip`), bytes);
    await writeFile(join(directory, `${base}.zip.sha256`), `${digest}  ${base}.zip\n`);
    await writeFile(join(directory, `${base}.json`), JSON.stringify({
      version: '0.2.0', platform, commit, sourceDirty: false, archive: `${base}.zip`,
      bytes: bytes.length, sha256: digest,
      signing: platform === 'macos-arm64' ? 'ad-hoc-development' : 'unsigned',
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
    assert.equal((await readdir(output)).length, 9);
    for (const platform of platforms) {
      const base = `computer-use-0.2.0-${platform}`;
      const archive = `${base}.zip`;
      const metadata = JSON.parse(await readFile(join(output, `${base}.json`), 'utf8'));
      assert.equal(metadata.archive, archive);
      assert.equal(metadata.bytes, (await stat(join(output, archive))).size);
      assert.equal(await readFile(join(output, `${archive}.sha256`), 'utf8'), `${metadata.sha256}  ${archive}\n`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a modified archive before moving any assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'computer-use-release-'));
  try {
    await fixture(root);
    const archive = join(root, 'input', 'windows-x64', `computer-use-0.2.0-windows-x64-${commit.slice(0, 12)}-dev.zip`);
    await writeFile(archive, 'different bytes');
    const output = join(root, 'release');
    await assert.rejects(prepareRelease(join(root, 'input'), output, '0.2.0', commit), /checksum/);
    await assert.rejects(stat(output), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
