import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { bootstrapInvocation, cleanEnvironment, installation, invocation, main, runProcess } from '../lib/launcher.mjs';

const launcherUrl = new URL('../lib/launcher.mjs', import.meta.url).href;
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const supportedHelp = 'computer-use preflight --profile NAME\ncomputer-use skill prompt --profile NAME\n';

async function fixture(t, { platform = 'darwin', arch = 'arm64', version = '0.7.0', installed = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'computer-use-npm-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = join(directory, "应用 'quoted' $dollar; App.app");
  const resources = platform === 'darwin' ? join(app, 'Contents', 'Resources') : app;
  const node = join(resources, 'bin', platform === 'darwin' ? 'node' : 'node.exe');
  const cli = join(resources, 'runtime', 'cli.js');
  const host = platform === 'darwin' ? join(app, 'Contents', 'MacOS', 'ComputerUseHost') : join(app, 'ComputerUse.WindowsHost.exe');
  for (const path of [node, cli, host, join(resources, 'runtime', 'host.js')]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'fixture; never executed\n');
  }
  const receipt = {
    owner: platform === 'darwin' ? 'computer-use-package-v1' : `computer-use-windows-${arch}-package-v1`,
    arch: platform === 'darwin' ? arch : `win-${arch}`,
  };
  await writeFile(join(resources, 'build-receipt.json'), JSON.stringify(receipt));
  await writeFile(join(resources, 'package.json'), JSON.stringify({ version }));
  const discovery = {
    platform: `${platform === 'darwin' ? 'macos' : 'windows'}-${arch}`,
    installed,
    ...(platform === 'darwin' ? { app } : { packageRoot: app }),
  };
  return { directory, app, resources, node, cli, host, receipt, discovery };
}

function harness(
  f,
  {
    profile = 'default',
    state = 'valid',
    host = 'ready',
    appHelp = supportedHelp,
    preflight,
    forwardCode = 0,
    bootstrapCode = 0,
    bootstrapStderr = '',
    env,
  } = {},
) {
  const calls = [];
  let stdout = '';
  let stderr = '';
  const status = preflight ?? { profile: { name: profile, state }, host: { state: host } };
  return {
    calls,
    output: () => ({ stdout, stderr }),
    dependencies: {
      platform: f.discovery.platform.startsWith('macos') ? 'darwin' : 'win32',
      env: env ?? { PATH: process.env.PATH, SystemRoot: 'C:\\Windows' },
      stdout: {
        write: chunk => {
          stdout += chunk;
        },
      },
      stderr: {
        write: chunk => {
          stderr += chunk;
        },
      },
      run: async (command, args, options) => {
        calls.push({ command, args, options });
        if (calls.length === 1) return { code: bootstrapCode, stdout: JSON.stringify(f.discovery), stderr: bootstrapStderr };
        assert.equal(command, f.node);
        assert.equal(args[0], f.cli);
        if (!options.capture) return { code: forwardCode, stdout: '', stderr: '' };
        const actual = args.slice(1);
        if (actual.length === 1 && actual[0] === '--help') return { code: 0, stdout: appHelp, stderr: '' };
        if (actual[0] === 'preflight') return { code: 0, stdout: JSON.stringify(status), stderr: '' };
        if (actual[0] === 'skill' && actual[1] === 'prompt') return { code: 0, stdout: `Setup prompt for ${actual[3]}\n`, stderr: '' };
        assert.fail(`Setup attempted an unexpected command: ${JSON.stringify(actual)}`);
      },
    },
  };
}

test('help and launcher version work offline on unsupported platforms without discovery', async () => {
  for (const args of [[], ['--help'], ['-h'], ['help'], ['setup', '--help'], ['--version']]) {
    let stdout = '';
    let stderr = '';
    const code = await main(args, {
      platform: 'linux',
      env: {},
      stdout: {
        write: value => {
          stdout += value;
        },
      },
      stderr: {
        write: value => {
          stderr += value;
        },
      },
      run: () => assert.fail('Offline help/version must not invoke discovery'),
    });
    assert.equal(code, 0);
    assert.equal(stderr, '');
    assert.ok(stdout.includes(manifest.version));
    if (args[0] === '--version') assert.equal(stdout, `${manifest.name} ${manifest.version}\n`);
    else assert.match(stdout, /Only setup may download and install/);
  }
});

test('setup validates profile and arguments before discovering or installing anything', async () => {
  for (const args of [
    ['setup', '--profile', '../other'],
    ['setup', '--profile', 'a'.repeat(65)],
    ['setup', '--unexpected'],
    ['setup', 'extra'],
    ['--app-path'],
  ]) {
    let stderr = '';
    const code = await main(args, {
      stdout: { write: () => assert.fail('Unexpected stdout') },
      stderr: {
        write: value => {
          stderr += value;
        },
      },
      run: () => assert.fail('Invalid input must not run a process'),
    });
    assert.equal(code, 2);
    assert.notEqual(stderr, '');
  }
  assert.equal(invocation(['setup']).profile, 'default');
  assert.equal(invocation(['setup', '--profile', 'Team_2-prod']).profile, 'Team_2-prod');
});

test('normal commands discover only, preserve exact CLI arguments, and propagate the exit code', async t => {
  const f = await fixture(t);
  const h = harness(f, { forwardCode: 17 });
  const args = [
    'pair',
    '--profile',
    'team',
    '--app',
    'com.example.AuthorizedApp',
    '--name',
    'User "quoted"; $(ignored)',
    '--data',
    '{"text":"你好\\n"quoted"; $HOME"}',
  ];
  assert.equal(await main(['--app-path', f.app, ...args], h.dependencies), 17);
  assert.deepEqual(h.calls[0].args.slice(1), ['--discover-only', f.app]);
  assert.deepEqual(h.calls[1].args, [f.cli, ...args]);
  assert.equal(h.calls[1].options.capture, false);
  assert.deepEqual(h.output(), { stdout: '', stderr: '' });
  assert.equal(h.calls.length, 2);
});

test('an absent App during a normal command does not download or forward anything', async () => {
  const h = harness({ discovery: { platform: 'macos-arm64', found: false } });
  assert.equal(await main(['doctor', '--profile', 'default'], h.dependencies), 1);
  assert.deepEqual(h.calls[0].args.slice(1), ['--discover-only']);
  assert.equal(h.calls.length, 1);
  assert.match(h.output().stderr, /not installed.*setup/);
});

test('setup performs only help, preflight and prompt with one consistent selected profile', async t => {
  const f = await fixture(t, { installed: true });
  const h = harness(f, { profile: 'Agent_2', state: 'missing', host: 'offline' });
  assert.equal(await main(['--app-path', f.app, 'setup', '--profile', 'Agent_2'], h.dependencies), 0);
  assert.deepEqual(h.calls[0].args.slice(1), [f.app]);
  assert.equal(h.calls[0].options.timeoutMs, 30 * 60_000);
  assert.deepEqual(
    h.calls.slice(1).map(call => call.args.slice(1)),
    [['--help'], ['preflight', '--profile', 'Agent_2'], ['skill', 'prompt', '--profile', 'Agent_2']],
  );
  assert.ok(h.calls.every(call => call.options.capture));
  assert.equal(h.output().stdout, 'Setup prompt for Agent_2\n');
  assert.match(h.output().stderr, /Profile Agent_2: missing; host: offline/);
});

test('setup JSON whitelists status and does not leak extra preflight fields or credentials', async t => {
  const f = await fixture(t);
  const privateValue = 'sentinel-private-token';
  const h = harness(f, {
    preflight: {
      profile: { name: 'default', state: 'unverified', token: privateValue },
      host: { state: 'offline', secret: privateValue },
      credentials: privateValue,
      extra: privateValue,
    },
  });
  assert.equal(await main(['setup', '--json'], h.dependencies), 0);
  const output = h.output();
  const status = JSON.parse(output.stdout);
  assert.equal(output.stderr, '');
  assert.equal(output.stdout.includes(privateValue), false);
  assert.deepEqual(status.profile, { name: 'default', state: 'unverified' });
  assert.deepEqual(status.host, { state: 'offline' });
  assert.equal(status.upgradeRequired, false);
  assert.deepEqual(
    h.calls.slice(1).map(call => call.args.slice(1)),
    [['--help'], ['preflight', '--profile', 'default']],
  );
});

test('paused, stopped, revoked and system-blocked profiles never pair or recover automatically', async t => {
  const f = await fixture(t);
  for (const [host, state, message] of [
    ['paused', 'valid', /Resume or restart services locally/],
    ['stopped', 'valid', /Resume or restart services locally/],
    ['ready', 'unauthorized', /does not delete credentials or pair again/],
    ['ready', 'invalid', /does not delete credentials or pair again/],
    ['permissions_required', 'unverified', /complete its system permission steps locally/],
  ]) {
    const h = harness(f, { host, state });
    assert.equal(await main(['setup'], h.dependencies), 0);
    assert.match(h.output().stderr, message);
    assert.deepEqual(
      h.calls.slice(1).map(call => call.args.slice(1)),
      [['--help'], ['preflight', '--profile', 'default'], ['skill', 'prompt', '--profile', 'default']],
    );
  }
});

test('a running host preserves missing or unverified authorization without claiming readiness or pairing', async t => {
  const f = await fixture(t);
  for (const state of ['missing', 'unverified', 'unauthorized']) {
    for (const json of [false, true]) {
      const h = harness(f, { state, host: 'running' });
      assert.equal(await main(['setup', ...(json ? ['--json'] : [])], h.dependencies), 0);
      const expected = [['--help'], ['preflight', '--profile', 'default']];
      if (json) {
        const status = JSON.parse(h.output().stdout);
        assert.deepEqual(status.host, { state: 'running' });
        assert.deepEqual(status.profile, { name: 'default', state });
        assert.equal(h.output().stderr, '');
      } else {
        assert.ok(h.output().stderr.includes(`Profile default: ${state}; host: running.`));
        expected.push(['skill', 'prompt', '--profile', 'default']);
      }
      assert.deepEqual(
        h.calls.slice(1).map(call => call.args.slice(1)),
        expected,
      );
      assert.equal(`${h.output().stdout}${h.output().stderr}`.includes('ready'), false);
    }
  }
});

test('v0.6.1 is recognized as installed and reports an upgrade without trying new commands', async t => {
  const f = await fixture(t, { version: '0.6.1' });
  for (const json of [false, true]) {
    const h = harness(f, { appHelp: 'computer-use pair\ncomputer-use doctor\ncomputer-use schema\n' });
    assert.equal(await main(['setup', ...(json ? ['--json'] : [])], h.dependencies), 2);
    assert.equal(h.calls.length, 2);
    if (json) {
      const status = JSON.parse(h.output().stdout);
      assert.equal(status.version, '0.6.1');
      assert.equal(status.upgradeRequired, true);
      assert.equal(status.profile.state, 'unverified');
    } else assert.match(h.output().stderr, /0\.6\.1 is installed.*Upgrade to v0\.7\.0/);
    assert.equal(h.output().stderr.includes('not installed'), false);
  }
  const forwarded = harness(f);
  assert.equal(await main(['doctor'], forwarded.dependencies), 0);
  assert.equal(forwarded.calls[1].options.capture, false);
});

test('unexpected or mismatched preflight responses stop before producing a setup prompt', async t => {
  const f = await fixture(t);
  for (const preflight of [
    { profile: { name: 'other', state: 'valid' }, host: { state: 'ready' } },
    { profile: { name: 'default', state: 'surprise' }, host: { state: 'ready' } },
    { profile: { name: 'default', state: 'valid' }, host: { state: 'surprise' } },
  ]) {
    const h = harness(f, { preflight });
    assert.equal(await main(['setup'], h.dependencies), 1);
    assert.equal(h.calls.length, 3);
    assert.match(h.output().stderr, /unexpected status/);
    assert.equal(h.output().stdout, '');
  }
});

test('unsafe runtime environment injection is removed from bootstrap and bundled runtime calls', async t => {
  const f = await fixture(t);
  const env = {
    PATH: '/safe/bin',
    PROFILE: 'keep',
    NODE_OPTIONS: '--require malicious.cjs',
    node_path: '/evil',
    NODE_REPL_EXTERNAL_MODULE: '/evil',
    ELECTRON_RUN_AS_NODE: '1',
    DYLD_INSERT_LIBRARIES: '/evil.dylib',
    dyld_library_path: '/evil',
    LD_PRELOAD: '/evil.so',
    LD_LIBRARY_PATH: '/evil',
    EMPTY: undefined,
  };
  const expected = { PATH: '/safe/bin', PROFILE: 'keep' };
  assert.deepEqual(cleanEnvironment(env), expected);
  const h = harness(f, { env });
  assert.equal(await main(['doctor'], h.dependencies), 0);
  for (const call of h.calls) assert.deepEqual(call.options.env, expected);
  assert.equal(env.NODE_OPTIONS, '--require malicious.cjs');
});

test('installation derives trusted runtime paths from package root and validates both Windows architectures', async t => {
  for (const platform of ['darwin', 'win32']) {
    for (const arch of platform === 'darwin' ? ['arm64'] : ['arm64', 'x64']) {
      const f = await fixture(t, { platform, arch });
      const result = await installation({ ...f.discovery, node: '/malicious/node', cli: '/malicious/cli', token: 'do-not-use' }, platform);
      assert.equal(result.node, f.node);
      assert.equal(result.cli, f.cli);
      assert.equal(result.app, f.app);
      assert.equal(result.version, '0.7.0');
      assert.equal(Object.hasOwn(result, 'token'), false);
    }
  }
});

test('installation rejects wrong platforms, relative roots, incomplete packages and incompatible receipts', async t => {
  const f = await fixture(t);
  for (const discovery of [
    { ...f.discovery, platform: 'macos-x64' },
    { ...f.discovery, platform: 'windows-arm64' },
    { ...f.discovery, app: 'relative.app' },
    { ...f.discovery, installed: 'false' },
  ])
    await assert.rejects(installation(discovery, 'darwin'), /incomplete or its paths/);
  await rm(f.host);
  await assert.rejects(installation(f.discovery, 'darwin'), /incomplete or its paths/);
  const windows = await fixture(t, { platform: 'win32', arch: 'arm64' });
  await writeFile(
    join(windows.resources, 'build-receipt.json'),
    JSON.stringify({ owner: 'computer-use-windows-x64-package-v1', arch: 'win-x64' }),
  );
  await assert.rejects(installation(windows.discovery, 'win32'), /incomplete or its paths/);
});

test('package metadata must have a valid bounded version document', async t => {
  const f = await fixture(t);
  for (const text of [
    JSON.stringify({ version: 'latest;execute' }),
    '{invalid json',
    JSON.stringify({ version: '0.7.0', padding: 'x'.repeat(65536) }),
  ]) {
    await writeFile(join(f.resources, 'package.json'), text);
    await assert.rejects(installation(f.discovery, 'darwin'), /incomplete or its paths/);
  }
});

test('symlinked runtime files and package roots are rejected', {
  skip: process.platform === 'win32' ? 'Creating symlinks requires Windows developer mode or elevated rights' : false,
}, async t => {
  const f = await fixture(t);
  const linkedRoot = join(f.directory, 'linked.app');
  await symlink(f.app, linkedRoot, 'dir');
  await assert.rejects(installation({ ...f.discovery, app: linkedRoot }, 'darwin'), /incomplete or its paths/);
  const outside = join(f.directory, 'outside-node');
  await writeFile(outside, 'outside');
  await rm(f.node);
  await symlink(outside, f.node);
  await assert.rejects(installation(f.discovery, 'darwin'), /incomplete or its paths/);
});

test('invalid discovery JSON or a failed discovery never executes the bundled CLI', async () => {
  for (const result of [
    { code: 0, stdout: 'not json', stderr: '' },
    { code: 0, stdout: '[]', stderr: '' },
    { code: 0, stdout: 'null', stderr: '' },
    { code: 23, stdout: '', stderr: 'Installation blocked by system policy' },
  ]) {
    let calls = 0;
    let stderr = '';
    const code = await main(['doctor'], {
      platform: 'darwin',
      env: {},
      stdout: { write: () => assert.fail('Unexpected stdout') },
      stderr: {
        write: value => {
          stderr += value;
        },
      },
      run: async () => {
        assert.equal(++calls, 1);
        return result;
      },
    });
    assert.equal(code, result.code || 1);
    assert.notEqual(stderr, '');
  }
});

test('Windows bootstrap uses an absolute system PowerShell and literal encoded paths', () => {
  const app = "C:\\Apps\\用户's App; $(Write-Error injected)\\Computer Use";
  const resources = "C:\\Packages\\O'Brien $env:PATH; (ignored)";
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  for (const install of [false, true]) {
    const bootstrap = bootstrapInvocation('win32', app, install, { systemroot: 'D:\\Windows' }, resources);
    assert.equal(bootstrap.command, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(bootstrap.args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const code = Buffer.from(bootstrap.args.at(-1), 'base64').toString('utf16le');
    assert.ok(code.includes(`ReadAllText(${quote(join(resources, 'bootstrap-windows.ps1'))})`));
    assert.ok(code.endsWith(` -Hint ${quote(app)}`));
    assert.equal(code.includes(' -DiscoverOnly'), !install);
    assert.equal(code.includes('ExecutionPolicy'), false);
  }
  assert.throws(() => bootstrapInvocation('win32', undefined, false, { SystemRoot: 'relative' }), /absolute path/);
  assert.throws(() => bootstrapInvocation('linux', undefined, false, {}), /No Linux or Intel Mac/);
});

test('Windows forwarding selects discovery mode and the package runtime without executing PowerShell in tests', async t => {
  const f = await fixture(t, { platform: 'win32', arch: 'x64' });
  const h = harness(f);
  assert.equal(await main(['mcp', 'stdio', '--profile', 'windows'], h.dependencies), 0);
  const encoded = h.calls[0].args.at(-1);
  assert.match(Buffer.from(encoded, 'base64').toString('utf16le'), / -DiscoverOnly$/);
  assert.deepEqual(h.calls[1].args, [f.cli, 'mcp', 'stdio', '--profile', 'windows']);
  assert.equal(h.calls[1].options.capture, false);
});

test('runProcess captures stdout/stderr, preserves literal arguments, and returns child exit status', async () => {
  const argument = 'literal $(echo injected); "quoted" & %PATH% 中文';
  const result = await runProcess(
    process.execPath,
    ['-e', 'process.stdout.write("\\uFEFF" + process.argv[1]); process.stderr.write("child error"); process.exitCode = 19;', argument],
    { env: cleanEnvironment(process.env), timeoutMs: 10_000 },
  );
  assert.deepEqual(result, { code: 19, stdout: argument, stderr: 'child error' });
});

test('runProcess bounds capture time and output and removes signal listeners on failure', async () => {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const counts = signals.map(signal => process.listenerCount(signal));
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 }), /timed out/);
  assert.deepEqual(
    signals.map(signal => process.listenerCount(signal)),
    counts,
  );
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000)'], {
      timeoutMs: 10_000,
    }),
    /output exceeded/,
  );
  assert.deepEqual(
    signals.map(signal => process.listenerCount(signal)),
    counts,
  );
  await assert.rejects(runProcess(join(tmpdir(), 'computer-use-nonexistent-executable'), [], { timeoutMs: 1000 }), /Cannot run/);
  assert.deepEqual(
    signals.map(signal => process.listenerCount(signal)),
    counts,
  );
});

test('runProcess times out while a real descendant keeps inherited output pipes open', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-pipe-timeout-'));
  const ready = join(directory, 'descendant-ready.json');
  const stop = join(directory, 'stop-descendant');
  const exited = join(directory, 'descendant-exited');
  const readIfPresent = async path => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const waitForFile = async (path, timeoutMs) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const text = await readIfPresent(path);
      if (text !== undefined) return text;
      await delay(25);
    }
    throw new Error(`Fixture did not produce ${path}`);
  };
  t.after(async () => {
    // Only this fixture knows the stop path. Its descendant also has a hard
    // lifetime limit so a test-runner crash cannot leave a persistent process.
    await writeFile(stop, 'stop');
    await waitForFile(exited, 10_000);
    await rm(directory, { recursive: true, force: true });
  });
  const descendant = `
    const fs = require('node:fs');
    const [ready, stop, exited] = process.argv.slice(1);
    process.on('exit', () => fs.writeFileSync(exited, String(process.pid)));
    fs.writeFileSync(ready, JSON.stringify({ pid: process.pid }));
    setInterval(() => { if (fs.existsSync(stop)) process.exit(0); }, 25);
    setTimeout(() => process.exit(0), 20_000);
  `;
  const directChild = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, ...process.argv.slice(1)], {
      detached: true, windowsHide: true, shell: false, stdio: 'inherit'
    });
    child.unref();
  `;
  const began = performance.now();
  const result = runProcess(process.execPath, ['-e', directChild, ready, stop, exited], {
    env: cleanEnvironment(process.env),
    timeoutMs: 3000,
  }).then(
    value => ({ value }),
    error => ({ error }),
  );
  const { pid } = JSON.parse(await waitForFile(ready, 5000));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  let deadline;
  try {
    const outcome = await Promise.race([
      result,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Inherited pipes defeated the process timeout')), 8000);
      }),
    ]);
    assert.match(outcome.error?.message ?? '', /timed out/);
    assert.ok(performance.now() - began < 8000, 'Timeout must remain bounded while descendant pipes stay open');
    assert.equal(await readIfPresent(exited), undefined, 'Descendant should still be alive when runProcess rejects');
    process.kill(pid, 0);
  } finally {
    clearTimeout(deadline);
  }
});

test('runProcess forwarding inherits input/output without protocol banners and returns the real exit code', async () => {
  const childCode =
    'let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", value => input += value); process.stdin.on("end", () => { process.stdout.write(input); process.stderr.write("forwarded stderr"); process.exitCode = 21; });';
  const wrapper = `import { runProcess } from ${JSON.stringify(launcherUrl)}; const result = await runProcess(process.execPath, ['-e', ${JSON.stringify(childCode)}], { capture: false }); process.exitCode = result.code;`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', wrapper], {
      env: cleanEnvironment(process.env),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Forwarding fixture timed out'));
    }, 10_000);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => {
      stdout += value;
    });
    child.stderr.on('data', value => {
      stderr += value;
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  });
  assert.deepEqual(result, { code: 21, stdout: '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n', stderr: 'forwarded stderr' });
});
