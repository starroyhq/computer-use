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
export type Element = { id: string; role: string; label: string; bounds?: Bounds };
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
  doctor(): Promise<Doctor>;
  targets(grant: Grant): Promise<Target[]>;
  observe(target: Target): Promise<BackendObservation>;
  validate(observation: BackendObservation): Promise<boolean>;
  act(observation: BackendObservation, action: Action, mode: Mode, signal: AbortSignal): Promise<BackendExecution | undefined>;
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
  | { event: 'rpc_response'; id: string; result?: unknown; error?: { code: ErrorCode; message: string } }
  | { event: 'status' | 'fatal'; message: string };
export type HostCommand =
  | { command: 'pair_allow' | 'pair_deny'; clientId: string }
  | { command: 'foreground_allow' | 'foreground_deny'; sessionId: string }
  | { command: 'revoke'; clientId: string }
  | { command: 'pause' | 'resume' | 'stop' | 'http_enable' | 'http_disable' };
export interface RpcService {
  call(token: string | undefined, method: string, params: unknown): Promise<unknown>;
}
import type { z } from 'zod';
import type { actionSchema, conditionSchema } from './schema.js';
