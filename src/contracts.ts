export type Mode = 'background' | 'foreground';
export type Target = {
  id: string;
  kind: 'desktop' | 'browser';
  appId: string;
  title: string;
  pid?: number;
  windowId?: number;
  url?: string;
  /** 桌面窗口不在屏幕上时的原因（列出目标时的状态）：已最小化、在别的桌面（Space），或其他原因看不见（应用被隐藏、辅助窗口等）。在屏幕上则没有这个字段。 */
  offScreen?: 'minimized' | 'other-space' | 'not-visible';
};
export type Bounds = { x: number; y: number; width: number; height: number };
export type Element = {
  id: string;
  role: string;
  label: string;
  bounds?: Bounds;
  /** 后端读到的当前值（文本框内容、滑块数值等）。后端能识别的密码类字段不带值，不进入观察或条件判断。 */
  value?: string;
  enabled?: boolean;
  selected?: boolean;
  min?: number;
  max?: number;
  /** 树深度：运行时只用它在多次观察间识别同一元素，不返回给客户端。 */
  depth?: number;
};
export type Screenshot = { mimeType: 'image/png' | 'image/jpeg'; data: string };
export type BackendObservation = {
  target: Target;
  bounds: Bounds;
  /** 截图的像素尺寸。只取元素的观察没有截图，也就没有它们。 */
  imageWidth?: number;
  imageHeight?: number;
  elements: Element[];
  elementsComplete?: boolean;
  /** 观察时窗口被前面的其他窗口完全挡住（按窗口层级和边界估算）。 */
  covered?: boolean;
  /** 窗口被完全挡住且显示网页内容：网页视图被挡住时可能不再重绘，截图可能是旧画面。 */
  screenshotMayBeStale?: boolean;
  /** 只取元素的观察（ObserveOptions.pixels 为 false）不带截图：元素没有像素位置，坐标动作不可用。 */
  screenshot?: Screenshot;
  // Opaque backend state is never returned to clients.
  backendState?: unknown;
};
/** 带截图的观察：像素尺寸、截图三者同在。 */
export type PixelObservation = BackendObservation & { imageWidth: number; imageHeight: number; screenshot: Screenshot };
export function hasPixels(observation: BackendObservation): observation is PixelObservation {
  return observation.screenshot !== undefined && observation.imageWidth !== undefined && observation.imageHeight !== undefined;
}
export type ObserveOptions = {
  /** 为 false 时只取元素，不抓取截图：更快，但这份快照不能用于坐标动作。默认 true。 */
  pixels?: boolean;
};
export type Point = { x: number; y: number };
export type Action = z.infer<typeof actionSchema>;
export type Condition = z.infer<typeof conditionSchema>;
// allApps 仅覆盖桌面应用；缺失时沿用旧配对的 appIds，不能自动扩权。
// foreground 在配对或本机升级授权时授予；缺失表示旧版配对，不能自行扩权。
export type Grant = { appIds: string[]; allApps?: boolean; browser: boolean; foreground?: boolean };
export type Authorization = Required<Grant>;
export type GrantOperation = {
  command: 'grant_all_apps';
  requestId: string;
  clientId: string;
  ok: boolean;
  error?: { code: ErrorCode; message: string };
};
export type Doctor = { available: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> };
/**
 * 动作已派发、但有需要 Agent 知道的情况。只用固定代码和固定文案，不含输入内容或界面文字。
 * - readback_mismatch：网页输入框（如终端）每次输入后自行清空，读回对不上；文字通常已完整送达。
 * - partial_input：分段输入中途停下，progress 给出已完整送达的字符数。
 */
export type ExecutionWarning = {
  code: 'readback_mismatch' | 'partial_input';
  message: string;
};
export type BackendExecution = {
  effect: 'confirmed' | 'unconfirmed';
  warning?: ExecutionWarning;
  /** 分段输入中途停下时：已完整送达的前缀字符数（按 Unicode 码位）和总字符数。 */
  progress?: { delivered: number; total: number };
};
/** 派发时的执行条件。budgetMs：距离动作时限还剩的毫秒数，后端可据此在分段之间提前停下。 */
export type ActContext = { budgetMs?: number };
/** 文字识别结果的一行；bounds 是截图像素坐标，与该快照的坐标空间一致。 */
export type TextLine = { text: string; bounds: Bounds };
export interface Backend {
  readonly kind: 'desktop' | 'browser';
  /**
   * 为 true 时，后端保证在即将发出输入的同一时刻调用 act 的 onDispatch，且此前已检查 signal。
   * 运行时据此区分“尚未派发”（超时或取消都不会送达输入）和“可能已送达”。
   * 未声明时运行时保守处理：一旦调用 act 就视为可能已派发。
   */
  readonly reportsDispatch?: boolean;
  /**
   * 为 true 时，被中断或结果不确定的动作不会在该后端之外留下仍在进行的输入（例如隔离浏览器页面），
   * 运行时只把记录标为 unknown，不停止整个运行时。未声明时按原生手势处理：停止运行时。
   */
  readonly interruptionContained?: boolean;
  doctor(): Promise<Doctor>;
  targets(grant: Grant): Promise<Target[]>;
  observe(target: Target, options?: ObserveOptions): Promise<BackendObservation>;
  validate(observation: BackendObservation): Promise<boolean>;
  /**
   * 派发前估算动作大约要多少毫秒；只对已知很慢的动作（例如网页内容和前台的逐键输入）返回数值。
   * 运行时据此在入队前拒绝注定超时的动作，避免输入到一半被时限截断。
   */
  estimateMs?(observation: BackendObservation, action: Action, mode: Mode): number | undefined;
  act(
    observation: BackendObservation,
    action: Action,
    mode: Mode,
    signal: AbortSignal,
    onDispatch?: () => void,
    context?: ActContext,
  ): Promise<BackendExecution | undefined>;
  /** 该目标已没有任何会话时调用：释放后端为它缓存的截图、元素句柄等。 */
  release?(target: Target): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}
export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'permission_denied'
  | 'not_found'
  | 'background_unavailable'
  | 'unavailable'
  | 'stale_snapshot'
  | 'busy'
  | 'cancelled'
  | 'timeout'
  | 'paused'
  | 'unknown_outcome'
  | 'internal';
export class CuError extends Error {
  /**
   * 仅对 unknown_outcome 有意义：为 true 表示驱动调用已经返回，没有仍在进行的输入，
   * 只是无法判断它的效果。运行时记为 unknown，但不必停机；中断或连接丢失时为 false。
   */
  readonly settled: boolean;
  constructor(
    public readonly code: ErrorCode,
    message: string,
    options: { settled?: boolean } = {},
  ) {
    super(message);
    this.name = 'CuError';
    this.settled = options.settled === true;
  }
}
export function errorResult(error: unknown): { code: ErrorCode; message: string } {
  if (error instanceof CuError) return { code: error.code, message: error.message };
  // Backend exception strings may contain input text or page data. Keep them out of responses/logs.
  return { code: 'internal', message: 'Unexpected internal error; inspect local diagnostics.' };
}
export type Client = { id: string; name: string; tokenHash: string; grant: Grant };
export type HostEvent =
  | { event: 'pair_request'; clientId: string; name: string; appIds: string[]; allApps?: boolean; browser: boolean; foreground: boolean }
  | { event: 'foreground_request'; sessionId: string; clientName: string; targetTitle: string }
  | { event: 'decision_finished'; requestId: string; approved: boolean }
  // 宿主的客户端列表：授权范围只用于展示，不含凭据。
  | {
      event: 'clients';
      clients: Array<{ id: string; name: string; appIds: string[]; allApps?: boolean; browser: boolean; foreground: boolean }>;
      operation?: GrantOperation;
    }
  | { event: 'ready' }
  | { event: 'control_begin' | 'control_end'; pid: number }
  | { event: 'rpc_response'; id: string; result?: unknown; error?: { code: ErrorCode; message: string } }
  | { event: 'status' | 'fatal'; message: string };
export type HostCommand =
  | { command: 'pair_allow' | 'pair_deny'; clientId: string; allApps?: boolean | undefined }
  | { command: 'foreground_allow' | 'foreground_deny'; sessionId: string }
  | { command: 'revoke'; clientId: string }
  | { command: 'grant_all_apps'; clientId: string; requestId: string }
  | { command: 'pause' | 'resume' | 'stop' | 'http_enable' | 'http_disable' }
  | { command: 'control_ready'; pid: number };
export interface RpcService {
  call(token: string | undefined, method: string, params: unknown): Promise<unknown>;
}
import type { z } from 'zod';
import type { actionSchema, conditionSchema } from './schema.js';
