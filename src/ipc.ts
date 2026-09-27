import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CuError, errorResult, type ErrorCode, type RpcService } from './contracts.js';
import { z } from 'zod';

const MAX_REQUEST = 512 * 1024;
const MAX_RESPONSE = 32 * 1024 * 1024;
const requestSchema = z.object({ version: z.literal(1), id: z.string().max(100), token: z.string().max(512).optional(), method: z.string().max(80), params: z.unknown() }).strict();

export async function listenIpc(path: string, service: RpcService): Promise<{ close(): Promise<void> }> {
  if (Buffer.byteLength(path) > 103) throw new CuError('unavailable', 'Runtime socket path exceeds the macOS limit.');
  // Never unlink a socket that might belong to a running host.
  try { await lstat(path); throw new CuError('unavailable', 'Runtime socket already exists; stop its owner before restarting.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(70_000, () => socket.destroy());
    let input = Buffer.alloc(0);
    let accepted = false;
    socket.on('data', (chunk: Buffer) => {
      if (accepted) return;
      input = Buffer.concat([input, chunk]);
      if (input.length > MAX_REQUEST) { socket.destroy(); return; }
      const end = input.indexOf(10);
      if (end < 0) return;
      accepted = true;
      void (async () => {
        let id = '';
        try {
          const request = requestSchema.parse(JSON.parse(input.subarray(0, end).toString('utf8')));
          id = request.id;
          const result = await service.call(request.token, request.method, request.params);
          const response = JSON.stringify({ id, result });
          if (Buffer.byteLength(response) > MAX_RESPONSE) throw new CuError('unavailable', 'Observation exceeds transport size limit.');
          socket.end(response + '\n');
        } catch (error) {
          const detail = error instanceof z.ZodError || error instanceof SyntaxError ? { code: 'invalid_request', message: 'Malformed IPC request.' } : errorResult(error);
          socket.end(JSON.stringify({ id, error: detail }) + '\n');
        }
      })();
    });
  });
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  await chmod(path, 0o600);
  return { async close() {
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
    await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  } };
}
function closeServer(server: Server): Promise<void> { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

export class IpcClient implements RpcService {
  constructor(private readonly path: string) {}
  async call(token: string | undefined, method: string, params: unknown): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.path);
      let input = Buffer.alloc(0);
      let complete = false;
      const fail = (error: Error) => { if (!complete) { complete = true; reject(error); } socket.destroy(); };
      socket.setTimeout(65_000, () => fail(new CuError(method === 'act' ? 'unknown_outcome' : 'timeout', method === 'act' ? 'Connection timed out; query action_status with the original requestId before acting again.' : 'Runtime response timed out.')));
      socket.on('connect', () => socket.write(JSON.stringify({ version: 1, id, token, method, params }) + '\n'));
      socket.on('error', () => fail(new CuError(method === 'act' ? 'unknown_outcome' : 'unavailable', 'Cannot connect to runtime. Open the local app and check its status.')));
      socket.on('end', () => { if (!complete) fail(new CuError(method === 'act' ? 'unknown_outcome' : 'unavailable', 'Runtime connection closed before a result arrived.')); });
      socket.on('data', (chunk: Buffer) => {
        input = Buffer.concat([input, chunk]);
        if (input.length > MAX_RESPONSE) { fail(new CuError('unavailable', 'Runtime response too large.')); return; }
        const end = input.indexOf(10);
        if (end < 0 || complete) return;
        try {
          const response = z.object({ id: z.string(), result: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string() }).optional() }).parse(JSON.parse(input.subarray(0, end).toString('utf8')));
          if (response.id !== id) throw new CuError('unavailable', 'Mismatched runtime response.');
          complete = true;
          if (response.error) reject(new CuError(response.error.code as ErrorCode, response.error.message));
          else resolve(response.result);
          socket.end();
        } catch { fail(new CuError('unavailable', 'Invalid runtime response.')); }
      });
    });
  }
}
