// Drive Microsoft Edge (Chromium) through the Chrome DevTools Protocol. Node 24, no dependencies.
//
//   import { launchEdge, fileUrl } from './cdp.mjs';
//   const edge = await launchEdge({ width: 1100 });
//   await edge.open(fileUrl('dist/Budget.html'));
//   await edge.setFiles('#file', ['test/fixtures/ing-fake-1.pdf']);
//   await edge.waitFor('window.__done === true');
//   const value = await edge.eval(() => document.title);
//   await edge.screenshot('.tmp/shot.png', { width: 400, fullPage: true });
//   console.log(edge.errors(), edge.externalRequests());
//   await edge.close();
//
// Every launch uses its own profile under .tmp/ (deleted on close unless `profileDir` was given),
// and only the process started here is ever killed (by PID).
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TMP_ROOT = join(APP_ROOT, '.tmp');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function fileUrl(path) {
  return pathToFileURL(resolve(APP_ROOT, path)).href;
}

async function waitForFile(path, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const text = await readFile(path, 'utf8');
      if (text.includes('\n')) return text;
    } catch {
      // not written yet
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function killTree(pid) {
  return new Promise((done) => {
    const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    p.on('exit', done);
    p.on('error', done);
  });
}

// Wrap a function or expression string into an expression for Runtime.evaluate.
export function toExpression(fnOrExpr, args) {
  if (typeof fnOrExpr === 'function') {
    return `(${fnOrExpr.toString()})(...${JSON.stringify(args)})`;
  }
  return String(fnOrExpr);
}

class CdpConnection {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();

  static async open(url) {
    const conn = new CdpConnection();
    conn.#ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      conn.#ws.addEventListener('open', ok, { once: true });
      conn.#ws.addEventListener('error', () => fail(new Error(`Cannot connect to ${url}`)), { once: true });
    });
    conn.#ws.addEventListener('message', (event) => conn.#onMessage(JSON.parse(event.data)));
    conn.#ws.addEventListener('close', () => {
      for (const { reject } of conn.#pending.values()) reject(new Error('CDP connection closed'));
      conn.#pending.clear();
    });
    return conn;
  }

  #onMessage(msg) {
    if (msg.id !== undefined) {
      const waiter = this.#pending.get(msg.id);
      if (!waiter) return;
      this.#pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`));
      else waiter.resolve(msg.result);
      return;
    }
    for (const listener of this.#listeners) listener(msg);
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolvePromise, reject) => {
      this.#pending.set(id, { resolve: resolvePromise, reject, method });
      this.#ws.send(JSON.stringify(message));
    });
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close() {
    this.#ws.close();
  }
}

export class EdgePage {
  constructor(conn, sessionId, targetId) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.logs = []; // {source:'console'|'exception'|'log', level, text, url}
    this.requests = []; // {url, type}
    this.viewport = { width: 1100, height: 900 };
    conn.onEvent((msg) => {
      if (msg.sessionId === sessionId) this.#onEvent(msg.method, msg.params);
    });
  }

  send(method, params) {
    return this.conn.send(method, params, this.sessionId);
  }

  #onEvent(method, p) {
    if (method === 'Runtime.consoleAPICalled') {
      const text = p.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');
      const level = p.type === 'error' || p.type === 'assert' ? 'error' : p.type === 'warning' ? 'warning' : 'info';
      this.logs.push({ source: 'console', level, text, url: p.stackTrace?.callFrames?.[0]?.url || '' });
    } else if (method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails;
      this.logs.push({ source: 'exception', level: 'error', text: d.exception?.description || d.text, url: d.url || '' });
    } else if (method === 'Log.entryAdded') {
      const e = p.entry;
      this.logs.push({ source: 'log', level: e.level, text: e.text, url: e.url || '' });
    } else if (method === 'Network.requestWillBeSent') {
      this.requests.push({ url: p.request.url, type: p.type || '' });
    }
  }

  async init({ width, height }) {
    await Promise.all([
      this.send('Page.enable'),
      this.send('Runtime.enable'),
      this.send('Log.enable'),
      this.send('Network.enable'),
    ]);
    await this.setViewport(width, height);
  }

  async setViewport(width, height = this.viewport.height) {
    this.viewport = { width, height };
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }

  #waitForEvent(name, timeoutMs) {
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        off();
        fail(new Error(`Timed out waiting for ${name}`));
      }, timeoutMs);
      const off = this.conn.onEvent((msg) => {
        if (msg.sessionId === this.sessionId && msg.method === name) {
          clearTimeout(timer);
          off();
          ok(msg.params);
        }
      });
    });
  }

  async open(url, { timeoutMs = 20000 } = {}) {
    const loaded = this.#waitForEvent('Page.loadEventFired', timeoutMs);
    const nav = await this.send('Page.navigate', { url });
    if (nav.errorText) throw new Error(`Navigation to ${url} failed: ${nav.errorText}`);
    await loaded;
  }

  async reload({ timeoutMs = 20000 } = {}) {
    const loaded = this.#waitForEvent('Page.loadEventFired', timeoutMs);
    await this.send('Page.reload', { ignoreCache: true });
    await loaded;
  }

  // Evaluate a function (serialised, args passed as JSON) or an expression string; promises are awaited.
  async eval(fnOrExpr, ...args) {
    const res = await this.send('Runtime.evaluate', {
      expression: toExpression(fnOrExpr, args),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`Page evaluation failed: ${d.exception?.description || d.text}`);
    }
    return res.result.value;
  }

  async waitFor(fnOrExpr, { timeoutMs = 20000, intervalMs = 100 } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.eval(fnOrExpr);
      if (value) return value;
      if (Date.now() > end) throw new Error(`waitFor timed out: ${String(fnOrExpr).slice(0, 120)}`);
      await delay(intervalMs);
    }
  }

  // Put files into an <input type="file"> (fires input + change like a real pick).
  async setFiles(selector, paths) {
    const res = await this.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
    if (!res.result.objectId) throw new Error(`No element for ${selector}`);
    await this.send('DOM.setFileInputFiles', {
      objectId: res.result.objectId,
      files: paths.map((p) => resolve(APP_ROOT, p)),
    });
  }

  // 'light' | 'dark' | null (null = back to the real setting).
  async colorScheme(scheme) {
    await this.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme || '' }],
    });
  }

  async printMedia(on) {
    await this.send('Emulation.setEmulatedMedia', { media: on ? 'print' : '' });
  }

  async screenshot(path, { width, height, fullPage = false } = {}) {
    if (width || height) await this.setViewport(width || this.viewport.width, height || this.viewport.height);
    const params = { format: 'png' };
    if (fullPage) {
      const m = await this.send('Page.getLayoutMetrics');
      const size = m.cssContentSize || m.contentSize;
      params.clip = { x: 0, y: 0, width: this.viewport.width, height: Math.ceil(size.height), scale: 1 };
      params.captureBeyondViewport = true;
    }
    const shot = await this.send('Page.captureScreenshot', params);
    const out = resolve(APP_ROOT, path);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, Buffer.from(shot.data, 'base64'));
    return out;
  }

  async pdf(path, options = {}) {
    const res = await this.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, ...options });
    const out = resolve(APP_ROOT, path);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, Buffer.from(res.data, 'base64'));
    return out;
  }

  errors() {
    return this.logs.filter((l) => l.level === 'error');
  }

  // Requests that would leave the machine (anything except file:, blob:, data:, about:).
  externalRequests() {
    return this.requests.filter((r) => !/^(file|blob|data|about|chrome|edge|devtools):/i.test(r.url));
  }
}

export class EdgeBrowser {
  constructor({ proc, conn, profileDir, ownsProfile, downloadDir }) {
    this.proc = proc;
    this.pid = proc.pid;
    this.conn = conn;
    this.profileDir = profileDir;
    this.ownsProfile = ownsProfile;
    this.downloadDir = downloadDir;
    this.pages = [];
  }

  async newPage({ width = 1100, height = 900 } = {}) {
    const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new EdgePage(this.conn, sessionId, targetId);
    await page.init({ width, height });
    this.pages.push(page);
    return page;
  }

  async close() {
    const exited = new Promise((ok) => (this.proc.exitCode !== null ? ok() : this.proc.once('exit', ok)));
    try {
      await Promise.race([this.conn.send('Browser.close'), delay(3000)]);
    } catch {
      // connection may drop while closing
    }
    this.conn.close();
    if (!(await Promise.race([exited.then(() => true), delay(5000).then(() => false)]))) {
      await killTree(this.pid);
    }
    if (this.ownsProfile) {
      await rm(this.profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}

// Launch Edge with its own profile. Returns {browser, page, ...page methods bound} for convenience.
export async function launchEdge({
  profileDir,
  headless = true,
  width = 1100,
  height = 900,
  downloadDir,
  extraArgs = [],
} = {}) {
  await mkdir(TMP_ROOT, { recursive: true });
  const ownsProfile = !profileDir;
  const dir = profileDir ? resolve(APP_ROOT, profileDir) : await mkdtemp(join(TMP_ROOT, 'edge-'));
  await mkdir(dir, { recursive: true });
  await rm(join(dir, 'DevToolsActivePort'), { force: true });
  const args = [
    `--user-data-dir=${dir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=msEdgeSidebarV2,msUndersideButton,EdgeCollections,Translate',
    `--window-size=${width},${height}`,
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs,
    'about:blank',
  ];
  const proc = spawn(EDGE_EXE, args, { stdio: 'ignore', windowsHide: true });
  const portFile = await waitForFile(join(dir, 'DevToolsActivePort'), 20000);
  const [port, path] = portFile.trim().split(/\r?\n/);
  const conn = await CdpConnection.open(`ws://127.0.0.1:${port}${path}`);
  const browser = new EdgeBrowser({ proc, conn, profileDir: dir, ownsProfile, downloadDir });
  if (downloadDir) {
    const dl = resolve(APP_ROOT, downloadDir);
    await mkdir(dl, { recursive: true });
    await conn.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true });
  }
  const page = await browser.newPage({ width, height });
  return Object.assign(page, { browser, close: () => browser.close() });
}
