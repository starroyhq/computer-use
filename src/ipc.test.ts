import { createConnection, createServer, type Socket } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcClient, listenIpc } from './ipc.js';
import { CuError } from './contracts.js';

let directory: string;
let path: string;
let listener: { close(): Promise<void> } | undefined;
const token = randomUUID();
const envelope = (id: string, method = 'doctor') => JSON.stringify({ version: 1, id, token, method, params: {} }) + '\n';

beforeEach(async () => {
  // AF_UNIX on macOS has a 104-byte path limit; tmpdir() may exceed it.
  directory = await mkdtemp('/tmp/cu-ipc-');
  path = join(directory, 'runtime.sock');
});
afterEach(async () => {
  await listener?.close();
  listener = undefined;
  await rm(directory, { recursive: true, force: true });
});

function rawRequest(input: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const output: Buffer[] = [];
    socket.on('connect', () => socket.write(input));
    socket.on('data', chunk => output.push(chunk));
    socket.on('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
    });
    socket.on('close', () => resolve(Buffer.concat(output).toString('utf8')));
  });
}

describe.skipIf(process.platform === 'win32')('private IPC transport', () => {
  it('creates a mode-0600 socket, passes authorization to the service and rejects unauthorized clients', async () => {
    const call = vi.fn(async (provided: string | undefined) => {
      if (provided !== token) throw new CuError('unauthorized', 'Client authorization required.');
      return { state: 'ready' };
    });
    listener = await listenIpc(path, { call });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const client = new IpcClient(path);
    await expect(client.call(undefined, 'doctor', {})).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(client.call(token, 'doctor', {})).resolves.toEqual({ state: 'ready' });
    expect(call.mock.calls.length).toBe(2);
    await expect(listenIpc(path, { call })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(client.call(token, 'doctor', {})).resolves.toEqual({ state: 'ready' });
  });

  it('accepts fragmented JSON and dispatches at most one request on a connection', async () => {
    const call = vi.fn(async () => ({ state: 'ready' }));
    listener = await listenIpc(path, { call });
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(path);
      let result = '';
      socket.on('error', reject);
      socket.on('connect', () => {
        const request = envelope('first');
        socket.write(request.slice(0, 10));
        setImmediate(() => socket.write(request.slice(10) + envelope('second')));
      });
      socket.on('data', chunk => {
        result += chunk.toString();
      });
      socket.on('close', () => resolve(result));
    });
    expect(JSON.parse(response)).toEqual({ id: 'first', result: { state: 'ready' } });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('keeps dispatched work running after its caller disconnects', async () => {
    const gate = Promise.withResolvers<void>();
    const dispatched = Promise.withResolvers<void>();
    let completed = false;
    listener = await listenIpc(path, {
      async call() {
        dispatched.resolve();
        await gate.promise;
        completed = true;
        return {};
      },
    });
    const socket = createConnection(path);
    socket.on('error', () => {});
    socket.on('connect', () => socket.write(envelope('disconnected', 'act')));
    await dispatched.promise;
    socket.destroy();
    gate.resolve();
    await vi.waitFor(() => expect(completed).toBe(true));
  });

  it('rejects malformed, unsupported-version and oversized requests without dispatching', async () => {
    const call = vi.fn(async () => ({}));
    listener = await listenIpc(path, { call });
    for (const request of [
      '{broken\n',
      '{"version":2,"id":"x","method":"doctor","params":{}}\n',
      '{"version":1,"id":"x","method":"doctor","params":{},"unexpected":true}\n',
    ]) {
      expect(JSON.parse(await rawRequest(request))).toMatchObject({ error: { code: 'invalid_request' } });
    }
    expect(await rawRequest(Buffer.alloc(512 * 1024 + 1, 65))).toBe('');
    expect(call).not.toHaveBeenCalled();
  });

  it('sanitizes unexpected service exceptions and caps response size', async () => {
    listener = await listenIpc(path, {
      async call(_token, method) {
        if (method === 'large') return { data: 'x'.repeat(32 * 1024 * 1024) };
        throw new Error('fixture-sensitive-value');
      },
    });
    const response = await rawRequest(envelope('error'));
    expect(response.includes('fixture-sensitive-value')).toBe(false);
    expect(JSON.parse(response)).toMatchObject({ error: { code: 'internal' } });
    await expect(new IpcClient(path).call(token, 'large', {})).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('reports lost action replies as unknown outcomes and rejects mismatched reply ids', async () => {
    let mode: 'disconnect' | 'mismatch' = 'disconnect';
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      socket.once('data', () => {
        if (mode === 'disconnect') socket.end();
        else socket.end(JSON.stringify({ id: 'different-id', result: {} }) + '\n');
      });
    });
    await new Promise<void>(resolve => server.listen(path, resolve));
    listener = {
      async close() {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
      },
    };
    const client = new IpcClient(path);
    await expect(client.call(token, 'act', {})).rejects.toMatchObject({ code: 'unknown_outcome' });
    await expect(client.call(token, 'doctor', {})).rejects.toMatchObject({ code: 'unavailable' });
    mode = 'mismatch';
    await expect(client.call(token, 'doctor', {})).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('reports an action that never reached the runtime as unavailable instead of an unknown outcome', async () => {
    const client = new IpcClient(join(directory, 'missing.sock'));
    await expect(client.call(token, 'act', {})).rejects.toMatchObject({ code: 'unavailable' });
    await expect(client.call(token, 'doctor', {})).rejects.toMatchObject({ code: 'unavailable' });
  });
});
