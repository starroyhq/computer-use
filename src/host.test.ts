import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CuError, type Client, type HostCommand, type HostEvent } from './contracts.js';
import { IpcClient } from './ipc.js';
import { hash } from './storage.js';

type WorkerEvent = HostEvent | { event: 'test_prepare_pending' };

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cu host '));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function launch(gated: boolean, preload?: string) {
  // Exercise the actual native launcher rather than a second copy of its bootstrap.
  const native = await readFile(resolve('windows/ComputerUse.WindowsHost/HostRuntime.cs'), 'utf8');
  const bootstrap = native.match(/const string bootstrap = "([^"]+)";/)?.[1];
  if (!bootstrap) throw new Error('Windows worker bootstrap was not found.');
  const entrypoint = resolve('dist/host.js');
  const workerArgs =
    process.platform === 'win32'
      ? ['--windows', '--driver-binary', join(directory, 'unused-driver.exe')]
      : ['--socket', join(directory, 'runtime.sock'), '--driver-socket', join(directory, 'unused-driver.sock')];
  const child = spawn(
    process.execPath,
    [
      ...(preload ? ['--import', pathToFileURL(preload).href] : []),
      ...(gated ? ['--input-type=commonjs', '--eval', bootstrap] : []),
      entrypoint,
      ...workerArgs,
      '--data-dir',
      join(directory, 'data'),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const events: WorkerEvent[] = [];
  let output = '';
  let stderr = '';
  const ready = Promise.withResolvers<boolean>();
  child.stdout.on('data', chunk => {
    output += chunk.toString();
    for (;;) {
      const end = output.indexOf('\n');
      if (end === -1) break;
      const event = JSON.parse(output.slice(0, end)) as WorkerEvent;
      output = output.slice(end + 1);
      events.push(event);
      if (event.event === 'ready') ready.resolve(true);
    }
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  child.stdin.on('error', () => {});
  const closed = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', code => {
      ready.resolve(false);
      resolveExit(code);
    });
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  async function waitEvent<T extends WorkerEvent>(matches: (event: WorkerEvent) => event is T): Promise<T> {
    return vi.waitFor(() => {
      const event = events.find(matches);
      expect(event, stderr).toBeDefined();
      return event!;
    });
  }
  return {
    child,
    events,
    ready: ready.promise,
    closed,
    waitEvent,
    send(command: HostCommand) {
      child.stdin.write(JSON.stringify(command) + '\n');
    },
    async rpc(token: string, method: string): Promise<unknown> {
      if (process.platform !== 'win32') return new IpcClient(join(directory, 'runtime.sock'), 1000).call(token, method, {});
      const id = randomUUID();
      child.stdin.write(JSON.stringify({ command: 'rpc_request', id, token, method, params: {} }) + '\n');
      const response = await waitEvent(
        (event): event is Extract<HostEvent, { event: 'rpc_response' }> => event.event === 'rpc_response' && event.id === id,
      );
      if (response.error) throw new CuError(response.error.code, response.error.message);
      return response.result;
    },
    stderr: () => stderr,
    async dispose() {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    },
  };
}

async function launchWithPendingGrant(failAfterGate = false) {
  const token = 'host-entrypoint-test-token';
  const observerToken = 'host-entrypoint-observer-token';
  const grant = { appIds: ['com.example.Editor'], allApps: false, browser: false, foreground: false };
  const clients: Client[] = [
    { id: 'client-a', name: 'Grant test', tokenHash: hash(token), grant },
    { id: 'client-b', name: 'Observer test', tokenHash: hash(observerToken), grant },
  ];
  const clientsPath = join(directory, 'data', 'clients.json');
  await mkdir(join(directory, 'data'), { mode: 0o700 });
  await writeFile(clientsPath, JSON.stringify(clients), { mode: 0o600 });
  const releasePath = join(directory, 'release-prepare');
  const preload = join(directory, 'prepare-gate.mjs');
  // Patch only this child process. Holding a prepared candidate exercises the
  // real persistence queue without adding a production test hook or a driver.
  await writeFile(
    preload,
    `import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ClientStore } from ${JSON.stringify(pathToFileURL(resolve('dist/storage.js')).href)};
const load = ClientStore.prototype.load;
ClientStore.prototype.load = async function () {
  const prepare = this.prepare;
  let held = false;
  this.prepare = async (...args) => {
    if (held && ${failAfterGate}) throw new Error('Test-only persistence failure');
    const staged = await prepare(...args);
    if (!held) {
      held = true;
      process.stdout.write(JSON.stringify({ event: 'test_prepare_pending' }) + '\\n');
      const deadline = Date.now() + 8000;
      for (;;) {
        try { await access(${JSON.stringify(releasePath)}); break; }
        catch (error) { if (error.code !== 'ENOENT' || Date.now() > deadline) throw error; }
        await delay(10);
      }
    }
    return staged;
  };
  return load.call(this);
};
`,
  );
  const worker = await launch(true, preload);
  worker.child.stdin.write('computer-use-start\n');
  const requestId = randomUUID();
  return {
    ...worker,
    token,
    observerToken,
    clients,
    releasePrepare: () => writeFile(releasePath, 'release'),
    async beginGrant() {
      expect(await worker.ready, worker.stderr()).toBe(true);
      worker.send({ command: 'grant_all_apps', clientId: 'client-a', requestId });
      await worker.waitEvent(
        (event): event is Extract<WorkerEvent, { event: 'test_prepare_pending' }> => event.event === 'test_prepare_pending',
      );
    },
    async releaseGrant() {
      await writeFile(releasePath, 'release');
      const event = await worker.waitEvent(
        (event): event is Extract<HostEvent, { event: 'clients' }> => event.event === 'clients' && event.operation?.requestId === requestId,
      );
      return event.operation!;
    },
    async persisted(): Promise<Client[]> {
      return JSON.parse(await readFile(clientsPath, 'utf8')) as Client[];
    },
  };
}

describe('real host entrypoint', () => {
  it.each([false, true])('parses native worker arguments and closes on EOF (gated=%s)', async gated => {
    const worker = await launch(gated);
    try {
      if (gated) worker.child.stdin.write('computer-use-start\n');
      expect(await worker.ready, worker.stderr()).toBe(true);
      expect(worker.events.map(event => event.event)).toContain('clients');
      expect(worker.stderr()).not.toContain('ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL');
      worker.child.stdin.end();
      expect(await worker.closed).toBe(0);
      expect(worker.events.map(event => event.event)).not.toContain('fatal');
    } finally {
      await worker.dispose();
    }
  });

  it('does not import or start the worker when the native gate closes before assignment', async () => {
    const worker = await launch(true);
    try {
      worker.child.stdin.end();
      expect(await worker.closed).toBe(1);
      expect(worker.events).toEqual([]);
      await expect(stat(join(directory, 'data'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await worker.dispose();
    }
  });

  it('applies stop before a pending grant can commit and still accepts revocation afterward', async () => {
    const worker = await launchWithPendingGrant();
    try {
      await worker.beginGrant();
      worker.send({ command: 'stop' });
      await vi.waitFor(async () => {
        expect(await worker.rpc(worker.token, 'capabilities')).toMatchObject({
          stopped: true,
          paused: true,
          authorization: worker.clients[0]!.grant,
        });
      });
      expect(await worker.persisted()).toEqual(worker.clients);
      expect(await worker.releaseGrant()).toMatchObject({ ok: false, error: { code: 'unavailable' } });
      expect(await worker.persisted()).toEqual(worker.clients);
      worker.send({ command: 'resume' });
      expect(await worker.rpc(worker.token, 'capabilities')).toMatchObject({ stopped: true, paused: true });
      worker.send({ command: 'revoke', clientId: 'client-a' });
      await vi.waitFor(async () => {
        await expect(worker.rpc(worker.token, 'capabilities')).rejects.toMatchObject({ code: 'unauthorized' });
        expect(await worker.persisted()).toEqual([worker.clients[1]]);
      });
      expect(worker.events.some(event => event.event === 'fatal')).toBe(false);
    } finally {
      await worker.dispose();
    }
  });

  it('revokes immediately during grant persistence without blocking a subsequent stop', async () => {
    const worker = await launchWithPendingGrant();
    try {
      await worker.beginGrant();
      worker.send({ command: 'revoke', clientId: 'client-a' });
      worker.send({ command: 'stop' });
      await vi.waitFor(async () => {
        await expect(worker.rpc(worker.token, 'capabilities')).rejects.toMatchObject({ code: 'unauthorized' });
        expect(await worker.rpc(worker.observerToken, 'capabilities')).toMatchObject({ stopped: true, paused: true });
      });
      expect(await worker.persisted()).toEqual(worker.clients);
      expect(await worker.releaseGrant()).toMatchObject({ ok: false, error: { code: 'not_found' } });
      await vi.waitFor(async () => expect(await worker.persisted()).toEqual([worker.clients[1]]));
      await expect(worker.rpc(worker.token, 'capabilities')).rejects.toMatchObject({ code: 'unauthorized' });
      expect(worker.events.some(event => event.event === 'fatal')).toBe(false);
    } finally {
      await worker.dispose();
    }
  });

  it('pauses execution immediately while allowing an explicit local grant to finish', async () => {
    const worker = await launchWithPendingGrant();
    try {
      await worker.beginGrant();
      worker.send({ command: 'pause' });
      await vi.waitFor(async () => {
        expect(await worker.rpc(worker.token, 'capabilities')).toMatchObject({
          paused: true,
          stopped: false,
          authorization: worker.clients[0]!.grant,
        });
      });
      await expect(worker.rpc(worker.token, 'targets')).rejects.toMatchObject({ code: 'paused' });
      expect(await worker.persisted()).toEqual(worker.clients);
      expect(await worker.releaseGrant()).toMatchObject({ ok: true });
      expect(await worker.rpc(worker.token, 'capabilities')).toMatchObject({
        paused: true,
        stopped: false,
        authorization: { allApps: true, appIds: [], browser: false, foreground: true },
      });
      await expect(worker.rpc(worker.token, 'targets')).rejects.toMatchObject({ code: 'paused' });
      expect((await worker.persisted())[0]).toMatchObject({
        tokenHash: worker.clients[0]!.tokenHash,
        grant: { allApps: true, appIds: [], browser: false, foreground: true },
      });
      expect(worker.events.some(event => event.event === 'fatal')).toBe(false);
    } finally {
      await worker.dispose();
    }
  });

  it('flushes revocations before normal EOF exit while stopping a pending grant immediately', async () => {
    const worker = await launchWithPendingGrant();
    let released: Promise<void> | undefined;
    try {
      await worker.beginGrant();
      worker.send({ command: 'revoke', clientId: 'client-a' });
      worker.send({ command: 'stop' });
      await vi.waitFor(async () => {
        await expect(worker.rpc(worker.token, 'capabilities')).rejects.toMatchObject({ code: 'unauthorized' });
        expect(await worker.rpc(worker.observerToken, 'capabilities')).toMatchObject({ stopped: true, paused: true });
      });
      worker.send({ command: 'revoke', clientId: 'client-b' });
      await vi.waitFor(async () => {
        await expect(worker.rpc(worker.observerToken, 'capabilities')).rejects.toMatchObject({ code: 'unauthorized' });
      });
      expect(await worker.persisted()).toEqual(worker.clients);
      released = delay(1000).then(() => worker.releasePrepare());
      worker.child.stdin.end();
      expect(await worker.closed).toBe(0);
      await released;
      expect(await worker.persisted()).toEqual([]);
      expect(worker.events.some(event => event.event === 'fatal')).toBe(false);
      expect(worker.events.some(event => event.event === 'clients' && event.operation?.ok === true)).toBe(false);
    } finally {
      await released;
      await worker.dispose();
    }
  });

  it('still reports a fatal control error when queued revocation persistence fails during close', async () => {
    const worker = await launchWithPendingGrant(true);
    try {
      await worker.beginGrant();
      worker.send({ command: 'revoke', clientId: 'client-a' });
      await vi.waitFor(async () => {
        await expect(worker.rpc(worker.token, 'capabilities')).rejects.toMatchObject({ code: 'unauthorized' });
      });
      worker.child.stdin.end();
      expect(await worker.releaseGrant()).toMatchObject({ ok: false });
      await worker.closed;
      expect(worker.events).toContainEqual({ event: 'fatal', message: 'Host control channel failed.' });
      expect(worker.events.some(event => event.event === 'clients' && event.operation?.ok === true)).toBe(false);
      expect(await worker.persisted()).toEqual(worker.clients);
    } finally {
      await worker.dispose();
    }
  });
});
