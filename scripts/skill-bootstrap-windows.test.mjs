import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { checkSkill } from './build-skill.mjs';

const markdown = await checkSkill();
const marker = '<!-- computer-use-bootstrap:windows -->\n```powershell\n';
const script = markdown.split(marker)[1].split('\n```')[0];
const entry = '\ntry {\n    if ([Environment]::OSVersion.Platform';
assert.equal(script.split(entry).length, 2);
const windows = process.platform === 'win32';
const quote = value => `'${value.replaceAll("'", "''")}'`;

function powershell(code, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(
          '[Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8; & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))',
          'utf16le',
        ).toString('base64'),
      ],
      {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    child.stdin.end(code);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', value => {
      stdout += value;
    });
    child.stderr.on('data', value => {
      stderr += value;
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: stdout.replace(/^\uFEFF/, ''), stderr }));
  });
}

async function fakePackage(path, arch, version) {
  for (const file of [
    'ComputerUse.WindowsHost.exe',
    'bin/node.exe',
    'bin/cua-driver.exe',
    'runtime/cli.js',
    'runtime/host.js',
    'skills/computer-use/SKILL.md',
  ]) {
    await mkdir(dirname(join(path, file)), { recursive: true });
    await writeFile(join(path, file), 'test fixture; never execute');
  }
  await mkdir(join(path, 'node_modules'));
  await writeFile(join(path, 'package.json'), JSON.stringify({ version }));
  await writeFile(
    join(path, 'build-receipt.json'),
    JSON.stringify({ owner: `computer-use-windows-${arch}-package-v1`, arch: `win-${arch}` }),
  );
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archResult = await powershell(script.split(entry)[0] + '\nGet-NativeArchitecture');
  assert.equal(archResult.code, 0, archResult.stderr);
  const arch = archResult.stdout.trim();
  assert.ok(['arm64', 'x64'].includes(arch));
  const version = '99.0.1';
  const platform = `windows-${arch}`;
  const prefix = `computer-use-${version}-${platform}`;
  const name = `${prefix}-setup.exe`;
  const installer = Buffer.from('fixture installer that must never execute');
  const digest = createHash('sha256').update(installer).digest('hex');
  const metadata = {
    version,
    platform,
    commit: 'a'.repeat(40),
    sourceDirty: false,
    archive: `${prefix}.zip`,
    bytes: 1,
    sha256: 'b'.repeat(64),
    signing: 'unsigned',
    installer: { name, bytes: installer.length, sha256: digest },
    ...options.metadata,
  };
  const mirrorMetadata = { ...metadata, ...options.mirrorMetadata };
  const files = {
    [`${prefix}.json`]: JSON.stringify(mirrorMetadata),
    [`${name}.sha256`]: `${digest}  ${name}\n`,
    [name]: installer,
  };
  const manifest = {
    schemaVersion: 1,
    repository: 'starroyhq/computer-use',
    version,
    tag: `v${version}`,
    commit: metadata.commit,
    publishedAt: '2026-10-14T00:00:00.000Z',
    assets: Object.entries(files).map(([name, bytes]) => ({
      name,
      bytes: Buffer.byteLength(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
    ...options.manifest,
  };
  if (options.missingMirrorAsset) manifest.assets = manifest.assets.filter(asset => !asset.name.endsWith('.exe'));
  const home = join(directory, "Local AppData '$HOME' 电脑");
  await mkdir(home);
  const packagePath = join(home, 'Programs', 'Computer Use');
  const source = join(directory, 'source-package');
  await fakePackage(source, arch, options.installedVersion ?? version);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const mirror = path.startsWith('/computer-use/');
    if (!mirror && options.githubFailure && path.endsWith(options.githubFailure)) {
      if (options.interrupt) {
        response.writeHead(200, { 'Content-Length': installer.length });
        response.write(installer.subarray(0, 10));
        setTimeout(() => response.destroy(), 25);
      } else {
        response.writeHead(options.githubStatus ?? 503, options.rateLimited ? { 'X-RateLimit-Remaining': '0' } : {});
        response.end();
      }
    } else if (mirror && options.mirrorStatus) {
      response.writeHead(options.mirrorStatus);
      response.end();
    } else if (path.endsWith('/releases/latest')) {
      response.writeHead(302, { Location: options.latest ?? `https://github.com/starroyhq/computer-use/releases/tag/v${version}` });
      response.end();
    } else if (mirror && (path.endsWith('/latest.json') || path.endsWith('/manifest.json'))) response.end(JSON.stringify(manifest));
    else if (path.endsWith('.json')) response.end(JSON.stringify(mirror ? mirrorMetadata : metadata));
    else if (path.endsWith('.sha256')) response.end(`${digest}  ${name}\n`);
    else if (path.endsWith(name)) {
      if (options.redirect && !mirror) {
        response.writeHead(302, { Location: options.redirect });
        response.end();
      } else
        response.end(
          options.corrupt || (mirror && options.mirrorCorrupt)
            ? Buffer.alloc(installer.length, 88)
            : options.truncated
              ? installer.subarray(2)
              : installer,
        );
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const overrides = `
$env:LOCALAPPDATA = ${quote(home)}
function Open-Response([Uri]$Uri, [int]$TimeoutMilliseconds) {
    $acl = Get-Acl -LiteralPath $work
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid -or
        $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid -or $rules[0].IsInherited -or
        $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl' -or
        $rules[0].InheritanceFlags -ne 'ContainerInherit, ObjectInherit') { throw 'Bootstrap temporary directory ACL is not private' }
    Assert-TrustedUri $Uri
    $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:${port}' + $Uri.PathAndQuery)
    $request.AllowAutoRedirect = $false
    $request.Timeout = $TimeoutMilliseconds
    $request.ReadWriteTimeout = $TimeoutMilliseconds
    try { return $request.GetResponse() }
    catch [Net.WebException] { if ($_.Exception.Response) { return $_.Exception.Response }; throw }
}
function Start-Process {
    param($FilePath, $ArgumentList, [switch]$PassThru)
    if ($ArgumentList.Count -ne 4 -or $ArgumentList[0] -ne '/VERYSILENT') { throw 'Unexpected installer arguments' }
    New-Item -ItemType Directory -Path ${quote(dirname(packagePath))} -Force | Out-Null
    Copy-Item -LiteralPath ${quote(source)} -Destination ${quote(packagePath)} -Recurse
    $process = [pscustomobject]@{ ExitCode = 0; Handle = 1 }
    $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($Timeout) return $true }
    return $process
}
`;
  // Only this test copy substitutes network/process dependencies; production has no fixture/source override.
  const registry = '{6C2B9F4E-4B7A-4E0F-9C59-3B1D2F8A7E41}_is1';
  const copy = script.replace(registry, `computer-use-fixture-${Date.now()}-${Math.random()}_is1`).replace(entry, overrides + entry);
  return {
    arch,
    directory,
    packagePath,
    credentialPath: join(home, 'Computer Use', 'credentials', 'default.json'),
    requests,
    run: env => powershell(copy, env),
    discover: hint => powershell(`& {\n${copy}\n} -DiscoverOnly${hint === undefined ? '' : ` -Hint ${quote(hint)}`}`),
    source,
    copy,
  };
}

test('PowerShell parser accepts the exact script copied in Markdown', { skip: !windows }, async () => {
  const result = await powershell(`$errors = $null; $tokens = $null
[void][System.Management.Automation.Language.Parser]::ParseInput(${quote(script)}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
'parsed'`);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'parsed');
});

for (const exitCode of [0, 23]) {
  test(`Windows observes exit code ${exitCode} from a real installer process`, { skip: !windows }, async () => {
    const start = script.indexOf('    $process = Start-Process -FilePath $installer');
    const end = script.indexOf("    $package = Get-Installations '' $architecture", start);
    assert.ok(start > 0 && end > start);
    // Exercise the exact process/wait handling, substituting only harmless cmd.exe arguments; no process API is mocked.
    const processBlock = script.slice(start, end).replace(/-ArgumentList @\([^\n]+\)/, '-ArgumentList $testArguments');
    const result = await powershell(`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$installer = Join-Path $env:SystemRoot 'System32\\cmd.exe'
$testArguments = @('/D', '/C', 'exit ${exitCode}')
try {
${processBlock}
    'installer completed'
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($process) { $process.Dispose() }
}`);
    if (exitCode === 0) {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'installer completed');
    } else {
      assert.equal(result.code, 1, result.stdout);
      assert.match(result.stderr, /Installer returned exit code 23\./);
    }
  });
}

test('Windows discovery-only returns a missing result without downloading or installing', { skip: !windows }, async t => {
  const f = await fixture(t);
  const result = await f.discover();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { platform: `windows-${f.arch}`, found: false });
  await assert.rejects(readFile(join(f.packagePath, 'package.json')), /ENOENT/);
  assert.equal(f.requests.length, 0);
});

test('Windows discovery-only returns the unchanged result for standard and explicit installations', { skip: !windows }, async t => {
  const f = await fixture(t);
  await fakePackage(f.packagePath, f.arch, '0.6.1');
  const normal = await f.run();
  assert.equal(normal.code, 0, normal.stderr);
  for (const hint of [undefined, join(f.packagePath, 'runtime', 'cli.js')]) {
    const result = await f.discover(hint);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), JSON.parse(normal.stdout));
  }
  assert.equal(f.requests.length, 0);
});

test('Windows discovery-only rejects stale and different-architecture hints', { skip: !windows }, async t => {
  const f = await fixture(t);
  const missing = await f.discover(join(f.directory, 'missing', 'runtime', 'cli.js'));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /hinted package is missing, incomplete or for another architecture/);
  const wrongArch = f.arch === 'arm64' ? 'x64' : 'arm64';
  await writeFile(
    join(f.source, 'build-receipt.json'),
    JSON.stringify({ owner: `computer-use-windows-${wrongArch}-package-v1`, arch: `win-${wrongArch}` }),
  );
  const wrong = await f.discover(f.source);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /hinted package is missing, incomplete or for another architecture/);
  assert.equal(f.requests.length, 0);
});

test('Windows clean bootstrap uses native architecture and preserves an existing profile on rerun', { skip: !windows }, async t => {
  const f = await fixture(t);
  await mkdir(dirname(f.credentialPath), { recursive: true });
  const credential = JSON.stringify({ clientId: 'fixture-profile', token: 'fixture-secret-retained-only-in-test-directory' });
  await writeFile(f.credentialPath, credential);
  const first = await f.run();
  assert.equal(first.code, 0, first.stderr);
  const output = JSON.parse(first.stdout);
  assert.equal(output.platform, `windows-${f.arch}`);
  // Windows runners can expose TEMP through an 8.3 user alias while discovery returns its long name.
  assert.equal(await realpath(output.packageRoot), await realpath(f.packagePath));
  assert.equal(output.installed, true);
  const requests = f.requests.length;
  const second = await f.run();
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).installed, false);
  assert.equal(f.requests.length, requests);
  assert.equal(await readFile(f.credentialPath, 'utf8'), credential);
});

test('Windows bootstrap prioritizes all engine modules and restores a polluted caller module path', { skip: !windows }, async t => {
  const f = await fixture(t);
  const moduleRoot = join(f.directory, 'PowerShell 7 modules');
  // All three inherited modules are discoverable but cannot load in this engine, as with PS7 assemblies.
  for (const [name, commands] of [
    ['Security', ['Set-Acl', 'Get-Acl']],
    ['Utility', ['Get-FileHash', 'Add-Type', 'ConvertFrom-Json', 'ConvertTo-Json', 'Select-Object', 'New-Object']],
    ['Management', ['Get-Item', 'Join-Path', 'Test-Path', 'Remove-Item', 'Start-Process']],
  ]) {
    const moduleDirectory = join(moduleRoot, `Microsoft.PowerShell.${name}`);
    await mkdir(moduleDirectory, { recursive: true });
    await writeFile(
      join(moduleDirectory, `Microsoft.PowerShell.${name}.psd1`),
      `@{
RootModule = 'incompatible.psm1'
ModuleVersion = '7.0.0'
PowerShellVersion = '5.1'
FunctionsToExport = @(${commands.map(quote).join(', ')})
}`,
    );
    await writeFile(join(moduleDirectory, 'incompatible.psm1'), "throw 'Incompatible fixture module must never execute'\n");
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
  // PS7 -> Node can omit Windows PowerShell's module directory entirely. Do not repair it in the harness.
  env.PSModulePath = moduleRoot;
  for (const command of [
    `Set-Acl -LiteralPath ${quote(f.directory)} -AclObject ([Security.AccessControl.DirectorySecurity]::new())`,
    `Get-FileHash -LiteralPath ${quote(join(f.source, 'package.json'))} -Algorithm SHA256`,
  ]) {
    const unqualified = await powershell(
      `$ErrorActionPreference = 'Stop'
try { ${command}; exit 3 }
catch { [Console]::Error.WriteLine($_.FullyQualifiedErrorId); exit 1 }`,
      env,
    );
    assert.equal(unqualified.code, 1);
    assert.match(unqualified.stderr, /CouldNotAutoloadMatchingModule/);
  }
  const run = fixture =>
    powershell(
      `
$callerModulePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Process')
try { & {
${fixture.copy}
} } finally {
    if ([Environment]::GetEnvironmentVariable('PSModulePath', 'Process') -cne $callerModulePath) {
        [Console]::Error.WriteLine('Caller PSModulePath was not restored')
        exit 4
    }
}`,
      env,
    );
  const result = await run(f);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).installed, true);
  assert.ok(f.requests.length > 0);
  const repeated = await run(f);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).installed, false);
  const corrupt = await run(await fixture(t, { corrupt: true }));
  assert.equal(corrupt.code, 1, corrupt.stderr);
  assert.match(corrupt.stderr, /SHA-256/);
});

test('existing Windows v0.6.1 with a quoted CLI hint needs no network or process execution', { skip: !windows }, async t => {
  const f = await fixture(t, { installedVersion: '0.6.1' });
  const source = `& {\n${f.copy}\n} -Hint ${quote(join(f.source, 'runtime', 'cli.js'))}`;
  const result = await powershell(source);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).installed, false);
  assert.equal(f.requests.length, 0);
});

test('concurrent Windows bootstraps download once and reuse the installed package', { skip: !windows }, async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.run(), f.run()]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(results.map(result => JSON.parse(result.stdout).installed).sort(), [false, true]);
  assert.equal(f.requests.filter(url => url.endsWith('/releases/latest')).length, 1);
});

test('an incomplete Windows package blocks installation without changing existing files', { skip: !windows }, async t => {
  const f = await fixture(t);
  await mkdir(f.packagePath, { recursive: true });
  const marker = join(f.packagePath, 'keep-me.txt');
  await writeFile(marker, 'existing user work');
  for (const result of [await f.run(), await f.discover()]) {
    assert.equal(result.code, 1);
    assert.match(result.stderr, /incomplete, unknown or different-architecture/);
  }
  assert.equal(await readFile(marker, 'utf8'), 'existing user work');
  assert.equal(f.requests.length, 0);
});

for (const [name, options, error] of [
  ['hash mismatch', { corrupt: true }, /SHA-256/],
  ['truncated download', { truncated: true }, /SHA-256/],
  ['wrong platform', { metadata: { platform: 'macos-arm64' } }, /metadata/],
  ['string sourceDirty', { metadata: { sourceDirty: 'false' } }, /metadata/],
  ['boolean size', { metadata: { bytes: true } }, /metadata/],
  ['unsafe redirect', { redirect: 'https://attacker.example/installer.exe' }, /untrusted/],
  [
    'cross-source redirect',
    { redirect: 'https://computer-use-download-1308799022.cos.ap-guangzhou.myqcloud.com/computer-use/releases/v99.0.1/file.exe' },
    /original trusted source/,
  ],
  ['prerelease', { latest: 'https://github.com/starroyhq/computer-use/releases/tag/v9.9.9-rc.1' }, /stable version/],
]) {
  test(`Windows bootstrap rejects ${name} before invoking an installer`, { skip: !windows }, async t => {
    const f = await fixture(t, options);
    const result = await f.run();
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, error);
    assert.ok(!f.requests.some(url => url.startsWith('/computer-use/')), 'Validation failures must not use the mirror');
    await assert.rejects(readFile(join(f.packagePath, 'package.json')), /ENOENT/);
  });
}

test('Windows URL validation rejects userinfo, HTTP, ports and untrusted hosts', { skip: !windows }, async () => {
  const bad = [
    'https://github.com@attacker.example/payload',
    'http://github.com/file',
    'https://github.com:444/file',
    'https://github.com.attacker.example/file',
    'https://other-1308799022.cos.ap-guangzhou.myqcloud.com/computer-use/file',
    'https://computer-use-download-1308799022.cos.ap-guangzhou.myqcloud.com/other/file',
  ];
  for (const url of bad) {
    const result = await powershell(
      script.split(entry)[0] + `\ntry { Assert-TrustedUri ([Uri]${quote(url)}); exit 3 } catch { 'rejected' }`,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'rejected');
  }
});

for (const failure of ['/releases/latest', '.json', '.exe.sha256', '.exe']) {
  test(`Windows uses a verified COS release after GitHub failure at ${failure}`, { skip: !windows }, async t => {
    const f = await fixture(t, { githubFailure: failure });
    const result = await f.run();
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).installed, true);
    assert.ok(f.requests.includes('/computer-use/releases/v99.0.1/manifest.json'));
    assert.equal(f.requests.filter(url => url.endsWith('/latest.json')).length, failure === '/releases/latest' ? 1 : 0);
    assert.equal(f.requests.filter(url => url.endsWith('/releases/latest')).length, 1);
  });
}

for (const options of [{ interrupt: true }, { githubStatus: 429 }, { githubStatus: 403, rateLimited: true }]) {
  test(`Windows retries a clean mirror download for ${JSON.stringify(options)}`, { skip: !windows }, async t => {
    const f = await fixture(t, { githubFailure: '.exe', ...options });
    const result = await f.run();
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).installed, true);
  });
}

for (const githubStatus of [403, 404]) {
  test(`Windows does not switch source after HTTP ${githubStatus}`, { skip: !windows }, async t => {
    const f = await fixture(t, { githubFailure: '.exe', githubStatus });
    const result = await f.run();
    assert.equal(result.code, 1);
    assert.ok(!f.requests.some(url => url.startsWith('/computer-use/')));
    await assert.rejects(readFile(join(f.packagePath, 'package.json')), /ENOENT/);
  });
}

for (const [name, options, error] of [
  ['array schema version', { manifest: { schemaVersion: [1] } }, /Invalid mirror release manifest/],
  ['string schema version', { manifest: { schemaVersion: '1' } }, /Invalid mirror release manifest/],
  ['another version', { manifest: { version: '99.0.2', tag: 'v99.0.2' } }, /Invalid mirror release manifest/],
  ['another commit', { manifest: { commit: 'c'.repeat(40) } }, /commit differs/],
  ['different primary metadata', { mirrorMetadata: { commit: 'c'.repeat(40) } }, /selected release size or SHA-256/],
  ['corrupted mirror bytes', { mirrorCorrupt: true }, /SHA-256/],
  ['missing installer', { missingMirrorAsset: true }, /missing an asset/],
  ['unavailable mirror', { mirrorStatus: 503 }, /temporarily unavailable/],
  [
    'unsafe manifest name',
    { manifest: { assets: [{ name: '../payload', bytes: 1, sha256: 'a'.repeat(64) }] } },
    /Invalid mirror release asset/,
  ],
]) {
  test(`Windows rejects ${name} without re-resolving latest`, { skip: !windows }, async t => {
    const f = await fixture(t, { githubFailure: '.exe', ...options });
    const result = await f.run();
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, error);
    assert.ok(!f.requests.some(url => url.endsWith('/latest.json')));
    await assert.rejects(readFile(join(f.packagePath, 'package.json')), /ENOENT/);
  });
}
