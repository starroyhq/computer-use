import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify as verifyMac } from '../../scripts/package-app.mjs';
import { DMG, verifyDmg } from '../../scripts/package-dmg.mjs';
import { smokeTestInstaller, verifyInstallerFile } from '../../scripts/package-windows-installer.mjs';
import { targetForArch, verify as verifyWindows } from '../../scripts/package-windows.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 300_000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  const [platform, ...extra] = process.argv.slice(2);
  const notarized = extra.length === 1 && extra[0] === '--notarized';
  if ((!notarized && extra.length) || (notarized && platform !== 'macos-arm64') ||
    !['macos-arm64', 'windows-x64', 'windows-arm64'].includes(platform)) {
    throw new Error('Usage: node .github/scripts/archive-package.mjs macos-arm64 [--notarized]|windows-x64|windows-arm64');
  }
  const mac = platform === 'macos-arm64';
  const arch = platform.split('-')[1];
  if (process.platform !== (mac ? 'darwin' : 'win32') || process.arch !== arch) {
    throw new Error('Archive verification must run on the target OS and architecture.');
  }
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid package version.');
  const commit = run('git', ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Missing source commit.');
  const dirty = run('git', ['status', '--porcelain']).length > 0;
  const ci = process.env.GITHUB_ACTIONS === 'true';
  if (ci && dirty) throw new Error('CI packaging changed tracked sources or created unignored files.');
  const output = join(root, 'artifacts', 'ci');
  await mkdir(output, { recursive: true });
  const name = `computer-use-${version}-${platform}-${commit.slice(0, 12)}-${notarized ? 'notarized' : 'dev'}`;
  const archive = join(output, `${name}.zip`);
  // 首次安装用的安装包：macOS 为 DMG（scripts/package-dmg.mjs），Windows 为安装程序（scripts/package-windows-installer.mjs）。
  const installer = join(output, mac ? `${name}.dmg` : `${name}-setup.exe`);
  const target = mac ? undefined : targetForArch(arch);
  const bundle = mac ? join(root, 'artifacts', 'Computer Use.app') : target.output;
  const verify = path => mac ? verifyMac(path) : verifyWindows(path, target);
  await verify(bundle);
  if (notarized) verifyNotarizedMac(bundle);
  await mkdir(join(root, '.cache'), { recursive: true });
  const temporary = await mkdtemp(join(root, '.cache', 'archive-check-'));
  try {
    // Keep the native archive inside upload-artifact's wrapper: macOS executable
    // modes, symlinks and signatures must survive download and extraction.
    if (mac) {
      await writeFile(archive, '', { flag: 'wx' });
      run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, archive]);
      run('/usr/bin/ditto', ['-x', '-k', archive, temporary]);
    } else {
      const script = join(temporary, 'archive.ps1');
      await writeFile(script, `param([string]$Source, [string]$Archive, [string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $Archive) { throw 'Refusing to replace an existing archive' }
[IO.Compression.ZipFile]::CreateFromDirectory($Source, $Archive, [IO.Compression.CompressionLevel]::Optimal, $true)
Expand-Archive -LiteralPath $Archive -DestinationPath $Destination
`);
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, bundle, archive, temporary]);
    }
    await verify(join(temporary, basename(bundle)));
    if (notarized) verifyNotarizedMac(join(temporary, basename(bundle)));
    const digest = await sha256(archive);
    await writeFile(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);

    await copyFile(mac ? DMG : target.installer, installer, constants.COPYFILE_EXCL);
    let installerCheck;
    if (mac) {
      await verifyDmg(installer, notarized
        ? { notarized: true, identity: process.env.APPLE_SIGNING_IDENTITY, team: process.env.APPLE_TEAM_ID }
        : {});
      installerCheck = ' Disk image mounted read-only with only the app and an Applications shortcut; its app verified' +
        (notarized ? '; image Developer ID signature, team, stapled ticket and Gatekeeper assessed.' : '.');
    } else {
      await verifyInstallerFile(installer);
      // 冒烟测试会以固定 AppId 安装再卸载，只在一次性的 CI runner 上自动运行。
      if (ci) await smokeTestInstaller(installer, target);
      installerCheck = ci
        ? ' Installer silently installed into a temporary folder, installed components, registration and shortcut verified, then uninstalled.'
        : ' Installer executable checked; not installed.';
    }
    const installerDigest = await sha256(installer);
    await writeFile(`${installer}.sha256`, `${installerDigest}  ${basename(installer)}\n`);

    await writeFile(join(output, `${name}.json`), JSON.stringify({
      version, platform, commit, sourceDirty: dirty, archive: basename(archive),
      bytes: (await stat(archive)).size, sha256: digest,
      signing: mac ? (notarized ? 'developer-id-notarized' : 'ad-hoc-development') : 'unsigned',
      ...(notarized ? { notarization: 'stapled' } : {}),
      installer: { name: basename(installer), bytes: (await stat(installer)).size, sha256: installerDigest },
      verification: 'Archive extracted; architecture, dependencies, CLI and native SDK verified.' +
        (notarized ? ' Developer ID signature, team, stapled ticket and Gatekeeper assessed.' : '') +
        installerCheck +
        ' No desktop or model acceptance.',
    }, null, 2) + '\n');
    console.log(`Verified archive: ${basename(archive)} (${digest})`);
    console.log(`Verified installer: ${basename(installer)} (${installerDigest})`);
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

function verifyNotarizedMac(app) {
  const identity = process.env.APPLE_SIGNING_IDENTITY;
  const team = process.env.APPLE_TEAM_ID;
  if (!identity?.startsWith('Developer ID Application:') || !/^[A-Z0-9]{10}$/.test(team ?? '')) {
    throw new Error('APPLE_SIGNING_IDENTITY and APPLE_TEAM_ID are required for notarized archive verification.');
  }
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', app], { encoding: 'utf8', timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`codesign display failed: ${result.stderr}`);
  const details = result.stderr;
  if (!details.split('\n').includes(`Authority=${identity}`) || !details.split('\n').includes(`TeamIdentifier=${team}`)) {
    throw new Error('App Developer ID signing identity or team does not match the release configuration.');
  }
  run('xcrun', ['stapler', 'validate', app]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
