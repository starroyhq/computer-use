import { spawnSync } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ROOT } from './fetch-runtime.mjs';
import { signingIdentity, verify as verifyApp } from './package-app.mjs';

// 首次安装用的磁盘映像：打开后把 App 拖进“应用程序”。一键更新仍使用 ZIP。
export const APP = join(ROOT, 'artifacts', 'Computer Use.app');
export const DMG = join(ROOT, 'artifacts', 'Computer Use.dmg');
const APP_NAME = 'Computer Use.app';
const VOLUME_NAME = 'Computer Use';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout: 600_000, maxBuffer: 20 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} failed (${result.status}):\n${result.stderr || result.stdout || ''}`);
  return { stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

// hdiutil 在 CI 上偶尔因“资源忙”失败，有限次重试。
async function hdiutil(args) {
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync('/usr/bin/hdiutil', args, { encoding: 'utf8', timeout: 600_000 });
    if (!result.error && result.status === 0) return (result.stdout ?? '').trim();
    if (attempt >= 3) {
      throw new Error(`hdiutil ${args[0]} failed (${result.status}):\n${result.stderr || result.stdout || result.error?.message || ''}`);
    }
    await delay(2_000 * attempt);
  }
}

export function parseArguments(args) {
  if (args.length === 0) return { verifyOnly: false };
  if (args.length === 1 && args[0] === '--verify-only') return { verifyOnly: true };
  if (args.length === 2 && args[0] === '--identity' && args[1].startsWith('Developer ID Application:'))
    return { verifyOnly: false, identity: args[1] };
  throw new Error('Usage: node scripts/package-dmg.mjs [--verify-only | --identity "Developer ID Application: …"]');
}

/**
 * 用已签名的 App 生成压缩磁盘映像，内含 App 与指向 /Applications 的快捷方式。
 * identity 为 Developer ID 时同时签名映像；"-" 表示开发版本，映像不签名。
 */
export async function createDmg({ app = APP, output = DMG, identity = '-' } = {}) {
  if (process.platform !== 'darwin') throw new Error('Building the disk image requires macOS.');
  if (identity !== '-' && !identity.startsWith('Developer ID Application:'))
    throw new Error('Use the complete Developer ID Application identity, or "-" for an unsigned development image.');
  await access(join(app, 'Contents', 'Info.plist'));
  await mkdir(join(ROOT, '.cache'), { recursive: true });
  const stage = await mkdtemp(join(ROOT, '.cache', 'package-dmg-'));
  try {
    const content = join(stage, 'content');
    await mkdir(content);
    // ditto 保留签名、装订的公证票据、符号链接与扩展属性。
    run('/usr/bin/ditto', [app, join(content, APP_NAME)]);
    await symlink('/Applications', join(content, 'Applications'));
    const image = join(stage, 'image.dmg');
    await hdiutil([
      'create',
      '-volname',
      VOLUME_NAME,
      '-srcfolder',
      content,
      '-fs',
      'HFS+',
      '-format',
      'UDZO',
      '-imagekey',
      'zlib-level=9',
      '-ov',
      '-quiet',
      image,
    ]);
    if (identity !== '-') {
      run('/usr/bin/codesign', ['--force', '--sign', identity, '--timestamp', image]);
      run('/usr/bin/codesign', ['--verify', '--strict', image]);
    }
    await mkdir(dirname(output), { recursive: true });
    await rm(output, { force: true });
    await rename(image, output);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  console.log(`Created ${output}${identity === '-' ? ' (unsigned development image)' : ''}.`);
  return output;
}

async function detach(mountpoint) {
  try {
    await hdiutil(['detach', mountpoint, '-quiet']);
  } catch {
    await hdiutil(['detach', mountpoint, '-force', '-quiet']);
  }
}

/**
 * 校验映像本身与其中的 App：只读挂载，内容必须恰好是 App 与 /Applications 快捷方式，App 通过打包校验。
 * identity / team 给出时核对映像的签名者；notarized 时还要求 App 与映像都装订了公证票据并通过 Gatekeeper。
 */
export async function verifyDmg(dmg = DMG, { notarized = false, identity, team } = {}) {
  if (process.platform !== 'darwin') throw new Error('Verifying the disk image requires macOS.');
  await hdiutil(['verify', '-quiet', dmg]);
  const mountpoint = await mkdtemp(join(tmpdir(), 'computer-use-dmg-'));
  await hdiutil(['attach', dmg, '-readonly', '-nobrowse', '-noautoopen', '-noverify', '-mountpoint', mountpoint, '-quiet']);
  try {
    const entries = (await readdir(mountpoint)).filter(name => !name.startsWith('.')).sort();
    if (JSON.stringify(entries) !== JSON.stringify(['Applications', APP_NAME]))
      throw new Error(`Unexpected disk image contents: ${entries.join(', ')}`);
    const shortcut = join(mountpoint, 'Applications');
    if (!(await lstat(shortcut)).isSymbolicLink() || (await readlink(shortcut)) !== '/Applications')
      throw new Error('The disk image Applications shortcut must point to /Applications.');
    const app = join(mountpoint, APP_NAME);
    await verifyApp(app);
    if (notarized) {
      run('/usr/bin/xcrun', ['stapler', 'validate', app]);
      run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
    }
  } finally {
    await detach(mountpoint);
    await rm(mountpoint, { recursive: true, force: true });
  }
  if (identity || team || notarized) {
    run('/usr/bin/codesign', ['--verify', '--strict', dmg]);
    const details = run('/usr/bin/codesign', ['--display', '--verbose=4', dmg]).stderr.split('\n');
    if (identity && !details.includes(`Authority=${identity}`)) throw new Error('The disk image is not signed by the expected identity.');
    if (team && !details.includes(`TeamIdentifier=${team}`)) throw new Error('The disk image is not signed by the expected team.');
  }
  if (notarized) {
    run('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
    run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg]);
  }
  console.log(
    `Verified disk image ${basename(dmg)}: contents, mounted app${identity || team || notarized ? ', image signature' : ''}` +
      `${notarized ? ', stapled tickets and Gatekeeper' : ''}.`,
  );
}

async function main() {
  const { verifyOnly, identity: explicit } = parseArguments(process.argv.slice(2));
  if (verifyOnly) {
    await verifyDmg(DMG);
    return;
  }
  // 与 App 打包相同：命令行身份优先，其次是被 git 忽略的 .env.local，否则为开发版本。
  const identity = explicit ?? (await signingIdentity([]));
  await createDmg({ identity });
  await verifyDmg(DMG, identity === '-' ? {} : { identity });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
