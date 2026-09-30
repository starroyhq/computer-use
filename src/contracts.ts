export type Mode = 'background' | 'foreground';
export type Target = {
  id: string;
  kind: 'desktop' | 'browser';
  appId: string;
  title: string;
  pid?: number;
  windowId?: number;
  url?: string;
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
  imageWidth: number;
  imageHeight: number;
  elements: Element[];
  elementsComplete?: boolean;
  screenshot: Screenshot;
  // Opaque backend state is never returned to clients.
  backendState?: unknown;
};
export type Point = { x: number; y: number };
export type Action = z.infer<typeof actionSchema>;
export type Condition = z.infer<typeof conditionSchema>;
// foreground 在配对批准时一并授予并持久化；缺失表示旧版配对，需要重新配对才能使用前台。
export type Grant = { appIds: string[]; browser: boolean; foreground?: boolean };
export type Doctor = { available: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> };
export type BackendExecution = { effect: 'confirmed' | 'unconfirmed' };
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
  observe(target: Target): Promise<BackendObservation>;
  validate(observation: BackendObservation): Promise<boolean>;
  act(
    observation: BackendObservation,
    action: Action,
    mode: Mode,
    signal: AbortSignal,
    onDispatch?: () => void,
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
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CuError';
  }
}
export function errorResult(error: unknown): { code: ErrorCode; message: string } {
  if (error instanceof CuError) return { code: error.code, message: error.message };
  // Backend exception strings may contain input text or page data. Keep them out of responses/logs.
  return { code: 'internal', message: 'Unexpected internal error; inspect local diagnostics.' };
}
export type Client = { id: string; name: string; tokenHash: string; grant: Grant };
export type HostEvent =
  | { event: 'pair_request'; clientId: string; name: string; appIds: string[]; browser: boolean; foreground: boolean }
  | { event: 'foreground_request'; sessionId: string; clientName: string; targetTitle: string }
  | { event: 'decision_finished'; requestId: string; approved: boolean }
  | { event: 'clients'; clients: Array<{ id: string; name: string }> }
  | { event: 'ready' }
  | { event: 'control_begin' | 'control_end'; pid: number }
  | { event: 'rpc_response'; id: string; result?: unknown; error?: { code: ErrorCode; message: string } }
  | { event: 'status' | 'fatal'; message: string };
export type HostCommand =
  | { command: 'pair_allow' | 'pair_deny'; clientId: string }
  | { command: 'foreground_allow' | 'foreground_deny'; sessionId: string }
  | { command: 'revoke'; clientId: string }
  | { command: 'pause' | 'resume' | 'stop' | 'http_enable' | 'http_disable' }
  | { command: 'control_ready'; pid: number };
export interface RpcService {
  call(token: string | undefined, method: string, params: unknown): Promise<unknown>;
}
import type { z } from 'zod';
import type { actionSchema, conditionSchema } from './schema.js';
