import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareVersions, mirrorBase, platforms, prepareMirror, releaseNames, validateManifest } from './release-manifest.mjs';
import { promoteMirror, uploadMirror, verifyGitHubRelease, verifyPublicAsset } from './publish-mirror.mjs';
import { inspectRelease, runReleaseCommand, verifyReleaseAssets } from './verify-release.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const latestKey = 'computer-use/latest.json';
const serialized = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

test('COS CLI reports progress and propagates network failures without exposing signed request details', async t => {
  const f = await fixture(t);
  await f.prepare();
  const sdk = join(f.output, '..', 'sdk');
  const moduleDirectory = join(sdk, 'node_modules', 'cos-nodejs-sdk-v5');
  await mkdir(moduleDirectory, { recursive: true });
  await writeFile(join(sdk, 'package.json'), '{}');
  await writeFile(join(moduleDirectory, 'index.js'), `
    module.exports = class {
      constructor(options) {
        if (options.Timeout !== 60000 || 'MaxRetryTimes' in options) throw new Error('Unexpected timeout configuration');
        this.objects = new Map();
      }
      fail(operation) {
        if (process.env.FAKE_COS_FAILURE !== operation) return;
        const error = new Error('private-test-secret signed request');
        error.code = process.env.FAKE_COS_CODE;
        error.headers = { Authorization: 'private-test-secret' };
        throw error;
      }
      async getObject({ Key }) {
        this.fail('GET');
        if (!this.objects.has(Key)) throw Object.assign(new Error('not found'), { statusCode: 404 });
        return { Body: this.objects.get(Key) };
      }
      async putObject({ Key, Body }) { this.fail('PUT'); this.objects.set(Key, Body); }
    };
  `);
  for (const [operation, code] of [['', ''], ['GET', 'ESOCKETTIMEDOUT'], ['PUT', 'ECONNRESET'], ['GET', 'private-test-secret']]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./publish-mirror.mjs', import.meta.url)), 'upload', f.output], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, COS_SDK_DIRECTORY: sdk, COS_SECRET_ID: 'private-test-id', COS_SECRET_KEY: 'private-test-secret',
        FAKE_COS_FAILURE: operation, FAKE_COS_CODE: code },
    });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, /private-test-secret|private-test-id|signed request|Authorization/);
    assert.match(output, /Mirror runtime: v\d/);
    assert.match(output, /COS GET computer-use\/latest.json: started/);
    if (operation) {
      assert.equal(result.status, 1);
      assert.match(output, new RegExp(`failed \\(HTTP unknown, ${code === 'private-test-secret' ? 'UNKNOWN' : code}\\)`));
    } else {
      assert.equal(result.status, 0);
      assert.match(output, /COS GET computer-use\/latest.json: not found/);
      assert.match(output, /COS PUT .*: \d+ bytes \([\d.]+s\)/);
      assert.match(output, /upload: v0.7.1 verified\./);
    }
  }
});

async function fixture(t, version = '0.7.1') {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-mirror-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input');
  const output = join(directory, 'output');
  await mkdir(input);
  const commit = 'a'.repeat(40);
  const publishedAt = '2026-10-14T00:00:00.000Z';
  for (const platform of platforms) {
    const prefix = `computer-use-${version}-${platform}`;
    const archive = `${prefix}.zip`;
    const installer = prefix + (platform === 'macos-arm64' ? '.dmg' : '-setup.exe');
    const bytes = Buffer.from(`fixture archive ${platform}`);
    const installBytes = Buffer.from(`fixture installer ${platform}`);
    const metadata = {
      version, platform, commit, sourceDirty: false, archive, bytes: bytes.length, sha256: hash(bytes),
      signing: platform === 'macos-arm64' ? 'developer-id-notarized' : 'unsigned',
      ...(platform === 'macos-arm64' ? { notarization: 'stapled' } : {}),
      installer: { name: installer, bytes: installBytes.length, sha256: hash(installBytes) },
    };
    for (const [name, value] of Object.entries({
      [archive]: bytes, [`${archive}.sha256`]: `${hash(bytes)}  ${archive}\n`,
      [installer]: installBytes, [`${installer}.sha256`]: `${hash(installBytes)}  ${installer}\n`,
      [`${prefix}.json`]: serialized(metadata),
    })) await writeFile(join(input, name), value);
  }
  const sourceReads = [];
  const readSource = path => {
    sourceReads.push(path);
    return Buffer.from(`fixture source at ${commit}: ${path}\n`);
  };
  const options = { input, output, version, commit, publishedAt, readSource };
  return { ...options, sourceReads, prepare: () => prepareMirror(options) };
}

function store(initial = new Map()) {
  const objects = new Map([...initial].map(([key, value]) => [key, Buffer.from(value)]));
  const events = [];
  const hooks = {};
  return {
    objects, events, hooks,
    async get(key) {
      events.push({ type: 'get', key });
      const bytes = objects.get(key);
      if (hooks.get) return hooks.get(key, bytes === undefined ? null : Buffer.from(bytes));
      return bytes === undefined ? null : Buffer.from(bytes);
    },
    async put(key, bytes, cacheControl) {
      events.push({ type: 'put', key, cacheControl });
      await hooks.beforePut?.(key, bytes);
      objects.set(key, Buffer.from(bytes));
    },
  };
}

function previousManifest(manifest, version = '0.7.0') {
  return {
    ...manifest, version, tag: `v${version}`,
    assets: manifest.assets.map(asset => ({ ...asset, name: asset.name.replace(manifest.version, version) })),
  };
}

function verifiers(storage, events = []) {
  return [
    async manifest => { events.push({ type: 'published', tag: manifest.tag }); },
    async (url, asset) => {
      events.push({ type: 'public', name: asset.name });
      assert.equal(url, `${mirrorBase}/releases/v0.7.1/${asset.name}`);
      const bytes = storage.objects.get(`computer-use/releases/v0.7.1/${asset.name}`);
      assert.ok(bytes);
      assert.equal(bytes.length, asset.bytes);
      assert.equal(hash(bytes), asset.sha256);
    },
  ];
}

async function staged(t) {
  const f = await fixture(t);
  const manifest = await f.prepare();
  const previous = serialized(previousManifest(manifest));
  const storage = store(new Map([[latestKey, previous]]));
  await uploadMirror(f.output, storage);
  return { ...f, manifest, previous, storage };
}

test('prepare mirrors exactly 15 verified release assets plus the three source-commit documents', async t => {
  const f = await fixture(t);
  const manifest = await f.prepare();
  assert.equal(manifest.assets.length, 18);
  assert.equal(manifest.commit, f.commit);
  assert.deepEqual(f.sourceReads, ['skills/computer-use/SKILL.md', 'LICENSE', '.github/release-notes/v0.7.1.md']);
  assert.deepEqual((await readdir(f.output)).sort(), [...releaseNames(f.version), 'SKILL.md', 'LICENSE.md', 'release-notes.md', 'manifest.json'].sort());
  for (const asset of manifest.assets) {
    const bytes = await readFile(join(f.output, asset.name));
    assert.equal(bytes.length, asset.bytes);
    assert.equal(hash(bytes), asset.sha256);
  }
  assert.deepEqual(await f.prepare(), manifest);
  await writeFile(join(f.output, 'SKILL.md'), 'different document');
  await assert.rejects(f.prepare(), /Refusing to replace SKILL.md/);
});

for (const [name, mutate] of [
  ['wrong commit', m => { m.commit = 'b'.repeat(40); }],
  ['wrong platform', m => { m.platform = 'windows-x64'; }],
  ['dirty source', m => { m.sourceDirty = true; }],
  ['wrong version', m => { m.version = '0.7.2'; }],
  ['unnotarized macOS', m => { m.notarization = 'pending'; }],
  ['archive size mismatch', m => { m.bytes += 1; }],
  ['archive checksum mismatch', m => { m.sha256 = 'b'.repeat(64); }],
  ['installer size mismatch', m => { m.installer.bytes += 1; }],
  ['installer checksum mismatch', m => { m.installer.sha256 = 'c'.repeat(64); }],
]) {
  test(`preparation rejects ${name} before writing the mirror directory`, async t => {
    const f = await fixture(t);
    const path = join(f.input, 'computer-use-0.7.1-macos-arm64.json');
    const metadata = JSON.parse(await readFile(path));
    mutate(metadata);
    await writeFile(path, serialized(metadata));
    await assert.rejects(f.prepare(), /metadata\/source mismatch|checksum mismatch/);
    await assert.rejects(readdir(f.output), /ENOENT/);
  });
}

test('preparation rejects additional files and inconsistent checksum sidecars', async t => {
  const f = await fixture(t);
  const extra = join(f.input, 'unreviewed.exe');
  await writeFile(extra, 'unexpected');
  await assert.rejects(f.prepare(), /exactly the 15 verified release files/);
  await rm(extra);
  await writeFile(join(f.input, 'computer-use-0.7.1-windows-x64.zip.sha256'), 'invalid checksum');
  await assert.rejects(f.prepare(), /checksum mismatch/);
});

test('manifest validation rejects missing, duplicate, unsafe and oversized assets', async t => {
  const f = await fixture(t);
  const manifest = await f.prepare();
  for (const mutate of [
    m => { m.version = '0.7.1-rc.1'; }, m => { m.commit = 'x'; }, m => { m.publishedAt = 'not a date'; },
    m => { m.assets.pop(); }, m => { m.assets[0].name = m.assets[1].name; },
    m => { m.assets[0].name = '../payload'; }, m => { m.assets[0].name = 'C:\\payload'; },
    m => { m.assets[0].bytes = true; }, m => { m.assets[0].bytes = 2147483649; }, m => { m.assets[0].sha256 = 'x'; },
  ]) {
    const value = structuredClone(manifest);
    mutate(value);
    assert.throws(() => validateManifest(value), /Invalid|Missing/);
  }
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.7.1', '0.7.1'), 0);
});

test('upload validates every file, reads back each immutable write and is idempotent', async t => {
  const f = await fixture(t);
  const manifest = await f.prepare();
  const storage = store();
  assert.deepEqual(await uploadMirror(f.output, storage), manifest);
  const writes = storage.events.filter(event => event.type === 'put');
  assert.equal(writes.length, 19);
  assert.ok(writes.every(event => event.cacheControl === 'public, max-age=31536000, immutable'));
  for (const write of writes) {
    const position = storage.events.indexOf(write);
    assert.equal(storage.events[position + 1].type, 'get');
    assert.equal(storage.events[position + 1].key, write.key);
  }
  assert.ok(!storage.objects.has(latestKey));
  assert.deepEqual(await uploadMirror(f.output, storage), manifest);
  assert.equal(storage.events.filter(event => event.type === 'put').length, 19);
});

test('immutable conflicts and changed local files fail before any upload or latest write', async t => {
  const f = await fixture(t);
  const manifest = await f.prepare();
  const last = manifest.assets.at(-1).name;
  const storage = store(new Map([[`computer-use/releases/v0.7.1/${last}`, Buffer.from('different immutable content')]]));
  await assert.rejects(uploadMirror(f.output, storage), /immutable release file/);
  assert.equal(storage.events.filter(event => event.type === 'put').length, 0);
  storage.objects.clear();
  await writeFile(join(f.output, last), 'locally changed');
  await assert.rejects(uploadMirror(f.output, storage), /Local file changed/);
  assert.equal(storage.events.filter(event => event.type === 'put').length, 0);
});

for (const failure of ['write', 'readback']) {
  test(`an asset ${failure} failure preserves latest and retries without rewriting verified objects`, async t => {
    const f = await fixture(t);
    const manifest = await f.prepare();
    const previous = serialized(previousManifest(manifest));
    const storage = store(new Map([[latestKey, previous]]));
    const key = `computer-use/releases/v0.7.1/${manifest.assets[5].name}`;
    if (failure === 'write') storage.hooks.beforePut = target => { if (target === key) throw new Error('fixture write failed'); };
    else storage.hooks.get = (target, bytes) => target === key && bytes ? Buffer.from('bad readback') : bytes;
    await assert.rejects(uploadMirror(f.output, storage), /write failed|Mirror readback failed/);
    assert.deepEqual(storage.objects.get(latestKey), previous);
    delete storage.hooks.beforePut;
    delete storage.hooks.get;
    const verifiedKey = `computer-use/releases/v0.7.1/${manifest.assets[0].name}`;
    assert.equal(storage.events.filter(event => event.type === 'put' && event.key === verifiedKey).length, 1);
    await uploadMirror(f.output, storage);
    assert.equal(storage.events.filter(event => event.type === 'put' && event.key === verifiedKey).length, 1);
    assert.deepEqual(storage.objects.get(latestKey), previous);
  });
}

test('promotion verifies the published release and all 18 anonymous assets before updating latest', async t => {
  const f = await staged(t);
  const checks = [];
  const before = f.storage.events.filter(event => event.type === 'put').length;
  f.storage.hooks.beforePut = key => {
    assert.equal(key, latestKey);
    assert.equal(checks[0].type, 'published');
    assert.equal(checks.filter(check => check.type === 'public').length, 18);
  };
  await promoteMirror(f.output, f.storage, ...verifiers(f.storage, checks));
  assert.deepEqual(f.storage.objects.get(latestKey), await readFile(join(f.output, 'manifest.json')));
  assert.equal(f.storage.events.filter(event => event.type === 'put').length, before + 1);
  assert.equal(f.storage.events.filter(event => event.type === 'put').at(-1).cacheControl, 'no-cache, max-age=0, must-revalidate');
  await promoteMirror(f.output, f.storage, ...verifiers(f.storage));
  assert.equal(f.storage.events.filter(event => event.type === 'put').length, before + 1);
});

test('failed GitHub verification, staged manifest or the last public asset keeps the previous index', async t => {
  for (const failure of ['github', 'manifest', 'public']) {
    const f = await staged(t);
    const checks = [];
    const [published, publicAsset] = verifiers(f.storage, checks);
    if (failure === 'manifest') f.storage.objects.set('computer-use/releases/v0.7.1/manifest.json', Buffer.from('wrong manifest'));
    await assert.rejects(promoteMirror(f.output, f.storage,
      async manifest => { if (failure === 'github') throw new Error('not published'); await published(manifest); },
      async (url, asset) => {
        await publicAsset(url, asset);
        if (failure === 'public' && checks.filter(check => check.type === 'public').length === 18) throw new Error('public checksum failure');
      }), /not published|manifest does not match|public checksum failure/);
    assert.deepEqual(f.storage.objects.get(latestKey), f.previous);
    assert.equal(f.storage.events.filter(event => event.type === 'put' && event.key === latestKey).length, 0);
  }
});

test('promotion cannot downgrade an index or replace a different manifest of the same version', async t => {
  const f = await staged(t);
  for (const previous of [previousManifest(f.manifest, '0.8.0'), { ...f.manifest, publishedAt: '2026-10-13T00:00:00.000Z' }]) {
    const bytes = serialized(previous);
    f.storage.objects.set(latestKey, bytes);
    await assert.rejects(promoteMirror(f.output, f.storage, ...verifiers(f.storage)), /downgrade|different manifest/);
    assert.deepEqual(f.storage.objects.get(latestKey), bytes);
  }
});

test('index write failure is reported while a pre-write failure preserves the previous index', async t => {
  const f = await staged(t);
  f.storage.hooks.beforePut = key => { if (key === latestKey) throw new Error('index write failed'); };
  await assert.rejects(promoteMirror(f.output, f.storage, ...verifiers(f.storage)), /index write failed/);
  assert.deepEqual(f.storage.objects.get(latestKey), f.previous);
});

test('index readback failure is reported as an uncertain promotion and a retry verifies without downgrading', async t => {
  const f = await staged(t);
  const desired = await readFile(join(f.output, 'manifest.json'));
  f.storage.hooks.get = (key, bytes) => key === latestKey && bytes?.equals(desired) ? Buffer.from('unreadable response') : bytes;
  await assert.rejects(promoteMirror(f.output, f.storage, ...verifiers(f.storage)), /index readback failed/);
  // A successful atomic PUT cannot be rolled back safely just because the following GET failed.
  assert.deepEqual(f.storage.objects.get(latestKey), desired);
  delete f.storage.hooks.get;
  const writes = f.storage.events.filter(event => event.type === 'put' && event.key === latestKey).length;
  await promoteMirror(f.output, f.storage, ...verifiers(f.storage));
  assert.equal(f.storage.events.filter(event => event.type === 'put' && event.key === latestKey).length, writes);
});

test('anonymous verification checks exact response bytes and SHA-256 and forbids redirects', async t => {
  const bytes = Buffer.from('verified installer');
  const asset = { name: 'fixture.zip', bytes: bytes.length, sha256: hash(bytes) };
  const url = `${mirrorBase}/releases/v0.7.1/fixture.zip`;
  for (const body of [bytes, Buffer.from('corrupted installer'), bytes.subarray(1), Buffer.concat([bytes, bytes])]) {
    const mock = t.mock.method(globalThis, 'fetch', async (target, options) => {
      assert.equal(target, url);
      assert.equal(options.redirect, 'error');
      return new Response(body);
    });
    if (body === bytes) await verifyPublicAsset(url, asset);
    else await assert.rejects(verifyPublicAsset(url, asset), /Oversized|checksum mismatch/);
    mock.mock.restore();
  }
  await assert.rejects(verifyPublicAsset('https://other.example/file', asset), /Unexpected public mirror path/);
});

function githubRelease(manifest, overrides = {}) {
  return {
    tag_name: manifest.tag, draft: false, prerelease: false, created_at: manifest.publishedAt,
    published_at: '2026-10-14T01:00:00.000Z',
    assets: manifest.assets.filter(asset => asset.name.startsWith('computer-use-')).map(asset => ({
      name: asset.name, size: asset.bytes, digest: `sha256:${asset.sha256}`, state: 'uploaded',
    })),
    ...overrides,
  };
}

test('an old-version upload or changed same-version index is rejected before any immutable object is written', async t => {
  const f = await fixture(t);
  const manifest = await f.prepare();
  for (const previous of [previousManifest(manifest, '0.8.0'), { ...manifest, commit: 'd'.repeat(40) }]) {
    const bytes = serialized(previous);
    const storage = store(new Map([[latestKey, bytes]]));
    await assert.rejects(uploadMirror(f.output, storage), /downgrade|different manifest/);
    assert.equal(storage.events.filter(event => event.type === 'put').length, 0);
    assert.deepEqual(storage.objects.get(latestKey), bytes);
  }
});

test('GitHub preflight rejects old stable versions while newer drafts or prereleases do not block a stable release', async t => {
  const f = await fixture(t);
  const manifest = await f.prepare();
  const release = githubRelease(manifest);
  const newer = githubRelease(previousManifest(manifest, '0.10.0'));
  assert.throws(() => inspectRelease(manifest.tag, [release, newer]), /newer stable/);
  assert.equal(inspectRelease(manifest.tag, [release, { ...newer, draft: true }]), release);
  assert.equal(inspectRelease(manifest.tag, [release, { ...newer, prerelease: true }]), release);
  assert.throws(() => inspectRelease(manifest.tag, [release, release]), /Multiple releases/);
  assert.throws(() => inspectRelease(manifest.tag, [{ ...release, prerelease: true }]), /prerelease/);
});

test('published GitHub retries never call release edit, and draft publication rechecks the latest version', async t => {
  const f = await fixture(t);
  const manifest = await f.prepare();
  const release = githubRelease(manifest);
  const commands = [];
  const execute = (...args) => commands.push(args);
  t.mock.method(console, 'log', () => {});
  await runReleaseCommand(['publish', manifest.tag], { list: () => [release], execute });
  assert.equal(commands.length, 0);
  await assert.rejects(runReleaseCommand(['publish', manifest.tag], {
    list: () => [{ ...release, draft: true }, githubRelease(previousManifest(manifest, '0.8.0'))], execute,
  }), /newer stable/);
  assert.equal(commands.length, 0);
  await runReleaseCommand(['publish', manifest.tag], { list: () => [{ ...release, draft: true }], execute });
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].slice(0, 2), ['gh', ['release', 'edit', manifest.tag, '--repo', 'starroyhq/computer-use', '--draft=false', '--prerelease=false', '--latest']]);
});

test('partial drafts recover only missing assets after matching every existing byte and never allow published recovery', async t => {
  const f = await fixture(t);
  const manifest = await f.prepare();
  const release = githubRelease(manifest, { draft: true });
  const missing = release.assets.slice(-2).map(asset => asset.name).sort();
  const partial = { ...release, assets: release.assets.slice(0, -2) };
  assert.deepEqual(await verifyReleaseAssets(f.input, manifest.tag, partial, { allowPartial: true }), missing);
  await assert.rejects(verifyReleaseAssets(f.input, manifest.tag, partial), /recovery_run_id/);
  assert.deepEqual(await verifyReleaseAssets(f.input, manifest.tag, { ...release, assets: [] }, { allowPartial: true }), releaseNames(f.version).sort());
  await assert.rejects(verifyReleaseAssets(f.input, manifest.tag, { ...partial, draft: false }, { allowPartial: true }), /only allowed for a draft/);
  const conflicting = structuredClone(partial);
  conflicting.assets[0].digest = `sha256:${'e'.repeat(64)}`;
  await assert.rejects(verifyReleaseAssets(f.input, manifest.tag, conflicting, { allowPartial: true }), /never overwrite/);
  conflicting.assets[0].state = 'starter';
  await assert.rejects(verifyReleaseAssets(f.input, manifest.tag, conflicting, { allowPartial: true }), /unfinished starter asset/);
  await assert.rejects(verifyReleaseAssets(f.input, manifest.tag, { ...release, assets: [...release.assets, release.assets[0]] }), /asset list differs/);
});

test('promotion requires the immutable GitHub created_at timestamp, exact commit and all 15 official asset hashes', async t => {
  const f = await fixture(t);
  const manifest = await f.prepare();
  const release = githubRelease(manifest);
  const options = { list: () => [release], resolveCommit: () => manifest.commit };
  await verifyGitHubRelease(manifest, options);
  await assert.rejects(verifyGitHubRelease({ ...manifest, publishedAt: release.published_at }, options), /creation time/);
  await assert.rejects(verifyGitHubRelease(manifest, { ...options, resolveCommit: () => 'f'.repeat(40) }), /source mismatch/);
  for (const changed of [
    { ...release, draft: true }, { ...release, prerelease: true }, { ...release, assets: release.assets.slice(1) },
    { ...release, assets: release.assets.map((asset, i) => i === 0 ? { ...asset, digest: 'sha256:wrong' } : asset) },
  ]) await assert.rejects(verifyGitHubRelease(manifest, { ...options, list: () => [changed] }), /published stable|prerelease|asset mismatch/);
});
