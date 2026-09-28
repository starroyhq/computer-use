import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { sha256 } from './fetch-runtime.mjs';
import { assertInternalLinks, signingIdentity } from './package-app.mjs';

test('signing identity comes from --identity, then the ignored local env file, then ad-hoc', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-signing-test-'));
  try {
    const file = join(directory, '.env.local');
    assert.equal(await signingIdentity([], file), '-');
    await writeFile(file, 'OTHER_SECRET=ignored\nCOMPUTER_USE_SIGNING_IDENTITY="Developer ID Application: Local (TEAM)"\n');
    assert.equal(await signingIdentity([], file), 'Developer ID Application: Local (TEAM)');
    assert.equal(
      await signingIdentity(['--identity', 'Developer ID Application: Explicit (X)'], file),
      'Developer ID Application: Explicit (X)',
    );
    assert.equal(process.env.OTHER_SECRET, undefined);
    await assert.rejects(signingIdentity(['--unknown'], file), /Usage/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('archive checksum reads actual bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-checksum-test-'));
  try {
    const path = join(directory, 'payload');
    await writeFile(path, 'abc');
    assert.equal(await sha256(path), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    await writeFile(path, 'modified');
    assert.notEqual(await sha256(path), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bundle accepts internal dependency links and rejects escaped and broken links', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-bundle-test-'));
  try {
    const bundle = join(directory, 'bundle');
    await mkdir(bundle);
    await writeFile(join(bundle, 'module.js'), 'export {};');
    await symlink('module.js', join(bundle, 'alias.js'));
    await assertInternalLinks(bundle);
    await writeFile(join(directory, 'external.js'), 'external');
    await symlink('../external.js', join(bundle, 'escape.js'));
    await assert.rejects(assertInternalLinks(bundle), /external symlink/);
    await rm(join(bundle, 'escape.js'));
    await symlink('missing.js', join(bundle, 'broken.js'));
    await assert.rejects(assertInternalLinks(bundle));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
