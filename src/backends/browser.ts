import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, errors } from 'playwright';
import type { Browser, BrowserContext, ElementHandle, JSHandle, Page } from 'playwright';
import { CuError } from '../contracts.js';
import type { Action, Backend, BackendObservation, Doctor, Element as CuElement, Grant, Mode, Target } from '../contracts.js';

const SELECTOR = 'button,input:not([type=hidden]),a[href],select,textarea,[role],[contenteditable=true]';
type Monitor = { revision: number; observer: MutationObserver; document: Document };
type ElementState = { handle: ElementHandle; signature: string };
type Snapshot = {
  page: Page;
  url: string;
  epoch: number;
  scroll: { x: number; y: number };
  monitor: JSHandle<Monitor>;
  elements: Map<string, ElementState>;
};

/** Isolated Chromium only. Coordinates and PNG dimensions are CSS viewport pixels (scale 1). */
export class BrowserBackend implements Backend {
  readonly kind = 'browser' as const;
  // 输入只作用于隔离的无头页面：中止时关闭该页并释放按键，不会在桌面上留下进行中的手势。
  readonly reportsDispatch = true;
  readonly interruptionContained = true;
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private starting: Promise<void> | undefined;
  private readonly pages = new Map<string, Page>();
  private readonly epochs = new WeakMap<Page, number>();
  private readonly snapshots = new Map<Page, Snapshot>();
  private readonly observations = new WeakMap<BackendObservation, Snapshot>();
  private readonly downloads = new Set<Promise<void>>();
  private downloadFailure = false;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly dataDir: string,
    private readonly options: { headless?: boolean } = {},
  ) {}

  async doctor(): Promise<Doctor> {
    let installed = true;
    try {
      await access(chromium.executablePath(), constants.X_OK);
    } catch {
      installed = false;
    }
    return {
      available: installed,
      checks: [
        {
          name: 'chromium',
          ok: installed,
          detail: installed
            ? 'Bundled-compatible Chromium is installed; no browser was launched.'
            : 'Chromium is missing. Install the matching Playwright browser explicitly.',
        },
        {
          name: 'downloads',
          ok: !this.downloadFailure,
          detail: this.downloadFailure
            ? 'A controlled browser download failed to save.'
            : 'Downloads use a private, unique directory under the application data directory.',
        },
      ],
    };
  }

  async targets(grant: Grant): Promise<Target[]> {
    this.checkOpen();
    if (!grant.browser) return [];
    await this.ensureStarted();
    this.checkOpen();
    if (this.pages.size === 0) await this.context!.newPage();
    this.checkOpen();
    return Promise.all([...this.pages].filter(([, page]) => !page.isClosed()).map(([id, page]) => this.target(id, page)));
  }

  private checkOpen(): void {
    if (this.closed) throw new CuError('unavailable', 'Controlled browser backend is closed; restart the runtime.');
  }

  private async ensureStarted(): Promise<void> {
    this.checkOpen();
    if (this.context) return;
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
  }

  private async start(): Promise<void> {
    if (!(await this.doctor()).available) throw new CuError('unavailable', 'The matching Chromium component is not installed.');
    this.checkOpen();
    try {
      // A private, ephemeral browser: no user profile and no implicit network navigation.
      this.browser = await chromium.launch({ headless: this.options.headless ?? true, args: ['--no-startup-window'] });
      this.checkOpen();
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        acceptDownloads: true,
        serviceWorkers: 'block',
      });
      this.checkOpen();
      this.context.setDefaultTimeout(5_000);
      this.context.setDefaultNavigationTimeout(15_000);
      await this.context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.protocol === 'http:' || url.protocol === 'https:') await route.continue();
        else await route.abort('blockedbyclient');
      });
      this.checkOpen();
      this.context.on('page', page => this.register(page));
      await this.context.newPage();
      this.checkOpen();
    } catch {
      // Do not call close() here: it awaits this startup promise and would deadlock.
      await this.releaseBrowser();
      throw new CuError(
        'unavailable',
        this.closed ? 'Controlled browser startup was cancelled.' : 'Unable to launch the isolated Chromium component.',
      );
    }
  }

  private register(page: Page): void {
    const id = `browser:${randomUUID()}`;
    this.pages.set(id, page);
    this.epochs.set(page, 0);
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) this.epochs.set(page, (this.epochs.get(page) ?? 0) + 1);
    });
    // Native JS dialogs have no snapshot representation; dismiss instead of hanging the action queue.
    page.on('dialog', dialog => {
      void dialog.dismiss().catch(() => {});
    });
    page.on('download', download => {
      const task = (async () => {
        const directory = join(this.dataDir, 'downloads', randomUUID());
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const name = basename(download.suggestedFilename()).replace(/[^\p{L}\p{N}._ -]/gu, '_');
        await download.saveAs(join(directory, name && name !== '.' && name !== '..' ? name : 'download'));
      })().catch(() => {
        this.downloadFailure = true;
      });
      this.downloads.add(task);
      void task.finally(() => this.downloads.delete(task));
    });
    page.on('close', () => {
      this.pages.delete(id);
      const snapshot = this.snapshots.get(page);
      if (snapshot) void this.dispose(snapshot);
      this.snapshots.delete(page);
    });
  }

  private async target(id: string, page: Page): Promise<Target> {
    return { id, kind: 'browser', appId: 'browser', title: await page.title(), url: page.url() };
  }

  async observe(target: Target): Promise<BackendObservation> {
    const page = this.pages.get(target.id);
    if (!page || page.isClosed()) throw new CuError('not_found', 'Controlled browser page no longer exists.');
    const previous = this.snapshots.get(page);
    if (previous) await this.dispose(previous);
    const monitor = await page.evaluateHandle(() => {
      const state = { revision: 0, observer: undefined as unknown as MutationObserver, document };
      state.observer = new MutationObserver(() => {
        state.revision++;
      });
      state.observer.observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
      return state;
    });
    const state: Snapshot = {
      page,
      url: page.url(),
      epoch: this.epochs.get(page) ?? 0,
      scroll: await page.evaluate(() => ({ x: scrollX, y: scrollY })),
      monitor,
      elements: new Map(),
    };
    this.snapshots.set(page, state);
    try {
      const elements: CuElement[] = [];
      const handles = await page.locator(SELECTOR).elementHandles();
      for (const handle of handles) {
        const value = await describe(handle);
        if (!value) {
          await handle.dispose();
          continue;
        }
        const id = `e${elements.length + 1}`;
        state.elements.set(id, { handle, signature: JSON.stringify(value) });
        elements.push({
          id,
          role: value.role,
          label: value.label,
          bounds: value.bounds,
          ...(value.text !== undefined ? { value: value.text } : {}),
          enabled: value.enabled,
          ...(value.selected !== undefined ? { selected: value.selected } : {}),
        });
      }
      const viewport = page.viewportSize()!;
      const png = await page.screenshot({ type: 'png', fullPage: false, scale: 'css', caret: 'initial', timeout: 5_000 });
      const observation: BackendObservation = {
        target: await this.target(target.id, page),
        bounds: { x: 0, y: 0, ...viewport },
        imageWidth: viewport.width,
        imageHeight: viewport.height,
        elements,
        elementsComplete: false,
        screenshot: { mimeType: 'image/png', data: png.toString('base64') },
      };
      this.observations.set(observation, state);
      if (!(await this.validate(observation))) throw new CuError('stale_snapshot', 'Page changed while observing; observe again.');
      return observation;
    } catch (error) {
      await this.dispose(state);
      if (this.snapshots.get(page) === state) this.snapshots.delete(page);
      throw error;
    }
  }

  async validate(observation: BackendObservation): Promise<boolean> {
    const state = this.observations.get(observation);
    if (!state || state.page.isClosed() || this.snapshots.get(state.page) !== state) return false;
    const viewport = state.page.viewportSize();
    if (
      state.url !== state.page.url() ||
      state.epoch !== this.epochs.get(state.page) ||
      viewport?.width !== observation.imageWidth ||
      viewport?.height !== observation.imageHeight
    )
      return false;
    try {
      if (
        !(await state.monitor.evaluate(
          (value, scroll) => value.document === document && value.revision === 0 && scrollX === scroll.x && scrollY === scroll.y,
          state.scroll,
        ))
      )
        return false;
      for (const element of state.elements.values()) if (JSON.stringify(await describe(element.handle)) !== element.signature) return false;
      return true;
    } catch {
      return false;
    }
  }

  async act(
    observation: BackendObservation,
    action: Action,
    _mode: Mode,
    signal: AbortSignal,
    onDispatch?: () => void,
  ): Promise<undefined> {
    if (signal.aborted) throw new CuError('cancelled', 'Browser action cancelled.');
    if (!(await this.validate(observation))) throw new CuError('stale_snapshot', 'Page or elements changed; observe again.');
    const state = this.observations.get(observation)!;
    const page = state.page;
    const abort = () => {
      void page.close().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    const check = () => {
      if (signal.aborted) throw new CuError('cancelled', 'Browser action cancelled.');
    };
    try {
      check();
      // 快照已复核且未被中止；之后的页面操作都可能产生输入或请求。
      onDispatch?.();
      switch (action.type) {
        case 'navigate': {
          let url: URL;
          try {
            url = new URL(action.url);
          } catch {
            throw new CuError('invalid_request', 'Navigation requires an absolute HTTP(S) URL or about:blank.');
          }
          if (!['http:', 'https:'].includes(url.protocol) && action.url !== 'about:blank')
            throw new CuError('invalid_request', 'Only HTTP(S) URLs and about:blank are allowed.');
          if (url.username || url.password) throw new CuError('invalid_request', 'Navigation URLs cannot contain credentials.');
          await page.goto(action.url, { waitUntil: 'domcontentloaded' });
          break;
        }
        case 'click': {
          const element = action.elementId ? state.elements.get(action.elementId) : undefined;
          if (action.elementId && !element) throw new CuError('stale_snapshot', 'Unknown snapshot element.');
          const options = { button: action.button ?? 'left', clickCount: action.count ?? 1 };
          if (element) await element.handle.click(options);
          else if (action.point) await page.mouse.click(action.point.x, action.point.y, options);
          else throw new CuError('invalid_request', 'Click requires an element or a point.');
          break;
        }
        case 'type': {
          if (action.elementId) {
            const element = state.elements.get(action.elementId);
            if (!element) throw new CuError('stale_snapshot', 'Unknown snapshot element.');
            const editable = await element.handle.evaluate(node => {
              if (node instanceof HTMLInputElement)
                return (
                  ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(node.type) && !node.disabled && !node.readOnly
                );
              if (node instanceof HTMLTextAreaElement) return !node.disabled && !node.readOnly;
              return node instanceof HTMLElement && node.isContentEditable;
            });
            if (!editable) throw new CuError('invalid_request', 'The snapshot element is not an editable text field.');
            await element.handle.focus();
            await page.keyboard.insertText(action.text);
          } else await page.keyboard.insertText(action.text);
          break;
        }
        case 'key':
          await page.keyboard.press(action.keys.map(normalizeKey).join('+'));
          break;
        case 'scroll':
          if (action.point) await page.mouse.move(action.point.x, action.point.y);
          {
            const horizontal = action.direction === 'left' || action.direction === 'right';
            const viewport = page.viewportSize()!;
            const unit = action.unit === 'line' ? 40 : horizontal ? viewport.width : viewport.height;
            const distance = action.amount * unit * (action.direction === 'left' || action.direction === 'up' ? -1 : 1);
            await page.mouse.wheel(horizontal ? distance : 0, horizontal ? 0 : distance);
          }
          break;
        case 'drag': {
          if (action.path.length < 2) throw new CuError('invalid_request', 'Drag requires at least two points.');
          const first = action.path[0]!;
          const held: string[] = [];
          try {
            for (const rawKey of action.modifiers ?? []) {
              const key = normalizeKey(rawKey);
              check();
              await page.keyboard.down(key);
              held.push(key);
            }
            await page.mouse.move(first.x, first.y);
            await page.mouse.down({ button: action.button ?? 'left' });
            const interval = action.durationMs / (action.path.length - 1);
            let previous = first;
            for (const point of action.path.slice(1)) {
              // Multiple pointer moves trigger dragstart and dragover, unlike a delayed teleport.
              const steps = Math.max(2, Math.ceil(interval / 16));
              for (let step = 1; step <= steps; step++) {
                check();
                await delay(interval / steps, undefined, { signal });
                check();
                await page.mouse.move(
                  previous.x + ((point.x - previous.x) * step) / steps,
                  previous.y + ((point.y - previous.y) * step) / steps,
                );
              }
              previous = point;
            }
          } finally {
            if (!page.isClosed()) {
              await page.mouse.up({ button: action.button ?? 'left' }).catch(() => {});
              for (const key of held.reverse()) await page.keyboard.up(key).catch(() => {});
            }
          }
          break;
        }
      }
      check();
    } catch (error) {
      if (signal.aborted) throw new CuError('cancelled', 'Browser action cancelled; its page was closed.');
      if (error instanceof CuError) throw error;
      // 导航被 Chromium 以网络错误拒绝时结果是确定的：页面没有加载目标地址。只回传固定格式的错误名。
      // ERR_ABORTED 例外：导航转成下载或被其他导航取代时也会报它，此时已有副作用，仍按结果不确定处理。
      const network = action.type === 'navigate' && error instanceof Error ? /net::ERR_\w+/.exec(error.message)?.[0] : undefined;
      if (network && network !== 'net::ERR_ABORTED')
        throw new CuError('unavailable', `Navigation failed (${network}); observe the page before continuing.`);
      if (error instanceof errors.TimeoutError)
        throw new CuError('unknown_outcome', 'Browser action timed out after possible input; inspect the target before retrying.');
      throw new CuError('unknown_outcome', 'Browser action did not finish normally; observe before retrying.');
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  /** 页面已没有会话：释放它的快照（截图对应的元素句柄与 DOM 监视器）。 */
  async release(target: Target): Promise<void> {
    const page = this.pages.get(target.id);
    const snapshot = page ? this.snapshots.get(page) : undefined;
    if (!page || !snapshot) return;
    this.snapshots.delete(page);
    await this.dispose(snapshot);
  }

  async cancel(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      await this.releaseBrowser();
      // A launch may still be awaiting the OS when cancellation arrives. Its closed check
      // disposes anything it creates; wait for that cleanup before reporting stopped.
      await this.starting?.catch(() => {});
    })();
    await this.closing;
  }

  private async releaseBrowser(): Promise<void> {
    const browser = this.browser;
    this.context = undefined;
    this.browser = undefined;
    // Browser shutdown disposes remote handles. Evaluating cleanup JavaScript first can
    // hang forever on a page with an unresponsive main thread, so avoid it on stop.
    this.snapshots.clear();
    this.pages.clear();
    await browser?.close();
    await Promise.all(this.downloads);
  }

  private async dispose(state: Snapshot): Promise<void> {
    await state.monitor.evaluate(value => value.observer.disconnect()).catch(() => {});
    await state.monitor.dispose().catch(() => {});
    await Promise.all([...state.elements.values()].map(value => value.handle.dispose().catch(() => {})));
  }
}

async function describe(handle: ElementHandle) {
  return handle.evaluate(element => {
    if (!(element instanceof Element)) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (
      !element.isConnected ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= innerHeight ||
      rect.left >= innerWidth ||
      style.visibility === 'hidden' ||
      style.display === 'none'
    )
      return null;
    const tag = element.tagName.toLowerCase();
    const inputRole =
      (
        {
          checkbox: 'checkbox',
          radio: 'radio',
          range: 'slider',
          number: 'spinbutton',
          button: 'button',
          submit: 'button',
          reset: 'button',
          image: 'button',
        } as Record<string, string>
      )[element.getAttribute('type') ?? 'text'] ?? 'textbox';
    const role =
      element.getAttribute('role') ??
      (tag === 'input'
        ? inputRole
        : ((
            {
              button: 'button',
              a: 'link',
              textarea: 'textbox',
              select: element.hasAttribute('multiple') ? 'listbox' : 'combobox',
            } as Record<string, string>
          )[tag] ?? tag));
    const labelledBy = element
      .getAttribute('aria-labelledby')
      ?.split(/\s+/)
      .map(id => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    const nativeLabels =
      'labels' in element
        ? Array.from((element as HTMLInputElement).labels ?? [])
            .map(label => label.textContent ?? '')
            .join(' ')
        : '';
    const label = (
      element.getAttribute('aria-label') ||
      labelledBy ||
      nativeLabels ||
      element.getAttribute('placeholder') ||
      (['input', 'textarea', 'select'].includes(tag) ? '' : element.textContent) ||
      element.getAttribute('title') ||
      ''
    )
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 500);
    const disabled = 'disabled' in element && Boolean((element as HTMLInputElement).disabled);
    // 公开给客户端的值：只取可编辑控件的内容。密码框不给值；按钮等控件的 value 属性不是用户可见内容。
    const input = element instanceof HTMLInputElement ? element : undefined;
    const text =
      element instanceof HTMLSelectElement
        ? Array.from(element.selectedOptions, option => option.label).join(', ')
        : element instanceof HTMLTextAreaElement ||
            (input && !['password', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden'].includes(input.type))
          ? (element as HTMLInputElement | HTMLTextAreaElement).value
          : undefined;
    const aria = (name: string) => {
      const state = element.getAttribute(name);
      return state === 'true' ? true : state === 'false' ? false : undefined;
    };
    const selected =
      input && (input.type === 'checkbox' || input.type === 'radio')
        ? input.checked
        : (aria('aria-checked') ?? aria('aria-selected') ?? aria('aria-pressed'));
    return {
      role,
      label,
      bounds: {
        x: Math.max(0, rect.x),
        y: Math.max(0, rect.y),
        width: Math.min(innerWidth, rect.right) - Math.max(0, rect.left),
        height: Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top),
      },
      // value 与 disabled 只用于快照签名，检测输入内容变化；它们不会原样返回给客户端。
      value: 'value' in element ? String((element as HTMLInputElement).value) : '',
      disabled,
      ...(text !== undefined ? { text } : {}),
      enabled: !disabled && aria('aria-disabled') !== true,
      ...(selected !== undefined ? { selected } : {}),
    };
  });
}

function normalizeKey(key: string): string {
  return (
    (
      {
        command: 'Meta',
        cmd: 'Meta',
        meta: 'Meta',
        control: 'Control',
        ctrl: 'Control',
        option: 'Alt',
        alt: 'Alt',
        shift: 'Shift',
        return: 'Enter',
        enter: 'Enter',
        escape: 'Escape',
        esc: 'Escape',
        space: 'Space',
        tab: 'Tab',
        backspace: 'Backspace',
        delete: 'Delete',
        up: 'ArrowUp',
        down: 'ArrowDown',
        left: 'ArrowLeft',
        right: 'ArrowRight',
      } as Record<string, string>
    )[key.toLowerCase()] ?? key
  );
}
