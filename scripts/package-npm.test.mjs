import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  normalizeArchiveModes,
  packageFiles,
  packageNpm,
  parseArguments,
  readPackageArchive,
  validateManifest,
  verifyNpmArchive,
} from './package-npm.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function manifest() {
  return {
    name: '@starroy/computer-use',
    version: '0.7.0',
    type: 'module',
    license: 'MIT',
    bin: { 'computer-use': 'bin/computer-use.mjs' },
    files: packageFiles.filter(path => path !== 'package.json'),
    repository: { type: 'git', url: 'git+https://github.com/starroyhq/computer-use.git', directory: 'packages/npm' },
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' },
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cu-npm 空格 & $()'-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.7.0', private: true }));
  for (const file of packageFiles) {
    let destination;
    let content;
    if (file.startsWith('resources/')) {
      destination = join(root, 'skills', 'computer-use', file.slice('resources/'.length));
      content = await readFile(join(ROOT, 'skills', 'computer-use', file.slice('resources/'.length)));
    } else if (['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'].includes(file)) {
      destination = join(root, file);
      content = await readFile(join(ROOT, file));
    } else {
      destination = join(root, 'packages', 'npm', file);
      content = {
        'package.json': JSON.stringify(manifest(), null, 2),
        'README.md': '# Package fixture\n',
        'bin/computer-use.mjs': "#!/usr/bin/env node\nimport { message } from '../lib/launcher.mjs';\nconsole.log(message);\n",
        'lib/launcher.mjs': "export const message = 'launcher fixture';\n",
      }[file];
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  return root;
}

test('npm packaging accepts only one optional output directory', () => {
  assert.deepEqual(parseArguments([]), {});
  assert.deepEqual(parseArguments(['--out', 'artifacts/npm']), { output: resolve('artifacts/npm') });
  for (const args of [['--out'], ['--out', '--bad'], ['--out', 'a', '--out', 'b'], ['--publish']]) {
    assert.throws(() => parseArguments(args), /Usage/);
  }
});

test('manifest forbids accidental root publishing, dependency installation, hooks and broad file patterns', () => {
  const valid = manifest();
  validateManifest(valid);
  for (const change of [
    { name: 'computer-use' },
    { version: '0.7.1-beta.1' },
    { private: true },
    { type: 'commonjs' },
    { bin: { 'computer-use': 'dist/cli.js' } },
    { repository: { url: 'git+https://github.com/other/project.git' } },
    { dependencies: { unexpected: '*' } },
    { optionalDependencies: { unexpected: '*' } },
    { peerDependencies: { unexpected: '*' } },
    { bundledDependencies: ['unexpected'] },
    { scripts: { prepublishOnly: 'echo unsafe' } },
    { files: ['bin', 'lib', 'resources'] },
    { publishConfig: { access: 'restricted', registry: 'https://registry.npmjs.org' } },
  ]) {
    assert.throws(() => validateManifest({ ...valid, ...change }));
  }
});

test('archive contains only the launcher, exact maintained bootstrap bytes and notices; packed entry runs', async t => {
  const root = await fixture(t);
  const source = join(root, 'packages', 'npm');
  for (const path of ['.npmrc', '.env', 'credential.json', 'dist/cli.js', 'node_modules/unwanted/index.js', 'resources/extra.txt']) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), 'DO_NOT_SHIP_THIS_FIXTURE');
  }
  const output = join(root, 'custom output & 空间');
  const result = await packageNpm({ root, output });
  assert.equal(result.path, join(output, 'starroy-computer-use-0.7.0.tgz'));
  assert.equal(result.name, '@starroy/computer-use');
  assert.deepEqual(result.files, packageFiles);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  const bytes = await readFile(result.path);
  const entries = readPackageArchive(bytes);
  assert.equal(gunzipSync(bytes).includes(Buffer.from('DO_NOT_SHIP_THIS_FIXTURE')), false);
  const extracted = join(root, 'extracted');
  for (const [file, entry] of entries) {
    await mkdir(dirname(join(extracted, file)), { recursive: true });
    await writeFile(join(extracted, file), entry.content);
  }
  const run = spawnSync(process.execPath, [join(extracted, 'bin/computer-use.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'launcher fixture');
  assert.deepEqual(await verifyNpmArchive(result.path, { root }), result);
  assert.deepEqual(await readdir(join(root, '.cache')), []);
  // Rebuilding is safe and deterministic, including a non-default output path.
  const repeated = await packageNpm({ root, output });
  assert.equal(repeated.sha256, result.sha256);
  assert.deepEqual(await readdir(output), [result.filename]);
});

test('missing resources fail without emitting a publishable archive or leaving staging files', async t => {
  const root = await fixture(t);
  await rm(join(root, 'skills', 'computer-use', 'bootstrap-windows.ps1'));
  await assert.rejects(packageNpm({ root }), /ENOENT/);
  assert.deepEqual(await readdir(join(root, '.cache')), []);
  await assert.rejects(readFile(join(root, 'artifacts', 'npm', 'starroy-computer-use-0.7.0.tgz')), /ENOENT/);
});

test('npm versions are independent of the App while the archive must match the npm source manifest', async t => {
  const root = await fixture(t);
  const path = join(root, 'packages', 'npm', 'package.json');
  await writeFile(path, JSON.stringify({ ...manifest(), version: '0.7.1' }));
  const result = await packageNpm({ root });
  assert.equal(result.version, '0.7.1');
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, '0.7.0');
  await writeFile(path, JSON.stringify({ ...manifest(), version: '0.7.2' }));
  await assert.rejects(verifyNpmArchive(result.path, { root }), /Packed package.json differs/);
});

test('Windows-style tar permissions are normalized without weakening executable and checksum validation', async t => {
  const root = await fixture(t);
  const result = await packageNpm({ root });
  const original = await readFile(result.path);
  const originalEntries = readPackageArchive(original);
  const tar = gunzipSync(original);
  let binHeader;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii'), 8);
    // NTFS does not preserve the chmod(0755) performed before npm pack.
    header.write('0000666\0', 100, 8, 'ascii');
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    if (name === 'package/bin/computer-use.mjs') binHeader = header;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(binHeader);
  const windowsArchive = gzipSync(tar);
  assert.throws(() => readPackageArchive(windowsArchive), /not executable/);
  const normalized = normalizeArchiveModes(windowsArchive);
  const entries = readPackageArchive(normalized);
  for (const [path, { content, mode }] of entries) {
    assert.equal(mode, path === 'bin/computer-use.mjs' ? 0o755 : 0o644);
    assert.deepEqual(content, originalEntries.get(path).content);
  }
  await writeFile(result.path, normalized);
  await verifyNpmArchive(result.path, { root });
  // Do not silently repair a corrupt header while setting its executable bit.
  binHeader[100] = '1'.charCodeAt(0);
  assert.throws(() => normalizeArchiveModes(gzipSync(tar)), /Invalid or unexpected entry/);
});

test('symlink sources cannot include unrelated private files', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t);
  const source = join(root, 'packages', 'npm', 'lib', 'launcher.mjs');
  await copyFile(source, join(root, 'private-file'));
  await rm(source);
  await symlink(join(root, 'private-file'), source);
  await assert.rejects(packageNpm({ root }), /regular file/);
});

test('artifact verification detects bootstrap drift and tampered bytes', async t => {
  const root = await fixture(t);
  const result = await packageNpm({ root });
  const bytes = await readFile(result.path);
  const tar = gunzipSync(bytes);
  const marker = await readFile(join(root, 'skills', 'computer-use', 'bootstrap-macos.sh'));
  const position = tar.indexOf(marker);
  assert.ok(position > 0);
  tar[position] = 'X'.charCodeAt(0);
  await writeFile(result.path, gzipSync(tar));
  await assert.rejects(verifyNpmArchive(result.path, { root }), /Packed resource differs/);
  await writeFile(result.path, bytes);
  await writeFile(join(root, 'skills', 'computer-use', 'bootstrap-macos.sh'), '# changed after packing\n');
  await assert.rejects(verifyNpmArchive(result.path, { root }), /Packed resource differs/);
});
