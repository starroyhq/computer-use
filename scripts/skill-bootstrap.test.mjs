import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { checkSkill, renderSkill, skillDirectory } from './build-skill.mjs';

const document = await checkSkill();
function extract(platform, language) {
  const marker = `<!-- computer-use-bootstrap:${platform} -->\n\x60\x60\x60${language}\n`;
  assert.equal(document.split(marker).length, 2);
  return document.split(marker)[1].split('\n```')[0] + '\n';
}
const shell = extract('macos', 'bash');
const powershell = extract('windows', 'powershell');
const mac = process.platform === 'darwin';

function execute(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', value => {
      stdout += value;
    });
    child.stderr.on('data', value => {
      stderr += value;
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function fakeApp(path, version = '0.6.1') {
  const resources = join(path, 'Contents', 'Resources');
  for (const file of [
    'Contents/MacOS/ComputerUseHost',
    'Contents/Resources/bin/node',
    'Contents/Resources/bin/computer-use',
    'Contents/Resources/bin/cua-driver',
    'Contents/Resources/runtime/host.js',
    'Contents/Resources/runtime/cli.js',
    'Contents/Resources/skills/computer-use/SKILL.md',
  ]) {
    await mkdir(dirname(join(path, file)), { recursive: true });
    await writeFile(join(path, file), 'fixture only\n', { mode: 0o755 });
  }
  await mkdir(join(resources, 'node_modules'));
  await writeFile(join(resources, 'build-receipt.json'), JSON.stringify({ owner: 'computer-use-package-v1', arch: 'arm64' }));
  await writeFile(join(resources, 'package.json'), JSON.stringify({ version }));
  await writeFile(
    join(path, 'Contents', 'Info.plist'),
    JSON.stringify({ CFBundleIdentifier: 'com.starroy.computeruse', CFBundleShortVersionString: version }),
  );
}

async function fixture(t, changes = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'computer-use-skill-fixture-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const applications = join(directory, 'Applications');
  const home = join(directory, 'home');
  const mocks = join(directory, 'mocks');
  await Promise.all([mkdir(applications), mkdir(home), mkdir(mocks)]);
  const version = '99.0.1';
  const name = `computer-use-${version}-macos-arm64.dmg`;
  const installer = Buffer.from('fixture installer, never mounted by real hdiutil');
  const digest = createHash('sha256').update(installer).digest('hex');
  const metadata = {
    version,
    platform: 'macos-arm64',
    commit: 'a'.repeat(40),
    sourceDirty: false,
    archive: `computer-use-${version}-macos-arm64.zip`,
    bytes: 1,
    sha256: 'b'.repeat(64),
    signing: 'developer-id-notarized',
    notarization: 'stapled',
    installer: { name, bytes: installer.length, sha256: digest },
    ...changes.metadata,
  };
  const base = `https://github.com/starroyhq/computer-use/releases/download/v${version}`;
  const config = {
    version,
    name,
    base,
    metadata,
    digest,
    installer: installer.toString(),
    app: join(directory, 'source.app'),
    log: join(directory, 'requests.jsonl'),
    ...changes,
  };
  config.metadata = metadata;
  await fakeApp(config.app, changes.appVersion ?? version);
  await writeFile(join(directory, 'config.json'), JSON.stringify(config));
  const code = `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, cpSync } from 'node:fs';
import { basename, join } from 'node:path';
const c = JSON.parse(readFileSync(${JSON.stringify(join(directory, 'config.json'))}, 'utf8'));
const args = process.argv.slice(2), operation = basename(process.argv[1]);
const value = key => args[args.indexOf(key) + 1];
if (operation === 'uname') process.stdout.write('Darwin\\n');
else if (operation === 'sysctl') process.stdout.write(c.unsupported ? '0\\n' : '1\\n');
else if (operation === 'sleep') await new Promise(resolve => setTimeout(resolve, 10));
else if (operation === 'curl') {
  const url = args.at(-1); appendFileSync(c.log, JSON.stringify({ operation, url }) + '\\n');
  let status = 200, body = '', location = '';
  if (url.endsWith('/releases/latest')) { status = 302; location = c.latest ?? 'https://github.com/starroyhq/computer-use/releases/tag/v' + c.version; }
  else if (url.endsWith('.json')) body = JSON.stringify(c.metadata);
  else if (url.endsWith('.sha256')) body = c.digest + '  ' + c.name + '\\n';
  else if (url === c.base + '/' + c.name) {
    if (c.redirect) { status = 302; location = c.redirect; }
    else body = c.truncated ? c.installer.slice(2) : c.corrupt ? 'X'.repeat(c.installer.length) : c.installer;
  } else if (url === 'https://release-assets.githubusercontent.com/fixture') body = c.installer;
  else { status = 404; }
  writeFileSync(value('--dump-header'), 'HTTP/2 ' + status + '\\r\\n' + (location ? 'Location: ' + location + '\\r\\n' : '') + '\\r\\n');
  writeFileSync(value('--output'), body); process.stdout.write(String(status));
} else if (operation === 'hdiutil') {
  if (args[0] === 'attach') cpSync(c.app, join(value('-mountpoint'), 'Computer Use.app'), { recursive: true });
} else if (operation === 'codesign' || operation === 'spctl') {
  appendFileSync(c.log, JSON.stringify({ operation }) + '\\n');
  if (c.failCheck === operation) process.exit(1);
} else throw new Error('Unknown mock');
`;
  for (const name of ['uname', 'sysctl', 'curl', 'hdiutil', 'codesign', 'spctl', 'sleep']) {
    await writeFile(join(mocks, name), code, { mode: 0o755 });
  }
  // Replacements exist only in this isolated test copy, never as bootstrap options/environment hooks.
  let script = shell
    .replaceAll("'/Applications'", JSON.stringify(applications))
    .replaceAll("'/Applications/Computer Use.app'", JSON.stringify(join(applications, 'Computer Use.app')));
  for (const name of ['uname', 'sysctl', 'curl', 'hdiutil', 'codesign', 'spctl']) {
    script = script.replaceAll(`/usr/${['sysctl', 'spctl'].includes(name) ? 'sbin' : 'bin'}/${name}`, JSON.stringify(join(mocks, name)));
  }
  if (changes.fastLock) script = script.replace('/bin/sleep 1', `${JSON.stringify(join(mocks, 'sleep'))} 1`);
  const scriptPath = join(directory, 'copied-skill.sh');
  await writeFile(scriptPath, script);
  const run = (...args) => execute('/bin/bash', [scriptPath, ...args], { ...process.env, HOME: home });
  const logs = async () =>
    (await readFile(config.log, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  return { directory, applications, home, run, logs, app: config.app };
}

test('generated standalone Skill includes the exact maintained scripts and current guide', async () => {
  assert.equal(shell, await readFile(join(skillDirectory, 'bootstrap-macos.sh'), 'utf8'));
  assert.equal(powershell, await readFile(join(skillDirectory, 'bootstrap-windows.ps1'), 'utf8'));
  assert.ok(document.includes((await readFile(join(skillDirectory, 'instructions.md'), 'utf8')).trimEnd()));
  assert.equal(document, await renderSkill());
});

test('generation check rejects missing inputs and an out-of-date copied Skill', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-skill-generation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(skillDirectory, directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), 'stale');
  await assert.rejects(checkSkill(directory), /out of date/);
  await rm(join(directory, 'bootstrap-windows.ps1'));
  await assert.rejects(renderSkill(directory), /ENOENT/);
});

test('macOS script extracted from copied Markdown parses', { skip: !mac }, async () => {
  const result = await execute('/bin/bash', ['-n', join(skillDirectory, 'bootstrap-macos.sh')]);
  assert.equal(result.code, 0, result.stderr);
});

test('existing v0.6.1 and a quoted Unicode path are found without executing or downloading', { skip: !mac }, async t => {
  const f = await fixture(t);
  const app = join(f.directory, "移动 '$HOME' `never-run` 应用.app");
  await fakeApp(app);
  const result = await f.run(join(app, 'Contents/Resources/bin/computer-use'));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    platform: 'macos-arm64',
    app,
    cli: join(app, 'Contents/Resources/bin/computer-use'),
    installed: false,
  });
  assert.deepEqual(await f.logs(), []);
});

test('App-exported bundle, runtime CLI and embedded Node hints discover the same package', { skip: !mac }, async t => {
  const f = await fixture(t);
  const app = join(f.applications, 'Computer Use.app');
  await fakeApp(app);
  for (const hint of [app, join(app, 'Contents/Resources/runtime/cli.js'), join(app, 'Contents/Resources/bin/node')]) {
    const result = await f.run(hint);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).app, app);
  }
  const stale = await f.run(join(f.directory, 'old.app', 'Contents/Resources/runtime/cli.js'));
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /hinted App is missing/);
  const rediscovered = await f.run();
  assert.equal(rediscovered.code, 0, rediscovered.stderr);
  assert.equal(JSON.parse(rediscovered.stdout).app, app);
  assert.deepEqual(await f.logs(), []);
});

test('isolated clean install verifies download then returns same package on repeated bootstrap', { skip: !mac }, async t => {
  const f = await fixture(t, { redirect: 'https://release-assets.githubusercontent.com/fixture' });
  const first = await f.run();
  assert.equal(first.code, 0, first.stderr);
  const output = JSON.parse(first.stdout);
  assert.equal(output.installed, true);
  assert.equal(output.app, join(f.applications, 'Computer Use.app'));
  assert.ok((await stat(output.cli)).isFile());
  const requests = await f.logs();
  assert.ok(requests.some(row => row.operation === 'codesign'));
  assert.ok(requests.some(row => row.operation === 'spctl'));
  const second = await f.run();
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).installed, false);
  assert.deepEqual(await f.logs(), requests);
});

test('multiple packages require an explicit choice and incomplete packages are preserved', { skip: !mac }, async t => {
  const f = await fixture(t);
  await fakeApp(join(f.applications, 'Computer Use.app'));
  await fakeApp(join(f.home, 'Applications', 'Computer Use.app'));
  const multiple = await f.run();
  assert.equal(multiple.code, 1);
  assert.match(multiple.stderr, /Multiple installations/);
  await rm(join(f.home, 'Applications'), { recursive: true });
  await rm(join(f.applications, 'Computer Use.app', 'Contents/Resources/bin/node'));
  const incomplete = await f.run();
  assert.equal(incomplete.code, 1);
  assert.match(incomplete.stderr, /incomplete or unknown/);
  assert.deepEqual(await f.logs(), []);
});

for (const [name, changes, error] of [
  ['wrong architecture', { unsupported: true }, /Apple Silicon/],
  ['prerelease', { latest: 'https://github.com/starroyhq/computer-use/releases/tag/v1.2.3-beta' }, /stable version/],
  ['untrusted redirect', { redirect: 'https://attacker.example/payload' }, /untrusted address/],
  ['userinfo redirect', { redirect: 'https://github.com@attacker.example/payload' }, /untrusted address/],
  ['metadata mismatch', { metadata: { platform: 'windows-arm64' } }, /Invalid release metadata/],
  ['dirty release', { metadata: { sourceDirty: true } }, /Invalid release metadata/],
  ['truncated download', { truncated: true }, /incomplete/],
  ['hash mismatch', { corrupt: true }, /SHA-256/],
  ['wrong publisher', { failCheck: 'codesign' }, /signature or publisher/],
  ['notarization rejection', { failCheck: 'spctl' }, /notarization/],
  ['version mismatch', { appVersion: '0.0.1' }, /version does not match/],
]) {
  test(`bootstrap rejects ${name} before installation`, { skip: !mac }, async t => {
    const f = await fixture(t, changes);
    const result = await f.run();
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, error);
    await assert.rejects(stat(join(f.applications, 'Computer Use.app')), /ENOENT/);
    if (changes.redirect?.includes('attacker')) assert.ok(!(await f.logs()).some(row => row.url?.includes('attacker')));
  });
}

test('installation lock prevents concurrent download and allows reuse after the first installer exits', { skip: !mac }, async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.run(), f.run()]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(results.map(result => JSON.parse(result.stdout).installed).sort(), [false, true]);
  assert.equal((await f.logs()).filter(row => row.url?.endsWith('/releases/latest')).length, 1);
});

test('stale/held lock stops with a bounded error without deleting another lock', { skip: !mac }, async t => {
  const f = await fixture(t, { fastLock: true });
  const lock = join(f.home, '.computer-use-bootstrap.lock');
  await mkdir(lock, { mode: 0o700 });
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Another installation holds the lock/);
  assert.ok((await stat(lock)).isDirectory());
  assert.deepEqual(await f.logs(), []);
});
