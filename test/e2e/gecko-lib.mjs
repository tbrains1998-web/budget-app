// Helpers for the Gecko end-to-end tests (LibreWolf / Firefox through WebDriver BiDi). Node 24, no dependencies.
//
// Unlike test/lib/bidi.mjs's launchGecko, launch() here
//   - can write the profile's user.js three ways: harness prefs (default), a file copied verbatim, or none at all
//     (pure browser defaults), which the persistence test needs;
//   - installs a preload script that records `securitypolicyviolation` events before any page script runs;
//   - opens the session with a file-dialog prompt handler, so a page's input.click() never shows a native picker;
//   - quits with BiDi browser.close and reports whether the browser exited by itself (no kill) and how long it took.
// The browser object is test/lib/bidi.mjs's GeckoBrowser (open, eval, waitFor, setFiles, screenshot, logs, ...).
// Ui adds real input: element-origin pointer clicks and key presses via input.performActions.
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { APP_ROOT, BidiConnection, FIREFOX_EXE, GeckoBrowser, LIBREWOLF_EXE, openFreshTab } from '../lib/bidi.mjs';

export { APP_ROOT };
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function killTree(pid) {
  return new Promise((done) => {
    const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    p.on('exit', done);
    p.on('error', done);
  });
}

const SCHEME_OVERRIDE = { dark: 0, light: 1 };

// The same convenience prefs test/lib/bidi.mjs writes (no first-run pages, no default-browser question).
export function harnessUserJs({ colorScheme, downloadDir, prefs = {} } = {}) {
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
          'browser.download.alwaysOpenPanel': false,
        }
      : {}),
    ...prefs,
  };
  return Object.entries(all).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n') + '\n';
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

// Runs before every page script: CSP violations end up in window.__t2csp.
const PRELOAD = `() => {
  const list = [];
  Object.defineProperty(window, '__t2csp', { value: list, configurable: true });
  document.addEventListener('securitypolicyviolation', (e) => {
    list.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample || '' });
  }, true);
}`;

/**
 * Starts LibreWolf (default) or Firefox on profileDir (kept on close).
 * userJs: 'harness' (convenience prefs + colorScheme/downloadDir/prefs), {copyFrom: path} (that file verbatim, nothing
 * added), or 'none' (no user.js: the browser's own defaults plus LibreWolf's librewolf.cfg).
 * wipe: delete the profile folder first.
 * freshTab: {tries, waitMs} for opening the fresh tab (test/lib/bidi.mjs openFreshTab; restart() waits longer).
 * Commands sent after the browser quit reject at once (BidiConnection), they never hang.
 */
export async function launch({
  browser = 'librewolf',
  profileDir,
  wipe = false,
  userJs = 'harness',
  colorScheme,
  downloadDir,
  prefs = {},
  headless = true,
  width = 1100,
  height = 900,
  fileDialog = 'dismiss',
  freshTab = {},
} = {}) {
  if (!profileDir) throw new Error('launch: profileDir is required');
  const exe = browser === 'firefox' ? FIREFOX_EXE : LIBREWOLF_EXE;
  const dir = resolve(APP_ROOT, profileDir);
  if (wipe) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await mkdir(dir, { recursive: true });
  await rm(join(dir, 'WebDriverBiDiServer.json'), { force: true });
  const dl = downloadDir ? resolve(APP_ROOT, downloadDir) : undefined;
  if (dl) await mkdir(dl, { recursive: true });
  if (userJs === 'harness') {
    await writeFile(join(dir, 'user.js'), harnessUserJs({ colorScheme, downloadDir: dl, prefs }), 'utf8');
  } else if (userJs === 'none') {
    await rm(join(dir, 'user.js'), { force: true });
  } else if (userJs && userJs.copyFrom) {
    await copyFile(userJs.copyFrom, join(dir, 'user.js'));
  } else if (userJs && typeof userJs.text === 'string') {
    await writeFile(join(dir, 'user.js'), userJs.text, 'utf8');
  } else if (userJs !== 'keep') {
    throw new Error(`launch: unknown userJs ${JSON.stringify(userJs)}`);
  }

  const args = ['--no-remote', '--profile', dir, '--remote-debugging-port', '0', ...(headless ? ['--headless'] : [])];
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const stderr = { text: '' };
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    stderr.text = (stderr.text + chunk).slice(-20000);
  });
  const started = Date.now();
  try {
    const base = await waitForBidiPort(dir, proc, stderr, 45000);
    const conn = await BidiConnection.open(`${base}/session`);
    const caps = { acceptInsecureCerts: false };
    if (fileDialog) caps.unhandledPromptBehavior = { file: fileDialog };
    let session;
    try {
      session = await conn.send('session.new', { capabilities: { alwaysMatch: caps } });
    } catch {
      session = await conn.send('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
    }
    await conn.send('session.subscribe', { events: ['log.entryAdded', 'network.beforeRequestSent'] });
    const fileDialogs = [];
    try {
      await conn.send('session.subscribe', { events: ['input.fileDialogOpened'] });
      conn.onEvent((method, p) => {
        if (method === 'input.fileDialogOpened') fileDialogs.push({ at: Date.now(), multiple: p.multiple, element: p.element });
      });
    } catch {
      fileDialogs.unsupported = true;
    }
    await conn.send('script.addPreloadScript', { functionDeclaration: PRELOAD });
    const { context, attempts, reused } = await openFreshTab(conn, freshTab); // retries when the start tab is replaced meanwhile
    const options = { browser, headless, width, height, colorScheme, downloadDir, prefs };
    const gecko = new GeckoBrowser({ proc, conn, context, options, profileDir: dir, ownsProfile: false });
    gecko.stderr = stderr;
    gecko.fileDialogs = fileDialogs;
    gecko.session = session;
    gecko.startMs = Date.now() - started;
    gecko.launchRetries = attempts - 1;
    gecko.reusedStartTab = Boolean(reused);
    gecko.launchArgs = { browser, profileDir: dir, userJs, colorScheme, downloadDir: dl, prefs, headless, width, height, fileDialog };
    await gecko.setViewport(width, height);
    return gecko;
  } catch (err) {
    await killTree(proc.pid);
    throw err;
  }
}

/**
 * Normal shutdown: BiDi browser.close (closes the tabs, so pagehide runs, then quits the application through the
 * regular shutdown path, which includes LibreWolf's sanitize-on-shutdown). Waits for the process to exit by itself.
 * Only if it is still running after timeoutMs is it killed; then clean is false.
 */
export async function quit(gecko, { timeoutMs = 60000 } = {}) {
  const t0 = Date.now();
  const proc = gecko.proc;
  const exited = new Promise((ok) => (proc.exitCode !== null ? ok() : proc.once('exit', ok)));
  let closeError = null;
  try {
    await Promise.race([gecko.send('browser.close', {}), delay(5000)]);
  } catch (err) {
    closeError = String(err.message || err); // the connection may drop while the browser quits
  }
  gecko.conn.close();
  const byItself = await Promise.race([exited.then(() => true), delay(timeoutMs).then(() => false)]);
  if (!byItself) await killTree(proc.pid);
  return { clean: byItself, ms: Date.now() - t0, exitCode: proc.exitCode, closeError };
}

/**
 * Quits (normal shutdown) and starts again on the same profile; overrides change launch options. Right after a
 * restart the browser may replace its start tab for a while (seen in Firefox, gecko.mjs item 15), so the fresh tab
 * is retried for up to about 15 s. When the start fails, the error is thrown: the old browser has quit then, so a
 * caller must not go on with it (its commands reject).
 */
export async function restart(gecko, overrides = {}) {
  const shutdown = await quit(gecko);
  const a = gecko.launchArgs;
  const next = await launch({ ...a, userJs: a.userJs === 'harness' ? 'harness' : 'keep', freshTab: { tries: 30, waitMs: 500 }, ...overrides, wipe: false });
  next.launchArgs.userJs = a.userJs;
  return { browser: next, shutdown };
}

// ------------------------------------------------------------------------------------------------ Marionette

/**
 * Minimal Marionette client (protocol 3: "<byte length>:<json>" frames). Used where the browser must be started with
 * an exact command line (no --remote-debugging-port): Marionette can be switched on by the MOZ_MARIONETTE=1
 * environment variable instead of an argument. Listens on marionette.port (default 2828).
 */
export class Marionette {
  #sock;
  #buf = Buffer.alloc(0);
  #pending = new Map();
  #nextId = 1;
  hello = null;

  static async connect(port = 2828, { timeoutMs = 30000, proc } = {}) {
    const net = await import('node:net');
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (proc && proc.exitCode !== null) throw new Error(`browser exited (code ${proc.exitCode}) before Marionette was up`);
      try {
        const m = new Marionette();
        await m.#open(net, port);
        return m;
      } catch (err) {
        if (Date.now() > end) throw new Error(`Marionette on ${port} not reachable: ${err.message}`);
        await delay(300);
      }
    }
  }

  #open(net, port) {
    return new Promise((ok, fail) => {
      const sock = net.createConnection({ host: '127.0.0.1', port });
      let greeted = false;
      sock.on('error', (err) => (greeted ? null : fail(err)));
      sock.on('data', (chunk) => {
        this.#buf = Buffer.concat([this.#buf, chunk]);
        for (;;) {
          const colon = this.#buf.indexOf(0x3a);
          if (colon < 0) return;
          const len = Number(this.#buf.subarray(0, colon).toString());
          if (this.#buf.length < colon + 1 + len) return;
          const msg = JSON.parse(this.#buf.subarray(colon + 1, colon + 1 + len).toString('utf8'));
          this.#buf = this.#buf.subarray(colon + 1 + len);
          if (!greeted) {
            greeted = true;
            this.hello = msg;
            ok();
          } else if (Array.isArray(msg) && msg[0] === 1) {
            const w = this.#pending.get(msg[1]);
            if (!w) continue;
            this.#pending.delete(msg[1]);
            if (msg[2]) w.fail(new Error(`${w.name}: ${msg[2].error} ${msg[2].message || ''}`));
            else w.ok(msg[3]);
          }
        }
      });
      sock.on('close', () => {
        for (const w of this.#pending.values()) w.fail(new Error('Marionette connection closed'));
        this.#pending.clear();
      });
      this.#sock = sock;
    });
  }

  send(name, params = {}) {
    const id = this.#nextId++;
    const body = Buffer.from(JSON.stringify([0, id, name, params]), 'utf8');
    return new Promise((ok, fail) => {
      this.#pending.set(id, { ok, fail, name });
      this.#sock.write(`${body.length}:`);
      this.#sock.write(body);
    });
  }

  async script(source, args = []) {
    const res = await this.send('WebDriver:ExecuteScript', { script: source, args });
    return res && Object.prototype.hasOwnProperty.call(res, 'value') ? res.value : res;
  }

  close() {
    try {
      this.#sock.destroy();
    } catch {
      // already closed
    }
  }
}

// ------------------------------------------------------------------------------------------------ real input

const KEYS = { Enter: '', Escape: '', Tab: '', Backspace: '', Control: '', Shift: '',
  PageUp: '', PageDown: '', End: '', Home: '', ArrowUp: '', ArrowDown: '' };

export class Ui {
  constructor(gecko) {
    this.b = gecko;
  }

  /**
   * finder: a function (serialised into the page) returning the element to act on, or a CSS selector.
   * Marks it with data-e2e-target and scrolls it to the middle of the viewport. Returns false when not found.
   */
  async mark(finder, ...args) {
    const find = typeof finder === 'function' ? `(${finder.toString()})(...${JSON.stringify(args)})` : `document.querySelector(${JSON.stringify(finder)})`;
    return this.b.eval(`(() => {
      for (const n of document.querySelectorAll('[data-e2e-target]')) n.removeAttribute('data-e2e-target');
      const el = ${find};
      if (!el) return false;
      el.setAttribute('data-e2e-target', '1');
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      return true;
    })()`);
  }

  async #sharedId() {
    const { nodes } = await this.b.send('browsingContext.locateNodes', {
      context: this.b.context,
      locator: { type: 'css', value: '[data-e2e-target]' },
      maxNodeCount: 1,
    });
    if (!nodes.length) throw new Error('marked element disappeared before the click');
    return nodes[0].sharedId;
  }

  /** A real mouse click (pointer move to the element's centre, press, release). Returns false when not found. */
  async click(finder, ...args) {
    if (!(await this.mark(finder, ...args))) return false;
    const sharedId = await this.#sharedId();
    await this.b.send('input.performActions', {
      context: this.b.context,
      actions: [
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: 0, y: 0, origin: { type: 'element', element: { sharedId } } },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ],
    });
    await this.b.send('input.releaseActions', { context: this.b.context });
    await this.b.eval(`(() => { for (const n of document.querySelectorAll('[data-e2e-target]')) n.removeAttribute('data-e2e-target'); return true; })()`);
    return true;
  }

  /** A real mouse click at a point of the viewport (CSS pixels), e.g. on a dialog's backdrop. */
  async clickAt(x, y) {
    await this.b.send('input.performActions', {
      context: this.b.context,
      actions: [
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport' },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ],
    });
    await this.b.send('input.releaseActions', { context: this.b.context });
  }

  /** A real mouse-wheel turn at a point of the viewport (CSS pixels); deltaY > 0 scrolls down. */
  async wheelAt(x, y, deltaY) {
    await this.b.send('input.performActions', {
      context: this.b.context,
      actions: [{ type: 'wheel', id: 'wheel', actions: [{ type: 'scroll', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY, origin: 'viewport' }] }],
    });
    await this.b.send('input.releaseActions', { context: this.b.context });
  }

  /** Types text into whatever has the focus, one key at a time. */
  async type(text) {
    const actions = [];
    for (const ch of [...text]) actions.push({ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch });
    await this.b.send('input.performActions', { context: this.b.context, actions: [{ type: 'key', id: 'kb', actions }] });
    await this.b.send('input.releaseActions', { context: this.b.context });
  }

  /** Presses a named key (Enter, Escape, Tab, Backspace, PageDown, ArrowDown, Home, End, …) or a chord like 'Control+a'. */
  async press(chord) {
    const parts = chord.split('+').map((k) => KEYS[k] || k);
    const actions = [...parts.map((v) => ({ type: 'keyDown', value: v })), ...parts.reverse().map((v) => ({ type: 'keyUp', value: v }))];
    await this.b.send('input.performActions', { context: this.b.context, actions: [{ type: 'key', id: 'kb', actions }] });
    await this.b.send('input.releaseActions', { context: this.b.context });
  }

  /** Clicks the button whose visible text matches re, inside the element matched by scope (CSS). */
  clickButton(scope, re) {
    return this.click(
      (sc, src, flags) => {
        const r = new RegExp(src, flags);
        const roots = [...document.querySelectorAll(sc)];
        for (const root of roots.reverse()) {
          const btn = [...root.querySelectorAll('button, [role="button"], [role="menuitem"]')].find((b) => r.test(b.textContent.trim()) && b.offsetParent !== null);
          if (btn) return btn;
        }
        return null;
      },
      scope,
      re.source,
      re.flags,
    );
  }
}

// ------------------------------------------------------------------------------------------------ reporting

export class Fail extends Error {}

export class Report {
  constructor(prefix = '') {
    this.prefix = prefix;
    this.results = []; // {status, item, name, reason}
  }

  #print(status, item, name, reason) {
    this.results.push({ status, item, name, reason });
    const tag = item ? `[${item}] ` : '';
    console.log(`${status.padEnd(5)} ${this.prefix}${tag}${name}${reason ? ` — ${reason}` : ''}`);
  }

  pass(item, name, detail) {
    this.#print('PASS', item, name, detail);
  }

  fail(item, name, reason) {
    this.#print('FAIL', item, name, reason);
  }

  info(item, name, detail) {
    this.#print('INFO', item, name, detail);
  }

  /** check(item, name, ok, reasonIfFail, detailIfPass) → ok */
  check(item, name, ok, reason, detail) {
    if (ok) this.pass(item, name, detail);
    else this.fail(item, name, reason);
    return Boolean(ok);
  }

  /** Runs a step; Fail aborts the step as FAIL, anything else as ERROR (a harness problem, result unknown). */
  async step(item, name, fn) {
    try {
      await fn();
    } catch (err) {
      if (err instanceof Fail) this.fail(item, name, err.message);
      else this.#print('ERROR', item, name, `harness error, not verified: ${String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err)}`);
    }
  }

  get failed() {
    return this.results.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
  }

  summary() {
    const count = (s) => this.results.filter((r) => r.status === s).length;
    return `${count('PASS')} passed, ${count('FAIL')} failed, ${count('ERROR')} harness errors, ${count('INFO')} info`;
  }
}

/** Waits until fnOrExpr is truthy in the page; throws Fail(reason) on timeout. */
export async function expectSoon(gecko, fnOrExpr, reason, timeoutMs = 20000, ...args) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await gecko.eval(fnOrExpr, ...args);
    if (v) return v;
    if (Date.now() > end) throw new Fail(reason);
    await delay(100);
  }
}
