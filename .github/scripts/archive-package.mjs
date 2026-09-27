import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify as verifyMac } from '../../scripts/package-app.mjs';
import { targetForArch, verify as verifyWindows } from '../../scripts/package-windows.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 300_000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function main() {
  const [platform, ...extra] = process.argv.slice(2);
  if (extra.length || !['macos-arm64', 'windows-x64', 'windows-arm64'].includes(platform)) {
    throw new Error('Usage: node .github/scripts/archive-package.mjs macos-arm64|windows-x64|windows-arm64');
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
  if (process.env.GITHUB_ACTIONS === 'true' && dirty) throw new Error('CI packaging changed tracked sources or created unignored files.');
  const output = join(root, 'artifacts', 'ci');
  await mkdir(output, { recursive: true });
  const name = `computer-use-${version}-${platform}-${commit.slice(0, 12)}-dev`;
  const archive = join(output, `${name}.zip`);
  const target = mac ? undefined : targetForArch(arch);
  const bundle = mac ? join(root, 'artifacts', 'Computer Use.app') : target.output;
  const verify = path => mac ? verifyMac(path) : verifyWindows(path, target);
  await verify(bundle);
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
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    const digest = hash.digest('hex');
    await writeFile(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
    await writeFile(join(output, `${name}.json`), JSON.stringify({
      version, platform, commit, sourceDirty: dirty, archive: basename(archive),
      bytes: (await stat(archive)).size, sha256: digest,
      signing: mac ? 'ad-hoc-development' : 'unsigned',
      verification: 'Archive extracted; architecture, dependencies, CLI and native SDK verified. No desktop or model acceptance.',
    }, null, 2) + '\n');
    console.log(`Verified development archive: ${basename(archive)} (${digest})`);
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
