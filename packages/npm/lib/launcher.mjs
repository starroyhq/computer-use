import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
const MAX_OUTPUT = 1024 * 1024;
const PROFILE = /^[a-zA-Z0-9_-]{1,64}$/;
const STATES = new Set(['missing', 'invalid', 'unverified', 'valid', 'unauthorized']);
const HOST_STATES = new Set([
  'offline',
  'starting',
  'running',
  'ready',
  'paused',
  'stopped',
  'failed',
  'permissions_required',
  'unavailable',
]);

const help = `Computer Use npm launcher ${manifest.version}

Usage: computer-use [--app-path PATH] <command> [options]

  setup [--profile NAME] [--json]  Find/install the official App and report setup
  preflight [--profile NAME]      Read App, host and selected profile status
  skill prompt [--profile NAME]  Print instructions for your Agent
  pair --profile NAME --name NAME Request pairing; approve locally in the App
  doctor [--profile NAME]         Check the connected desktop service
  targets [--profile NAME]        List authorized windows
  mcp stdio [--profile NAME]      Forward stdio directly to the bundled MCP server
  config codex [--profile NAME]   Generate configuration using the App's runtime
  instructions                   Read the installed App's current guide
  --help                         Show this launcher help without finding the App
  --version                      Show the npm launcher version (not App version)

All commands except setup/help/version are passed unchanged to the App CLI.
Only setup may download and install. It does not pair, grant permissions, start
services, clear pause/stop, or change your Agent's configuration. Without --json,
setup prints the App's setup prompt for your Agent; --json reports local status.
Use --app-path before the command to select a nonstandard installation.
Supports macOS Apple Silicon and Windows ARM64/x64. Node 22+ runs this launcher;
the App uses its bundled runtime. No install/postinstall scripts are run.
`;

class LauncherError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

export function cleanEnvironment(environment) {
  // The selected App must use its bundled runtime without npm/Agent injection.
  const blocked = /^(NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|ELECTRON_RUN_AS_NODE|DYLD_.*|LD_PRELOAD|LD_LIBRARY_PATH)$/i;
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => value !== undefined && !blocked.test(key)));
}

export function invocation(args) {
  let app;
  let offset = 0;
  if (args[0] === '--app-path' || args[0]?.startsWith('--app-path=')) {
    app = args[0] === '--app-path' ? args[1] : args[0].slice('--app-path='.length);
    offset = args[0] === '--app-path' ? 2 : 1;
    if (!app || app.includes('\0')) throw new LauncherError('--app-path requires an App or package path.', 2);
    app = resolve(app);
  }
  const forwarded = args.slice(offset);
  if (forwarded.length === 0 || (forwarded.length === 1 && ['--help', '-h', 'help'].includes(forwarded[0]))) return { command: 'help' };
  if (forwarded.length === 1 && forwarded[0] === '--version') return { command: 'version' };
  if (forwarded[0] !== 'setup') return { command: 'forward', app, args: forwarded };
  let parsed;
  try {
    parsed = parseArgs({
      args: forwarded.slice(1),
      strict: true,
      allowPositionals: false,
      options: { profile: { type: 'string', default: 'default' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch {
    throw new LauncherError('Use setup [--profile NAME] [--json], with --app-path PATH before setup.', 2);
  }
  if (parsed.values.help) return { command: 'help' };
  if (!PROFILE.test(parsed.values.profile)) throw new LauncherError('Profile must be 1–64 letters, digits, underscores or hyphens.', 2);
  return { command: 'setup', app, profile: parsed.values.profile, json: parsed.values.json === true };
}

/** Captured commands are bounded; forwarded stdio has no wrapper output or buffering. */
export function runProcess(command, args, { env, capture = true, timeoutMs = 30_000 } = {}) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, { env, shell: false, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let failure;
    let timer;
    let forceTimer;
    let settled = false;
    const handlers = new Map();
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      if (error) reject(error);
      else resolveProcess(result);
    };
    const stop = (error, signal = 'SIGTERM') => {
      if (failure) return;
      failure = error;
      child.kill(signal);
      forceTimer = setTimeout(() => {
        child.kill('SIGKILL');
        // A descendant may retain inherited output handles after the direct child
        // exits. Do not let those handles defeat our timeout or interruption.
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(failure);
      }, 2000);
      forceTimer.unref();
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => {
        stop(new LauncherError(`Interrupted by ${signal}.`, signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143), signal);
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      const append = (name, chunk) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT) return stop(new LauncherError('Child output exceeded the size limit.'));
        if (name === 'stdout') stdout += chunk;
        else stderr += chunk;
      };
      child.stdout.on('data', chunk => append('stdout', chunk));
      child.stderr.on('data', chunk => append('stderr', chunk));
      timer = setTimeout(
        () => stop(new LauncherError('The operation timed out. Check the App or installer before trying again.')),
        timeoutMs,
      );
      timer.unref();
    }
    child.once('error', error => {
      finish(new LauncherError(`Cannot run ${command} (${error.code ?? 'unknown error'}). Check installation and system policy.`));
    });
    child.once('close', (code, signal) => {
      finish(failure, {
        code: code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143),
        stdout: stdout.replace(/^\uFEFF/, ''),
        stderr,
      });
    });
  });
}

const psQuote = value => `'${value.replaceAll("'", "''")}'`;

export function bootstrapInvocation(platform, app, install, environment, resources = join(packageDirectory, 'resources')) {
  if (platform === 'darwin') {
    return {
      command: '/bin/bash',
      args: [join(resources, 'bootstrap-macos.sh'), ...(install ? [] : ['--discover-only']), ...(app ? [app] : [])],
    };
  }
  if (platform === 'win32') {
    const systemRoot = Object.entries(environment).find(([key]) => key.toLowerCase() === 'systemroot')?.[1] ?? 'C:\\Windows';
    if (!win32.isAbsolute(systemRoot)) throw new LauncherError('Windows SystemRoot must be an absolute path.');
    const script = join(resources, 'bootstrap-windows.ps1');
    // Pass literal paths as data, never shell fragments; no ExecutionPolicy override.
    const code = `[Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; & ([ScriptBlock]::Create([IO.File]::ReadAllText(${psQuote(script)})))${install ? '' : ' -DiscoverOnly'}${app ? ` -Hint ${psQuote(app)}` : ''}`;
    return {
      command: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
    };
  }
  throw new LauncherError('Computer Use supports macOS Apple Silicon and Windows ARM64/x64. No Linux or Intel Mac App is available.');
}

function parseJson(output, label) {
  try {
    const parsed = JSON.parse(output);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Expected object');
    return parsed;
  } catch {
    throw new LauncherError(`${label} returned invalid JSON. Repair the installation; no command was forwarded.`);
  }
}

async function regularFile(path, root) {
  if (!(await lstat(path)).isFile()) throw new Error('Not a regular file');
  const actual = await realpath(path);
  if (actual !== path || (!actual.startsWith(`${root}/`) && !actual.startsWith(`${root}\\`))) throw new Error('Path escapes package');
}

/** Revalidate the selected package before executing it, using no paths supplied by its JSON except the root. */
export async function installation(result, platform) {
  try {
    const expected = platform === 'darwin' ? ['macos-arm64'] : ['windows-arm64', 'windows-x64'];
    if (!expected.includes(result.platform)) throw new Error('Unexpected platform');
    if (result.found === false) return undefined;
    const input = platform === 'darwin' ? result.app : result.packageRoot;
    if (typeof input !== 'string' || !isAbsolute(input) || typeof result.installed !== 'boolean') throw new Error('Invalid package result');
    if (!(await lstat(input)).isDirectory()) throw new Error('Not a package directory');
    const root = await realpath(input);
    const resources = platform === 'darwin' ? join(root, 'Contents', 'Resources') : root;
    const node = join(resources, 'bin', platform === 'darwin' ? 'node' : 'node.exe');
    const cli = join(resources, 'runtime', 'cli.js');
    const host = platform === 'darwin' ? join(root, 'Contents', 'MacOS', 'ComputerUseHost') : join(root, 'ComputerUse.WindowsHost.exe');
    for (const file of [
      node,
      cli,
      host,
      join(resources, 'runtime', 'host.js'),
      join(resources, 'build-receipt.json'),
      join(resources, 'package.json'),
    ])
      await regularFile(file, root);
    const receiptPath = join(resources, 'build-receipt.json');
    const manifestPath = join(resources, 'package.json');
    if ((await lstat(receiptPath)).size > 65536 || (await lstat(manifestPath)).size > 65536) throw new Error('Oversized package metadata');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    const arch = result.platform.slice(result.platform.indexOf('-') + 1);
    const owner = platform === 'darwin' ? 'computer-use-package-v1' : `computer-use-windows-${arch}-package-v1`;
    if (receipt.owner !== owner || receipt.arch !== (platform === 'darwin' ? arch : `win-${arch}`)) throw new Error('Invalid receipt');
    const appManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (typeof appManifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(appManifest.version))
      throw new Error('Invalid version');
    return { platform: result.platform, app: root, node, cli, version: appManifest.version, installed: result.installed };
  } catch {
    throw new LauncherError(
      'The discovered App is incomplete or its paths do not match its package. Repair it or select the intended App with --app-path.',
    );
  }
}

async function captureCli(app, args, run, env) {
  const result = await run(app.node, [app.cli, ...args], { env, capture: true, timeoutMs: 30_000 });
  if (result.code !== 0)
    throw new LauncherError(
      `App CLI failed (${result.code}). ${result.stderr.trim() || 'Open the App to inspect its state.'}`,
      result.code,
    );
  return result.stdout;
}

export async function main(args, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const environment = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const run = dependencies.run ?? runProcess;
  try {
    const request = invocation(args);
    if (request.command === 'help') {
      stdout.write(help);
      return 0;
    }
    if (request.command === 'version') {
      stdout.write(`${manifest.name} ${manifest.version}\n`);
      return 0;
    }
    const env = cleanEnvironment(environment);
    const bootstrap = bootstrapInvocation(platform, request.app, request.command === 'setup', env);
    const result = await run(bootstrap.command, bootstrap.args, {
      env,
      capture: true,
      timeoutMs: request.command === 'setup' ? 30 * 60_000 : 45_000,
    });
    if (result.code !== 0)
      throw new LauncherError(result.stderr.trim() || 'App discovery failed. Check the installation and system policy.', result.code);
    const app = await installation(parseJson(result.stdout, 'App discovery'), platform);
    if (!app)
      throw new LauncherError(
        'Computer Use is not installed. Run computer-use setup to install the official App, or use --app-path PATH for an existing installation.',
      );
    if (request.command === 'forward') {
      return (await run(app.node, [app.cli, ...request.args], { env, capture: false })).code;
    }
    // Setup only calls read-only commands. Pairing and service startup stay explicit.
    const appHelp = await captureCli(app, ['--help'], run, env);
    if (!appHelp.includes('computer-use preflight') || !appHelp.includes('computer-use skill prompt')) {
      const status = {
        launcherVersion: manifest.version,
        ...app,
        profile: { name: request.profile, state: 'unverified' },
        host: { state: 'unavailable' },
        upgradeRequired: true,
      };
      if (request.json) stdout.write(`${JSON.stringify(status)}\n`);
      else
        stderr.write(
          `Computer Use ${app.version} is installed at ${app.app}. Upgrade to v0.7.0 or newer for setup prompts and preflight. Existing pair/doctor/schema commands remain available. No credentials or permissions were changed.\n`,
        );
      return 2;
    }
    const preflight = parseJson(await captureCli(app, ['preflight', '--profile', request.profile], run, env), 'App preflight');
    if (preflight.profile?.name !== request.profile || !STATES.has(preflight.profile?.state) || !HOST_STATES.has(preflight.host?.state))
      throw new LauncherError('App preflight returned an unexpected status. Inspect the App; no pairing or recovery was attempted.');
    const status = {
      launcherVersion: manifest.version,
      ...app,
      profile: { name: request.profile, state: preflight.profile.state },
      host: { state: preflight.host.state },
      upgradeRequired: false,
    };
    if (request.json) stdout.write(`${JSON.stringify(status)}\n`);
    else {
      stderr.write(
        `Computer Use ${app.version}: ${app.installed ? 'installed' : 'found'} at ${app.app}\nProfile ${request.profile}: ${status.profile.state}; host: ${status.host.state}.\n`,
      );
      if (['paused', 'stopped'].includes(status.host.state))
        stderr.write('Resume or restart services locally in the App before using desktop commands.\n');
      if (status.host.state === 'permissions_required') stderr.write('Open the App and complete its system permission steps locally.\n');
      if (['invalid', 'unauthorized'].includes(status.profile.state))
        stderr.write('Review this profile in the App. Setup does not delete credentials or pair again.\n');
      stdout.write(await captureCli(app, ['skill', 'prompt', '--profile', request.profile], run, env));
    }
    return 0;
  } catch (error) {
    stderr.write(
      `Computer Use: ${error instanceof LauncherError ? error.message : 'Unexpected launcher failure. Check the App installation.'}\n`,
    );
    return error instanceof LauncherError ? error.code : 1;
  }
}
