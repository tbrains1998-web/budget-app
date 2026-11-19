// Shared browser session for the command-line tools (parse-file.mjs, import-to-backup.mjs). Node 24, no packages.
//
// Privacy rules this module enforces (the tools may run on private bank files):
//   - the app runs in headless Edge on a brand-new profile .tmp/tools/profile-<pid>-<random>; that folder (it holds
//     the app's localStorage, i.e. the imported payments) is deleted at the end, also on errors and Ctrl+C;
//   - only the Edge processes started for that profile are killed (matched by PID, then by the unique profile path);
//   - nothing is written except the built app (no private data) and, for import-to-backup, the --out file;
//   - stdout is left to the caller (one JSON object); progress goes to stderr, without row data.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { APP_ROOT, fileUrl, launchEdge } from '../lib/cdp.mjs';

export const TOOLS_DIR = join(APP_ROOT, '.tmp', 'tools');

export function log(message) {
  process.stderr.write(`${message}\n`);
}

/** File name safe to print: account numbers and long digit runs masked (ING CSV names hold the IBAN). */
export function safeLabel(path) {
  return basename(path).replace(/[A-Z]{2}\d{2}\s?[A-Z]{4}(?:\s?\d){6,}/gi, '…').replace(/\d{6,}/g, '…');
}

export class UsageError extends Error {}

/** Minimal argv parser: flags with one value; everything else is a file. */
export function parseArgs(argv, valueFlags, boolFlags = []) {
  const out = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (boolFlags.includes(a)) {
      out[a.slice(2)] = true;
    } else if (valueFlags.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      out[a.slice(2)] = v;
      i++;
    } else if (a.startsWith('--')) {
      throw new UsageError(`unknown option ${a}`);
    } else {
      out.files.push(a);
    }
  }
  return out;
}

/** Absolute paths of existing, readable regular files (relative paths resolve against the current directory). */
export async function checkInputs(paths) {
  const abs = [];
  for (const p of paths) {
    const full = resolve(process.cwd(), p);
    let s;
    try {
      s = await stat(full);
    } catch {
      throw new UsageError(`file not found: ${safeLabel(p)}`);
    }
    if (!s.isFile()) throw new UsageError(`not a file: ${safeLabel(p)}`);
    abs.push(full);
  }
  return abs;
}

/** --app as given, else a fresh no-seed build in .tmp/tools/Budget.html (build output goes to stderr only). */
export async function appFile(app) {
  if (app) {
    const full = resolve(process.cwd(), app);
    if (!existsSync(full)) throw new UsageError(`--app not found: ${app}`);
    return full;
  }
  await mkdir(TOOLS_DIR, { recursive: true });
  const out = join(TOOLS_DIR, 'Budget.html');
  log('building a no-seed app into .tmp/tools/Budget.html …');
  const r = spawnSync(process.execPath, [join(APP_ROOT, 'build', 'build.mjs'), '--out', out], { cwd: APP_ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    log(String(r.stderr || r.stdout).trim());
    throw new Error('build failed');
  }
  return out;
}

// Last-resort kill of Edge processes whose command line holds our unique profile folder (a launch that failed
// half-way leaves a process that launchEdge never returned).
function killByProfile(dir) {
  const needle = dir.replace(/'/g, "''");
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
  { stdio: 'ignore', windowsHide: true, timeout: 20000 });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// A tool run that was killed hard (Task Manager, taskkill /F) cannot clean up after itself: remove profiles whose
// tool process is gone, together with any Edge still using them.
async function sweepStaleProfiles() {
  let names = [];
  try {
    names = await readdir(TOOLS_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^profile-(\d+)-[0-9a-f]+$/.exec(name);
    if (!m || Number(m[1]) === process.pid || alive(Number(m[1]))) continue;
    const dir = join(TOOLS_DIR, name);
    killByProfile(dir);
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {});
    log(existsSync(dir) ? `WARNING: could not delete a stale temp profile ${dir}` : 'removed a temp profile left by an interrupted earlier run');
  }
}

/**
 * Runs fn(page, info) with the app opened in headless Edge on a throw-away profile; always closes Edge and deletes
 * the profile. info = {seedDropped}. The app starts EMPTY: an embedded demo seed (when --app has one) is wiped.
 */
export async function withApp(appPath, fn, { timeoutMs = 300000 } = {}) {
  await sweepStaleProfiles();
  const profileDir = join(TOOLS_DIR, `profile-${process.pid}-${randomBytes(4).toString('hex')}`);
  let edge = null;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (edge) await edge.close();
    } catch {
      // the browser may already be gone
    }
    killByProfile(profileDir);
    await rm(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {});
    if (existsSync(profileDir)) log(`WARNING: could not delete the temp profile ${profileDir} — delete it by hand (it may hold imported payments).`);
  };
  const onSignal = (sig) => {
    log(`stopped (${sig}), cleaning up …`);
    cleanup().finally(() => process.exit(130));
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'];
  for (const s of signals) process.on(s, onSignal);
  let timer = null;
  try {
    await mkdir(profileDir, { recursive: true });
    edge = await launchEdge({ profileDir, headless: true, width: 1100, height: 900 });
    await edge.open(fileUrl(appPath));
    await edge.waitFor(() => Boolean(window.Budget && Budget.store && Budget.importer && Budget.calc), { timeoutMs: 20000 });
    const seedDropped = await edge.eval(() => {
      const had = Budget.store.get().transactions.length;
      if (had || Budget.store.get().statements.length) Budget.store.reset();
      return had;
    });
    if (seedDropped) log(`note: the app had an embedded seed (${seedDropped} payments); started from an empty budget instead.`);
    const work = fn(edge, { seedDropped });
    const limit = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    });
    return await Promise.race([work, limit]);
  } finally {
    if (timer) clearTimeout(timer);
    await cleanup();
    for (const s of signals) process.off(s, onSignal);
  }
}

/** Puts the files into a fresh <input type=file multiple> of the page (DOM.setFileInputFiles) and returns its id. */
export async function toolInput(edge, files) {
  const id = `tool-files-${randomBytes(3).toString('hex')}`;
  await edge.eval((i) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.id = i;
    input.hidden = true;
    document.body.append(input);
    return true;
  }, id);
  await edge.setFiles(`#${id}`, files);
  return id;
}

/** Restores a backup (object) with store.importBackup; throws with the app's own message when it is invalid. */
export async function restoreBackup(edge, backupText) {
  const r = await edge.eval((text) => {
    try {
      Budget.store.importBackup(text);
      return { ok: true, transactions: Budget.store.get().transactions.length };
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) };
    }
  }, backupText);
  if (!r.ok) throw new UsageError(`the backup cannot be restored: ${r.message}`);
  return r;
}

/** {months:[{month, count, statementCheck, tiles, recap}], normalMonth} from the app's own calc (what the user sees). */
export function summaryInPage() {
  const st = Budget.store.get();
  const { calc } = Budget;
  const months = calc.monthsWithData(st).slice().sort();
  return {
    months: months.map((month) => {
      const s = calc.monthSummary(st, month);
      const { statementCheck, ...recap } = calc.monthRecap(st, month);
      return {
        month,
        count: st.transactions.filter((t) => String(t.date).slice(0, 7) === month).length,
        statementCheck,
        tiles: { income: s.income, fixed: 0 - s.fixed, daily: 0 - s.daily, left: s.left },
        recap,
      };
    }),
    normalMonth: calc.normalMonth(st),
  };
}

/** Prints one JSON object on stdout. */
export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Common main wrapper: usage errors -> exit 2, other errors -> exit 1 (message only, no data). */
export async function main(run, usage) {
  try {
    process.exitCode = (await run()) || 0;
  } catch (err) {
    if (err instanceof UsageError) {
      log(`error: ${err.message}\n\n${usage}`);
      process.exitCode = 2;
    } else {
      log(`error: ${String((err && err.message) || err).replace(/\d{6,}/g, '…').slice(0, 300)}`);
      process.exitCode = 1;
    }
  }
}
