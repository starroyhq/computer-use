import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CuError,
  errorResult,
  hasPixels,
  type Backend,
  type Authorization,
  type BackendObservation,
  type Bounds,
  type Client,
  type Condition,
  type Element,
  type HostCommand,
  type HostEvent,
  type GrantOperation,
  type Mode,
  type RpcService,
  type Screenshot,
  type Target,
  type TextLine,
} from './contracts.js';
import { descriptions, pairSchema, schemas, type Method } from './schema.js';
import { ActionStore, ClientStore, hash, privateDirectory, type ActionRecord } from './storage.js';
import { canonicalAppId } from './app-identity.js';

type Session = {
  id: string;
  clientId: string;
  target: Target;
  mode: Mode;
  exclusive: boolean;
  expiresAt: number;
  // 最近一次发布的元素表：用于在多次观察间沿用元素 id，并计算增量。
  view?: ElementView;
};
// elementIds：公开元素 id → 后端元素 id。后端 id 不返回给客户端。
// pixels：这份快照是否带截图。只取元素的快照（elementsOnly）不能用于坐标动作。
type Snapshot = {
  id: string;
  sessionId: string;
  createdAt: number;
  observation: BackendObservation;
  elementIds: Map<string, string>;
  pixels: boolean;
};
// key 是元素身份（角色、标签、深度、取整后的位置），state 是其值与状态的摘要。
type ViewEntry = { key: string; state: string; id: string };
// shown：这次发布是否把元素返回给了客户端。只有客户端见过的元素表才能作为增量的基准。
type ElementView = { snapshotId: string; shown: boolean; entries: ViewEntry[] };
type PublishOptions = { screenshot: boolean; elements: boolean; elementsOnly?: boolean; text?: boolean; since?: string | undefined };
// observe 与 act.observe 的原始参数；screenshot 缺省时由 elementsOnly 决定。
type ObserveRequest = {
  screenshot?: boolean | undefined;
  elements: boolean;
  elementsOnly: boolean;
  text?: boolean | undefined;
  since?: string | undefined;
};
// 快照被移除的原因，只用于给出更明确的错误信息；按会话记录，不向其他会话透露。
type RetireReason = 'replaced' | 'consumed' | 'expired' | 'closed';
type Retired = { reason: RetireReason; sessionId: string; at: number };
type PendingGrant = { clientId: string; resolve: (approved: boolean) => void };
// waitFor 的结果：满足条件的那次观察，以及（文字条件时）从它识别出的文字。
type Found = { observation: BackendObservation; text?: TextLine[] | undefined };
type PublicElement = {
  id: string;
  role: string;
  label: string;
  bounds?: Bounds;
  value?: string;
  valueLength?: number;
  enabled?: false;
  selected?: true;
  min?: number;
  max?: number;
};
type PendingPair = { client: Client; resolve: (allow: boolean) => void };
type PublicTextLine = { text: string; bounds: Bounds };
type Work = {
  controller: AbortController;
  sessionId: string;
  // 输入可能已经送达：此时中断无法证明手势已停止。
  started: boolean;
  // 后端声明中断不会在其外部留下进行中的输入，不确定结果无需停止整个运行时。
  contained: boolean;
  promise: Promise<unknown>;
  admitted: Promise<void>;
};
const SESSION_TTL = 120_000;
const SNAPSHOT_TTL = 30_000;
// 传输层约 65 秒超时：排队准入 15 秒 + 校验 10 秒 + 派发与验证共用 timeoutMs（最多 30 秒）
// + 已发出输入的完成宽限 5 秒，合计不超过 60 秒。
const QUEUE_ADMISSION_MS = 15_000;
const VALIDATE_MS = 10_000;
const DISPATCH_GRACE_MS = 5_000;
const REAP_INTERVAL_MS = 30_000;
// 宿主马上回执；没有回执时会话仍然打开，避免标记失败挡住操作。
const CONTROL_ACK_MS = 2_000;
const OBSERVE_MS = 30_000;
// act 连同动作后观察的整体响应上限，低于传输层约 65 秒的超时。剩余时间不足时不再观察。
const ACT_RESPONSE_MS = 60_000;
const MIN_OBSERVE_MS = 1_000;
// 观察结果中单个元素值的长度上限；条件判断仍使用后端读到的完整值。
const VALUE_LIMIT = 2_000;
const FULL: PublishOptions = { screenshot: true, elements: true };
// 文字识别结果最多返回的行数和总字符数；超出部分不返回，结果标明 textTruncated。
const TEXT_LINE_LIMIT = 1_000;
const TEXT_CHAR_LIMIT = 20_000;
// 已移除快照的原因只保留有限的数量和时长。
const RETIRED_LIMIT = 256;
const RETIRED_MS = 10 * 60_000;
// 文字条件每轮要截图并识别，轮询间隔放宽，避免持续占用 CPU。
const TEXT_POLL_MS = 500;
const GRANT_REQUEST_FEATURE = 'grant_request';

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // 不把代理对拆成半个字符。
  const last = text.charCodeAt(limit - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

// 把 observe 与 act.observe 的参数换算成发布选项。elementsOnly 不抓取截图，不能再要求返回截图或省略元素。
function publishOptions(request: ObserveRequest): PublishOptions {
  if (request.elementsOnly && (request.screenshot === true || !request.elements))
    throw new CuError(
      'invalid_request',
      'elementsOnly returns elements without a screenshot; do not combine it with screenshot: true or elements: false.',
    );
  if (request.elementsOnly && request.text)
    throw new CuError('invalid_request', 'Text recognition reads the screenshot; do not combine text with elementsOnly.');
  return {
    screenshot: request.screenshot ?? !request.elementsOnly,
    elements: request.elements,
    ...(request.elementsOnly ? { elementsOnly: true } : {}),
    ...(request.text ? { text: true } : {}),
    ...(request.since !== undefined ? { since: request.since } : {}),
  };
}

// 返回给客户端的元素：位置取整；只在与默认不同时给出 enabled/selected；与非空标签重复的值不再重复。
// 空值照常给出：它说明文本框是空的，而没有 value 只说明后端读不到。
// 没有截图的快照里像素位置没有意义，不给出位置。
function publicElement(element: Element, pixels: boolean): Omit<PublicElement, 'id'> {
  const published: Omit<PublicElement, 'id'> = { role: element.role, label: element.label };
  const { value } = element;
  if (value !== undefined && (value === '' || value !== element.label)) {
    published.value = truncate(value, VALUE_LIMIT);
    if (published.value.length < value.length) published.valueLength = value.length;
  }
  if (element.enabled === false) published.enabled = false;
  if (element.selected === true) published.selected = true;
  if (element.min !== undefined && element.max !== undefined) {
    published.min = element.min;
    published.max = element.max;
  }
  if (pixels && element.bounds) {
    const { x, y, width, height } = element.bounds;
    published.bounds = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  }
  return published;
}

// 不同平台的文本控件换行符不同，条件比较时统一成 \n。
const newlines = (text: string) => text.replace(/\r\n?/g, '\n');
// 文字识别会多出或漏掉空格、在换行处断开，还会把半角标点认成全角、把连字符认成破折号：
// 文字条件比较时去掉全部空白，并统一字符宽度、横线和引号。
const recognizable = (text: string) =>
  text
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201C\u201D]/gu, '"')
    .replace(/\s+/gu, '');

// 识别出的文字行按上限截断，位置取整。
function publicText(lines: TextLine[]): { text: PublicTextLine[]; truncated: boolean } {
  const text: PublicTextLine[] = [];
  let characters = 0;
  for (const line of lines) {
    if (text.length >= TEXT_LINE_LIMIT || characters + line.text.length > TEXT_CHAR_LIMIT) return { text, truncated: true };
    characters += line.text.length;
    const { x, y, width, height } = line.bounds;
    text.push({ text: line.text, bounds: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) } });
  }
  return { text, truncated: false };
}

async function bounded<T>(operation: Promise<T>, milliseconds: number, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new CuError('cancelled', 'Operation cancelled.'));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => reject(new CuError('timeout', 'Operation exceeded its deadline.')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

export class Runtime implements RpcService {
  readonly clients: ClientStore;
  readonly actions: ActionStore;
  private readonly sessions = new Map<string, Session>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly pairs = new Map<string, PendingPair>();
  private readonly work = new Map<string, Work>();
  private readonly controlCounts = new Map<number, number>();
  private readonly controlReady = new Map<number, () => void>();
  private readonly retired = new Map<string, Retired>();
  private readonly grantRequests = new Map<string, PendingGrant>();
  // 宿主声明支持的新功能；旧宿主不声明，相应事件就不发出。
  private hostFeatures = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  // 公开元素 id 的全局序号：同一会话内沿用，不同会话之间不会重复。
  private elementSequence = 0;
  private paused = false;
  private stopped = false;
  private reaper: NodeJS.Timeout | undefined;
  constructor(
    private readonly options: {
      dataDir: string;
      backends: Backend[];
      emit: (event: HostEvent) => void;
      now?: () => number;
      platform?: NodeJS.Platform;
      // 仅供测试缩短：输入已发出后，超过 timeoutMs 仍允许其完成的时长。
      dispatchGraceMs?: number;
      // 从截图识别文字（本机系统能力，由宿主进程提供）；没有时文字相关功能报告不可用。
      recognizeText?: (image: Screenshot, signal?: AbortSignal) => Promise<TextLine[]>;
    },
  ) {
    this.clients = new ClientStore(join(options.dataDir, 'clients.json'));
    this.actions = new ActionStore(options.dataDir, () => this.now());
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }
  private controlPid(target: Target): number | undefined {
    if (this.platform() !== 'darwin' || target.kind !== 'desktop') return undefined;
    const pid = target.pid;
    if (!pid || !Number.isInteger(pid) || pid <= 0) return undefined;
    return pid;
  }
  private async acquireControl(target: Target): Promise<void> {
    const pid = this.controlPid(target);
    if (pid === undefined) return;
    const next = (this.controlCounts.get(pid) ?? 0) + 1;
    this.controlCounts.set(pid, next);
    if (next > 1) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.controlReady.delete(pid);
        resolve();
      }, CONTROL_ACK_MS);
      this.controlReady.set(pid, () => {
        clearTimeout(timer);
        this.controlReady.delete(pid);
        resolve();
      });
      this.options.emit({ event: 'control_begin', pid });
    });
  }
  private releaseControl(target: Target): void {
    const pid = this.controlPid(target);
    if (pid === undefined) return;
    const count = this.controlCounts.get(pid);
    if (!count) return;
    if (count > 1) {
      this.controlCounts.set(pid, count - 1);
      return;
    }
    this.controlCounts.delete(pid);
    this.controlReady.get(pid)?.();
    this.options.emit({ event: 'control_end', pid });
  }
  async start(): Promise<void> {
    await privateDirectory(this.options.dataDir);
    await this.clients.load();
    await this.actions.load();
    this.emitClients();
    this.reaper = setInterval(() => this.reap(), REAP_INTERVAL_MS);
    this.reaper.unref();
  }
  // 过期会话和快照原本只在被访问时清理；定时回收避免长期运行时持有截图和执行租约。
  private reap(): void {
    const now = this.now();
    for (const [id, session] of this.sessions)
      if (session.expiresAt < now && ![...this.work.values()].some(w => w.sessionId === id)) this.removeSession(id);
    for (const [id, snapshot] of this.snapshots)
      if (now - snapshot.createdAt > SNAPSHOT_TTL) {
        this.snapshots.delete(id);
        this.retire(id, snapshot.sessionId, 'expired');
      }
    for (const [id, retired] of this.retired) if (now - retired.at > RETIRED_MS) this.retired.delete(id);
  }
  private retire(id: string, sessionId: string, reason: RetireReason): void {
    this.retired.delete(id);
    this.retired.set(id, { reason, sessionId, at: this.now() });
    if (this.retired.size > RETIRED_LIMIT) {
      const oldest = this.retired.keys().next().value;
      if (oldest !== undefined) this.retired.delete(oldest);
    }
  }
  // 说明快照为什么不能用；其他会话的快照一律按未知处理，不透露它是否存在。
  private staleSnapshot(id: string, snapshot: Snapshot | undefined, sessionId: string): CuError {
    if (snapshot?.sessionId === sessionId)
      return new CuError('stale_snapshot', 'This snapshot expired after 30 seconds; observe again before acting.');
    const retired = snapshot ? undefined : this.retired.get(id);
    if (retired?.sessionId === sessionId && this.now() - retired.at <= RETIRED_MS) {
      const messages: Record<RetireReason, string> = {
        replaced: 'A newer observation in this session replaced this snapshot; act on the latest snapshotId or observe again.',
        consumed: 'An earlier action already used this snapshot; observe again, or pass observe to act, before the next action.',
        expired: 'This snapshot expired after 30 seconds; observe again before acting.',
        closed: 'The session that owned this snapshot was closed; open a session and observe again.',
      };
      return new CuError('stale_snapshot', messages[retired.reason]);
    }
    return new CuError('stale_snapshot', 'Unknown snapshot; observe this target again before acting.');
  }
  private authorization(client: Client): Authorization {
    return {
      appIds: [...client.grant.appIds],
      allApps: client.grant.allApps === true,
      browser: client.grant.browser,
      foreground: client.grant.foreground === true,
    };
  }
  private emitClients(operation?: GrantOperation): void {
    this.options.emit({
      event: 'clients',
      ...(operation ? { operation } : {}),
      clients: [...this.clients.clients.values()].map(({ id, name, grant }) => ({
        id,
        name,
        appIds: [...grant.appIds],
        allApps: grant.allApps === true,
        browser: grant.browser,
        foreground: grant.foreground === true,
      })),
    });
  }
  authenticate(token: string | undefined): Client {
    return this.clients.authenticate(token);
  }
  private backend(kind: Target['kind']): Backend {
    const backend = this.options.backends.find(b => b.kind === kind);
    if (!backend) throw new CuError('unavailable', 'The requested backend is unavailable.');
    return backend;
  }
  private checkRunning(): void {
    if (this.stopped) throw new CuError('unavailable', 'Runtime stopped; restart it from the local app.');
    if (this.paused) throw new CuError('paused', 'Execution is paused in the local app.');
  }
  private getSession(client: Client, id: string): Session {
    const session = this.sessions.get(id);
    if (!session || session.clientId !== client.id) throw new CuError('not_found', 'Session not found.');
    if (session.expiresAt < this.now() && ![...this.work.values()].some(w => w.sessionId === id && w.started)) {
      this.removeSession(id);
      throw new CuError('not_found', 'Session expired; open a new session and observe again.');
    }
    session.expiresAt = this.now() + SESSION_TTL;
    return session;
  }
  private checkLease(session: Session): void {
    for (const other of this.sessions.values()) {
      if (
        other.id !== session.id &&
        other.exclusive &&
        (other.expiresAt >= this.now() || [...this.work.values()].some(w => w.sessionId === other.id && w.started))
      ) {
        throw new CuError('busy', 'Another session holds the desktop execution lease.');
      }
    }
  }
  private removeSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.releaseControl(session.target);
    for (const [key, value] of this.snapshots)
      if (value.sessionId === id) {
        this.snapshots.delete(key);
        this.retire(key, id, 'closed');
      }
    for (const [requestId, work] of this.work)
      if (work.sessionId === id) {
        work.controller.abort();
        if (work.started && !work.contained)
          this.haltUncertainInput(`Active action ${requestId} was interrupted; restart the runtime and inspect the target.`);
      }
    this.releaseTarget(session.target);
  }
  // 同一目标不再有任何会话时，让后端释放它缓存的截图和元素句柄。
  private releaseTarget(target: Target): void {
    if ([...this.sessions.values()].some(other => other.target.id === target.id)) return;
    const backend = this.options.backends.find(b => b.kind === target.kind);
    void backend?.release?.(target).catch(() => {});
  }
  async control(command: HostCommand): Promise<void> {
    switch (command.command) {
      case 'pair_allow':
      case 'pair_deny': {
        const pair = this.pairs.get(command.clientId);
        // 旧宿主不认识 allApps，可能把空应用列表显示为“无”。只有明确展示并确认过此范围的宿主才能批准。
        pair?.resolve(command.command === 'pair_allow' && (pair.client.grant.allApps !== true || command.allApps === true));
        break;
      }
      case 'foreground_allow':
      case 'foreground_deny':
        break; // 前台权限已在配对时授予；保留命令以兼容旧宿主。
      case 'grant_all_apps': {
        // 宿主对 Agent 发起的请求也用这条命令批准；requestId 不对应待处理请求时就是客户端页的按钮。
        const pending = this.grantRequests.get(command.requestId);
        const answer = pending?.clientId === command.clientId ? pending : undefined;
        try {
          await this.clients.grantAllApps(command.clientId, () => !this.stopped);
          this.emitClients({ command: 'grant_all_apps', clientId: command.clientId, requestId: command.requestId, ok: true });
          answer?.resolve(true);
        } catch (error) {
          this.emitClients({
            command: 'grant_all_apps',
            clientId: command.clientId,
            requestId: command.requestId,
            ok: false,
            error: errorResult(error),
          });
          answer?.resolve(false);
        }
        break;
      }
      case 'grant_deny': {
        const pending = this.grantRequests.get(command.requestId);
        if (pending?.clientId === command.clientId) pending.resolve(false);
        break;
      }
      case 'host_features':
        this.hostFeatures = new Set(command.features);
        break;
      case 'pause':
        this.paused = true;
        break;
      case 'resume':
        if (!this.stopped) this.paused = false;
        break;
      case 'stop':
        this.stopped = true;
        this.paused = true;
        for (const pair of this.pairs.values()) pair.resolve(false);
        for (const request of this.grantRequests.values()) request.resolve(false);
        for (const item of this.work.values()) item.controller.abort();
        for (const id of this.sessions.keys()) this.removeSession(id);
        await Promise.allSettled(this.options.backends.map(b => b.cancel()));
        break;
      case 'revoke': {
        const saved = this.clients.revoke(command.clientId);
        for (const request of this.grantRequests.values()) if (request.clientId === command.clientId) request.resolve(false);
        for (const session of this.sessions.values()) if (session.clientId === command.clientId) this.removeSession(session.id);
        await saved;
        this.emitClients();
        break;
      }
      case 'http_enable':
      case 'http_disable':
        break; // The host transport owns the listener.
      case 'control_ready':
        this.controlReady.get(command.pid)?.();
        break;
    }
  }
  private haltUncertainInput(message: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.paused = true;
    for (const item of this.work.values()) item.controller.abort();
    this.options.emit({ event: 'fatal', message });
  }
  private async requestDecision(register: (resolve: (value: boolean) => void) => void, cleanup: () => void): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), 60_000);
        register(resolve);
      });
    } finally {
      clearTimeout(timer);
      cleanup();
    }
  }
  private async pair(params: unknown): Promise<unknown> {
    const parsed = pairSchema.safeParse(params);
    if (!parsed.success) throw new CuError('invalid_request', 'Provide a client name and a valid application/browser scope.');
    if (this.stopped) throw new CuError('unavailable', 'Runtime stopped.');
    if (this.pairs.size >= 3) throw new CuError('busy', 'Too many pending pairing requests.');
    const token = randomBytes(32).toString('base64url');
    const client: Client = {
      id: randomUUID(),
      name: parsed.data.name,
      tokenHash: hash(token),
      grant: {
        appIds: [...new Set(parsed.data.appIds.map(id => canonicalAppId(id, this.options.platform)))],
        allApps: parsed.data.allApps ?? (parsed.data.appIds.length === 0 && !parsed.data.browser),
        browser: parsed.data.browser,
        foreground: true,
      },
    };
    let granted = false;
    try {
      const approved = await this.requestDecision(
        resolve => {
          this.pairs.set(client.id, { client, resolve });
          this.options.emit({
            event: 'pair_request',
            clientId: client.id,
            name: client.name,
            appIds: client.grant.appIds,
            allApps: client.grant.allApps === true,
            browser: client.grant.browser,
            foreground: true,
          });
        },
        () => this.pairs.delete(client.id),
      );
      if (!approved || this.stopped) throw new CuError('permission_denied', 'Pairing was denied or expired.');
      await this.clients.add(client, () => !this.stopped);
      this.emitClients();
      granted = true;
      return { clientId: client.id, token };
    } finally {
      this.options.emit({ event: 'decision_finished', requestId: client.id, approved: granted });
    }
  }
  private async listTargets(client: Client): Promise<Target[]> {
    const results = await bounded(Promise.all(this.options.backends.map(b => b.targets(client.grant))), 25_000);
    if (!this.clients.clients.has(client.id)) throw new CuError('unauthorized', 'Client revoked.');
    // This check remains in the runtime even if a backend filters incorrectly.
    return results
      .flat()
      .filter(t => (t.kind === 'browser' ? client.grant.browser : client.grant.allApps === true || client.grant.appIds.includes(t.appId)));
  }
  private async openSession(client: Client, params: unknown): Promise<unknown> {
    this.checkRunning();
    const p = schemas.session_open.parse(params);
    const target = (await this.listTargets(client)).find(t => t.id === p.targetId);
    this.checkRunning();
    if (!target) throw new CuError('not_found', 'Authorized target not found.');
    // 前台权限只在配对时由用户批准一次并持久化，会话级不再弹窗。
    if (p.mode === 'foreground' && client.grant.foreground !== true)
      throw new CuError(
        'permission_denied',
        'This client does not have foreground access. Call request_all_apps to ask the user, or have them choose Allow all apps for this client on the Clients page; keep the existing profile.',
      );
    const session: Session = {
      id: randomUUID(),
      clientId: client.id,
      target,
      mode: p.mode,
      exclusive: p.exclusive,
      expiresAt: this.now() + SESSION_TTL,
    };
    const admit = () => {
      this.checkLease(session);
      if (session.exclusive && this.work.size > 0)
        throw new CuError('busy', 'Wait for pending actions before acquiring an exclusive session.');
    };
    admit();
    await this.acquireControl(session.target);
    // 等待宿主回执期间，可能有其他会话登记、客户端被撤销或运行时停止；登记前同步复核。
    try {
      this.checkRunning();
      if (!this.clients.clients.has(client.id)) throw new CuError('unauthorized', 'Client revoked.');
      admit();
    } catch (error) {
      this.releaseControl(session.target);
      throw error;
    }
    this.sessions.set(session.id, session);
    return { sessionId: session.id, target, mode: session.mode, exclusive: session.exclusive, expiresAt: session.expiresAt };
  }
  // 只取元素时才传选项：后端默认带截图，完整观察的调用方式保持不变。
  private observeBackend(session: Session, elementsOnly: boolean): Promise<BackendObservation> {
    const backend = this.backend(session.target.kind);
    return elementsOnly ? backend.observe(session.target, { pixels: false }) : backend.observe(session.target);
  }
  private requireTextRecognition(): void {
    if (!this.options.recognizeText)
      throw new CuError('unavailable', 'Text recognition is not available in this installation; read the screenshot instead.');
  }
  // 识别截图上的文字。没有截图的快照（elementsOnly）不能识别。
  private async recognize(observation: BackendObservation, signal?: AbortSignal): Promise<TextLine[]> {
    this.requireTextRecognition();
    if (!hasPixels(observation)) throw new CuError('invalid_request', 'Text recognition needs a snapshot with a screenshot.');
    return this.options.recognizeText!(observation.screenshot, signal);
  }
  private async observe(session: Session, options: PublishOptions = FULL, milliseconds = OBSERVE_MS): Promise<Record<string, unknown>> {
    if (options.text) this.requireTextRecognition();
    const started = this.now();
    const observation = await bounded(this.observeBackend(session, options.elementsOnly === true), milliseconds);
    try {
      const text = options.text
        ? await bounded(this.recognize(observation), Math.max(MIN_OBSERVE_MS, milliseconds - (this.now() - started)))
        : undefined;
      return this.publishObservation(session, observation, options, text);
    } catch (error) {
      // 会话在观察期间被关闭时，后端刚缓存的截图不会再有人使用。
      if (!this.sessions.has(session.id)) this.releaseTarget(session.target);
      throw error;
    }
  }
  private publishObservation(
    session: Session,
    observation: BackendObservation,
    options: PublishOptions = FULL,
    text?: TextLine[],
  ): Record<string, unknown> {
    const client = this.clients.clients.get(session.clientId);
    if (!client) throw new CuError('unauthorized', 'Client revoked during observation.');
    this.getSession(client, session.id);
    // Keep one snapshot per session to bound memory and make stale references explicit.
    for (const [id, snap] of this.snapshots)
      if (snap.sessionId === session.id) {
        this.snapshots.delete(id);
        this.retire(id, session.id, 'replaced');
      }
    // 后端没按要求给出截图时同样视为没有像素，而不是把残缺的几何交给客户端。
    const pixels = options.elementsOnly !== true && hasPixels(observation);
    const snapshot: Snapshot = {
      id: randomUUID(),
      sessionId: session.id,
      createdAt: this.now(),
      observation,
      elementIds: new Map(),
      pixels,
    };
    // 与上一次发布的元素表按身份逐个匹配：身份相同的元素沿用 id；值或状态不同则算作变化。
    // 同一身份出现多次时按出现顺序配对。
    const previous = session.view;
    const unmatched = new Map<string, ViewEntry[]>();
    for (const entry of previous?.entries ?? []) {
      const same = unmatched.get(entry.key);
      if (same) same.push(entry);
      else unmatched.set(entry.key, [entry]);
    }
    const entries: ViewEntry[] = [];
    const elements: PublicElement[] = [];
    const changed: PublicElement[] = [];
    for (const element of observation.elements) {
      const published = publicElement(element, pixels);
      const key = JSON.stringify([element.role, element.label, element.depth ?? null, published.bounds ?? null]);
      const state = hash(
        JSON.stringify([
          element.value ?? null,
          element.enabled ?? null,
          element.selected ?? null,
          element.min ?? null,
          element.max ?? null,
        ]),
      );
      const reused = unmatched.get(key)?.shift();
      const id = reused?.id ?? `e${++this.elementSequence}`;
      entries.push({ key, state, id });
      snapshot.elementIds.set(id, element.id);
      const item: PublicElement = { id, ...published };
      elements.push(item);
      if (!reused || reused.state !== state) changed.push(item);
    }
    session.view = { snapshotId: snapshot.id, shown: options.elements, entries };
    this.snapshots.set(snapshot.id, snapshot);
    const { backendState: _, screenshot, elements: __, imageWidth, imageHeight, ...geometry } = observation;
    const result: Record<string, unknown> = { snapshotId: snapshot.id, capturedAt: snapshot.createdAt, ...geometry };
    // 没有截图的快照既没有图像，也没有像素尺寸；客户端据此知道不能用坐标。
    if (pixels) {
      result.imageWidth = imageWidth;
      result.imageHeight = imageHeight;
      if (options.screenshot) result.screenshot = screenshot;
    }
    if (options.elements) {
      const unchanged = elements.length - changed.length;
      // 没有任何元素沿用时（例如页面整体跳转），增量不会比完整列表小，直接给完整列表。
      if (options.since !== undefined && previous?.shown && previous.snapshotId === options.since && unchanged > 0) {
        const removed = [...unmatched.values()].flat().map(entry => entry.id);
        result.changes = { since: options.since, unchanged, removed };
        result.elements = changed;
      } else result.elements = elements;
    }
    if (text) {
      const published = publicText(text);
      result.text = published.text;
      if (published.truncated) result.textTruncated = true;
    }
    return result;
  }
  private satisfies(observation: BackendObservation, condition: Condition, text?: TextLine[]): boolean {
    if (condition.type === 'title') return observation.target.title.includes(condition.includes);
    if (condition.type === 'text') {
      if (!text) throw new CuError('unavailable', 'Text recognition is not available in this installation.');
      return recognizable(text.map(line => line.text).join('\n')).includes(recognizable(condition.includes));
    }
    if (!condition.present && !observation.elementsComplete)
      throw new CuError('unavailable', 'This backend returns a partial element tree and cannot verify element absence.');
    // 后端没有报告的值或状态一律不满足条件。
    const matches = (element: Element) =>
      (condition.label === undefined || element.label === condition.label) &&
      (!condition.role || element.role === condition.role) &&
      (condition.value === undefined || (element.value !== undefined && newlines(element.value) === newlines(condition.value))) &&
      (condition.valueIncludes === undefined ||
        (element.value !== undefined && newlines(element.value).includes(newlines(condition.valueIncludes)))) &&
      (condition.enabled === undefined || element.enabled === condition.enabled) &&
      (condition.selected === undefined || element.selected === condition.selected);
    return observation.elements.some(matches) === condition.present;
  }
  // pixels 为 false 时每次轮询只取元素，不抓截图；条件只看元素和标题，用不到图像。
  // 满足条件的那次观察会原样交给调用方，所以后续要用到像素的调用方必须让轮询带截图。
  // 文字条件要识别截图，所以总是带截图轮询。
  private async waitFor(session: Session, condition: Condition, timeout: number, signal?: AbortSignal, pixels = true): Promise<Found> {
    const reading = condition.type === 'text';
    if (reading) this.requireTextRecognition();
    const deadline = this.now() + timeout;
    let covered = false;
    do {
      if (signal?.aborted || !this.sessions.has(session.id) || this.stopped) throw new CuError('cancelled', 'Wait cancelled.');
      try {
        const observed = await bounded(this.observeBackend(session, !(pixels || reading)), Math.max(1, deadline - this.now()), signal);
        if (signal?.aborted || !this.sessions.has(session.id) || this.stopped) throw new CuError('cancelled', 'Wait cancelled.');
        covered ||= observed.screenshotMayBeStale === true;
        const text = reading ? await bounded(this.recognize(observed, signal), Math.max(1, deadline - this.now()), signal) : undefined;
        if (this.satisfies(observed, condition, text)) return { observation: observed, text };
      } catch (error) {
        // A changing page is an expected waiting state, not a reason to retry input.
        if (!(error instanceof CuError) || error.code !== 'stale_snapshot') {
          if (error instanceof CuError && error.code === 'timeout' && reading && covered) break;
          throw error;
        }
      }
      try {
        await delay(Math.min(reading ? TEXT_POLL_MS : 150, Math.max(1, deadline - this.now())), undefined, signal ? { signal } : {});
      } catch {
        // 只有 signal 中止会让 delay 拒绝；统一报告为取消，而不是内部错误。
        throw new CuError('cancelled', 'Wait cancelled.');
      }
    } while (this.now() < deadline);
    // 被完全挡住的网页窗口可能不再重绘：截图一直不变时文字条件永远等不到。
    if (covered)
      throw new CuError(
        'timeout',
        'The requested text did not appear. The window was covered by other windows and shows web content, so its screenshots may not have updated; ask the user to keep it visible.',
      );
    throw new CuError('timeout', 'The requested observable condition was not satisfied.');
  }
  private async act(client: Client, params: unknown): Promise<unknown> {
    const startedAt = this.now();
    const p = schemas.act.parse(params);
    // observe 只决定结果里附带什么，不属于动作参数：带或不带它重试同一请求都算同一动作。
    const { observe: _, ...identity } = p;
    const fingerprint = hash(JSON.stringify(identity));
    const existing = this.actions.records.get(p.requestId);
    if (existing) {
      if (existing.clientId !== client.id) throw new CuError('not_found', 'Request not found.');
      if (existing.fingerprint !== fingerprint) throw new CuError('invalid_request', 'requestId already belongs to different arguments.');
      await this.work.get(p.requestId)?.admitted;
      return this.publicRecord(existing);
    }
    // 附带观察的参数在派发前校验：动作发出之后才发现参数冲突就晚了。
    const followUp: PublishOptions | undefined = p.observe && {
      ...publishOptions(p.observe),
      ...(p.observe.changes ? { since: p.snapshotId } : {}),
    };
    this.checkRunning();
    const session = this.getSession(client, p.sessionId);
    this.checkLease(session);
    if (this.work.size >= 32) throw new CuError('busy', 'Action queue is full.');
    const snapshot = this.snapshots.get(p.snapshotId);
    if (!snapshot || snapshot.sessionId !== session.id || this.now() - snapshot.createdAt > SNAPSHOT_TTL)
      throw this.staleSnapshot(p.snapshotId, snapshot, session.id);
    if (p.verify?.type === 'text' || followUp?.text) this.requireTextRecognition();
    const action = p.action;
    const points = action.type === 'drag' ? action.path : 'point' in action && action.point ? [action.point] : [];
    if (!snapshot.pixels && (action.type === 'scroll' || points.length > 0))
      throw new CuError(
        'invalid_request',
        'This snapshot has no screenshot (observed with elementsOnly); observe again without elementsOnly before using coordinates, drag or scroll.',
      );
    const observed = snapshot.observation;
    if (hasPixels(observed) && points.some(point => point.x >= observed.imageWidth || point.y >= observed.imageHeight))
      throw new CuError('invalid_request', 'Coordinates are outside the observed image.');
    const backendElementId = 'elementId' in action && action.elementId ? snapshot.elementIds.get(action.elementId) : undefined;
    if ('elementId' in action && action.elementId && backendElementId === undefined)
      throw new CuError('stale_snapshot', 'Element does not belong to this snapshot.');
    // 后端只认识它自己的元素 id；公开 id 在这里换回去。
    const backendAction = backendElementId === undefined ? action : { ...action, elementId: backendElementId };
    // 逐键输入很慢；注定超过时限的输入在入队前拒绝，避免输入到一半被截断、结果不确定而停机。
    const estimate = this.backend(session.target.kind).estimateMs?.(snapshot.observation, backendAction, session.mode);
    if (estimate !== undefined && estimate > p.timeoutMs) {
      const seconds = Math.ceil(estimate / 1000);
      throw new CuError(
        'invalid_request',
        estimate > 30_000
          ? `This input needs about ${seconds} seconds, longer than one action can take (30 seconds); nothing was sent. Split it into shorter parts or use paste.`
          : `This input needs about ${seconds} seconds, longer than timeoutMs (${p.timeoutMs} ms); nothing was sent. Raise timeoutMs to ${Math.min(30_000, seconds * 1000)}, split the text or use paste.`,
      );
    }
    const record: ActionRecord = {
      requestId: p.requestId,
      clientId: client.id,
      sessionId: session.id,
      fingerprint,
      type: action.type,
      state: 'queued',
      updatedAt: this.now(),
    };
    this.actions.records.set(record.requestId, record);
    // Consume immediately: two queued actions cannot both rely on one pre-action snapshot.
    this.snapshots.delete(p.snapshotId);
    this.retire(p.snapshotId, session.id, 'consumed');
    const controller = new AbortController();
    const work: Work = {
      controller,
      sessionId: session.id,
      started: false,
      contained: this.options.backends.find(b => b.kind === session.target.kind)?.interruptionContained === true,
      promise: Promise.resolve(),
      admitted: Promise.resolve(),
    };
    this.work.set(record.requestId, work);
    work.admitted = this.persistActions();
    // Attach immediately: queued work may be waiting behind a running gesture.
    void work.admitted.catch(() => {});
    const submittedAt = this.now();
    work.promise = this.queue.then(async () => {
      let timer: NodeJS.Timeout | undefined;
      let verified: Found | undefined;
      try {
        await work.admitted;
        if (controller.signal.aborted) throw new CuError('cancelled', 'Action cancelled before execution.');
        if (this.now() - submittedAt > QUEUE_ADMISSION_MS)
          throw new CuError('cancelled', 'Action waited too long behind earlier actions and was not executed; observe again.');
        this.checkRunning();
        if (!this.clients.clients.has(client.id)) throw new CuError('unauthorized', 'Client revoked.');
        this.getSession(client, session.id);
        this.checkLease(session);
        const backend = this.backend(session.target.kind);
        if (this.now() - snapshot.createdAt > SNAPSHOT_TTL)
          throw new CuError('stale_snapshot', 'The snapshot expired while the action waited in the queue; observe again.');
        if (!(await bounded(backend.validate(snapshot.observation), Math.min(VALIDATE_MS, p.timeoutMs), controller.signal)))
          throw new CuError('stale_snapshot', 'Target changed; observe it again.');
        record.state = 'running';
        await this.persistActions();
        // Authorization and cancellation may change during backend/IO awaits.
        if (controller.signal.aborted) throw new CuError('cancelled', 'Action cancelled before execution.');
        this.checkRunning();
        if (!this.clients.clients.has(client.id)) throw new CuError('unauthorized', 'Client revoked.');
        this.getSession(client, session.id);
        this.checkLease(session);
        // 能报告派发时刻的后端，要到真正发出输入时才进入“可能已送达”；其余后端从调用 act 起就按已派发处理。
        work.started = backend.reportsDispatch !== true;
        const deadline = this.now() + p.timeoutMs;
        let timedOut = false;
        const interruption = (): CuError => {
          if (work.started) return new CuError('unknown_outcome', 'Active action interrupted; inspect the target before retrying.');
          if (timedOut) return new CuError('timeout', 'Action timed out before any input was dispatched; nothing was sent.');
          return new CuError('cancelled', 'Action cancelled before any input was dispatched.');
        };
        const aborted = new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(interruption()), { once: true });
          timer = setTimeout(() => {
            timedOut = true;
            // 已发出的输入中断不了，只会把一次正常完成的动作变成结果不确定并停机；给它一段宽限期完成。
            if (!work.started) controller.abort();
            else timer = setTimeout(() => controller.abort(), this.options.dispatchGraceMs ?? DISPATCH_GRACE_MS);
          }, p.timeoutMs);
        });
        const dispatched = () => {
          work.started = true;
        };
        const execution = await Promise.race([
          backend.act(snapshot.observation, backendAction, session.mode, controller.signal, dispatched, { budgetMs: p.timeoutMs }),
          aborted,
        ]);
        clearTimeout(timer);
        work.started = false;
        // 派发已完成：effect 未确认只说明驱动无法证明效果，不属于结果不确定。
        record.state = 'executed';
        if (execution) {
          record.effect = execution.effect;
          if (execution.warning) record.warning = { ...execution.warning };
          if (execution.progress) record.progress = { ...execution.progress };
        }
        if (p.verify) {
          try {
            // 满足条件的那次观察会作为附带观察直接发布；没有附带观察、或附带的只要元素时，轮询用不着截图。
            verified = await this.waitFor(
              session,
              p.verify,
              Math.max(1, deadline - this.now()),
              controller.signal,
              followUp !== undefined && followUp.elementsOnly !== true,
            );
            record.state = 'verified';
            delete record.error;
          } catch (error) {
            record.error = errorResult(error);
          }
        }
      } catch (error) {
        record.error = errorResult(error);
        record.state = work.started
          ? ['unknown_outcome', 'timeout', 'internal'].includes(record.error.code) || controller.signal.aborted
            ? 'unknown'
            : 'failed'
          : record.error.code === 'cancelled'
            ? 'cancelled'
            : 'failed';
        // 原生手势可能在取消后继续执行，必须停机；隔离后端只记录 unknown，由 Agent 重新观察。
        // 驱动调用已经返回、只是无法判断效果时（settled），没有仍在进行的输入，记为 unknown 但不停机。
        const settled = error instanceof CuError && error.settled && !controller.signal.aborted;
        if (work.started && record.state === 'unknown' && !work.contained && !settled)
          this.haltUncertainInput(
            `Active action ${record.requestId} ended with ${record.error.code}; restart the runtime and inspect the target.`,
          );
      } finally {
        clearTimeout(timer);
        work.started = false;
        record.updatedAt = this.now();
        session.expiresAt = this.now() + SESSION_TTL;
        this.work.delete(record.requestId);
        await this.persistActions();
      }
      const result = this.publicRecord(record);
      // 结果不确定时不附带观察：Agent 必须先查询状态、有意识地检查目标，而不是顺着新截图继续操作。
      if (followUp && record.state !== 'unknown') Object.assign(result, await this.observeAfter(session, followUp, verified, startedAt));
      return result;
    });
    this.queue = work.promise.catch(() => {});
    return work.promise;
  }
  // 在动作的队列位置内观察，后面排队的动作不会插到动作与观察之间。观察失败不改变动作记录。
  private async observeAfter(
    session: Session,
    publish: PublishOptions,
    verified: Found | undefined,
    startedAt: number,
  ): Promise<{ observation: unknown } | { observationError: { code: string; message: string } }> {
    try {
      if (this.stopped) throw new CuError('unavailable', 'Runtime stopped; restart it from the local app.');
      // 验证条件刚刚满足的那次观察就是动作后的最新状态，直接发布，不再重复抓取。
      if (verified) {
        const text = publish.text ? (verified.text ?? (await this.recognize(verified.observation))) : undefined;
        return { observation: this.publishObservation(session, verified.observation, publish, text) };
      }
      const remaining = startedAt + ACT_RESPONSE_MS - this.now();
      if (remaining < MIN_OBSERVE_MS) throw new CuError('timeout', 'No time remained to observe after the action; call observe.');
      return { observation: await this.observe(session, publish, Math.min(OBSERVE_MS, remaining)) };
    } catch (error) {
      return { observationError: errorResult(error) };
    }
  }
  private async persistActions(): Promise<void> {
    try {
      await this.actions.save();
    } catch {
      this.haltUncertainInput('Action journal could not be persisted; restart the runtime after checking local storage.');
      throw new CuError('unavailable', 'Action journal could not be persisted; execution has stopped.');
    }
  }
  private publicRecord(record: ActionRecord): Record<string, unknown> {
    const { clientId: _, fingerprint: __, ...publicRecord } = record;
    return structuredClone(publicRecord);
  }
  async call(token: string | undefined, method: string, params: unknown): Promise<unknown> {
    if (method === 'pair') return this.pair(params);
    const client = this.clients.authenticate(token);
    if (!(method in schemas) || !Object.hasOwn(schemas, method)) throw new CuError('invalid_request', 'Unknown method.');
    const name = method as Method;
    const parsed = schemas[name].safeParse(params ?? {});
    if (!parsed.success) throw new CuError('invalid_request', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    switch (name) {
      case 'capabilities':
        return {
          protocolVersion: 1,
          client: this.clientInfo(client),
          authorization: this.authorization(client),
          methods: descriptions,
          desktop: {
            driver: 'cua-driver',
            version: '0.38.0',
            coordinateSpace: 'snapshot-image-pixels',
            drag: 'two-endpoint straight gesture',
            scroll: 'direction + line/page units',
          },
          modes: ['background', 'foreground'],
          observation: {
            elementFields: ['id', 'role', 'label', 'bounds', 'value', 'valueLength', 'enabled', 'selected', 'min', 'max'],
            elementIds: 'stable within a session while role, label and bounds are unchanged',
            valueLimit: VALUE_LIMIT,
            omit: ['screenshot', 'elements'],
            // 不抓取截图的快照：只能用于元素动作、输入和按键，元素没有位置。
            elementsOnly: true,
            changesSince: true,
            observeAfterAct: true,
            // 截图文字识别（observe 的 text、wait 与 verify 的文字条件）是否可用。
            text: this.options.recognizeText !== undefined,
            covered: true,
          },
          // 能否由 Agent 发起全应用授权请求（需要支持确认弹窗的宿主）。
          grantRequests: this.hostFeatures.has(GRANT_REQUEST_FEATURE),
          sessionTtlMs: SESSION_TTL,
          snapshotTtlMs: SNAPSHOT_TTL,
          paused: this.paused,
          stopped: this.stopped,
          verification: 'Only explicit observable conditions produce verified results.',
        };
      case 'doctor':
        return {
          client: this.clientInfo(client),
          authorization: this.authorization(client),
          paused: this.paused,
          stopped: this.stopped,
          backends: await bounded(Promise.all(this.options.backends.map(async b => ({ kind: b.kind, ...(await b.doctor()) }))), 25_000),
        };
      case 'targets':
        this.checkRunning();
        return this.listTargets(client);
      case 'session_open':
        return this.openSession(client, parsed.data);
      case 'session_close': {
        const p = schemas.session_close.parse(parsed.data);
        this.getSession(client, p.sessionId);
        this.removeSession(p.sessionId);
        return { closed: true };
      }
      case 'observe': {
        const { sessionId, ...request } = schemas.observe.parse(parsed.data);
        const options = publishOptions(request);
        return this.observe(this.getSession(client, sessionId), options);
      }
      case 'act':
        return this.act(client, parsed.data);
      case 'wait': {
        const p = schemas.wait.parse(parsed.data);
        const session = this.getSession(client, p.sessionId);
        const reading = p.text || p.condition.type === 'text';
        const options = publishOptions({ screenshot: p.screenshot, elements: true, elementsOnly: p.elementsOnly, text: reading });
        if (reading) this.requireTextRecognition();
        const found = await this.waitFor(session, p.condition, p.timeoutMs, undefined, !p.elementsOnly);
        const text = reading ? (found.text ?? (await this.recognize(found.observation))) : undefined;
        return { state: 'verified', observation: this.publishObservation(session, found.observation, options, text) };
      }
      case 'request_all_apps':
        return this.requestAllApps(client);
      case 'action_status':
      case 'cancel': {
        const p = schemas.action_status.parse(parsed.data);
        const record = this.actions.records.get(p.requestId);
        if (!record || record.clientId !== client.id) throw new CuError('not_found', 'Request not found.');
        await this.work.get(p.requestId)?.admitted;
        if (name === 'cancel') {
          const work = this.work.get(p.requestId);
          work?.controller.abort();
          if (work?.started && !work.contained)
            this.haltUncertainInput(`Active action ${p.requestId} was cancelled; restart the runtime and inspect the target.`);
          if (work) await work.promise;
        }
        return this.publicRecord(record);
      }
    }
  }
  // 名称是配对时 Agent 自己给的，短 ID 是客户端 ID 的前 8 位，与 App 客户端页显示的一致。两者都不是凭据。
  private clientInfo(client: Client): { id: string; shortId: string; name: string } {
    return { id: client.id, shortId: client.id.slice(0, 8), name: client.name };
  }
  // Agent 发起、本机用户在弹窗里确认的全应用授权：与配对同一个信任模型，默认按钮是拒绝。
  private async requestAllApps(client: Client): Promise<unknown> {
    if (this.stopped) throw new CuError('unavailable', 'Runtime stopped; restart it from the local app.');
    if (client.grant.allApps === true && client.grant.foreground === true && client.grant.appIds.length === 0)
      return { granted: true, alreadyGranted: true, authorization: this.authorization(client) };
    if (client.grant.allApps !== true && client.grant.appIds.length === 0)
      throw new CuError('permission_denied', 'A browser-only client cannot request desktop access; pair a desktop client instead.');
    if (!this.hostFeatures.has(GRANT_REQUEST_FEATURE))
      throw new CuError(
        'unavailable',
        'This App version cannot show the request. Ask the user to choose Allow all apps for this client on the Clients page.',
      );
    if ([...this.grantRequests.values()].some(request => request.clientId === client.id))
      throw new CuError('busy', 'A request for this client is already waiting for the user.');
    if (this.grantRequests.size >= 3) throw new CuError('busy', 'Too many pending authorization requests.');
    const requestId = randomUUID();
    let approved = false;
    try {
      approved = await this.requestDecision(
        resolve => {
          this.grantRequests.set(requestId, { clientId: client.id, resolve });
          this.options.emit({
            event: 'grant_request',
            requestId,
            clientId: client.id,
            name: client.name,
            appIds: [...client.grant.appIds],
            browser: client.grant.browser,
          });
        },
        () => this.grantRequests.delete(requestId),
      );
    } finally {
      this.options.emit({ event: 'decision_finished', requestId, approved });
    }
    const current = this.clients.clients.get(client.id);
    if (!current) throw new CuError('unauthorized', 'Client revoked.');
    if (!approved) throw new CuError('permission_denied', 'The user did not allow all applications, or the request expired.');
    return { granted: true, authorization: this.authorization(current) };
  }
  async close(): Promise<void> {
    clearInterval(this.reaper);
    for (const pair of this.pairs.values()) pair.resolve(false);
    for (const request of this.grantRequests.values()) request.resolve(false);
    await this.control({ command: 'stop' });
    await Promise.allSettled(this.options.backends.map(b => b.close()));
    // EOF 可以紧跟撤销命令。先停止输入，再等待客户端保存，避免正常退出丢失撤销。
    await this.clients.flush();
  }
}
