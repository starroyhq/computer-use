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
  // macOS 的归属校验通过 get_accessibility_tree 取运行中的应用。这里由 listApps 的模拟结果换算，
  // 因此调整应用列表的用例照常生效，而 callTool 的调用记录里只有动作本身。
  const routed: CuaConnection = {
    ...client,
    callTool: async (name, argumentsJson, options) => {
      if (name !== 'get_accessibility_tree') return client.callTool(name, argumentsJson, options);
      const { apps } = await client.listApps({}, options);
      return {
        ...success(),
        structuredJson: JSON.stringify({
          apps: apps.filter(app => app.running).map(app => ({ pid: app.pid, name: app.name, bundle_id: app.bundleId })),
          windows: [],
        }),
      };
    },
  };
  const connector = vi.fn(async () => routed);
  return { client, connection: routed, backend: new CuaBackend('/test/driver.sock', connector, 'darwin'), state, connector };
}

function textFixture(role = 'AXTextField') {
  const value = fixture();
  Object.assign(value.state.elements![0]!, {
    role,
    actions: ['AXShowMenu', 'AXConfirm'],
    frame: { x: 30, y: 40, w: 100, h: 30 },
  });
  return value;
}

describe('Cua socket adapter', () => {
  it('uses a verified executable identity and Windows health checks', async () => {
    vi.useFakeTimers();
    try {
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
      await vi.advanceTimersByTimeAsync(1_000);
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
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters before enumerating windows and never launches apps', async () => {
    const { client, backend } = fixture();
    expect(await backend.targets({ appIds: ['test.fixture'], browser: false })).toEqual([target]);
    expect(client.listWindows).toHaveBeenCalledTimes(1);
    expect(client.listWindows.mock.calls[0]?.[0]).toMatchObject({ pid: 42 });
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it('discovers every identified running app for an all-app grant while still checking window ownership', async () => {
    const { client, backend } = fixture();
    client.listApps.mockResolvedValue({
      apps: [
        { pid: 42, name: 'Fixture', running: true, active: false, bundleId: 'test.fixture' },
        { pid: 99, name: 'Other', running: true, active: true, bundleId: 'other.app' },
        { pid: 100, name: 'Unidentified', running: true, active: false },
        { pid: 101, name: 'Stopped', running: false, active: false, bundleId: 'stopped.app' },
      ],
    });
    client.listWindows.mockImplementation(async ({ pid }) => ({
      windows: [
        { windowId: 19n, pid, appName: 'App', title: 'Window', bounds, isOnScreen: true },
        { windowId: 20n, pid: 777, appName: 'Wrong owner', title: 'Window', bounds, isOnScreen: true },
      ],
    }));
    expect(await backend.targets({ appIds: [], browser: false })).toEqual([]);
    expect(client.listApps).not.toHaveBeenCalled();
    expect(await backend.targets({ appIds: [], allApps: true, browser: false })).toEqual([
      { ...target, title: 'Window' },
      { ...target, id: 'desktop:99:19', appId: 'other.app', pid: 99, title: 'Window' },
    ]);
    expect(client.listWindows).toHaveBeenCalledTimes(2);
    expect(client.callTool).not.toHaveBeenCalled();
    expect(await backend.observe(target)).toMatchObject({ target });
    await expect(backend.observe({ ...target, appId: 'wrong.app' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('keeps Windows executable identity checks when every application is authorized', async () => {
    const { client } = fixture();
    const paths = new Map([
      [42, 'C:\\Apps\\Fixture.exe'],
      [99, 'C:\\Apps\\Other.exe'],
      [100, 'C:\\Apps\\Actual.exe'],
    ]);
    const backend = new CuaBackend(
      'C:\\Driver\\cua-driver.exe',
      async () => client,
      'win32',
      async () => paths,
    );
    client.listApps.mockResolvedValue({
      apps: [
        { pid: 42, name: 'Fixture', running: true, active: false },
        { pid: 99, name: 'Other', running: true, active: false, launchPath: 'C:\\Apps\\Other.exe' },
        { pid: 100, name: 'Mismatched', running: true, active: false, launchPath: 'C:\\Apps\\Claimed.exe' },
        { pid: 101, name: 'Unidentified', running: true, active: false },
      ],
    });
    client.listWindows.mockImplementation(async ({ pid }) => ({
      windows: [{ windowId: 19n, pid, appName: 'App', title: 'Fixture', bounds, isOnScreen: true }],
    }));
    const listed = await backend.targets({ appIds: [], allApps: true, browser: false });
    expect(listed.map(item => item.appId)).toEqual(['win32:c:\\apps\\fixture.exe', 'win32:c:\\apps\\other.exe']);
    expect(client.listWindows).toHaveBeenCalledTimes(2);
    paths.set(42, 'C:\\Apps\\Replacement.exe');
    await expect(backend.observe(listed[0]!)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('replaces an idle SDK client before the implicit session expires', async () => {
    vi.useFakeTimers();
    try {
      const { client, backend, connector, connection } = fixture();
      const second = fixture();
      const replacement = second.client;
      connector.mockResolvedValueOnce(connection).mockResolvedValueOnce(second.connection);
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
    const { client, backend, connector, connection } = fixture();
    const second = fixture();
    const replacement = second.client;
    connector.mockResolvedValueOnce(connection).mockResolvedValueOnce(second.connection);
    // 失效的客户端上，轻量列表（由 listApps 模拟换算）和回退的 list_apps 都会失败，读取才会换连接重试。
    client.listApps.mockRejectedValue(new Error('stale SDK transport'));
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

  it.each([
    { role: 'AXTextField', mode: 'background', width: 600, height: 400, x: 140, y: 70 },
    { role: 'AXTextArea', mode: 'foreground', width: 600, height: 400, x: 140, y: 70 },
    { role: 'AXTextField', mode: 'foreground', width: 150, height: 100, x: 35, y: 17.5 },
    { role: 'AXTextArea', mode: 'background', width: 150, height: 100, x: 35, y: 17.5 },
  ] as const)(
    'dispatches one exact-window $role click in $mode using $width-pixel geometry',
    async ({ role, mode, width, height, x, y }) => {
      const { client, backend, state } = textFixture(role);
      state.screenshotWidth = width;
      state.screenshotHeight = height;
      client.callTool.mockResolvedValue({ ...success(), action: { effect: 2, route: 1 } });
      const dispatched = vi.fn();
      const observation = await backend.observe(target);
      await expect(
        backend.act(observation, { type: 'click', elementId: 's1:1' }, mode, new AbortController().signal, dispatched),
      ).resolves.toEqual({ effect: 'unconfirmed' });
      expect(dispatched).toHaveBeenCalledTimes(1);
      expect(client.callTool).toHaveBeenCalledTimes(1);
      expect(client.callTool.mock.calls[0]![0]).toBe('click');
      expect(JSON.parse(client.callTool.mock.calls[0]![1])).toEqual({
        pid: 42,
        window_id: 19,
        session: client.getWindowState.mock.calls[0]![0].session,
        delivery_mode: mode,
        button: 'left',
        count: 1,
        x,
        y,
      });
      expect(client.getWindowState).toHaveBeenCalledTimes(1);
      await expect(
        backend.act(observation, { type: 'click', elementId: 's1:1' }, mode, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'stale_snapshot' });
      expect(client.callTool).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { label: 'text field advertising press', role: 'AXTextField', actions: ['AXPress'], button: 'left' },
    { label: 'text area advertising press', role: 'AXTextArea', actions: ['AXPress', 'AXShowMenu'], button: 'left' },
    { label: 'unknown text capabilities', role: 'AXTextField', actions: undefined, button: 'left' },
    { label: 'button', role: 'AXButton', actions: ['AXPress'], button: 'left' },
    { label: 'other role without press', role: 'AXStaticText', actions: [], button: 'left' },
    { label: 'right text click', role: 'AXTextField', actions: ['AXConfirm'], button: 'right' },
    { label: 'middle text click', role: 'AXTextField', actions: ['AXConfirm'], button: 'middle' },
  ] as const)('preserves the element token for $label', async ({ role, actions, button }) => {
    const { client, backend, state } = textFixture(role);
    if (actions === undefined) delete state.elements![0]!.actions;
    else state.elements![0]!.actions = [...actions];
    await backend.act(
      await backend.observe(target),
      { type: 'click', elementId: 's1:1', button },
      'background',
      new AbortController().signal,
    );
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(JSON.parse(client.callTool.mock.calls[0]![1])).toMatchObject({ element_token: 's1:1', button, delivery_mode: 'background' });
    expect(JSON.parse(client.callTool.mock.calls[0]![1])).not.toHaveProperty('x');
  });

  it('keeps the Windows semantic route for text controls without AXPress', async () => {
    const { client } = textFixture();
    const backend = new CuaBackend(
      'C:\\Driver\\cua-driver.exe',
      async () => client,
      'win32',
      async () => new Map([[42, 'C:\\Fixtures\\Fixture.exe']]),
    );
    const windowsTarget: Target = { ...target, appId: 'win32:c:\\fixtures\\fixture.exe' };
    await backend.act(
      await backend.observe(windowsTarget),
      { type: 'click', elementId: 's1:1' },
      'foreground',
      new AbortController().signal,
    );
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(JSON.parse(client.callTool.mock.calls[0]![1])).toMatchObject({ element_token: 's1:1', delivery_mode: 'background' });
    expect(JSON.parse(client.callTool.mock.calls[0]![1])).not.toHaveProperty('x');
  });

  it.each([
    { label: 'missing', frame: undefined },
    { label: 'non-finite position', frame: { x: Number.NaN, y: 40, w: 100, h: 30 } },
    { label: 'non-finite size', frame: { x: 30, y: 40, w: Number.POSITIVE_INFINITY, h: 30 } },
    { label: 'zero width', frame: { x: 30, y: 40, w: 0, h: 30 } },
    { label: 'negative height', frame: { x: 30, y: 40, w: 100, h: -1 } },
    { label: 'partially outside left edge', frame: { x: 9, y: 40, w: 100, h: 30 } },
    { label: 'partially outside top edge', frame: { x: 30, y: 19, w: 100, h: 30 } },
    { label: 'partially outside right edge', frame: { x: 220, y: 40, w: 100, h: 30 } },
    { label: 'partially outside bottom edge', frame: { x: 30, y: 200, w: 100, h: 30 } },
  ])('rejects $label text geometry before dispatch', async ({ frame }) => {
    const { client, backend, state } = textFixture();
    if (frame) state.elements![0]!.frame = frame;
    else delete state.elements![0]!.frame;
    const dispatched = vi.fn();
    await expect(
      backend.act(
        await backend.observe(target),
        { type: 'click', elementId: 's1:1' },
        'background',
        new AbortController().signal,
        dispatched,
      ),
    ).rejects.toMatchObject({ code: 'background_unavailable' });
    expect(dispatched).not.toHaveBeenCalled();
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it('rejects disabled text controls without consuming their observation or sending input', async () => {
    const { client, backend, state } = textFixture();
    state.elements![0]!.enabled = false;
    const observation = await backend.observe(target);
    const dispatched = vi.fn();
    await expect(
      backend.act(observation, { type: 'click', elementId: 's1:1' }, 'background', new AbortController().signal, dispatched),
    ).rejects.toMatchObject({ code: 'background_unavailable' });
    expect(dispatched).not.toHaveBeenCalled();
    expect(client.callTool).not.toHaveBeenCalled();
    expect(await backend.validate(observation)).toBe(true);
  });

  it.each(['driver error', 'transport error'] as const)('never retries a routed text click after %s', async failure => {
    const { client, backend, connector, state } = textFixture();
    state.elements![0]!.actions = [];
    if (failure === 'driver error') client.callTool.mockResolvedValueOnce({ ...success(), isError: true });
    else client.callTool.mockRejectedValueOnce(new Error('uncertain transport'));
    const observation = await backend.observe(target);
    const dispatched = vi.fn();
    await expect(
      backend.act(observation, { type: 'click', elementId: 's1:1' }, 'background', new AbortController().signal, dispatched),
    ).rejects.toMatchObject({ code: 'unknown_outcome' });
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(JSON.parse(client.callTool.mock.calls[0]![1])).toMatchObject({ x: 140, y: 70, delivery_mode: 'background' });
    expect(JSON.parse(client.callTool.mock.calls[0]![1])).not.toHaveProperty('element_token');
    await expect(
      backend.act(observation, { type: 'click', elementId: 's1:1' }, 'foreground', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'stale_snapshot' });
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(connector).toHaveBeenCalledTimes(1);
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

  it('surfaces readable element values and states but never protected values', async () => {
    const { backend, state } = fixture();
    const common = { depth: 1, frame: { x: 12, y: 23, w: 20, h: 10 } };
    state.elements = [
      { elementIndex: 1n, role: 'AXTextField', label: 'Name', value: '中文内容', enabled: true, elementToken: 's1:1', ...common },
      { elementIndex: 2n, role: 'AXSecureTextField', label: 'Password', value: 'fixture-secret', elementToken: 's1:2', ...common },
      { elementIndex: 3n, role: 'Edit', label: 'PIN', value: '••••', elementToken: 's1:3', ...common },
      // macOS 实测：安全文本框的角色是普通 AXTextField，值是等长的 U+F79A。
      { elementIndex: 8n, role: 'AXTextField', label: 'Probe secret', value: '\uf79a'.repeat(19), elementToken: 's1:8', ...common },
      { elementIndex: 9n, role: 'AXTextField', label: 'One', value: '\uf79a', elementToken: 's1:9', ...common },
      // 没有名称的密码框：驱动用值充当标签，标签同样不能公开。
      { elementIndex: 6n, role: 'AXSecureTextField', label: 'unnamed-secret', value: 'unnamed-secret', elementToken: 's1:6', ...common },
      // 单个圆点是列表符号，照常保留。
      { elementIndex: 7n, role: 'AXStaticText', label: '•', value: '•', elementToken: 's1:7', ...common },
      {
        elementIndex: 4n,
        role: 'AXSlider',
        label: 'Volume',
        value: '0.25',
        min: 0,
        max: 1,
        enabled: false,
        selected: true,
        elementToken: 's1:4',
        ...common,
      },
      { elementIndex: 5n, role: 'AXTextField', label: 'Search', value: '', elementToken: 's1:5', ...common },
    ];
    const observation = await backend.observe(target);
    expect(observation.elements.map(({ bounds: _, ...element }) => element)).toEqual([
      { id: 's1:1', role: 'AXTextField', label: 'Name', value: '中文内容', enabled: true, depth: 1 },
      { id: 's1:2', role: 'AXSecureTextField', label: 'Password', depth: 1 },
      { id: 's1:3', role: 'Edit', label: 'PIN', depth: 1 },
      { id: 's1:8', role: 'AXTextField', label: 'Probe secret', depth: 1 },
      { id: 's1:9', role: 'AXTextField', label: 'One', depth: 1 },
      { id: 's1:6', role: 'AXSecureTextField', label: '', depth: 1 },
      { id: 's1:7', role: 'AXStaticText', label: '•', value: '•', depth: 1 },
      { id: 's1:4', role: 'AXSlider', label: 'Volume', value: '0.25', enabled: false, selected: true, min: 0, max: 1, depth: 1 },
      // 空值照常保留，才能验证“已清空”。
      { id: 's1:5', role: 'AXTextField', label: 'Search', value: '', depth: 1 },
    ]);
    for (const hidden of ['fixture-secret', 'unnamed-secret', '\uf79a']) expect(JSON.stringify(observation.elements)).not.toContain(hidden);
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

  it('skips the pointer warm-up while the observation frame is fresh, and never warms element or key actions', async () => {
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
    expect(order).toEqual(['observe', 'click', 'observe', 'scroll', 'observe', 'click', 'observe', 'hotkey']);
    expect(client.getWindowState.mock.calls.filter(([input]) => !input.includeAccessibilityTree)).toHaveLength(0);
  });

  it.each(['point', 'text element'] as const)('warms a %s action once the observation frame is a second old', async path => {
    vi.useFakeTimers();
    try {
      const { client, backend } = path === 'point' ? fixture() : textFixture();
      const observation = await backend.observe(target);
      await vi.advanceTimersByTimeAsync(1_000);
      await backend.act(
        observation,
        path === 'point' ? { type: 'click', point: { x: 25, y: 50 } } : { type: 'click', elementId: 's1:1' },
        'foreground',
        new AbortController().signal,
      );
      const warm = client.getWindowState.mock.calls.filter(([input]) => !input.includeAccessibilityTree);
      expect(warm).toHaveLength(1);
      expect(warm[0]?.[0]).toMatchObject({ includeScreenshot: true, pid: 42, windowId: 19n });
      expect(client.listApps).toHaveBeenCalledTimes(2);
      expect(client.callTool).toHaveBeenCalledTimes(1);
      expect(JSON.parse(client.callTool.mock.calls[0]![1])).not.toHaveProperty('element_token');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each<{ label: string; patch?: Partial<WindowStateOutput> }>([
    { label: 'capture failure' },
    { label: 'empty screenshot', patch: { images: [] } },
    { label: 'invalid screenshot frame', patch: { screenshotFrameValid: false } },
    { label: 'different process', patch: { pid: 99 } },
    { label: 'different window', patch: { windowId: 20n } },
    { label: 'moved window', patch: { windowBounds: { ...bounds, x: 11 } } },
    { label: 'resized window', patch: { windowBounds: { ...bounds, width: 301 } } },
    { label: 'changed image width', patch: { screenshotWidth: 300 } },
    { label: 'changed image height', patch: { screenshotHeight: 200 } },
  ])('refuses text clicks after warm-up with $label before any dispatch', async ({ patch }) => {
    vi.useFakeTimers();
    try {
      const { client, backend, state, connector } = textFixture();
      const observation = await backend.observe(target);
      await vi.advanceTimersByTimeAsync(1_000);
      if (patch) client.getWindowState.mockResolvedValueOnce({ ...state, ...patch });
      else client.getWindowState.mockRejectedValueOnce(new Error('capture failed'));
      const dispatched = vi.fn();
      await expect(
        backend.act(observation, { type: 'click', elementId: 's1:1' }, 'background', new AbortController().signal, dispatched),
      ).rejects.toMatchObject({ code: 'stale_snapshot' });
      expect(client.getWindowState).toHaveBeenCalledTimes(2);
      expect(client.getWindowState.mock.calls[1]![0]).toMatchObject({
        pid: 42,
        windowId: 19n,
        includeScreenshot: true,
        includeAccessibilityTree: false,
      });
      expect(dispatched).not.toHaveBeenCalled();
      expect(client.callTool).not.toHaveBeenCalled();
      expect(connector).toHaveBeenCalledTimes(1);
      await expect(
        backend.act(await backend.observe(target), { type: 'click', elementId: 's1:1' }, 'background', new AbortController().signal),
      ).resolves.toEqual({ effect: 'confirmed' });
      expect(client.callTool).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses the application list for one second across observe and act', async () => {
    vi.useFakeTimers();
    try {
      const { client, backend } = fixture();
      const observation = await backend.observe(target);
      await backend.act(observation, { type: 'click', point: { x: 25, y: 50 } }, 'background', new AbortController().signal);
      expect(client.listApps).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await backend.observe(target);
      expect(client.listApps).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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
    const { client, backend, connector, connection } = fixture();
    const second = fixture();
    const replacement = second.client;
    connector.mockResolvedValueOnce(connection).mockResolvedValueOnce(second.connection);
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
      const { client, backend, connector, connection } = fixture();
      const second = fixture();
      const replacement = second.client;
      connector.mockResolvedValueOnce(connection).mockResolvedValueOnce(second.connection);
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

  it('reports dispatch right before the driver call and not for an action cancelled during warm-up', async () => {
    vi.useFakeTimers();
    try {
      const { client, backend } = fixture();
      const order: string[] = [];
      client.callTool.mockImplementation(async tool => {
        order.push(tool);
        return success();
      });
      const dispatched = () => {
        order.push('dispatch');
      };
      const signal = new AbortController().signal;
      await backend.act(await backend.observe(target), { type: 'key', keys: ['tab'] }, 'background', signal, dispatched);
      expect(order).toEqual(['dispatch', 'hotkey']);
      const observation = await backend.observe(target);
      await vi.advanceTimersByTimeAsync(1_000);
      const controller = new AbortController();
      client.getWindowState.mockImplementationOnce(async () => {
        controller.abort();
        return fixture().state;
      });
      const click = backend.act(observation, { type: 'click', point: { x: 25, y: 50 } }, 'background', controller.signal, dispatched);
      await expect(click).rejects.toMatchObject({ code: 'cancelled' });
      expect(order).toEqual(['dispatch', 'hotkey']);
      const next = backend.act(await backend.observe(target), { type: 'key', keys: ['tab'] }, 'background', signal);
      await expect(next).resolves.toEqual({ effect: 'confirmed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the cached observation and screenshot when the runtime releases a target', async () => {
    const { client, backend } = fixture();
    const observation = await backend.observe(target);
    expect(await backend.validate(observation)).toBe(true);
    await backend.release(target);
    expect(await backend.validate(observation)).toBe(false);
    await expect(
      backend.act(observation, { type: 'key', keys: ['tab'] }, 'background', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'stale_snapshot' });
    expect(client.callTool).not.toHaveBeenCalled();
  });

  describe('value and menu actions', () => {
    const signal = () => new AbortController().signal;
    const frame = { x: 43, y: 0, w: 40, h: 20 };
    // 菜单栏第一项是系统 Apple 菜单，其后是应用自己的菜单。
    function withMenuBar(state: WindowStateOutput, systemLabel = 'Apple') {
      state.elements!.push(
        { elementIndex: 6n, role: 'AXMenuBar', depth: 0, elementToken: 's1:6' },
        { elementIndex: 7n, role: 'AXMenuBarItem', depth: 1, elementToken: 's1:7', label: systemLabel, parentIndex: 6n },
        { elementIndex: 8n, role: 'AXMenuBarItem', depth: 1, elementToken: 's1:8', label: 'File', parentIndex: 6n, frame },
      );
    }
    const sent = (client: ReturnType<typeof fixture>['client']) =>
      client.callTool.mock.calls.map(([tool, json]) => [tool, JSON.parse(json)] as const);

    it('replaces an element value through set_value without a delivery mode, in either session mode', async () => {
      const { client, backend } = fixture();
      for (const mode of ['background', 'foreground'] as const) {
        client.callTool.mockClear();
        client.callTool.mockResolvedValueOnce({ ...success(), action: { effect: 0, route: 0 } });
        const observation = await backend.observe(target);
        await expect(
          backend.act(observation, { type: 'setValue', elementId: 's1:1', value: '新的值 🙂' }, mode, signal()),
        ).resolves.toEqual({
          effect: 'confirmed',
        });
        expect(sent(client)).toEqual([
          ['set_value', { pid: 42, window_id: 19, session: expect.any(String), element_token: 's1:1', value: '新的值 🙂' }],
        ]);
      }
      // 驱动无法读回值时只是发出，不是确认。
      client.callTool.mockResolvedValueOnce({ ...success(), action: { effect: 2, route: 0 } });
      await expect(
        backend.act(await backend.observe(target), { type: 'setValue', elementId: 's1:1', value: '7' }, 'background', signal()),
      ).resolves.toEqual({ effect: 'unconfirmed' });
    });

    it('does not set a value on an element outside the observation, and keeps conservative handling of uncoded failures', async () => {
      const { client, backend } = fixture();
      const observation = await backend.observe(target);
      await expect(
        backend.act(observation, { type: 'setValue', elementId: 's1:99', value: 'x' }, 'background', signal()),
      ).rejects.toMatchObject({ code: 'stale_snapshot' });
      expect(client.callTool).not.toHaveBeenCalled();
      client.callTool.mockResolvedValueOnce({ ...success(), isError: true });
      await expect(
        backend.act(observation, { type: 'setValue', elementId: 's1:1', value: 'x' }, 'background', signal()),
      ).rejects.toMatchObject({ code: 'unknown_outcome' });
    });

    it('refuses pop-up buttons on macOS before dispatch because the driver fails them without an error code', async () => {
      const { client, backend, state } = fixture();
      state.elements![0]!.role = 'AXPopUpButton';
      const observation = await backend.observe(target);
      await expect(
        backend.act(observation, { type: 'setValue', elementId: 's1:1', value: 'Medium' }, 'background', signal()),
      ).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('click it to open') });
      expect(client.callTool).not.toHaveBeenCalled();
      expect(await backend.validate(observation)).toBe(true);
    });

    it('invokes an application menu path through invoke_menu without a delivery mode', async () => {
      const { client, backend, state } = fixture();
      withMenuBar(state);
      for (const mode of ['background', 'foreground'] as const) {
        client.callTool.mockClear();
        const observation = await backend.observe(target);
        await expect(backend.act(observation, { type: 'menu', path: ['File', 'Export', 'PDF…'] }, mode, signal())).resolves.toEqual({
          effect: 'confirmed',
        });
        expect(sent(client)).toEqual([
          ['invoke_menu', { pid: 42, window_id: 19, session: expect.any(String), path: ['File', 'Export', 'PDF…'] }],
        ]);
      }
    });

    it('never invokes the system Apple menu, whatever its label, case or padding', async () => {
      const { client, backend, state } = fixture();
      withMenuBar(state, '苹果');
      const observation = await backend.observe(target);
      for (const first of ['苹果', ' 苹果 ']) {
        await expect(backend.act(observation, { type: 'menu', path: [first, 'Shut Down…'] }, 'foreground', signal())).rejects.toMatchObject(
          { code: 'permission_denied' },
        );
      }
      expect(client.callTool).not.toHaveBeenCalled();
      // 拒绝发生在派发前，快照仍然可用；应用自己的菜单照常。
      await expect(backend.act(observation, { type: 'menu', path: ['File', 'Close'] }, 'background', signal())).resolves.toBeDefined();
      // 大小写不同也一并拒绝。
      const { client: other, backend: second, state: otherState } = fixture();
      withMenuBar(otherState, 'Apple');
      await expect(
        second.act(await second.observe(target), { type: 'menu', path: ['APPLE', 'Restart…'] }, 'background', signal()),
      ).rejects.toMatchObject({ code: 'permission_denied' });
      expect(other.callTool).not.toHaveBeenCalled();
    });

    it('requires a menu bar in the snapshot on macOS so the system menu can be identified', async () => {
      const { client, backend } = fixture();
      await expect(
        backend.act(await backend.observe(target), { type: 'menu', path: ['File', 'Save'] }, 'background', signal()),
      ).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('menu bar') });
      expect(client.callTool).not.toHaveBeenCalled();
    });

    it('reports an unavailable menu path as a definite refusal and keeps the backend usable', async () => {
      const { client, backend, state } = fixture();
      withMenuBar(state);
      client.callTool.mockResolvedValueOnce({
        ...success(),
        isError: true,
        errorCode: 'menu_path_unavailable',
        structuredJson: JSON.stringify({
          status: 'refused',
          refusal: { code: 'menu_path_unavailable', message: 'segment 1 was not found' },
        }),
      });
      const dispatched = vi.fn();
      await expect(
        backend.act(await backend.observe(target), { type: 'menu', path: ['File', 'Nope'] }, 'background', signal(), dispatched),
      ).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining('nothing was sent') });
      // 驱动文案可能含界面内容，不转述给客户端。
      await expect(
        backend.act(await backend.observe(target), { type: 'menu', path: ['File', 'Nope'] }, 'background', signal()),
      ).resolves.toBeDefined();
    });

    it('works on elements-only snapshots and on Windows without the Apple menu rule', async () => {
      const { client, backend, state } = fixture();
      withMenuBar(state);
      client.getWindowState.mockImplementation(async input =>
        input.includeScreenshot === false ? { ...state, images: [], windowBounds: undefined } : state,
      );
      const slim = await backend.observe(target, { pixels: false });
      await backend.act(slim, { type: 'setValue', elementId: 's1:1', value: 'v' }, 'background', signal());
      await backend.act(await backend.observe(target, { pixels: false }), { type: 'menu', path: ['File', 'Save'] }, 'background', signal());
      expect(sent(client).map(([tool]) => tool)).toEqual(['set_value', 'invoke_menu']);
      const windows = fixture();
      const backendWin = new CuaBackend(
        'C:\\Computer Use\\cua-driver.exe',
        async () => windows.client,
        'win32',
        async () => new Map([[42, 'C:\\Fixtures\\Fixture.exe']]),
      );
      const windowsTarget: Target = { ...target, appId: 'win32:c:\\fixtures\\fixture.exe' };
      windows.client.listApps.mockResolvedValue({ apps: [{ pid: 42, name: 'Fixture', running: true, active: false }] });
      // Windows 没有 Apple 菜单，也不要求菜单栏元素出现在快照里；弹出按钮的限制只属于 macOS。
      windows.state.elements![0]!.role = 'AXPopUpButton';
      await backendWin.act(await backendWin.observe(windowsTarget), { type: 'menu', path: ['Apple', 'About'] }, 'foreground', signal());
      await backendWin.act(
        await backendWin.observe(windowsTarget),
        { type: 'setValue', elementId: 's1:1', value: 'Medium' },
        'foreground',
        signal(),
      );
      expect(sent(windows.client).map(([tool, args]) => [tool, 'delivery_mode' in args])).toEqual([
        ['invoke_menu', false],
        ['set_value', false],
      ]);
    });
  });

  describe('elements-only observation', () => {
    // 驱动在只取树的路径上不返回图像和窗口几何。
    function treeOnly(role = 'button', actions?: string[]) {
      const value = fixture();
      Object.assign(value.state.elements![0]!, { role, ...(actions ? { actions } : {}) });
      value.client.getWindowState.mockImplementation(async input =>
        input.includeScreenshot === false
          ? { ...value.state, images: [], windowBounds: undefined, screenshotWidth: undefined, screenshotHeight: undefined }
          : value.state,
      );
      return value;
    }
    const signal = () => new AbortController().signal;

    it('asks the driver for the tree only, takes geometry from the window list and returns no pixels', async () => {
      const { client, backend } = treeOnly();
      const observation = await backend.observe(target, { pixels: false });
      // 不重试：没有图像是这条路径的正常结果。
      expect(client.getWindowState).toHaveBeenCalledTimes(1);
      expect(client.getWindowState.mock.calls[0]![0]).toMatchObject({
        pid: 42,
        windowId: 19n,
        includeAccessibilityTree: true,
        includeScreenshot: false,
      });
      expect(observation).toMatchObject({
        target,
        bounds,
        elementsComplete: false,
        elements: [{ id: 's1:1', role: 'button', label: 'Save' }],
      });
      for (const field of ['screenshot', 'imageWidth', 'imageHeight']) expect(observation).not.toHaveProperty(field);
      expect(observation.elements[0]).not.toHaveProperty('bounds');
      expect(await backend.validate(observation)).toBe(true);
      // 同一份快照照旧需要窗口几何不变。
      client.listWindows.mockResolvedValueOnce({
        windows: [
          { windowId: 19n, pid: 42, appName: 'Fixture', title: 'Fixture', bounds: { ...bounds, x: bounds.x + 1 }, isOnScreen: true },
        ],
      });
      expect(await backend.validate(observation)).toBe(false);
    });

    it('reads the geometry before the tree so a window that moves in between is treated as stale', async () => {
      const { client, backend } = treeOnly();
      const order: string[] = [];
      client.listWindows.mockImplementationOnce(async () => {
        order.push('geometry');
        return { windows: [{ windowId: 19n, pid: 42, appName: 'Fixture', title: 'Fixture', bounds, isOnScreen: true }] };
      });
      client.getWindowState.mockImplementationOnce(async () => {
        order.push('tree');
        return { ...fixture().state, images: [], windowBounds: undefined };
      });
      await backend.observe(target, { pixels: false });
      expect(order).toEqual(['geometry', 'tree']);
    });

    it('does not warm the pointer path, so element actions follow without a capture', async () => {
      const { client, backend } = treeOnly();
      const observation = await backend.observe(target, { pixels: false });
      await expect(backend.act(observation, { type: 'click', elementId: 's1:1' }, 'background', signal())).resolves.toEqual({
        effect: 'confirmed',
      });
      expect(client.callTool).toHaveBeenCalledTimes(1);
      expect(client.callTool.mock.calls[0]![0]).toBe('click');
      expect(JSON.parse(client.callTool.mock.calls[0]![1])).toMatchObject({ element_token: 's1:1', delivery_mode: 'background' });
      // 元素动作之外没有再抓一次图像。
      expect(client.getWindowState).toHaveBeenCalledTimes(1);
      const next = await backend.observe(target, { pixels: false });
      await backend.act(next, { type: 'type', text: '中文', elementId: 's1:1' }, 'background', signal());
      const again = await backend.observe(target, { pixels: false });
      await backend.act(again, { type: 'key', keys: ['cmd', 's'] }, 'foreground', signal());
      expect(client.callTool.mock.calls.map(([tool]) => tool)).toEqual(['click', 'type_text', 'hotkey']);
    });

    it('refuses coordinates, scrolling and dragging before any driver call and keeps the snapshot usable', async () => {
      const { client, backend } = treeOnly();
      const observation = await backend.observe(target, { pixels: false });
      for (const [action, mode] of [
        [{ type: 'click', point: { x: 25, y: 50 } }, 'background'],
        [{ type: 'scroll', direction: 'down', amount: 1, unit: 'line' }, 'background'],
        [{ type: 'scroll', direction: 'down', amount: 1, unit: 'line', point: { x: 25, y: 50 } }, 'background'],
        [
          {
            type: 'drag',
            path: [
              { x: 1, y: 1 },
              { x: 5, y: 5 },
            ],
            durationMs: 200,
          },
          'foreground',
        ],
      ] as const)
        await expect(backend.act(observation, action, mode, signal())).rejects.toMatchObject({
          code: 'invalid_request',
          message: expect.stringContaining('elementsOnly'),
        });
      expect(client.callTool).not.toHaveBeenCalled();
      expect(client.getWindowState).toHaveBeenCalledTimes(1);
      expect(await backend.validate(observation)).toBe(true);
    });

    it('refuses to click a text control that needs its pixel position, and still allows typing into it', async () => {
      const { client, backend } = treeOnly('AXTextField', ['AXShowMenu', 'AXConfirm']);
      const observation = await backend.observe(target, { pixels: false });
      await expect(backend.act(observation, { type: 'click', elementId: 's1:1' }, 'background', signal())).rejects.toMatchObject({
        code: 'invalid_request',
        message: expect.stringContaining('type into it'),
      });
      expect(client.callTool).not.toHaveBeenCalled();
      await expect(backend.act(observation, { type: 'type', text: 'x', elementId: 's1:1' }, 'background', signal())).resolves.toBeDefined();
    });

    it('rejects a missing window and a result for another window', async () => {
      const { client, backend } = treeOnly();
      client.listWindows.mockResolvedValueOnce({ windows: [] });
      await expect(backend.observe(target, { pixels: false })).rejects.toMatchObject({ code: 'not_found' });
      expect(client.getWindowState).not.toHaveBeenCalled();
      client.getWindowState.mockResolvedValueOnce({ ...fixture().state, images: [], windowId: 20n });
      await expect(backend.observe(target, { pixels: false })).rejects.toMatchObject({ code: 'stale_snapshot' });
      // 归属校验与完整观察一致。
      await expect(backend.observe({ ...target, appId: 'wrong.app' }, { pixels: false })).rejects.toMatchObject({ code: 'not_found' });
    });

    it('applies the same menu filtering and protected-value rules as a full observation', async () => {
      const { state, backend } = treeOnly();
      state.elements = [
        { elementIndex: 1n, role: 'AXMenuBar', depth: 0, elementToken: 's1:1', label: 'Menu bar' },
        { elementIndex: 2n, role: 'AXMenuBarItem', depth: 1, elementToken: 's1:2', label: 'Apple', parentIndex: 1n },
        {
          elementIndex: 3n,
          role: 'AXMenuBarItem',
          depth: 1,
          elementToken: 's1:3',
          label: 'File',
          parentIndex: 1n,
          frame: { x: 43, y: 0, w: 40, h: 20 },
        },
        { elementIndex: 4n, role: 'AXTextField', depth: 0, elementToken: 's1:4', label: 'Secret', value: '\uf79a\uf79a\uf79a' },
      ];
      const observation = await backend.observe(target, { pixels: false });
      expect(observation.elements.map(element => element.label)).toEqual(['Menu bar', 'File', 'Secret']);
      expect(observation.elements.at(-1)).not.toHaveProperty('value');
      expect(observation.elementsComplete).toBe(false);
    });

    it('works the same way on Windows', async () => {
      const { client } = treeOnly();
      const backend = new CuaBackend(
        'C:\\Computer Use\\cua-driver.exe',
        async () => client,
        'win32',
        async () => new Map([[42, 'C:\\Fixtures\\Fixture.exe']]),
      );
      const windowsTarget: Target = { ...target, appId: 'win32:c:\\fixtures\\fixture.exe' };
      const observation = await backend.observe(windowsTarget, { pixels: false });
      expect(client.getWindowState.mock.calls[0]![0]).toMatchObject({ includeScreenshot: false });
      expect(observation.elements).toHaveLength(1);
      expect(observation).not.toHaveProperty('screenshot');
    });
  });

  describe('running application listing', () => {
    const tree = (apps: unknown[]): ToolResult => ({ ...success(), structuredJson: JSON.stringify({ apps, windows: [] }) });
    const running = [
      { pid: 42, name: 'Fixture', bundle_id: 'test.fixture' },
      { pid: 99, name: 'Other', bundle_id: 'other.app' },
    ];
    // 不经 fixture() 的换算：backend 直接面对驱动的 get_accessibility_tree。
    function direct(result: () => Promise<ToolResult>) {
      const { client } = fixture();
      client.callTool.mockImplementation(async () => result());
      return { client, backend: new CuaBackend('/test/driver.sock', async () => client, 'darwin') };
    }

    it('uses the lightweight listing for targets and ownership instead of the full list_apps scan', async () => {
      const { client, backend } = direct(async () => tree(running));
      expect(await backend.targets({ appIds: ['test.fixture'], browser: false })).toEqual([target]);
      expect(await backend.observe(target)).toMatchObject({ target });
      await expect(backend.observe({ ...target, appId: 'other.app' })).rejects.toMatchObject({ code: 'not_found' });
      await expect(backend.observe({ ...target, pid: 7, id: 'desktop:7:19' })).rejects.toMatchObject({ code: 'not_found' });
      expect(client.listApps).not.toHaveBeenCalled();
      expect(client.callTool).toHaveBeenCalled();
      for (const [name, args] of client.callTool.mock.calls) {
        expect(name).toBe('get_accessibility_tree');
        expect(args).toBe('{}');
      }
    });

    it('ignores listed apps without a usable bundle identity when matching a target', async () => {
      const { client, backend } = direct(async () =>
        tree([
          { pid: 42, name: 'Fixture' },
          { pid: 42, name: 'Fixture', bundle_id: '' },
        ]),
      );
      await expect(backend.observe(target)).rejects.toMatchObject({ code: 'not_found' });
      expect(await backend.targets({ appIds: [], allApps: true, browser: false })).toEqual([]);
      expect(client.listApps).not.toHaveBeenCalled();
    });

    it.each([
      ['a tool error', async () => ({ ...success(), isError: true, errorCode: 'internal_error' })],
      ['no structured result', async () => success()],
      ['unparseable JSON', async () => ({ ...success(), structuredJson: '{not json' })],
      ['a result without an app array', async () => ({ ...success(), structuredJson: JSON.stringify({ apps: 'none' }) })],
      ['an app with a non-numeric pid', async () => tree([{ pid: '42', bundle_id: 'test.fixture' }])],
      ['an app with a non-positive pid', async () => tree([{ pid: 0, bundle_id: 'test.fixture' }])],
      ['a transport failure', async () => Promise.reject(new Error('transport'))],
    ])('falls back to the full list_apps when the lightweight listing returns %s', async (_name, result) => {
      const { client, backend } = direct(result);
      expect(await backend.targets({ appIds: ['test.fixture'], browser: false })).toEqual([target]);
      expect(client.listApps).toHaveBeenCalledTimes(1);
      // 回退不改变授权判断：完整列表里没有的应用仍被拒绝。
      await expect(backend.observe({ ...target, appId: 'wrong.app' })).rejects.toMatchObject({ code: 'not_found' });
    });

    it('never uses the lightweight listing on Windows', async () => {
      const { client } = fixture();
      const backend = new CuaBackend(
        'C:\\Computer Use\\cua-driver.exe',
        async () => client,
        'win32',
        async () => new Map(),
      );
      client.listApps.mockResolvedValue({ apps: [] });
      expect(await backend.targets({ appIds: [], allApps: true, browser: false })).toEqual([]);
      expect(client.listApps).toHaveBeenCalledTimes(1);
      expect(client.callTool).not.toHaveBeenCalled();
    });
  });
});
