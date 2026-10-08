import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import {
  assertScriptEncoding,
  compilerArguments,
  compilerCandidates,
  INSTALLER_APP_ID,
  INSTALLER_SCRIPT,
  parseArguments as parseInstallerArguments,
  parseRegistryValues,
  readPeMachine,
  verifyInstallerFile,
} from './package-windows-installer.mjs';
import { assertPeMachine, parseArguments, targetForArch } from './package-windows.mjs';

/** 只有 PE 头的最小可执行文件，用于检查机器类型。 */
function peFile(machine, size = 0x86) {
  const pe = Buffer.alloc(size);
  pe.write('MZ');
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write('PE\0\0', 0x80);
  pe.writeUInt16LE(machine, 0x84);
  return pe;
}

test('Windows package targets have separate binaries, receipts and destinations', () => {
  const arm64 = targetForArch('arm64');
  const x64 = targetForArch('x64');
  assert.equal(arm64.rid, 'win-arm64');
  assert.equal(x64.rid, 'win-x64');
  assert.notEqual(arm64.output, x64.output);
  assert.notEqual(arm64.marker, x64.marker);
  assert.match(arm64.node.filename, /win-arm64/);
  assert.match(x64.node.filename, /win-x64/);
  assert.match(arm64.cua.filename, /windows-arm64/);
  assert.match(x64.cua.filename, /windows-x86_64/);
  assert.equal(basename(arm64.installer), 'Computer Use Windows ARM64 Setup.exe');
  assert.equal(basename(x64.installer), 'Computer Use Windows x64 Setup.exe');
  assert.throws(() => targetForArch('ia32'), /Unsupported Windows architecture/);
});

test('Windows installer CLI selects the target and optional checks', () => {
  assert.deepEqual(
    { ...parseInstallerArguments([], 'arm64'), target: undefined },
    { target: undefined, verifyOnly: false, smokeTest: false },
  );
  const parsed = parseInstallerArguments(['--arch', 'x64', '--verify-only', '--smoke-test'], 'arm64');
  assert.equal(parsed.target.rid, 'win-x64');
  assert.equal(parsed.verifyOnly, true);
  assert.equal(parsed.smokeTest, true);
  assert.throws(() => parseInstallerArguments(['--smoke-test', '--smoke-test'], 'arm64'), /Usage/);
  assert.throws(() => parseInstallerArguments(['--arch'], 'arm64'), /Usage/);
  assert.throws(() => parseInstallerArguments(['--sign'], 'arm64'), /Usage/);
});

test('Inno Setup is found from an explicit path or the standard install folders', () => {
  assert.deepEqual(
    compilerCandidates({
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
    }),
    [
      'C:\\Program Files (x86)\\Inno Setup 7\\ISCC.exe',
      'C:\\Program Files\\Inno Setup 7\\ISCC.exe',
      'C:\\Users\\a\\AppData\\Local\\Programs\\Inno Setup 7\\ISCC.exe',
      'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
      'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
      'C:\\Users\\a\\AppData\\Local\\Programs\\Inno Setup 6\\ISCC.exe',
    ],
  );
  // 显式指定时不再回退到其他位置。
  assert.deepEqual(compilerCandidates({ INNO_SETUP_COMPILER: 'D:\\Tools\\ISCC.exe', ProgramFiles: 'C:\\Program Files' }), [
    'D:\\Tools\\ISCC.exe',
  ]);
  assert.deepEqual(compilerCandidates({}), []);
});

test('the installer script receives version, architecture and folders on the command line', () => {
  const args = compilerArguments({ version: '0.6.0', arch: 'arm64', sourceDir: 'C:\\pkg', outputDir: 'C:\\out', outputName: 'setup' });
  assert.deepEqual(args, [
    '/Qp',
    '/DAppVersion=0.6.0',
    '/DArch=arm64',
    '/DSourceDir=C:\\pkg',
    '/DOutputDir=C:\\out',
    '/DOutputName=setup',
    INSTALLER_SCRIPT,
  ]);
  assert.throws(
    () => compilerArguments({ version: '0.6.0-beta.1', arch: 'x64', sourceDir: 'a', outputDir: 'b', outputName: 'c' }),
    /MAJOR/,
  );
  assert.throws(
    () => compilerArguments({ version: '0.6.0', arch: 'ia32', sourceDir: 'a', outputDir: 'b', outputName: 'c' }),
    /architecture/,
  );
});

test('the installer script keeps its BOM and the AppId the tray host recognizes', async () => {
  await assertScriptEncoding();
  const script = await readFile(INSTALLER_SCRIPT, 'utf8');
  // Inno Setup 用 {{ 转义 AppId 开头的花括号。
  assert.equal(/^AppId=\{(\{[0-9A-F-]{36}\})$/m.exec(script)?.[1], INSTALLER_APP_ID);
  const host = await readFile(new URL('../windows/ComputerUse.WindowsHost/Updater.cs', import.meta.url), 'utf8');
  assert.equal(/InstallerAppId = "(\{[0-9A-F-]{36}\})"/.exec(host)?.[1], INSTALLER_APP_ID);
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-iss-'));
  try {
    const plain = join(directory, 'plain.iss');
    await writeFile(plain, '; 没有 BOM\n');
    await assert.rejects(assertScriptEncoding(plain), /UTF-8 with a BOM/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the smoke test reads uninstall registration values', () => {
  const output = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{6C2B9F4E-4B7A-4E0F-9C59-3B1D2F8A7E41}_is1',
    '    Inno Setup: Setup Version    REG_SZ    6.7.1',
    '    InstallLocation    REG_SZ    C:\\Users\\a\\AppData\\Local\\Programs\\Computer Use\\',
    '    DisplayVersion    REG_SZ    0.6.0',
    '    EstimatedSize    REG_DWORD    0x5b8d8',
    '',
  ].join('\r\n');
  const values = parseRegistryValues(output);
  assert.equal(values.InstallLocation, 'C:\\Users\\a\\AppData\\Local\\Programs\\Computer Use\\');
  assert.equal(values.DisplayVersion, '0.6.0');
  assert.equal(values.EstimatedSize, '0x5b8d8');
});

test('installer executables must be Windows programs large enough to hold the package', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-installer-pe-'));
  try {
    const small = join(directory, 'small.exe');
    await writeFile(small, peFile(0x014c));
    assert.equal(await readPeMachine(small), 0x014c);
    await assert.rejects(verifyInstallerFile(small), /too small/);
    const arm = join(directory, 'arm.exe');
    await writeFile(arm, peFile(0x01c4));
    await assert.rejects(verifyInstallerFile(arm), /machine type 0x1c4/);
    const large = join(directory, 'large.exe');
    await writeFile(large, peFile(0x014c, 21 * 1024 * 1024));
    await verifyInstallerFile(large);
    const text = join(directory, 'text.exe');
    await writeFile(text, 'not an executable, but long enough to read a header from it at all..');
    await assert.rejects(readPeMachine(text), /Not a PE file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Windows package CLI defaults to host architecture and selects an explicit target', () => {
  assert.equal(parseArguments([], 'arm64').target.rid, 'win-arm64');
  assert.equal(parseArguments([], 'x64').target.rid, 'win-x64');
  assert.equal(parseArguments(['--arch', 'x64', '--verify-only'], 'arm64').target.rid, 'win-x64');
  assert.equal(parseArguments(['--verify-only', '--arch', 'arm64'], 'x64').verifyOnly, true);
  assert.throws(() => parseArguments(['--arch'], 'arm64'), /Usage/);
  assert.throws(() => parseArguments(['--arch', '--verify-only'], 'arm64'), /Usage/);
  assert.throws(() => parseArguments(['--arch', 'x64', '--arch', 'arm64'], 'arm64'), /Usage/);
});

test('Windows PE verification rejects the other architecture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-windows-pe-'));
  try {
    const path = join(directory, 'component.exe');
    await writeFile(path, peFile(0x8664));
    await assertPeMachine(path, targetForArch('x64'));
    await assert.rejects(assertPeMachine(path, targetForArch('arm64')), /not Windows ARM64/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
