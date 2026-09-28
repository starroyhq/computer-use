import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Runtime } from './runtime.js';
import { CuError, type Backend, type BackendObservation, type HostEvent, type Target } from './contracts.js';

const target: Target = { id: 'window-1', kind: 'desktop', appId: 'com.example.Editor', title: 'Test document' };
const secretTarget: Target = { ...target, id: 'window-private', appId: 'com.example.Private' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fakeBackend(): Backend {
  return {
    kind: 'desktop',
    doctor: vi.fn(async () => ({ available: true, checks: [] })),
    targets: vi.fn(async () => [target, secretTarget]),
    observe: vi.fn(async (requested: Target): Promise<BackendObservation> => ({ target: requested, bounds: { x: 100, y: 100, width: 200, height: 100 }, imageWidth: 400, imageHeight: 200, elements: [{ id: 'button-1', label: 'Save', role: 'button' }], screenshot: { mimeType: 'image/png', data: 'cGl4ZWxz' }, backendState: { private: 'must not leak' } })),
    validate: vi.fn(async () => true),
    act: vi.fn(async () => {}), cancel: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
}

describe('Runtime authorization and execution', () => {
  let directory: string;
  let runtime: Runtime;
  let backend: Backend;
  let events: HostEvent[];
  let clock: number;
  const call = <T = Record<string, unknown>>(token: string | undefined, method: string, params: unknown = {}) => runtime.call(token, method, params) as Promise<T>;
  async function pair(name = 'Test Agent', allow = true) {
    const pending = call<{ token: string; clientId: string }>(undefined, 'pair', { name, appIds: [target.appId, target.appId], browser: false });
    const event = events.findLast(e => e.event === 'pair_request');
    if (event?.event !== 'pair_request') throw new Error('Pair request not emitted');
    await runtime.control({ command: allow ? 'pair_allow' : 'pair_deny', clientId: event.clientId });
    return pending;
  }
  async function session(token: string, exclusive = false) {
    return call<{ sessionId: string }>(token, 'session_open', { targetId: target.id, exclusive });
  }
  async function observation(token: string, sessionId: string) {
    return call<{ snapshotId: string; backendState?: unknown }>(token, 'observe', { sessionId });
  }
  async function actionInput(token: string, sessionId: string) {
    const { snapshotId } = await observation(token, sessionId);
    return { requestId: randomUUID(), sessionId, snapshotId, action: { type: 'click', point: { x: 399, y: 199 } }, timeoutMs: 1000 };
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cu-runtime-test-'));
    backend = fakeBackend(); events = []; clock = 1_000;
    runtime = new Runtime({ dataDir: directory, backends: [backend], emit: event => events.push(event), now: () => clock, platform: 'darwin' });
    await runtime.start();
  });
  afterEach(async () => { vi.useRealTimers(); await runtime.close(); await rm(directory, { recursive: true, force: true }); });

  it('notifies the host when pairing expires and ignores a late approval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = call(undefined, 'pair', { name: 'Expired', appIds: [target.appId], browser: false });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'permission_denied' });
    const request = events.findLast(e => e.event === 'pair_request');
    if (request?.event !== 'pair_request') throw new Error('Missing pair request');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    await runtime.control({ command: 'pair_allow', clientId: request.clientId });
    expect(events.filter(e => e.event === 'decision_finished')).toEqual([
      { event: 'decision_finished', requestId: request.clientId, approved: false },
    ]);
    expect(runtime.clients.clients.size).toBe(0);
  });

  it('confirms pairing only after credentials have been persisted', async () => {
    const save = vi.spyOn(runtime.clients, 'save').mockRejectedValueOnce(new Error('disk failure'));
    await expect(pair()).rejects.toThrow('disk failure');
    expect(events.findLast(e => e.event === 'decision_finished')).toMatchObject({ approved: false });
    expect(runtime.clients.clients.size).toBe(0);
    save.mockRestore();
    const client = await pair();
    expect(events.findLast(e => e.event === 'decision_finished')).toEqual({ event: 'decision_finished', requestId: client.clientId, approved: true });
    expect(JSON.parse(await readFile(join(directory, 'clients.json'), 'utf8'))).toEqual([
      expect.objectContaining({ id: client.clientId, name: 'Test Agent' }),
    ]);
  });

  it('grants foreground once at pairing and keeps it across runtime restarts without further prompts', async () => {
    const client = await pair();
    const pairRequest = events.findLast(e => e.event === 'pair_request');
    expect(pairRequest).toMatchObject({ foreground: true });
    expect(JSON.parse(await readFile(join(directory, 'clients.json'), 'utf8'))[0].grant.foreground).toBe(true);
    const first = await call<{ sessionId: string; mode: string }>(client.token, 'session_open', { targetId: target.id, mode: 'foreground' });
    expect(first.mode).toBe('foreground');
    await call(client.token, 'act', await actionInput(client.token, first.sessionId));
    expect(backend.act).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'foreground', expect.anything());
    await runtime.close();
    events = [];
    runtime = new Runtime({ dataDir: directory, backends: [backend], emit: event => events.push(event), now: () => clock, platform: 'darwin' });
    await runtime.start();
    await expect(call(client.token, 'session_open', { targetId: target.id, mode: 'foreground' })).resolves.toMatchObject({ mode: 'foreground' });
    expect(events.some(e => e.event === 'foreground_request' || e.event === 'pair_request')).toBe(false);
  });

  it('refuses foreground for revoked clients and for clients paired before foreground was included', async () => {
    const client = await pair();
    await runtime.control({ command: 'revoke', clientId: client.clientId });
    await expect(call(client.token, 'session_open', { targetId: target.id, mode: 'foreground' })).rejects.toMatchObject({ code: 'unauthorized' });
    const legacy = await pair('Legacy');
    runtime.clients.clients.get(legacy.clientId)!.grant = { appIds: [target.appId], browser: false };
    await expect(call(legacy.token, 'session_open', { targetId: target.id, mode: 'foreground' })).rejects.toMatchObject({ code: 'permission_denied', message: expect.stringContaining('pair') });
    await expect(call(legacy.token, 'session_open', { targetId: target.id })).resolves.toMatchObject({ mode: 'background' });
    expect(events.some(e => e.event === 'foreground_request')).toBe(false);
    expect(backend.act).not.toHaveBeenCalled();
  });

  it('requires local pairing approval and deduplicates the explicit application scope', async () => {
    await expect(pair('Denied', false)).rejects.toMatchObject({ code: 'permission_denied' });
    expect(runtime.clients.clients.size).toBe(0);
    const { token } = await pair();
    expect(runtime.authenticate(token).grant.appIds).toEqual([target.appId]);
    await expect(call('wrong', 'targets')).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await call(token, 'targets')).toEqual([target]);
    await expect(call(token, 'session_open', { targetId: secretTarget.id })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('isolates sessions, snapshots, and action records between clients', async () => {
    const a = await pair('A'), b = await pair('B');
    const first = await session(a.token), second = await session(b.token);
    await expect(observation(b.token, first.sessionId)).rejects.toMatchObject({ code: 'not_found' });
    const request = await actionInput(a.token, first.sessionId);
    await expect(call(b.token, 'act', { ...request, sessionId: second.sessionId })).rejects.toMatchObject({ code: 'stale_snapshot' });
    await call(a.token, 'act', request);
    await expect(call(b.token, 'action_status', { requestId: request.requestId })).rejects.toMatchObject({ code: 'not_found' });
    await expect(call(b.token, 'act', request)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not silently elevate a background session to foreground', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    await call(token, 'act', await actionInput(token, sessionId));
    expect(backend.act).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'background', expect.anything());
  });

  it('consumes snapshots after one action, replaces observations, and hides backend state', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    const first = await observation(token, sessionId);
    expect(first).not.toHaveProperty('backendState');
    const request = await actionInput(token, sessionId);
    await expect(call(token, 'act', { ...request, snapshotId: first.snapshotId })).rejects.toMatchObject({ code: 'stale_snapshot' });
    await call(token, 'act', request);
    await expect(call(token, 'act', { ...request, requestId: randomUUID() })).rejects.toMatchObject({ code: 'stale_snapshot' });
    expect(backend.act).toHaveBeenCalledTimes(1);
  });

  it('rejects expired, changed, and out-of-bounds targets before executing', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    const request = await actionInput(token, sessionId);
    await expect(call(token, 'act', { ...request, action: { type: 'click', point: { x: 400, y: 0 } } })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(call(token, 'act', { ...request, action: { type: 'click', point: { x: -1, y: 0 } } })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(call(token, 'act', { ...request, action: { type: 'click', elementId: 'foreign' } })).rejects.toMatchObject({ code: 'stale_snapshot' });
    clock += 30_001;
    await expect(call(token, 'act', request)).rejects.toMatchObject({ code: 'stale_snapshot' });
    vi.mocked(backend.validate).mockResolvedValueOnce(false);
    expect(await call(token, 'act', await actionInput(token, sessionId))).toMatchObject({ state: 'failed', error: { code: 'stale_snapshot' } });
    expect(backend.act).not.toHaveBeenCalled();
  });

  it('deduplicates identical requests and rejects ID reuse with changed arguments', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    const request = await actionInput(token, sessionId);
    const result = await call(token, 'act', request);
    expect(await call(token, 'act', request)).toEqual(result);
    await expect(call(token, 'act', { ...request, action: { type: 'key', keys: ['ENTER'] } })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(backend.act).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty('fingerprint');
    expect(result).not.toHaveProperty('clientId');
  });

  it('serializes complete actions from different sessions', async () => {
    const { token } = await pair(), first = await session(token), second = await session(token);
    const gate = deferred();
    vi.mocked(backend.act).mockImplementationOnce(async () => gate.promise);
    const a = call(token, 'act', await actionInput(token, first.sessionId));
    await vi.waitFor(() => expect(backend.act).toHaveBeenCalledTimes(1));
    const secondRequest = await actionInput(token, second.sessionId);
    const b = call(token, 'act', secondRequest);
    await vi.waitFor(() => expect(runtime.actions.records.get(secondRequest.requestId)?.state).toBe('queued'));
    expect(backend.act).toHaveBeenCalledTimes(1);
    gate.resolve();
    expect((await Promise.all([a, b])).map(r => r.state)).toEqual(['executed', 'executed']);
    expect(backend.act).toHaveBeenCalledTimes(2);
  });

  it('prevents another session from acting under an exclusive lease and expires idle leases', async () => {
    const { token } = await pair();
    const other = await session(token);
    const request = await actionInput(token, other.sessionId);
    await session(token, true);
    await expect(call(token, 'act', request)).rejects.toMatchObject({ code: 'busy' });
    await expect(session(token)).rejects.toMatchObject({ code: 'busy' });
    clock += 120_001;
    await expect(session(token)).resolves.toHaveProperty('sessionId');
  });

  it('pause rejects new actions and resume restores admission', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    const request = await actionInput(token, sessionId);
    await runtime.control({ command: 'pause' });
    await expect(call(token, 'act', request)).rejects.toMatchObject({ code: 'paused' });
    await runtime.control({ command: 'resume' });
    expect(await call(token, 'act', request)).toMatchObject({ state: 'executed' });
  });

  it('cancels queued work without interrupting the active action or halting the runtime', async () => {
    const { token } = await pair(), first = await session(token), second = await session(token);
    const gate = deferred();
    vi.mocked(backend.act).mockImplementationOnce(async () => gate.promise);
    const active = call(token, 'act', await actionInput(token, first.sessionId));
    await vi.waitFor(() => expect(backend.act).toHaveBeenCalledTimes(1));
    const queuedRequest = await actionInput(token, second.sessionId);
    const queued = call(token, 'act', queuedRequest);
    await vi.waitFor(() => expect(runtime.actions.records.get(queuedRequest.requestId)?.state).toBe('queued'));
    const cancelled = call(token, 'cancel', { requestId: queuedRequest.requestId });
    gate.resolve();
    expect(await active).toMatchObject({ state: 'executed' });
    expect(await queued).toMatchObject({ state: 'cancelled' });
    expect(await cancelled).toMatchObject({ state: 'cancelled' });
    expect(events.some(e => e.event === 'fatal')).toBe(false);
    expect(backend.act).toHaveBeenCalledTimes(1);
  });

  it.each(['cancel', 'timeout'] as const)('halts after active %s and never retries an uncertain action', async interruption => {
    const { token } = await pair(), { sessionId } = await session(token);
    vi.mocked(backend.act).mockImplementationOnce(() => new Promise(() => {}));
    const request = { ...await actionInput(token, sessionId), timeoutMs: interruption === 'timeout' ? 100 : 1000 };
    const pending = call(token, 'act', request);
    await vi.waitFor(() => expect(backend.act).toHaveBeenCalledTimes(1));
    if (interruption === 'cancel') await call(token, 'cancel', { requestId: request.requestId });
    expect(await pending).toMatchObject({ state: 'unknown', error: { code: 'unknown_outcome' } });
    expect(events.filter(e => e.event === 'fatal')).toHaveLength(1);
    await runtime.control({ command: 'resume' });
    await expect(session(token)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await call(token, 'act', request)).toMatchObject({ state: 'unknown' });
    expect(backend.act).toHaveBeenCalledTimes(1);
  });

  it('halts on an unexpected backend exception because execution may already have occurred', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    vi.mocked(backend.act).mockRejectedValueOnce(new Error('private typed text'));
    const result = await call(token, 'act', await actionInput(token, sessionId));
    expect(result).toMatchObject({ state: 'unknown', error: { code: 'internal' } });
    expect(JSON.stringify(result)).not.toContain('private typed text');
    expect(events.some(e => e.event === 'fatal')).toBe(true);
    await expect(session(token)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('reserves request IDs before persistence so concurrent duplicate submissions execute once', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    const request = await actionInput(token, sessionId), gate = deferred();
    vi.spyOn(runtime.actions, 'save').mockImplementationOnce(() => gate.promise);
    const first = call(token, 'act', request);
    let duplicateSettled = false;
    const duplicate = call(token, 'act', request).then(result => { duplicateSettled = true; return result; });
    await expect(call(token, 'act', { ...request, action: { type: 'key', keys: ['ENTER'] } })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(duplicateSettled).toBe(false);
    gate.resolve();
    expect(await duplicate).toMatchObject({ state: 'queued' });
    expect(await first).toMatchObject({ state: 'executed' });
    expect(backend.act).toHaveBeenCalledTimes(1);
  });

  it('accepts cancellation while a queued action is still being persisted', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    const request = await actionInput(token, sessionId), gate = deferred();
    vi.spyOn(runtime.actions, 'save').mockImplementationOnce(() => gate.promise);
    const pending = call(token, 'act', request);
    await vi.waitFor(() => expect(runtime.actions.save).toHaveBeenCalledTimes(1));
    const cancelled = call(token, 'cancel', { requestId: request.requestId });
    gate.resolve();
    await cancelled;
    expect(await pending).toMatchObject({ state: 'cancelled' });
    expect(backend.act).not.toHaveBeenCalled();
  });

  it('does not execute when cancelled during asynchronous target validation', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    const request = await actionInput(token, sessionId), gate = deferred();
    vi.mocked(backend.validate).mockImplementationOnce(async () => { await gate.promise; return true; });
    const pending = call(token, 'act', request);
    await vi.waitFor(() => expect(backend.validate).toHaveBeenCalledTimes(1));
    const cancelled = call(token, 'cancel', { requestId: request.requestId });
    gate.resolve();
    await cancelled;
    expect(await pending).toMatchObject({ state: 'cancelled' });
    expect(backend.act).not.toHaveBeenCalled();
  });

  it('does not open a session after its client is revoked during target enumeration', async () => {
    const { token, clientId } = await pair(), gate = deferred();
    vi.mocked(backend.targets).mockImplementationOnce(async () => { await gate.promise; return [target]; });
    const pending = session(token);
    const rejected = expect(pending).rejects.toMatchObject({ code: expect.stringMatching(/unauthorized|not_found/) });
    await runtime.control({ command: 'revoke', clientId });
    gate.resolve();
    await rejected;
  });

  it('withholds an in-flight observation when its client is revoked', async () => {
    const { token, clientId } = await pair(), { sessionId } = await session(token);
    const original = await backend.observe(target), gate = deferred();
    vi.mocked(backend.observe).mockImplementationOnce(async () => { await gate.promise; return original; });
    const pending = observation(token, sessionId);
    const rejection = expect(pending).rejects.toMatchObject({ code: expect.stringMatching(/unauthorized|not_found/) });
    await runtime.control({ command: 'revoke', clientId });
    gate.resolve();
    await rejection;
  });

  it('fails closed if the action journal cannot be persisted', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    vi.spyOn(runtime.actions, 'save').mockRejectedValueOnce(new Error('disk unavailable'));
    expect(await call(token, 'act', await actionInput(token, sessionId))).toMatchObject({ state: 'failed', error: { code: 'unavailable' } });
    expect(backend.act).not.toHaveBeenCalled();
    expect(events.find(e => e.event === 'fatal')).toMatchObject({ message: expect.stringContaining('Action journal') });
    await expect(session(token)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('enforces wait timeout when the backend observation never settles', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    vi.mocked(backend.observe).mockImplementationOnce(() => new Promise(() => {}));
    await expect(call(token, 'wait', { sessionId, timeoutMs: 100, condition: { type: 'title', includes: 'never' } })).rejects.toMatchObject({ code: 'timeout' });
    expect(events.some(event => event.event === 'fatal')).toBe(false);
  });

  it('returns the observation that satisfied a wait without starting an unbounded second read', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    const matching = await backend.observe(target);
    vi.mocked(backend.observe).mockClear().mockResolvedValueOnce(matching).mockImplementationOnce(() => new Promise(() => {}));
    expect(await call(token, 'wait', { sessionId, timeoutMs: 100, condition: { type: 'title', includes: 'Test document' } })).toMatchObject({ state: 'verified', observation: { target, screenshot: matching.screenshot } });
    expect(backend.observe).toHaveBeenCalledTimes(1);
  });

  it('enforces validation timeout before input starts and keeps the runtime usable', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    vi.mocked(backend.validate).mockImplementationOnce(() => new Promise(() => {}));
    expect(await call(token, 'act', { ...await actionInput(token, sessionId), timeoutMs: 100 })).toMatchObject({ state: 'failed', error: { code: 'timeout' } });
    expect(backend.act).not.toHaveBeenCalled();
    expect(events.some(event => event.event === 'fatal')).toBe(false);
    expect(await call(token, 'act', await actionInput(token, sessionId))).toMatchObject({ state: 'executed' });
  });

  it('cancels a validation that never settles without waiting for its timeout', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    const request = { ...await actionInput(token, sessionId), timeoutMs: 30_000 };
    vi.mocked(backend.validate).mockImplementationOnce(() => new Promise(() => {}));
    const pending = call(token, 'act', request);
    await vi.waitFor(() => expect(backend.validate).toHaveBeenCalledTimes(1));
    expect(await call(token, 'cancel', { requestId: request.requestId })).toMatchObject({ state: 'cancelled' });
    expect(await pending).toMatchObject({ state: 'cancelled' });
    expect(backend.act).not.toHaveBeenCalled();
  });

  it('persists queued requests before reporting their status behind an active gesture', async () => {
    const { token } = await pair(), { sessionId } = await session(token), gate = deferred();
    vi.mocked(backend.act).mockImplementationOnce(() => gate.promise);
    const active = call(token, 'act', await actionInput(token, sessionId));
    await vi.waitFor(() => expect(backend.act).toHaveBeenCalledTimes(1));
    const request = await actionInput(token, sessionId);
    const queued = call(token, 'act', request);
    try {
      expect(await call(token, 'action_status', { requestId: request.requestId })).toMatchObject({ state: 'queued' });
      const journal = JSON.parse(await readFile(join(directory, 'actions.json'), 'utf8')) as Array<{ requestId: string; state: string }>;
      expect(journal.find(record => record.requestId === request.requestId)).toMatchObject({ state: 'queued' });
    } finally { gate.resolve(); await Promise.all([active, queued]); }
  });

  it('does not infer absence from an incomplete element tree', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    const partial = { ...await backend.observe(target), elementsComplete: false };
    vi.mocked(backend.observe).mockResolvedValue(partial);
    const condition = { type: 'element', label: 'Missing', present: false };
    await expect(call(token, 'wait', { sessionId, timeoutMs: 100, condition })).rejects.toMatchObject({ code: 'unavailable' });
    expect(await call(token, 'act', { ...await actionInput(token, sessionId), verify: condition })).toMatchObject({ state: 'executed', error: { code: 'unavailable' } });
    expect(await call(token, 'wait', { sessionId, timeoutMs: 100, condition: { type: 'element', label: 'Save', present: true } })).toMatchObject({ state: 'verified' });
    vi.mocked(backend.observe).mockResolvedValue({ ...partial, elementsComplete: true });
    expect(await call(token, 'wait', { sessionId, timeoutMs: 100, condition })).toMatchObject({ state: 'verified' });
  });

  it('retains an unconfirmed dispatch as unknown without halting or repeating it', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    vi.mocked(backend.act).mockResolvedValueOnce({ effect: 'unconfirmed' });
    const request = await actionInput(token, sessionId);
    expect(await call(token, 'act', request)).toMatchObject({ state: 'unknown' });
    expect(await call(token, 'act', request)).toMatchObject({ state: 'unknown' });
    expect(backend.act).toHaveBeenCalledTimes(1);
    expect(events.some(event => event.event === 'fatal')).toBe(false);
    expect(await call(token, 'act', await actionInput(token, sessionId))).toMatchObject({ state: 'executed' });
  });

  it('opens a new foreground session after closing one with a completed unknown action', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    vi.mocked(backend.act).mockResolvedValueOnce({ effect: 'unconfirmed' });
    const request = await actionInput(token, sessionId);
    expect(await call(token, 'act', request)).toMatchObject({ state: 'unknown' });
    expect(await call(token, 'session_close', { sessionId })).toEqual({ closed: true });

    const next = await call<{ sessionId: string }>(token, 'session_open', { targetId: target.id, mode: 'foreground', exclusive: true });
    expect(await observation(token, next.sessionId)).toHaveProperty('snapshotId');
    expect(await call(token, 'action_status', { requestId: request.requestId })).toMatchObject({ state: 'unknown' });
    expect(backend.act).toHaveBeenCalledTimes(1);
    expect(events.some(event => event.event === 'fatal')).toBe(false);
  });

  it('verifies unconfirmed dispatch only through an explicit successful observation', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    vi.mocked(backend.act).mockResolvedValue({ effect: 'unconfirmed' });
    expect(await call(token, 'act', { ...await actionInput(token, sessionId), verify: { type: 'element', label: 'Save', present: true } })).toMatchObject({ state: 'verified' });
    expect(await call(token, 'act', { ...await actionInput(token, sessionId), timeoutMs: 100, verify: { type: 'title', includes: 'never' } })).toMatchObject({ state: 'unknown', error: { code: 'timeout' } });
    expect(events.some(event => event.event === 'fatal')).toBe(false);
  });

  it.each(['unknown_outcome', 'timeout'] as const)('halts when an active backend throws %s instead of returning a completed dispatch', async code => {
    const { token } = await pair(), { sessionId } = await session(token);
    vi.mocked(backend.act).mockRejectedValueOnce(new CuError(code, 'Driver did not establish completion'));
    const request = await actionInput(token, sessionId);
    expect(await call(token, 'act', request)).toMatchObject({ state: 'unknown', error: { code } });
    expect(events.find(event => event.event === 'fatal')).toMatchObject({ message: expect.stringContaining(request.requestId) });
    expect(events.find(event => event.event === 'fatal')).toMatchObject({ message: expect.stringContaining(code) });
    await expect(session(token)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('revokes credentials and session ownership immediately', async () => {
    const { token, clientId } = await pair(), { sessionId } = await session(token);
    await runtime.control({ command: 'revoke', clientId });
    await expect(observation(token, sessionId)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(runtime.clients.clients.has(clientId)).toBe(false);
  });

  it('only reports verified when an explicit observable condition succeeds', async () => {
    const { token } = await pair(), { sessionId } = await session(token);
    expect(await call(token, 'act', await actionInput(token, sessionId))).toMatchObject({ state: 'executed' });
    expect(await call(token, 'act', { ...await actionInput(token, sessionId), verify: { type: 'element', label: 'Save', present: true } })).toMatchObject({ state: 'verified' });
    expect(await call(token, 'act', { ...await actionInput(token, sessionId), timeoutMs: 100, verify: { type: 'title', includes: 'Not present' } })).toMatchObject({ state: 'executed', error: { code: 'timeout' } });
  });
});
