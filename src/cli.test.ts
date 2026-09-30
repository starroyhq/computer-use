import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserBackend } from './backends/browser.js';
import { Runtime } from './runtime.js';
import { listenIpc } from './ipc.js';
import type { Target } from './contracts.js';

type CliResult = { code: number | null; stdout: string; stderr: string };
type Observation = {
  snapshotId: string;
  target: Target;
  screenshot: { path: string; mimeType: string };
  elements: Array<{ id: string; label: string }>;
};
let directory: string;
let socketPath: string;
let runtime: Runtime;
let listener: Awaited<ReturnType<typeof listenIpc>>;
let fixture: Server;
let fixtureUrl: string;
const entrypoint = resolve('dist/cli.js');

beforeEach(async () => {
  // Short private paths work with the macOS AF_UNIX socket limit.
  directory = await mkdtemp('/tmp/cu-cli-');
  socketPath = join(directory, 'runtime.sock');
  runtime = new Runtime({
    dataDir: join(directory, 'runtime'),
    backends: [new BrowserBackend(join(directory, 'browser'))],
    emit: event => {
      // Automatic approval is confined to this test runtime and browser-only grants.
      if (event.event === 'pair_request')
        void runtime.control({
          command: event.browser && event.appIds.length === 0 ? 'pair_allow' : 'pair_deny',
          clientId: event.clientId,
        });
    },
  });
  await runtime.start();
  listener = await listenIpc(socketPath, runtime);
  fixture = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><title>CLI Fixture</title><label>姓名<input id="name"></label><button onclick="document.title=\'Saved \'+document.querySelector(\'#name\').value">Save</button>',
    );
  });
  await new Promise<void>(resolveServer => fixture.listen(0, '127.0.0.1', resolveServer));
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  fixtureUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await listener?.close();
  await runtime?.close();
  await new Promise<void>(resolveServer => fixture.close(() => resolveServer()));
  await rm(directory, { recursive: true, force: true });
});

function cli(args: string[]): Promise<CliResult> {
  return new Promise((resolveResult, reject) => {
    // HOME is overridden only inside the isolated child; user profiles are never read or written.
    const child = spawn(process.execPath, [entrypoint, ...args, '--socket', socketPath], {
      env: { ...process.env, HOME: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CLI test subprocess timed out.'));
    }, 10_000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolveResult({ code, stdout, stderr });
    });
  });
}
async function command<T>(args: string[]): Promise<T> {
  const result = await cli(args);
  // Do not include command output in exceptions: config regressions could expose credentials.
  if (result.code !== 0) throw new Error(`CLI command failed with exit code ${result.code}.`);
  return JSON.parse(result.stdout) as T;
}
const call = <T>(method: string, params: unknown = {}) => command<T>([method, '--json', JSON.stringify(params)]);
async function pair(profile = 'default') {
  const result = await cli(['pair', '--name', 'CLI integration test', '--browser', '--profile', profile]);
  expect(result.code).toBe(0);
  const path = join(directory, '.config', 'computer-use', `${profile}.json`);
  const credential = JSON.parse(await readFile(path, 'utf8')) as { clientId: string; token: string };
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(result.stdout.includes(credential.token)).toBe(false);
  expect(result.stderr.includes(credential.token)).toBe(false);
  expect(JSON.parse(result.stdout)).toMatchObject({ clientId: credential.clientId, paired: true });
  return credential;
}

describe.skipIf(process.platform === 'win32')('real CLI, IPC, runtime and browser workflow', () => {
  it('pairs privately, materializes screenshots, enters Chinese text, verifies a save and closes the session', async context => {
    if (!(await new BrowserBackend(directory).doctor()).available) context.skip();
    const credential = await pair();
    const targets = await call<Target[]>('targets');
    expect(targets).toHaveLength(1);
    const { sessionId } = await call<{ sessionId: string }>('session_open', { targetId: targets[0]!.id });
    const session = { sessionId };
    const screenshots = join(directory, '.config', 'computer-use', 'screenshots');
    await mkdir(screenshots, { recursive: true, mode: 0o700 });
    const stale = join(screenshots, `${randomUUID()}.png`),
      fresh = join(screenshots, `${randomUUID()}.png`),
      unrelated = join(screenshots, 'notes.png');
    for (const file of [stale, fresh, unrelated]) await writeFile(file, 'x');
    const old = new Date(Date.now() - 25 * 60 * 60_000);
    for (const file of [stale, unrelated]) await utimes(file, old, old);
    let observation = await call<Observation>('observe', session);
    expect(
      await Promise.all(
        [stale, fresh, unrelated].map(file =>
          stat(file).then(
            () => true,
            () => false,
          ),
        ),
      ),
    ).toEqual([false, true, true]);
    expect(isAbsolute(observation.screenshot.path)).toBe(true);
    expect(observation.screenshot.path.startsWith(join(directory, '.config', 'computer-use', 'screenshots'))).toBe(true);
    expect((await stat(observation.screenshot.path)).mode & 0o777).toBe(0o600);
    const png = await readFile(observation.screenshot.path);
    expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
    const navigation = await call<{ requestId: string; state: string }>('act', {
      ...session,
      snapshotId: observation.snapshotId,
      action: { type: 'navigate', url: fixtureUrl },
    });
    expect(navigation.state).toBe('executed');
    expect(navigation.requestId).toMatch(/^[a-f0-9-]{36}$/);
    observation = await call<Observation>('observe', session);
    const name = observation.elements.find(element => element.label === '姓名');
    expect(name).toBeDefined();
    const typed = await call<{ state: string }>('act', {
      ...session,
      snapshotId: observation.snapshotId,
      action: { type: 'type', elementId: name!.id, text: '中文端到端' },
    });
    expect(typed.state).toBe('executed');
    observation = await call<Observation>('observe', session);
    const save = observation.elements.find(element => element.label === 'Save')!;
    const saved = await call<{ requestId: string; state: string }>('act', {
      ...session,
      snapshotId: observation.snapshotId,
      action: { type: 'click', elementId: save.id },
      verify: { type: 'title', includes: 'Saved 中文端到端' },
    });
    expect(saved.state).toBe('verified');
    const waited = await call<{ state: string; observation: Observation }>('wait', {
      ...session,
      condition: { type: 'title', includes: 'Saved 中文端到端' },
      timeoutMs: 2000,
    });
    expect(waited.state).toBe('verified');
    expect(waited.observation.target.title).toBe('Saved 中文端到端');
    expect(runtime.actions.records.get(saved.requestId)?.state).toBe('verified');
    expect((await call<{ state: string }>('action_status', { requestId: saved.requestId })).state).toBe('verified');
    expect(await call('session_close', session)).toEqual({ closed: true });
    const closed = await cli(['observe', '--json', JSON.stringify(session)]);
    expect(closed.code).toBe(1);
    expect(JSON.parse(closed.stderr).error.code).toBe('not_found');
    const journal = await readFile(join(directory, 'runtime', 'actions.json'), 'utf8');
    expect(journal.includes('中文端到端')).toBe(false);
    expect(journal.includes(credential.token)).toBe(false);
  }, 30_000);

  it('generates usable stdio configuration and writes HTTP credentials only to a new mode-0600 file', async () => {
    const credential = await pair();
    const stdio = await cli(['config', 'stdio']);
    expect(stdio.code).toBe(0);
    expect(stdio.stdout.includes(credential.token)).toBe(false);
    const settings = JSON.parse(stdio.stdout).mcpServers['computer-use'];
    expect(settings.command).toBe(process.execPath);
    expect(settings.args).toEqual([entrypoint, 'mcp', 'stdio', '--profile', 'default', '--socket', socketPath]);
    const probeCredential = await pair('probe');
    const codex = await cli(['config', 'codex', '--profile', 'probe']);
    expect(codex.code).toBe(0);
    expect(codex.stdout).toBe(
      `[mcp_servers.computer-use]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${[entrypoint, 'mcp', 'stdio', '--profile', 'probe', '--socket', socketPath].map(JSON.stringify).join(', ')}]\n`,
    );
    expect(codex.stdout.includes(credential.token)).toBe(false);
    expect(codex.stdout.includes(probeCredential.token)).toBe(false);
    expect(codex.stderr.includes(credential.token)).toBe(false);
    expect(codex.stderr.includes(probeCredential.token)).toBe(false);
    const configPath = join(directory, 'http-config.json');
    const generated = await cli(['config', 'http', '--out', configPath]);
    expect(generated.code).toBe(0);
    expect(generated.stdout.includes(credential.token)).toBe(false);
    expect(generated.stderr.includes(credential.token)).toBe(false);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    const original = await readFile(configPath, 'utf8');
    const http = JSON.parse(original).mcpServers['computer-use'];
    expect(http.url).toBe('http://127.0.0.1:47631/mcp');
    expect(http.headers.Authorization === `Bearer ${credential.token}`).toBe(true);
    const repeated = await cli(['config', 'http', '--out', configPath]);
    expect(repeated.code).toBe(1);
    expect(repeated.stdout.includes(credential.token)).toBe(false);
    expect(repeated.stderr.includes(credential.token)).toBe(false);
    expect((await readFile(configPath, 'utf8')) === original).toBe(true);
  }, 30_000);

  it('reports unknown options as a JSON error and shows the package version in help', async () => {
    const unknown = await cli(['doctor', '--sessionId', 'x']);
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.stderr)).toEqual({ error: { code: 'invalid_request', message: expect.stringContaining('--sessionId') } });
    const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout.startsWith(`Computer Use ${version} `)).toBe(true);
  });
});
