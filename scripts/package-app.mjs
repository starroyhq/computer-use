import { spawnSync } from 'node:child_process';
import { access, chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { fetchRuntimes, ROOT, RUNTIMES } from './fetch-runtime.mjs';

const OUTPUT = join(ROOT, 'artifacts', 'Computer Use.app');
const MARKER = 'computer-use-package-v1';
const BUNDLE_ID = 'com.starroy.computeruse';
const cleanEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_') && !key.startsWith('DYLD_') && !key.startsWith('CUA_')),
  );
const childEnv = () => ({
  ...cleanEnvironment(),
  CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
  CUA_DRIVER_RS_UPDATE_CHECK: 'false',
  DO_NOT_TRACK: '1',
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: childEnv(),
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} failed (${result.status}):\n${result.stderr || result.stdout || ''}`);
  return (result.stdout ?? '').trim();
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

async function macho(path) {
  if (!(await lstat(path)).isFile()) return false;
  const file = await open(path, 'r');
  try {
    const magic = Buffer.alloc(4);
    if ((await file.read(magic, 0, 4, 0)).bytesRead !== 4) return false;
    return new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']).has(
      magic.toString('hex'),
    );
  } finally {
    await file.close();
  }
}

export async function assertInternalLinks(directory) {
  const root = await realpath(directory);
  for await (const path of files(directory)) {
    if (!(await lstat(path)).isSymbolicLink()) continue;
    const destination = await realpath(path);
    const rel = relative(root, destination);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error(`Bundle contains an external symlink: ${path}`);
  }
}

async function extract(archive, destination) {
  const entries = run('/usr/bin/tar', ['-tzf', archive]).split('\n');
  if (entries.some(entry => isAbsolute(entry) || entry.split('/').includes('..'))) throw new Error('Unsafe archive member path.');
  await mkdir(destination, { recursive: true });
  run('/usr/bin/tar', ['-xzf', archive, '-C', destination]);
}

export async function verify(app) {
  const resources = join(app, 'Contents', 'Resources');
  const receipt = JSON.parse(await readFile(join(resources, 'build-receipt.json'), 'utf8'));
  if (receipt.owner !== MARKER) throw new Error('Not a package created by this script.');
  for (const path of [
    'Contents/MacOS/ComputerUseHost',
    'Contents/Info.plist',
    'Contents/Resources/bin/cua-driver',
    'Contents/Resources/bin/node',
    'Contents/Resources/bin/computer-use',
    'Contents/Resources/runtime/host.js',
    'Contents/Resources/runtime/cli.js',
    'Contents/Resources/node_modules/@trycua/cua-driver/package.json',
  ]) {
    if (!(await exists(join(app, path)))) throw new Error(`Missing bundle resource: ${path}`);
  }
  const infoPlist = join(app, 'Contents', 'Info.plist');
  run('/usr/bin/plutil', ['-lint', infoPlist]);
  if (run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', infoPlist]) !== BUNDLE_ID) {
    throw new Error(`Bundle identifier must be ${BUNDLE_ID}.`);
  }
  await assertInternalLinks(app);
  let nativeCount = 0;
  for await (const path of files(app)) {
    if (!(await macho(path))) continue;
    const architectures = run('/usr/bin/lipo', ['-archs', path]).split(/\s+/);
    if (!architectures.includes('arm64')) throw new Error(`Native component lacks arm64: ${path}`);
    run('/usr/bin/codesign', ['--verify', '--strict', path]);
    nativeCount++;
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const node = join(resources, 'bin', 'node');
  if (run(node, ['--version']) !== `v${RUNTIMES.node.version}`) throw new Error('Bundled Node version mismatch.');
  const driverVersion = run(join(resources, 'bin', 'cua-driver'), ['--version']);
  if (!new RegExp(`\\b${RUNTIMES.cua.version.replaceAll('.', '\\.')}\\b`).test(driverVersion))
    throw new Error('Bundled driver version mismatch.');
  const help = run(join(resources, 'bin', 'computer-use'), ['--help']);
  if (!help.includes('computer-use')) throw new Error('Bundled CLI did not return its help.');
  const loaded = run(node, ['--input-type=module', '-e', 'await import("@trycua/cua-driver"); console.log("native-sdk-loaded");'], {
    cwd: resources,
  });
  if (loaded !== 'native-sdk-loaded') throw new Error('Bundled native SDK did not load.');
  console.log(`Verified arm64 bundle, ${nativeCount} signed native components, Node/driver versions, CLI help, and native SDK import.`);
  console.log('App UI, Accessibility, Screen Recording, and real application actions were not started.');
}

async function build(identity) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('This packaging target requires an Apple Silicon macOS host.');
  if (identity !== '-' && !identity.startsWith('Developer ID Application:'))
    throw new Error('Use the complete Developer ID Application identity, or omit --identity for an ad-hoc development build.');
  console.log('Building TypeScript and native release host…');
  run('pnpm', ['build'], { stdio: 'inherit' });
  run('swift', ['build', '--package-path', 'native', '-c', 'release', '--arch', 'arm64'], { stdio: 'inherit' });
  if (!(await exists(join(ROOT, 'dist', 'cli.js')))) throw new Error('dist/cli.js is required before packaging.');
  const nativeDirectory = run('swift', ['build', '--package-path', 'native', '-c', 'release', '--arch', 'arm64', '--show-bin-path']);
  const archives = await fetchRuntimes();
  await mkdir(join(ROOT, '.cache'), { recursive: true });
  await mkdir(dirname(OUTPUT), { recursive: true });
  const stage = await mkdtemp(join(ROOT, '.cache', 'package-app-'));
  try {
    const app = join(stage, 'Computer Use.app');
    const resources = join(app, 'Contents', 'Resources');
    const binaries = join(resources, 'bin');
    await mkdir(binaries, { recursive: true });
    await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
    await extract(archives.node, join(stage, 'node'));
    await extract(archives.cua, join(stage, 'cua'));
    await cp(join(stage, 'node', `node-v${RUNTIMES.node.version}-darwin-arm64`, 'bin', 'node'), join(binaries, 'node'));
    await cp(join(stage, 'cua', 'cua-driver'), join(binaries, 'cua-driver'));
    await cp(join(nativeDirectory, 'ComputerUseHost'), join(app, 'Contents', 'MacOS', 'ComputerUseHost'));
    await cp(join(ROOT, 'native', 'Info.plist'), join(app, 'Contents', 'Info.plist'));
    await cp(join(ROOT, 'dist'), join(resources, 'runtime'), { recursive: true });
    const dependencies = join(stage, 'dependencies');
    await mkdir(dependencies);
    for (const file of ['package.json', 'pnpm-lock.yaml']) await cp(join(ROOT, file), join(dependencies, file));
    // Isolate the staging project from the enclosing development workspace.
    await writeFile(join(dependencies, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
    console.log('Installing frozen production dependencies in an isolated staging project…');
    run('pnpm', ['install', '--prod', '--frozen-lockfile', '--ignore-scripts'], {
      cwd: dependencies,
      stdio: 'inherit',
      env: { ...childEnv(), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
    });
    await cp(join(dependencies, 'node_modules'), join(resources, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    await writeFile(
      join(resources, 'package.json'),
      JSON.stringify(
        { name: manifest.name, version: manifest.version, private: true, type: 'module', dependencies: manifest.dependencies },
        null,
        2,
      ),
    );
    await writeFile(
      join(binaries, 'computer-use'),
      '#!/bin/sh\nset -eu\n# Resolve CLI installation symlinks without requiring Node on PATH.\nscript=$0\nwhile [ -L "$script" ]; do\n  directory=$(CDPATH= cd -- "$(dirname -- "$script")" && pwd)\n  link=$(readlink "$script")\n  case "$link" in /*) script=$link ;; *) script=$directory/$link ;; esac\ndone\ndirectory=$(CDPATH= cd -- "$(dirname -- "$script")" && pwd)\nexec "$directory/node" "$directory/../runtime/cli.js" "$@"\n',
    );
    await chmod(join(binaries, 'computer-use'), 0o755);
    await mkdir(join(resources, 'licenses'), { recursive: true });
    await cp(join(stage, 'node', `node-v${RUNTIMES.node.version}-darwin-arm64`, 'LICENSE'), join(resources, 'licenses', 'NODE-LICENSE'));
    await cp(archives.cuaLicense, join(resources, 'licenses', 'CUA-LICENSE'));
    await chmod(join(resources, 'licenses', 'CUA-LICENSE'), 0o644);
    for (const file of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) await cp(join(ROOT, file), join(resources, 'licenses', file));
    if (await exists(join(ROOT, 'skills', 'computer-use', 'SKILL.md')))
      await cp(join(ROOT, 'skills', 'computer-use'), join(resources, 'skills', 'computer-use'), { recursive: true });
    await writeFile(
      join(resources, 'build-receipt.json'),
      JSON.stringify(
        {
          owner: MARKER,
          arch: 'arm64',
          signing: identity === '-' ? 'ad-hoc-development' : identity,
          node: RUNTIMES.node,
          cua: RUNTIMES.cua,
        },
        null,
        2,
      ),
    );
    await assertInternalLinks(app);
    // Node's upstream tools/osx-entitlements.plist declares these executable-memory
    // permissions. Deliberately omit debugger, DYLD, and library-validation bypasses;
    // every bundled native module is signed with the same selected identity.
    const entitlements = join(stage, 'node.entitlements');
    await writeFile(
      entitlements,
      '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>',
    );
    console.log(`Signing nested native components (${identity === '-' ? 'ad-hoc development' : 'Developer ID'})…`);
    for await (const path of files(app)) {
      if (!(await macho(path))) continue;
      run('/usr/bin/codesign', [
        '--force',
        '--sign',
        identity,
        '--options',
        identity === '-' ? '0' : 'runtime',
        ...(identity === '-' ? ['--timestamp=none'] : ['--timestamp']),
        ...(path === join(binaries, 'node') ? ['--entitlements', entitlements] : []),
        path,
      ]);
    }
    run('/usr/bin/codesign', [
      '--force',
      '--sign',
      identity,
      '--options',
      identity === '-' ? '0' : 'runtime',
      ...(identity === '-' ? ['--timestamp=none'] : ['--timestamp']),
      app,
    ]);
    await verify(app);
    if (await exists(OUTPUT)) {
      const old = JSON.parse(await readFile(join(OUTPUT, 'Contents', 'Resources', 'build-receipt.json'), 'utf8'));
      if (old.owner !== MARKER) throw new Error('Refusing to replace an artifact not owned by this packaging script.');
      await rm(OUTPUT, { recursive: true });
    }
    await rename(app, OUTPUT);
    console.log(`Packaged: ${OUTPUT}`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

const LOCAL_ENV = join(ROOT, '.env.local');

// 本机签名身份只存放在被 git 忽略的 .env.local 中；只读取这一项，不把文件其他内容注入环境。
export async function signingIdentity(args, envFile = LOCAL_ENV) {
  if (args.length === 2 && args[0] === '--identity') return args[1];
  if (args.length !== 0) throw new Error('Usage: node scripts/package-app.mjs [--verify-only | --identity "Developer ID Application: …"]');
  const content = await readFile(envFile, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return parseEnv(content).COMPUTER_USE_SIGNING_IDENTITY?.trim() || '-';
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--verify-only') {
    await verify(OUTPUT);
    return;
  }
  await build(await signingIdentity(args));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
