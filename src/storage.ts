import { createHash, timingSafeEqual } from 'node:crypto';
import { renameSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  grant: z.object({
    appIds: z.array(z.string()),
    allApps: z.boolean().default(false),
    browser: z.boolean(),
    foreground: z.boolean().default(false),
  }),
});
export type PreparedClientSnapshot = { commit(): void; discard(): Promise<void> };
export async function prepareClientSnapshot(path: string, value: unknown): Promise<PreparedClientSnapshot> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await chmod(temporary, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return {
    // 最后的授权检查、原子替换与内存提交之间不能 await，否则停止/撤销会落在已写盘但未生效的间隙。
    commit: () => renameSync(temporary, path),
    discard: () => rm(temporary, { force: true }),
  };
}
export class ClientStore {
  readonly clients = new Map<string, Client>();
  private writeTail: Promise<void> = Promise.resolve();
  private readonly revoked = new Set<string>();
  private revision = 0;
  constructor(
    private readonly path: string,
    private readonly prepare: typeof prepareClientSnapshot = prepareClientSnapshot,
  ) {}
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
  private enqueue(update: () => Promise<void>): Promise<void> {
    const operation = this.writeTail.then(update);
    this.writeTail = operation.catch(() => {});
    return operation;
  }
  // 只等待已排队的保存；失败仍由各操作的原始 Promise 向调用方报告。
  flush(): Promise<void> {
    return this.writeTail;
  }
  private snapshot(replacement?: Client): Client[] {
    const next = new Map(this.clients);
    if (replacement) next.set(replacement.id, replacement);
    return structuredClone([...next.values()]);
  }
  private async persist(replacement?: Client, validate: () => void = () => {}): Promise<void> {
    const storageError = () => new CuError('unavailable', 'Could not save client authorization. Review local storage in the app.');
    for (;;) {
      validate();
      const revision = this.revision;
      let staged: PreparedClientSnapshot;
      try {
        staged = await this.prepare(this.path, this.snapshot(replacement));
      } catch {
        throw storageError();
      }
      let failure: unknown;
      let failed = false;
      try {
        validate();
        // 撤销在队列外立即失效；准备文件时发生任何撤销，都要基于最新认证表重新准备。
        if (revision === this.revision) {
          try {
            staged.commit();
          } catch {
            throw storageError();
          }
          if (replacement) {
            this.clients.set(replacement.id, replacement);
            this.revision++;
          }
          return;
        }
      } catch (error) {
        failure = error;
        failed = true;
      }
      try {
        await staged.discard();
      } catch {
        throw storageError();
      }
      if (failed) throw failure;
    }
  }
  // 所有写入在队列执行时读取最新状态。扩大权限的候选对象在落盘前不进入认证表。
  save(): Promise<void> {
    return this.enqueue(() => this.persist());
  }
  add(client: Client, active: () => boolean): Promise<void> {
    const candidate = structuredClone(client);
    return this.enqueue(async () => {
      await this.persist(candidate, () => {
        if (this.clients.has(candidate.id) || this.revoked.has(candidate.id)) throw new CuError('unauthorized', 'Client is unavailable.');
        if (!active()) throw new CuError('unavailable', 'Runtime stopped before authorization was saved.');
      });
    });
  }
  grantAllApps(clientId: string, active: () => boolean): Promise<void> {
    return this.enqueue(async () => {
      const client = this.clients.get(clientId);
      if (!client || this.revoked.has(clientId)) throw new CuError('not_found', 'Client no longer exists or was revoked.');
      if (!active()) throw new CuError('unavailable', 'Runtime stopped; review its state in the local app.');
      if (client.grant.allApps !== true && client.grant.appIds.length === 0)
        throw new CuError('permission_denied', 'Browser-only clients cannot be upgraded to desktop access.');
      if (client.grant.allApps === true && client.grant.foreground === true && client.grant.appIds.length === 0) return;
      const candidate: Client = {
        ...client,
        grant: { ...client.grant, allApps: true, appIds: [], foreground: true },
      };
      await this.persist(candidate, () => {
        if (!active() || this.revoked.has(clientId) || this.clients.get(clientId) !== client)
          throw new CuError(
            this.revoked.has(clientId) ? 'not_found' : 'unavailable',
            'Authorization changed or service stopped before completion.',
          );
      });
    });
  }
  revoke(clientId: string): Promise<void> {
    this.revoked.add(clientId);
    this.clients.delete(clientId);
    this.revision++;
    return this.save();
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
  // 只记固定代码、固定文案和字符计数，不含输入内容。
  warning?: { code: string; message: string };
  progress?: { delivered: number; total: number };
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
  warning: z.object({ code: z.string(), message: z.string() }).optional(),
  progress: z.object({ delivered: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).optional(),
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
      const { error, effect, warning, progress, ...rest } = raw;
      const record: ActionRecord = {
        ...rest,
        ...(effect ? { effect } : {}),
        ...(error ? { error } : {}),
        ...(warning ? { warning } : {}),
        ...(progress ? { progress } : {}),
      };
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
