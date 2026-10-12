import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportSkill, instructions, preflight, setupPrompt, writeSkill } from './skill.js';

let directory: string;
const closers: Array<() => Promise<void>> = [];
const token = 'test-credential-never-export-this-token';
const paths = { node: "C:\\安装 $& $' quotes\\node.exe", cli: '/Applications/$`fence```/cli.js' };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cu-skill-'));
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await rm(directory, { recursive: true, force: true });
});
const missingSocket = () =>
  Promise.resolve(process.platform === 'win32' ? `\\\\.\\pipe\\cu-missing-${randomUUID()}` : `/tmp/cu-${randomUUID()}`);
function options(profile = 'default') {
  return { profile, paths, data: directory, credentials: directory, discover: missingSocket };
}
async function credential(name = 'default') {
  await writeFile(join(directory, `${name}.json`), JSON.stringify({ clientId: 'test-client', token }));
}
async function server(reply: (request: { method: string; token: string; id: string }, socket: Socket) => void) {
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\cu-preflight-${randomUUID()}` : `/tmp/cu-${randomUUID()}.sock`;
  const sockets = new Set<Socket>();
  const listener = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let data = '';
    socket.on('data', chunk => {
      data += chunk.toString();
      if (data.includes('\n')) reply(JSON.parse(data), socket);
    });
  });
  await new Promise<void>((done, reject) => {
    listener.once('error', reject);
    listener.listen(path, done);
  });
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done, reject) => listener.close(error => (error ? reject(error) : done())));
  });
  return path;
}

describe('local onboarding', () => {
  it('creates a short Agent-neutral setup prompt with safe hints and no embedded installation scripts', async () => {
    await credential();
    const prompt = setupPrompt('existing-agent', paths);
    expect(prompt).toContain('skill export --profile existing-agent');
    expect(prompt).toContain('保留用户自定义改动');
    expect(prompt).toContain('首次配对由我在本机批准');
    expect(prompt).not.toMatch(/\.codex|\.claude|```bash|```powershell/);
    expect(prompt).not.toContain(token);
    expect(prompt).not.toContain('test-client');
    expect(prompt.length).toBeLessThan(2200);
    expect(JSON.parse(prompt.split('```json\n')[1]!.split('```')[0]!)).toMatchObject({ profile: 'existing-agent', ...paths });
    expect(() => setupPrompt('../invalid', paths)).toThrow('Invalid profile');
  });
  it('exports a self-contained Skill and escaped non-secret hints without reading credentials', async () => {
    await credential();
    const text = await exportSkill('existing-agent', paths);
    expect(text).toContain('name: computer-use');
    expect(text).toContain('existing-agent');
    expect(text.indexOf('"profile": "existing-agent"')).toBeLessThan(text.indexOf('## First connection'));
    expect(text).not.toContain('--profile default');
    expect(text).not.toContain(token);
    expect(text).not.toContain('test-client');
    const binding = JSON.parse(text.split('```json\n').at(-1)!.split('```')[0]!);
    expect(binding).toMatchObject({ schemaVersion: 1, profile: 'existing-agent', ...paths });
    expect(text).not.toContain('/`fence```/');
  });
  it('never overwrites an existing export', async () => {
    const destination = join(directory, 'SKILL.md');
    await writeSkill(destination, 'original');
    await expect(writeSkill(destination, 'replacement')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await readFile(destination, 'utf8')).toBe('original');
  });
  it('reports missing package resources without returning partial output', async () => {
    await expect(exportSkill('default', paths, directory)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(instructions(directory)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('has no first-use writes or pairing requirement', async () => {
    const credentials = join(directory, 'not-created');
    const result = await preflight({ ...options(), credentials });
    expect(result.profile.state).toBe('missing');
    expect(result.host.state).toBe('offline');
    expect(result.profiles).toEqual([]);
    await expect(stat(credentials)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not mistake an offline saved credential for a valid grant or change it', async () => {
    await credential();
    const before = await readFile(join(directory, 'default.json'), 'utf8');
    const result = await preflight(options());
    expect(result.profile.state).toBe('unverified');
    expect(result.profiles).toEqual(['default']);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(await readFile(join(directory, 'default.json'), 'utf8')).toBe(before);
  });
  it('reports malformed credentials as invalid and only lists valid profile names', async () => {
    await writeFile(join(directory, 'default.json'), '{broken');
    await writeFile(join(directory, 'not a profile.json'), '{}');
    await writeFile(join(directory, 'notes.txt'), 'notes');
    const result = await preflight(options());
    expect(result.profile.state).toBe('invalid');
    expect(result.profiles).toEqual(['default']);
  });
  it.each(['paused', 'stopped'] as const)('reports persistent %s without starting or resuming anything', async reason => {
    await writeFile(join(directory, 'host-state.json'), JSON.stringify({ state: 'exited', autoStartBlocked: true, blockedReason: reason }));
    expect((await preflight(options())).host.state).toBe(reason);
  });
  it('verifies a credential only through the read-only capabilities method', async () => {
    await credential();
    const methods: string[] = [];
    const socket = await server((request, peer) => {
      methods.push(request.method);
      expect(request.token).toBe(token);
      peer.end(JSON.stringify({ id: request.id, result: { paused: true, stopped: false } }) + '\n');
    });
    const result = await preflight({ ...options(), socket });
    expect(result.profile.state).toBe('valid');
    expect(result.host.state).toBe('paused');
    expect(methods).toEqual(['capabilities']);
  });
  it('keeps rejected credentials and reports unauthorized without re-pairing', async () => {
    await credential();
    const socket = await server((request, peer) =>
      peer.end(JSON.stringify({ id: request.id, error: { code: 'unauthorized', message: 'Invalid or revoked.' } }) + '\n'),
    );
    const result = await preflight({ ...options(), socket });
    expect(result.profile.state).toBe('unauthorized');
    expect(await readFile(join(directory, 'default.json'), 'utf8')).toContain(token);
  });
  it('bounds an unresponsive existing runtime instead of hanging the connection pane', async () => {
    await credential();
    const socket = await server(() => {});
    const started = Date.now();
    const result = await preflight({ ...options(), socket });
    expect(result.profile.state).toBe('unverified');
    expect(result.host.state).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(4000);
  });
  it('does not report a reachable but broken runtime as running', async () => {
    await credential();
    const socket = await server((_request, peer) => peer.end('not-json\n'));
    const result = await preflight({ ...options(), socket });
    expect(result.host.state).toBe('unavailable');
    expect(result.profile.state).toBe('unverified');
  });
});

async function cli(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, [resolve('dist/cli.js'), ...args], {
      env: { ...process.env, HOME: directory, USERPROFILE: directory, LOCALAPPDATA: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', code => done({ code, stdout, stderr }));
  });
}
describe('unpaired CLI integration on both platforms', () => {
  it('prints instructions and exports a profile-bound Skill from a fresh user directory', async () => {
    const manual = await cli(['instructions']);
    expect(manual.code).toBe(0);
    expect(manual.stdout).toContain('Computer Use');
    const prompt = await cli(['skill', 'prompt', '--profile', 'agent-2']);
    expect(prompt.code).toBe(0);
    expect(prompt.stdout).toContain('skill export --profile agent-2');
    expect(prompt.stdout).toContain('"profile": "agent-2"');
    const exported = await cli(['skill', 'export', '--profile', 'agent-2']);
    expect(exported.code).toBe(0);
    expect(exported.stdout).toContain('"profile": "agent-2"');
    const output = join(directory, 'SKILL.md');
    expect((await cli(['skill', 'export', '--out', output])).code).toBe(0);
    expect((await cli(['skill', 'export', '--out', output])).code).not.toBe(0);
  });
  it('preflights without creating a profile and rejects unsafe profile names', async () => {
    const result = await cli(['preflight', '--profile', 'new-agent']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).profile).toEqual({ name: 'new-agent', state: 'missing' });
    expect((await cli(['skill', 'export', '--profile', '../invalid'])).code).not.toBe(0);
    expect((await cli(['preflight', '--profile', '../invalid'])).code).not.toBe(0);
  });
});
