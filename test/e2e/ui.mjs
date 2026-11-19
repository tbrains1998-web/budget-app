// Real-UI driver for the built Budget.html in headless Edge (CDP), on top of test/lib/cdp.mjs. Node 24, no packages.
//
//   const ui = await startEdge({ label: 'main', root: '.tmp/e2e-edge' });
//   await ui.open(fileUrl('.tmp/e2e-edge/Budget.html'));
//   await ui.click({ css: 'button', text: 'All months' });     // trusted mouse events at the element's centre
//   await ui.type('12,50'); await ui.key('Enter');                 // Input.insertText / Input.dispatchKeyEvent
//   await ui.chooseFiles(['test/fixtures/x.pdf'], { css: '#btn-import' }); // click -> file chooser -> files
//   await ui.drop(['test/fixtures/x.csv']);                        // synthetic dragenter/dragover/drop with File objects
//   await ui.shot('month', { width: 400, scheme: 'dark' });
//   await ui.close();                                              // closes Edge (own PID only) and deletes the profile
//
// Every launch gets a NEW profile folder <root>/profiles/<label>-<time>; close() deletes it.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { APP_ROOT, launchEdge } from '../lib/cdp.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in every document before the app's own scripts (DevTools-injected, so the page CSP does not apply).
const PAGE_HELPERS = String.raw`
(() => {
  window.__violations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__violations.push(e.violatedDirective + ' ' + (e.blockedURI || ''));
  });
  // Money is shown as "−⁠€ 12,50": the invisible word joiner goes, the no-break space becomes a space.
  const norm = (s) => String(s == null ? '' : s).replace(/[⁠​]/g, '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.closest('[hidden]')) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const describe = (el) => {
    if (!el) return 'nothing';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).join('.');
    const t = norm(el.textContent).slice(0, 40);
    return t ? s + ' "' + t + '"' : s;
  };
  // spec: {css, text (exact, normalised), re (regex source, case-insensitive), within (css), nth, child (css inside the
  // match), hidden (allow invisible)}
  const findAll = (spec) => {
    const scope = spec.within ? document.querySelector(spec.within) : document;
    if (!scope) return [];
    let list = [...scope.querySelectorAll(spec.css || '*')];
    if (!spec.hidden) list = list.filter(visible);
    if (spec.text !== undefined) list = list.filter((el) => norm(el.innerText || el.textContent) === spec.text);
    if (spec.re !== undefined) {
      const re = new RegExp(spec.re, 'i');
      list = list.filter((el) => re.test(norm(el.innerText || el.textContent)));
    }
    return list;
  };
  const find = (spec) => {
    const el = findAll(spec)[spec.nth || 0] || null;
    if (!el || !spec.child) return el;
    const kid = el.querySelector(spec.child);
    return kid && (spec.hidden || visible(kid)) ? kid : null;
  };
  window.__t = {
    norm, visible, describe, findAll, find,
    prepClick(spec) {
      const el = find(spec);
      if (!el) return { ok: false, reason: 'not found: ' + JSON.stringify(spec) };
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      const x = r.left + Math.min(r.width / 2, Math.max(4, r.width - 4));
      const y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      if (!top || !(top === el || el.contains(top))) return { ok: false, reason: 'covered by ' + describe(top) + ' (wanted ' + describe(el) + ')' };
      return { ok: true, x, y, what: describe(el) };
    },
    text(spec) {
      const el = find(spec);
      return el ? norm(el.innerText || el.textContent) : null;
    },
    texts(spec) {
      return findAll(spec).map((el) => norm(el.innerText || el.textContent));
    },
    dialog() {
      const list = [...document.querySelectorAll('#dialog-root .dialog')];
      const d = list[list.length - 1];
      if (!d) return null;
      return {
        title: norm(d.querySelector('h2') && d.querySelector('h2').textContent),
        body: norm(d.querySelector('.dialog-body') && d.querySelector('.dialog-body').innerText),
        buttons: [...d.querySelectorAll('.dialog-actions button')].map((b) => norm(b.textContent)),
        count: list.length,
      };
    },
    toasts() {
      return [...document.querySelectorAll('#toast-root .toast')].map((t) => norm(t.querySelector('.toast-msg') && t.querySelector('.toast-msg').textContent));
    },
    hscroll() {
      const de = document.documentElement;
      return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, bodyScroll: document.body.scrollWidth, innerWidth };
    },
  };
})();
`;

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34, nativeVirtualKeyCode: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33, nativeVirtualKeyCode: 33 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ' },
};

const MIME = { '.pdf': 'application/pdf', '.csv': 'text/csv', '.txt': 'text/plain', '.json': 'application/json' };

/**
 * Starts headless Edge on a brand-new profile <root>/profiles/<label>-<ms>.
 * opts.preferences: object written to <profile>/Default/Preferences before the start (content settings etc.).
 * opts.download: true -> downloads go to <root>/downloads/<label>-<ms>.
 */
export async function startEdge({ label, root, width = 1100, height = 900, preferences = null, download = false }) {
  const stamp = `${label}-${Date.now()}`;
  const profileDir = resolve(APP_ROOT, root, 'profiles', stamp);
  await mkdir(join(profileDir, 'Default'), { recursive: true });
  if (preferences) await writeFile(join(profileDir, 'Default', 'Preferences'), JSON.stringify(preferences));
  const downloadDir = download ? resolve(APP_ROOT, root, 'downloads', stamp) : undefined;
  const page = await launchEdge({ profileDir, width, height, downloadDir });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HELPERS });
  await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
  await page.colorScheme('light'); // headless Edge follows the Windows theme otherwise; dark is switched on per check
  return new Ui(page, { profileDir, downloadDir, root: resolve(APP_ROOT, root), width, height });
}

export class Ui {
  constructor(page, { profileDir, downloadDir, root, width, height }) {
    this.page = page;
    this.profileDir = profileDir;
    this.downloadDir = downloadDir;
    this.root = root;
    this.size = { width, height };
    this.closed = false;
    this.incidents = []; // toasts that had to be closed because they covered a click target
  }

  eval(fn, ...args) {
    return this.page.eval(fn, ...args);
  }

  send(method, params) {
    return this.page.send(method, params);
  }

  waitFor(fnOrExpr, opts) {
    return this.page.waitFor(fnOrExpr, opts);
  }

  async open(url) {
    await this.page.open(url);
    await this.settle();
  }

  async reload() {
    await this.page.reload();
    await this.settle();
  }

  // Two animation frames: lets renders triggered by the last event reach the DOM.
  async settle(ms = 0) {
    await this.page.eval(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
    if (ms) await delay(ms);
  }

  /**
   * Trusted left click at the centre of the element matched by spec (throws when missing or covered).
   * When a toast lies on top of the target, it is closed with its × first, as a user would (logged in
   * this.incidents), and the click is retried.
   */
  async click(spec, { settle = true } = {}) {
    let at = await this.page.eval((s) => window.__t.prepClick(s), spec);
    for (let i = 0; i < 4 && at && !at.ok && /^covered by div\.toast\b/.test(at.reason); i++) {
      this.incidents.push(at.reason);
      const close = await this.page.eval((s) => {
        const el = window.__t.find(s);
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const toast = top && top.closest('.toast');
        const x = toast && toast.querySelector('.toast-close');
        if (!x) return null;
        const b = x.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }, spec);
      if (!close) break;
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...close, button: 'left', buttons: 1, clickCount: 1 });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...close, button: 'left', buttons: 0, clickCount: 1 });
      await this.settle();
      at = await this.page.eval((s) => window.__t.prepClick(s), spec);
    }
    if (!at || !at.ok) throw new Error(`click failed: ${at ? at.reason : 'no page helper'}`);
    const base = { x: at.x, y: at.y };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, button: 'left', buttons: 0, clickCount: 1 });
    if (settle) await this.settle();
    return at;
  }

  /** Moves the mouse onto the element (hover state), without clicking. */
  async hover(spec) {
    const at = await this.page.eval((s) => window.__t.prepClick(s), spec);
    if (!at || !at.ok) throw new Error(`hover failed: ${at ? at.reason : 'no page helper'}`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await this.settle();
  }

  /** Moves the mouse to the window's top-left corner so no :hover style is active. */
  async parkMouse() {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    await this.settle();
  }

  /** Types text into the focused element (replaces its selection). */
  async type(text) {
    await this.send('Input.insertText', { text });
    await this.settle();
  }

  /** Presses a key from KEYS; shift: true holds Shift (e.g. Shift+Tab). */
  async key(name, { times = 1, shift = false } = {}) {
    const k = KEYS[name];
    if (!k) throw new Error(`unknown key ${name}`);
    const modifiers = shift ? 8 : 0;
    for (let i = 0; i < times; i++) {
      await this.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...k, modifiers });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k, text: undefined, modifiers });
    }
    await this.settle();
  }

  /** Trusted left click at a point of the window (CSS pixels), e.g. on a dialog's backdrop. */
  async clickAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await this.settle();
  }

  /**
   * Changes a native <select> the keyboard way (focus, then arrow keys: a closed select commits each step and fires
   * change). Returns the value it ended on.
   */
  async selectByKeys(spec, value) {
    const info = await this.page.eval((s, v) => {
      const el = window.__t.find(s);
      if (!el) return { ok: false, reason: 'not found' };
      el.focus();
      const values = [...el.options].map((o) => o.value);
      return { ok: values.includes(v), from: values.indexOf(el.value), to: values.indexOf(v), values };
    }, spec, value);
    if (!info.ok) throw new Error(`selectByKeys: ${info.reason || `no option ${value} in ${JSON.stringify(info.values)}`}`);
    const diff = info.to - info.from;
    for (let i = 0; i < Math.abs(diff); i++) {
      await this.key(diff > 0 ? 'ArrowDown' : 'ArrowUp');
      await this.page.eval((s) => { const el = window.__t.find(s); if (el && document.activeElement !== el) el.focus(); return true; }, spec);
    }
    return this.page.eval((s) => { const el = window.__t.find(s); return el ? el.value : null; }, spec);
  }

  /** Selects all text of the focused input (as a user would with Ctrl+A) so the next type() replaces it. */
  async selectAll() {
    await this.page.eval(() => {
      const a = document.activeElement;
      if (a && typeof a.select === 'function') a.select();
      return true;
    });
  }

  text(spec) {
    return this.page.eval((s) => window.__t.text(s), spec);
  }

  texts(spec) {
    return this.page.eval((s) => window.__t.texts(s), spec);
  }

  exists(spec) {
    return this.page.eval((s) => Boolean(window.__t.find(s)), spec);
  }

  dialog() {
    return this.page.eval(() => window.__t.dialog());
  }

  toasts() {
    return this.page.eval(() => window.__t.toasts());
  }

  state() {
    return this.page.eval(() => JSON.parse(JSON.stringify(Budget.store.get())));
  }

  async waitDialog(re, timeoutMs = 20000) {
    const source = re ? re.source : '';
    await this.page.waitFor(`(() => { const d = window.__t && window.__t.dialog(); return Boolean(d && new RegExp(${JSON.stringify(source)}, 'i').test(d.title + ' ' + d.body)); })()`, { timeoutMs });
    return this.dialog();
  }

  async waitNoDialog(timeoutMs = 5000) {
    await this.page.waitFor(() => !document.querySelector('#dialog-root .dialog'), { timeoutMs });
  }

  /** Clicks spec, answers the file chooser it opens with paths (relative to the app root or absolute). */
  async chooseFiles(paths, spec, { timeoutMs = 10000 } = {}) {
    const files = paths.map((p) => resolve(APP_ROOT, p));
    const opened = new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        off();
        fail(new Error(`no file chooser opened after clicking ${JSON.stringify(spec)}`));
      }, timeoutMs);
      const off = this.page.conn.onEvent((msg) => {
        if (msg.sessionId === this.page.sessionId && msg.method === 'Page.fileChooserOpened') {
          clearTimeout(timer);
          off();
          ok(msg.params);
        }
      });
    });
    await this.click(spec, { settle: false });
    const chooser = await opened;
    await this.send('DOM.setFileInputFiles', { files, backendNodeId: chooser.backendNodeId });
    await this.settle();
    return chooser;
  }

  /** DOM.setFileInputFiles on an existing <input type=file> (fires input + change). */
  async setFiles(selector, paths) {
    await this.page.setFiles(selector, paths);
    await this.settle();
  }

  /**
   * Synthetic drag & drop of real file bytes onto the middle of the window: dragenter, dragover, drop.
   * Returns what the drop overlay showed between dragenter and drop.
   */
  async drop(paths) {
    const files = [];
    for (const p of paths) {
      const abs = resolve(APP_ROOT, p);
      const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase();
      files.push({ name: basename(abs), type: MIME[ext] || '', b64: (await readFile(abs)).toString('base64') });
    }
    const result = await this.page.eval((list) => {
      const dt = new DataTransfer();
      for (const f of list) {
        const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      const target = document.elementFromPoint(innerWidth / 2, Math.min(innerHeight / 2, 300)) || document.body;
      const fire = (type) => target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
      const overlay = document.getElementById('drop-overlay');
      fire('dragenter');
      const shown = Boolean(overlay) && window.__t.visible(overlay);
      const overlayText = overlay ? window.__t.norm(overlay.innerText) : '';
      const overNotCancelled = fire('dragover');
      const dropNotCancelled = fire('drop');
      return { shown, overlayText, dragoverPrevented: !overNotCancelled, dropPrevented: !dropNotCancelled, hiddenAfter: !overlay || overlay.hidden, target: window.__t.describe(target) };
    }, files);
    await this.settle();
    return result;
  }

  /** Screenshot into <root>/shots/<name>-<width>-<scheme>.png; restores the previous width afterwards. */
  async shot(name, { width = this.size.width, scheme = 'light', fullPage = true } = {}) {
    const before = this.page.viewport.width;
    await this.page.colorScheme(scheme);
    await this.page.setViewport(width, this.size.height);
    await this.settle(150);
    const file = join(this.root, 'shots', `${name}-${width}-${scheme}.png`);
    await this.page.screenshot(file, { fullPage });
    if (before !== width) await this.page.setViewport(before, this.size.height);
    await this.page.colorScheme('light');
    await this.settle();
    return file;
  }

  async setWidth(width) {
    await this.page.setViewport(width, this.size.height);
    await this.settle(100);
  }

  errors() {
    return this.page.errors();
  }

  externalRequests() {
    return this.page.externalRequests();
  }

  violations() {
    return this.page.eval(() => window.__violations || []);
  }

  /** Closes Edge (only the process this launch started) and deletes the profile. Safe to call twice. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.page.close();
    } finally {
      await rm(this.profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
}

export { delay };
