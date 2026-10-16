import { describe, expect, it, vi } from 'vitest';
import type { ToolResult, WindowStateOutput } from '@trycua/cua-driver';
import { CuaBackend, type CuaConnection } from './cua.js';
import type { Target } from '../contracts.js';
import type { NativeHelper, PasteSession } from '../native-helper.js';

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
    // 授权全部应用时一次取全部窗口，再按应用分组：没有 pid 的窗口、属于列表之外进程的窗口、
    // 没有身份或已退出的应用的窗口，都不成为目标。
    const window = (windowId: bigint, pid: number | undefined) => ({
      windowId,
      ...(pid === undefined ? {} : { pid }),
      appName: 'App',
      title: 'Window',
      bounds,
      isOnScreen: true,
    });
    client.listWindows.mockResolvedValue({
      windows: [window(19n, 42), window(19n, 99), window(21n, undefined), window(20n, 777), window(22n, 100), window(23n, 101)],
    });
    expect(await backend.targets({ appIds: [], browser: false })).toEqual([]);
    expect(client.listApps).not.toHaveBeenCalled();
    expect(await backend.targets({ appIds: [], allApps: true, browser: false })).toEqual([
      { ...target, title: 'Window' },
      { ...target, id: 'desktop:99:19', appId: 'other.app', pid: 99, title: 'Window' },
    ]);
    expect(client.listWindows).toHaveBeenCalledTimes(1);
    expect(client.listWindows.mock.calls[0]![0]).toEqual({ onScreenOnly: false });
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

  describe('clicks with modifier keys', () => {
    const signal = () => new AbortController().signal;
    // 元素窗口局部像素中心为 (140, 70)，与文本框点击用例的几何一致。
    function inside(value = fixture()) {
      Object.assign(value.state.elements![0]!, { frame: { x: 30, y: 40, w: 100, h: 30 } });
      return value;
    }
    const args = (client: ReturnType<typeof fixture>['client']) => JSON.parse(client.callTool.mock.calls.at(-1)![1]);

    it('holds the modifiers for a pixel click in a foreground session and names them the way the driver does', async () => {
      const { client, backend } = inside();
      await backend.act(
        await backend.observe(target),
        { type: 'click', point: { x: 25, y: 50 }, button: 'right', count: 2, modifiers: ['cmd', 'shift', 'option', 'ctrl'] },
        'foreground',
        signal(),
      );
      expect(client.callTool.mock.calls.at(-1)![0]).toBe('click');
      expect(args(client)).toMatchObject({
        x: 25,
        y: 50,
        button: 'right',
        count: 2,
        delivery_mode: 'foreground',
        modifier: ['cmd', 'shift', 'option', 'ctrl'],
      });
      expect(args(client)).not.toHaveProperty('element_token');
      // 没有修饰键时仍不带这个参数。
      await backend.act(await backend.observe(target), { type: 'click', point: { x: 25, y: 50 } }, 'foreground', signal());
      expect(args(client)).not.toHaveProperty('modifier');
    });

    it('refuses modifier clicks in a background session before any driver call and keeps the snapshot', async () => {
      const { client, backend } = inside();
      const observation = await backend.observe(target);
      for (const click of [
        { type: 'click', point: { x: 25, y: 50 }, modifiers: ['shift'] },
        { type: 'click', elementId: 's1:1', modifiers: ['cmd'] },
      ] as const)
        await expect(backend.act(observation, click, 'background', signal())).rejects.toMatchObject({
          code: 'background_unavailable',
          message: expect.stringContaining('foreground session'),
        });
      expect(client.callTool).not.toHaveBeenCalled();
      expect(await backend.validate(observation)).toBe(true);
    });

    it('clicks the centre of an element with modifiers through the pixel route', async () => {
      const { client, backend } = inside();
      await backend.act(await backend.observe(target), { type: 'click', elementId: 's1:1', modifiers: ['cmd'] }, 'foreground', signal());
      expect(args(client)).toMatchObject({ x: 140, y: 70, delivery_mode: 'foreground', modifier: ['cmd'] });
      expect(args(client)).not.toHaveProperty('element_token');
    });

    it('refuses an element that has no usable pixel position, or no screenshot, before dispatch', async () => {
      const covered = fixture(); // 默认元素位置落在窗口外
      const observation = await covered.backend.observe(target);
      await expect(
        covered.backend.act(observation, { type: 'click', elementId: 's1:1', modifiers: ['shift'] }, 'foreground', signal()),
      ).rejects.toMatchObject({ code: 'background_unavailable' });
      const disabled = inside();
      disabled.state.elements![0]!.enabled = false;
      await expect(
        disabled.backend.act(
          await disabled.backend.observe(target),
          { type: 'click', elementId: 's1:1', modifiers: ['shift'] },
          'foreground',
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'background_unavailable' });
      const slim = inside();
      slim.client.getWindowState.mockImplementation(async input =>
        input.includeScreenshot === false ? { ...slim.state, images: [], windowBounds: undefined } : slim.state,
      );
      await expect(
        slim.backend.act(
          await slim.backend.observe(target, { pixels: false }),
          { type: 'click', elementId: 's1:1', modifiers: ['shift'] },
          'foreground',
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('screenshot') });
      for (const value of [covered, disabled, slim]) expect(value.client.callTool).not.toHaveBeenCalled();
    });

    it('does not dispatch when the window geometry changes during the pointer warm-up', async () => {
      vi.useFakeTimers();
      try {
        const { client, backend } = inside();
        const observation = await backend.observe(target);
        await vi.advanceTimersByTimeAsync(1_000);
        client.getWindowState.mockResolvedValueOnce({ ...fixture().state, screenshotWidth: 1200 });
        await expect(
          backend.act(observation, { type: 'click', elementId: 's1:1', modifiers: ['cmd'] }, 'foreground', signal()),
        ).rejects.toMatchObject({ code: 'stale_snapshot' });
        expect(client.callTool).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses the pixel route in foreground on Windows, maps option to alt and has no cmd', async () => {
      const { client, state } = inside();
      const backend = new CuaBackend(
        'C:\\Computer Use\\cua-driver.exe',
        async () => client,
        'win32',
        async () => new Map([[42, 'C:\\Fixtures\\Fixture.exe']]),
      );
      const windowsTarget: Target = { ...target, appId: 'win32:c:\\fixtures\\fixture.exe' };
      state.elements![0]!.role = 'Button';
      await backend.act(
        await backend.observe(windowsTarget),
        { type: 'click', elementId: 's1:1', modifiers: ['ctrl', 'option'] },
        'foreground',
        signal(),
      );
      expect(args(client)).toMatchObject({ x: 140, y: 70, delivery_mode: 'foreground', modifier: ['ctrl', 'alt'] });
      expect(args(client)).not.toHaveProperty('element_token');
      await expect(
        backend.act(await backend.observe(windowsTarget), { type: 'click', elementId: 's1:1', modifiers: ['cmd'] }, 'foreground', signal()),
      ).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('ctrl') });
      // 没有修饰键时 Windows 元素点击照旧走后台语义路径。
      await backend.act(await backend.observe(windowsTarget), { type: 'click', elementId: 's1:1' }, 'foreground', signal());
      expect(args(client)).toMatchObject({ element_token: 's1:1', delivery_mode: 'background' });
    });
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

  it('says why a window is off screen when listing targets, and does not carry that into observations', async () => {
    const { client, backend, state } = fixture();
    state.windowTitle = 'Live title';
    const window = (windowId: bigint, extra: Record<string, unknown>) => ({
      windowId,
      pid: 42,
      appName: 'Fixture',
      title: `Window ${windowId}`,
      bounds,
      isOnScreen: false,
      ...extra,
    });
    client.listWindows.mockResolvedValue({
      windows: [
        { ...window(19n, {}), isOnScreen: true, onCurrentSpace: true },
        window(20n, { minimized: true, onCurrentSpace: false }),
        window(21n, { onCurrentSpace: false }),
        window(22n, { onCurrentSpace: true }),
        window(23n, {}),
      ],
    });
    const listed = await backend.targets({ appIds: ['test.fixture'], browser: false });
    expect(listed.map(item => [item.windowId, item.offScreen])).toEqual([
      [19, undefined],
      [20, 'minimized'],
      [21, 'other-space'],
      [22, 'not-visible'],
      [23, 'not-visible'],
    ]);
    expect(listed[0]).not.toHaveProperty('offScreen');
    // 列出时的状态此后可能不成立：观察里的目标不带它，仍取实时标题。
    client.listWindows.mockResolvedValue({
      windows: [{ windowId: 19n, pid: 42, appName: 'Fixture', title: 'Fixture', bounds, isOnScreen: true }],
    });
    for (const options of [undefined, { pixels: false }]) {
      const observation = await backend.observe({ ...listed[1]!, windowId: 19, id: 'desktop:42:19' }, options);
      expect(observation.target).not.toHaveProperty('offScreen');
      expect(observation.target).toMatchObject({ pid: 42, windowId: 19, title: 'Live title' });
    }
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

  describe('typing results, budgets and estimates', () => {
    const signal = () => new AbortController().signal;
    const incomplete = (path = 'key_events'): ToolResult => ({
      ...success(),
      isError: true,
      errorCode: 'type_text_incomplete',
      structuredJson: JSON.stringify({
        code: 'type_text_incomplete',
        delivered_chars: 0,
        effect: 'partial',
        path,
        requested_chars: 6,
        retry_from_character: 0,
        retryable: true,
      }),
    });
    function web(inWebContent = true) {
      const value = fixture();
      Object.assign(value.state.elements![0]!, { role: 'AXTextArea', label: 'Terminal input', inWebContent });
      return value;
    }
    const type = (text = 'ls -la') => ({ type: 'type' as const, text, elementId: 's1:1' });

    it('records a failed read-back in a self-clearing web input as executed with a warning, never as a retry hint', async () => {
      const { client, backend } = web();
      client.callTool.mockResolvedValueOnce(incomplete());
      await expect(backend.act(await backend.observe(target), type(), 'background', signal())).resolves.toEqual({
        effect: 'unconfirmed',
        warning: { code: 'readback_mismatch', message: expect.stringContaining('do not type it again') },
      });
      expect(JSON.parse(client.callTool.mock.calls[0]![1])).toMatchObject({ text: 'ls -la', element_token: 's1:1' });
    });

    it('keeps other incomplete results unknown, but marks them settled because the driver call returned', async () => {
      for (const [inWebContent, path] of [
        [false, 'key_events'],
        [true, 'accessibility'],
      ] as const) {
        const { client, backend } = web(inWebContent);
        client.callTool.mockResolvedValueOnce(incomplete(path));
        const error = await backend.act(await backend.observe(target), type(), 'background', signal()).catch(caught => caught);
        expect(error).toMatchObject({
          code: 'unknown_outcome',
          settled: true,
          message: expect.stringContaining('do not type the text again'),
        });
      }
    });

    it('distinguishes a returned but unclassified driver error from a lost connection', async () => {
      const { client, backend } = fixture();
      client.callTool.mockResolvedValueOnce({ ...success(), isError: true, errorCode: 'window_busy' });
      await expect(
        backend.act(await backend.observe(target), { type: 'key', keys: ['tab'] }, 'background', signal()),
      ).rejects.toMatchObject({ code: 'unknown_outcome', settled: true });
      client.callTool.mockRejectedValueOnce(new Error('transport'));
      await expect(
        backend.act(await backend.observe(target), { type: 'key', keys: ['tab'] }, 'background', signal()),
      ).rejects.toMatchObject({ code: 'unknown_outcome', settled: false });
      // 驱动明确拒绝的代码仍是确定的失败。
      client.callTool.mockResolvedValueOnce({ ...success(), isError: true, errorCode: 'background_unavailable' });
      await expect(
        backend.act(await backend.observe(target), { type: 'key', keys: ['tab'] }, 'background', signal()),
      ).rejects.toMatchObject({ code: 'background_unavailable', settled: false });
    });

    it('turns a pre-dispatch synthesis budget refusal into a definite failure with the safe part size', async () => {
      const budget = (fields: Record<string, unknown>): ToolResult => ({
        ...success(),
        isError: true,
        errorCode: 'type_text_synthesis_budget_exceeded',
        structuredJson: JSON.stringify({ code: 'type_text_synthesis_budget_exceeded', ...fields }),
      });
      const { client, backend } = web();
      client.callTool.mockResolvedValueOnce(budget({ synthesized_chars: 0, max_chunk_chars: 120, estimated_duration_ms: 90_000 }));
      await expect(backend.act(await backend.observe(target), type(), 'background', signal())).rejects.toMatchObject({
        code: 'invalid_request',
        settled: false,
        message: expect.stringContaining('at most 120 characters'),
      });
      client.callTool.mockResolvedValueOnce(budget({}));
      await expect(backend.act(await backend.observe(target), type(), 'background', signal())).rejects.toMatchObject({
        code: 'invalid_request',
        message: expect.stringContaining('nothing was sent'),
      });
      // 已经合成过字符时不能当作没有发出。
      client.callTool.mockResolvedValueOnce(budget({ synthesized_chars: 5 }));
      await expect(backend.act(await backend.observe(target), type(), 'background', signal())).rejects.toMatchObject({
        code: 'unknown_outcome',
        settled: true,
      });
    });

    it('estimates only slow keystroke typing on macOS', async () => {
      const { backend } = web();
      const observation = await backend.observe(target);
      const text = 'x'.repeat(100);
      expect(backend.estimateMs(observation, type(text), 'background')).toBe(4_500 + 100 * 40);
      expect(backend.estimateMs(observation, type(''), 'background')).toBeUndefined();
      expect(backend.estimateMs(observation, { type: 'type', text }, 'background')).toBeUndefined();
      expect(backend.estimateMs(observation, type(text), 'foreground')).toBe(2 * (4_500 + 450) + 100 * 120);
      expect(backend.estimateMs(observation, { type: 'key', keys: ['tab'] }, 'foreground')).toBeUndefined();
      // 码位计数：一个表情符号算一个字符。
      expect(backend.estimateMs(observation, type('🙂🙂'), 'background')).toBe(4_500 + 2 * 40);
      const native = web(false);
      expect(native.backend.estimateMs(await native.backend.observe(target), type(text), 'background')).toBeUndefined();
      const windows = new CuaBackend(
        'C:\\Driver\\cua-driver.exe',
        async () => native.client,
        'win32',
        async () => new Map(),
      );
      expect(windows.estimateMs(observation, type(text), 'foreground')).toBeUndefined();
    });
  });

  describe('native helpers: user activity and paste', () => {
    const signal = () => new AbortController().signal;
    function helper(idle: Array<number | undefined> = [], session?: PasteSession) {
      const values = [...idle];
      return {
        recognizeText: vi.fn(async () => []),
        warmUp: vi.fn(),
        openPasteSession: vi.fn(async () => {
          if (!session) throw new Error('no session');
          return session;
        }),
        inputIdleMs: vi.fn(async () => (values.length > 0 ? values.shift() : 60_000)),
      } satisfies NativeHelper;
    }
    // 菜单栏：Apple 菜单在前，后面是给定的菜单与菜单项（未展开的菜单项没有位置）。默认带标准的 Edit > Paste。
    function withHelper(
      native: NativeHelper,
      menus: Array<{ title: string; items: string[] }> = [{ title: 'Edit', items: ['Copy', 'Paste'] }],
    ) {
      const value = fixture();
      let index = 100n;
      const add = (role: string, label: string, parentIndex?: bigint) => {
        const elementIndex = index++;
        value.state.elements!.push({
          elementIndex,
          role,
          depth: 1,
          label,
          elementToken: `s1:${elementIndex}`,
          ...(parentIndex ? { parentIndex } : {}),
        });
        return elementIndex;
      };
      if (menus.length > 0) {
        const bar = add('AXMenuBar', '');
        add('AXMenuBarItem', 'Apple', bar);
        for (const { title, items } of menus) {
          const menu = add('AXMenu', '', add('AXMenuBarItem', title, bar));
          for (const item of items) add('AXMenuItem', item, menu);
        }
      }
      return { ...value, backend: new CuaBackend('/test/driver.sock', value.connector, 'darwin', undefined, native) };
    }
    function pasteSession(overrides: Partial<PasteSession> = {}) {
      return {
        stage: vi.fn(async () => ({ complete: true })),
        finish: vi.fn(async () => ({ restored: true })),
        abort: vi.fn(),
        ...overrides,
      } satisfies PasteSession;
    }

    it('sends nothing in the foreground while the user is using the mouse or keyboard', async () => {
      const native = helper([200]);
      const { client, backend } = withHelper(native);
      const dispatched = vi.fn();
      await expect(
        backend.act(await backend.observe(target), { type: 'key', keys: ['tab'] }, 'foreground', signal(), dispatched),
      ).rejects.toMatchObject({ code: 'busy', message: expect.stringContaining('nothing was sent') });
      expect(dispatched).not.toHaveBeenCalled();
      expect(client.callTool).not.toHaveBeenCalled();
      // 后台动作和不动用键盘鼠标的动作不检查。
      await backend.act(await backend.observe(target), { type: 'key', keys: ['tab'] }, 'background', signal());
      await backend.act(await backend.observe(target), { type: 'setValue', elementId: 's1:1', value: 'x' }, 'foreground', signal());
      expect(native.inputIdleMs).toHaveBeenCalledTimes(1);
    });

    it('waits out its own recent foreground input before checking the user', async () => {
      vi.useFakeTimers();
      try {
        const native = helper();
        const { client, backend } = withHelper(native);
        await backend.act(await backend.observe(target), { type: 'key', keys: ['tab'] }, 'foreground', signal());
        const next = backend.act(await backend.observe(target), { type: 'key', keys: ['return'] }, 'foreground', signal());
        await vi.advanceTimersByTimeAsync(500);
        expect(client.callTool).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(600);
        await expect(next).resolves.toBeDefined();
        expect(client.callTool).toHaveBeenCalledTimes(2);
        expect(native.inputIdleMs).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('types long foreground text in parts and stops with an exact count when the user starts typing', async () => {
      const native = helper([60_000, 60_000, 100]);
      const { client, backend, state } = withHelper(native);
      Object.assign(state.elements![0]!, { role: 'AXTextArea', inWebContent: true });
      client.callTool.mockResolvedValue({ ...success(), action: { effect: 2, route: 0 } });
      const text = 'a'.repeat(150);
      await expect(
        backend.act(await backend.observe(target), { type: 'type', text, elementId: 's1:1' }, 'foreground', signal()),
      ).resolves.toEqual({
        effect: 'unconfirmed',
        progress: { delivered: 128, total: 150 },
        warning: { code: 'partial_input', message: expect.stringContaining('user started using the mouse or keyboard') },
      });
      expect(client.callTool.mock.calls.map(([tool, json]) => [tool, JSON.parse(json).text.length])).toEqual([
        ['type_text', 64],
        ['type_text', 64],
      ]);
    });

    it('stops between parts before the action would outlive its deadline', async () => {
      const { client, backend } = withHelper(helper());
      const text = 'b'.repeat(100);
      await expect(
        backend.act(await backend.observe(target), { type: 'type', text, elementId: 's1:1' }, 'foreground', signal(), undefined, {
          budgetMs: 6_000,
        }),
      ).resolves.toMatchObject({ progress: { delivered: 64, total: 100 }, warning: { code: 'partial_input' } });
      expect(client.callTool).toHaveBeenCalledTimes(1);
    });

    it('pastes through a saved and restored clipboard without trailing line breaks', async () => {
      const session = pasteSession();
      const native = helper([], session);
      const { client, backend } = withHelper(native);
      const order: string[] = [];
      session.stage.mockImplementation(async () => {
        order.push('stage');
        return { complete: true };
      });
      client.callTool.mockImplementation(async () => {
        order.push('paste');
        return success();
      });
      session.finish.mockImplementation(async () => {
        order.push('restore');
        return { restored: true };
      });
      await expect(
        backend.act(
          await backend.observe(target),
          { type: 'paste', text: 'docker ps\r\n\n', restoreClipboard: true },
          'background',
          signal(),
        ),
      ).resolves.toEqual({ effect: 'confirmed' });
      expect(order).toEqual(['stage', 'paste', 'restore']);
      expect(session.stage).toHaveBeenCalledWith('docker ps', true);
      expect(session.finish).toHaveBeenCalledWith(800);
      // 实测：后台 ⌘V 到不了 WebKit 页面，通过辅助功能调用应用的“粘贴”菜单命令可以。
      expect(client.callTool.mock.calls[0]![0]).toBe('invoke_menu');
      const args = JSON.parse(client.callTool.mock.calls[0]![1]);
      expect(args).toMatchObject({ path: ['Edit', 'Paste'] });
      expect(args).not.toHaveProperty('delivery_mode');
      expect(session.abort).not.toHaveBeenCalled();
    });

    it('finds the Paste command in localized menus by its exact name', async () => {
      const { client, backend } = withHelper(helper([], pasteSession()), [
        { title: 'Format', items: ['Paste'] },
        { title: '编辑', items: ['拷贝', '粘贴并匹配样式', '粘贴'] },
      ]);
      await backend.act(await backend.observe(target), { type: 'paste', text: 'ls', restoreClipboard: true }, 'background', signal());
      expect(JSON.parse(client.callTool.mock.calls[0]![1])).toMatchObject({ path: ['编辑', '粘贴'] });
      const other = withHelper(helper([], pasteSession()), [{ title: 'Terminal', items: ['Paste and Match Style', 'Paste'] }]);
      await other.backend.act(
        await other.backend.observe(target),
        { type: 'paste', text: 'ls', restoreClipboard: true },
        'background',
        signal(),
      );
      expect(JSON.parse(other.client.callTool.mock.calls[0]![1])).toMatchObject({ path: ['Terminal', 'Paste'] });
    });

    it('sends the paste shortcut to an element only in the foreground', async () => {
      const session = pasteSession();
      const native = helper([], session);
      const background = withHelper(native);
      await expect(
        background.backend.act(
          await background.backend.observe(target),
          { type: 'paste', text: 'ls', elementId: 's1:1', restoreClipboard: true },
          'background',
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'background_unavailable', message: expect.stringContaining('without elementId') });
      expect(native.openPasteSession).not.toHaveBeenCalled();
      expect(background.client.callTool).not.toHaveBeenCalled();
      const foreground = withHelper(native);
      await foreground.backend.act(
        await foreground.backend.observe(target),
        { type: 'paste', text: 'ls', elementId: 's1:1', restoreClipboard: true },
        'foreground',
        signal(),
      );
      expect(foreground.client.callTool.mock.calls[0]![0]).toBe('hotkey');
      expect(JSON.parse(foreground.client.callTool.mock.calls[0]![1])).toMatchObject({
        keys: ['cmd', 'v'],
        element_token: 's1:1',
        delivery_mode: 'foreground',
      });
    });

    it('tries the Paste name of the Edit menu’s language when an inactive app does not list the item', async () => {
      // 实测：未激活应用的“编辑”菜单在辅助功能树里只列出系统附加的项，剪切、拷贝、粘贴不在其中。
      const { client, backend } = withHelper(helper([], pasteSession()), [{ title: '編集', items: ['自動入力', '絵文字と記号'] }]);
      client.callTool
        .mockResolvedValueOnce({
          ...success(),
          isError: true,
          errorCode: 'menu_path_unavailable',
          text: 'invoke_menu: path segment 1 was not found',
        })
        .mockResolvedValueOnce(success());
      await expect(
        backend.act(await backend.observe(target), { type: 'paste', text: 'ls', restoreClipboard: true }, 'background', signal()),
      ).resolves.toMatchObject({ effect: 'confirmed' });
      expect(client.callTool.mock.calls.map(([tool, json]) => [tool, JSON.parse(json).path])).toEqual([
        ['invoke_menu', ['編集', 'ペースト']],
        ['invoke_menu', ['編集', '貼り付け']],
      ]);
    });

    it('cannot paste in the background without a Paste menu command', async () => {
      const native = helper([], pasteSession());
      const bare = withHelper(native, []);
      await expect(
        bare.backend.act(await bare.backend.observe(target), { type: 'paste', text: 'ls', restoreClipboard: true }, 'background', signal()),
      ).rejects.toMatchObject({ code: 'background_unavailable', message: expect.stringContaining('no Paste menu command') });
      expect(native.openPasteSession).not.toHaveBeenCalled();
      // 每个名称都找不到：没有按下任何菜单项，剪贴板立即换回。
      const session = pasteSession();
      const missing = withHelper(helper([], session), [{ title: 'Edit', items: ['AutoFill'] }]);
      missing.client.callTool.mockResolvedValue({ ...success(), isError: true, errorCode: 'menu_path_unavailable', text: 'not found' });
      await expect(
        missing.backend.act(
          await missing.backend.observe(target),
          { type: 'paste', text: 'ls', restoreClipboard: true },
          'background',
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'background_unavailable', settled: true });
      expect(missing.client.callTool).toHaveBeenCalledTimes(1);
      expect(session.abort).toHaveBeenCalled();
      expect(session.finish).not.toHaveBeenCalled();
      const foreground = withHelper(native, []);
      await foreground.backend.act(
        await foreground.backend.observe(target),
        { type: 'paste', text: 'ls', restoreClipboard: true },
        'foreground',
        signal(),
      );
      expect(JSON.parse(foreground.client.callTool.mock.calls[0]![1])).toMatchObject({ keys: ['cmd', 'v'], delivery_mode: 'foreground' });
    });

    it('warns when the clipboard could not be restored or saved completely', async () => {
      const notRestored = pasteSession({ finish: vi.fn(async () => ({ restored: false })) });
      const first = withHelper(helper([], notRestored));
      await expect(
        first.backend.act(
          await first.backend.observe(target),
          { type: 'paste', text: 'x', restoreClipboard: true },
          'background',
          signal(),
        ),
      ).resolves.toMatchObject({ warning: { code: 'clipboard_not_restored' } });
      const partial = pasteSession({ stage: vi.fn(async () => ({ complete: false })) });
      const second = withHelper(helper([], partial));
      await expect(
        second.backend.act(
          await second.backend.observe(target),
          { type: 'paste', text: 'x', restoreClipboard: true },
          'background',
          signal(),
        ),
      ).resolves.toMatchObject({ warning: { code: 'clipboard_partial' } });
    });

    it('neither reads nor restores the clipboard when asked not to', async () => {
      const session = pasteSession();
      const { backend } = withHelper(helper([], session));
      await backend.act(await backend.observe(target), { type: 'paste', text: 'x', restoreClipboard: false }, 'background', signal());
      expect(session.stage).toHaveBeenCalledWith('x', false);
      expect(session.finish).not.toHaveBeenCalled();
      expect(session.abort).toHaveBeenCalledTimes(1);
    });

    it('sends nothing when staging fails, and puts the clipboard back when cancelled after staging', async () => {
      const failing = pasteSession({ stage: vi.fn(async () => Promise.reject(new Error('denied'))) });
      const first = withHelper(helper([], failing));
      const dispatched = vi.fn();
      await expect(
        first.backend.act(
          await first.backend.observe(target),
          { type: 'paste', text: 'x', restoreClipboard: true },
          'background',
          signal(),
          dispatched,
        ),
      ).rejects.toBeDefined();
      expect(dispatched).not.toHaveBeenCalled();
      expect(first.client.callTool).not.toHaveBeenCalled();
      expect(failing.abort).toHaveBeenCalled();
      const controller = new AbortController();
      const staged = pasteSession({
        stage: vi.fn(async () => {
          controller.abort();
          return { complete: true };
        }),
      });
      const second = withHelper(helper([], staged));
      await expect(
        second.backend.act(
          await second.backend.observe(target),
          { type: 'paste', text: 'x', restoreClipboard: true },
          'background',
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: 'cancelled' });
      expect(second.client.callTool).not.toHaveBeenCalled();
      expect(staged.abort).toHaveBeenCalled();
    });

    it('rejects empty text and installations without the helper, and uses ctrl+v on Windows', async () => {
      const { backend, client } = fixture();
      const observation = await backend.observe(target);
      await expect(
        backend.act(observation, { type: 'paste', text: '\n\n', restoreClipboard: true }, 'background', signal()),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(
        backend.act(observation, { type: 'paste', text: 'x', restoreClipboard: true }, 'background', signal()),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(client.callTool).not.toHaveBeenCalled();
      const windows = fixture();
      const session = pasteSession();
      const windowsBackend = new CuaBackend(
        'C:\\Computer Use\\cua-driver.exe',
        async () => windows.client,
        'win32',
        async () => new Map([[42, 'C:\\Fixtures\\Fixture.exe']]),
        helper([], session),
      );
      windows.client.listApps.mockResolvedValue({ apps: [{ pid: 42, name: 'Fixture', running: true, active: false }] });
      const windowsTarget: Target = { ...target, appId: 'win32:c:\\fixtures\\fixture.exe' };
      await windowsBackend.act(
        await windowsBackend.observe(windowsTarget),
        { type: 'paste', text: 'dir', restoreClipboard: true },
        'background',
        signal(),
      );
      expect(JSON.parse(windows.client.callTool.mock.calls[0]![1])).toMatchObject({ keys: ['ctrl', 'v'] });
    });
  });

  describe('covered windows', () => {
    const own = { windowId: 19n, pid: 42, appName: 'Fixture', title: 'Fixture', bounds, isOnScreen: true, zIndex: 5n };
    function covered(front: Array<Record<string, unknown>>, web = false) {
      const value = fixture();
      if (web) value.state.elements![0]!.inWebContent = true;
      value.client.listWindows.mockImplementation(async ({ pid }) =>
        pid === undefined
          ? {
              windows: [
                own,
                ...front.map((window, index) => ({
                  windowId: BigInt(100 + index),
                  pid: 7,
                  appName: 'Other',
                  title: 'Other',
                  isOnScreen: true,
                  ...window,
                })),
              ],
            }
          : { windows: [own] },
      ) as never;
      return value;
    }
    const big = { x: 0, y: 0, width: 1000, height: 800 };

    it('marks a fully covered window and a possibly stale screenshot when it shows web content', async () => {
      const plain = covered([{ bounds: big, zIndex: 9n }]);
      expect(await plain.backend.observe(target)).toMatchObject({ covered: true });
      expect(await plain.backend.observe(target)).not.toHaveProperty('screenshotMayBeStale');
      const web = covered([{ bounds: big, zIndex: 9n }], true);
      expect(await web.backend.observe(target)).toMatchObject({ covered: true, screenshotMayBeStale: true });
      // 只取元素的快照没有截图，也就谈不上截图过期。
      const slim = await web.backend.observe(target, { pixels: false });
      expect(slim).toMatchObject({ covered: true });
      expect(slim).not.toHaveProperty('screenshotMayBeStale');
    });

    it('does not mark partly visible windows, windows behind it, or windows without stacking order', async () => {
      for (const front of [
        [{ bounds: { ...bounds, width: bounds.width / 2 }, zIndex: 9n }],
        [{ bounds: big, zIndex: 1n }],
        [{ bounds: big }],
        [{ bounds: big, zIndex: 9n, isOnScreen: false }],
        // 两个窗口合起来盖住全部时也算。
      ]) {
        const { backend } = covered(front, true);
        const observation = await backend.observe(target);
        expect(observation).not.toHaveProperty('covered');
        expect(observation).not.toHaveProperty('screenshotMayBeStale');
      }
      const halves = covered(
        [
          { bounds: { x: 0, y: 0, width: bounds.x + bounds.width / 2 + 1, height: 800 }, zIndex: 9n },
          { bounds: { x: bounds.x + bounds.width / 2, y: 0, width: 1000, height: 800 }, zIndex: 8n },
        ],
        true,
      );
      expect(await halves.backend.observe(target)).toMatchObject({ covered: true, screenshotMayBeStale: true });
    });
  });
});
