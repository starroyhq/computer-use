import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CuError, type Client } from './contracts.js';

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function matchesHash(value: string, expected: string): boolean {
  const actual = Buffer.from(hash(value), 'hex');
  const stored = Buffer.from(expected, 'hex');
  return stored.length === actual.length && timingSafeEqual(actual, stored);
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
export async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CuError('unavailable', 'Local state is unreadable; repair it before starting the runtime.');
  }
}
const clientSchema = z.object({
  id: z.string(),
  name: z.string(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  grant: z.object({ appIds: z.array(z.string()), browser: z.boolean(), foreground: z.boolean().default(false) }),
});
export class ClientStore {
  readonly clients = new Map<string, Client>();
  private writeTail: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  async load(): Promise<void> {
    const raw = await readJson(this.path);
    const parsed = z.array(clientSchema).safeParse(raw ?? []);
    if (!parsed.success) throw new CuError('unavailable', 'Client authorization store is invalid.');
    for (const client of parsed.data) this.clients.set(client.id, client);
  }
  authenticate(token: string | undefined): Client {
    if (!token || token.length > 512) throw new CuError('unauthorized', 'Pair this client with the local app first.');
    const client = [...this.clients.values()].find(c => matchesHash(token, c.tokenHash));
    if (!client) throw new CuError('unauthorized', 'Client credential is invalid or revoked.');
    return client;
  }
  async save(): Promise<void> {
    const snapshot = [...this.clients.values()];
    const operation = this.writeTail.then(() => atomicJson(this.path, snapshot));
    this.writeTail = operation.catch(() => {});
    await operation;
  }
}
export type ActionState = 'queued' | 'running' | 'executed' | 'verified' | 'failed' | 'cancelled' | 'unknown';
export type ActionRecord = {
  requestId: string;
  clientId: string;
  sessionId: string;
  fingerprint: string;
  type: string;
  state: ActionState;
  updatedAt: number;
  error?: { code: string; message: string };
};
const recordSchema = z.object({
  requestId: z.string(),
  clientId: z.string(),
  sessionId: z.string(),
  fingerprint: z.string(),
  type: z.string(),
  state: z.enum(['queued', 'running', 'executed', 'verified', 'failed', 'cancelled', 'unknown']),
  updatedAt: z.number(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export class ActionStore {
  readonly records = new Map<string, ActionRecord>();
  private writeTail: Promise<void> = Promise.resolve();
  private readonly path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, 'actions.json');
  }
  async load(): Promise<void> {
    const parsed = z.array(recordSchema).safeParse((await readJson(this.path)) ?? []);
    if (!parsed.success) throw new CuError('unavailable', 'Action journal is invalid.');
    for (const raw of parsed.data) {
      const { error, ...rest } = raw;
      const record: ActionRecord = error ? { ...rest, error } : rest;
      if (record.state === 'running' || record.state === 'queued') {
        record.state = 'unknown';
        record.error = { code: 'unknown_outcome', message: 'Runtime restarted; inspect the target before taking another action.' };
      }
      this.records.set(record.requestId, record);
    }
    await this.save();
  }
  async save(): Promise<void> {
    // The journal deliberately excludes arguments, window titles and screenshot content.
    const snapshot = [...this.records.values()].map(v => structuredClone(v));
    const operation = this.writeTail.then(() => atomicJson(this.path, snapshot));
    this.writeTail = operation.catch(() => {});
    await operation;
  }
}
