// Drive LibreWolf / Firefox (Gecko) through WebDriver BiDi. Node 24, no dependencies.
//
//   import { launchGecko, fileUrl } from './bidi.mjs';
//   const lw = await launchGecko({ profileDir: '.tmp/lw-profile' });   // persistent profile
//   await lw.open(fileUrl('dist/Budget.html'));
//   await lw.setFiles('#file', ['test/fixtures/ing-fake-1.pdf']);
//   await lw.waitFor('window.__done === true');
//   await lw.screenshot('.tmp/lw.png', { width: 400, fullPage: true });
//   const again = await lw.restart();       // full browser restart, same profile (localStorage test)
//   await again.close();
//
// Every launch starts its own browser instance (--no-remote) on a profile under .tmp/; a profile
// created here is deleted on close, a `profileDir` you pass is kept. Only the started PID is killed.
// Colour scheme and other prefs are written to the profile's user.js before start, so they need a
// (re)launch: launchGecko({ colorScheme: 'dark' }).
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LIBREWOLF_EXE = 'C:\\Program Files\\LibreWolf\\librewolf.exe';
export const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TMP_ROOT = join(APP_ROOT, '.tmp');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function fileUrl(path) {
  return pathToFileURL(resolve(APP_ROOT, path)).href;
}

/** True for the error a BiDi command gives when its tab or frame was just replaced or closed by the browser. */
export function isGoneContextError(err) {
  return /no such frame|no such window|DiscardedBrowsingContext/i.test(String((err && err.message) || err));
}

/**
 * Opens a fresh tab and closes the tabs the browser started with; returns {context, attempts}. Right after a
 * (re)start the browser may still replace its start tab (a process switch while the start page loads), and a
 * command that runs into that fails with "no such frame" (DiscardedBrowsingContextError) — seen once in
 * gecko.mjs --firefox, item 15. Then it waits a moment and starts over (reading the tabs again, so a tab left by a
 * failed attempt is closed too), up to `tries` times. A start tab that is already gone is not an error.
 * The default waits up to about 6 s: 5 tries of 300 ms were once not enough after a Firefox restart;
 * test/e2e/gecko-lib.mjs's restart() passes even more. When no new tab could be made in all that time, a tab the
 * browser has open that still answers (it can be navigated to about:blank) is used instead ({reused: true}); only when
 * there is none either does it throw.
 */
export async function openFreshTab(conn, { tries = 15, waitMs = 400 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const { contexts } = await conn.send('browsingContext.getTree', { maxDepth: 0 });
      const { context } = await conn.send('browsingContext.create', { type: 'tab' });
      for (const old of contexts) {
        if (old.context === context) continue;
        try {
          await conn.send('browsingContext.close', { context: old.context });
        } catch (err) {
          if (!isGoneContextError(err)) throw err;
        }
      }
      return { context, attempts: attempt };
    } catch (err) {
      if (!isGoneContextError(err)) throw err;
      if (attempt >= tries) {
        const context = await liveStartTab(conn);
        if (context) return { context, attempts: attempt, reused: true };
        throw err;
      }
      await delay(waitMs);
    }
  }
}

/** The newest top-level tab that can still be navigated (to about:blank), or null. */
async function liveStartTab(conn) {
  let contexts = [];
  try {
    ({ contexts } = await conn.send('browsingContext.getTree', { maxDepth: 0 }));
  } catch {
    return null;
  }
  for (const c of [...contexts].reverse()) {
    try {
      await conn.send('browsingContext.navigate', { context: c.context, url: 'about:blank', wait: 'complete' });
      return c.context;
    } catch {
      // gone as well; try the next one
    }
  }
  return null;
}

function killTree(pid) {
  return new Promise((done) => {
    const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    p.on('exit', done);
    p.on('error', done);
  });
}

function toExpression(fnOrExpr, args) {
  const inner = typeof fnOrExpr === 'function'
    ? `(${fnOrExpr.toString()})(...${JSON.stringify(args)})`
    : String(fnOrExpr);
  // Values travel as JSON text, so the result looks the same as with cdp.mjs (returnByValue).
  return `(async () => { const v = await (${inner}); return v === undefined ? undefined : JSON.stringify(v); })()`;
}

const SCHEME_OVERRIDE = { dark: 0, light: 1 };

function userJs({ colorScheme, downloadDir, prefs }) {
  const all = {
    'browser.shell.checkDefaultBrowser': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'browser.sessionstore.resume_from_crash': false,
    'toolkit.startup.max_resumed_crashes': -1,
    'datareporting.policy.dataSubmissionEnabled': false,
    'browser.aboutwelcome.enabled': false,
    ...(colorScheme ? { 'layout.css.prefers-color-scheme.content-override': SCHEME_OVERRIDE[colorScheme] } : {}),
    ...(downloadDir
      ? {
          'browser.download.folderList': 2,
          'browser.download.dir': downloadDir,
          'browser.download.useDownloadDir': true,
          'browser.download.always_ask_before_handling_new_types': false,
        }
      : {}),
    ...prefs,
  };
  return Object.entries(all).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n') + '\n';
}

const WS_OPEN = 1; // WebSocket.OPEN

/**
 * One WebDriver BiDi connection (used by launchGecko here and by test/e2e/gecko-lib.mjs). A command sent after the
 * connection closed (e.g. to a browser that already quit after a failed restart) rejects at once: WebSocket.send on
 * a closed socket does not throw, and its answer would never come, so the promise would never settle and Node would
 * leave a test run half way ("unsettled top-level await", exit code 13) without its summary.
 */
export class BidiConnection {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();
  #closed = false;

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => fail(new Error(`Cannot connect to ${url}`)), { once: true });
    });
    return BidiConnection.attach(ws);
  }

  /** Wraps a WebSocket that is already open (anything with readyState, send, close and addEventListener). */
  static attach(ws) {
    const conn = new BidiConnection();
    conn.#ws = ws;
    ws.addEventListener('message', (event) => conn.#onMessage(JSON.parse(event.data)));
    ws.addEventListener('close', () => {
      conn.#closed = true;
      for (const { reject } of conn.#pending.values()) reject(new Error('BiDi connection closed'));
      conn.#pending.clear();
    });
    return conn;
  }

  /** True once the socket closed (or is closing). */
  get closed() {
    return this.#closed || this.#ws.readyState !== WS_OPEN;
  }

  #onMessage(msg) {
    if (msg.type === 'event') {
      for (const listener of this.#listeners) listener(msg.method, msg.params);
      return;
    }
    const waiter = this.#pending.get(msg.id);
    if (!waiter) return;
    this.#pending.delete(msg.id);
    if (msg.type === 'error') waiter.reject(new Error(`${waiter.method}: ${msg.error} ${msg.message || ''}`));
    else waiter.resolve(msg.result);
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error(`${method}: BiDi connection closed`));
    const id = this.#nextId++;
    return new Promise((resolvePromise, reject) => {
      this.#pending.set(id, { resolve: resolvePromise, reject, method });
      try {
        this.#ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.#pending.delete(id);
        reject(err);
      }
    });
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      // already closed
    }
  }
}

async function waitForBidiPort(profileDir, proc, stderr, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const m = stderr.text.match(/WebDriver BiDi listening on (ws:\/\/[^\s]+)/);
    if (m) return m[1].replace(/\/$/, '');
    try {
      const info = JSON.parse(await readFile(join(profileDir, 'WebDriverBiDiServer.json'), 'utf8'));
      if (info.ws_port) return `ws://${info.ws_host || '127.0.0.1'}:${info.ws_port}`;
    } catch {
      // not written yet
    }
    if (proc.exitCode !== null) throw new Error(`Browser exited early (code ${proc.exitCode}): ${stderr.text.slice(-500)}`);
    await delay(100);
  }
  throw new Error(`Timed out waiting for WebDriver BiDi. stderr: ${stderr.text.slice(-500)}`);
}

export class GeckoBrowser {
  constructor({ proc, conn, context, options, profileDir, ownsProfile }) {
    this.proc = proc;
    this.pid = proc.pid;
    this.conn = conn;
    this.context = context;
    this.options = options;
    this.profileDir = profileDir;
    this.ownsProfile = ownsProfile;
    this.logs = []; // {source:'console'|'javascript', level, text, url}
    this.requests = []; // {url}
    this.viewport = { width: options.width, height: options.height };
    conn.onEvent((method, p) => {
      if (method === 'log.entryAdded') {
        const level = p.level === 'warn' ? 'warning' : p.level;
        const url = p.stackTrace?.callFrames?.[0]?.url || '';
        this.logs.push({ source: p.type, level, text: p.text, url });
      } else if (method === 'network.beforeRequestSent') {
        this.requests.push({ url: p.request.url });
      }
    });
  }

  send(method, params) {
    return this.conn.send(method, params);
  }

  async setViewport(width, height = this.viewport.height) {
    this.viewport = { width, height };
    await this.send('browsingContext.setViewport', { context: this.context, viewport: { width, height } });
  }

  async open(url) {
    await this.send('browsingContext.navigate', { context: this.context, url, wait: 'complete' });
  }

  async reload() {
    await this.send('browsingContext.reload', { context: this.context, wait: 'complete' });
  }

  // Evaluate a function (serialised, args passed as JSON) or an expression string; promises are awaited.
  async eval(fnOrExpr, ...args) {
    const res = await this.send('script.evaluate', {
      expression: toExpression(fnOrExpr, args),
      target: { context: this.context },
      awaitPromise: true,
      userActivation: true,
    });
    if (res.type === 'exception') {
      throw new Error(`Page evaluation failed: ${res.exceptionDetails.text}`);
    }
    return res.result.type === 'string' ? JSON.parse(res.result.value) : undefined;
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
    const { nodes } = await this.send('browsingContext.locateNodes', {
      context: this.context,
      locator: { type: 'css', value: selector },
      maxNodeCount: 1,
    });
    if (!nodes.length) throw new Error(`No element for ${selector}`);
    await this.send('input.setFiles', {
      context: this.context,
      element: { sharedId: nodes[0].sharedId },
      files: paths.map((p) => resolve(APP_ROOT, p)),
    });
  }

  async screenshot(path, { width, height, fullPage = false } = {}) {
    if (width || height) await this.setViewport(width || this.viewport.width, height || this.viewport.height);
    const shot = await this.send('browsingContext.captureScreenshot', {
      context: this.context,
      origin: fullPage ? 'document' : 'viewport',
    });
    const out = resolve(APP_ROOT, path);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, Buffer.from(shot.data, 'base64'));
    return out;
  }

  errors() {
    return this.logs.filter((l) => l.level === 'error');
  }

  // Requests that would leave the machine (anything except file:, blob:, data:, about:).
  externalRequests() {
    return this.requests.filter((r) => !/^(file|blob|data|about|moz-extension|resource|chrome):/i.test(r.url));
  }

  async #shutdown() {
    const exited = new Promise((ok) => (this.proc.exitCode !== null ? ok() : this.proc.once('exit', ok)));
    try {
      await Promise.race([this.send('browser.close'), delay(3000)]);
    } catch {
      // connection may drop while closing
    }
    this.conn.close();
    if (!(await Promise.race([exited.then(() => true), delay(10000).then(() => false)]))) {
      await killTree(this.pid);
    }
  }

  async close() {
    await this.#shutdown();
    if (this.ownsProfile) {
      await rm(this.profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }

  // Full browser restart on the same profile (the profile is kept even if this launch created it).
  async restart(overrides = {}) {
    await this.#shutdown();
    const next = await launchGecko({ ...this.options, ...overrides, profileDir: this.profileDir });
    next.ownsProfile = this.ownsProfile;
    return next;
  }
}

export async function launchGecko({
  browser = 'librewolf',
  profileDir,
  headless = true,
  width = 1100,
  height = 900,
  colorScheme,
  downloadDir,
  prefs = {},
} = {}) {
  await mkdir(TMP_ROOT, { recursive: true });
  const exe = browser === 'firefox' ? FIREFOX_EXE : LIBREWOLF_EXE;
  const ownsProfile = !profileDir;
  const dir = profileDir ? resolve(APP_ROOT, profileDir) : await mkdtemp(join(TMP_ROOT, `${browser}-`));
  await mkdir(dir, { recursive: true });
  await rm(join(dir, 'WebDriverBiDiServer.json'), { force: true });
  const dl = downloadDir ? resolve(APP_ROOT, downloadDir) : undefined;
  if (dl) await mkdir(dl, { recursive: true });
  await writeFile(join(dir, 'user.js'), userJs({ colorScheme, downloadDir: dl, prefs }), 'utf8');

  const args = ['--no-remote', '--profile', dir, '--remote-debugging-port', '0', ...(headless ? ['--headless'] : [])];
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const stderr = { text: '' };
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    stderr.text = (stderr.text + chunk).slice(-20000);
  });
  try {
    const base = await waitForBidiPort(dir, proc, stderr, 30000);
    const conn = await BidiConnection.open(`${base}/session`);
    await conn.send('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
    await conn.send('session.subscribe', { events: ['log.entryAdded', 'network.beforeRequestSent'] });
    // The start tab can hold a privileged about: page; drive a fresh content tab instead.
    const { context } = await openFreshTab(conn);
    const options = { browser, headless, width, height, colorScheme, downloadDir, prefs };
    const gecko = new GeckoBrowser({ proc, conn, context, options, profileDir: dir, ownsProfile });
    gecko.stderr = stderr;
    await gecko.setViewport(width, height);
    return gecko;
  } catch (err) {
    await killTree(proc.pid);
    if (ownsProfile) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    throw err;
  }
}
