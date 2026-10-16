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
      // 按住的修饰键（cmd 是 macOS 的 Command，option 与 alt 等价；Windows 没有 cmd）。桌面上只能在前台会话里发出。
      modifiers: z
        .array(z.enum(['cmd', 'shift', 'option', 'alt', 'ctrl']))
        .max(4)
        .optional(),
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
  // 整体替换元素的值（文本框、滑块、步进器等），不是在光标处插入。
  z.object({ type: z.literal('setValue'), elementId: id, value: z.string().max(100_000) }).strict(),
  // 按菜单名路径调用应用菜单项，如 ["File", "Export", "PDF"]；每段与菜单上显示的名称完全一致。
  z.object({ type: z.literal('menu'), path: z.array(z.string().trim().min(1).max(200)).min(1).max(16) }).strict(),
  // 经剪贴板粘贴一段文字。桌面上先完整暂存用户的剪贴板，粘贴后恢复；末尾的换行会被去掉，避免终端里一粘贴就执行。
  // restoreClipboard: false 时不读取、也不恢复剪贴板（不会触发系统的读取询问），用户复制的内容会被覆盖。
  z
    .object({
      type: z.literal('paste'),
      text: z.string().min(1).max(100_000),
      elementId: id.optional(),
      restoreClipboard: z.boolean().default(true),
    })
    .strict(),
]);
export const conditionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('element'),
      role: z.string().max(100).optional(),
      label: z.string().min(1).max(1000).optional(),
      // 状态条件按后端读到的完整值判断，不受观察结果里的截断影响；适配器丢弃的值（如可识别的密码框）不参与匹配。
      value: z.string().max(100_000).optional(),
      valueIncludes: z.string().min(1).max(100_000).optional(),
      enabled: z.boolean().optional(),
      selected: z.boolean().optional(),
      present: z.boolean(),
    })
    .strict()
    .refine(v => v.label !== undefined || v.value !== undefined || v.valueIncludes !== undefined, 'Specify label, value or valueIncludes')
    // 后端没有报告的状态无法证明“不存在”，状态条件只用于确认元素存在。
    .refine(
      v => v.present || (v.value === undefined && v.valueIncludes === undefined && v.enabled === undefined && v.selected === undefined),
      'value, valueIncludes, enabled and selected require present: true',
    ),
  z.object({ type: z.literal('title'), includes: z.string().min(1).max(1000) }).strict(),
  // 截图上识别出的文字里出现某段文字（忽略空白，全角与半角、各种横线和引号视为相同，区分大小写）。
  // 识别可能漏字，只能确认出现，不能证明不存在。
  z.object({ type: z.literal('text'), includes: z.string().max(1000).regex(/\S/u, 'Text to look for must not be blank') }).strict(),
]);
// 观察结果里要包含哪些部分。省略截图或元素只影响返回内容，快照照常可用于后续动作。
// elementsOnly 不同：根本不抓取截图，更快，但快照只能用于元素动作、输入和按键。
// screenshot 缺省时按 elementsOnly 取值（默认 true），这样才能识别它与 elementsOnly 的显式冲突。
// text：附带从截图识别出的文字行，需要截图，不能与 elementsOnly 同用。
const observeParts = {
  screenshot: z.boolean().optional(),
  elements: z.boolean().default(true),
  elementsOnly: z.boolean().default(false),
  text: z.boolean().default(false),
};
export const schemas = {
  capabilities: z.object({}).strict(),
  doctor: z.object({}).strict(),
  targets: z.object({}).strict(),
  session_open: z
    .object({ targetId: id, mode: z.enum(['background', 'foreground']).default('background'), exclusive: z.boolean().default(true) })
    .strict(),
  session_close: z.object({ sessionId: id }).strict(),
  observe: z.object({ sessionId: id, ...observeParts, since: id.optional() }).strict(),
  act: z
    .object({
      sessionId: id,
      snapshotId: id,
      requestId: z.uuid(),
      action: actionSchema,
      verify: conditionSchema.optional(),
      timeoutMs: z.number().int().min(100).max(30_000).default(15_000),
      observe: z
        .object({ ...observeParts, changes: z.boolean().default(false) })
        .strict()
        .optional(),
    })
    .strict(),
  wait: z
    .object({
      sessionId: id,
      condition: conditionSchema,
      timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
      elementsOnly: z.boolean().default(false),
      // 返回结果里是否带截图；缺省时带（elementsOnly 时不带）。文字条件满足后通常只需要文字。
      screenshot: z.boolean().optional(),
      text: z.boolean().default(false),
    })
    .strict(),
  action_status: z.object({ requestId: z.uuid() }).strict(),
  cancel: z.object({ requestId: z.uuid() }).strict(),
  request_all_apps: z.object({}).strict(),
};
export type Method = keyof typeof schemas;
// 客户端名称会原样显示在本机审批框里：拒绝换行、方向控制等不可见字符，避免伪造提示内容。
const visibleText = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;
export const pairSchema = z
  .object({
    name: z.string().trim().min(1).max(80).regex(visibleText),
    appIds: z.array(z.string().min(2).max(1024)).max(50).default([]),
    allApps: z.boolean().optional(),
    browser: z.boolean().default(false),
  })
  .strict()
  // 不指定范围的新客户端默认请求所有桌面应用；显式应用列表和仅浏览器请求保留原语义。
  .refine(v => v.allApps !== true || v.appIds.length === 0, 'Choose all applications or an explicit application list')
  .refine(v => v.allApps !== false || v.appIds.length > 0 || v.browser, 'At least one target permission required');
export const hostCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.enum(['pair_allow', 'pair_deny']), clientId: id, allApps: z.boolean().optional() }).strict(),
  z.object({ command: z.literal('revoke'), clientId: id }).strict(),
  z.object({ command: z.literal('grant_all_apps'), clientId: id, requestId: z.uuid() }).strict(),
  z.object({ command: z.literal('grant_deny'), clientId: id, requestId: z.uuid() }).strict(),
  z
    .object({
      command: z.literal('host_features'),
      features: z.array(z.string().min(1).max(40)).max(20),
    })
    .strict(),
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
  observe:
    'Return a fresh screenshot and semantic elements (role, label, bounds, and value/enabled/selected when readable; password contents are never returned). Coordinates refer to this image; use its snapshotId for the next action. An element keeps its id within the session while its role, label and bounds stay the same. screenshot: false or elements: false omits that part without affecting the snapshot. elementsOnly: true does not capture a screenshot at all, which is faster: the snapshot then supports element actions, typing and keys, but not coordinates, drag or scroll, and elements carry no bounds. Do not combine it with screenshot: true or elements: false. text: true adds the text lines recognized in the screenshot, with bounds in image pixels (for terminals, canvases and other text missing from the element tree; recognition can miss or misread characters); it needs a screenshot capture. since: a snapshotId whose elements you already have returns only added or changed elements plus changes.removed; without a changes field the element list is complete. covered: true means other windows completely covered the window; with screenshotMayBeStale: true the window shows web content that may stop redrawing while covered, so the image can be out of date.',
  act: 'Execute one bounded action using a recent snapshot. requestId is a UUID for deduplication; query status instead of repeating an uncertain operation. timeoutMs bounds dispatch and verification together; input already dispatched gets up to 5 more seconds to finish. An action still queued after 15 seconds is cancelled without dispatch. Pass observe to receive the next observation in this result (not after an unknown outcome); observe.changes returns only elements changed since the acted snapshot, and observe.elementsOnly skips the screenshot as in observe. Without a screenshot-bearing observe, verify polls without capturing screenshots. Besides pointer and keyboard actions (a click may hold modifiers, which on the desktop needs a foreground session), setValue replaces the whole value of a text field, slider or similar element, and menu invokes an application menu item by its path of names, both without moving focus. paste puts text on the clipboard, pastes it and then restores what the user had copied (restoreClipboard: false skips saving and restoring); trailing line breaks are removed so a pasted command never runs by itself. In a macOS background session paste runs the app’s Paste menu command, so it goes to the field that has focus and takes no elementId; otherwise it sends the paste shortcut, to elementId when given. A result may carry warning (for example readback_mismatch when a self-clearing web input such as a terminal could not read the typed text back) and progress when typing stopped partway. Execution alone does not imply task success.',
  wait: 'Wait for an explicit observable condition, with a bounded timeout. Element conditions match label, value or valueIncludes, optionally role, enabled and selected. A text condition waits until the recognized screenshot text includes a string, for terminals and other text the element tree does not show; matching ignores whitespace and treats full-width forms, dashes and quotes alike. elementsOnly: true polls and returns without capturing screenshots (faster; the returned snapshot supports element actions, typing and keys only). screenshot: false returns the observation without the image; text: true (implied by a text condition) adds the recognized text lines. No fixed sleep or implicit task planning.',
  action_status: 'Read the status of a previous request owned by this client, including uncertain outcomes after disconnects.',
  cancel: 'Cancel a queued or active request. Active cancellation may require a runtime restart to guarantee input has stopped.',
  request_all_apps:
    'Ask the local user to extend this client to all desktop applications and foreground control. The App shows a confirmation naming this client; the result arrives after the user answers (up to 60 seconds). Existing credentials, profile and browser permission stay unchanged.',
};
