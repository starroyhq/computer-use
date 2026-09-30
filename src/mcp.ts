import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { createServer, type IncomingMessage } from 'node:http';
import { z } from 'zod';
import { errorResult, type RpcService } from './contracts.js';
import { descriptions, schemas, type Method } from './schema.js';
import { VERSION } from './version.js';

const imageSchema = z.object({ mimeType: z.enum(['image/png', 'image/jpeg']), data: z.string() });
const instructions =
  'Use only paired targets. Start with doctor and targets, open a session, then observe. Each act needs a fresh snapshotId and a UUID requestId. Observe again after each action, or pass observe: { changes: true } to act to receive the next snapshot with only changed elements in the same call. Element ids stay stable within a session while an element is unchanged. executed with effect "unconfirmed" means input was dispatched but the driver could not prove its effect: observe and continue. state "unknown" means delivery itself is uncertain: query action_status and inspect the target; never blindly replay it. Verify the intended result, for example with an element value condition, and close the session. Foreground was granted once at pairing; use it only when the task needs keyboard or pointer input that background mode cannot deliver.';
export function mcpResult(value: unknown): CallToolResult {
  const images: Array<{ type: 'image'; mimeType: string; data: string }> = [];
  function stripImages(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(stripImages);
    if (!input || typeof input !== 'object') return input;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      const image = key === 'screenshot' ? imageSchema.safeParse(item) : undefined;
      if (image?.success) {
        images.push({ type: 'image', ...image.data });
        result[key] = { mimeType: image.data.mimeType, contentIndex: images.length };
      } else result[key] = stripImages(item);
    }
    return result;
  }
  const result = stripImages(value);
  const structuredContent =
    result !== null && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : { result };
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }, ...images], structuredContent };
}
export function createMcp(service: RpcService, token: string): McpServer {
  const server = new McpServer({ name: 'computer-use', version: VERSION }, { instructions });
  for (const method of Object.keys(schemas) as Method[]) {
    server.registerTool(
      method,
      {
        description: descriptions[method],
        inputSchema: schemas[method],
        annotations: {
          readOnlyHint: ['capabilities', 'doctor', 'observe', 'wait', 'action_status'].includes(method),
          destructiveHint: method === 'act',
          idempotentHint: method === 'action_status',
          openWorldHint: true,
        },
      },
      async (params: unknown): Promise<CallToolResult> => {
        try {
          return mcpResult(await service.call(token, method, params));
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorResult(error)) }] };
        }
      },
    );
  }
  return server;
}
export async function runStdio(service: RpcService, token: string): Promise<McpServer> {
  const server = createMcp(service, token);
  await server.connect(new StdioServerTransport());
  return server;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > 512 * 1024) throw new Error('body too large');
    parts.push(buffer);
  }
  return parts.length ? (JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown) : undefined;
}

export async function listenHttp(
  service: RpcService,
  authenticate: (token: string | undefined) => unknown,
  port = 47631,
): Promise<{ port: number; close(): Promise<void> }> {
  const connections = new Set<McpServer>();
  let boundPort = port;
  const http = createServer(async (request, response) => {
    const hosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
    const host = request.headers.host;
    const origin = request.headers.origin;
    if (!host || !hosts.has(host) || (origin !== undefined && ![...hosts].some(h => origin === `http://${h}`))) {
      response.writeHead(403).end();
      return;
    }
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    try {
      authenticate(token);
    } catch {
      response.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="computer-use"' }).end();
      return;
    }
    if (!token) {
      response.writeHead(401).end();
      return;
    }
    if (connections.size >= 32) {
      response.writeHead(503).end();
      return;
    }
    if (!['POST', 'GET', 'DELETE'].includes(request.method ?? '')) {
      response.writeHead(405).end();
      return;
    }
    let body: unknown;
    try {
      body = await readBody(request);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const mcp = createMcp(service, token);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    connections.add(mcp);
    response.on('close', () => {
      connections.delete(mcp);
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) response.writeHead(500).end();
      else response.end();
      await mcp.close();
    }
  });
  http.requestTimeout = 65_000;
  http.headersTimeout = 10_000;
  http.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, '127.0.0.1', resolve);
  });
  const address = http.address();
  if (address && typeof address === 'object') boundPort = address.port;
  return {
    port: boundPort,
    async close() {
      await Promise.allSettled([...connections].map(c => c.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close(error => (error ? reject(error) : resolve())));
    },
  };
}
