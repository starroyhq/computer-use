import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { targetForArch, verify as verifyBundle } from './package-windows.mjs';

// 用 Inno Setup 把已校验的便携目录做成普通安装程序（按当前用户安装，不需要管理员权限）。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const INSTALLER_SCRIPT = join(ROOT, 'windows', 'installer', 'ComputerUse.iss');
// 与安装脚本的 AppId、托盘程序的安装版识别一致。
export const INSTALLER_APP_ID = '{6C2B9F4E-4B7A-4E0F-9C59-3B1D2F8A7E41}';
const UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${INSTALLER_APP_ID}_is1`;
const HOST_EXE = 'ComputerUse.WindowsHost.exe';
// Inno Setup 默认生成 x86 安装程序，在 ARM64 上经仿真运行；也接受 64 位（SetupArchitecture=x64）的版本。
const SETUP_MACHINES = new Set([0x014c, 0x8664, 0xaa64]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout: 900_000, maxBuffer: 20 * 1024 * 1024, ...options });
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

export function parseArguments(args, hostArch = process.arch) {
  let arch = hostArch;
  let archSpecified = false;
  let verifyOnly = false;
  let smokeTest = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--arch' && i + 1 < args.length && !args[i + 1].startsWith('-') && !archSpecified) {
      arch = args[++i];
      archSpecified = true;
    } else if (args[i] === '--verify-only' && !verifyOnly) verifyOnly = true;
    else if (args[i] === '--smoke-test' && !smokeTest) smokeTest = true;
    else throw new Error('Usage: node scripts/package-windows-installer.mjs [--arch arm64|x64] [--verify-only] [--smoke-test]');
  }
  return { target: targetForArch(arch), verifyOnly, smokeTest };
}

/**
 * ISCC.exe 的候选位置：设置了 INNO_SETUP_COMPILER 时只用它；否则依次找 Program Files（32 位与 64 位）
 * 和当前用户安装的 Inno Setup 7，再找可以并存的 Inno Setup 6。
 */
export function compilerCandidates(env = process.env) {
  if (env.INNO_SETUP_COMPILER) return [env.INNO_SETUP_COMPILER];
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  return ['Inno Setup 7', 'Inno Setup 6'].flatMap(name => roots.map(root => win32.join(root, name, 'ISCC.exe')));
}

async function findCompiler() {
  const lacking = [];
  for (const candidate of compilerCandidates()) {
    if (!(await exists(candidate))) continue;
    // 简体中文从 Inno Setup 7.0.2 起才是官方语言，6.x 默认不带这个语言文件。
    if (await exists(win32.join(win32.dirname(candidate), 'Languages', 'ChineseSimplified.isl'))) return candidate;
    lacking.push(candidate);
  }
  if (lacking.length)
    throw new Error(`Inno Setup at ${lacking.join(', ')} lacks Languages\\ChineseSimplified.isl; install Inno Setup 7.0.2 or later.`);
  throw new Error('Inno Setup 7.0.2 or later is required: ISCC.exe was not found. Set INNO_SETUP_COMPILER to its path.');
}

/** 编译参数：版本、架构与输入输出目录都从命令行传入，脚本本身不含路径。 */
export function compilerArguments({ version, arch, sourceDir, outputDir, outputName, script = INSTALLER_SCRIPT }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('The installer version must use the form MAJOR.MINOR.PATCH.');
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`Unsupported installer architecture: ${arch}`);
  return [
    '/Qp',
    `/DAppVersion=${version}`,
    `/DArch=${arch}`,
    `/DSourceDir=${sourceDir}`,
    `/DOutputDir=${outputDir}`,
    `/DOutputName=${outputName}`,
    script,
  ];
}

/** 安装脚本含中文提示：必须是带 BOM 的 UTF-8，否则 ISCC 按系统代码页读取，提示会乱码。 */
export async function assertScriptEncoding(script = INSTALLER_SCRIPT) {
  const file = await open(script, 'r');
  try {
    const head = Buffer.alloc(3);
    await file.read(head, 0, 3, 0);
    if (!head.equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error(`${basename(script)} must be saved as UTF-8 with a BOM.`);
  } finally {
    await file.close();
  }
}

export async function readPeMachine(path) {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(64);
    if ((await file.read(header, 0, 64, 0)).bytesRead !== 64 || header.toString('ascii', 0, 2) !== 'MZ')
      throw new Error(`Not a PE file: ${path}`);
    const pe = Buffer.alloc(6);
    if ((await file.read(pe, 0, 6, header.readUInt32LE(0x3c))).bytesRead !== 6 || pe.toString('ascii', 0, 4) !== 'PE\0\0')
      throw new Error(`Not a PE file: ${path}`);
    return pe.readUInt16LE(4);
  } finally {
    await file.close();
  }
}

/** 安装程序文件本身：Windows 可执行文件，大小与内含的完整组件相称。 */
export async function verifyInstallerFile(path) {
  const machine = await readPeMachine(path);
  if (!SETUP_MACHINES.has(machine)) throw new Error(`Unexpected installer machine type 0x${machine.toString(16)}: ${path}`);
  const { size } = await stat(path);
  if (size < 20 * 1024 * 1024) throw new Error(`The installer is too small to contain the runtime components: ${path}`);
  console.log(`Verified installer executable ${basename(path)} (${size} bytes).`);
}

async function renameWithRetry(from, to) {
  // 杀毒软件可能短暂占用刚生成的可执行文件。
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await delay(250);
    }
  }
}

export async function buildInstaller(target) {
  if (process.platform !== 'win32') throw new Error('Build the Windows installer on Windows.');
  await assertScriptEncoding();
  await verifyBundle(target.output, target);
  const version = JSON.parse(await readFile(join(target.output, 'package.json'), 'utf8')).version;
  const source = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;
  if (version !== source) throw new Error(`The package was built for ${version}, but the source is ${source}; rebuild the package.`);
  const compiler = await findCompiler();
  console.log(`Compiling the installer with ${compiler}`);
  await mkdir(join(ROOT, '.cache'), { recursive: true });
  const stage = await mkdtemp(join(ROOT, '.cache', 'package-installer-'));
  try {
    run(compiler, compilerArguments({ version, arch: target.npmArch, sourceDir: target.output, outputDir: stage, outputName: 'setup' }), {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const built = join(stage, 'setup.exe');
    await verifyInstallerFile(built);
    await rm(target.installer, { force: true });
    await renameWithRetry(built, target.installer);
  } finally {
    await rm(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
  console.log(`Packaged: ${target.installer}`);
}

/** 读取当前用户的卸载登记；没有安装时为 undefined。 */
export function parseRegistryValues(output) {
  const values = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

function uninstallRegistration() {
  const result = spawnSync('reg.exe', ['query', UNINSTALL_KEY], { encoding: 'utf8', timeout: 30_000 });
  if (result.error) throw result.error;
  return result.status === 0 ? parseRegistryValues(result.stdout ?? '') : undefined;
}

const normalized = path =>
  win32
    .resolve(path)
    .replace(/[\\/]+$/, '')
    .toLowerCase();

async function waitUntil(condition, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(500);
  }
}

/**
 * 冒烟测试：静默安装到临时目录，复验安装后的组件、卸载登记与开始菜单快捷方式，再静默卸载并确认清理干净。
 * 使用固定 AppId：本机已有安装版时拒绝运行，避免替换真实安装（CI 的 runner 是一次性环境）。
 */
export async function smokeTestInstaller(installer, target) {
  if (process.platform !== 'win32') throw new Error('Run the installer smoke test on Windows.');
  if (uninstallRegistration() && process.env.GITHUB_ACTIONS !== 'true')
    throw new Error('Computer Use is installed for this user; the smoke test would replace that installation.');
  const version = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;
  const root = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'computer-use-installer-'));
  const directory = join(root, 'Computer Use');
  const shortcut = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Computer Use.lnk');
  try {
    run(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', `/DIR=${directory}`, `/LOG=${join(root, 'install.log')}`]);
    await verifyBundle(directory, target);
    const registration = uninstallRegistration();
    if (
      !registration ||
      normalized(registration.InstallLocation ?? '') !== normalized(directory) ||
      registration.DisplayVersion !== version
    )
      throw new Error('The installer did not register the expected installation for the current user.');
    if (!(await exists(shortcut))) throw new Error('The installer did not create the Start menu shortcut.');
    // 没有实例在运行时，--quit 立即成功；安装和卸载程序都靠它先关闭正在运行的托盘程序。
    run(join(directory, HOST_EXE), ['--quit'], { timeout: 60_000 });
    run(join(directory, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
    // 卸载程序先把自己复制到临时目录再继续执行，原进程会提前返回：等到文件和登记都清除。
    await waitUntil(
      async () =>
        !(await exists(join(directory, HOST_EXE))) && !(await exists(join(directory, 'unins000.exe'))) && !uninstallRegistration(),
      180_000,
      'The uninstaller did not remove the installation in time.',
    );
    if (await exists(shortcut)) throw new Error('The uninstaller left the Start menu shortcut behind.');
    console.log('Installer smoke test passed: silent install, installed components, registration, shortcut, --quit and uninstall.');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  }
}

async function main() {
  const { target, verifyOnly, smokeTest } = parseArguments(process.argv.slice(2));
  if (!verifyOnly) await buildInstaller(target);
  await verifyInstallerFile(target.installer);
  if (smokeTest) await smokeTestInstaller(target.installer, target);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
