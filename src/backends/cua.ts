import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import type { CuaDriverLike, ToolResult, WindowElement, WindowStateOutput } from '@trycua/cua-driver';
import { CuError, type Action, type Backend, type BackendExecution, type BackendObservation, type Bounds, type Doctor, type ErrorCode, type Grant, type Mode, type Point, type Target } from '../contracts.js';
import { windowsAppId } from '../app-identity.js';

export type CuaConnection = Pick<CuaDriverLike, 'metadata' | 'listApps' | 'listWindows' | 'getWindowState' | 'callTool' | 'endSession' | 'shutdown'>;
type State = { snapshot: WindowStateOutput; session: string; consumed: boolean };
const VERSION = '0.28.2';
// The SDK's implicit transport session expires after five minutes of inactivity.
const CONNECTION_IDLE_MS = 4 * 60_000;
const readOptions = () => ({ signal: AbortSignal.timeout(10_000) });
const execFileAsync = promisify(execFile);
const record = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;

function failure(code: unknown, mutation = false): CuError {
  const known: Record<string, ErrorCode> = {
    background_unavailable: 'background_unavailable', background_occluded: 'background_unavailable',
    permission_denied: 'permission_denied', accessibility_permission_denied: 'permission_denied',
    screen_recording_permission_denied: 'permission_denied', stale_element_token: 'stale_snapshot',
    stale_snapshot: 'stale_snapshot', snapshot_id_required: 'stale_snapshot',
    window_not_found: 'not_found', window_id_not_found: 'not_found', app_not_found: 'not_found', invalid_arguments: 'invalid_request',
    // 以下均为驱动在派发前的明确拒绝（驱动文案："refused" / "Refusing to dispatch"），输入未发出。
    same_pid_keyboard_ambiguity: 'background_unavailable', off_space_or_ax_unresolved: 'background_unavailable',
    minimized_or_hidden_window: 'background_unavailable',
    px_capture_unavailable: 'stale_snapshot', px_frame_mismatch: 'stale_snapshot', px_window_not_found: 'stale_snapshot',
  };
  const hints: Record<string, string> = {
    same_pid_keyboard_ambiguity: ' Key input cannot be proven to reach this window among sibling windows; use an element action or a foreground session.',
    off_space_or_ax_unresolved: ' The window is on another Space or its accessibility surface is unresolved.',
    minimized_or_hidden_window: ' The window is minimized or hidden; use an element action.',
    px_capture_unavailable: ' No provable pixel frame was available; observe again before a coordinate action.',
  };
  const mapped = typeof code === 'string' ? known[code] : undefined;
  const driverCode = typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : undefined;
  return new CuError(mapped ?? (mutation ? 'unknown_outcome' : 'unavailable'), mapped
    ? `Desktop backend refused the operation (${mapped}).${hints[code as string] ?? ''}`
    : mutation ? `Desktop action outcome is unknown${driverCode ? ` (driver code ${driverCode})` : ''}. Observe before retrying.` : 'Desktop backend is unavailable. Check the native host and permissions.');
}

function checkResult(result: ToolResult): void;
function checkResult(result: ToolResult, mutation: true): BackendExecution;
function checkResult(result: ToolResult, mutation = false): BackendExecution | undefined {
  if (result.isError) throw failure(result.errorCode, mutation);
  // UniFFI's ActionEffect enum: Confirmed=0; Partial=1; Unverifiable=2;
  // SuspectedNoop=3; Refused=4. A successful transport is not an effect proof.
  if (mutation) {
    if (result.action?.effect === 4) throw new CuError('unavailable', 'Desktop driver refused this action.');
    return { effect: result.action?.effect === 0 ? 'confirmed' : 'unconfirmed' };
  }
}

function exactTarget(target: Target): { pid: number; windowId: bigint } {
  if (target.kind !== 'desktop' || !Number.isSafeInteger(target.pid) || !Number.isSafeInteger(target.windowId)
      || target.pid! <= 0 || target.windowId! <= 0) throw new CuError('invalid_request', 'An exact desktop process and window are required.');
  return { pid: target.pid!, windowId: BigInt(target.windowId!) };
}

function sameBounds(a: Bounds, b: Bounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function captured(state: WindowStateOutput): boolean {
  const image = state.images[0];
  return Boolean(image && ['image/png', 'image/jpeg'].includes(image.mimeType) && state.windowBounds
    && state.screenshotWidth && state.screenshotHeight && state.windowBounds.width > 0 && state.windowBounds.height > 0
    && state.screenshotFrameValid !== false);
}

// macOS 的 AX 树会附带菜单栏：
// - 系统级 Apple 菜单（菜单栏第一项）含最近使用的文件/应用及关机、重启等系统命令，整棵子树都不暴露；
// - 应用菜单中未展开（没有屏幕坐标）的内容，例如 Safari 的历史记录，属于隐私数据且当前不可见，也不暴露。
function withoutHiddenMenus(elements: WindowElement[]): WindowElement[] {
  const excluded = new Set<bigint>();
  const inMenu = new Set(elements.filter(element => element.role === 'AXMenuBar').map(element => element.elementIndex));
  for (const bar of [...inMenu]) {
    const first = elements.filter(element => element.role === 'AXMenuBarItem' && element.parentIndex === bar)
      .reduce<WindowElement | undefined>((min, element) => !min || element.elementIndex < min.elementIndex ? element : min, undefined);
    if (first) excluded.add(first.elementIndex);
  }
  // 驱动按先序遍历输出，父节点总在子节点之前。
  for (const element of [...elements].sort((a, b) => (a.elementIndex < b.elementIndex ? -1 : 1))) {
    if (element.parentIndex === undefined || !inMenu.has(element.parentIndex)) continue;
    inMenu.add(element.elementIndex);
    if (excluded.has(element.parentIndex) || !element.frame) excluded.add(element.elementIndex);
  }
  return elements.filter(element => !excluded.has(element.elementIndex));
}

// Cua Driver 0.28.2 的 macOS 坐标滚轮路径方向与请求相反，且与系统"自然滚动"设置无关
// （开启、关闭两种设置下均实测反向），派发前需交换方向。
const reversed = { up: 'down', down: 'up', left: 'right', right: 'left' } as const;

function point(point: Point, observation: BackendObservation): Point {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0
      || point.x >= observation.imageWidth || point.y >= observation.imageHeight) {
    throw new CuError('invalid_request', 'Point is outside the observed screenshot.');
  }
  return point;
}

async function windowsProcessPaths(driverBinary: string, pids: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  if (unique.length === 0) return new Map();
  if (unique.length > 512) throw new CuError('unavailable', 'Too many Windows processes to verify safely.');
  const helper = join(dirname(dirname(driverBinary)), 'ComputerUse.WindowsHost.exe');
  try {
    const { stdout } = await execFileAsync(helper, ['--process-paths', unique.join(',')], { windowsHide: true, timeout: 10_000, maxBuffer: 256 * 1024 });
    const raw: unknown = JSON.parse(stdout);
    const entries = record(raw);
    if (!entries) throw new Error('Invalid process identity response.');
    const paths = new Map<number, string>();
    for (const pid of unique) {
      const value = entries[String(pid)];
      if (typeof value === 'string' && windowsAppId(value)) paths.set(pid, value);
    }
    return paths;
  } catch {
    throw new CuError('unavailable', 'Windows process identity check failed.');
  }
}

async function connect(socketPath: string): Promise<CuaConnection> {
  process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = 'false';
  process.env.CUA_DRIVER_RS_UPDATE_CHECK = 'false';
  const { CuaDriver } = await import('@trycua/cua-driver');
  return CuaDriver.connect(socketPath);
}

export async function connectWindowsWorker(binaryPath: string): Promise<CuaConnection> {
  process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = 'false';
  process.env.CUA_DRIVER_RS_UPDATE_CHECK = 'false';
  const { CuaDriver, ConfiguredDriverOptions, PrivateWorkerOptions, RuntimeAuthorizationOptions, SessionPermissionMode } = await import('@trycua/cua-driver');
  return CuaDriver.createPrivateWorker(PrivateWorkerOptions.create({
    binaryPath,
    hostBundleId: 'com.starroy.computeruse',
    configuredDriver: ConfiguredDriverOptions.create({
      claudeCodeCompatibility: false,
      authorization: RuntimeAuthorizationOptions.create({
        allowedModes: [SessionPermissionMode.Standard], compatibilityMode: SessionPermissionMode.Standard,
        unrestrictedAcknowledged: false, maxSessionTtlSeconds: 300n, maxIdleTtlSeconds: 300n,
      }),
    }),
    environment: [],
    inheritStderr: false,
  }));
}

/** Socket SDK client only. The signed native host owns the daemon and TCC grants. */
export class CuaBackend implements Backend {
  readonly kind = 'desktop' as const;
  private connection: Promise<CuaConnection> | undefined;
  private lastConnectionUse = 0;
  // 驱动会话一旦结束（空闲过期或连接关闭），同名后续调用会被永久拒绝；
  // 因此每个新连接都使用新的会话名，旧会话的快照随之失效。
  private session = `computer-use-${randomUUID()}`;
  private readonly states = new WeakMap<BackendObservation, State>();
  private readonly latest = new Map<string, BackendObservation>();
  private readonly active = new Set<AbortController>();
  private closed = false;
  private interrupted = false;

  constructor(private readonly socketPath: string, private readonly connector: (socketPath: string) => Promise<CuaConnection> = connect,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly processPaths: (pids: number[]) => Promise<Map<number, string>> = pids => windowsProcessPaths(socketPath, pids)) {}

  private async client(): Promise<CuaConnection> {
    if (this.closed) throw new CuError('unavailable', 'Desktop backend is closed.');
    const now = Date.now();
    if (this.connection && now - this.lastConnectionUse >= CONNECTION_IDLE_MS) {
      const stale = this.connection;
      this.connection = undefined;
      // Rotation happens before a new request. Never replay an action after transport uncertainty.
      if (this.active.size === 0) void stale.then(client => client.shutdown(readOptions())).catch(() => {});
    }
    this.lastConnectionUse = now;
    if (!this.connection) this.session = `computer-use-${randomUUID()}`;
    this.connection ??= this.connector(this.socketPath).then(async client => {
      const metadata = await client.metadata(readOptions());
      if (metadata.driverVersion !== VERSION) throw new CuError('unavailable', `Desktop driver must be version ${VERSION}.`);
      return client;
    }).catch(error => { this.connection = undefined; throw error; });
    try { return await this.connection; }
    catch (error) { if (error instanceof CuError) throw error; throw failure(record(record(error)?.inner)?.errorCode); }
  }

  private async read<T>(operation: (client: CuaConnection) => Promise<T>): Promise<T> {
    const client = await this.client();
    try { return await operation(client); }
    catch (error) {
      if (error instanceof CuError) throw error;
      // A stale SDK client can fail while the daemon remains healthy. Only read-only
      // operations may be retried; dispatched input must retain its uncertain result.
      if (await this.connection?.catch(() => undefined) === client) {
        this.connection = undefined;
        if (this.active.size === 0) void client.shutdown(readOptions()).catch(() => {});
      }
      try { return await operation(await this.client()); }
      catch (retryError) { throw retryError instanceof CuError ? retryError : failure(record(record(retryError)?.inner)?.errorCode); }
    }
  }

  async doctor(): Promise<Doctor> {
    let checks: Doctor['checks'] = [];
    try {
      checks = await this.read(async client => {
        const attemptChecks: Doctor['checks'] = [{ name: 'driver', ok: true, detail: `Cua Driver ${VERSION}; ${this.platform === 'win32' ? 'private worker SDK' : 'native socket SDK'}` }];
        const health = await client.callTool('health_report', JSON.stringify({ include: this.platform === 'win32'
          ? ['session_active', 'ax_capability', 'screen_capture_capability'] : ['bundle_identity'] }), readOptions());
        checkResult(health);
        const report = record(JSON.parse(health.structuredJson ?? '{}'));
        if (this.platform === 'win32') {
          const names = ['session_active', 'ax_capability', 'screen_capture_capability'];
          const entries = Array.isArray(report?.checks) ? report.checks.map(record) : [];
          for (const name of names) {
            const check = entries.find(item => item?.name === name);
            const ok = report?.schema_version === '1' && report.platform === 'win32' && check?.status === 'pass';
            attemptChecks.push({ name, ok, detail: ok ? 'Windows desktop check passed.' : 'Windows desktop check did not pass; inspect the interactive session and driver.' });
          }
          return attemptChecks;
        }
        const identity = Array.isArray(report?.checks) ? report.checks.map(record).find(check => check?.name === 'bundle_identity') : undefined;
        const identityData = record(identity?.data);
        const identityMatches = report?.schema_version === '1' && identity?.status === 'pass'
          && identityData?.identity_source === 'parent_application'
          && identityData.bundle_identifier === 'com.starroy.computeruse'
          && identityData.configured_bundle_identifier === 'com.starroy.computeruse';
        attemptChecks.push({ name: 'bundle_identity', ok: identityMatches,
          detail: identityMatches ? 'Driver is directly owned by the configured Computer Use application.' : 'Driver parent identity does not match the configured Computer Use application.' });
        const result = await client.callTool('check_permissions', JSON.stringify({ prompt: false }), readOptions());
        checkResult(result);
        const permissions = record(JSON.parse(result.structuredJson ?? '{}'));
        for (const name of ['accessibility', 'screen_recording']) {
          const ok = permissions?.[name] === true;
          attemptChecks.push({ name, ok, detail: ok
            ? name === 'screen_recording' ? 'TCC preflight granted; actual window capture was not probed. Use observe to verify capture.' : 'Accessibility preflight granted to the native host.'
            : 'Grant this permission to the native host in System Settings.' });
        }
        return attemptChecks;
      });
    } catch { checks.push({ name: 'driver', ok: false, detail: `Cannot reach a compatible Cua Driver ${VERSION} native host.` }); }
    return { available: checks.every(check => check.ok), checks };
  }

  async targets(grant: Grant): Promise<Target[]> {
    if (grant.appIds.length === 0) return [];
    return this.read(async client => {
      const { apps } = await client.listApps({}, readOptions());
      const nativePaths = this.platform === 'win32' ? await this.processPaths(apps.filter(app => app.running).map(app => app.pid)) : undefined;
      const targets: Target[] = [];
      for (const app of apps) {
        const appId = this.platform === 'win32' ? windowsAppId(nativePaths?.get(app.pid)) : app.bundleId;
        if (this.platform === 'win32' && app.launchPath && windowsAppId(app.launchPath) !== appId) continue;
        if (!app.running || !appId || !grant.appIds.includes(appId)) continue;
        const { windows } = await client.listWindows({ pid: app.pid, onScreenOnly: false }, readOptions());
        for (const window of windows) {
          if (window.pid !== undefined && window.pid !== app.pid) continue;
          const windowId = Number(window.windowId);
          if (!Number.isSafeInteger(windowId) || windowId <= 0) continue;
          targets.push({ id: `desktop:${app.pid}:${window.windowId}`, kind: 'desktop', appId, title: window.title, pid: app.pid, windowId });
        }
      }
      return targets;
    });
  }

  private async owner(target: Target): Promise<boolean> {
    const { pid } = exactTarget(target);
    const { apps } = await this.read(client => client.listApps({}, readOptions()));
    const nativePath = this.platform === 'win32' ? (await this.processPaths([pid])).get(pid) : undefined;
    return apps.some(app => app.pid === pid && app.running
      && (this.platform === 'win32' ? windowsAppId(nativePath) === target.appId
        && (!app.launchPath || windowsAppId(app.launchPath) === target.appId) : app.bundleId === target.appId));
  }

  async observe(target: Target): Promise<BackendObservation> {
    if (!await this.owner(target)) throw new CuError('not_found', 'Desktop target is no longer owned by the authorized application.');
    let session = this.session;
    const capture = () => this.read(client => {
      session = this.session;
      return client.getWindowState({ ...exactTarget(target), session, includeAccessibilityTree: true, includeScreenshot: true }, { signal: AbortSignal.timeout(15_000) });
    });
    let state = await capture();
    // 新 SDK 连接上的首次抓取可能不带截图和几何信息；只读观察可以安全地重试一次。
    if (!captured(state)) state = await capture();
    const image = state.images[0];
    if (state.pid !== target.pid || state.windowId !== BigInt(target.windowId!)) throw new CuError('stale_snapshot', 'Desktop observation did not match the requested window.');
    if (!image || !captured(state) || !state.windowBounds || !state.screenshotWidth || !state.screenshotHeight) {
      throw new CuError('unavailable', 'Desktop observation did not contain a valid window screenshot and geometry.');
    }
    const elements = this.platform === 'darwin' ? withoutHiddenMenus(state.elements ?? []) : state.elements ?? [];
    const observation: BackendObservation = { target: { ...target, title: state.windowTitle ?? target.title }, bounds: state.windowBounds,
      imageWidth: state.screenshotWidth, imageHeight: state.screenshotHeight,
      // 过滤后的树不能再用于证明元素不存在。
      elementsComplete: state.elementsComplete === true && elements.length === (state.elements ?? []).length,
      screenshot: { mimeType: image.mimeType as 'image/png' | 'image/jpeg', data: image.dataBase64 },
      elements: elements.filter(element => element.elementToken).map(element => ({
        id: element.elementToken!, role: element.role, label: element.label ?? '',
        // AX frames are global logical screen points. Actions and public element
        // bounds use window-local pixels of this particular (possibly scaled) image.
        ...(element.frame ? { bounds: {
          x: (element.frame.x - state.windowBounds!.x) * state.screenshotWidth! / state.windowBounds!.width,
          y: (element.frame.y - state.windowBounds!.y) * state.screenshotHeight! / state.windowBounds!.height,
          width: element.frame.w * state.screenshotWidth! / state.windowBounds!.width,
          height: element.frame.h * state.screenshotHeight! / state.windowBounds!.height,
        } } : {}),
      })) };
    this.states.set(observation, { snapshot: state, session, consumed: false });
    this.latest.set(`${target.pid}:${target.windowId}`, observation);
    return observation;
  }

  async validate(observation: BackendObservation): Promise<boolean> {
    const state = this.states.get(observation);
    if (!state || state.consumed || state.session !== this.session || this.latest.get(`${observation.target.pid}:${observation.target.windowId}`) !== observation
        || !await this.owner(observation.target)) return false;
    const target = exactTarget(observation.target);
    // Re-observing AX would mint new tokens. Geometry-only discovery leaves the
    // original snapshot tokens intact; Driver checks their generation at dispatch.
    const { windows } = await this.read(client => client.listWindows({ pid: target.pid, onScreenOnly: false }, readOptions()));
    return windows.some(window => window.windowId === target.windowId
      && (window.pid === undefined || window.pid === target.pid) && sameBounds(window.bounds, observation.bounds));
  }

  async act(observation: BackendObservation, action: Action, mode: Mode, signal: AbortSignal): Promise<BackendExecution> {
    if (this.interrupted) throw new CuError('unavailable', 'An earlier desktop action was interrupted. Restart the native host before sending more actions.');
    if (signal.aborted) throw new CuError('cancelled', 'Desktop action cancelled before dispatch.');
    if (mode !== 'background' && mode !== 'foreground') throw new CuError('invalid_request', 'Explicit delivery mode is required.');
    if (!await this.validate(observation)) throw new CuError('stale_snapshot', 'Observe the desktop target again before acting.');
    const { pid, windowId } = exactTarget(observation.target);
    const state = this.states.get(observation)!;
    const args: Record<string, unknown> = { pid, window_id: Number(windowId), session: state.session, delivery_mode: mode };
    const element = (id: string): string => {
      if (!observation.elements.some(element => element.id === id)) throw new CuError('stale_snapshot', 'Element does not belong to this observation.');
      return id;
    };
    let tool: string;
    switch (action.type) {
      case 'click':
        if (Boolean(action.elementId) === Boolean(action.point)) throw new CuError('invalid_request', 'Click requires exactly one element or point.');
        if (action.count !== undefined && (!Number.isInteger(action.count) || action.count < 1 || action.count > 3)) throw new CuError('invalid_request', 'Click count must be 1 to 3.');
        if (action.elementId && (action.count ?? 1) !== 1) throw new CuError('invalid_request', 'Repeated clicks require a screenshot point.');
        tool = 'click';
        Object.assign(args, action.elementId ? { element_token: element(action.elementId) } : point(action.point!, observation),
          { button: action.button ?? 'left', count: action.count ?? 1 });
        // Cua's Windows foreground element path forces SendInput, which
        // intermittently failed on WPF controls. Its background path tries
        // UIA semantic patterns before coordinate delivery.
        if (this.platform === 'win32' && action.elementId) args.delivery_mode = 'background';
        break;
      case 'type':
        tool = 'type_text'; args.text = action.text;
        if (action.elementId) {
          args.element_token = element(action.elementId);
          // Windows UIA ValuePattern can confirm the value; foreground SendInput
          // only confirms queuing and may drop long text after focus restoration.
          if (this.platform === 'win32') args.delivery_mode = 'background';
        }
        break;
      case 'key':
        if (action.keys.length === 0) throw new CuError('invalid_request', 'At least one key is required.');
        tool = 'hotkey'; args.keys = action.keys; break;
      case 'scroll':
        if (!Number.isInteger(action.amount) || action.amount < 1 || action.amount > 50) throw new CuError('invalid_request', 'Scroll amount must be 1 to 50.');
        tool = 'scroll';
        Object.assign(args, point(action.point ?? { x: observation.imageWidth / 2, y: observation.imageHeight / 2 }, observation),
          { direction: this.platform === 'darwin' ? reversed[action.direction] : action.direction,
            by: action.unit, amount: action.amount });
        break;
      case 'drag': {
        if (action.path.length !== 2) throw new CuError('invalid_request', 'This desktop driver supports straight two-point drags only.');
        if (!Number.isInteger(action.durationMs) || action.durationMs < 0 || action.durationMs > 10_000) throw new CuError('invalid_request', 'Drag duration must be 0 to 10000 milliseconds.');
        if (mode === 'background' && this.platform === 'darwin') throw new CuError('background_unavailable', 'Cua Driver 0.28.2 cannot deliver background drags on macOS.');
        const from = point(action.path[0]!, observation); const to = point(action.path[1]!, observation);
        tool = 'drag'; Object.assign(args, { from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y,
          duration_ms: action.durationMs, button: action.button ?? 'left', modifier: action.modifiers ?? [] }); break;
      }
      case 'navigate': throw new CuError('invalid_request', 'Desktop targets do not support browser navigation.');
    }
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    this.active.add(controller);
    let dispatched = false;
    try {
      const client = await this.client();
      if (combined.aborted) throw new CuError('cancelled', 'Desktop action cancelled before dispatch.');
      // 连接轮换会更换驱动会话；旧会话的元素 token 不能在新会话里派发。
      if (state.session !== this.session) throw new CuError('stale_snapshot', 'Desktop driver session changed; observe the target again.');
      // 驱动空闲约 1 秒后的首次窗口抓取会失败，坐标动作因此被拒为 px_capture_unavailable。
      // 派发前紧挨着做一次只读抓取预热；失败无妨，只影响随后派发是否被驱动拒绝。
      if (tool === 'drag' || tool === 'scroll' || (tool === 'click' && !args.element_token)) {
        await client.getWindowState({ pid, windowId, session: state.session, includeAccessibilityTree: false, includeScreenshot: true }, readOptions()).catch(() => undefined);
        if (combined.aborted) throw new CuError('cancelled', 'Desktop action cancelled before dispatch.');
      }
      state.consumed = true;
      dispatched = true;
      const result = await client.callTool(tool, JSON.stringify(args), { signal: combined });
      return checkResult(result, true);
    } catch (error) {
      if (error instanceof CuError) throw error;
      throw failure(record(record(error)?.inner)?.errorCode, dispatched);
    } finally {
      // Native spawn_blocking gestures may outlive cancellation of the SDK
      // future. Do not admit a second gesture until the host replaces its daemon.
      if (dispatched && combined.aborted) this.interrupted = true;
      this.active.delete(controller);
    }
  }

  async cancel(): Promise<void> {
    if (this.active.size > 0) this.interrupted = true;
    for (const controller of this.active) controller.abort();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.latest.clear();
    await this.cancel();
    const client = await this.connection?.catch(() => undefined);
    if (!client) return;
    try { await client.endSession({ session: this.session }, readOptions()); }
    finally {
      await client.shutdown(readOptions());
      if ('uniffiDestroy' in client && typeof client.uniffiDestroy === 'function') client.uniffiDestroy();
    }
  }
}
