import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = {
  arm64: {
    label: 'ARM64', rid: 'win-arm64', peMachine: 0xaa64, npmArch: 'arm64',
    marker: 'computer-use-windows-arm64-package-v1',
    node: { filename: 'node-v24.21.0-win-arm64.zip', sha256: '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921' },
    cua: { filename: 'cua-driver-rs-0.28.2-windows-arm64-binary.zip', sha256: '578b88ff2dd56f06eb7e984d73aaf5e76f59c6fde9542c967d6a30d00213c680' },
  },
  x64: {
    label: 'x64', rid: 'win-x64', peMachine: 0x8664, npmArch: 'x64',
    marker: 'computer-use-windows-x64-package-v1',
    node: { filename: 'node-v24.21.0-win-x64.zip', sha256: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541' },
    cua: { filename: 'cua-driver-rs-0.28.2-windows-x86_64-binary.zip', sha256: '1f4bfceeab64cb7f56be7aad774c3dc2d2910d1427e4be1d79939c706e8029ba' },
  },
};
const NODE_COMMON = { version: '24.21.0', baseUrl: 'https://nodejs.org/dist/v24.21.0', checksumFile: 'SHASUMS256.txt' };
const CUA_COMMON = { version: '0.28.2', baseUrl: 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.2', checksumFile: 'checksums.txt' };
const CUA_LICENSE_SHA256 = 'c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9';

export function targetForArch(arch) {
  const target = TARGETS[arch];
  if (!target) throw new Error(`Unsupported Windows architecture: ${arch}. Use arm64 or x64.`);
  return { ...target, output: join(ROOT, 'artifacts', `Computer Use Windows ${target.label}`),
    node: { ...NODE_COMMON, ...target.node }, cua: { ...CUA_COMMON, ...target.cua } };
}

export function parseArguments(args, hostArch = process.arch) {
  let arch = hostArch;
  let archSpecified = false;
  let verifyOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--arch' && i + 1 < args.length && !args[i + 1].startsWith('-') && !archSpecified) { arch = args[++i]; archSpecified = true; }
    else if (args[i] === '--verify-only' && !verifyOnly) verifyOnly = true;
    else throw new Error('Usage: node scripts/package-windows.mjs [--arch arm64|x64] [--verify-only]');
  }
  return { target: targetForArch(arch), verifyOnly };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout: 600_000,
    maxBuffer: 20 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} failed (${result.status}):\n${result.stderr || result.stdout || ''}`);
  return (result.stdout ?? '').trim();
}

async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function renameAfterExecution(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) {
      if (process.platform !== 'win32' || attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await delay(250);
    }
  }
}
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function download(url, path) {
  const temporary = `${path}.partial-${process.pid}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
async function fetchArchive(component, cache) {
  const manifest = join(cache, `${component.version}-${component.checksumFile}`);
  if (!await exists(manifest)) await download(`${component.baseUrl}/${component.checksumFile}`, manifest);
  const entry = (await readFile(manifest, 'utf8')).split(/\r?\n/).find(line => line.trim().split(/\s+/)[1] === component.filename);
  if (!entry || entry.trim().split(/\s+/)[0] !== component.sha256) throw new Error(`Pinned ${component.filename} hash disagrees with upstream manifest.`);
  const archive = join(cache, component.filename);
  if (!await exists(archive)) await download(`${component.baseUrl}/${component.filename}`, archive);
  if (await sha256(archive) !== component.sha256) throw new Error(`Checksum mismatch: ${archive}`);
  return archive;
}
async function extract(archive, destination, script) {
  await mkdir(destination, { recursive: true });
  // The archives are pinned to upstream SHA-256 before extraction.
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, archive, destination]);
}
async function assertInternalLinks(directory) {
  const root = await realpath(directory);
  async function scan(folder) {
    for (const name of await readdir(folder)) {
      const path = join(folder, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        const destination = await realpath(path);
        const rel = relative(root, destination);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`External package link: ${path}`);
      } else if (stat.isDirectory()) await scan(path);
    }
  }
  await scan(directory);
}
export async function assertPeMachine(path, target) {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(64);
    if ((await file.read(header, 0, 64, 0)).bytesRead !== 64 || header.toString('ascii', 0, 2) !== 'MZ') throw new Error(`Not a PE file: ${path}`);
    const offset = header.readUInt32LE(0x3c);
    const pe = Buffer.alloc(6);
    if ((await file.read(pe, 0, 6, offset)).bytesRead !== 6 || pe.toString('ascii', 0, 4) !== 'PE\0\0' || pe.readUInt16LE(4) !== target.peMachine) {
      throw new Error(`Native component is not Windows ${target.label}: ${path}`);
    }
  } finally { await file.close(); }
}

export async function verify(bundle, target) {
  const receipt = JSON.parse(await readFile(join(bundle, 'build-receipt.json'), 'utf8'));
  if (receipt.owner !== target.marker || receipt.arch !== target.rid
    || receipt.node?.filename !== target.node.filename || receipt.node?.sha256 !== target.node.sha256
    || receipt.cua?.filename !== target.cua.filename || receipt.cua?.sha256 !== target.cua.sha256) {
    throw new Error(`Not a Computer Use Windows ${target.label} package produced by this script.`);
  }
  const required = ['ComputerUse.WindowsHost.exe', 'bin/node.exe', 'bin/cua-driver.exe', 'bin/cua_driver_sdk.dll',
    'bin/cua_driver_node_runtime.node', 'runtime/host.js', 'runtime/cli.js', 'node_modules/@trycua/cua-driver/package.json',
    `node_modules/@trycua/cua-driver-win32-${target.npmArch}-msvc/package.json`, 'licenses/NODE-LICENSE', 'licenses/CUA-LICENSE',
    'licenses/DOTNET-LICENSE', 'licenses/DOTNET-THIRD-PARTY-NOTICES'];
  for (const name of required) if (!await exists(join(bundle, name))) throw new Error(`Missing Windows package resource: ${name}`);
  await assertInternalLinks(bundle);
  for (const name of ['ComputerUse.WindowsHost.exe', 'bin/node.exe', 'bin/cua-driver.exe', 'bin/cua_driver_sdk.dll', 'bin/cua_driver_node_runtime.node']) {
    await assertPeMachine(join(bundle, name), target);
  }
  const node = join(bundle, 'bin', 'node.exe');
  if (run(node, ['--version']) !== `v${target.node.version}`) throw new Error('Bundled Node version mismatch.');
  if (!run(join(bundle, 'bin', 'cua-driver.exe'), ['--version']).includes(target.cua.version)) throw new Error('Bundled Cua Driver version mismatch.');
  if (!run(node, [join(bundle, 'runtime', 'cli.js'), '--help'], { cwd: bundle }).includes('computer-use')) throw new Error('Bundled CLI failed.');
  if (run(node, ['--input-type=module', '-e', 'await import("@trycua/cua-driver"); console.log("native-sdk-loaded")'], { cwd: bundle }) !== 'native-sdk-loaded') {
    throw new Error(`Bundled Windows ${target.label} native SDK failed to load.`);
  }
  console.log(`Verified Windows ${target.label} PE files, internal links, versions, CLI and native SDK import. Desktop actions were not tested.`);
}

async function build(target) {
  const native = process.arch === target.npmArch;
  const emulatedX64 = process.arch === 'arm64' && target.npmArch === 'x64';
  if (process.platform !== 'win32' || (!native && !emulatedX64)) {
    throw new Error(`Build the Windows ${target.label} package inside Windows ${target.label}${target.npmArch === 'x64' ? ' or Windows ARM64' : ''}.`);
  }
  await mkdir(join(ROOT, '.cache'), { recursive: true });
  await mkdir(dirname(target.output), { recursive: true });
  const stage = await mkdtemp(join(ROOT, '.cache', 'package-windows-'));
  try {
    const bundle = join(stage, `Computer Use Windows ${target.label}`);
    const bin = join(bundle, 'bin');
    const licenses = join(bundle, 'licenses');
    const publish = join(stage, 'publish');
    const dependencies = join(stage, 'dependencies');
    const cache = join(ROOT, '.cache', 'runtime-downloads');
    await Promise.all([mkdir(bin, { recursive: true }), mkdir(licenses, { recursive: true }), mkdir(dependencies), mkdir(cache, { recursive: true })]);
    run('pnpm.cmd', ['build'], { shell: true, stdio: 'inherit' });
    run('dotnet.exe', ['publish', join(ROOT, 'windows', 'ComputerUse.WindowsHost', 'ComputerUse.WindowsHost.csproj'),
      '-c', 'Release', '-r', target.rid, '--self-contained', 'true', '-o', publish], { stdio: 'inherit' });
    await cp(publish, bundle, { recursive: true });
    await cp(join(ROOT, 'dist'), join(bundle, 'runtime'), { recursive: true });
    await cp(join(ROOT, 'docs', 'WINDOWS.md'), join(bundle, 'WINDOWS.md'));
    await mkdir(join(bundle, 'helpers'));
    await cp(join(ROOT, 'scripts', 'windows-remote-auth.mjs'), join(bundle, 'helpers', 'windows-remote-auth.mjs'));
    const [nodeArchive, cuaArchive] = await Promise.all([fetchArchive(target.node, cache), fetchArchive(target.cua, cache)]);
    const extractor = join(stage, 'extract.ps1');
    await writeFile(extractor, 'param([string]$Archive, [string]$Destination)\n$ErrorActionPreference = "Stop"\nExpand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force\n');
    await extract(nodeArchive, join(stage, 'node'), extractor);
    await extract(cuaArchive, join(stage, 'cua'), extractor);
    await cp(join(stage, 'node', `node-v${target.node.version}-${target.rid}`, 'node.exe'), join(bin, 'node.exe'));
    for (const name of ['cua-driver.exe', 'cua-cursor-theme.exe', 'cua-driver-uia.exe', 'cua_driver_sdk.dll', 'cua_driver_node_runtime.node', 'cua_driver_abi.h']) {
      await cp(join(stage, 'cua', name), join(bin, name));
    }
    for (const name of ['package.json', 'pnpm-lock.yaml']) await cp(join(ROOT, name), join(dependencies, name));
    // pnpm must select the target native optional dependency when cross-packaging x64 on Windows ARM64.
    await writeFile(join(dependencies, 'pnpm-workspace.yaml'), `packages:\n  - .\nsupportedArchitectures:\n  os:\n    - win32\n  cpu:\n    - ${target.npmArch}\n`);
    // Hoisted installation keeps package links inside the staging tree when the
    // verified bundle is moved to artifacts (Windows junctions can be absolute).
    run('pnpm.cmd', ['install', '--prod', '--frozen-lockfile', '--ignore-scripts', '--config.node-linker=hoisted', '--config.package-import-method=copy'], {
      cwd: dependencies, shell: true, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
    });
    await cp(join(dependencies, 'node_modules'), join(bundle, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, private: true, type: 'module', dependencies: manifest.dependencies }, null, 2));
    const nodeDir = join(stage, 'node', `node-v${target.node.version}-${target.rid}`);
    await cp(join(nodeDir, 'LICENSE'), join(licenses, 'NODE-LICENSE'));
    const dotnetRoot = dirname(run('where.exe', ['dotnet.exe']).split(/\r?\n/)[0]);
    for (const [name, target] of [['LICENSE.txt', 'DOTNET-LICENSE'], ['ThirdPartyNotices.txt', 'DOTNET-THIRD-PARTY-NOTICES']]) {
      if (!await exists(join(dotnetRoot, name))) throw new Error(`The self-contained .NET license is missing from ${dotnetRoot}.`);
      await cp(join(dotnetRoot, name), join(licenses, target));
    }
    const cuaLicense = join(cache, 'cua-0.28.2-LICENSE.md');
    if (!await exists(cuaLicense)) await download('https://raw.githubusercontent.com/trycua/cua/cua-driver-rs-v0.28.2/LICENSE.md', cuaLicense);
    if (await sha256(cuaLicense) !== CUA_LICENSE_SHA256) throw new Error('Cua license checksum mismatch.');
    await cp(cuaLicense, join(licenses, 'CUA-LICENSE'));
    for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) await cp(join(ROOT, name), join(licenses, name));
    if (await exists(join(ROOT, 'skills', 'computer-use', 'SKILL.md'))) await cp(join(ROOT, 'skills', 'computer-use'), join(bundle, 'skills', 'computer-use'), { recursive: true });
    await writeFile(join(bundle, 'build-receipt.json'), JSON.stringify({ owner: target.marker, arch: target.rid, node: target.node, cua: target.cua }, null, 2));
    await verify(bundle, target);
    if (await exists(target.output)) {
      const old = JSON.parse(await readFile(join(target.output, 'build-receipt.json'), 'utf8'));
      if (old.owner !== target.marker || old.arch !== target.rid) throw new Error('Refusing to replace a Windows artifact not owned by this script.');
      const backup = join(stage, 'previous');
      await renameAfterExecution(target.output, backup);
      try { await renameAfterExecution(bundle, target.output); }
      catch (error) { await renameAfterExecution(backup, target.output); throw error; }
    } else await renameAfterExecution(bundle, target.output);
    console.log(`Packaged: ${target.output}`);
  } finally { await rm(stage, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
}

async function main() {
  const { target, verifyOnly } = parseArguments(process.argv.slice(2));
  if (verifyOnly) return verify(target.output, target);
  return build(target);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
