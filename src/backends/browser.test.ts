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
import type { Action, BackendObservation, Target } from '../contracts.js';

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
});
