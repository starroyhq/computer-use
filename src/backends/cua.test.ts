import { describe, expect, it, vi } from 'vitest';
import type { ToolResult, WindowStateOutput } from '@trycua/cua-driver';
import { CuaBackend, type CuaConnection } from './cua.js';
import type { Target } from '../contracts.js';

const target: Target = { id: 'desktop:42:19', kind: 'desktop', appId: 'test.fixture', title: 'Fixture', pid: 42, windowId: 19 };
const bounds = { x: 10, y: 20, width: 300, height: 200 };
const success = (): ToolResult => ({
  text: '',
  images: [],
  isError: false,
  degraded: false,
  rawJson: '{}',
  action: { effect: 0, route: 0 },
});

function fixture() {
  const state: WindowStateOutput = {
    pid: 42,
    windowId: 19n,
    windowBounds: bounds,
    screenshotWidth: 600,
    screenshotHeight: 400,
    screenshotFrameValid: true,
    images: [{ mimeType: 'image/png', dataBase64: 'fixture-image' }],
    snapshotId: 's1',
    elements: [{ elementIndex: 1n, role: 'button', depth: 0, label: 'Save', elementToken: 's1:1', frame: { x: 2, y: 3, w: 20, h: 10 } }],
  };
  const client = {
    metadata: vi.fn<CuaConnection['metadata']>(async () => ({
      driverVersion: '0.28.2',
      contractVersion: '0.8.0',
      toolsListSchemaVersion: '1',
      capabilityVersion: '1',
      mcpProtocolVersion: '2025-06-18',
      pid: 100,
      embedded: true,
    })),
    listApps: vi.fn<CuaConnection['listApps']>(async () => ({
      apps: [
        { pid: 42, name: 'Fixture', running: true, active: false, bundleId: 'test.fixture' },
        { pid: 99, name: 'Unapproved', running: true, active: true, bundleId: 'other.app' },
      ],
    })),
    listWindows: vi.fn<CuaConnection['listWindows']>(async () => ({
      windows: [{ windowId: 19n, pid: 42, appName: 'Fixture', title: 'Fixture', bounds, isOnScreen: true }],
    })),
    getWindowState: vi.fn<CuaConnection['getWindowState']>(async () => state),
    callTool: vi.fn<CuaConnection['callTool']>(async () => success()),
    endSession: vi.fn<CuaConnection['endSession']>(async () => ({ session: 'fixture', active: false })),
    shutdown: vi.fn(async () => {}),
  } satisfies CuaConnection;
  const connector = vi.fn(async () => client);
  return { client, backend: new CuaBackend('/test/driver.sock', connector, 'darwin'), state, connector };
}

describe('Cua socket adapter', () => {
  it('uses a verified executable identity and Windows health checks', async () => {
    const { client } = fixture();
    const processPaths = vi.fn(async () => new Map([[42, 'C:\\Fixtures\\Fixture.exe']]));
    const backend = new CuaBackend('C:\\Computer Use\\cua-driver.exe', async () => client, 'win32', processPaths);
    client.listApps.mockResolvedValue({
      apps: [
        { pid: 42, name: 'Fixture', running: true, active: false },
        { pid: 99, name: 'Unidentified', running: true, active: true },
      ],
    });
    const appId = 'win32:c:\\fixtures\\fixture.exe';
    const windowsTarget: Target = { ...target, appId };
    expect(await backend.targets({ appIds: [appId], browser: false })).toEqual([windowsTarget]);
    await expect(backend.observe(windowsTarget)).resolves.toMatchObject({ target: windowsTarget });
    client.listApps.mockResolvedValueOnce({
      apps: [{ pid: 42, name: 'Other', running: true, active: true, launchPath: 'C:\\Other\\Fixture.exe' }],
    });
    await expect(backend.observe(windowsTarget)).rejects.toMatchObject({ code: 'not_found' });
    expect(processPaths).toHaveBeenCalledWith([42]);
    client.callTool.mockImplementation(async () => ({
      ...success(),
      structuredJson: JSON.stringify({
        schema_version: '1',
        platform: 'win32',
        checks: [
          { name: 'session_active', status: 'pass' },
          { name: 'ax_capability', status: 'pass' },
          { name: 'screen_capture_capability', status: 'pass' },
        ],
      }),
    }));
    expect((await backend.doctor()).available).toBe(true);
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(client.callTool.mock.calls[0]?.[0]).toBe('health_report');
  });

  it('filters before enumerating windows and never launches apps', async () => {
    const { client, backend } = fixture();
    expect(await backend.targets({ appIds: ['test.fixture'], browser: false })).toEqual([target]);
    expect(client.listWindows).toHaveBeenCalledTimes(1);
    expect(client.listWindows.mock.calls[0]?.[0]).toMatchObject({ pid: 42 });
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it('replaces an idle SDK client before the implicit session expires', async () => {
    vi.useFakeTimers();
    try {
      const { client, backend, connector } = fixture();
      const replacement = fixture().client;
      connector.mockResolvedValueOnce(client).mockResolvedValueOnce(replacement);
      await backend.targets({ appIds: ['test.fixture'], browser: false });
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await backend.targets({ appIds: ['test.fixture'], browser: false });
      expect(connector).toHaveBeenCalledTimes(2);
      expect(client.shutdown).toHaveBeenCalledTimes(1);
      expect(client.listApps).toHaveBeenCalledTimes(1);
      expect(replacement.listApps).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects after a failed read without replaying input', async () => {
    const { client, backend, connector } = fixture();
    const replacement = fixture().client;
    connector.mockResolvedValueOnce(client).mockResolvedValueOnce(replacement);
    client.listApps.mockRejectedValueOnce(new Error('stale SDK transport'));
    expect(await backend.targets({ appIds: ['test.fixture'], browser: false })).toEqual([target]);
    expect(connector).toHaveBeenCalledTimes(2);
    expect(replacement.listApps).toHaveBeenCalledTimes(1);
    const observation = await backend.observe(target);
    replacement.callTool.mockRejectedValueOnce(new Error('uncertain input'));
    await expect(
      backend.act(observation, { type: 'click', elementId: 's1:1' }, 'background', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'unknown_outcome' });
    expect(connector).toHaveBeenCalledTimes(2);
    expect(replacement.callTool).toHaveBeenCalledTimes(1);
  });

  it('keeps screenshot pixel dimensions separate from native bounds and validates without rebuilding AX', async () => {
    const { client, backend } = fixture();
    const observation = await backend.observe(target);
    expect(observation.imageWidth).toBe(600);
    expect(observation.bounds.width).toBe(300);
    expect(observation.elements[0]?.bounds).toEqual({ x: -16, y: -34, width: 40, height: 20 });
    expect(observation.elementsComplete).toBe(false);
    expect(await backend.validate(observation)).toBe(true);
    expect(client.getWindowState).toHaveBeenCalledTimes(1);
    client.listWindows.mockResolvedValueOnce({
      windows: [{ windowId: 19n, pid: 42, appName: 'Fixture', title: 'Fixture', bounds: { ...bounds, x: 11 }, isOnScreen: true }],
    });
    expect(await backend.validate(observation)).toBe(false);
  });

  it('refuses reused PIDs belonging to another application', async () => {
    const { client, backend } = fixture();
    client.listApps.mockResolvedValueOnce({ apps: [{ pid: 42, name: 'Other', running: true, active: true, bundleId: 'other.app' }] });
    await expect(backend.observe(target)).rejects.toMatchObject({ code: 'not_found' });
    expect(client.getWindowState).not.toHaveBeenCalled();
  });

  it('passes foreground/background explicitly and consumes an observation once', async () => {
    const { client, backend } = fixture();
    const observation = await backend.observe(target);
    await backend.act(observation, { type: 'click', elementId: 's1:1' }, 'background', new AbortController().signal);
    const [tool, json] = client.callTool.mock.calls[0]!;
    expect(tool).toBe('click');
    expect(JSON.parse(json)).toMatchObject({ pid: 42, window_id: 19, delivery_mode: 'background', element_token: 's1:1' });
    await expect(
      backend.act(observation, { type: 'click', elementId: 's1:1' }, 'foreground', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'stale_snapshot' });
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it('does not retry refused background actions in foreground', async () => {
    const { client, backend } = fixture();
    client.callTool.mockResolvedValue({ ...success(), isError: true, errorCode: 'background_unavailable' });
    await expect(
      backend.act(await backend.observe(target), { type: 'click', point: { x: 25, y: 50 } }, 'background', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'background_unavailable' });
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it('retains a safe driver error code when a dispatched action outcome is unknown', async () => {
    const { client, backend } = fixture();
    client.callTool.mockResolvedValueOnce({ ...success(), isError: true, errorCode: 'window_busy' });
    await expect(
      backend.act(await backend.observe(target), { type: 'click', elementId: 's1:1' }, 'background', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'unknown_outcome', message: expect.stringContaining('driver code window_busy') });
    client.callTool.mockResolvedValueOnce({ ...success(), isError: true, errorCode: 'private user text: 中文' });
    await expect(
      backend.act(await backend.observe(target), { type: 'click', elementId: 's1:1' }, 'background', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'unknown_outcome', message: 'Desktop action outcome is unknown. Observe before retrying.' });
    expect(client.callTool).toHaveBeenCalledTimes(2);
  });

  it('routes typing and hotkeys through the explicit window and delivery mode', async () => {
    const { client, backend } = fixture();
    await backend.act(
      await backend.observe(target),
      { type: 'type', text: '中文🙂', elementId: 's1:1' },
      'background',
      new AbortController().signal,
    );
    await backend.act(await backend.observe(target), { type: 'key', keys: ['cmd', 's'] }, 'foreground', new AbortController().signal);
    expect(client.callTool.mock.calls.map(([tool, args]) => [tool, JSON.parse(args)])).toMatchObject([
      ['type_text', { text: '中文🙂', element_token: 's1:1', delivery_mode: 'background', window_id: 19 }],
      ['hotkey', { keys: ['cmd', 's'], delivery_mode: 'foreground', window_id: 19 }],
    ]);
  });

  it('uses Windows UIA for element-directed typing even in an approved foreground session', async () => {
    const { client } = fixture();
    const processPaths = vi.fn(async () => new Map([[42, 'C:\\Fixtures\\Fixture.exe']]));
    const backend = new CuaBackend('C:\\Computer Use\\cua-driver.exe', async () => client, 'win32', processPaths);
    const windowsTarget: Target = { ...target, appId: 'win32:c:\\fixtures\\fixture.exe' };
    const observation = await backend.observe(windowsTarget);
    await backend.act(observation, { type: 'type', text: '长文本🙂', elementId: 's1:1' }, 'foreground', new AbortController().signal);
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(client.callTool.mock.calls[0]?.[0]).toBe('type_text');
    expect(JSON.parse(client.callTool.mock.calls[0]![1])).toMatchObject({
      pid: 42,
      window_id: 19,
      element_token: 's1:1',
      delivery_mode: 'background',
      text: '长文本🙂',
    });
    await expect(
      backend.act(observation, { type: 'type', text: 'again', elementId: 's1:1' }, 'foreground', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'stale_snapshot' });
    expect(client.callTool).toHaveBeenCalledTimes(1);
    await backend.act(await backend.observe(windowsTarget), { type: 'type', text: 'plain' }, 'foreground', new AbortController().signal);
    expect(JSON.parse(client.callTool.mock.calls[1]![1])).toMatchObject({ delivery_mode: 'foreground', text: 'plain' });
    expect(client.callTool.mock.calls[1]![1]).not.toContain('element_token');
    expect(processPaths).toHaveBeenCalledWith([42]);
  });

  it('routes Windows element clicks through the semantic path without retrying refused or uncertain results', async () => {
    const { client } = fixture();
    const processPaths = vi.fn(async () => new Map([[42, 'C:\\Fixtures\\Fixture.exe']]));
    const backend = new CuaBackend('C:\\Computer Use\\cua-driver.exe', async () => client, 'win32', processPaths);
    const windowsTarget: Target = { ...target, appId: 'win32:c:\\fixtures\\fixture.exe' };
    await backend.act(
      await backend.observe(windowsTarget),
      { type: 'click', elementId: 's1:1' },
      'foreground',
      new AbortController().signal,
    );
    expect(JSON.parse(client.callTool.mock.calls[0]![1])).toMatchObject({ element_token: 's1:1', delivery_mode: 'background' });
    await backend.act(
      await backend.observe(windowsTarget),
      { type: 'click', point: { x: 25, y: 50 } },
      'foreground',
      new AbortController().signal,
    );
    expect(JSON.parse(client.callTool.mock.calls[1]![1])).toMatchObject({ delivery_mode: 'foreground' });
    client.callTool.mockResolvedValueOnce({ ...success(), isError: true, errorCode: 'background_unavailable' });
    await expect(
      backend.act(await backend.observe(windowsTarget), { type: 'click', elementId: 's1:1' }, 'foreground', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'background_unavailable' });
    expect(client.callTool).toHaveBeenCalledTimes(3);
    client.callTool.mockResolvedValueOnce({ ...success(), isError: true });
    await expect(
      backend.act(await backend.observe(windowsTarget), { type: 'click', elementId: 's1:1' }, 'foreground', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'unknown_outcome' });
    expect(client.callTool).toHaveBeenCalledTimes(4);
  });

  it('does not dispatch Windows element text with a stale target identity or retry after refusal or uncertainty', async () => {
    const { client } = fixture();
    const processPaths = vi.fn(async () => new Map([[42, 'C:\\Fixtures\\Fixture.exe']]));
    const backend = new CuaBackend('C:\\Computer Use\\cua-driver.exe', async () => client, 'win32', processPaths);
    const windowsTarget: Target = { ...target, appId: 'win32:c:\\fixtures\\fixture.exe' };
    const first = await backend.observe(windowsTarget);
    processPaths.mockResolvedValueOnce(new Map([[42, 'C:\\Other\\Fixture.exe']]));
    await expect(
      backend.act(first, { type: 'type', text: 'blocked', elementId: 's1:1' }, 'foreground', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'stale_snapshot' });
    expect(client.callTool).not.toHaveBeenCalled();
    const second = await backend.observe(windowsTarget);
    await expect(
      backend.act(second, { type: 'type', text: 'blocked', elementId: 'other:1' }, 'foreground', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'stale_snapshot' });
    expect(client.callTool).not.toHaveBeenCalled();
    client.callTool.mockResolvedValueOnce({ ...success(), isError: true, errorCode: 'background_unavailable' });
    await expect(
      backend.act(second, { type: 'type', text: 'refused', elementId: 's1:1' }, 'foreground', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'background_unavailable' });
    expect(client.callTool).toHaveBeenCalledTimes(1);
    client.callTool.mockResolvedValueOnce({ ...success(), action: { effect: 1, route: 0 } });
    await expect(
      backend.act(
        await backend.observe(windowsTarget),
        { type: 'type', text: 'uncertain', elementId: 's1:1' },
        'foreground',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ effect: 'unconfirmed' });
    expect(client.callTool).toHaveBeenCalledTimes(2);
    expect(client.callTool.mock.calls.every(([, args]) => JSON.parse(args).delivery_mode === 'background')).toBe(true);
  });

  it('preserves scroll units and complete drag parameters', async () => {
    const { client, backend } = fixture();
    await backend.act(
      await backend.observe(target),
      { type: 'scroll', direction: 'down', amount: 2, unit: 'page' },
      'background',
      new AbortController().signal,
    );
    await backend.act(
      await backend.observe(target),
      {
        type: 'drag',
        path: [
          { x: 1, y: 2 },
          { x: 99, y: 88 },
        ],
        durationMs: 800,
        modifiers: ['shift'],
        button: 'right',
      },
      'foreground',
      new AbortController().signal,
    );
    expect(client.callTool.mock.calls.map(([tool, args]) => [tool, JSON.parse(args)])).toMatchObject([
      ['scroll', { direction: 'up', amount: 2, by: 'page', x: 300, y: 200, delivery_mode: 'background' }],
      [
        'drag',
        { from_x: 1, from_y: 2, to_x: 99, to_y: 88, duration_ms: 800, modifier: ['shift'], button: 'right', delivery_mode: 'foreground' },
      ],
    ]);
  });

  it('reverses macOS wheel scroll directions only', async () => {
    const { client, backend } = fixture();
    for (const direction of ['down', 'up', 'left', 'right'] as const) {
      await backend.act(
        await backend.observe(target),
        { type: 'scroll', direction, amount: 1, unit: 'line' },
        'background',
        new AbortController().signal,
      );
    }
    expect(client.callTool.mock.calls.map(([, args]) => JSON.parse(args).direction)).toEqual(['up', 'down', 'right', 'left']);
    const other = fixture().client;
    const windows = new CuaBackend(
      'C:\\Computer Use\\cua-driver.exe',
      async () => other,
      'win32',
      async () => new Map([[42, 'C:\\Fixtures\\Fixture.exe']]),
    );
    const windowsTarget: Target = { ...target, appId: 'win32:c:\\fixtures\\fixture.exe' };
    await windows.act(
      await windows.observe(windowsTarget),
      { type: 'scroll', direction: 'down', amount: 1, unit: 'line' },
      'background',
      new AbortController().signal,
    );
    expect(JSON.parse(other.callTool.mock.calls.at(-1)![1]).direction).toBe('down');
  });

  it('rejects unsupported paths, background drags, and out of image points before dispatch', async () => {
    const { client, backend } = fixture();
    const observation = await backend.observe(target);
    const signal = new AbortController().signal;
    await expect(
      backend.act(
        observation,
        {
          type: 'drag',
          path: [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
            { x: 3, y: 3 },
          ],
          durationMs: 20,
        },
        'foreground',
        signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      backend.act(
        observation,
        {
          type: 'drag',
          path: [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
          ],
          durationMs: 20,
        },
        'background',
        signal,
      ),
    ).rejects.toMatchObject({ code: 'background_unavailable' });
    await expect(backend.act(observation, { type: 'click', point: { x: 600, y: 1 } }, 'foreground', signal)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3] as const)('returns completed but unconfirmed effect %s without interrupting the backend', async effect => {
    const { client, backend } = fixture();
    client.callTool.mockResolvedValue({ ...success(), action: { effect, route: 1 } });
    await expect(
      backend.act(await backend.observe(target), { type: 'key', keys: ['tab'] }, 'background', new AbortController().signal),
    ).resolves.toEqual({ effect: 'unconfirmed' });
    await expect(
      backend.act(await backend.observe(target), { type: 'key', keys: ['tab'] }, 'background', new AbortController().signal),
    ).resolves.toEqual({ effect: 'unconfirmed' });
  });

  it('does not infer evidence from a result with no action metadata and rejects an explicit refusal', async () => {
    const { client, backend } = fixture();
    const { action: _, ...withoutAction } = success();
    client.callTool.mockResolvedValueOnce(withoutAction);
    await expect(
      backend.act(await backend.observe(target), { type: 'click', elementId: 's1:1' }, 'background', new AbortController().signal),
    ).resolves.toEqual({ effect: 'unconfirmed' });
    client.callTool.mockResolvedValueOnce({ ...success(), action: { effect: 4, route: 0 } });
    await expect(
      backend.act(await backend.observe(target), { type: 'click', elementId: 's1:1' }, 'background', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('cancels an in-flight native request and preserves outcome uncertainty', async () => {
    const { client, backend } = fixture();
    const observation = await backend.observe(target);
    const started = Promise.withResolvers<void>();
    client.callTool.mockImplementation(async (_tool, _args, options) => {
      started.resolve();
      return await new Promise((_resolve, reject) =>
        options!.signal.addEventListener('abort', () => reject(new Error('private user text')), { once: true }),
      );
    });
    const action = backend.act(observation, { type: 'key', keys: ['tab'] }, 'background', new AbortController().signal);
    const assertion = expect(action).rejects.toMatchObject({
      code: 'unknown_outcome',
      message: 'Desktop action outcome is unknown. Observe before retrying.',
    });
    await started.promise;
    await backend.cancel();
    await assertion;
    await expect(
      backend.act(await backend.observe(target), { type: 'key', keys: ['tab'] }, 'background', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await backend.close();
    expect(client.endSession).toHaveBeenCalledTimes(1);
    expect(client.shutdown).toHaveBeenCalledTimes(1);
  });

  it('checks permissions without prompting and fails closed on version mismatch', async () => {
    const { client, backend } = fixture();
    client.callTool.mockResolvedValue({ ...success(), structuredJson: JSON.stringify({ accessibility: true, screen_recording: false }) });
    expect((await backend.doctor()).available).toBe(false);
    expect(JSON.parse(client.callTool.mock.calls[1]![1])).toEqual({ prompt: false });
    const incompatible = fixture();
    incompatible.client.metadata.mockResolvedValue({
      driverVersion: '0.29.0',
      contractVersion: '0.8.0',
      toolsListSchemaVersion: '1',
      capabilityVersion: '1',
      mcpProtocolVersion: '2025-06-18',
      pid: 100,
      embedded: true,
    });
    expect((await incompatible.backend.doctor()).available).toBe(false);
    expect(incompatible.client.callTool).not.toHaveBeenCalled();
  });

  it('converts offset AX frames to pixels for Retina and downscaled screenshots', async () => {
    const { backend, state } = fixture();
    state.windowBounds = { x: -200, y: 120, width: 300, height: 200 };
    state.elements![0]!.frame = { x: -150, y: 150, w: 20, h: 10 };
    expect((await backend.observe(target)).elements[0]?.bounds).toEqual({ x: 100, y: 60, width: 40, height: 20 });
    state.screenshotWidth = 150;
    state.screenshotHeight = 100;
    expect((await backend.observe(target)).elements[0]?.bounds).toEqual({ x: 25, y: 15, width: 10, height: 5 });
  });

  it.each([
    ['same_pid_keyboard_ambiguity', 'background_unavailable'],
    ['off_space_or_ax_unresolved', 'background_unavailable'],
    ['minimized_or_hidden_window', 'background_unavailable'],
    ['px_capture_unavailable', 'stale_snapshot'],
    ['px_frame_mismatch', 'stale_snapshot'],
    ['px_window_not_found', 'stale_snapshot'],
    ['window_id_not_found', 'not_found'],
  ])('maps the pre-dispatch driver refusal %s to %s instead of an unknown outcome', async (driverCode, code) => {
    const { client, backend } = fixture();
    client.callTool.mockResolvedValueOnce({ ...success(), isError: true, errorCode: driverCode });
    await expect(
      backend.act(await backend.observe(target), { type: 'key', keys: ['return'] }, 'background', new AbortController().signal),
    ).rejects.toMatchObject({ code });
    await expect(
      backend.act(await backend.observe(target), { type: 'key', keys: ['tab'] }, 'background', new AbortController().signal),
    ).resolves.toEqual({ effect: 'confirmed' });
  });

  it('warms the capture pipeline immediately before pointer actions only', async () => {
    const { client, backend } = fixture();
    const order: string[] = [];
    client.getWindowState.mockImplementation(async input => {
      order.push(input.includeAccessibilityTree ? 'observe' : 'warm');
      return fixture().state;
    });
    client.callTool.mockImplementation(async tool => {
      order.push(tool);
      return success();
    });
    await backend.act(
      await backend.observe(target),
      { type: 'click', point: { x: 25, y: 50 } },
      'foreground',
      new AbortController().signal,
    );
    await backend.act(
      await backend.observe(target),
      { type: 'scroll', direction: 'down', amount: 1, unit: 'line' },
      'background',
      new AbortController().signal,
    );
    await backend.act(await backend.observe(target), { type: 'click', elementId: 's1:1' }, 'background', new AbortController().signal);
    await backend.act(await backend.observe(target), { type: 'key', keys: ['return'] }, 'foreground', new AbortController().signal);
    expect(order).toEqual(['observe', 'warm', 'click', 'observe', 'warm', 'scroll', 'observe', 'click', 'observe', 'hotkey']);
    expect(
      client.getWindowState.mock.calls
        .filter(([input]) => !input.includeAccessibilityTree)
        .every(([input]) => input.includeScreenshot && input.pid === 42 && input.windowId === 19n),
    ).toBe(true);
  });

  it('omits off-screen application menu contents such as browsing history but keeps visible menu titles', async () => {
    const { backend, state } = fixture();
    const item = (
      elementIndex: bigint,
      role: string,
      label: string,
      parentIndex: bigint | undefined,
      frame?: { x: number; y: number; w: number; h: number },
    ) => ({
      elementIndex,
      role,
      label,
      depth: 0,
      elementToken: `s1:${elementIndex}`,
      ...(parentIndex === undefined ? {} : { parentIndex }),
      ...(frame ? { frame } : {}),
    });
    state.elements = [
      state.elements![0]!,
      item(6n, 'AXMenuBar', '', undefined, { x: 0, y: -30, w: 300, h: 30 }),
      item(7n, 'AXMenuBarItem', 'Apple', 6n, { x: 10, y: -30, w: 20, h: 30 }),
      item(20n, 'AXMenuBarItem', '历史记录', 6n, { x: 40, y: -30, w: 60, h: 30 }),
      item(21n, 'AXMenu', '', 20n),
      item(22n, 'AXMenuItem', 'secret - Google 搜索', 21n),
      item(30n, 'AXMenuBarItem', '文件', 6n, { x: 110, y: -30, w: 40, h: 30 }),
      item(31n, 'AXMenu', '', 30n, { x: 110, y: 0, w: 200, h: 100 }),
      item(32n, 'AXMenuItem', '新建窗口', 31n, { x: 110, y: 5, w: 200, h: 20 }),
    ];
    expect((await backend.observe(target)).elements.map(element => element.label)).toEqual([
      'Save',
      '',
      '历史记录',
      '文件',
      '',
      '新建窗口',
    ]);
  });

  it('uses a new driver session after reconnecting because an ended session id rejects every later call', async () => {
    const { client, backend, connector } = fixture();
    const replacement = fixture().client;
    connector.mockResolvedValueOnce(client).mockResolvedValueOnce(replacement);
    await backend.observe(target);
    const first = client.getWindowState.mock.calls[0]![0].session;
    client.getWindowState.mockRejectedValue(new Error(`session '${first}' has ended`));
    replacement.getWindowState.mockImplementation(async input => {
      if (input.session === first) throw new Error(`session '${first}' has ended`);
      return fixture().state;
    });
    const observation = await backend.observe(target);
    const renewed = replacement.getWindowState.mock.calls[0]![0].session;
    expect(renewed).not.toBe(first);
    await backend.act(observation, { type: 'key', keys: ['tab'] }, 'background', new AbortController().signal);
    expect(JSON.parse(replacement.callTool.mock.calls[0]![1]).session).toBe(renewed);
  });

  it('refuses to dispatch old-session element tokens after an idle connection rotation', async () => {
    vi.useFakeTimers();
    try {
      const { client, backend, connector } = fixture();
      const replacement = fixture().client;
      connector.mockResolvedValueOnce(client).mockResolvedValueOnce(replacement);
      const observation = await backend.observe(target);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await expect(
        backend.act(observation, { type: 'click', elementId: 's1:1' }, 'background', new AbortController().signal),
      ).rejects.toMatchObject({ code: 'stale_snapshot' });
      expect(client.callTool).not.toHaveBeenCalled();
      expect(replacement.callTool).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries one read-only capture when a fresh driver connection returns no screenshot', async () => {
    const { client, backend, state } = fixture();
    const { windowBounds: _, screenshotWidth: __, screenshotHeight: ___, ...rest } = state;
    const uncaptured = { ...rest, images: [] };
    client.getWindowState.mockResolvedValueOnce({ ...uncaptured, screenshotFrameValid: false });
    await expect(backend.observe(target)).resolves.toMatchObject({ imageWidth: 600, screenshot: { data: 'fixture-image' } });
    expect(client.getWindowState).toHaveBeenCalledTimes(2);
    client.getWindowState
      .mockResolvedValueOnce({ ...uncaptured, screenshotFrameValid: false })
      .mockResolvedValueOnce({ ...uncaptured, screenshotFrameValid: false });
    await expect(backend.observe(target)).rejects.toMatchObject({ code: 'unavailable' });
    expect(client.getWindowState).toHaveBeenCalledTimes(4);
  });

  it('omits the system Apple menu subtree but keeps the application menus', async () => {
    const { client, backend, state } = fixture();
    const menu = (elementIndex: bigint, role: string, label: string, depth: number, parentIndex?: bigint) => ({
      elementIndex,
      role,
      label,
      depth,
      elementToken: `s1:${elementIndex}`,
      ...(parentIndex === undefined ? {} : { parentIndex }),
    });
    state.elementsComplete = true;
    state.elements = [
      state.elements![0]!,
      menu(6n, 'AXMenuBar', '', 0),
      menu(7n, 'AXMenuBarItem', 'Apple', 1, 6n),
      menu(8n, 'AXMenu', '', 2, 7n),
      menu(9n, 'AXMenuItem', '关机', 3, 8n),
      menu(13n, 'AXMenuItem', '最近使用的项目', 3, 8n),
      menu(14n, 'AXMenu', '', 4, 13n),
      menu(15n, 'AXMenuItem', 'secret-project', 5, 14n),
      { ...menu(73n, 'AXMenuBarItem', 'Fixture', 1, 6n), frame: { x: 43, y: 0, w: 162, h: 39 } },
      { ...menu(74n, 'AXMenuItem', 'Save', 2, 73n), frame: { x: 43, y: 40, w: 162, h: 20 } },
    ];
    const observation = await backend.observe(target);
    expect(observation.elements.map(element => element.id)).toEqual(['s1:1', 's1:6', 's1:73', 's1:74']);
    expect(observation.elementsComplete).toBe(false);
    await expect(
      backend.act(observation, { type: 'click', elementId: 's1:9' }, 'background', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'stale_snapshot' });
    expect(client.callTool).not.toHaveBeenCalled();
    const windows = new CuaBackend(
      'C:\\Computer Use\\cua-driver.exe',
      async () => client,
      'win32',
      async () => new Map([[42, 'C:\\Fixtures\\Fixture.exe']]),
    );
    expect((await windows.observe({ ...target, appId: 'win32:c:\\fixtures\\fixture.exe' })).elements).toHaveLength(10);
  });

  it('refreshes the window title from the live observation', async () => {
    const { backend, state } = fixture();
    state.windowTitle = 'Saved document';
    expect((await backend.observe(target)).target.title).toBe('Saved document');
    expect(target.title).toBe('Fixture');
  });

  it('requires a measured matching parent application identity in doctor', async () => {
    const { client, backend } = fixture();
    const data = {
      identity_source: 'parent_application',
      bundle_identifier: 'com.starroy.computeruse',
      configured_bundle_identifier: 'com.starroy.computeruse',
    };
    client.callTool.mockImplementation(async tool => ({
      ...success(),
      structuredJson: JSON.stringify(
        tool === 'health_report'
          ? { schema_version: '1', checks: [{ name: 'bundle_identity', status: 'pass', data }] }
          : { accessibility: true, screen_recording: true },
      ),
    }));
    const doctor = await backend.doctor();
    expect(doctor.available).toBe(true);
    expect(doctor.checks.find(check => check.name === 'screen_recording')?.detail).toContain('was not probed');
    data.bundle_identifier = 'com.apple.Terminal';
    expect((await backend.doctor()).available).toBe(false);
  });
});
