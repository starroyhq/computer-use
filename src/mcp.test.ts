import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client, LATEST_PROTOCOL_VERSION, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CuError, type RpcService } from './contracts.js';
import { listenHttp, mcpResult } from './mcp.js';

const imageData = Buffer.from('fixture-png').toString('base64');
const toolNames = ['capabilities', 'doctor', 'targets', 'session_open', 'session_close', 'observe', 'act', 'wait', 'action_status', 'cancel'];
let server: Awaited<ReturnType<typeof listenHttp>>;
let token: string;
let revoked: boolean;
let failure: 'domain' | 'unexpected' | undefined;
let clients: Client[];
let calls: string[];
let service: RpcService;

beforeEach(async () => {
  token = randomUUID(); revoked = false; failure = undefined; clients = []; calls = [];
  const authenticate = (provided: string | undefined) => {
    if (revoked || provided !== token) throw new CuError('unauthorized', 'Client authorization required.');
  };
  service = { async call(provided, method) {
    authenticate(provided);
    calls.push(method);
    if (failure === 'domain') throw new CuError('permission_denied', 'Fixture permission denied.');
    if (failure === 'unexpected') throw new Error('fixture-sensitive-value');
    if (method === 'observe') return { snapshotId: 'fixture-snapshot', screenshot: { mimeType: 'image/png', data: imageData }, elements: [] };
    return { state: 'ready', method };
  } };
  server = await listenHttp(service, authenticate, 0);
});
afterEach(async () => { await Promise.allSettled(clients.map(client => client.close())); await server.close(); });

async function connectedClient(): Promise<Client> {
  const client = new Client({ name: 'computer-use-protocol-test', version: '1.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

type Reply = { status: number; body: string; remoteAddress: string | undefined };
async function rawHttp(options: { body?: string; method?: string; headers?: Record<string, string>; path?: string; authenticated?: boolean } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers = {
      Host: `127.0.0.1:${server.port}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION,
      ...(options.authenticated === false ? {} : { Authorization: `Bearer ${token}` }),
      ...options.headers,
    };
    const request = httpRequest({ hostname: '127.0.0.1', port: server.port, method: options.method ?? 'POST', path: options.path ?? '/mcp', headers }, response => {
      const chunks: Buffer[] = [];
      const remoteAddress = response.socket.remoteAddress;
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString('utf8'), remoteAddress }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(options.body);
  });
}
const rpc = (method: string, params: unknown = {}, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

it('extracts nested screenshots once and maps content indexes without duplicating base64', () => {
  const result = mcpResult({ observations: [{ screenshot: { mimeType: 'image/png', data: imageData } }, { screenshot: { mimeType: 'image/jpeg', data: 'anBlZw==' } }] });
  expect(result.content.map(content => content.type)).toEqual(['text', 'image', 'image']);
  expect(result.structuredContent).toEqual({ observations: [{ screenshot: { mimeType: 'image/png', contentIndex: 1 } }, { screenshot: { mimeType: 'image/jpeg', contentIndex: 2 } }] });
  expect(JSON.stringify(result.structuredContent).includes(imageData)).toBe(false);
  expect(result.content[0]?.type === 'text' && result.content[0].text.includes(imageData)).toBe(false);
  expect(mcpResult(['simple']).structuredContent).toEqual({ result: ['simple'] });
});

describe('MCP Streamable HTTP', () => {
  it('performs real initialize/list/call with the official v2 client and exposes all ten schemas', async () => {
    const client = await connectedClient();
    const listing = await client.listTools();
    expect(listing.tools.map(tool => tool.name).sort()).toEqual([...toolNames].sort());
    for (const tool of listing.tools) expect(tool.inputSchema.type).toBe('object');
    expect(listing.tools.find(tool => tool.name === 'act')?.inputSchema.required).toEqual(expect.arrayContaining(['sessionId', 'snapshotId', 'requestId', 'action']));
    expect(listing.tools.find(tool => tool.name === 'targets')?.annotations?.readOnlyHint).toBe(false);
    const result = await client.callTool({ name: 'observe', arguments: { sessionId: 'fixture-session' } });
    expect(result.content.map(item => item.type)).toEqual(['text', 'image']);
    expect(result.structuredContent).toMatchObject({ snapshotId: 'fixture-snapshot', screenshot: { contentIndex: 1 } });
    expect(JSON.stringify(result.structuredContent).includes(imageData)).toBe(false);
    expect(calls).toEqual(['observe']);
  });

  it('returns domain errors as tool errors and redacts unexpected exception messages', async () => {
    const client = await connectedClient();
    failure = 'domain';
    const denied = await client.callTool({ name: 'doctor', arguments: {} });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.type === 'text' && JSON.parse(denied.content[0].text)).toMatchObject({ code: 'permission_denied' });
    failure = 'unexpected';
    const unexpected = await client.callTool({ name: 'doctor', arguments: {} });
    expect(unexpected.isError).toBe(true);
    expect(JSON.stringify(unexpected).includes('fixture-sensitive-value')).toBe(false);
    const before = calls.length;
    const invalid = await client.callTool({ name: 'act', arguments: { sessionId: 'missing-other-fields' } });
    expect(invalid.isError).toBe(true);
    expect(calls.length).toBe(before);
  });

  it('binds loopback and accepts raw initialize, tools/list, and tools/call POSTs', async () => {
    const initialized = await rawHttp({ body: rpc('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'raw-test', version: '1' } }) });
    expect(initialized.remoteAddress).toBe('127.0.0.1');
    expect(initialized.status).toBe(200);
    expect(JSON.parse(initialized.body).result.serverInfo.name).toBe('computer-use');
    expect(JSON.parse(initialized.body).result.instructions).toContain('fresh snapshotId');
    const listing = await rawHttp({ body: rpc('tools/list', {}, 2) });
    expect(listing.status).toBe(200);
    expect(JSON.parse(listing.body).result.tools).toHaveLength(10);
    const called = await rawHttp({ body: rpc('tools/call', { name: 'doctor', arguments: {} }, 3) });
    expect(called.status).toBe(200);
    expect(JSON.parse(called.body).result.structuredContent).toEqual({ method: 'doctor', state: 'ready' });
  });

  it('rejects missing credentials, unauthorized Host and Origin before dispatch', async () => {
    const body = rpc('tools/list');
    expect((await rawHttp({ body, authenticated: false })).status).toBe(401);
    expect((await rawHttp({ body, headers: { Authorization: 'Bearer invalid-fixture-credential' } })).status).toBe(401);
    expect((await rawHttp({ body, headers: { Host: `attacker.example:${server.port}` } })).status).toBe(403);
    expect((await rawHttp({ body, headers: { Origin: 'https://attacker.example' } })).status).toBe(403);
    expect((await rawHttp({ body, headers: { Origin: 'null' } })).status).toBe(403);
    expect((await rawHttp({ body, headers: { Origin: `http://127.0.0.1:${server.port}` } })).status).toBe(200);
    expect((await rawHttp({ body, path: '/other' })).status).toBe(404);
    expect((await rawHttp({ method: 'PUT', body })).status).toBe(405);
    expect(calls).toEqual([]);
  });

  it('rechecks authorization for an already connected client after token revocation', async () => {
    const client = await connectedClient();
    await client.callTool({ name: 'doctor', arguments: {} });
    revoked = true;
    await expect(client.callTool({ name: 'doctor', arguments: {} })).rejects.toThrow();
    expect((await rawHttp({ body: rpc('tools/list') })).status).toBe(401);
    expect(calls).toEqual(['doctor']);
  });

  it('rejects malformed and oversized request bodies before service execution', async () => {
    expect((await rawHttp({ body: '{broken' })).status).toBe(400);
    expect((await rawHttp({ body: ' '.repeat(512 * 1024 + 1) })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

it('performs a real stdio child-process handshake and calls the shared server implementation', async () => {
  const client = new Client({ name: 'computer-use-stdio-test', version: '1' });
  clients.push(client);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./test-fixtures/mcp-worker.mjs', import.meta.url))],
    env: { TEST_MCP_TOKEN: token }, stderr: 'pipe',
  });
  await client.connect(transport);
  expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([...toolNames].sort());
  const result = await client.callTool({ name: 'doctor', arguments: {} });
  expect(result.structuredContent).toEqual({ method: 'doctor', state: 'fixture-ready' });
});
