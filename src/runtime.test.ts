import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Runtime } from './runtime.js';
import { CuError, type Backend, type BackendObservation, type Element, type HostEvent, type Target } from './contracts.js';

const target: Target = { id: 'window-1', kind: 'desktop', appId: 'com.example.Editor', title: 'Test document' };
const secretTarget: Target = { ...target, id: 'window-private', appId: 'com.example.Private' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
function fakeBackend(tick: () => void = () => {}): Backend {
  return {
    kind: 'desktop',
    doctor: vi.fn(async () => ({ available: true, checks: [] })),
    targets: vi.fn(async () => [target, secretTarget]),
    observe: vi.fn(async (requested: Target): Promise<BackendObservation> => {
      tick();
      return {
        target: requested,
        bounds: { x: 100, y: 100, width: 200, height: 100 },
        imageWidth: 400,
        imageHeight: 200,
        elements: [{ id: 'button-1', label: 'Save', role: 'button' }],
        screenshot: { mimeType: 'image/png', data: 'cGl4ZWxz' },
        backendState: { private: 'must not leak' },
      };
    }),
    validate: vi.fn(async () => true),
    act: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function observationOf(requested: Target, elements: Element[]): BackendObservation {
  return {
    target: requested,
    bounds: { x: 100, y: 100, width: 200, height: 100 },
    imageWidth: 400,
    imageHeight: 200,
    elements,
    screenshot: { mimeType: 'image/png', data: 'cGl4ZWxz' },
  };
}
type PublishedElement = { id: string; role: string; label: string; [field: string]: unknown };
type Published = {
  snapshotId: string;
  elements?: PublishedElement[];
  changes?: { since: string; unchanged: number; removed: string[] };
  screenshot?: unknown;
};

describe('Runtime authorization and execution', () => {
  let directory: string;
  let runtime: Runtime;
  let backend: Backend;
  let events: HostEvent[];
  let clock: number;
  let ackControl: boolean;
  // 让假后端返回指定元素；每次观察同样推进时钟，与默认假后端一致。
  const observeReturning = (elements: () => Element[]) =>
    vi.mocked(backend.observe).mockImplementation(async requested => {
      clock += 50;
      return observationOf(requested, elements());
    });
  const call = <T = Record<string, unknown>>(token: string | undefined, method: string, params: unknown = {}) =>
    runtime.call(token, method, params) as Promise<T>;
  async function pair(name = 'Test Agent', allow = true) {
    const pending = call<{ token: string; clientId: string }>(undefined, 'pair', {
      name,
      appIds: [target.appId, target.appId],
      browser: false,
    });
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
    // Each observation advances the injected clock so bounded waits reach their deadline.
    backend = fakeBackend(() => {
      clock += 50;
    });
    events = [];
    clock = 1_000;
    ackControl = true;
    runtime = new Runtime({
      dataDir: directory,
      backends: [backend],
      emit: event => {
        events.push(event);
        if (ackControl && event.event === 'control_begin') void runtime.control({ command: 'control_ready', pid: event.pid });
      },
      now: () => clock,
      platform: 'darwin',
      dispatchGraceMs: 250,
    });
    await runtime.start();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });

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

  it('tells the host each client grant for display, without credentials', async () => {
    const client = await pair();
    const listed = events.findLast(e => e.event === 'clients');
    expect(listed).toEqual({
      event: 'clients',
      clients: [{ id: client.clientId, name: 'Test Agent', appIds: [target.appId], browser: false, foreground: true }],
    });
    expect(JSON.stringify(listed)).not.toContain(client.token);
    await runtime.control({ command: 'revoke', clientId: client.clientId });
    expect(events.findLast(e => e.event === 'clients')).toEqual({ event: 'clients', clients: [] });
  });

  it('confirms pairing only after credentials have been persisted', async () => {
    const save = vi.spyOn(runtime.clients, 'save').mockRejectedValueOnce(new Error('disk failure'));
    await expect(pair()).rejects.toThrow('disk failure');
    expect(events.findLast(e => e.event === 'decision_finished')).toMatchObject({ approved: false });
    expect(runtime.clients.clients.size).toBe(0);
    save.mockRestore();
    const client = await pair();
    expect(events.findLast(e => e.event === 'decision_finished')).toEqual({
      event: 'decision_finished',
      requestId: client.clientId,
      approved: true,
    });
    expect(JSON.parse(await readFile(join(directory, 'clients.json'), 'utf8'))).toEqual([
      expect.objectContaining({ id: client.clientId, name: 'Test Agent' }),
    ]);
  });

  it('grants foreground once at pairing and keeps it across runtime restarts without further prompts', async () => {
    const client = await pair();
    const pairRequest = events.findLast(e => e.event === 'pair_request');
    expect(pairRequest).toMatchObject({ foreground: true });
    expect(JSON.parse(await readFile(join(directory, 'clients.json'), 'utf8'))[0].grant.foreground).toBe(true);
    const first = await call<{ sessionId: string; mode: string }>(client.token, 'session_open', {
      targetId: target.id,
      mode: 'foreground',
    });
    expect(first.mode).toBe('foreground');
    await call(client.token, 'act', await actionInput(client.token, first.sessionId));
    expect(backend.act).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'foreground', expect.anything(), expect.any(Function));
    await runtime.close();
    events = [];
    runtime = new Runtime({
      dataDir: directory,
      backends: [backend],
      emit: event => events.push(event),
      now: () => clock,
      platform: 'darwin',
    });
    await runtime.start();
    await expect(call(client.token, 'session_open', { targetId: target.id, mode: 'foreground' })).resolves.toMatchObject({
      mode: 'foreground',
    });
    expect(events.some(e => e.event === 'foreground_request' || e.event === 'pair_request')).toBe(false);
  });

  it('refuses foreground for revoked clients and for clients paired before foreground was included', async () => {
    const client = await pair();
    await runtime.control({ command: 'revoke', clientId: client.clientId });
    await expect(call(client.token, 'session_open', { targetId: target.id, mode: 'foreground' })).rejects.toMatchObject({
      code: 'unauthorized',
    });
    const legacy = await pair('Legacy');
    runtime.clients.clients.get(legacy.clientId)!.grant = { appIds: [target.appId], browser: false };
    await expect(call(legacy.token, 'session_open', { targetId: target.id, mode: 'foreground' })).rejects.toMatchObject({
      code: 'permission_denied',
      message: expect.stringContaining('pair'),
    });
    await expect(call(legacy.token, 'session_open', { targetId: target.id })).resolves.toMatchObject({ mode: 'background' });
    expect(events.some(e => e.event === 'foreground_request')).toBe(false);
    expect(backend.act).not.toHaveBeenCalled();
  });

  it('marks a macOS desktop process controlled while any of its sessions remain open', async () => {
    const desktop = { ...target, id: 'marked', pid: 4242 };
    const page = { id: 'page', kind: 'browser' as const, appId: 'browser', title: 'Page' };
    backend.targets = vi.fn(async () => [desktop, page]);
    const client = await pair();
    runtime.clients.clients.get(client.clientId)!.grant.browser = true;
    const first = await call<{ sessionId: string }>(client.token, 'session_open', { targetId: desktop.id, exclusive: false });
    const second = await call<{ sessionId: string }>(client.token, 'session_open', { targetId: desktop.id, exclusive: false });
    await call(client.token, 'session_open', { targetId: page.id, exclusive: false });
    expect(events.filter(event => event.event === 'control_begin')).toEqual([{ event: 'control_begin', pid: 4242 }]);
    await call(client.token, 'session_close', { sessionId: first.sessionId });
    expect(events.some(event => event.event === 'control_end')).toBe(false);
    await call(client.token, 'session_close', { sessionId: second.sessionId });
    expect(events.filter(event => event.event === 'control_end')).toEqual([{ event: 'control_end', pid: 4242 }]);
  });

  it('clears the control mark when the desktop session expires and skips it on Windows', async () => {
    const desktop = { ...target, id: 'expire', pid: 99 };
    backend.targets = vi.fn(async () => [desktop]);
    const { token } = await pair();
    const { sessionId } = await call<{ sessionId: string }>(token, 'session_open', { targetId: desktop.id, exclusive: false });
    clock += 120_000 + 1;
    await expect(call(token, 'observe', { sessionId })).rejects.toMatchObject({ code: 'not_found' });
    expect(events.filter(event => event.event === 'control_end')).toEqual([{ event: 'control_end', pid: 99 }]);

    const windowsTarget = { ...desktop, appId: 'win32:c:\\windows\\system32\\notepad.exe' };
    backend.targets = vi.fn(async () => [windowsTarget]);
    const windowsEvents: HostEvent[] = [];
    const windows = new Runtime({
      dataDir: join(directory, 'windows'),
      backends: [backend],
      emit: event => windowsEvents.push(event),
      now: () => clock,
      platform: 'win32',
    });
    await windows.start();
    const windowsClient = await (async () => {
      const pending = windows.call(undefined, 'pair', {
        name: 'Win',
        appIds: ['C:\\Windows\\System32\\notepad.exe'],
        browser: false,
      }) as Promise<{ token: string }>;
      const request = windowsEvents.findLast(event => event.event === 'pair_request');
      if (request?.event !== 'pair_request') throw new Error('Missing pair request');
      await windows.control({ command: 'pair_allow', clientId: request.clientId });
      return pending;
    })();
    await windows.call(windowsClient.token, 'session_open', { targetId: windowsTarget.id, exclusive: false });
    expect(windowsEvents.some(event => event.event === 'control_begin')).toBe(false);
    await windows.close();
  });

  it('still opens a desktop session when the host does not acknowledge the control mark', async () => {
    const desktop = { ...target, id: 'unacked', pid: 77 };
    backend.targets = vi.fn(async () => [desktop]);
    const { token } = await pair();
    ackControl = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = call<{ sessionId: string }>(token, 'session_open', { targetId: desktop.id, exclusive: false });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toHaveProperty('sessionId');
    expect(events.filter(event => event.event === 'control_begin')).toEqual([{ event: 'control_begin', pid: 77 }]);
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
    const a = await pair('A'),
      b = await pair('B');
    const first = await session(a.token),
      second = await session(b.token);
    await expect(observation(b.token, first.sessionId)).rejects.toMatchObject({ code: 'not_found' });
    const request = await actionInput(a.token, first.sessionId);
    await expect(call(b.token, 'act', { ...request, sessionId: second.sessionId })).rejects.toMatchObject({ code: 'stale_snapshot' });
    await call(a.token, 'act', request);
    await expect(call(b.token, 'action_status', { requestId: request.requestId })).rejects.toMatchObject({ code: 'not_found' });
    await expect(call(b.token, 'act', request)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not silently elevate a background session to foreground', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    await call(token, 'act', await actionInput(token, sessionId));
    expect(backend.act).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'background', expect.anything(), expect.any(Function));
  });

  it('consumes snapshots after one action, replaces observations, and hides backend state', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    const first = await observation(token, sessionId);
    expect(first).not.toHaveProperty('backendState');
    const request = await actionInput(token, sessionId);
    await expect(call(token, 'act', { ...request, snapshotId: first.snapshotId })).rejects.toMatchObject({ code: 'stale_snapshot' });
    await call(token, 'act', request);
    await expect(call(token, 'act', { ...request, requestId: randomUUID() })).rejects.toMatchObject({ code: 'stale_snapshot' });
    expect(backend.act).toHaveBeenCalledTimes(1);
  });

  it('rejects expired, changed, and out-of-bounds targets before executing', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    const request = await actionInput(token, sessionId);
    await expect(call(token, 'act', { ...request, action: { type: 'click', point: { x: 400, y: 0 } } })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(call(token, 'act', { ...request, action: { type: 'click', point: { x: -1, y: 0 } } })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(call(token, 'act', { ...request, action: { type: 'click', elementId: 'foreign' } })).rejects.toMatchObject({
      code: 'stale_snapshot',
    });
    clock += 30_001;
    await expect(call(token, 'act', request)).rejects.toMatchObject({ code: 'stale_snapshot' });
    vi.mocked(backend.validate).mockResolvedValueOnce(false);
    expect(await call(token, 'act', await actionInput(token, sessionId))).toMatchObject({
      state: 'failed',
      error: { code: 'stale_snapshot' },
    });
    expect(backend.act).not.toHaveBeenCalled();
  });

  it('deduplicates identical requests and rejects ID reuse with changed arguments', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    const request = await actionInput(token, sessionId);
    const result = await call(token, 'act', request);
    expect(await call(token, 'act', request)).toEqual(result);
    await expect(call(token, 'act', { ...request, action: { type: 'key', keys: ['ENTER'] } })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(backend.act).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty('fingerprint');
    expect(result).not.toHaveProperty('clientId');
  });

  it('serializes complete actions from different sessions', async () => {
    const { token } = await pair(),
      first = await session(token),
      second = await session(token);
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
    const { token } = await pair(),
      { sessionId } = await session(token);
    const request = await actionInput(token, sessionId);
    await runtime.control({ command: 'pause' });
    await expect(call(token, 'act', request)).rejects.toMatchObject({ code: 'paused' });
    await runtime.control({ command: 'resume' });
    expect(await call(token, 'act', request)).toMatchObject({ state: 'executed' });
  });

  it('cancels queued work without interrupting the active action or halting the runtime', async () => {
    const { token } = await pair(),
      first = await session(token),
      second = await session(token);
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
    const { token } = await pair(),
      { sessionId } = await session(token);
    vi.mocked(backend.act).mockImplementationOnce(() => new Promise(() => {}));
    const request = { ...(await actionInput(token, sessionId)), timeoutMs: interruption === 'timeout' ? 100 : 1000 };
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
    const { token } = await pair(),
      { sessionId } = await session(token);
    vi.mocked(backend.act).mockRejectedValueOnce(new Error('private typed text'));
    const result = await call(token, 'act', await actionInput(token, sessionId));
    expect(result).toMatchObject({ state: 'unknown', error: { code: 'internal' } });
    expect(JSON.stringify(result)).not.toContain('private typed text');
    expect(events.some(e => e.event === 'fatal')).toBe(true);
    await expect(session(token)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('reserves request IDs before persistence so concurrent duplicate submissions execute once', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    const request = await actionInput(token, sessionId),
      gate = deferred();
    vi.spyOn(runtime.actions, 'save').mockImplementationOnce(() => gate.promise);
    const first = call(token, 'act', request);
    let duplicateSettled = false;
    const duplicate = call(token, 'act', request).then(result => {
      duplicateSettled = true;
      return result;
    });
    await expect(call(token, 'act', { ...request, action: { type: 'key', keys: ['ENTER'] } })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(duplicateSettled).toBe(false);
    gate.resolve();
    expect(await duplicate).toMatchObject({ state: 'queued' });
    expect(await first).toMatchObject({ state: 'executed' });
    expect(backend.act).toHaveBeenCalledTimes(1);
  });

  it('accepts cancellation while a queued action is still being persisted', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    const request = await actionInput(token, sessionId),
      gate = deferred();
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
    const { token } = await pair(),
      { sessionId } = await session(token);
    const request = await actionInput(token, sessionId),
      gate = deferred();
    vi.mocked(backend.validate).mockImplementationOnce(async () => {
      await gate.promise;
      return true;
    });
    const pending = call(token, 'act', request);
    await vi.waitFor(() => expect(backend.validate).toHaveBeenCalledTimes(1));
    const cancelled = call(token, 'cancel', { requestId: request.requestId });
    gate.resolve();
    await cancelled;
    expect(await pending).toMatchObject({ state: 'cancelled' });
    expect(backend.act).not.toHaveBeenCalled();
  });

  it('does not open a session after its client is revoked during target enumeration', async () => {
    const { token, clientId } = await pair(),
      gate = deferred();
    vi.mocked(backend.targets).mockImplementationOnce(async () => {
      await gate.promise;
      return [target];
    });
    const pending = session(token);
    const rejected = expect(pending).rejects.toMatchObject({ code: expect.stringMatching(/unauthorized|not_found/) });
    await runtime.control({ command: 'revoke', clientId });
    gate.resolve();
    await rejected;
  });

  it('withholds an in-flight observation when its client is revoked', async () => {
    const { token, clientId } = await pair(),
      { sessionId } = await session(token);
    const original = await backend.observe(target),
      gate = deferred();
    vi.mocked(backend.observe).mockImplementationOnce(async () => {
      await gate.promise;
      return original;
    });
    const pending = observation(token, sessionId);
    const rejection = expect(pending).rejects.toMatchObject({ code: expect.stringMatching(/unauthorized|not_found/) });
    await runtime.control({ command: 'revoke', clientId });
    gate.resolve();
    await rejection;
  });

  it('fails closed if the action journal cannot be persisted', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    vi.spyOn(runtime.actions, 'save').mockRejectedValueOnce(new Error('disk unavailable'));
    expect(await call(token, 'act', await actionInput(token, sessionId))).toMatchObject({
      state: 'failed',
      error: { code: 'unavailable' },
    });
    expect(backend.act).not.toHaveBeenCalled();
    expect(events.find(e => e.event === 'fatal')).toMatchObject({ message: expect.stringContaining('Action journal') });
    await expect(session(token)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('enforces wait timeout when the backend observation never settles', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    vi.mocked(backend.observe).mockImplementationOnce(() => new Promise(() => {}));
    await expect(call(token, 'wait', { sessionId, timeoutMs: 100, condition: { type: 'title', includes: 'never' } })).rejects.toMatchObject(
      { code: 'timeout' },
    );
    expect(events.some(event => event.event === 'fatal')).toBe(false);
  });

  it('returns the observation that satisfied a wait without starting an unbounded second read', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    const matching = await backend.observe(target);
    vi.mocked(backend.observe)
      .mockClear()
      .mockResolvedValueOnce(matching)
      .mockImplementationOnce(() => new Promise(() => {}));
    expect(await call(token, 'wait', { sessionId, timeoutMs: 100, condition: { type: 'title', includes: 'Test document' } })).toMatchObject(
      { state: 'verified', observation: { target, screenshot: matching.screenshot } },
    );
    expect(backend.observe).toHaveBeenCalledTimes(1);
  });

  it('enforces validation timeout before input starts and keeps the runtime usable', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    vi.mocked(backend.validate).mockImplementationOnce(() => new Promise(() => {}));
    expect(await call(token, 'act', { ...(await actionInput(token, sessionId)), timeoutMs: 100 })).toMatchObject({
      state: 'failed',
      error: { code: 'timeout' },
    });
    expect(backend.act).not.toHaveBeenCalled();
    expect(events.some(event => event.event === 'fatal')).toBe(false);
    expect(await call(token, 'act', await actionInput(token, sessionId))).toMatchObject({ state: 'executed' });
  });

  it('cancels a validation that never settles without waiting for its timeout', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    const request = { ...(await actionInput(token, sessionId)), timeoutMs: 30_000 };
    vi.mocked(backend.validate).mockImplementationOnce(() => new Promise(() => {}));
    const pending = call(token, 'act', request);
    await vi.waitFor(() => expect(backend.validate).toHaveBeenCalledTimes(1));
    expect(await call(token, 'cancel', { requestId: request.requestId })).toMatchObject({ state: 'cancelled' });
    expect(await pending).toMatchObject({ state: 'cancelled' });
    expect(backend.act).not.toHaveBeenCalled();
  });

  it('persists queued requests before reporting their status behind an active gesture', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token),
      gate = deferred();
    vi.mocked(backend.act).mockImplementationOnce(() => gate.promise);
    const active = call(token, 'act', await actionInput(token, sessionId));
    await vi.waitFor(() => expect(backend.act).toHaveBeenCalledTimes(1));
    const request = await actionInput(token, sessionId);
    const queued = call(token, 'act', request);
    try {
      expect(await call(token, 'action_status', { requestId: request.requestId })).toMatchObject({ state: 'queued' });
      const journal = JSON.parse(await readFile(join(directory, 'actions.json'), 'utf8')) as Array<{ requestId: string; state: string }>;
      expect(journal.find(record => record.requestId === request.requestId)).toMatchObject({ state: 'queued' });
    } finally {
      gate.resolve();
      await Promise.all([active, queued]);
    }
  });

  it('does not infer absence from an incomplete element tree', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    const partial = { ...(await backend.observe(target)), elementsComplete: false };
    vi.mocked(backend.observe).mockResolvedValue(partial);
    const condition = { type: 'element', label: 'Missing', present: false };
    await expect(call(token, 'wait', { sessionId, timeoutMs: 100, condition })).rejects.toMatchObject({ code: 'unavailable' });
    expect(await call(token, 'act', { ...(await actionInput(token, sessionId)), verify: condition })).toMatchObject({
      state: 'executed',
      error: { code: 'unavailable' },
    });
    expect(
      await call(token, 'wait', { sessionId, timeoutMs: 100, condition: { type: 'element', label: 'Save', present: true } }),
    ).toMatchObject({ state: 'verified' });
    vi.mocked(backend.observe).mockResolvedValue({ ...partial, elementsComplete: true });
    expect(await call(token, 'wait', { sessionId, timeoutMs: 100, condition })).toMatchObject({ state: 'verified' });
  });

  it('cancels queued actions that wait past the admission limit without dispatching them', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    const gate = deferred();
    vi.mocked(backend.act).mockImplementationOnce(async () => {
      await gate.promise;
      return undefined;
    });
    const first = call(token, 'act', await actionInput(token, sessionId));
    await vi.waitFor(() => expect(backend.act).toHaveBeenCalledTimes(1));
    const second = call(token, 'act', await actionInput(token, sessionId));
    clock += 15_001;
    gate.resolve();
    expect(await first).toMatchObject({ state: 'executed' });
    expect(await second).toMatchObject({ state: 'cancelled', error: { code: 'cancelled' } });
    expect(backend.act).toHaveBeenCalledTimes(1);
    expect(events.some(event => event.event === 'fatal')).toBe(false);
  });

  it('gives verification only the time left in the action budget', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    const request = { ...(await actionInput(token, sessionId)), verify: { type: 'title', includes: 'never' } };
    vi.mocked(backend.act).mockImplementationOnce(async () => {
      clock += 950;
      return { effect: 'unconfirmed' };
    });
    const observe = vi.mocked(backend.observe);
    observe.mockClear();
    expect(await call(token, 'act', request)).toMatchObject({ state: 'executed', effect: 'unconfirmed', error: { code: 'timeout' } });
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('reaps expired sessions in the background instead of only on access', async () => {
    await runtime.close();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    runtime = new Runtime({
      dataDir: directory,
      backends: [backend],
      emit: event => events.push(event),
      now: () => clock,
      platform: 'darwin',
    });
    await runtime.start();
    const { token } = await pair(),
      { sessionId } = await session(token, true);
    clock += 120_001;
    await expect(observation(token, sessionId)).rejects.toMatchObject({ message: expect.stringContaining('expired') });
    const next = await session(token, true);
    clock += 120_001;
    vi.advanceTimersByTime(30_000);
    await expect(observation(token, next.sessionId)).rejects.toMatchObject({ code: 'not_found', message: 'Session not found.' });
  });

  it('bounds waits by the injected clock rather than wall time', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    const observe = vi.mocked(backend.observe);
    const original = observe.getMockImplementation()!;
    observe.mockClear().mockImplementation(async requested => {
      clock += 5_000;
      return original(requested);
    });
    const started = Date.now();
    await expect(
      call(token, 'wait', { sessionId, timeoutMs: 30_000, condition: { type: 'title', includes: 'never' } }),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(observe).toHaveBeenCalledTimes(6);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports an unconfirmed dispatch as executed without halting or repeating it', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    vi.mocked(backend.act).mockResolvedValueOnce({ effect: 'unconfirmed' });
    const request = await actionInput(token, sessionId);
    expect(await call(token, 'act', request)).toMatchObject({ state: 'executed', effect: 'unconfirmed' });
    expect(await call(token, 'act', request)).toMatchObject({ state: 'executed', effect: 'unconfirmed' });
    expect(backend.act).toHaveBeenCalledTimes(1);
    expect(await call(token, 'act', request)).not.toHaveProperty('error');
    expect(events.some(event => event.event === 'fatal')).toBe(false);
    expect(await call(token, 'act', await actionInput(token, sessionId))).toMatchObject({ state: 'executed' });
  });

  it('opens a new foreground session after closing one with a completed unconfirmed action', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    vi.mocked(backend.act).mockResolvedValueOnce({ effect: 'unconfirmed' });
    const request = await actionInput(token, sessionId);
    expect(await call(token, 'act', request)).toMatchObject({ state: 'executed', effect: 'unconfirmed' });
    expect(await call(token, 'session_close', { sessionId })).toEqual({ closed: true });

    const next = await call<{ sessionId: string }>(token, 'session_open', { targetId: target.id, mode: 'foreground', exclusive: true });
    expect(await observation(token, next.sessionId)).toHaveProperty('snapshotId');
    expect(await call(token, 'action_status', { requestId: request.requestId })).toMatchObject({
      state: 'executed',
      effect: 'unconfirmed',
    });
    expect(backend.act).toHaveBeenCalledTimes(1);
    expect(events.some(event => event.event === 'fatal')).toBe(false);
  });

  it('verifies unconfirmed dispatch only through an explicit successful observation', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    vi.mocked(backend.act).mockResolvedValue({ effect: 'unconfirmed' });
    expect(
      await call(token, 'act', { ...(await actionInput(token, sessionId)), verify: { type: 'element', label: 'Save', present: true } }),
    ).toMatchObject({ state: 'verified' });
    expect(
      await call(token, 'act', { ...(await actionInput(token, sessionId)), timeoutMs: 100, verify: { type: 'title', includes: 'never' } }),
    ).toMatchObject({ state: 'executed', effect: 'unconfirmed', error: { code: 'timeout' } });
    expect(events.some(event => event.event === 'fatal')).toBe(false);
  });

  it.each(['unknown_outcome', 'timeout'] as const)(
    'halts when an active backend throws %s instead of returning a completed dispatch',
    async code => {
      const { token } = await pair(),
        { sessionId } = await session(token);
      vi.mocked(backend.act).mockRejectedValueOnce(new CuError(code, 'Driver did not establish completion'));
      const request = await actionInput(token, sessionId);
      expect(await call(token, 'act', request)).toMatchObject({ state: 'unknown', error: { code } });
      expect(events.find(event => event.event === 'fatal')).toMatchObject({ message: expect.stringContaining(request.requestId) });
      expect(events.find(event => event.event === 'fatal')).toMatchObject({ message: expect.stringContaining(code) });
      await expect(session(token)).rejects.toMatchObject({ code: 'unavailable' });
    },
  );

  it('revokes credentials and session ownership immediately', async () => {
    const { token, clientId } = await pair(),
      { sessionId } = await session(token);
    await runtime.control({ command: 'revoke', clientId });
    await expect(observation(token, sessionId)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(runtime.clients.clients.has(clientId)).toBe(false);
  });

  it('only reports verified when an explicit observable condition succeeds', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    expect(await call(token, 'act', await actionInput(token, sessionId))).toMatchObject({ state: 'executed' });
    expect(
      await call(token, 'act', { ...(await actionInput(token, sessionId)), verify: { type: 'element', label: 'Save', present: true } }),
    ).toMatchObject({ state: 'verified' });
    expect(
      await call(token, 'act', {
        ...(await actionInput(token, sessionId)),
        timeoutMs: 100,
        verify: { type: 'title', includes: 'Not present' },
      }),
    ).toMatchObject({ state: 'executed', error: { code: 'timeout' } });
  });

  it('fails an action that times out before dispatching input without halting the runtime', async () => {
    Object.assign(backend, { reportsDispatch: true });
    const { token } = await pair(),
      { sessionId } = await session(token);
    vi.mocked(backend.act).mockImplementationOnce(() => new Promise(() => {}));
    expect(await call(token, 'act', { ...(await actionInput(token, sessionId)), timeoutMs: 100 })).toMatchObject({
      state: 'failed',
      error: { code: 'timeout' },
    });
    expect(events.some(event => event.event === 'fatal')).toBe(false);
    expect(await call(token, 'act', await actionInput(token, sessionId))).toMatchObject({ state: 'executed' });
  });

  it('cancels an action before it dispatches input without halting the runtime', async () => {
    Object.assign(backend, { reportsDispatch: true });
    const { token } = await pair(),
      { sessionId } = await session(token);
    vi.mocked(backend.act).mockImplementationOnce(() => new Promise(() => {}));
    const request = await actionInput(token, sessionId);
    const pending = call(token, 'act', request);
    await vi.waitFor(() => expect(backend.act).toHaveBeenCalledTimes(1));
    expect(await call(token, 'cancel', { requestId: request.requestId })).toMatchObject({ state: 'cancelled' });
    expect(await pending).toMatchObject({ state: 'cancelled', error: { code: 'cancelled' } });
    expect(events.some(event => event.event === 'fatal')).toBe(false);
    expect(await call(token, 'act', await actionInput(token, sessionId))).toMatchObject({ state: 'executed' });
  });

  it('still halts when an action is interrupted after it reported dispatch', async () => {
    Object.assign(backend, { reportsDispatch: true });
    const { token } = await pair(),
      { sessionId } = await session(token);
    vi.mocked(backend.act).mockImplementationOnce((_observation, _action, _mode, _signal, onDispatch) => {
      onDispatch?.();
      return new Promise(() => {});
    });
    expect(await call(token, 'act', { ...(await actionInput(token, sessionId)), timeoutMs: 100 })).toMatchObject({
      state: 'unknown',
      error: { code: 'unknown_outcome' },
    });
    expect(events.filter(event => event.event === 'fatal')).toHaveLength(1);
    await expect(session(token)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('lets an input that was already dispatched finish after timeoutMs instead of halting', async () => {
    Object.assign(backend, { reportsDispatch: true });
    const { token } = await pair(),
      { sessionId } = await session(token);
    vi.mocked(backend.act).mockImplementationOnce(async (_observation, _action, _mode, _signal, onDispatch) => {
      onDispatch?.();
      await new Promise(resolve => setTimeout(resolve, 200));
      return { effect: 'unconfirmed' };
    });
    expect(await call(token, 'act', { ...(await actionInput(token, sessionId)), timeoutMs: 100 })).toMatchObject({
      state: 'executed',
      effect: 'unconfirmed',
    });
    expect(events.some(event => event.event === 'fatal')).toBe(false);
    expect(await call(token, 'act', await actionInput(token, sessionId))).toMatchObject({ state: 'executed' });
  });

  it('records uncertain results from a contained backend as unknown without halting later work', async () => {
    Object.assign(backend, { reportsDispatch: true, interruptionContained: true });
    const { token } = await pair(),
      { sessionId } = await session(token);
    vi.mocked(backend.act).mockImplementationOnce(async (_observation, _action, _mode, _signal, onDispatch) => {
      onDispatch?.();
      throw new CuError('unknown_outcome', 'Browser action did not finish normally.');
    });
    expect(await call(token, 'act', await actionInput(token, sessionId))).toMatchObject({
      state: 'unknown',
      error: { code: 'unknown_outcome' },
    });
    vi.mocked(backend.act).mockImplementationOnce((_observation, _action, _mode, _signal, onDispatch) => {
      onDispatch?.();
      return new Promise(() => {});
    });
    const request = await actionInput(token, sessionId);
    const pending = call(token, 'act', request);
    await vi.waitFor(() => expect(backend.act).toHaveBeenCalledTimes(2));
    await call(token, 'cancel', { requestId: request.requestId });
    expect(await pending).toMatchObject({ state: 'unknown', error: { code: 'unknown_outcome' } });
    expect(events.some(event => event.event === 'fatal')).toBe(false);
    expect(await call(token, 'act', await actionInput(token, sessionId))).toMatchObject({ state: 'executed' });
  });

  it('rechecks the exclusive lease after waiting for the host control mark', async () => {
    const desktop = { ...target, id: 'raced', pid: 4343 };
    backend.targets = vi.fn(async () => [desktop]);
    const { token } = await pair();
    ackControl = false;
    const first = call(token, 'session_open', { targetId: desktop.id, exclusive: true });
    const rejected = expect(first).rejects.toMatchObject({ code: 'busy' });
    await vi.waitFor(() => expect(events.some(event => event.event === 'control_begin')).toBe(true));
    const second = await call(token, 'session_open', { targetId: desktop.id, exclusive: true });
    expect(second).toHaveProperty('sessionId');
    await runtime.control({ command: 'control_ready', pid: desktop.pid });
    await rejected;
    expect(events.some(event => event.event === 'control_end')).toBe(false);
  });

  it('does not register a session for a client revoked while the host control mark is pending', async () => {
    const desktop = { ...target, id: 'revoked-mark', pid: 4444 };
    backend.targets = vi.fn(async () => [desktop]);
    const { token, clientId } = await pair();
    ackControl = false;
    const pending = call(token, 'session_open', { targetId: desktop.id, exclusive: false });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'unauthorized' });
    await vi.waitFor(() => expect(events.some(event => event.event === 'control_begin')).toBe(true));
    await runtime.control({ command: 'revoke', clientId });
    await runtime.control({ command: 'control_ready', pid: desktop.pid });
    await rejected;
    expect(events.filter(event => event.event === 'control_end')).toEqual([{ event: 'control_end', pid: desktop.pid }]);
  });

  it('reports a verification cancelled while waiting as cancelled rather than an internal error', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    const request = { ...(await actionInput(token, sessionId)), timeoutMs: 30_000, verify: { type: 'title', includes: 'never' } };
    const observe = vi.mocked(backend.observe);
    observe.mockClear();
    const pending = call(token, 'act', request);
    await vi.waitFor(() => expect(observe.mock.calls.length).toBeGreaterThan(1));
    const cancelled = await call(token, 'cancel', { requestId: request.requestId });
    expect(cancelled).toMatchObject({ state: 'executed', error: { code: 'cancelled' } });
    expect(await pending).toMatchObject({ state: 'executed', error: { code: 'cancelled' } });
    expect(events.some(event => event.event === 'fatal')).toBe(false);
  });

  it('asks the backend to release cached observations once no session uses the target', async () => {
    const release = vi.fn(async (_target: Target) => {});
    Object.assign(backend, { release });
    const { token } = await pair(),
      first = await session(token),
      second = await session(token);
    await observation(token, first.sessionId);
    await call(token, 'session_close', { sessionId: first.sessionId });
    expect(release).not.toHaveBeenCalled();
    await call(token, 'session_close', { sessionId: second.sessionId });
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(target);
  });

  it('rejects client names with line breaks or invisible formatting before prompting the user', async () => {
    for (const name of ['Agent\nApproved for every app', 'Agent\u202eppA', 'Agent\u2028Line', 'Tab\tName']) {
      await expect(call(undefined, 'pair', { name, appIds: [target.appId], browser: false })).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
    expect(events.some(event => event.event === 'pair_request')).toBe(false);
    await expect(pair('中文 Agent · 1')).resolves.toHaveProperty('token');
  });

  it('publishes readable element state compactly and maps public element ids back to backend ids', async () => {
    // 第 2000 个 UTF-16 单元正好是表情的前半个代理项：截断时不能留下半个字符。
    const long = '长'.repeat(1_999) + '😀'.repeat(300);
    observeReturning(() => [
      {
        id: 'native-1',
        role: 'AXButton',
        label: 'Save',
        enabled: true,
        depth: 2,
        bounds: { x: 10.4, y: 20.6, width: 50.5, height: 19.49 },
      },
      { id: 'native-2', role: 'AXTextArea', label: 'Body', value: long, depth: 3 },
      { id: 'native-3', role: 'AXCheckBox', label: 'Remember', value: 'Remember', enabled: false, selected: true, depth: 3 },
      { id: 'native-4', role: 'AXSlider', label: 'Volume', value: '0.5', min: 0, max: 1, selected: false, depth: 3 },
      { id: 'native-5', role: 'AXTextField', label: 'Empty', value: '', depth: 3 },
    ]);
    const { token } = await pair(),
      { sessionId } = await session(token);
    const observed = await call<Published>(token, 'observe', { sessionId });
    const id = expect.stringMatching(/^e\d+$/);
    // 位置取整；只有与默认不同的 enabled/selected 才给出；与标签相同的值不重复，空值照常给出；深度只在内部使用。
    expect(observed.elements).toEqual([
      { id, role: 'AXButton', label: 'Save', bounds: { x: 10, y: 21, width: 51, height: 19 } },
      { id, role: 'AXTextArea', label: 'Body', value: '长'.repeat(1_999), valueLength: 2_599 },
      { id, role: 'AXCheckBox', label: 'Remember', enabled: false, selected: true },
      { id, role: 'AXSlider', label: 'Volume', value: '0.5', min: 0, max: 1 },
      { id, role: 'AXTextField', label: 'Empty', value: '' },
    ]);
    expect(JSON.stringify(observed)).not.toContain('native-');
    const request = { sessionId, snapshotId: observed.snapshotId, requestId: randomUUID(), timeoutMs: 1000 };
    await call(token, 'act', { ...request, action: { type: 'click', elementId: observed.elements![0]!.id } });
    expect(vi.mocked(backend.act).mock.calls.at(-1)?.[1]).toEqual({ type: 'click', elementId: 'native-1' });
    // 后端自己的 id 从不公开，也不能直接使用。
    const again = await call<Published>(token, 'observe', { sessionId });
    await expect(
      call(token, 'act', {
        ...request,
        snapshotId: again.snapshotId,
        requestId: randomUUID(),
        action: { type: 'click', elementId: 'native-1' },
      }),
    ).rejects.toMatchObject({ code: 'stale_snapshot' });
  });

  it('keeps element ids stable within a session and returns only changes since a list the client has seen', async () => {
    const button = { role: 'AXButton', label: 'Save', depth: 1, bounds: { x: 1, y: 1, width: 10, height: 10 } };
    const field = { role: 'AXTextField', label: 'Name', depth: 1, bounds: { x: 1, y: 20, width: 100, height: 10 } };
    const notice = { role: 'AXStaticText', depth: 1, bounds: { x: 1, y: 40, width: 100, height: 10 } };
    let elements: Element[] = [
      { id: 'a1', ...button },
      { id: 'a2', ...field, value: 'a' },
      { id: 'a3', ...notice, label: 'Unsaved' },
    ];
    observeReturning(() => elements);
    const { token } = await pair(),
      { sessionId } = await session(token);
    const first = await call<Published>(token, 'observe', { sessionId });
    const ids = Object.fromEntries(first.elements!.map(element => [element.label, element.id]));
    elements = [
      { id: 'b1', ...button },
      { id: 'b2', ...field, value: 'ab' },
      { id: 'b3', ...notice, label: 'Saved' },
    ];
    const second = await call<Published>(token, 'observe', { sessionId, since: first.snapshotId });
    expect(second.changes).toEqual({ since: first.snapshotId, unchanged: 1, removed: [ids.Unsaved] });
    expect(second.elements).toEqual([
      { id: ids.Name, role: 'AXTextField', label: 'Name', value: 'ab', bounds: field.bounds },
      { id: expect.stringMatching(/^e\d+$/), role: 'AXStaticText', label: 'Saved', bounds: notice.bounds },
    ]);
    const saved = second.elements![1]!.id;
    expect(Object.values(ids)).not.toContain(saved);
    // 未变的元素沿用 id，并对应到这次观察里的后端元素。
    const request = { sessionId, requestId: randomUUID(), timeoutMs: 1000, action: { type: 'click', elementId: ids.Save } };
    await call(token, 'act', { ...request, snapshotId: second.snapshotId });
    expect(vi.mocked(backend.act).mock.calls.at(-1)?.[1]).toEqual({ type: 'click', elementId: 'b1' });
    // 基准不是最近一次返回的元素表时给完整列表，id 保持不变。
    const third = await call<Published>(token, 'observe', { sessionId, since: first.snapshotId });
    expect(third.changes).toBeUndefined();
    expect(third.elements!.map(element => element.id)).toEqual([ids.Save, ids.Name, saved]);
    // 省略元素或截图的观察照常可用于动作，但客户端没见过的元素表不能作为增量基准。
    const hidden = await call<Published>(token, 'observe', { sessionId, elements: false, screenshot: false });
    expect(hidden).not.toHaveProperty('elements');
    expect(hidden).not.toHaveProperty('screenshot');
    await call(token, 'act', { ...request, requestId: randomUUID(), snapshotId: hidden.snapshotId });
    expect(vi.mocked(backend.act).mock.calls.at(-1)?.[1]).toEqual({ type: 'click', elementId: 'b1' });
    const full = await call<Published>(token, 'observe', { sessionId, since: hidden.snapshotId });
    expect(full.changes).toBeUndefined();
    expect(full.elements).toHaveLength(3);
    // 没有任何元素沿用时（如整页跳转）直接给完整列表。
    elements = [{ id: 'c1', role: 'AXStaticText', label: 'Other page', depth: 1 }];
    const replaced = await call<Published>(token, 'observe', { sessionId, since: full.snapshotId });
    expect(replaced.changes).toBeUndefined();
    expect(replaced.elements).toEqual([{ id: expect.stringMatching(/^e\d+$/), role: 'AXStaticText', label: 'Other page' }]);
    // 另一个会话从新的 id 开始，不会与这个会话的 id 混用。
    const other = await session(token);
    const foreign = await call<Published>(token, 'observe', { sessionId: other.sessionId });
    expect(foreign.elements!.map(element => element.id).some(value => Object.values(ids).includes(value))).toBe(false);
  });

  it('attaches the next observation to act results, reuses a verification observation, and omits it after an unknown outcome', async () => {
    const { token } = await pair(),
      { sessionId } = await session(token);
    const first = await call<Published>(token, 'observe', { sessionId });
    const click = { type: 'click', point: { x: 10, y: 10 } };
    const input = { sessionId, snapshotId: first.snapshotId, requestId: randomUUID(), action: click, timeoutMs: 1000 };
    const attached = await call<{ state: string; observation: Published }>(token, 'act', {
      ...input,
      observe: { changes: true, screenshot: false },
    });
    expect(attached).toMatchObject({
      state: 'executed',
      observation: { changes: { since: first.snapshotId, unchanged: 1, removed: [] }, elements: [] },
    });
    expect(attached.observation).not.toHaveProperty('screenshot');
    // 重复同一请求只返回记录，不再附带观察；observe 不属于动作参数，改变它不算换了一个动作。
    expect(await call(token, 'act', { ...input, observe: { changes: true, screenshot: false } })).not.toHaveProperty('observation');
    expect(await call(token, 'act', input)).toMatchObject({ requestId: input.requestId, state: 'executed' });
    await expect(call(token, 'act', { ...input, timeoutMs: 2000 })).rejects.toMatchObject({ code: 'invalid_request' });
    // 附带的快照可以直接用于下一个动作；验证条件满足时复用那次观察，不再额外抓取。
    const observe = vi.mocked(backend.observe);
    observe.mockClear();
    const verified = await call<{ state: string; observation: Published }>(token, 'act', {
      ...input,
      requestId: randomUUID(),
      snapshotId: attached.observation.snapshotId,
      verify: { type: 'element', label: 'Save', present: true },
      observe: {},
    });
    expect(verified).toMatchObject({ state: 'verified', observation: { elements: [{ label: 'Save' }], screenshot: expect.anything() } });
    expect(observe).toHaveBeenCalledTimes(1);
    // 输入发出前失败时同样附带新观察，便于直接重试。
    vi.mocked(backend.validate).mockResolvedValueOnce(false);
    expect(await call(token, 'act', { ...(await actionInput(token, sessionId)), observe: {} })).toMatchObject({
      state: 'failed',
      error: { code: 'stale_snapshot' },
      observation: { snapshotId: expect.any(String) },
    });
    // 剩余时间不足时不观察，只报告原因。
    vi.mocked(backend.act).mockImplementationOnce(async () => {
      clock += 59_500;
      return { effect: 'confirmed' };
    });
    const late = await call(token, 'act', { ...(await actionInput(token, sessionId)), observe: {} });
    expect(late).toMatchObject({ state: 'executed', observationError: { code: 'timeout' } });
    expect(late).not.toHaveProperty('observation');
    vi.mocked(backend.act).mockRejectedValueOnce(new CuError('unknown_outcome', 'Connection lost after dispatch.'));
    const uncertain = await call(token, 'act', { ...(await actionInput(token, sessionId)), observe: {} });
    expect(uncertain).toMatchObject({ state: 'unknown' });
    expect(uncertain).not.toHaveProperty('observation');
    expect(uncertain).not.toHaveProperty('observationError');
    expect(events.some(event => event.event === 'fatal')).toBe(true);
  });

  it('verifies element values and states and never treats unreported state as a match', async () => {
    observeReturning(() => [
      { id: 'n1', role: 'AXTextArea', label: '', value: 'line one\r\nline two' },
      { id: 'n2', role: 'AXButton', label: 'Submit', enabled: false },
      { id: 'n3', role: 'AXCheckBox', label: 'Agree', selected: true },
      // 密码框：后端不报告它的值。
      { id: 'n4', role: 'AXSecureTextField', label: 'Password' },
    ]);
    const { token } = await pair(),
      { sessionId } = await session(token);
    const wait = (condition: Record<string, unknown>) => call(token, 'wait', { sessionId, timeoutMs: 100, condition });
    for (const condition of [
      { value: 'line one\nline two' },
      { role: 'AXTextArea', valueIncludes: 'two' },
      { label: 'Submit', enabled: false },
      { label: 'Agree', selected: true },
    ])
      await expect(wait({ type: 'element', present: true, ...condition })).resolves.toMatchObject({ state: 'verified' });
    for (const condition of [
      { label: 'Submit', enabled: true },
      { label: 'Password', value: '' },
      { label: 'Agree', valueIncludes: 'x' },
    ])
      await expect(wait({ type: 'element', present: true, ...condition })).rejects.toMatchObject({ code: 'timeout' });
    for (const condition of [
      { type: 'element', present: true },
      { type: 'element', label: 'Submit', enabled: true, present: false },
    ])
      await expect(wait(condition)).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
