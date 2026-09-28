import { z } from 'zod';

const id = z.string().min(1).max(200);
const point = z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() }).strict();
const key = z.string().min(1).max(40);
export const actionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('click'),
      elementId: id.optional(),
      point: point.optional(),
      button: z.enum(['left', 'right']).optional(),
      count: z.number().int().min(1).max(2).optional(),
    })
    .strict()
    .refine(v => Boolean(v.elementId) !== Boolean(v.point), 'Choose exactly one click target'),
  z.object({ type: z.literal('type'), text: z.string().max(100_000), elementId: id.optional() }).strict(),
  z.object({ type: z.literal('key'), keys: z.array(key).min(1).max(8) }).strict(),
  z
    .object({
      type: z.literal('scroll'),
      direction: z.enum(['up', 'down', 'left', 'right']),
      amount: z.number().int().min(1).max(50),
      unit: z.enum(['line', 'page']),
      point: point.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('drag'),
      path: z.array(point).length(2),
      durationMs: z.number().int().min(100).max(10_000),
      button: z.enum(['left', 'right']).optional(),
      modifiers: z.array(key).max(4).optional(),
    })
    .strict(),
  z.object({ type: z.literal('navigate'), url: z.url().max(4096) }).strict(),
]);
export const conditionSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('element'), role: z.string().max(100).optional(), label: z.string().min(1).max(1000), present: z.boolean() })
    .strict(),
  z.object({ type: z.literal('title'), includes: z.string().min(1).max(1000) }).strict(),
]);
export const schemas = {
  capabilities: z.object({}).strict(),
  doctor: z.object({}).strict(),
  targets: z.object({}).strict(),
  session_open: z
    .object({ targetId: id, mode: z.enum(['background', 'foreground']).default('background'), exclusive: z.boolean().default(true) })
    .strict(),
  session_close: z.object({ sessionId: id }).strict(),
  observe: z.object({ sessionId: id }).strict(),
  act: z
    .object({
      sessionId: id,
      snapshotId: id,
      requestId: z.uuid(),
      action: actionSchema,
      verify: conditionSchema.optional(),
      timeoutMs: z.number().int().min(100).max(30_000).default(15_000),
    })
    .strict(),
  wait: z.object({ sessionId: id, condition: conditionSchema, timeoutMs: z.number().int().min(100).max(30_000).default(10_000) }).strict(),
  action_status: z.object({ requestId: z.uuid() }).strict(),
  cancel: z.object({ requestId: z.uuid() }).strict(),
};
export type Method = keyof typeof schemas;
export const pairSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    appIds: z.array(z.string().min(2).max(1024)).max(50).default([]),
    browser: z.boolean().default(false),
  })
  .strict()
  .refine(v => v.appIds.length > 0 || v.browser, 'At least one target permission required');
export const hostCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.enum(['pair_allow', 'pair_deny', 'revoke']), clientId: id }).strict(),
  z.object({ command: z.enum(['foreground_allow', 'foreground_deny']), sessionId: id }).strict(),
  z.object({ command: z.enum(['pause', 'resume', 'stop', 'http_enable', 'http_disable']) }).strict(),
  z.object({ command: z.literal('control_ready'), pid: z.number().int().positive().max(2_147_483_647) }).strict(),
]);

export const descriptions: Record<Method, string> = {
  capabilities: 'List available computer-use capabilities and execution restrictions.',
  doctor: 'Check runtime, desktop permissions and browser installation without changing them.',
  targets: 'List windows and controlled browser pages authorized for this client.',
  session_open:
    'Bind a session to an authorized target. Background is the default; foreground is allowed for clients whose pairing included it and may move focus, pointer and keyboard. Exclusive sessions prevent other clients from changing the UI.',
  session_close: 'Release the session, its execution lease and screenshots.',
  observe: 'Return a fresh screenshot and semantic elements. Coordinates refer to this image; use its snapshotId for the next action.',
  act: 'Execute one bounded action using a recent snapshot. requestId is a UUID for deduplication; query status instead of repeating an uncertain operation. timeoutMs bounds dispatch and verification together; an action still queued after 15 seconds is cancelled without dispatch. Execution alone does not imply task success.',
  wait: 'Wait for an explicit observable condition, with a bounded timeout. No fixed sleep or implicit task planning.',
  action_status: 'Read the status of a previous request owned by this client, including uncertain outcomes after disconnects.',
  cancel: 'Cancel a queued or active request. Active cancellation may require a runtime restart to guarantee input has stopped.',
};
