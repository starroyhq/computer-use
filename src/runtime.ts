import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CuError,
  errorResult,
  type Backend,
  type BackendObservation,
  type Client,
  type Condition,
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
  foregroundApproved: boolean;
};
type Snapshot = { id: string; sessionId: string; createdAt: number; observation: BackendObservation };
type PendingPair = { client: Client; resolve: (allow: boolean) => void };
type Work = { controller: AbortController; sessionId: string; started: boolean; promise: Promise<unknown>; admitted: Promise<void> };
const SESSION_TTL = 120_000;
const SNAPSHOT_TTL = 30_000;
// 传输层约 65 秒超时：排队准入 15 秒 + 校验 10 秒 + 派发与验证共用 timeoutMs（最多 30 秒），合计不超过 55 秒。
const QUEUE_ADMISSION_MS = 15_000;
const VALIDATE_MS = 10_000;

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
  private queue: Promise<unknown> = Promise.resolve();
  private paused = false;
  private stopped = false;
  constructor(
    private readonly options: {
      dataDir: string;
      backends: Backend[];
      emit: (event: HostEvent) => void;
      now?: () => number;
      platform?: NodeJS.Platform;
    },
  ) {
    this.clients = new ClientStore(join(options.dataDir, 'clients.json'));
    this.actions = new ActionStore(options.dataDir);
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  async start(): Promise<void> {
    await privateDirectory(this.options.dataDir);
    await this.clients.load();
    await this.actions.load();
    this.emitClients();
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
    this.sessions.delete(id);
    for (const [key, value] of this.snapshots) if (value.sessionId === id) this.snapshots.delete(key);
    for (const [requestId, work] of this.work)
      if (work.sessionId === id) {
        work.controller.abort();
        if (work.started)
          this.haltUncertainInput(`Active action ${requestId} was interrupted; restart the runtime and inspect the target.`);
      }
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
      foregroundApproved: p.mode === 'foreground',
    };
    this.checkLease(session);
    if (session.exclusive && this.work.size > 0)
      throw new CuError('busy', 'Wait for pending actions before acquiring an exclusive session.');
    this.sessions.set(session.id, session);
    return { sessionId: session.id, target, mode: session.mode, exclusive: session.exclusive, expiresAt: session.expiresAt };
  }
  private async observe(session: Session): Promise<unknown> {
    const observation = await bounded(this.backend(session.target.kind).observe(session.target), 30_000);
    return this.publishObservation(session, observation);
  }
  private publishObservation(session: Session, observation: BackendObservation): unknown {
    const client = this.clients.clients.get(session.clientId);
    if (!client) throw new CuError('unauthorized', 'Client revoked during observation.');
    this.getSession(client, session.id);
    // Keep one snapshot per session to bound memory and make stale references explicit.
    for (const [id, snap] of this.snapshots) if (snap.sessionId === session.id) this.snapshots.delete(id);
    const snapshot: Snapshot = { id: randomUUID(), sessionId: session.id, createdAt: this.now(), observation };
    this.snapshots.set(snapshot.id, snapshot);
    const { backendState: _, ...publicObservation } = observation;
    return { snapshotId: snapshot.id, capturedAt: snapshot.createdAt, ...publicObservation };
  }
  private satisfies(observation: BackendObservation, condition: Condition): boolean {
    if (condition.type === 'title') return observation.target.title.includes(condition.includes);
    if (!condition.present && !observation.elementsComplete)
      throw new CuError('unavailable', 'This backend returns a partial element tree and cannot verify element absence.');
    return (
      observation.elements.some(e => e.label === condition.label && (!condition.role || e.role === condition.role)) === condition.present
    );
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
      await delay(Math.min(150, Math.max(1, deadline - this.now())), undefined, signal ? { signal } : {});
    } while (this.now() < deadline);
    throw new CuError('timeout', 'The requested observable condition was not satisfied.');
  }
  private async act(client: Client, params: unknown): Promise<unknown> {
    const p = schemas.act.parse(params);
    const fingerprint = hash(JSON.stringify(p));
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
    if ('elementId' in action && action.elementId && !snapshot.observation.elements.some(e => e.id === action.elementId))
      throw new CuError('stale_snapshot', 'Element does not belong to this snapshot.');
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
    const work: Work = { controller, sessionId: session.id, started: false, promise: Promise.resolve(), admitted: Promise.resolve() };
    this.work.set(record.requestId, work);
    work.admitted = this.persistActions();
    // Attach immediately: queued work may be waiting behind a running gesture.
    void work.admitted.catch(() => {});
    const submittedAt = this.now();
    work.promise = this.queue.then(async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await work.admitted;
        if (controller.signal.aborted) throw new CuError('cancelled', 'Action cancelled before execution.');
        if (this.now() - submittedAt > QUEUE_ADMISSION_MS)
          throw new CuError('cancelled', 'Action waited too long behind earlier actions and was not executed; observe again.');
        this.checkRunning();
        if (!this.clients.clients.has(client.id)) throw new CuError('unauthorized', 'Client revoked.');
        this.getSession(client, session.id);
        this.checkLease(session);
        if (session.mode === 'foreground' && !session.foregroundApproved)
          throw new CuError('permission_denied', 'Foreground approval required.');
        if (
          this.now() - snapshot.createdAt > SNAPSHOT_TTL ||
          !(await bounded(
            this.backend(session.target.kind).validate(snapshot.observation),
            Math.min(VALIDATE_MS, p.timeoutMs),
            controller.signal,
          ))
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
        work.started = true;
        const deadline = this.now() + p.timeoutMs;
        const aborted = new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new CuError('unknown_outcome', 'Active action interrupted; inspect the target before retrying.')),
            { once: true },
          );
          timer = setTimeout(() => controller.abort(), p.timeoutMs);
        });
        const execution = await Promise.race([
          this.backend(session.target.kind).act(snapshot.observation, action, session.mode, controller.signal),
          aborted,
        ]);
        clearTimeout(timer);
        work.started = false;
        // 派发已完成：effect 未确认只说明驱动无法证明效果，不属于结果不确定。
        record.state = 'executed';
        if (execution) record.effect = execution.effect;
        if (p.verify) {
          try {
            await this.waitFor(session, p.verify, Math.max(1, deadline - this.now()), controller.signal);
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
        if (work.started && record.state === 'unknown')
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
      return this.publicRecord(record);
    });
    this.queue = work.promise.catch(() => {});
    return work.promise;
  }
  private async persistActions(): Promise<void> {
    try {
      await this.actions.save();
    } catch {
      this.haltUncertainInput('Action journal could not be persisted; restart the runtime after checking local storage.');
      throw new CuError('unavailable', 'Action journal could not be persisted; execution has stopped.');
    }
  }
  private publicRecord(record: ActionRecord): unknown {
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
        const p = schemas.observe.parse(parsed.data);
        return this.observe(this.getSession(client, p.sessionId));
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
          if (work?.started)
            this.haltUncertainInput(`Active action ${p.requestId} was cancelled; restart the runtime and inspect the target.`);
          if (work) await work.promise;
        }
        return this.publicRecord(record);
      }
    }
  }
  async close(): Promise<void> {
    for (const pair of this.pairs.values()) pair.resolve(false);
    await this.control({ command: 'stop' });
    await Promise.allSettled(this.options.backends.map(b => b.close()));
  }
}
