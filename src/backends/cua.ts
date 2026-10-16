import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CuaDriverLike, ToolResult, WindowElement, WindowInfo, WindowStateOutput } from '@trycua/cua-driver';
import {
  CuError,
  hasPixels,
  type ActContext,
  type Action,
  type Backend,
  type BackendExecution,
  type BackendObservation,
  type Bounds,
  type Doctor,
  type Element,
  type ErrorCode,
  type ExecutionWarning,
  type Grant,
  type Mode,
  type ObserveOptions,
  type PixelObservation,
  type Point,
  type Target,
} from '../contracts.js';
import { windowsAppId } from '../app-identity.js';
import type { NativeHelper, PasteSession } from '../native-helper.js';

export type CuaConnection = Pick<
  CuaDriverLike,
  'metadata' | 'listApps' | 'listWindows' | 'getWindowState' | 'callTool' | 'endSession' | 'shutdown'
>;
type State = { snapshot: WindowStateOutput; session: string; consumed: boolean };
type AppList = Awaited<ReturnType<CuaConnection['listApps']>>['apps'];
const VERSION = '0.28.2';
// The SDK's implicit transport session expires after five minutes of inactivity.
const CONNECTION_IDLE_MS = 4 * 60_000;
// 应用列表一秒内的重复校验复用同一份结果。回退到 list_apps 时它要 2 到 3.5 秒，不该连付两次。
const APPS_CACHE_MS = 1000;
// 一次有效截图会给驱动的坐标派发预热，大约一秒后失效。
const CAPTURE_FRESH_MS = 1000;
const readOptions = () => ({ signal: AbortSignal.timeout(10_000) });
// 逐键输入的耗时（驱动 0.28.2，本机实测后台网页输入框）：每次调用约 4 秒固定开销（读回等待），之后每字符约 40 毫秒。
// 前台约每秒 9 个字符（实际使用记录），这里按每字符 120 毫秒保守估计。
const KEY_SETUP_MS = 4_500;
const BACKGROUND_MS_PER_CHAR = 40;
const FOREGROUND_MS_PER_CHAR = 120;
// 前台长文本分段输入：每段之后停一下，检查用户是否开始操作；段太小会放大每次调用的固定开销。
const FOREGROUND_CHUNK = 64;
const CHUNK_SETTLE_MS = 450;
// 前台动作前，用户需要至少这么久没有动键盘鼠标；自己刚发出的输入也会刷新这个时间，先等它过去。
const USER_QUIET_MS = 1_000;
// 粘贴快捷键发出后，等目标应用读完剪贴板再恢复。
const PASTE_RESTORE_DELAY_MS = 800;
const NO_PASTE_MENU =
  'This app has no Paste menu command a background session can use; nothing was sent. Use a foreground session, or type the text.';
const READBACK_WARNING: ExecutionWarning = {
  code: 'readback_mismatch',
  message:
    'The field did not read back the typed text. Web inputs such as terminals clear themselves after each keystroke, so the text usually arrived in full: check the target in a current screenshot and do not type it again.',
};
const execFileAsync = promisify(execFile);
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

// macOS 上用 get_accessibility_tree 取运行中的应用，约 50 毫秒。list_apps 还要扫描全部已安装应用，
// 这台机器上每次 2 到 3.5 秒，而归属校验在每次观察和每个动作前都要做。
// 实测（驱动 0.28.2）两者的运行中应用，包括被隐藏的，pid 与 Bundle ID 完全一致。
// 工具报错、返回结构不符或传输异常时返回 undefined，调用方回到 list_apps，只是更慢。
async function runningApps(client: CuaConnection): Promise<AppList | undefined> {
  try {
    const result = await client.callTool('get_accessibility_tree', '{}', readOptions());
    if (result.isError || result.structuredJson === undefined) return undefined;
    const apps = record(JSON.parse(result.structuredJson))?.apps;
    if (!Array.isArray(apps)) return undefined;
    const running: AppList = [];
    for (const raw of apps) {
      const app = record(raw);
      if (!app || typeof app.pid !== 'number' || !Number.isSafeInteger(app.pid) || app.pid <= 0) return undefined;
      running.push({
        pid: app.pid,
        name: typeof app.name === 'string' ? app.name : '',
        running: true,
        active: false,
        ...(typeof app.bundle_id === 'string' && app.bundle_id !== '' ? { bundleId: app.bundle_id } : {}),
      });
    }
    return running;
  } catch {
    return undefined;
  }
}

// settled：驱动调用已经返回（不是中断或连接丢失），没有仍在进行的输入。
function failure(code: unknown, mutation = false, settled = false): CuError {
  const known: Record<string, ErrorCode> = {
    background_unavailable: 'background_unavailable',
    background_occluded: 'background_unavailable',
    permission_denied: 'permission_denied',
    accessibility_permission_denied: 'permission_denied',
    screen_recording_permission_denied: 'permission_denied',
    stale_element_token: 'stale_snapshot',
    stale_snapshot: 'stale_snapshot',
    snapshot_id_required: 'stale_snapshot',
    window_not_found: 'not_found',
    window_id_not_found: 'not_found',
    app_not_found: 'not_found',
    invalid_arguments: 'invalid_request',
    // 以下均为驱动在派发前的明确拒绝（驱动文案："refused" / "Refusing to dispatch"），输入未发出。
    same_pid_keyboard_ambiguity: 'background_unavailable',
    off_space_or_ax_unresolved: 'background_unavailable',
    minimized_or_hidden_window: 'background_unavailable',
    px_capture_unavailable: 'stale_snapshot',
    px_frame_mismatch: 'stale_snapshot',
    px_window_not_found: 'stale_snapshot',
    // invoke_menu 在派发前的明确拒绝（结构化结果 status: refused）：路径缺失、重名或菜单项不可用。
    menu_path_unavailable: 'not_found',
  };
  const hints: Record<string, string> = {
    same_pid_keyboard_ambiguity:
      ' Key input cannot be proven to reach this window among sibling windows; use an element action or a foreground session.',
    off_space_or_ax_unresolved: ' The window is on another Space or its accessibility surface is unresolved.',
    minimized_or_hidden_window: ' The window is minimized or hidden; use an element action.',
    px_capture_unavailable: ' No provable pixel frame was available; observe again before a coordinate action.',
    menu_path_unavailable:
      ' The menu path was not found, is ambiguous or is disabled, or the window has no accessible menu; nothing was sent. Use the exact names shown in the menus.',
  };
  const mapped = typeof code === 'string' ? known[code] : undefined;
  const driverCode = typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : undefined;
  const advice =
    driverCode === 'type_text_incomplete'
      ? ' The field did not read back all typed characters; observe it and do not type the text again.'
      : ' Observe before retrying.';
  return new CuError(
    mapped ?? (mutation ? 'unknown_outcome' : 'unavailable'),
    mapped
      ? `Desktop backend refused the operation (${mapped}).${hints[code as string] ?? ''}`
      : mutation
        ? `Desktop action outcome is unknown${driverCode ? ` (driver code ${driverCode})` : ''}.${advice}`
        : 'Desktop backend is unavailable. Check the native host and permissions.',
    { settled: settled && mutation && !mapped },
  );
}

function checkResult(result: ToolResult): void;
function checkResult(result: ToolResult, mutation: true): BackendExecution;
function checkResult(result: ToolResult, mutation = false): BackendExecution | undefined {
  // 工具结果已经返回：即使效果不明，也没有仍在进行的输入。
  if (result.isError) throw failure(result.errorCode, mutation, true);
  // UniFFI's ActionEffect enum: Confirmed=0; Partial=1; Unverifiable=2;
  // SuspectedNoop=3; Refused=4. A successful transport is not an effect proof.
  if (mutation) {
    if (result.action?.effect === 4) throw new CuError('unavailable', 'Desktop driver refused this action.');
    return { effect: result.action?.effect === 0 ? 'confirmed' : 'unconfirmed' };
  }
}

function structured(result: ToolResult): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(result.structuredJson ?? 'null'));
  } catch {
    return undefined;
  }
}

// 按 Unicode 码位分段，不把代理对拆开。
function chunks(text: string, size: number): string[] {
  const characters = Array.from(text);
  const parts: string[] = [];
  for (let index = 0; index < characters.length; index += size) parts.push(characters.slice(index, index + size).join(''));
  return parts;
}

// 驱动在派发前因输入预算不足而拒绝（驱动说明：拒绝发生在任何字符事件之前）。已合成的字符数不是 0 时不算。
function budgetRefusal(result: ToolResult): CuError | undefined {
  if (!result.isError || result.errorCode !== 'type_text_synthesis_budget_exceeded') return undefined;
  const info = structured(result);
  const sent = info?.synthesized_chars;
  if (sent !== undefined && sent !== 0) return undefined;
  const max = typeof info?.max_chunk_chars === 'number' && info.max_chunk_chars > 0 ? Math.floor(info.max_chunk_chars) : undefined;
  return new CuError(
    'invalid_request',
    `The driver refused to type this much text in one call; nothing was sent. Split it into parts of${max ? ` at most ${max} characters` : ' fewer characters'} or use paste.`,
  );
}

// 窗口是否被前面的其他窗口完全挡住：在窗口内取一组均匀分布的点，每个点都落在更靠前的某个窗口里才算。
// 只是估算：透明或异形的窗口也会被当作遮挡。
function fullyCovered(own: WindowInfo, windows: WindowInfo[]): boolean {
  if (own.zIndex === undefined || own.bounds.width <= 0 || own.bounds.height <= 0) return false;
  const front = windows.filter(
    window =>
      window.windowId !== own.windowId &&
      window.isOnScreen &&
      window.zIndex !== undefined &&
      window.zIndex > own.zIndex! &&
      window.bounds.width > 0 &&
      window.bounds.height > 0,
  );
  if (front.length === 0) return false;
  const { x, y, width, height } = own.bounds;
  for (let column = 0; column < 9; column++)
    for (let row = 0; row < 7; row++) {
      const px = x + ((column + 0.5) * width) / 9;
      const py = y + ((row + 0.5) * height) / 7;
      const inside = front.some(
        window =>
          px >= window.bounds.x &&
          px < window.bounds.x + window.bounds.width &&
          py >= window.bounds.y &&
          py < window.bounds.y + window.bounds.height,
      );
      if (!inside) return false;
    }
  return true;
}

function exactTarget(target: Target): { pid: number; windowId: bigint } {
  if (
    target.kind !== 'desktop' ||
    !Number.isSafeInteger(target.pid) ||
    !Number.isSafeInteger(target.windowId) ||
    target.pid! <= 0 ||
    target.windowId! <= 0
  )
    throw new CuError('invalid_request', 'An exact desktop process and window are required.');
  return { pid: target.pid!, windowId: BigInt(target.windowId!) };
}

// 观察里的目标取实时标题；列出目标时记下的 offScreen 此后可能已不成立，不带进观察。
function observedTarget(target: Target, title: string | undefined): Target {
  const { offScreen: _, ...current } = target;
  return { ...current, title: title ?? target.title };
}

function sameBounds(a: Bounds, b: Bounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function captured(state: WindowStateOutput): boolean {
  const image = state.images[0];
  return Boolean(
    image &&
      ['image/png', 'image/jpeg'].includes(image.mimeType) &&
      state.windowBounds &&
      state.screenshotWidth &&
      state.screenshotHeight &&
      state.windowBounds.width > 0 &&
      state.windowBounds.height > 0 &&
      state.screenshotFrameValid !== false,
  );
}

// macOS 的 AX 树会附带菜单栏：
// - 系统级 Apple 菜单（菜单栏第一项）含最近使用的文件/应用及关机、重启等系统命令，整棵子树都不暴露；
// - 应用菜单中未展开（没有屏幕坐标）的内容，例如 Safari 的历史记录，属于隐私数据且当前不可见，也不暴露。
function withoutHiddenMenus(elements: WindowElement[]): WindowElement[] {
  const excluded = new Set<bigint>();
  const inMenu = new Set(elements.filter(element => element.role === 'AXMenuBar').map(element => element.elementIndex));
  for (const bar of [...inMenu]) {
    const first = elements
      .filter(element => element.role === 'AXMenuBarItem' && element.parentIndex === bar)
      .reduce<WindowElement | undefined>((min, element) => (!min || element.elementIndex < min.elementIndex ? element : min), undefined);
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

// 应用“编辑”菜单的常见名称，以及同一语言里“粘贴”命令的名称：系统各语言的标准菜单，以及 Electron、Tauri 的默认菜单。
const PASTE_BY_EDIT: Record<string, string[]> = {
  edit: ['Paste'],
  编辑: ['粘贴'],
  編輯: ['貼上'],
  編集: ['ペースト', '貼り付け'],
  편집: ['붙여넣기'],
  bearbeiten: ['Einsetzen', 'Einfügen'],
  édition: ['Coller'],
  edición: ['Pegar'],
  modifica: ['Incolla'],
  editar: ['Colar', 'Pegar'],
  правка: ['Вставить'],
  редагування: ['Вставити'],
  wijzig: ['Plak'],
  bewerken: ['Plakken', 'Plak'],
  redigera: ['Klistra in'],
  rediger: ['Indsæt', 'Lim inn'],
  muokkaa: ['Sijoita', 'Liitä'],
  edycja: ['Wklej'],
  düzen: ['Yapıştır'],
  úpravy: ['Vložit', 'Vložiť'],
  تحرير: ['لصق'],
  עריכה: ['הדבק'],
  แก้ไข: ['วาง'],
  sửa: ['Dán'],
  szerkesztés: ['Beillesztés'],
  επεξεργασία: ['Επικόλληση'],
};
const PASTE_TITLES = new Set(Object.values(PASTE_BY_EDIT).flatMap(names => names.map(name => name.toLowerCase())));

// 后台粘贴要调用的菜单路径，按尝试顺序排列。未激活的应用不处理 ⌘V 这类菜单快捷键（实测 WebKit 页面收不到粘贴），
// 通过辅助功能调用应用的“粘贴”菜单命令则可以送达该应用当前焦点所在的输入框。
// 快照里有“粘贴”项时直接用它（只做完整匹配，不会选中“粘贴并匹配样式”）。未激活应用的编辑菜单常常只列出系统附加的项，
// 这时按“编辑”菜单的语言给出该语言的“粘贴”名称逐个尝试；路径不存在时驱动在按下任何菜单项之前就报错。
function pasteMenuPaths(elements: WindowElement[]): string[][] {
  const children = (parent: WindowElement, role: string) =>
    elements
      .filter(element => element.parentIndex === parent.elementIndex && element.role === role)
      .sort((a, b) => (a.elementIndex < b.elementIndex ? -1 : 1));
  const listed: string[][] = [];
  const guessed: string[][] = [];
  // 第一项是 Apple 菜单。
  for (const bar of elements.filter(element => element.role === 'AXMenuBar'))
    for (const top of children(bar, 'AXMenuBarItem').slice(1)) {
      const title = (top.label ?? '').trim();
      if (!title) continue;
      const names = PASTE_BY_EDIT[title.toLowerCase()];
      for (const menu of children(top, 'AXMenu'))
        for (const item of children(menu, 'AXMenuItem')) {
          const label = (item.label ?? '').trim();
          if (!PASTE_TITLES.has(label.toLowerCase())) continue;
          if (names) listed.unshift([title, label]);
          else listed.push([title, label]);
        }
      if (names) guessed.push(...names.map(name => [title, name]));
    }
  const seen = new Set<string>();
  return [...listed, ...guessed].filter(path => {
    const key = path.join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 每个菜单栏的第一项是系统级 Apple 菜单（见上）：它不在观察里，调用菜单也不得绕过去。
function systemMenuLabels(elements: WindowElement[]): string[] | undefined {
  const bars = elements.filter(element => element.role === 'AXMenuBar');
  if (bars.length === 0) return undefined;
  return bars.flatMap(bar => {
    const first = elements
      .filter(element => element.role === 'AXMenuBarItem' && element.parentIndex === bar.elementIndex)
      .reduce<WindowElement | undefined>((min, element) => (!min || element.elementIndex < min.elementIndex ? element : min), undefined);
    return first ? [(first.label ?? '').trim().toLowerCase()] : [];
  });
}

// 密码类字段的值不进入观察结果，也不参与条件判断，避免 verify/wait 被用来逐次试探内容。
// 按角色识别；系统常用只含掩码字符的值代替真实内容，这类值同样丢弃，连长度也不透露。
// 实测 macOS 驱动把安全文本框报告为 AXTextField，值是等长的 U+F79A（系统私用区的掩码字符）。
// 单个圆点或星号多半是列表符号或必填标记，不当作掩码；U+F79A 不会作为普通文字出现。
const PROTECTED_ROLE = /secure|password/i;
const MASK_ONLY = /^(?:\uf79a+|[\u2022\u2219\u25cf*]{2,})$/u;
function readable(element: WindowElement): { label: string; value?: string } {
  const label = element.label ?? '';
  const { value } = element;
  if (!PROTECTED_ROLE.test(element.role) && (value === undefined || !MASK_ONLY.test(value)))
    return value === undefined ? { label } : { label, value };
  // 驱动在控件没有名称时会用值充当标签；这时标签也不能公开。
  return { label: value !== undefined && label === value ? '' : label };
}

// 把驱动的元素换成观察里的元素。有截图时带上窗口局部的像素位置，没有截图就不带：位置没有可对照的图像。
function observedElements(elements: WindowElement[], pixels?: { window: Bounds; width: number; height: number }): Element[] {
  return elements
    .filter(element => element.elementToken)
    .map(element => ({ element, ...readable(element) }))
    .map(({ element, label, value }) => ({
      id: element.elementToken!,
      role: element.role,
      label,
      ...(value !== undefined ? { value } : {}),
      ...(element.enabled !== undefined ? { enabled: element.enabled } : {}),
      ...(element.selected !== undefined ? { selected: element.selected } : {}),
      ...(Number.isFinite(element.min) && Number.isFinite(element.max) ? { min: element.min, max: element.max } : {}),
      depth: element.depth,
      // AX frames are global logical screen points. Actions and public element
      // bounds use window-local pixels of this particular (possibly scaled) image.
      ...(pixels && element.frame
        ? {
            bounds: {
              x: ((element.frame.x - pixels.window.x) * pixels.width) / pixels.window.width,
              y: ((element.frame.y - pixels.window.y) * pixels.height) / pixels.window.height,
              width: (element.frame.w * pixels.width) / pixels.window.width,
              height: (element.frame.h * pixels.height) / pixels.window.height,
            },
          }
        : {}),
    }));
}

// Cua Driver 0.28.2 的 macOS 坐标滚轮路径方向与请求相反，且与系统"自然滚动"设置无关
// （开启、关闭两种设置下均实测反向），派发前需交换方向。
const reversed = { up: 'down', down: 'up', left: 'right', right: 'left' } as const;

function point(point: Point, observation: PixelObservation): Point {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= observation.imageWidth ||
    point.y >= observation.imageHeight
  ) {
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
    const { stdout } = await execFileAsync(helper, ['--process-paths', unique.join(',')], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    });
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
  const { CuaDriver, ConfiguredDriverOptions, PrivateWorkerOptions, RuntimeAuthorizationOptions, SessionPermissionMode } = await import(
    '@trycua/cua-driver'
  );
  return CuaDriver.createPrivateWorker(
    PrivateWorkerOptions.create({
      binaryPath,
      hostBundleId: 'com.starroy.computeruse',
      configuredDriver: ConfiguredDriverOptions.create({
        claudeCodeCompatibility: false,
        authorization: RuntimeAuthorizationOptions.create({
          allowedModes: [SessionPermissionMode.Standard],
          compatibilityMode: SessionPermissionMode.Standard,
          unrestrictedAcknowledged: false,
          maxSessionTtlSeconds: 300n,
          maxIdleTtlSeconds: 300n,
        }),
      }),
      environment: [],
      inheritStderr: false,
    }),
  );
}

/** Socket SDK client only. The signed native host owns the daemon and TCC grants. */
export class CuaBackend implements Backend {
  readonly kind = 'desktop' as const;
  // act 在调用驱动派发前检查中止并回调 onDispatch；原生手势的中断仍需停止运行时，因此不声明 interruptionContained。
  readonly reportsDispatch = true;
  private connection: Promise<CuaConnection> | undefined;
  private lastConnectionUse = 0;
  // 驱动会话一旦结束（空闲过期或连接关闭），同名后续调用会被永久拒绝；
  // 因此每个新连接都使用新的会话名，旧会话的快照随之失效。
  private session = `computer-use-${randomUUID()}`;
  private readonly states = new WeakMap<BackendObservation, State>();
  private readonly latest = new Map<string, BackendObservation>();
  private readonly active = new Set<AbortController>();
  private appsCache: { at: number; apps: AppList } | undefined;
  // darwin 上，有效截图完成后的短时间内，坐标动作可以直接派发。
  private readonly freshCaptures = new Map<string, number>();
  private closed = false;
  private interrupted = false;
  // 本后端最近一次前台输入结束的时刻：它也会刷新系统的输入空闲时间。
  private lastForegroundInput = 0;

  constructor(
    private readonly socketPath: string,
    private readonly connector: (socketPath: string) => Promise<CuaConnection> = connect,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly processPaths: (pids: number[]) => Promise<Map<number, string>> = pids => windowsProcessPaths(socketPath, pids),
    // 同包宿主提供的剪贴板会话和用户输入空闲时间；没有时粘贴不可用，前台动作不做让行检查。
    private readonly native: NativeHelper | undefined = undefined,
  ) {}

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
    if (!this.connection) {
      this.session = `computer-use-${randomUUID()}`;
      this.freshCaptures.clear();
    }
    this.connection ??= this.connector(this.socketPath)
      .then(async client => {
        const metadata = await client.metadata(readOptions());
        if (metadata.driverVersion !== VERSION) throw new CuError('unavailable', `Desktop driver must be version ${VERSION}.`);
        return client;
      })
      .catch(error => {
        this.connection = undefined;
        throw error;
      });
    try {
      return await this.connection;
    } catch (error) {
      if (error instanceof CuError) throw error;
      throw failure(record(record(error)?.inner)?.errorCode);
    }
  }

  private async read<T>(operation: (client: CuaConnection) => Promise<T>): Promise<T> {
    const client = await this.client();
    try {
      return await operation(client);
    } catch (error) {
      if (error instanceof CuError) throw error;
      // A stale SDK client can fail while the daemon remains healthy. Only read-only
      // operations may be retried; dispatched input must retain its uncertain result.
      if ((await this.connection?.catch(() => undefined)) === client) {
        this.connection = undefined;
        if (this.active.size === 0) void client.shutdown(readOptions()).catch(() => {});
      }
      try {
        return await operation(await this.client());
      } catch (retryError) {
        throw retryError instanceof CuError ? retryError : failure(record(record(retryError)?.inner)?.errorCode);
      }
    }
  }

  async doctor(): Promise<Doctor> {
    let checks: Doctor['checks'] = [];
    try {
      checks = await this.read(async client => {
        const attemptChecks: Doctor['checks'] = [
          {
            name: 'driver',
            ok: true,
            detail: `Cua Driver ${VERSION}; ${this.platform === 'win32' ? 'private worker SDK' : 'native socket SDK'}`,
          },
        ];
        const health = await client.callTool(
          'health_report',
          JSON.stringify({
            include: this.platform === 'win32' ? ['session_active', 'ax_capability', 'screen_capture_capability'] : ['bundle_identity'],
          }),
          readOptions(),
        );
        checkResult(health);
        const report = record(JSON.parse(health.structuredJson ?? '{}'));
        if (this.platform === 'win32') {
          const names = ['session_active', 'ax_capability', 'screen_capture_capability'];
          const entries = Array.isArray(report?.checks) ? report.checks.map(record) : [];
          for (const name of names) {
            const check = entries.find(item => item?.name === name);
            const ok = report?.schema_version === '1' && report.platform === 'win32' && check?.status === 'pass';
            attemptChecks.push({
              name,
              ok,
              detail: ok
                ? 'Windows desktop check passed.'
                : 'Windows desktop check did not pass; inspect the interactive session and driver.',
            });
          }
          return attemptChecks;
        }
        const identity = Array.isArray(report?.checks)
          ? report.checks.map(record).find(check => check?.name === 'bundle_identity')
          : undefined;
        const identityData = record(identity?.data);
        const identityMatches =
          report?.schema_version === '1' &&
          identity?.status === 'pass' &&
          identityData?.identity_source === 'parent_application' &&
          identityData.bundle_identifier === 'com.starroy.computeruse' &&
          identityData.configured_bundle_identifier === 'com.starroy.computeruse';
        attemptChecks.push({
          name: 'bundle_identity',
          ok: identityMatches,
          detail: identityMatches
            ? 'Driver is directly owned by the configured Computer Use application.'
            : 'Driver parent identity does not match the configured Computer Use application.',
        });
        const result = await client.callTool('check_permissions', JSON.stringify({ prompt: false }), readOptions());
        checkResult(result);
        const permissions = record(JSON.parse(result.structuredJson ?? '{}'));
        for (const name of ['accessibility', 'screen_recording']) {
          const ok = permissions?.[name] === true;
          attemptChecks.push({
            name,
            ok,
            detail: ok
              ? name === 'screen_recording'
                ? 'TCC preflight granted; actual window capture was not probed. Use observe to verify capture.'
                : 'Accessibility preflight granted to the native host.'
              : 'Grant this permission to the native host in System Settings.',
          });
        }
        return attemptChecks;
      });
    } catch {
      checks.push({ name: 'driver', ok: false, detail: `Cannot reach a compatible Cua Driver ${VERSION} native host.` });
    }
    return { available: checks.every(check => check.ok), checks };
  }

  private cachedApps(): AppList | undefined {
    if (!this.appsCache || Date.now() - this.appsCache.at >= APPS_CACHE_MS) return undefined;
    return this.appsCache.apps;
  }

  private rememberApps(apps: AppList): void {
    this.appsCache = { at: Date.now(), apps };
  }

  private async listRunning(client: CuaConnection): Promise<AppList> {
    const running = this.platform === 'darwin' ? await runningApps(client) : undefined;
    return running ?? (await client.listApps({}, readOptions())).apps;
  }

  private async apps(): Promise<AppList> {
    const cached = this.cachedApps();
    if (cached) return cached;
    const apps = await this.read(client => this.listRunning(client));
    this.rememberApps(apps);
    return apps;
  }

  private captureKey(target: Target): string {
    return `${target.pid}:${target.windowId}`;
  }

  /** 有效截图已经预热过坐标派发时返回 true，并消费这次预热。 */
  private takeFreshCapture(target: Target): boolean {
    const key = this.captureKey(target);
    const at = this.freshCaptures.get(key);
    this.freshCaptures.delete(key);
    return this.platform === 'darwin' && at !== undefined && Date.now() - at < CAPTURE_FRESH_MS;
  }

  async targets(grant: Grant): Promise<Target[]> {
    if (grant.allApps !== true && grant.appIds.length === 0) return [];
    const cached = this.cachedApps();
    return this.read(async client => {
      const apps = cached ?? (await this.listRunning(client));
      if (!cached) this.rememberApps(apps);
      const nativePaths =
        this.platform === 'win32' ? await this.processPaths(apps.filter(app => app.running).map(app => app.pid)) : undefined;
      // 授权全部应用时没有什么要在枚举前过滤：一次取全部窗口再按应用分组。逐个应用调用 list_windows 每次约 45 毫秒，
      // 20 个应用累计约 1 秒（实测 144 个窗口 0.93–1.07 秒）。显式应用清单仍逐个应用枚举，不读清单之外的窗口。
      const everyWindow =
        this.platform === 'darwin' && grant.allApps === true
          ? (await client.listWindows({ onScreenOnly: false }, readOptions())).windows
          : undefined;
      const targets: Target[] = [];
      for (const app of apps) {
        const appId = this.platform === 'win32' ? windowsAppId(nativePaths?.get(app.pid)) : app.bundleId;
        if (this.platform === 'win32' && app.launchPath && windowsAppId(app.launchPath) !== appId) continue;
        if (!app.running || !appId || (grant.allApps !== true && !grant.appIds.includes(appId))) continue;
        const windows = everyWindow
          ? everyWindow.filter(item => item.pid === app.pid)
          : (await client.listWindows({ pid: app.pid, onScreenOnly: false }, readOptions())).windows;
        for (const window of windows) {
          if (window.pid !== undefined && window.pid !== app.pid) continue;
          const windowId = Number(window.windowId);
          if (!Number.isSafeInteger(windowId) || windowId <= 0) continue;
          const offScreen = window.isOnScreen
            ? undefined
            : window.minimized
              ? 'minimized'
              : window.onCurrentSpace === false
                ? 'other-space'
                : 'not-visible';
          targets.push({
            id: `desktop:${app.pid}:${window.windowId}`,
            kind: 'desktop',
            appId,
            title: window.title,
            pid: app.pid,
            windowId,
            ...(offScreen ? { offScreen } : {}),
          });
        }
      }
      return targets;
    });
  }

  private async owner(target: Target): Promise<boolean> {
    const { pid } = exactTarget(target);
    const apps = await this.apps();
    const nativePath = this.platform === 'win32' ? (await this.processPaths([pid])).get(pid) : undefined;
    return apps.some(
      app =>
        app.pid === pid &&
        app.running &&
        (this.platform === 'win32'
          ? windowsAppId(nativePath) === target.appId && (!app.launchPath || windowsAppId(app.launchPath) === target.appId)
          : app.bundleId === target.appId),
    );
  }

  // 只取元素：不抓取窗口图像，也就没有合并请求时偶发的约 5 秒首帧等待。
  // 驱动在这条路径上不返回窗口几何，另用 listWindows 取（约 40 毫秒）。
  private async observeElements(target: Target): Promise<BackendObservation> {
    const { pid, windowId } = exactTarget(target);
    // 先取几何再走树：窗口在两者之间移动时，动作前的 validate 会因几何不符判为过期，不会放行前后不一致的快照。
    const { windows } = await this.read(client => client.listWindows({ pid, onScreenOnly: false }, readOptions()));
    const window = windows.find(item => item.windowId === windowId && (item.pid === undefined || item.pid === pid));
    if (!window) throw new CuError('not_found', 'Desktop window no longer exists.');
    let session = this.session;
    const state = await this.read(client => {
      session = this.session;
      return client.getWindowState(
        { pid, windowId, session, includeAccessibilityTree: true, includeScreenshot: false },
        { signal: AbortSignal.timeout(15_000) },
      );
    });
    if (state.pid !== pid || state.windowId !== windowId)
      throw new CuError('stale_snapshot', 'Desktop observation did not match the requested window.');
    const elements = this.platform === 'darwin' ? withoutHiddenMenus(state.elements ?? []) : (state.elements ?? []);
    const observation: BackendObservation = {
      target: observedTarget(target, state.windowTitle),
      bounds: window.bounds,
      // 过滤后的树不能再用于证明元素不存在。
      elementsComplete: state.elementsComplete === true && elements.length === (state.elements ?? []).length,
      elements: observedElements(elements),
      ...(await this.coverage(target, state, false)),
    };
    this.states.set(observation, { snapshot: state, session, consumed: false });
    this.latest.set(this.captureKey(target), observation);
    return observation;
  }

  // 被完全挡住的窗口：网页视图此时可能不再重绘，截图可能停在旧画面。读不到窗口层级时不作判断。
  private async coverage(
    target: Target,
    state: WindowStateOutput,
    screenshot: boolean,
  ): Promise<{ covered?: true; screenshotMayBeStale?: true }> {
    try {
      const { windows } = await this.read(client => client.listWindows({ onScreenOnly: true }, readOptions()));
      const own = windows.find(
        window => window.windowId === BigInt(target.windowId!) && (window.pid === undefined || window.pid === target.pid),
      );
      if (!own || !fullyCovered(own, windows)) return {};
      const web = (state.elements ?? []).some(element => element.inWebContent === true);
      return { covered: true, ...(screenshot && web ? { screenshotMayBeStale: true as const } : {}) };
    } catch {
      return {};
    }
  }

  async observe(target: Target, options?: ObserveOptions): Promise<BackendObservation> {
    if (!(await this.owner(target))) throw new CuError('not_found', 'Desktop target is no longer owned by the authorized application.');
    if (options?.pixels === false) return this.observeElements(target);
    let session = this.session;
    const capture = () =>
      this.read(client => {
        session = this.session;
        return client.getWindowState(
          { ...exactTarget(target), session, includeAccessibilityTree: true, includeScreenshot: true },
          { signal: AbortSignal.timeout(15_000) },
        );
      });
    let state = await capture();
    // 合并请求树和截图时，驱动经常先花大约 5 秒返回一帧没有图像的结果，紧接着的一次才带上截图。
    // 只读观察可以重试一次。不能中途取消第一次：取消后后续抓取会一直空着。
    if (!captured(state)) state = await capture();
    const image = state.images[0];
    if (state.pid !== target.pid || state.windowId !== BigInt(target.windowId!))
      throw new CuError('stale_snapshot', 'Desktop observation did not match the requested window.');
    if (!image || !captured(state) || !state.windowBounds || !state.screenshotWidth || !state.screenshotHeight) {
      throw new CuError('unavailable', 'Desktop observation did not contain a valid window screenshot and geometry.');
    }
    const elements = this.platform === 'darwin' ? withoutHiddenMenus(state.elements ?? []) : (state.elements ?? []);
    const observation: BackendObservation = {
      target: observedTarget(target, state.windowTitle),
      bounds: state.windowBounds,
      imageWidth: state.screenshotWidth,
      imageHeight: state.screenshotHeight,
      // 过滤后的树不能再用于证明元素不存在。
      elementsComplete: state.elementsComplete === true && elements.length === (state.elements ?? []).length,
      screenshot: { mimeType: image.mimeType as 'image/png' | 'image/jpeg', data: image.dataBase64 },
      elements: observedElements(elements, {
        window: state.windowBounds,
        width: state.screenshotWidth,
        height: state.screenshotHeight,
      }),
      ...(await this.coverage(target, state, true)),
    };
    this.states.set(observation, { snapshot: state, session, consumed: false });
    this.latest.set(this.captureKey(target), observation);
    // 抓取本身可能要数秒。把应用列表的缓存时间挪到抓取结束，紧接着的动作不必再枚举进程；
    // 回退到 list_apps 时那要 2 到 3.5 秒，会把刚完成的截图预热拖过期。列表内容仍是这次观察开始时核对过的那一份。
    if (this.platform === 'darwin') {
      if (this.appsCache) this.appsCache = { ...this.appsCache, at: Date.now() };
      this.freshCaptures.set(this.captureKey(target), Date.now());
    }
    return observation;
  }

  private webElement(observation: BackendObservation, elementId: string | undefined): boolean {
    if (!elementId) return false;
    return this.states.get(observation)?.snapshot.elements?.find(item => item.elementToken === elementId)?.inWebContent === true;
  }

  // 只估算已知很慢的逐键输入：macOS 前台输入，以及后台向网页内容输入。原生文本框通常一次写入，不估算。
  estimateMs(observation: BackendObservation, action: Action, mode: Mode): number | undefined {
    if (action.type !== 'type' || this.platform !== 'darwin') return undefined;
    const characters = Array.from(action.text).length;
    if (characters === 0) return undefined;
    if (mode === 'foreground')
      return Math.ceil(characters / FOREGROUND_CHUNK) * (KEY_SETUP_MS + CHUNK_SETTLE_MS) + characters * FOREGROUND_MS_PER_CHAR;
    return this.webElement(observation, action.elementId) ? KEY_SETUP_MS + characters * BACKGROUND_MS_PER_CHAR : undefined;
  }

  // 前台动作会动用真实的键盘鼠标：用户正在用时，派发前让行，什么都不发出。
  private async ensureUserQuiet(signal: AbortSignal): Promise<void> {
    if (!this.native) return;
    const wait = this.lastForegroundInput + USER_QUIET_MS - Date.now();
    if (wait > 0) await delay(wait, undefined, { signal }).catch(() => {});
    if (signal.aborted) throw new CuError('cancelled', 'Desktop action cancelled before dispatch.');
    const idle = await this.native.inputIdleMs();
    if (idle !== undefined && idle < USER_QUIET_MS)
      throw new CuError(
        'busy',
        'The user is using the mouse or keyboard right now; nothing was sent. Wait until they stop, or tell them what you are about to do, then try again.',
      );
  }

  // 一次输入调用的结果。网页输入框会自行清空，驱动按读回判定“未送达”并不可信：记为已执行、效果未确认。
  private typeOutcome(result: ToolResult, web: boolean): BackendExecution {
    const refusal = budgetRefusal(result);
    if (refusal) throw refusal;
    if (result.isError && result.errorCode === 'type_text_incomplete' && web && structured(result)?.path === 'key_events')
      return { effect: 'unconfirmed', warning: READBACK_WARNING };
    return checkResult(result, true);
  }

  // 前台长文本分段输入：每段之间检查剩余时间和用户是否开始操作；停下时报告已完整送达的字符数。
  private async typeInParts(
    client: CuaConnection,
    args: Record<string, unknown>,
    text: string,
    web: boolean,
    signal: AbortSignal,
    budgetMs: number | undefined,
  ): Promise<BackendExecution> {
    const parts = chunks(text, FOREGROUND_CHUNK);
    const total = Array.from(text).length;
    const started = Date.now();
    let delivered = 0;
    let execution: BackendExecution = { effect: 'confirmed' };
    const stop = (reason: string): BackendExecution => ({
      effect: 'unconfirmed',
      progress: { delivered, total },
      warning: {
        code: 'partial_input',
        message: `Typing stopped after ${delivered} of ${total} characters ${reason}; the rest was not sent. Check the field before continuing.`,
      },
    });
    for (const [index, part] of parts.entries()) {
      const size = Array.from(part).length;
      if (index > 0) {
        if (budgetMs !== undefined && Date.now() - started + CHUNK_SETTLE_MS + KEY_SETUP_MS + size * FOREGROUND_MS_PER_CHAR > budgetMs)
          return stop('to stay within timeoutMs');
        await delay(CHUNK_SETTLE_MS, undefined, { signal }).catch(() => {});
        if (signal.aborted) return stop('because the action was cancelled');
        const idle = await this.native?.inputIdleMs();
        if (idle !== undefined && idle < CHUNK_SETTLE_MS - 100) return stop('because the user started using the mouse or keyboard');
      }
      const result = await client.callTool('type_text', JSON.stringify({ ...args, text: part }), { signal });
      this.lastForegroundInput = Date.now();
      let outcome: BackendExecution;
      try {
        outcome = this.typeOutcome(result, web);
      } catch (error) {
        if (delivered === 0) throw error;
        if (error instanceof CuError && error.code === 'invalid_request') return stop('because the driver refused the next part');
        throw new CuError(
          'unknown_outcome',
          `Typing stopped after ${delivered} of ${total} characters; the outcome of the next part is unknown. Observe the field before retrying.`,
          { settled: true },
        );
      }
      delivered += size;
      if (outcome.effect === 'unconfirmed') execution = { ...execution, effect: 'unconfirmed' };
      if (outcome.warning && !execution.warning) execution = { ...execution, warning: outcome.warning };
    }
    return execution;
  }

  async validate(observation: BackendObservation): Promise<boolean> {
    const state = this.states.get(observation);
    if (
      !state ||
      state.consumed ||
      state.session !== this.session ||
      this.latest.get(`${observation.target.pid}:${observation.target.windowId}`) !== observation ||
      !(await this.owner(observation.target))
    )
      return false;
    const target = exactTarget(observation.target);
    // Re-observing AX would mint new tokens. Geometry-only discovery leaves the
    // original snapshot tokens intact; Driver checks their generation at dispatch.
    const { windows } = await this.read(client => client.listWindows({ pid: target.pid, onScreenOnly: false }, readOptions()));
    return windows.some(
      window =>
        window.windowId === target.windowId &&
        (window.pid === undefined || window.pid === target.pid) &&
        sameBounds(window.bounds, observation.bounds),
    );
  }

  async act(
    observation: BackendObservation,
    action: Action,
    mode: Mode,
    signal: AbortSignal,
    onDispatch?: () => void,
    context?: ActContext,
  ): Promise<BackendExecution> {
    if (this.interrupted)
      throw new CuError('unavailable', 'An earlier desktop action was interrupted. Restart the native host before sending more actions.');
    if (signal.aborted) throw new CuError('cancelled', 'Desktop action cancelled before dispatch.');
    if (mode !== 'background' && mode !== 'foreground') throw new CuError('invalid_request', 'Explicit delivery mode is required.');
    if (!(await this.validate(observation))) throw new CuError('stale_snapshot', 'Observe the desktop target again before acting.');
    const { pid, windowId } = exactTarget(observation.target);
    const state = this.states.get(observation)!;
    const args: Record<string, unknown> = { pid, window_id: Number(windowId), session: state.session, delivery_mode: mode };
    const element = (id: string): string => {
      if (!observation.elements.some(element => element.id === id))
        throw new CuError('stale_snapshot', 'Element does not belong to this observation.');
      return id;
    };
    // 只取元素的快照没有截图：坐标、拖拽和滚动（默认落在图像中心）都没有可对照的像素。
    const pixelObservation = (): PixelObservation => {
      if (!hasPixels(observation))
        throw new CuError(
          'invalid_request',
          'This snapshot has no screenshot; observe again without elementsOnly before using coordinates, drag or scroll.',
        );
      return observation;
    };
    let tool: string;
    let textClickPoint = false;
    // 文字输入的附加信息：目标是否网页内容、是否分段；粘贴时要写入剪贴板的文字。
    let web = false;
    let typedInParts: string | undefined;
    let paste: { text: string; restore: boolean } | undefined;
    // 后台粘贴依次尝试的菜单路径。
    let menuPaths: string[][] | undefined;
    switch (action.type) {
      case 'click': {
        if (Boolean(action.elementId) === Boolean(action.point))
          throw new CuError('invalid_request', 'Click requires exactly one element or point.');
        if (action.count !== undefined && (!Number.isInteger(action.count) || action.count < 1 || action.count > 3))
          throw new CuError('invalid_request', 'Click count must be 1 to 3.');
        if (action.elementId && (action.count ?? 1) !== 1)
          throw new CuError('invalid_request', 'Repeated clicks require a screenshot point.');
        const modifiers = action.modifiers ?? [];
        if (modifiers.length > 0) {
          // 驱动只在前台投递时才把修饰键交给系统（后台没有真实的修饰键状态可带），所以后台会话不发出这类点击。
          if (mode !== 'foreground')
            throw new CuError(
              'background_unavailable',
              'A click with modifier keys needs a foreground session: modifier keys cannot be held in the background.',
            );
          if (this.platform === 'win32' && modifiers.includes('cmd'))
            throw new CuError('invalid_request', 'The cmd modifier does not exist on Windows; use ctrl.');
        }
        tool = 'click';
        // 元素换成它的中心像素：文本框没有 AXPress 时走像素路径；带修饰键的点击也只能走像素路径。
        const pixelRoute = (missing: string, what: string): Point => {
          if (!hasPixels(observation)) throw new CuError('invalid_request', missing);
          const bounds = observation.elements.find(item => item.id === action.elementId)?.bounds;
          if (
            !bounds ||
            ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
            bounds.width <= 0 ||
            bounds.height <= 0 ||
            bounds.x < 0 ||
            bounds.y < 0 ||
            bounds.x + bounds.width > observation.imageWidth ||
            bounds.y + bounds.height > observation.imageHeight
          )
            throw new CuError('background_unavailable', `${what} has no enabled, fully visible click target in this snapshot.`);
          return point({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, observation);
        };
        const native = action.elementId ? state.snapshot.elements?.find(item => item.elementToken === action.elementId) : undefined;
        Object.assign(args, action.elementId ? { element_token: element(action.elementId) } : point(action.point!, pixelObservation()), {
          button: action.button ?? 'left',
          count: action.count ?? 1,
        });
        if (action.elementId && modifiers.length > 0) {
          if (native?.enabled === false)
            throw new CuError('background_unavailable', 'Element has no enabled, fully visible click target in this snapshot.');
          const center = pixelRoute(
            'Clicking an element with modifier keys needs a snapshot with a screenshot; observe again without elementsOnly.',
            'Element',
          );
          delete args.element_token;
          Object.assign(args, center);
          textClickPoint = true;
        } else if (this.platform === 'darwin' && action.elementId && (action.button ?? 'left') === 'left') {
          // Addressable text controls need not implement AXPress (AppKit's
          // NSTextField exposes AXConfirm/AXShowMenu instead). Choose the
          // driver's exact-window pixel route BEFORE dispatch, never retry an
          // AX failure: that failure may already have delivered input.
          if (
            native &&
            ['AXTextField', 'AXTextArea'].includes(native.role) &&
            native.actions !== undefined &&
            !native.actions.includes('AXPress')
          ) {
            if (native.enabled === false)
              throw new CuError('background_unavailable', 'Text control has no enabled, fully visible click target in this snapshot.');
            const center = pixelRoute(
              'Clicking a text control needs a snapshot with a screenshot; observe again without elementsOnly, or type into it with its elementId.',
              'Text control',
            );
            delete args.element_token;
            Object.assign(args, center);
            textClickPoint = true;
          }
        }
        if (modifiers.length > 0) args.modifier = modifiers.map(name => (this.platform === 'win32' && name === 'option' ? 'alt' : name));
        // Cua's Windows foreground element path forces SendInput, which
        // intermittently failed on WPF controls. Its background path tries
        // UIA semantic patterns before coordinate delivery.
        if (this.platform === 'win32' && action.elementId && modifiers.length === 0) args.delivery_mode = 'background';
        break;
      }
      case 'type':
        tool = 'type_text';
        args.text = action.text;
        if (action.elementId) {
          args.element_token = element(action.elementId);
          web = this.webElement(observation, action.elementId);
          // Windows UIA ValuePattern can confirm the value; foreground SendInput
          // only confirms queuing and may drop long text after focus restoration.
          if (this.platform === 'win32') args.delivery_mode = 'background';
        }
        if (this.platform === 'darwin' && mode === 'foreground' && Array.from(action.text).length > FOREGROUND_CHUNK)
          typedInParts = action.text;
        break;
      case 'paste': {
        // 末尾换行在终端里等于回车：去掉，回车由 Agent 核对整行后单独发送。
        const text = action.text.replace(/[\r\n]+$/u, '');
        if (!text) throw new CuError('invalid_request', 'Nothing to paste after removing trailing line breaks.');
        if (!this.native) throw new CuError('unavailable', 'Paste is not available in this installation.');
        if (this.platform === 'darwin' && mode === 'background') {
          // 后台不能用 ⌘V，改为调用应用的“粘贴”菜单命令：它送到应用当前焦点所在的输入框，不能指定元素。
          if (action.elementId)
            throw new CuError(
              'background_unavailable',
              'In a background session paste goes through the app’s Paste menu command to the field that has focus, so it cannot target an element: click the field first if it is not focused, then paste without elementId.',
            );
          menuPaths = pasteMenuPaths(state.snapshot.elements ?? []);
          if (menuPaths.length === 0) throw new CuError('background_unavailable', NO_PASTE_MENU);
          tool = 'invoke_menu';
          delete args.delivery_mode;
        } else {
          tool = 'hotkey';
          args.keys = this.platform === 'win32' ? ['ctrl', 'v'] : ['cmd', 'v'];
          if (action.elementId) args.element_token = element(action.elementId);
        }
        paste = { text, restore: action.restoreClipboard };
        break;
      }
      case 'key':
        if (action.keys.length === 0) throw new CuError('invalid_request', 'At least one key is required.');
        tool = 'hotkey';
        args.keys = action.keys;
        break;
      case 'scroll': {
        if (!Number.isInteger(action.amount) || action.amount < 1 || action.amount > 50)
          throw new CuError('invalid_request', 'Scroll amount must be 1 to 50.');
        const pixels = pixelObservation();
        tool = 'scroll';
        Object.assign(args, point(action.point ?? { x: pixels.imageWidth / 2, y: pixels.imageHeight / 2 }, pixels), {
          direction: this.platform === 'darwin' ? reversed[action.direction] : action.direction,
          by: action.unit,
          amount: action.amount,
        });
        break;
      }
      case 'drag': {
        if (action.path.length !== 2) throw new CuError('invalid_request', 'This desktop driver supports straight two-point drags only.');
        if (!Number.isInteger(action.durationMs) || action.durationMs < 0 || action.durationMs > 10_000)
          throw new CuError('invalid_request', 'Drag duration must be 0 to 10000 milliseconds.');
        if (mode === 'background' && this.platform === 'darwin')
          throw new CuError('background_unavailable', 'Cua Driver 0.28.2 cannot deliver background drags on macOS.');
        const pixels = pixelObservation();
        const from = point(action.path[0]!, pixels);
        const to = point(action.path[1]!, pixels);
        tool = 'drag';
        Object.assign(args, {
          from_x: from.x,
          from_y: from.y,
          to_x: to.x,
          to_y: to.y,
          duration_ms: action.durationMs,
          button: action.button ?? 'left',
          modifier: action.modifiers ?? [],
        });
        break;
      }
      case 'setValue': {
        const token = element(action.elementId);
        // set_value 对 AXPopUpButton 靠子选项工作；驱动 0.28.2 在原生弹出按钮没有 AX 子项时返回无错误码的失败，
        // 无法证明输入没有发出，会被记为结果不确定并停机，所以派发前就拒绝这一类元素。
        if (this.platform === 'darwin' && state.snapshot.elements?.find(item => item.elementToken === token)?.role === 'AXPopUpButton')
          throw new CuError(
            'invalid_request',
            'Pop-up buttons cannot be set directly; click it to open the list, observe, then click the option.',
          );
        tool = 'set_value';
        // set_value 与 invoke_menu 都走辅助功能接口，没有投递方式参数，也不会移动焦点。
        delete args.delivery_mode;
        args.element_token = token;
        args.value = action.value;
        break;
      }
      case 'menu': {
        if (this.platform === 'darwin') {
          const system = systemMenuLabels(state.snapshot.elements ?? []);
          if (!system) throw new CuError('invalid_request', 'This snapshot has no application menu bar; observe the window again.');
          if (system.includes(action.path[0]!.trim().toLowerCase()))
            throw new CuError('permission_denied', 'The system (Apple) menu is not available to agents.');
        }
        tool = 'invoke_menu';
        delete args.delivery_mode;
        args.path = action.path;
        break;
      }
      case 'navigate':
        throw new CuError('invalid_request', 'Desktop targets do not support browser navigation.');
    }
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    this.active.add(controller);
    let dispatched = false;
    let pasteSession: PasteSession | undefined;
    let clipboardComplete = true;
    try {
      const client = await this.client();
      if (combined.aborted) throw new CuError('cancelled', 'Desktop action cancelled before dispatch.');
      // 连接轮换会更换驱动会话；旧会话的元素 token 不能在新会话里派发。
      if (state.session !== this.session) throw new CuError('stale_snapshot', 'Desktop driver session changed; observe the target again.');
      // 有效截图后大约 1 秒内，坐标动作可以直接派发（约 3 秒）。再插入一次抓取反而会先空转约 4 秒。
      // 超过这个窗口后，不预热的派发会以 px_capture_unavailable 失败，所以仍要紧挨着抓一次。
      const pointer = tool === 'drag' || tool === 'scroll' || (tool === 'click' && !args.element_token);
      if (pointer && !this.takeFreshCapture(observation.target)) {
        const warmed = await client
          .getWindowState(
            { pid, windowId, session: state.session, includeAccessibilityTree: false, includeScreenshot: true },
            readOptions(),
          )
          .catch(() => undefined);
        if (combined.aborted) throw new CuError('cancelled', 'Desktop action cancelled before dispatch.');
        // Warming updates the driver's pixel scale. A text element's center
        // was derived from the original image, so a resize or display change
        // must invalidate it rather than send old coordinates into a new frame.
        if (
          textClickPoint &&
          (!warmed ||
            !captured(warmed) ||
            warmed.pid !== pid ||
            warmed.windowId !== windowId ||
            !sameBounds(warmed.windowBounds!, observation.bounds) ||
            warmed.screenshotWidth !== observation.imageWidth ||
            warmed.screenshotHeight !== observation.imageHeight)
        )
          throw new CuError('stale_snapshot', 'Text click geometry changed or could not be verified; observe again before acting.');
      }
      // set_value 与 invoke_menu 不动用键盘鼠标，不需要让行。
      const foreground = args.delivery_mode === 'foreground';
      if (foreground) await this.ensureUserQuiet(combined);
      if (paste) {
        pasteSession = await this.native!.openPasteSession();
        if (combined.aborted) throw new CuError('cancelled', 'Desktop action cancelled before dispatch.');
        const staged = await pasteSession.stage(paste.text, paste.restore);
        clipboardComplete = staged.complete;
      }
      // 从这里到 callTool 之间没有 await：通过此处检查后不会再被中止打断，回调与派发处于同一时刻。
      if (combined.aborted) throw new CuError('cancelled', 'Desktop action cancelled before dispatch.');
      onDispatch?.();
      state.consumed = true;
      dispatched = true;
      if (typedInParts !== undefined) return await this.typeInParts(client, args, typedInParts, web, combined, context?.budgetMs);
      let result: ToolResult;
      if (menuPaths) {
        // 路径不存在（menu_path_unavailable）时驱动没有按下任何菜单项，可以换下一个名称；其他结果照常处理。
        let index = 0;
        do {
          if (combined.aborted) throw new CuError('cancelled', 'Desktop action cancelled.', { settled: true });
          result = await client.callTool(tool, JSON.stringify({ ...args, path: menuPaths[index] }), { signal: combined });
        } while (result.isError && result.errorCode === 'menu_path_unavailable' && ++index < menuPaths.length);
        if (result.isError && result.errorCode === 'menu_path_unavailable')
          throw new CuError('background_unavailable', NO_PASTE_MENU, { settled: true });
      } else result = await client.callTool(tool, JSON.stringify(args), { signal: combined });
      if (foreground) this.lastForegroundInput = Date.now();
      const execution = tool === 'type_text' ? this.typeOutcome(result, web) : checkResult(result, true);
      if (pasteSession && paste) {
        const session = pasteSession;
        pasteSession = undefined;
        // 不恢复时只需结束辅助进程；它不会读取或改回剪贴板。
        if (!paste.restore) {
          session.abort();
          return execution;
        }
        const { restored } = await session.finish(PASTE_RESTORE_DELAY_MS).catch(() => ({ restored: false }));
        if (!restored)
          return {
            ...execution,
            warning: {
              code: 'clipboard_not_restored',
              message:
                'The clipboard was not restored: the user copied something else meanwhile, or restoring failed. Tell the user their clipboard may hold the pasted text.',
            },
          };
        if (!clipboardComplete)
          return {
            ...execution,
            warning: {
              code: 'clipboard_partial',
              message: 'Some clipboard formats could not be saved, so the restored clipboard may lack them. Tell the user.',
            },
          };
      }
      return execution;
    } catch (error) {
      if (error instanceof CuError) throw error;
      throw failure(record(record(error)?.inner)?.errorCode, dispatched);
    } finally {
      // 粘贴没有正常结束（取消、错误）：立即请辅助进程把剪贴板换回去。
      pasteSession?.abort();
      // Native spawn_blocking gestures may outlive cancellation of the SDK
      // future. Do not admit a second gesture until the host replaces its daemon.
      if (dispatched && combined.aborted) this.interrupted = true;
      this.active.delete(controller);
    }
  }

  /** 目标已没有会话：丢弃为它缓存的最新观察（含截图）和坐标预热记录。 */
  async release(target: Target): Promise<void> {
    const key = this.captureKey(target);
    this.latest.delete(key);
    this.freshCaptures.delete(key);
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
    try {
      await client.endSession({ session: this.session }, readOptions());
    } finally {
      await client.shutdown(readOptions());
      if ('uniffiDestroy' in client && typeof client.uniffiDestroy === 'function') client.uniffiDestroy();
    }
  }
}
