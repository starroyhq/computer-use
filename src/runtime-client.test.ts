import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CuError } from './contracts.js';
import { listenHttp } from './mcp.js';
import {
  bundledWindowsHost,
  bundledMacHost,
  createRuntimeClient,
  ensureWindowsHost,
  ensureMacHost,
  probeRuntimePipe,
  type RuntimeClientOptions,
} from './runtime-client.js';

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

let directory: string;
let bundle: string;
let options: RuntimeClientOptions;
let cleanup: Array<() => Promise<void>>;

beforeEach(async () => {
  vi.mocked(childProcess.spawn).mockReset();
  directory = await realpath(await mkdtemp(join(tmpdir(), 'cu-start-')));
  bundle = join(directory, "Computer Use '& $ ` 安装包");
  await mkdir(join(bundle, 'runtime'), { recursive: true });
  await mkdir(join(bundle, 'bin'));
  for (const file of ['ComputerUse.WindowsHost.exe', 'runtime/cli.js', 'runtime/runtime-client.js', 'bin/node.exe']) {
    await writeFile(join(bundle, file), 'isolated fixture');
  }
  await writeFile(
    join(bundle, 'build-receipt.json'),
    JSON.stringify({ owner: 'computer-use-windows-arm64-package-v1', arch: 'win-arm64' }),
  );
  options = {
    platform: 'win32',
    modulePath: join(bundle, 'runtime', 'runtime-client.js'),
    entrypoint: join(bundle, 'runtime', 'cli.js'),
    executable: join(bundle, 'bin', 'node.exe'),
    readyTimeoutMs: 500,
    retryMs: 5,
  };
  cleanup = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.reverse()) await close();
  await rm(directory, { recursive: true, force: true });
});

type Request = { id: string; token?: string; method: string; params: unknown };
async function pipeServer(
  reply: (request: Request, socket: Socket) => void = (request, socket) => {
    socket.end(JSON.stringify({ id: request.id, result: { method: request.method } }) + '\n');
  },
) {
  const id = randomUUID();
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\cu-start-test-${id}` : `/tmp/cu-start-${id}.sock`;
  const requests: Request[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let input = '';
    socket.on('data', chunk => {
      input += chunk.toString();
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.trim()) as Request;
      requests.push(request);
      reply(request, socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  });
  return { path, requests };
}

const noDiscovery = () => Promise.reject(new CuError('unavailable', 'No pipe yet.'));

describe('lazy Windows runtime connection', () => {
  it('shares a cold start across concurrent first calls and sends each request exactly once', async () => {
    let active: Awaited<ReturnType<typeof pipeServer>> | undefined;
    const launch = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
      active = await pipeServer();
    });
    const service = createRuntimeClient(undefined, {
      ...options,
      defaultPath: () => (active ? Promise.resolve(active.path) : noDiscovery()),
      launch,
    });
    expect(launch).not.toHaveBeenCalled();
    const replies = await Promise.all([service.call('fixture-token', 'doctor', {}), service.call('fixture-token', 'targets', {})]);
    expect(replies).toEqual([{ method: 'doctor' }, { method: 'targets' }]);
    expect(launch).toHaveBeenCalledExactlyOnceWith(join(bundle, 'ComputerUse.WindowsHost.exe'), 40_000);
    expect(active?.requests.map(request => request.method).sort()).toEqual(['doctor', 'targets']);
  });

  it('waits for delayed discovery after the helper exits and rereads a replacement pipe', async () => {
    const first = await pipeServer();
    const second = await pipeServer();
    let path = `/tmp/missing-${randomUUID()}`;
    let reads = 0;
    const launch = vi.fn(async () => {});
    const service = createRuntimeClient(undefined, {
      ...options,
      defaultPath: async () => (++reads >= 4 ? path : `/tmp/missing-${randomUUID()}`),
      probe: async (value, timeout) => (value.startsWith('/tmp/missing-') ? false : probeRuntimePipe(value, timeout)),
      launch: async (...args) => {
        await launch(...args);
        path = first.path;
      },
    });
    await service.call('fixture-token', 'doctor', {});
    path = second.path;
    await service.call('fixture-token', 'targets', {});
    expect(launch).toHaveBeenCalledTimes(1);
    expect(first.requests.map(request => request.method)).toEqual(['doctor']);
    expect(second.requests.map(request => request.method)).toEqual(['targets']);
  });

  it('connects to an existing runtime without requiring a package or spawning a helper', async () => {
    const server = await pipeServer();
    const launch = vi.fn();
    const service = createRuntimeClient(undefined, {
      ...options,
      modulePath: join(directory, 'src', 'runtime-client.ts'),
      defaultPath: async () => server.path,
      launch,
    });
    await expect(service.call('fixture-token', 'doctor', {})).resolves.toEqual({ method: 'doctor' });
    expect(launch).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(1);
  });

  it('bounds readiness waiting, never sends a request, and permits a later independent attempt', async () => {
    const launch = vi.fn(async () => {});
    const service = createRuntimeClient(undefined, { ...options, readyTimeoutMs: 15, defaultPath: noDiscovery, launch });
    await expect(service.call('fixture-token', 'act', { requestId: 'unchanged' })).rejects.toMatchObject({ code: 'unavailable' });
    expect(launch).toHaveBeenCalledTimes(1);
    await expect(service.call('fixture-token', 'doctor', {})).rejects.toMatchObject({ code: 'unavailable' });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it.each(['paused', 'unauthorized', 'unavailable', 'unknown_outcome'] as const)(
    'does not restart or replay a business request rejected as %s',
    async code => {
      const server = await pipeServer((request, socket) => {
        socket.end(JSON.stringify({ id: request.id, error: { code, message: 'Fixture refusal.' } }) + '\n');
      });
      const launch = vi.fn();
      const service = createRuntimeClient(undefined, { ...options, defaultPath: async () => server.path, launch });
      await expect(service.call('fixture-token', 'act', { requestId: 'same-request' })).rejects.toMatchObject({ code });
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.params).toEqual({ requestId: 'same-request' });
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it('does not replay an act whose response connection closes', async () => {
    const server = await pipeServer((_request, socket) => socket.end());
    const launch = vi.fn();
    const service = createRuntimeClient(undefined, { ...options, defaultPath: async () => server.path, launch });
    await expect(service.call('fixture-token', 'act', {})).rejects.toMatchObject({ code: 'unknown_outcome' });
    expect(server.requests).toHaveLength(1);
    expect(launch).not.toHaveBeenCalled();
  });

  it('propagates an explicit stopped helper result without sending an RPC or retrying', async () => {
    const launch = vi.fn(async () => {
      throw new CuError('unavailable', 'Windows host startup stopped: restart in the local app.');
    });
    const service = createRuntimeClient(undefined, { ...options, defaultPath: noDiscovery, launch });
    await expect(service.call('fixture-token', 'act', {})).rejects.toThrow('startup stopped');
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('leaves explicit sockets and unsupported platforms on the original transport without probing', async () => {
    const server = await pipeServer();
    const launch = vi.fn();
    const probe = vi.fn();
    const discover = vi.fn(async () => server.path);
    await createRuntimeClient(server.path, { ...options, defaultPath: discover, launch, probe }).call('fixture-token', 'doctor', {});
    expect(discover).not.toHaveBeenCalled();
    await createRuntimeClient(undefined, { ...options, platform: 'linux', defaultPath: discover, launch, probe }).call(
      'fixture-token',
      'doctor',
      {},
    );
    expect(discover).toHaveBeenCalledTimes(1);
    expect(probe).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(2);
  });

  it('allows a real MCP initialize and tools/list before starting the host on the first tool call', async () => {
    let active: Awaited<ReturnType<typeof pipeServer>> | undefined;
    const launch = vi.fn(async () => {
      active = await pipeServer();
    });
    const service = createRuntimeClient(undefined, {
      ...options,
      defaultPath: () => (active ? Promise.resolve(active.path) : noDiscovery()),
      launch,
    });
    const http = await listenHttp(service, () => {}, 0);
    cleanup.push(() => http.close());
    const client = new Client({ name: 'lazy-runtime-test', version: '1' });
    cleanup.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer fixture-token' } },
      }),
    );
    expect((await client.listTools()).tools.some(tool => tool.name === 'doctor')).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    const result = await client.callTool({ name: 'doctor', arguments: {} });
    expect(result.structuredContent).toEqual({ method: 'doctor' });
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe('same-bundle Windows host selection', () => {
  const locate = () => bundledWindowsHost(options.modulePath!, options.entrypoint!, options.executable!);
  it('accepts an intact bundle including paths with shell metacharacters', async () => {
    await expect(locate()).resolves.toBe(join(bundle, 'ComputerUse.WindowsHost.exe'));
  });
  it.each(['source', 'other-cli', 'other-node', 'receipt', 'host'])('rejects %s without searching elsewhere', async problem => {
    if (problem === 'source') {
      await mkdir(join(directory, 'dist'));
      options.modulePath = join(directory, 'dist', 'runtime-client.js');
      await writeFile(options.modulePath, 'fixture');
    } else if (problem === 'other-cli') options.entrypoint = options.modulePath;
    else if (problem === 'other-node') options.executable = process.execPath;
    else await rm(join(bundle, problem === 'receipt' ? 'build-receipt.json' : 'ComputerUse.WindowsHost.exe'));
    await expect(locate()).rejects.toMatchObject({ code: 'unavailable' });
  });
  it.skipIf(process.platform === 'win32')('rejects a host symlink outside the bundle', async () => {
    const host = join(bundle, 'ComputerUse.WindowsHost.exe');
    await rm(host);
    await symlink(process.execPath, host);
    await expect(locate()).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('same-bundle macOS background startup', () => {
  async function macBundle() {
    const app = join(directory, 'Computer Use.app');
    const contents = join(app, 'Contents');
    const resources = join(contents, 'Resources');
    await mkdir(join(resources, 'runtime'), { recursive: true });
    await mkdir(join(resources, 'bin'));
    await mkdir(join(contents, 'MacOS'));
    const host = join(contents, 'MacOS', 'ComputerUseHost');
    for (const file of [
      host,
      join(resources, 'runtime', 'cli.js'),
      join(resources, 'runtime', 'runtime-client.js'),
      join(resources, 'bin', 'node'),
    ])
      await writeFile(file, 'fixture');
    await writeFile(
      join(contents, 'Info.plist'),
      '<plist><dict><key>CFBundleIdentifier</key><string>com.starroy.computeruse</string><key>CFBundleExecutable</key><string>ComputerUseHost</string></dict></plist>',
    );
    await writeFile(join(resources, 'build-receipt.json'), JSON.stringify({ owner: 'computer-use-package-v1', arch: 'arm64' }));
    const configured = {
      ...options,
      platform: 'darwin' as const,
      modulePath: join(resources, 'runtime', 'runtime-client.js'),
      entrypoint: join(resources, 'runtime', 'cli.js'),
      executable: join(resources, 'bin', 'node'),
    };
    return { app, host, contents, resources, configured };
  }
  it('selects only the matching bundled host and shares concurrent cold starts', async () => {
    const { host, configured } = await macBundle();
    expect(await bundledMacHost(configured.modulePath, configured.entrypoint, configured.executable)).toBe(host);
    let active: Awaited<ReturnType<typeof pipeServer>> | undefined;
    const launch = vi.fn(async () => {
      active = await pipeServer();
    });
    const client = createRuntimeClient(undefined, {
      ...configured,
      launch,
      defaultPath: () => (active ? Promise.resolve(active.path) : noDiscovery()),
    });
    await Promise.all([client.call('fixture-token', 'doctor', {}), client.call('fixture-token', 'targets', {})]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0]).toBe(host);
    expect(active!.requests).toHaveLength(2);
  });
  it.each(['receipt', 'identity', 'node', 'source'] as const)('rejects %s mismatch without invoking a helper', async problem => {
    const { contents, resources, configured } = await macBundle();
    if (problem === 'receipt') await writeFile(join(resources, 'build-receipt.json'), '{}');
    if (problem === 'identity') await writeFile(join(contents, 'Info.plist'), '<plist/>');
    if (problem === 'node') configured.executable = process.execPath;
    if (problem === 'source') configured.modulePath = join(directory, 'src', 'runtime-client.ts');
    const launch = vi.fn();
    const client = createRuntimeClient(undefined, { ...configured, defaultPath: noDiscovery, launch });
    await expect(client.call('fixture-token', 'doctor', {})).rejects.toMatchObject({ code: 'unavailable' });
    expect(launch).not.toHaveBeenCalled();
  });
  it('never probes or starts a host for an explicit macOS socket', async () => {
    const { configured } = await macBundle();
    const server = await pipeServer();
    const launch = vi.fn();
    const probe = vi.fn();
    await createRuntimeClient(server.path, { ...configured, launch, probe }).call('fixture-token', 'doctor', {});
    expect(launch).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });
  it('reports missing system permissions without retrying the helper', async () => {
    const { child } = helperProcess();
    const started = ensureMacHost('/fixture/ComputerUseHost');
    child.stdout.write(
      JSON.stringify({ ok: false, code: 'permissions_required', message: 'Open the local app to grant permissions.' }) + '\n',
    );
    child.emit('exit', 1, null);
    await expect(started).rejects.toThrow('macOS host startup permissions_required');
  });
});

function helperProcess() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn(() => true) });
  const spawn = vi.mocked(childProcess.spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof childProcess.spawn>);
  return { child, spawn };
}

describe('bounded native startup helper', () => {
  it('uses an absolute executable and literal arguments, accepting a fragmented single JSON line', async () => {
    const { child, spawn } = helperProcess();
    const host = join(bundle, 'ComputerUse.WindowsHost.exe');
    const started = ensureWindowsHost(host);
    child.stdout.write('{"ok":true,');
    child.stdout.write('"state":"ready"}\r\n');
    child.emit('exit', 0, null);
    await expect(started).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledExactlyOnceWith(host, ['--ensure-running'], {
      cwd: bundle,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: expect.any(Object),
    });
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdout.destroyed).toBe(true);
  });
  it('waits for process exit even after a complete ready result', async () => {
    const { child } = helperProcess();
    const finished = vi.fn();
    const started = ensureWindowsHost(join(bundle, 'ComputerUse.WindowsHost.exe')).then(finished);
    child.stdout.write('{"ok":true,"state":"ready"}\n');
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    child.emit('exit', 0, null);
    await started;
    expect(finished).toHaveBeenCalledTimes(1);
  });
  it('waits for a complete result when exit arrives before fragmented stdout', async () => {
    const { child } = helperProcess();
    const finished = vi.fn();
    const started = ensureWindowsHost(join(bundle, 'ComputerUse.WindowsHost.exe')).then(finished);
    child.emit('exit', 0, null);
    child.stdout.write('{"ok":true,"state":"ready"}');
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    child.stdout.write('\r\n');
    await started;
    expect(finished).toHaveBeenCalledTimes(1);
    expect(child.stdout.destroyed).toBe(true);
  });
  it('finishes after a real helper exits while its descendant still holds stdout', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const pidFile = join(directory, 'stdout-holder.pid');
    cleanup.push(async () => {
      const pid = Number(await readFile(pidFile, 'utf8'));
      try {
        process.kill(pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    });
    const script = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', process.stdout, 'ignore'] });
      writeFileSync(${JSON.stringify(pidFile)}, String(holder.pid));
      holder.unref();
      process.stdout.write('{"ok":true,"state":"ready"}\\n');
    `;
    vi.mocked(childProcess.spawn).mockImplementationOnce(() =>
      actual.spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] }),
    );
    await expect(ensureWindowsHost(join(bundle, 'ComputerUse.WindowsHost.exe'), 2000)).resolves.toBeUndefined();
  });
  it.each(['EACCES', 'ENOENT'])('reports the concrete spawn error %s', async code => {
    const { child } = helperProcess();
    const started = ensureWindowsHost(join(bundle, 'ComputerUse.WindowsHost.exe'));
    child.emit('error', Object.assign(new Error('discarded private detail'), { code }));
    await expect(started).rejects.toMatchObject({ code: 'unavailable', message: `Cannot launch the Windows host (${code}).` });
  });
  it.each(['paused', 'stopped', 'failed', 'non_interactive', 'timeout', 'launch_failed'])(
    'preserves the native %s reason and exit code',
    async code => {
      const { child } = helperProcess();
      const started = ensureWindowsHost(join(bundle, 'ComputerUse.WindowsHost.exe'));
      child.stdout.write(JSON.stringify({ ok: false, code, message: 'Fixture startup refusal.' }) + '\n');
      child.emit('exit', 3, null);
      await expect(started).rejects.toMatchObject({
        code: code === 'paused' ? 'paused' : code === 'timeout' ? 'timeout' : 'unavailable',
        message: `Windows host startup ${code} (exit 3): Fixture startup refusal.`,
      });
    },
  );
  it.each(['', 'secret fixture output', '{"ok":true,"state":"ready"}\n{}', '{"ok":true,"state":"ready"}'])(
    'rejects malformed output or an unsuccessful exit without echoing raw stdout',
    async output => {
      const { child } = helperProcess();
      const started = ensureWindowsHost(join(bundle, 'ComputerUse.WindowsHost.exe'));
      child.stdout.write(output);
      child.emit('exit', 7, null);
      child.emit('close', 7, null);
      await expect(started).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('exit 7') });
    },
  );
  it('rejects ready output when the helper exits unsuccessfully without waiting for close', async () => {
    const { child } = helperProcess();
    const started = ensureWindowsHost(join(bundle, 'ComputerUse.WindowsHost.exe'));
    child.stdout.write('{"ok":true,"state":"ready"}\n');
    child.emit('exit', 9, null);
    await expect(started).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('exit 9') });
    expect(child.stdout.destroyed).toBe(true);
  });
  it.each(['{}\n', '{"ok":true,"state":"ready"}\n{}\n', '{"ok":true,"state":"ready"}\n\n'])(
    'rejects invalid or multiple lines even after a successful exit',
    async output => {
      const { child } = helperProcess();
      const started = ensureWindowsHost(join(bundle, 'ComputerUse.WindowsHost.exe'));
      child.stdout.write(output);
      child.emit('exit', 0, null);
      await expect(started).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('invalid response (exit 0)') });
    },
  );
  it.each(['', '{"ok":true,"state":"ready"}'])(
    'bounds an exited helper with no complete line even when stdout remains open',
    async output => {
      const { child } = helperProcess();
      const started = ensureWindowsHost(join(bundle, 'ComputerUse.WindowsHost.exe'), 10);
      child.stdout.write(output);
      child.emit('exit', 0, null);
      await expect(started).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('invalid response (exit 0)') });
      expect(child.kill).not.toHaveBeenCalled();
      expect(child.stdout.destroyed).toBe(true);
    },
  );
  it('terminates only the helper when its response is oversized', async () => {
    const { child } = helperProcess();
    const started = ensureWindowsHost(join(bundle, 'ComputerUse.WindowsHost.exe'));
    child.stdout.write('x'.repeat(8193));
    await expect(started).rejects.toThrow('response limit');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
  it('terminates only the helper after the deadline and accepts late process events safely', async () => {
    const { child } = helperProcess();
    const started = ensureWindowsHost(join(bundle, 'ComputerUse.WindowsHost.exe'), 10);
    await expect(started).rejects.toMatchObject({ code: 'timeout' });
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('error', Object.assign(new Error('late exit'), { code: 'ESRCH' }));
    child.emit('close', null, 'SIGTERM');
  });
});
