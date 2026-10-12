import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const packageFiles = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'bin/computer-use.mjs',
  'lib/launcher.mjs',
  'package.json',
  'resources/bootstrap-macos.sh',
  'resources/bootstrap-windows.ps1',
].sort();

function sourceFor(root, path) {
  if (path.startsWith('resources/')) return join(root, 'skills', 'computer-use', basename(path));
  if (['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'].includes(path)) return join(root, path);
  return join(root, 'packages', 'npm', path);
}

function assertList(actual, expected, description) {
  if (!Array.isArray(actual) || JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${description} must match the explicit package file list.`);
  }
}

export function validateManifest(manifest) {
  if (manifest.name !== '@starroy/computer-use' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('The npm package must use the expected name and a stable release version.');
  }
  if (manifest.private === true || manifest.type !== 'module' || manifest.license !== 'MIT') {
    throw new Error('The npm launcher must be a public MIT ESM package.');
  }
  if (JSON.stringify(manifest.bin) !== JSON.stringify({ 'computer-use': 'bin/computer-use.mjs' })) {
    throw new Error('The npm package must expose only bin/computer-use.mjs as computer-use.');
  }
  if (manifest.repository?.url !== 'git+https://github.com/starroyhq/computer-use.git') {
    throw new Error('The npm repository URL must match the trusted publishing repository.');
  }
  for (const key of ['scripts', 'dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']) {
    if (manifest[key] && Object.keys(manifest[key]).length > 0) throw new Error(`The npm launcher cannot contain ${key}.`);
  }
  if (
    manifest.publishConfig?.access !== 'public' ||
    !['https://registry.npmjs.org', 'https://registry.npmjs.org/'].includes(manifest.publishConfig?.registry)
  ) {
    throw new Error('The npm launcher must publish publicly to https://registry.npmjs.org.');
  }
  assertList(
    manifest.files,
    packageFiles.filter(path => path !== 'package.json'),
    'package.json files',
  );
}

// These short, fixed paths require only ordinary ustar entries. Reject links,
// extended paths and unexpected files before accepting the packed artifact.
function packageTarEntries(tar) {
  const entries = new Map();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const name = field(0, 100);
    const size = Number.parseInt(field(124, 12).trim(), 8);
    const mode = Number.parseInt(field(100, 8).trim(), 8);
    const checksum = Number.parseInt(field(148, 8).trim(), 8);
    let actualChecksum = 0;
    for (let index = 0; index < 512; index++) actualChecksum += index >= 148 && index < 156 ? 32 : header[index];
    const path = name.replace(/^package\//, '');
    if (
      checksum !== actualChecksum ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + 512 + size > tar.length ||
      !name.startsWith('package/') ||
      !packageFiles.includes(path) ||
      field(345, 155) ||
      !['', '0'].includes(field(156, 1)) ||
      entries.has(path)
    ) {
      throw new Error(`Invalid or unexpected entry in npm archive: ${name}`);
    }
    entries.set(path, { content: tar.subarray(offset + 512, offset + 512 + size), mode, header });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assertList([...entries.keys()], packageFiles, 'npm archive');
  return entries;
}

export function readPackageArchive(bytes) {
  const entries = packageTarEntries(gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 }));
  if (!(entries.get('bin/computer-use.mjs').mode & 0o111)) throw new Error('The npm CLI entry point is not executable.');
  return new Map([...entries].map(([path, { content, mode }]) => [path, { content, mode }]));
}

export function normalizeArchiveModes(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 });
  const entries = packageTarEntries(tar);
  // Windows chmod cannot express Unix executable bits, so npm pack may emit
  // a non-executable bin. Normalize only permissions and header checksums;
  // the final verifier still requires an executable bin and exact source bytes.
  for (const [path, { header }] of entries) {
    const mode = path === 'bin/computer-use.mjs' ? 0o755 : 0o644;
    header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  }
  return gzipSync(tar);
}

export async function verifyNpmArchive(path, { root = ROOT } = {}) {
  const bytes = await readFile(path);
  const entries = readPackageArchive(bytes);
  const manifest = JSON.parse(entries.get('package.json').content.toString('utf8'));
  validateManifest(manifest);
  for (const file of packageFiles) {
    const source = await readFile(sourceFor(root, file));
    if (file === 'package.json') {
      // npm normalizes JSON whitespace when packing, but must not alter fields.
      if (JSON.stringify(JSON.parse(source)) !== JSON.stringify(manifest)) throw new Error('Packed package.json differs from source.');
    } else if (!source.equals(entries.get(file).content)) {
      throw new Error(`Packed resource differs from source: ${file}`);
    }
  }
  return {
    path: resolve(path),
    filename: basename(path),
    name: manifest.name,
    version: manifest.version,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    files: [...entries.keys()].sort(),
  };
}

async function npmCommand() {
  if (process.platform !== 'win32') return { command: 'npm', prefix: [] };
  // Launch npm's JavaScript directly on Windows; do not interpolate paths into cmd.exe.
  const candidates = [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const found = spawnSync('where.exe', ['npm.cmd'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (found.status === 0) {
    for (const path of found.stdout.trim().split(/\r?\n/)) candidates.push(join(dirname(path), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  for (const path of candidates) {
    if (
      await lstat(path).then(
        stat => stat.isFile(),
        () => false,
      )
    )
      return { command: process.execPath, prefix: [path] };
  }
  throw new Error('Cannot locate npm-cli.js beside Node.js or npm.cmd. Install a Node.js distribution that includes npm.');
}

export async function packageNpm({ root = ROOT, output = join(root, 'artifacts', 'npm') } = {}) {
  root = resolve(root);
  output = resolve(output);
  const manifest = JSON.parse(await readFile(sourceFor(root, 'package.json'), 'utf8'));
  validateManifest(manifest);
  const cache = join(root, '.cache');
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(join(cache, 'npm-package-'));
  try {
    const stage = join(temporary, 'package');
    const packed = join(temporary, 'packed');
    await mkdir(packed);
    for (const file of packageFiles) {
      const source = sourceFor(root, file);
      if (!(await lstat(source)).isFile()) throw new Error(`Package source must be a regular file: ${file}`);
      const destination = join(stage, file);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      await chmod(destination, file === 'bin/computer-use.mjs' ? 0o755 : 0o644);
    }
    const userconfig = join(temporary, 'npmrc');
    await writeFile(userconfig, '');
    const { command, prefix } = await npmCommand();
    const result = spawnSync(command, [...prefix, 'pack', '--ignore-scripts', '--json', '--pack-destination', packed], {
      cwd: stage,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        npm_config_userconfig: userconfig,
        npm_config_cache: join(temporary, 'npm-cache'),
        npm_config_ignore_scripts: 'true',
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm pack failed (${result.status}): ${result.stderr || result.stdout}`);
    const report = JSON.parse(result.stdout);
    const filename = `starroy-computer-use-${manifest.version}.tgz`;
    if (report.length !== 1 || report[0].filename !== filename) throw new Error('npm pack returned an unexpected package.');
    assertList(
      report[0].files.map(file => file.path),
      packageFiles,
      'npm pack report',
    );
    const archive = join(packed, filename);
    await writeFile(archive, normalizeArchiveModes(await readFile(archive)));
    const verified = await verifyNpmArchive(archive, { root });
    await mkdir(output, { recursive: true });
    const destination = join(output, filename);
    // The output directory may be on another filesystem. Copy to a unique sibling
    // first, then rename the completed, verified artifact into place.
    const outputStage = await mkdtemp(join(output, '.npm-package-'));
    try {
      const stagedArchive = join(outputStage, filename);
      await copyFile(verified.path, stagedArchive);
      await rename(stagedArchive, destination);
    } finally {
      await rm(outputStage, { recursive: true, force: true });
    }
    return { ...verified, path: destination };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function parseArguments(args) {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === '--out' && args[1] && !args[1].startsWith('-')) return { output: resolve(args[1]) };
  throw new Error('Usage: node scripts/package-npm.mjs [--out DIR]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await packageNpm(parseArguments(process.argv.slice(2)))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
