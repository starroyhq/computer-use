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
  effect?: 'confirmed' | 'unconfirmed';
  error?: { code: string; message: string };
};
// 旧版把"已派发但效果未确认"记为 unknown，加载时按原文识别并迁移为 executed + effect。
const LEGACY_UNCONFIRMED =
  'Driver finished dispatch, but its effect is unconfirmed. Inspect or explicitly verify the target; do not replay blindly.';
const recordSchema = z.object({
  requestId: z.string(),
  clientId: z.string(),
  sessionId: z.string(),
  fingerprint: z.string(),
  type: z.string(),
  state: z.enum(['queued', 'running', 'executed', 'verified', 'failed', 'cancelled', 'unknown']),
  updatedAt: z.number(),
  effect: z.enum(['confirmed', 'unconfirmed']).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
// 只淘汰终态记录；被淘汰的 requestId 不再去重，因此保留期要远长于任何客户端的重试窗口。
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const RETAINED_RECORDS = 500;
export class ActionStore {
  readonly records = new Map<string, ActionRecord>();
  private writeTail: Promise<void> = Promise.resolve();
  private readonly path: string;
  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.path = join(dataDir, 'actions.json');
  }
  private prune(): void {
    const terminal = [...this.records.values()].filter(record => record.state !== 'queued' && record.state !== 'running');
    const cutoff = this.now() - RETENTION_MS;
    const excess = terminal.length - RETAINED_RECORDS;
    const oldest = excess > 0 ? new Set(terminal.sort((a, b) => a.updatedAt - b.updatedAt).slice(0, excess)) : new Set<ActionRecord>();
    for (const record of terminal) if (record.updatedAt < cutoff || oldest.has(record)) this.records.delete(record.requestId);
  }
  async load(): Promise<void> {
    const parsed = z.array(recordSchema).safeParse((await readJson(this.path)) ?? []);
    if (!parsed.success) throw new CuError('unavailable', 'Action journal is invalid.');
    for (const raw of parsed.data) {
      const { error, effect, ...rest } = raw;
      const record: ActionRecord = { ...rest, ...(effect ? { effect } : {}), ...(error ? { error } : {}) };
      if (record.state === 'unknown' && record.error?.message === LEGACY_UNCONFIRMED) {
        record.state = 'executed';
        record.effect = 'unconfirmed';
        delete record.error;
      }
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
    this.prune();
    const snapshot = [...this.records.values()].map(v => structuredClone(v));
    const operation = this.writeTail.then(() => atomicJson(this.path, snapshot));
    this.writeTail = operation.catch(() => {});
    await operation;
  }
}
