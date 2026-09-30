import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Runtime } from '../runtime.js';
import { hash } from '../storage.js';
import type { Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserBackend } from './browser.js';
import type { Action, BackendObservation, HostEvent, Target } from '../contracts.js';

const browserOptions = { headless: true };
const grant = { appIds: [], browser: true };
const fixture = `<!doctype html><html><head><title>Fixture</title></head><body>
<label>Name <input id="name" value="已有"></label>
<button id="submit" onclick="document.title='Saved '+document.querySelector('#name').value">Save</button>
<button onclick="document.querySelector('#submit').outerHTML='<button>Replacement</button>'">Replace</button>
<button onclick="alert('Test');document.title='Dialog dismissed'">Dialog</button>
<a href="/popup" target="_blank">Popup</a>
<a href="/download" download="sample.txt">Download</a>
<div role="slider" aria-label="Drag surface" style="width:300px;height:60px;background:#eee;touch-action:none" onpointerdown="this.setPointerCapture(event.pointerId)" onpointerup="document.title='Dragged '+Math.round(event.clientX)"></div>
<div role="button" aria-label="Drag item" draggable="true" style="width:100px;height:40px;background:#ddd" ondragstart="event.dataTransfer.setData('text/plain','fixture')">Drag</div>
<div role="region" aria-label="Drop zone" style="width:300px;height:80px;background:#eee" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.title='Dropped '+event.dataTransfer.getData('text/plain')">Drop</div>
<div style="height:2000px"></div><button>Bottom</button>
</body></html>`;

let server: Server;
// 各种控件的当前值与状态；密码框预填一个一次性测试值，用来确认它不会出现在观察结果里。
const form = `<!doctype html><title>Form</title>
<label for="nick">Nickname</label><input id="nick" value="初始">
<label for="secret">Secret</label><input id="secret" type="password" value="fixture-secret">
<label for="notes">Notes</label><textarea id="notes">第一行
第二行</textarea>
<label for="size">Size</label><select id="size"><option>Small</option><option selected>Large</option></select>
<input id="subscribe" type="checkbox" checked><label for="subscribe">Subscribe</label>
<button disabled>Locked</button>
<div role="switch" aria-checked="false" aria-label="Alerts">Alerts</div>`;
let url: string;
let directory: string;
let backend: BrowserBackend;
let target: Target;
let chromiumInstalled = false;

beforeAll(async () => {
  chromiumInstalled = (await new BrowserBackend(tmpdir(), browserOptions).doctor()).available;
  server = createServer((request, response) => {
    if (request.url === '/download') {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="sample.txt"' });
      response.end('private fixture download');
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        request.url === '/popup'
          ? '<title>Popup page</title><button>Popup button</button>'
          : request.url === '/form'
            ? form
            : request.url === '/loading'
              ? `<title>Loading</title><p id=progress>Loading</p><script>const timer=setInterval(()=>document.querySelector('#progress').textContent=String(Date.now()),5);setTimeout(()=>{clearInterval(timer);document.title='Loaded';document.querySelector('#progress').textContent='Ready'},500)</script>`
              : fixture,
      );
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  url = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(async context => {
  if (!chromiumInstalled) context.skip();
  directory = await mkdtemp(join(tmpdir(), 'computer-use-browser-'));
  backend = new BrowserBackend(directory, browserOptions);
  target = (await backend.targets(grant))[0]!;
  await act(await backend.observe(target), { type: 'navigate', url });
});
afterEach(async () => {
  await backend?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const act = (observation: BackendObservation, action: Action, signal = new AbortController().signal) =>
  backend.act(observation, action, 'background', signal);
const element = (observation: BackendObservation, label: string) => observation.elements.find(item => item.label === label)!.id;
// A loopback port that was just released: navigation to it is refused.
async function closedPortUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Missing probe port');
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return `http://127.0.0.1:${address.port}/`;
}

// These cases only launch a dedicated headless browser and a loopback fixture server.
describe('isolated Chromium backend', () => {
  it('cancels a browser launch already admitted by targets', async () => {
    const startingBackend = new BrowserBackend(directory, { headless: true });
    const pendingTargets = startingBackend.targets(grant);
    try {
      await startingBackend.cancel();
      await expect(pendingTargets).rejects.toMatchObject({ code: expect.stringMatching(/cancelled|unavailable/) });
      await expect(startingBackend.targets(grant)).rejects.toMatchObject({ code: 'unavailable' });
    } finally {
      await startingBackend.close();
    }
  });

  it('wait retries transient stale snapshots while a loading page settles', async () => {
    const runtime = new Runtime({ dataDir: join(directory, 'runtime'), backends: [backend], emit: () => {} });
    await runtime.start();
    const credential = randomUUID();
    runtime.clients.clients.set('browser-test-client', {
      id: 'browser-test-client',
      name: 'Browser test',
      tokenHash: hash(credential),
      grant,
    });
    try {
      const session = (await runtime.call(credential, 'session_open', { targetId: target.id })) as { sessionId: string };
      await act(await backend.observe(target), { type: 'navigate', url: `${url}/loading` });
      await expect(
        runtime.call(credential, 'wait', {
          sessionId: session.sessionId,
          condition: { type: 'title', includes: 'Loaded' },
          timeoutMs: 2000,
        }),
      ).resolves.toMatchObject({ state: 'verified' });
    } finally {
      await runtime.close();
    }
  });

  it('keeps discovery gated, reports viewport coordinates and enters Chinese text', async () => {
    expect(await backend.targets({ appIds: [], browser: false })).toEqual([]);
    let observation = await backend.observe(target);
    expect(observation.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
    const png = Buffer.from(observation.screenshot.data, 'base64');
    expect(png.readUInt32BE(16)).toBe(1280);
    expect(png.readUInt32BE(20)).toBe(800);
    expect(observation.elements.some(item => item.label === 'Bottom')).toBe(false);
    await act(observation, { type: 'type', text: '中文测试', elementId: element(observation, 'Name') });
    expect(await backend.validate(observation)).toBe(false);
    observation = await backend.observe(target);
    await act(observation, { type: 'key', keys: ['ArrowRight'] });
    observation = await backend.observe(target);
    await act(observation, { type: 'type', text: '完成' });
    observation = await backend.observe(target);
    await act(observation, { type: 'click', elementId: element(observation, 'Save') });
    expect((await backend.targets(grant))[0]?.title).toBe('Saved 中文测试已完成有');
  });

  it('reports editable values and control states without exposing password contents', async () => {
    await act(await backend.observe(target), { type: 'navigate', url: `${url}/form` });
    const observation = await backend.observe(target);
    const byLabel = (label: string) => observation.elements.find(item => item.label === label);
    expect(byLabel('Nickname')).toMatchObject({ role: 'textbox', value: '初始', enabled: true });
    expect(byLabel('Secret')).toMatchObject({ role: 'textbox', enabled: true });
    expect(byLabel('Secret')).not.toHaveProperty('value');
    expect(byLabel('Notes')).toMatchObject({ role: 'textbox', value: '第一行\n第二行' });
    expect(byLabel('Size')).toMatchObject({ role: 'combobox', value: 'Large' });
    expect(byLabel('Subscribe')).toMatchObject({ role: 'checkbox', selected: true });
    expect(byLabel('Locked')).toMatchObject({ role: 'button', enabled: false });
    expect(byLabel('Alerts')).toMatchObject({ role: 'switch', selected: false });
    expect(byLabel('Locked')).not.toHaveProperty('value');
    expect(JSON.stringify(observation.elements)).not.toContain('fixture-secret');
    // 值变化会让旧快照失效，新观察读到新值。
    await act(observation, { type: 'type', elementId: byLabel('Nickname')!.id, text: '已改' });
    expect(await backend.validate(observation)).toBe(false);
    const updated = await backend.observe(target);
    // 与上面的中文输入用例一致：聚焦后光标位于开头。
    expect(updated.elements.find(item => item.label === 'Nickname')).toMatchObject({ value: '已改初始' });
  });

  it('rejects old references after DOM replacement and navigation', async () => {
    const observation = await backend.observe(target);
    await act(observation, { type: 'click', elementId: element(observation, 'Replace') });
    expect(await backend.validate(observation)).toBe(false);
    await expect(act(observation, { type: 'click', elementId: element(observation, 'Save') })).rejects.toMatchObject({
      code: 'stale_snapshot',
    });
    const replacement = await backend.observe(target);
    expect(replacement.elements.some(item => item.label === 'Replacement')).toBe(true);
    await act(replacement, { type: 'navigate', url: `${url}/popup` });
    expect(await backend.validate(replacement)).toBe(false);
  });

  it('rejects arbitrary scripts, local files and credential-bearing navigation', async () => {
    for (const unsafeUrl of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'https://user:password@example.com']) {
      await expect(act(await backend.observe(target), { type: 'navigate', url: unsafeUrl })).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
    expect((await backend.targets(grant))[0]?.url).toBe(`${url}/`);
  });

  it('dismisses dialogs and discovers isolated popup pages', async () => {
    let observation = await backend.observe(target);
    await act(observation, { type: 'click', elementId: element(observation, 'Dialog') });
    expect((await backend.targets(grant))[0]?.title).toBe('Dialog dismissed');
    observation = await backend.observe(target);
    await act(observation, { type: 'click', elementId: element(observation, 'Popup') });
    await vi.waitFor(async () => expect((await backend.targets(grant)).some(page => page.title === 'Popup page')).toBe(true));
    expect((await backend.targets(grant)).every(page => page.id.startsWith('browser:') && page.appId === 'browser')).toBe(true);
  });

  it('saves each download in a unique app directory', async () => {
    for (let index = 0; index < 2; index++) {
      const observation = await backend.observe(target);
      await act(observation, { type: 'click', elementId: element(observation, 'Download') });
    }
    await vi.waitFor(async () => {
      const folders = await readdir(join(directory, 'downloads'));
      expect(folders).toHaveLength(2);
      for (const folder of folders)
        expect(await readFile(join(directory, 'downloads', folder, 'sample.txt'), 'utf8')).toBe('private fixture download');
    });
    expect((await backend.doctor()).checks.find(check => check.name === 'downloads')?.ok).toBe(true);
  });

  it('executes a pointer drag then invalidates snapshots after scroll', async () => {
    let observation = await backend.observe(target);
    const bounds = observation.elements.find(item => item.label === 'Drag surface')!.bounds!;
    await act(observation, {
      type: 'drag',
      path: [
        { x: bounds.x + 10, y: bounds.y + 10 },
        { x: bounds.x + 150, y: bounds.y + 10 },
      ],
      durationMs: 50,
    });
    expect((await backend.targets(grant))[0]?.title).toBe(`Dragged ${Math.round(bounds.x + 150)}`);
    observation = await backend.observe(target);
    const source = observation.elements.find(item => item.label === 'Drag item')!.bounds!;
    const destination = observation.elements.find(item => item.label === 'Drop zone')!.bounds!;
    await act(observation, {
      type: 'drag',
      path: [
        { x: source.x + 20, y: source.y + 20 },
        { x: destination.x + 150, y: destination.y + 40 },
      ],
      durationMs: 200,
    });
    expect((await backend.targets(grant))[0]?.title).toBe('Dropped fixture');
    observation = await backend.observe(target);
    await act(observation, { type: 'scroll', direction: 'down', amount: 2, unit: 'line' });
    await vi.waitFor(async () => expect(await backend.validate(observation)).toBe(false));
  });

  it('cancels an in-flight drag by closing only its controlled page', async () => {
    const observation = await backend.observe(target);
    const controller = new AbortController();
    const result = act(
      observation,
      {
        type: 'drag',
        path: [
          { x: 10, y: 100 },
          { x: 100, y: 100 },
        ],
        durationMs: 1000,
      },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 75);
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(async () => expect(await backend.validate(observation)).toBe(false));
    const fresh = await backend.targets(grant);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.id).not.toBe(target.id);
  });

  it('marks dispatch only for a current snapshot and reports a refused navigation as a definite failure', async () => {
    const onDispatch = vi.fn();
    const signal = new AbortController().signal;
    const stale = await backend.observe(target);
    await act(stale, { type: 'click', elementId: element(stale, 'Replace') });
    const click: Action = { type: 'click', elementId: element(stale, 'Save') };
    await expect(backend.act(stale, click, 'background', signal, onDispatch)).rejects.toMatchObject({ code: 'stale_snapshot' });
    expect(onDispatch).not.toHaveBeenCalled();
    const navigation: Action = { type: 'navigate', url: await closedPortUrl() };
    const refused = backend.act(await backend.observe(target), navigation, 'background', signal, onDispatch);
    await expect(refused).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('net::ERR_') });
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  it('records a refused navigation as failed without stopping the runtime', async () => {
    const events: HostEvent[] = [];
    const runtime = new Runtime({ dataDir: join(directory, 'runtime'), backends: [backend], emit: event => events.push(event) });
    await runtime.start();
    const credential = randomUUID();
    runtime.clients.clients.set('browser-test-client', {
      id: 'browser-test-client',
      name: 'Browser test',
      tokenHash: hash(credential),
      grant,
    });
    try {
      const { sessionId } = (await runtime.call(credential, 'session_open', { targetId: target.id })) as { sessionId: string };
      const { snapshotId } = (await runtime.call(credential, 'observe', { sessionId })) as { snapshotId: string };
      const action = { type: 'navigate', url: await closedPortUrl() };
      const result = await runtime.call(credential, 'act', { sessionId, snapshotId, requestId: randomUUID(), action });
      expect(result).toMatchObject({ state: 'failed', error: { code: 'unavailable' } });
      expect(events.some(event => event.event === 'fatal')).toBe(false);
      expect(await runtime.call(credential, 'doctor', {})).toMatchObject({ paused: false, stopped: false });
    } finally {
      await runtime.close();
    }
  });

  it('releases the page snapshot once no session uses the page', async () => {
    const observation = await backend.observe(target);
    expect(await backend.validate(observation)).toBe(true);
    await backend.release(target);
    expect(await backend.validate(observation)).toBe(false);
    await expect(act(await backend.observe(target), { type: 'navigate', url })).resolves.toBeUndefined();
  });
});
