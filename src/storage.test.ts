import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ActionStore,
  ClientStore,
  atomicJson,
  hash,
  matchesHash,
  privateDirectory,
  prepareClientSnapshot,
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
    // 旧配对缺失的权限字段按未授予加载，不能升级成全应用或前台授权。
    expect(restored.authenticate(token)).toEqual({ ...client, grant: { ...client.grant, allApps: false, foreground: false } });
    for (const invalid of [undefined, '', 'bad', 'x'.repeat(513)]) expect(() => restored.authenticate(invalid)).toThrow();
    expect(matchesHash(token, 'invalid')).toBe(false);
    expect(matchesHash(token, hash(token))).toBe(true);
    await atomicJson(file, [{ ...client, tokenHash: 'invalid' }]);
    await expect(new ClientStore(file).load()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('persists all-app authorization explicitly and rejects malformed scope flags', async () => {
    const file = join(directory, 'clients.json');
    const store = new ClientStore(file);
    const client = {
      id: 'all-apps',
      name: 'All apps',
      tokenHash: hash('all-apps-test-token'),
      grant: { appIds: [], allApps: true, browser: false, foreground: true },
    };
    store.clients.set(client.id, client);
    await store.save();
    const restored = new ClientStore(file);
    await restored.load();
    expect(restored.authenticate('all-apps-test-token')).toEqual(client);
    await atomicJson(file, [{ ...client, grant: { ...client.grant, allApps: 'true' } }]);
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

  it('does not expose an expanded grant before persistence and leaves the old grant after a write failure', async () => {
    const file = join(directory, 'clients.json');
    const writer = vi.fn(prepareClientSnapshot);
    const store = new ClientStore(file, writer);
    const token = 'existing-token';
    const client = {
      id: 'existing',
      name: 'Existing',
      tokenHash: hash(token),
      grant: { appIds: ['com.example.Editor'], browser: true, foreground: false },
    };
    await store.add(client, () => true);
    let complete!: () => void;
    const gate = new Promise<void>(resolve => {
      complete = resolve;
    });
    writer.mockImplementationOnce(async (path, value) => {
      await gate;
      return prepareClientSnapshot(path, value);
    });
    const pending = store.grantAllApps(client.id, () => true);
    await vi.waitFor(() => expect(writer).toHaveBeenCalledTimes(2));
    expect(store.authenticate(token)).toEqual(client);
    expect(await readJson(file)).toEqual([client]);
    complete();
    await pending;
    expect(store.authenticate(token)).toMatchObject({ grant: { allApps: true, appIds: [], foreground: true, browser: true } });

    const other = { ...client, id: 'failure', tokenHash: hash('failure-token') };
    await store.add(other, () => true);
    writer.mockRejectedValueOnce(new Error('private path or credential must not leak'));
    await expect(store.grantAllApps(other.id, () => true)).rejects.toMatchObject({ code: 'unavailable' });
    expect(store.authenticate('failure-token')).toEqual(other);
    expect(((await readJson(file)) as (typeof client)[]).find(value => value.id === other.id)).toEqual(other);
  });

  it('revokes immediately while an upgrade is saving and never resurrects it on disk or in memory', async () => {
    const file = join(directory, 'clients.json');
    const writer = vi.fn(prepareClientSnapshot);
    const store = new ClientStore(file, writer);
    const token = 'revoked-during-upgrade';
    const client = { id: 'revoked', name: 'Old', tokenHash: hash(token), grant: { appIds: ['com.example.Editor'], browser: false } };
    await store.add(client, () => true);
    let complete!: () => void;
    const gate = new Promise<void>(resolve => {
      complete = resolve;
    });
    writer.mockImplementationOnce(async (path, value) => {
      await gate;
      return prepareClientSnapshot(path, value);
    });
    const upgraded = store.grantAllApps(client.id, () => true);
    const rejected = expect(upgraded).rejects.toMatchObject({ code: 'not_found' });
    await vi.waitFor(() => expect(writer).toHaveBeenCalledTimes(2));
    const revoked = store.revoke(client.id);
    expect(() => store.authenticate(token)).toThrow();
    complete();
    await Promise.all([rejected, revoked]);
    expect(await readJson(file)).toEqual([]);
    await expect(store.grantAllApps(client.id, () => true)).rejects.toMatchObject({ code: 'not_found' });
    const loaded = new ClientStore(file);
    await loaded.load();
    expect(() => loaded.authenticate(token)).toThrow();
  });

  it('serializes new pairings with upgrades and discards a grant interrupted before commit', async () => {
    const file = join(directory, 'clients.json');
    const writer = vi.fn(prepareClientSnapshot);
    const store = new ClientStore(file, writer);
    const first = { id: 'first', name: 'First', tokenHash: hash('first-token'), grant: { appIds: ['com.example.Editor'], browser: false } };
    const second = { ...first, id: 'second', tokenHash: hash('second-token') };
    await store.add(first, () => true);
    await Promise.all([store.grantAllApps(first.id, () => true), store.add(second, () => true)]);
    expect(await readJson(file)).toEqual([store.authenticate('first-token'), second]);
    const count = writer.mock.calls.length;
    await store.grantAllApps(first.id, () => true);
    expect(writer).toHaveBeenCalledTimes(count);
    let active = true;
    writer.mockImplementationOnce(async (path, value) => {
      const staged = await prepareClientSnapshot(path, value);
      active = false;
      return staged;
    });
    await expect(store.grantAllApps(second.id, () => active)).rejects.toMatchObject({ code: 'unavailable' });
    expect(store.authenticate('second-token')).toEqual(second);
    expect(await readJson(file)).toEqual([store.authenticate('first-token'), second]);
  });

  it('does not authenticate new credentials while pairing is being saved or after an interrupted approval', async () => {
    const file = join(directory, 'clients.json');
    const token = 'not-active-until-saved';
    let active = true;
    let store!: ClientStore;
    const writer = vi.fn(async (path: string, value: unknown) => {
      expect(() => store.authenticate(token)).toThrow();
      const staged = await prepareClientSnapshot(path, value);
      active = false;
      return staged;
    });
    store = new ClientStore(file, writer);
    await expect(
      store.add({ id: 'pending', name: 'Pending', tokenHash: hash(token), grant: { appIds: ['app'], browser: false } }, () => active),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(await readJson(file)).toBeUndefined();
    expect(() => store.authenticate(token)).toThrow();
  });

  it('keeps the persisted grant restricted when stop is followed by temporary-file cleanup failure', async () => {
    const file = join(directory, 'clients.json');
    const writer = vi.fn(prepareClientSnapshot);
    const store = new ClientStore(file, writer);
    const client = {
      id: 'interrupted',
      name: 'Old',
      tokenHash: hash('old-token'),
      grant: { appIds: ['com.example.Editor'], browser: false },
    };
    await store.add(client, () => true);
    let active = true;
    writer.mockImplementationOnce(async (path, value) => {
      const staged = await prepareClientSnapshot(path, value);
      active = false;
      return {
        ...staged,
        discard: async () => {
          throw new Error('cleanup failed');
        },
      };
    });
    await expect(store.grantAllApps(client.id, () => active)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await readJson(file)).toEqual([client]);
    const restarted = new ClientStore(file);
    await restarted.load();
    expect(restarted.authenticate('old-token').grant.allApps).toBe(false);
  });

  it('does not commit a stale snapshot after another client is revoked during preparation', async () => {
    const file = join(directory, 'clients.json');
    const writer = vi.fn(prepareClientSnapshot);
    const store = new ClientStore(file, writer);
    const client = {
      id: 'upgrading',
      name: 'Old',
      tokenHash: hash('kept-token'),
      grant: { appIds: ['com.example.Editor'], browser: false },
    };
    const revoked = { ...client, id: 'revoking', tokenHash: hash('removed-token') };
    await store.add(client, () => true);
    await store.add(revoked, () => true);
    let revocation: Promise<void> | undefined;
    let staleCommitted = false;
    writer.mockImplementationOnce(async (path, value) => {
      const staged = await prepareClientSnapshot(path, value);
      revocation = store.revoke(revoked.id);
      return {
        ...staged,
        commit: () => {
          staleCommitted = true;
          staged.commit();
        },
      };
    });
    await store.grantAllApps(client.id, () => true);
    await revocation;
    expect(staleCommitted).toBe(false);
    expect(await readJson(file)).toEqual([store.authenticate('kept-token')]);
    expect(() => store.authenticate('removed-token')).toThrow();
  });

  it('recovers queued and running work as unknown without replaying successful actions', async () => {
    const original = new ActionStore(directory, () => 1);
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
    const restored = new ActionStore(directory, () => 1);
    await restored.load();
    for (const state of ['queued', 'running'])
      expect(restored.records.get(state)).toMatchObject({ state: 'unknown', error: { code: 'unknown_outcome' } });
    for (const state of states.slice(2)) expect(restored.records.get(state)?.state).toBe(state);
    const persisted = (await readJson(join(directory, 'actions.json'))) as ActionRecord[];
    expect(persisted.filter(record => record.state === 'queued' || record.state === 'running')).toEqual([]);

    // Repeated recovery must not make an interrupted dispatch eligible to run again.
    const recoveredAgain = new ActionStore(directory, () => 2);
    await recoveredAgain.load();
    expect([...recoveredAgain.records.values()]).toEqual([...restored.records.values()]);
    for (const state of ['queued', 'running'])
      expect(recoveredAgain.records.get(state)).toMatchObject({
        requestId: state,
        clientId: 'client',
        sessionId: 'session',
        fingerprint: hash(state),
        state: 'unknown',
        error: { code: 'unknown_outcome' },
      });
  });

  it('captures each action journal save and excludes action text and image content', async () => {
    const store = new ActionStore(directory, () => 1);
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

  it('migrates legacy unconfirmed dispatch records and keeps genuine unknown outcomes', async () => {
    const base = { clientId: 'client', sessionId: 'session', fingerprint: hash('x'), type: 'key', updatedAt: 1 };
    const legacy =
      'Driver finished dispatch, but its effect is unconfirmed. Inspect or explicitly verify the target; do not replay blindly.';
    await atomicJson(join(directory, 'actions.json'), [
      { ...base, requestId: 'legacy', state: 'unknown', error: { code: 'unknown_outcome', message: legacy } },
      { ...base, requestId: 'lost', state: 'unknown', error: { code: 'unknown_outcome', message: 'Connection lost.' } },
    ]);
    const store = new ActionStore(directory, () => 1);
    await store.load();
    expect(store.records.get('legacy')).toEqual({ ...base, requestId: 'legacy', state: 'executed', effect: 'unconfirmed' });
    expect(store.records.get('lost')).toMatchObject({ state: 'unknown', error: { code: 'unknown_outcome' } });
  });

  it('prunes expired and excess terminal records but never in-flight work', async () => {
    const day = 24 * 60 * 60_000;
    let now = 10 * day;
    const store = new ActionStore(directory, () => now);
    const add = (requestId: string, state: ActionState, updatedAt: number) =>
      store.records.set(requestId, {
        requestId,
        clientId: 'c',
        sessionId: 's',
        fingerprint: hash(requestId),
        type: 'key',
        state,
        updatedAt,
      });
    add('old-done', 'executed', 2 * day);
    add('old-running', 'running', 2 * day);
    add('recent', 'failed', 9 * day);
    await store.save();
    expect([...store.records.keys()].sort()).toEqual(['old-running', 'recent']);
    for (let index = 0; index < 505; index++) add(`bulk-${index}`, 'executed', 9 * day + index + 1);
    now = 10 * day + 1;
    await store.save();
    expect(store.records.size).toBe(501);
    expect(store.records.has('old-running')).toBe(true);
    expect(store.records.has('recent')).toBe(false);
    expect(store.records.has('bulk-5')).toBe(true);
    expect(store.records.has('bulk-4')).toBe(false);
  });

  it('rejects a malformed journal rather than silently discarding uncertain work', async () => {
    await atomicJson(join(directory, 'actions.json'), [{ requestId: 'r', state: 'nonsense' }]);
    await expect(new ActionStore(directory, () => 1).load()).rejects.toMatchObject({ code: 'unavailable' });
  });
});
