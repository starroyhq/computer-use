import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ActionStore,
  ClientStore,
  atomicJson,
  hash,
  matchesHash,
  privateDirectory,
  readJson,
  type ActionRecord,
  type ActionState,
} from './storage.js';

describe('private persisted state', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cu-storage-test-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('writes JSON atomically with private filesystem modes', async () => {
    const folder = join(directory, 'state'),
      file = join(folder, 'value.json');
    await privateDirectory(folder);
    await atomicJson(file, { value: 1 });
    await atomicJson(file, { value: 2 });
    expect(await readJson(file)).toEqual({ value: 2 });
    if (process.platform !== 'win32') {
      expect((await stat(folder)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it('distinguishes absent state from malformed state without leaking file content', async () => {
    const file = join(directory, 'broken.json');
    expect(await readJson(file)).toBeUndefined();
    await writeFile(file, 'private broken credential');
    await expect(readJson(file)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(readJson(file)).rejects.not.toHaveProperty('message', expect.stringContaining('private broken credential'));
  });

  it('persists hashes rather than credentials and fails closed on corrupted authorizations', async () => {
    const file = join(directory, 'clients.json'),
      token = 'secret-token-for-test';
    const store = new ClientStore(file);
    await store.load();
    const client = { id: 'a', name: 'Agent', tokenHash: hash(token), grant: { appIds: ['com.example.Editor'], browser: false } };
    store.clients.set(client.id, client);
    await store.save();
    expect(await readFile(file, 'utf8')).not.toContain(token);
    const restored = new ClientStore(file);
    await restored.load();
    // 旧版配对没有 foreground 字段：按未授予前台加载，不会被静默提升。
    expect(restored.authenticate(token)).toEqual({ ...client, grant: { ...client.grant, foreground: false } });
    for (const invalid of [undefined, '', 'bad', 'x'.repeat(513)]) expect(() => restored.authenticate(invalid)).toThrow();
    expect(matchesHash(token, 'invalid')).toBe(false);
    expect(matchesHash(token, hash(token))).toBe(true);
    await atomicJson(file, [{ ...client, tokenHash: 'invalid' }]);
    await expect(new ClientStore(file).load()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('serializes concurrent saves so the newest revocation persists', async () => {
    const file = join(directory, 'clients.json'),
      store = new ClientStore(file);
    store.clients.set('a', { id: 'a', name: 'Agent', tokenHash: hash('token'), grant: { appIds: ['com.example.Editor'], browser: false } });
    const first = store.save();
    store.clients.delete('a');
    const second = store.save();
    await Promise.all([first, second]);
    expect(await readJson(file)).toEqual([]);
  });

  it('recovers queued and running work as unknown without replaying successful actions', async () => {
    const original = new ActionStore(directory);
    const states: ActionState[] = ['queued', 'running', 'executed', 'verified', 'failed', 'cancelled', 'unknown'];
    for (const state of states)
      original.records.set(state, {
        requestId: state,
        clientId: 'client',
        sessionId: 'session',
        fingerprint: hash(state),
        type: 'type',
        state,
        updatedAt: 1,
      });
    await original.save();
    const restored = new ActionStore(directory);
    await restored.load();
    for (const state of ['queued', 'running'])
      expect(restored.records.get(state)).toMatchObject({ state: 'unknown', error: { code: 'unknown_outcome' } });
    for (const state of states.slice(2)) expect(restored.records.get(state)?.state).toBe(state);
    const persisted = (await readJson(join(directory, 'actions.json'))) as ActionRecord[];
    expect(persisted.filter(record => record.state === 'queued' || record.state === 'running')).toEqual([]);
  });

  it('captures each action journal save and excludes action text and image content', async () => {
    const store = new ActionStore(directory);
    const record: ActionRecord = {
      requestId: 'request',
      clientId: 'client',
      sessionId: 'session',
      fingerprint: hash('secret content'),
      type: 'type',
      state: 'queued',
      updatedAt: 1,
    };
    store.records.set(record.requestId, record);
    const first = store.save();
    record.state = 'executed';
    record.updatedAt = 2;
    const second = store.save();
    await Promise.all([first, second]);
    const text = await readFile(join(directory, 'actions.json'), 'utf8');
    expect(text).not.toContain('secret content');
    expect(JSON.parse(text)).toEqual([record]);
  });

  it('rejects a malformed journal rather than silently discarding uncertain work', async () => {
    await atomicJson(join(directory, 'actions.json'), [{ requestId: 'r', state: 'nonsense' }]);
    await expect(new ActionStore(directory).load()).rejects.toMatchObject({ code: 'unavailable' });
  });
});
