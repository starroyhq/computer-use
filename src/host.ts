import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { CuaBackend, connectWindowsWorker } from './backends/cua.js';
import { BrowserBackend } from './backends/browser.js';
import { Runtime } from './runtime.js';
import { listenIpc } from './ipc.js';
import { listenHttp } from './mcp.js';
import { hostCommandSchema } from './schema.js';
import { type HostEvent } from './contracts.js';
import { errorResult } from './contracts.js';
import { z } from 'zod';

const { values } = parseArgs({ options: { socket: { type: 'string' }, 'driver-socket': { type: 'string' }, 'driver-binary': { type: 'string' }, windows: { type: 'boolean' }, 'data-dir': { type: 'string' } } });
if (!values['data-dir'] || (values.windows ? process.platform !== 'win32' || !values['driver-binary'] : !values.socket || !values['driver-socket'])) {
  throw new Error('Launch this worker from the Computer Use host.');
}
const emit = (event: HostEvent): void => {
  // Decision lifecycle notifications are currently consumed by the Windows host.
  if (event.event === 'decision_finished' && !values.windows) return;
  process.stdout.write(JSON.stringify(event) + '\n');
};
const desktop = values.windows ? new CuaBackend(values['driver-binary']!, connectWindowsWorker, 'win32') : new CuaBackend(values['driver-socket']!);
const runtime = new Runtime({ dataDir: values['data-dir'], backends: [desktop, new BrowserBackend(values['data-dir'])], emit });
const rpcRequest = z.object({ command: z.literal('rpc_request'), id: z.string().min(1).max(100), token: z.string().max(512).optional(),
  method: z.string().min(1).max(80), params: z.unknown() }).strict();
let http: Awaited<ReturnType<typeof listenHttp>> | undefined;
let ipc: Awaited<ReturnType<typeof listenIpc>> | undefined;
let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  const watchdog = setTimeout(() => process.exit(1), 1500);
  await Promise.allSettled([runtime.close(), http?.close(), ipc?.close()]);
  clearTimeout(watchdog);
  process.exit(0);
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
process.on('uncaughtException', () => { emit({ event: 'fatal', message: 'Runtime failed. Restart from the local app.' }); void close(); });
process.on('unhandledRejection', () => { emit({ event: 'fatal', message: 'Runtime operation failed. Restart from the local app.' }); void close(); });
try {
  await runtime.start();
  if (!values.windows) ipc = await listenIpc(values.socket!, runtime);
  const control = createInterface({ input: process.stdin });
  let commands = Promise.resolve();
  control.on('line', line => {
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { emit({ event: 'fatal', message: 'Host control channel sent malformed JSON.' }); void close(); return; }
    if (values.windows && rpcRequest.safeParse(message).success) {
      const request = rpcRequest.parse(message);
      // RPC calls run independently: a pending pair or foreground decision must
      // not block the host's approval command behind it.
      void runtime.call(request.token, request.method, request.params)
        .then(result => emit({ event: 'rpc_response', id: request.id, result }))
        .catch(error => emit({ event: 'rpc_response', id: request.id, error: errorResult(error) }));
      return;
    }
    commands = commands.then(async () => {
      const result = hostCommandSchema.safeParse(message);
      if (!result.success) throw new Error('Invalid host control message');
      const command = result.data;
      if (command.command === 'http_enable' && !http) {
        try { http = await listenHttp(runtime, token => runtime.authenticate(token)); emit({ event: 'status', message: `Local MCP: http://127.0.0.1:${http.port}/mcp` }); }
        catch { emit({ event: 'status', message: 'HTTP listener could not start; check port 47631.' }); }
      } else if (command.command === 'http_disable' && http) { await http.close(); http = undefined; }
      else await runtime.control(command);
    }).catch(() => { emit({ event: 'fatal', message: 'Host control channel failed.' }); void close(); });
  });
  control.on('close', () => void close());
  emit({ event: 'ready' });
} catch {
  emit({ event: 'fatal', message: 'Runtime startup failed. Check private sockets, driver and local state.' });
  await close();
}
