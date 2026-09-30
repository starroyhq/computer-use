import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CuError,
  errorResult,
  type Backend,
  type BackendObservation,
  type Bounds,
  type Client,
  type Condition,
  type Element,
  type HostCommand,
  type HostEvent,
  type Mode,
  type RpcService,
  type Target,
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
type Snapshot = { id: string; sessionId: string; createdAt: number; observation: BackendObservation; elementIds: Map<string, string> };
// key 是元素身份（角色、标签、深度、取整后的位置），state 是其值与状态的摘要。
type ViewEntry = { key: string; state: string; id: string };
// shown：这次发布是否把元素返回给了客户端。只有客户端见过的元素表才能作为增量的基准。
type ElementView = { snapshotId: string; shown: boolean; entries: ViewEntry[] };
type PublishOptions = { screenshot: boolean; elements: boolean; since?: string | undefined };
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

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // 不把代理对拆成半个字符。
  const last = text.charCodeAt(limit - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

// 返回给客户端的元素：位置取整；只在与默认不同时给出 enabled/selected；与非空标签重复的值不再重复。
// 空值照常给出：它说明文本框是空的，而没有 value 只说明后端读不到。
function publicElement(element: Element): Omit<PublicElement, 'id'> {
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
  if (element.bounds) {
    const { x, y, width, height } = element.bounds;
    published.bounds = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  }
  return published;
}

// 不同平台的文本控件换行符不同，条件比较时统一成 \n。
const newlines = (text: string) => text.replace(/\r\n?/g, '\n');

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
    for (const [id, snapshot] of this.snapshots) if (now - snapshot.createdAt > SNAPSHOT_TTL) this.snapshots.delete(id);
  }
  private emitClients(): void {
    this.options.emit({ event: 'clients', clients: [...this.clients.clients.values()].map(({ id, name }) => ({ id, name })) });
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
    for (const [key, value] of this.snapshots) if (value.sessionId === id) this.snapshots.delete(key);
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
      case 'pair_deny':
        this.pairs.get(command.clientId)?.resolve(command.command === 'pair_allow');
        break;
      case 'foreground_allow':
      case 'foreground_deny':
        break; // 前台权限已在配对时授予；保留命令以兼容旧宿主。
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
        for (const item of this.work.values()) item.controller.abort();
        for (const id of this.sessions.keys()) this.removeSession(id);
        await Promise.allSettled(this.options.backends.map(b => b.cancel()));
        break;
      case 'revoke':
        this.clients.clients.delete(command.clientId);
        for (const session of this.sessions.values()) if (session.clientId === command.clientId) this.removeSession(session.id);
        await this.clients.save();
        this.emitClients();
        break;
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
    if (!parsed.success) throw new CuError('invalid_request', 'Provide a client name and explicit application/browser permissions.');
    if (this.stopped) throw new CuError('unavailable', 'Runtime stopped.');
    if (this.pairs.size >= 3) throw new CuError('busy', 'Too many pending pairing requests.');
    const token = randomBytes(32).toString('base64url');
    const client: Client = {
      id: randomUUID(),
      name: parsed.data.name,
      tokenHash: hash(token),
      grant: {
        appIds: [...new Set(parsed.data.appIds.map(id => canonicalAppId(id, this.options.platform)))],
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
            browser: client.grant.browser,
            foreground: true,
          });
        },
        () => this.pairs.delete(client.id),
      );
      if (!approved || this.stopped) throw new CuError('permission_denied', 'Pairing was denied or expired.');
      this.clients.clients.set(client.id, client);
      try {
        await this.clients.save();
      } catch (error) {
        this.clients.clients.delete(client.id);
        throw error;
      }
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
    return results.flat().filter(t => (t.kind === 'browser' ? client.grant.browser : client.grant.appIds.includes(t.appId)));
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
        'This client was paired before foreground access was included; pair it again in the local app.',
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
  private async observe(session: Session, options: PublishOptions = FULL, milliseconds = OBSERVE_MS): Promise<Record<string, unknown>> {
    const observation = await bounded(this.backend(session.target.kind).observe(session.target), milliseconds);
    try {
      return this.publishObservation(session, observation, options);
    } catch (error) {
      // 会话在观察期间被关闭时，后端刚缓存的截图不会再有人使用。
      if (!this.sessions.has(session.id)) this.releaseTarget(session.target);
      throw error;
    }
  }
  private publishObservation(session: Session, observation: BackendObservation, options: PublishOptions = FULL): Record<string, unknown> {
    const client = this.clients.clients.get(session.clientId);
    if (!client) throw new CuError('unauthorized', 'Client revoked during observation.');
    this.getSession(client, session.id);
    // Keep one snapshot per session to bound memory and make stale references explicit.
    for (const [id, snap] of this.snapshots) if (snap.sessionId === session.id) this.snapshots.delete(id);
    const snapshot: Snapshot = { id: randomUUID(), sessionId: session.id, createdAt: this.now(), observation, elementIds: new Map() };
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
      const published = publicElement(element);
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
    const { backendState: _, screenshot, elements: __, ...geometry } = observation;
    const result: Record<string, unknown> = { snapshotId: snapshot.id, capturedAt: snapshot.createdAt, ...geometry };
    if (options.screenshot) result.screenshot = screenshot;
    if (options.elements) {
      const unchanged = elements.length - changed.length;
      // 没有任何元素沿用时（例如页面整体跳转），增量不会比完整列表小，直接给完整列表。
      if (options.since !== undefined && previous?.shown && previous.snapshotId === options.since && unchanged > 0) {
        const removed = [...unmatched.values()].flat().map(entry => entry.id);
        result.changes = { since: options.since, unchanged, removed };
        result.elements = changed;
      } else result.elements = elements;
    }
    return result;
  }
  private satisfies(observation: BackendObservation, condition: Condition): boolean {
    if (condition.type === 'title') return observation.target.title.includes(condition.includes);
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
  private async waitFor(session: Session, condition: Condition, timeout: number, signal?: AbortSignal): Promise<BackendObservation> {
    const deadline = this.now() + timeout;
    do {
      if (signal?.aborted || !this.sessions.has(session.id) || this.stopped) throw new CuError('cancelled', 'Wait cancelled.');
      try {
        const observed = await bounded(
          this.backend(session.target.kind).observe(session.target),
          Math.max(1, deadline - this.now()),
          signal,
        );
        if (signal?.aborted || !this.sessions.has(session.id) || this.stopped) throw new CuError('cancelled', 'Wait cancelled.');
        if (this.satisfies(observed, condition)) return observed;
      } catch (error) {
        // A changing page is an expected waiting state, not a reason to retry input.
        if (!(error instanceof CuError) || error.code !== 'stale_snapshot') throw error;
      }
      try {
        await delay(Math.min(150, Math.max(1, deadline - this.now())), undefined, signal ? { signal } : {});
      } catch {
        // 只有 signal 中止会让 delay 拒绝；统一报告为取消，而不是内部错误。
        throw new CuError('cancelled', 'Wait cancelled.');
      }
    } while (this.now() < deadline);
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
    this.checkRunning();
    const session = this.getSession(client, p.sessionId);
    this.checkLease(session);
    if (this.work.size >= 32) throw new CuError('busy', 'Action queue is full.');
    const snapshot = this.snapshots.get(p.snapshotId);
    if (!snapshot || snapshot.sessionId !== session.id || this.now() - snapshot.createdAt > SNAPSHOT_TTL)
      throw new CuError('stale_snapshot', 'Observe this target again before acting.');
    const action = p.action;
    const points = action.type === 'drag' ? action.path : 'point' in action && action.point ? [action.point] : [];
    if (points.some(point => point.x >= snapshot.observation.imageWidth || point.y >= snapshot.observation.imageHeight))
      throw new CuError('invalid_request', 'Coordinates are outside the observed image.');
    const backendElementId = 'elementId' in action && action.elementId ? snapshot.elementIds.get(action.elementId) : undefined;
    if ('elementId' in action && action.elementId && backendElementId === undefined)
      throw new CuError('stale_snapshot', 'Element does not belong to this snapshot.');
    // 后端只认识它自己的元素 id；公开 id 在这里换回去。
    const backendAction = backendElementId === undefined ? action : { ...action, elementId: backendElementId };
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
      let verified: BackendObservation | undefined;
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
        if (
          this.now() - snapshot.createdAt > SNAPSHOT_TTL ||
          !(await bounded(backend.validate(snapshot.observation), Math.min(VALIDATE_MS, p.timeoutMs), controller.signal))
        )
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
          backend.act(snapshot.observation, backendAction, session.mode, controller.signal, dispatched),
          aborted,
        ]);
        clearTimeout(timer);
        work.started = false;
        // 派发已完成：effect 未确认只说明驱动无法证明效果，不属于结果不确定。
        record.state = 'executed';
        if (execution) record.effect = execution.effect;
        if (p.verify) {
          try {
            verified = await this.waitFor(session, p.verify, Math.max(1, deadline - this.now()), controller.signal);
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
        if (work.started && record.state === 'unknown' && !work.contained)
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
      if (p.observe && record.state !== 'unknown')
        Object.assign(result, await this.observeAfter(session, p.snapshotId, p.observe, verified, startedAt));
      return result;
    });
    this.queue = work.promise.catch(() => {});
    return work.promise;
  }
  // 在动作的队列位置内观察，后面排队的动作不会插到动作与观察之间。观察失败不改变动作记录。
  private async observeAfter(
    session: Session,
    actedSnapshotId: string,
    options: { screenshot: boolean; elements: boolean; changes: boolean },
    verified: BackendObservation | undefined,
    startedAt: number,
  ): Promise<{ observation: unknown } | { observationError: { code: string; message: string } }> {
    const publish: PublishOptions = {
      screenshot: options.screenshot,
      elements: options.elements,
      ...(options.changes ? { since: actedSnapshotId } : {}),
    };
    try {
      if (this.stopped) throw new CuError('unavailable', 'Runtime stopped; restart it from the local app.');
      // 验证条件刚刚满足的那次观察就是动作后的最新状态，直接发布，不再重复抓取。
      if (verified) return { observation: this.publishObservation(session, verified, publish) };
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
          methods: descriptions,
          desktop: {
            driver: 'cua-driver',
            version: '0.28.2',
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
            changesSince: true,
            observeAfterAct: true,
          },
          sessionTtlMs: SESSION_TTL,
          snapshotTtlMs: SNAPSHOT_TTL,
          paused: this.paused,
          stopped: this.stopped,
          verification: 'Only explicit observable conditions produce verified results.',
        };
      case 'doctor':
        return {
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
        const { sessionId, ...options } = schemas.observe.parse(parsed.data);
        return this.observe(this.getSession(client, sessionId), options);
      }
      case 'act':
        return this.act(client, parsed.data);
      case 'wait': {
        const p = schemas.wait.parse(parsed.data);
        const session = this.getSession(client, p.sessionId);
        const observed = await this.waitFor(session, p.condition, p.timeoutMs);
        return { state: 'verified', observation: this.publishObservation(session, observed) };
      }
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
  async close(): Promise<void> {
    clearInterval(this.reaper);
    for (const pair of this.pairs.values()) pair.resolve(false);
    await this.control({ command: 'stop' });
    await Promise.allSettled(this.options.backends.map(b => b.close()));
  }
}
