import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { IpcClient } from './ipc.js';
import { credentialDir, socketPath } from './paths.js';
import { atomicJson, readJson } from './storage.js';
import { errorResult, CuError } from './contracts.js';

// Explicit opt-in, non-model desktop probe against the disposable fixture only.
const { values } = parseArgs({
  options: {
    socket: { type: 'string' },
    profile: { type: 'string', default: 'probe' },
    'fixture-output': { type: 'string' },
    report: { type: 'string' },
    iterations: { type: 'string', default: '10' },
  },
});
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(values.profile!)) throw new CuError('invalid_request', 'Invalid profile name.');
const credential = z.object({ token: z.string() }).parse(await readJson(join(credentialDir, `${values.profile}.json`)));
const client = new IpcClient(values.socket ?? socketPath);
const call = (method: string, params: unknown) => client.call(credential.token, method, params);
const report: { driver: string; iterations: unknown[]; completed: boolean; error?: unknown } = {
  driver: '0.28.2',
  iterations: [],
  completed: false,
};
let sessionId: string | undefined;
try {
  if (!values['fixture-output'] || !values.report)
    throw new CuError('invalid_request', 'Specify --fixture-output and --report. See docs/VALIDATION.md.');
  const iterations = Number(values.iterations);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10)
    throw new CuError('invalid_request', 'iterations must be between 1 and 10.');
  const targets = z.array(z.object({ id: z.string(), appId: z.string(), title: z.string() })).parse(await call('targets', {}));
  // AppKit also exposes untitled helper windows; only probe our explicit fixture.
  const target = targets.find(t => t.appId === 'com.starroy.computeruse.fixture' && t.title === 'Computer Use Fixture');
  if (!target) throw new CuError('not_found', 'Launch the disposable fixture and authorize its bundle ID first.');
  sessionId = z.object({ sessionId: z.string() }).parse(await call('session_open', { targetId: target.id })).sessionId;
  const observationSchema = z.object({
    snapshotId: z.string(),
    elements: z.array(z.object({ id: z.string(), role: z.string(), label: z.string() })),
  });
  const evidencePath = resolve(values['fixture-output']);
  const evidenceSchema = z.object({ text: z.string(), count: z.number().int().nonnegative() });
  const readEvidence = async () => evidenceSchema.parse(await readJson(evidencePath));
  const waitEvidence = async (accept: (value: z.infer<typeof evidenceSchema>) => Promise<boolean> | boolean) => {
    const deadline = Date.now() + 3000;
    do {
      const value = await readEvidence();
      if (await accept(value)) return value;
      await delay(50);
    } while (Date.now() < deadline);
    throw new CuError('unknown_outcome', 'Independent fixture evidence did not confirm the requested effect.');
  };
  const action = async (label: string, text?: string) => {
    const observed = observationSchema.parse(await call('observe', { sessionId }));
    const element = observed.elements.find(e => e.label === label);
    if (!element) throw new CuError('not_found', `Fixture element unavailable: ${label}`);
    const result = z
      .object({ requestId: z.string(), state: z.string(), error: z.object({ code: z.string(), message: z.string() }).optional() })
      .parse(
        await call('act', {
          sessionId,
          snapshotId: observed.snapshotId,
          requestId: randomUUID(),
          action: text === undefined ? { type: 'click', elementId: element.id } : { type: 'type', elementId: element.id, text },
        }),
      );
    // Completed-but-unconfirmed dispatch is followed by independent evidence,
    // never replayed or silently upgraded to executed. Interrupted actions stop.
    const dispatched =
      result.state === 'unknown' &&
      result.error?.code === 'unknown_outcome' &&
      result.error.message ===
        'Driver finished dispatch, but its effect is unconfirmed. Inspect or explicitly verify the target; do not replay blindly.';
    if (result.state !== 'executed' && result.state !== 'verified' && !dispatched)
      throw new CuError('unknown_outcome', `Fixture action did not complete; inspect action_status for ${result.requestId}.`);
    return { label, requestId: result.requestId, dispatchState: result.state };
  };
  for (let index = 0; index < iterations; index++) {
    const text = `中文输入验证 ${index + 1}`;
    const before = await readEvidence();
    const modified = (await stat(evidencePath, { bigint: true })).mtimeNs;
    const actions = [await action('Reset')];
    await waitEvidence(
      async evidence =>
        evidence.text === '' && evidence.count === before.count && (await stat(evidencePath, { bigint: true })).mtimeNs !== modified,
    );
    actions.push(await action('Probe input', text));
    actions.push(await action('Record'));
    const evidence = await waitEvidence(evidence => evidence.text === text && evidence.count === before.count + 1);
    report.iterations.push({
      iteration: index + 1,
      passed: true,
      recordedCount: evidence.count,
      verification: 'independent fixture file: reset write, exact Chinese text and counter increment',
      actions,
    });
  }
  report.completed = true;
} catch (error) {
  report.error = errorResult(error);
  process.exitCode = 1;
} finally {
  if (sessionId) await call('session_close', { sessionId }).catch(() => {});
  if (values.report) {
    const output = resolve(values.report);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await atomicJson(output, report);
  }
  process.stdout.write(JSON.stringify(report) + '\n');
}
