// End-to-end check of the app's main features (numbered check groups) through the REAL UI of the built Budget.html in
// headless Edge (CDP). Node 24, no npm packages. FAKE data only (test/fixtures, seed/demo-seed.json).
//
//   node test/e2e/edge.mjs            -> builds .tmp/e2e-edge/Budget.html (no seed) + .tmp/e2e-edge/Budget-demo.html (demo seed),
//                                       prints PASS/FAIL per check, exit code 1 on any FAIL
//   node test/e2e/edge.mjs --keep     -> keep the downloaded fake backups in .tmp/e2e-edge/downloads
//   node test/e2e/edge.mjs --only=tiles -> build + one part only (seed, tiles, main or robust), for quick runs
//
// Every browser launch uses a brand-new profile under .tmp/e2e-edge/profiles/ (deleted afterwards): one for the demo
// seed, one for the main flow, one for bad files, one with site data blocked (storage disabled) and one with corrupt
// stored JSON. Screenshots (1100 and 400 px, light and dark, plus print) go to .tmp/e2e-edge/shots/.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { APP_ROOT, fileUrl } from '../lib/cdp.mjs';
import { startEdge as launchUi, delay } from './ui.mjs';
import {
  KIND_PILLS, CATEGORY_ORDER, TX_FIELDS, alertsOf, bookedMonths, cents, csvFixture, dailyAvgOf, euro, euroExact, mask,
  monthsWithData, payeeIdOf, pdfFixture, reconcileOf, summaryOf, tilesOf, todayLocal,
} from './expect.mjs';

const OUT = '.tmp/e2e-edge';
const APP = `${OUT}/Budget.html`;
const DEMO = `${OUT}/Budget-demo.html`;
const KEEP = process.argv.includes('--keep');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
const READ_ERROR = "I can't read this file. Is it an ING statement (PDF) or ING download (CSV)?";
const STORAGE_BANNER = 'Your data is NOT being saved in this browser — make a backup';
const BACKUP_BANNER = 'New month read — please make a backup';
const CHECK_OK = '✓ Matches the bank statement';
const F = {
  pdf1: 'test/fixtures/ing-fake-1.pdf',
  pdf2: 'test/fixtures/ing-fake-2.pdf',
  comma: 'test/fixtures/ing-fake-comma.csv',
  semi: 'test/fixtures/ing-fake-semicolon.csv',
  english: 'test/fixtures/ing-fake-english.csv',
  cp1252: 'test/fixtures/ing-fake-cp1252.csv',
  notIng: 'test/fixtures/not-ing.pdf',
  corrupt: 'test/fixtures/corrupt.pdf',
  garbage: 'test/fixtures/garbage.csv',
};

// Every browser this run starts, so Ctrl+C can close them (own PIDs only) and delete their profiles.
const openUis = new Set();
async function startEdge(opts) {
  const ui = await launchUi(opts);
  openUis.add(ui);
  const close = ui.close.bind(ui);
  ui.close = async () => {
    openUis.delete(ui);
    await close();
  };
  return ui;
}

// ------------------------------------------------------------------------------------------------ reporting

const results = [];
const short = (v) => {
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 500 ? `${s.slice(0, 500)}…` : s;
};
function report(item, name, pass, detail = '') {
  results.push({ item, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${item}] ${name}${detail ? ` -- ${detail}` : ''}`);
  return pass;
}
const ok = (item, name, cond, detail = '') => report(item, name, Boolean(cond), detail);
function eq(item, name, actual, expected, detail = '') {
  const pass = isDeepStrictEqual(actual, expected);
  return report(item, name, pass, pass ? detail || short(actual) : `${detail ? `${detail}; ` : ''}got ${short(actual)}, expected ${short(expected)}`);
}
async function step(item, name, fn) {
  try {
    await fn();
  } catch (err) {
    report(item, `${name} (step aborted)`, false, String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 600));
  }
}
function diffPaths(a, b, path = '$', out = []) {
  if (out.length >= 8) return out;
  if (isDeepStrictEqual(a, b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], `${path}.${k}`, out);
    return out;
  }
  out.push(`${path}: ${short(a)} vs ${short(b)}`);
  return out;
}
const sum = (list) => list.reduce((a, b) => a + b, 0);
/** A red hue (light theme #b91c1c / #7f1d1d, dark theme #f87171 / #fca5a5 all qualify). */
function isRed(color) {
  const [r, g, b] = (String(color).match(/\d+/g) || []).map(Number);
  return r - Math.max(g, b) >= 60;
}

// ------------------------------------------------------------------------------------------------ page readers

// Everything the month screen shows (visible DOM text), read in the page.
function readMonth() {
  const T = window.__t;
  const n = T.norm;
  const q = (s, r = document) => r.querySelector(s);
  const qa = (s, r = document) => [...r.querySelectorAll(s)];
  const root = q('#view-month');
  const check = q('.recap-card .check', root);
  return {
    label: n(q('#month-label').textContent),
    empty: Boolean(q('.empty', root)),
    banners: qa('#banners .banner').map((b) => n(b.innerText)),
    tiles: qa('.tile', root).map((t) => ({ cls: t.className, label: n(q('.tile-label', t).textContent), value: n(q('.tile-value', t).textContent) })),
    bar: {
      shortfall: q('.bar-card .shortfall', root) ? n(q('.bar-card .shortfall', root).textContent) : null,
      parts: qa('.bar-card .bar span', root).length,
      legend: qa('.bar-card .legend li', root).map((li) => ({ label: n(li.childNodes[1] ? li.childNodes[1].textContent : ''), value: n(q('strong', li).textContent) })),
    },
    save: q('.save-card', root) ? {
      title: n(q('.save-card h2', root).textContent),
      big: n(q('.save-card .save-big', root).textContent),
      lines: qa('.save-card dl.sum > div', root).map((d) => ({ label: n(q('dt', d).textContent), value: n(q('dd', d).textContent), cls: d.className })),
      goal: q('#goal-bar') ? n(q('#goal-bar').innerText) : null,
      goalFill: q('#goal-bar .x-goal-fill') ? q('#goal-bar .x-goal-fill').style.width : null,
    } : null,
    recap: q('.recap-card', root) ? {
      rows: qa('.recap-card table.recap tr', root).map((tr) => ({ label: n(q('th', tr).textContent), value: n(q('td', tr).textContent), saldo: tr.classList.contains('saldo') })),
      change: n(q('.recap-card .recap-change', root) && q('.recap-card .recap-change', root).textContent),
      check: check ? { text: n(check.textContent), ok: check.classList.contains('ok'), color: getComputedStyle(check).color } : null,
    } : null,
    groups: qa('.list-card section.group', root).map((g) => ({
      cat: g.dataset.cat,
      name: n(q('.gname', g).textContent),
      note: n(q('.gnote', g) && q('.gnote', g).textContent),
      total: n(q('.gtotal', g).textContent),
      totalColor: getComputedStyle(q('.gtotal', g)).color,
      alert: g.classList.contains('x-alert'),
      badges: qa('.badges .x-badge', g).map((b) => n(b.textContent)),
      rows: qa('.tx', g).map((r) => ({
        id: r.dataset.id,
        date: n(q('.tx-date', r).textContent),
        name: n(q('.tx-name', r).textContent),
        desc: n(q('.tx-desc', r) && q('.tx-desc', r).textContent),
        note: n(q('.tx-note', r) && q('.tx-note', r).textContent),
        pill: n(q('.pill', r).textContent),
        amount: n(q('.tx-amount', r).textContent),
        amountIn: q('.tx-amount', r).classList.contains('amount-in'),
        faded: r.classList.contains('faded'),
        opacity: getComputedStyle(r).opacity,
      })),
    })),
    prevHidden: q('#prev-month').hidden,
    nextHidden: q('#next-month').hidden,
    prevDisabled: q('#prev-month').disabled,
    nextDisabled: q('#next-month').disabled,
    allHidden: q('#btn-all').hidden,
  };
}

// WCAG contrast of every visible text element under rootSel (colour vs composited background, opacity included).
function contrastReport(rootSel) {
  const root = document.querySelector(rootSel);
  if (!root) return { checked: 0, failures: [], unknown: 0 };
  const parse = (c) => {
    let m = /^rgba?\(([^)]+)\)$/.exec(c);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    m = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(c);
    if (m) return { r: m[1] * 255, g: m[2] * 255, b: m[3] * 255, a: m[4] === undefined ? 1 : Number(m[4]) };
    return null;
  };
  const over = (top, under) => {
    const a = top.a + under.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const ch = (k) => (top[k] * top.a + under[k] * under.a * (1 - top.a)) / a;
    return { r: ch('r'), g: ch('g'), b: ch('b'), a };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const canvas = parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  const base = canvas.a === 1 ? canvas : over(canvas, matchMedia('(prefers-color-scheme: dark)').matches ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 });
  const failures = [];
  let checked = 0;
  let unknown = 0;
  const els = [root, ...root.querySelectorAll('*')];
  for (const el of els) {
    if (el.closest('svg, script, style, [hidden], [aria-hidden="true"]')) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
    if (!own || !window.__t.visible(el)) continue;
    if (el.closest('[disabled]')) continue; // rows that do not count (.faded) are checked too
    const chain = [];
    let opacity = 1;
    for (let a = el; a; a = a.parentElement) { chain.push(a); opacity *= Number(getComputedStyle(a).opacity); }
    let bg = base;
    let complex = false;
    for (let i = chain.length - 1; i >= 0; i--) {
      const cs = getComputedStyle(chain[i]);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') complex = true;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) bg = over(c, bg);
    }
    const cs = getComputedStyle(el);
    const fg0 = parse(cs.color);
    if (!fg0) { unknown++; continue; }
    const fg = over({ ...fg0, a: fg0.a * opacity }, bg);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    const r = ratio(fg, bg);
    checked++;
    if (r + 1e-6 < need) {
      failures.push({ text: own.slice(0, 40), ratio: Math.round(r * 100) / 100, need, fg: cs.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`, complex, el: window.__t.describe(el).slice(0, 80) });
    }
  }
  return { checked, failures, unknown };
}

// UI text (data rows removed) + labels/titles/placeholders, for the "English everywhere" check. Text nodes are joined
// with spaces (textContent would glue "null" + "Income" into one word that \bnull\b never matches).
function uiTexts() {
  const clone = document.body.cloneNode(true);
  for (const n of clone.querySelectorAll('.tx-name, .tx-desc, .pop-title, .pop-sub, .nm-name, .x-rule-text, script, style, noscript, #drop-overlay[hidden]')) n.remove();
  for (const n of clone.querySelectorAll('[hidden]')) n.remove();
  const attrs = [...document.querySelectorAll('[aria-label], [title], [placeholder]')]
    .filter((e) => !e.closest('[hidden]'))
    .flatMap((e) => ['aria-label', 'title', 'placeholder'].map((a) => e.getAttribute(a)).filter(Boolean))
    .filter((t) => !/^Payment: |^Amount of |^Normal amount for /.test(t));
  const words = [];
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) words.push(n.nodeValue);
  return { text: words.join(' ').replace(/\s+/g, ' '), attrs, lang: document.documentElement.lang, title: document.title };
}

// Elements sticking out of the viewport (outside scroll containers) and the page's own horizontal scroll.
function overflowReport() {
  const vw = document.documentElement.clientWidth;
  const out = [];
  const scrollers = (el) => {
    for (let a = el.parentElement; a; a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
    }
    return false;
  };
  for (const el of document.querySelectorAll('body *')) {
    if (!window.__t.visible(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !scrollers(el) && getComputedStyle(el).position !== 'fixed') out.push({ el: window.__t.describe(el).slice(0, 80), left: Math.round(r.left), right: Math.round(r.right) });
  }
  return { vw, scrollWidth: document.documentElement.scrollWidth, overflow: out.slice(0, 6), count: out.length };
}

// Dutch words the screens used to show, plus broken values. Payee names and descriptions are fake Dutch bank data
// and are removed by uiTexts() first.
const DUTCH_UI = /\b(het|een|niet|geen|nog|jouw|je|deze|maand|maanden|betaling|betalingen|bedrag|opslaan|annuleren|sluiten|verwijderen|toevoegen|wijzigen|inkomsten|uitgaven|instellingen|ongedaan|kiezen|wissen|klaar|terugzetten|afdrukken|spaardoel|undefined|null|NaN|Infinity|\[object)\b/;

// ------------------------------------------------------------------------------------------------ UI helpers

const btn = (text, within = '#dialog-root .dialog-actions') => ({ css: `${within} button`, text });
const rowPart = (name, part) => ({ css: '#view-month .tx', re: name, child: part });

async function month(ui) {
  return ui.eval(readMonth);
}

/** Opens month M with the ◀ ▶ buttons (real clicks), at most 24 steps. */
async function goMonth(ui, M) {
  for (let i = 0; i < 24; i++) {
    const cur = await ui.eval(() => Budget.store && window.__t.norm(document.getElementById('month-label').textContent));
    const months = await ui.eval(() => Budget.calc.monthsWithData(Budget.store.get()).slice().sort());
    const want = months.indexOf(M);
    const at = months.findIndex((m) => Budget_label(m) === cur);
    if (at === want) return;
    await ui.click({ css: at < want ? '#next-month' : '#prev-month' });
  }
  throw new Error(`could not reach month ${M}`);
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function Budget_label(m) {
  return `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
}

async function openMenuItem(ui, label) {
  await ui.click({ css: '#btn-menu' });
  await ui.click({ css: '#menu-root .menu-item', text: label });
}

async function waitToast(ui, re, timeoutMs = 5000) {
  await ui.waitFor(`window.__t.toasts().some((t) => ${re}.test(t))`, { timeoutMs });
  return ui.toasts();
}

/** Month screen checks shared by several items: tiles, savings card and recap against independent values. */
async function checkMonthScreen(ui, item, M, tag) {
  const st = await ui.state();
  const v = await month(ui);
  const s = summaryOf(st, M);
  eq(item, `${tag}: month label`, v.label, Budget_label(M));
  eq(item, `${tag}: tile labels`, v.tiles.map((t) => t.label), ['Income', 'Fixed costs', 'Daily spending', 'One-off', 'Left this month']);
  eq(item, `${tag}: tile values (cents, sign-free for costs)`, v.tiles.map((t) => cents(t.value)).map((c, i) => (i >= 1 && i <= 3 ? Math.abs(c) : c)),
    [s.income, Math.abs(s.fixed), Math.abs(s.daily), Math.abs(s.oneoff), s.left]);
  const rec = reconcileOf(st, M);
  if (rec.statement) {
    const rows = v.recap.rows;
    const start = rows.find((r) => r.label === 'Balance at start of month');
    const end = rows.find((r) => r.label === 'Balance at end of month');
    const body = sum(rows.filter((r) => !r.saldo).map((r) => cents(r.value)));
    eq(item, `${tag}: recap saldo rows = statement`, [start && cents(start.value), end && cents(end.value)], [rec.statement.startBalance, rec.statement.endBalance]);
    eq(item, `${tag}: recap rows add up to end − start (shown values)`, body, rec.statement.endBalance - rec.statement.startBalance);
    eq(item, `${tag}: recap check shown ✓ iff the bank payments reconcile`, Boolean(v.recap.check && v.recap.check.ok), rec.ok, `independent diff ${rec.diff}`);
  }
  return { st, v, s };
}

// ------------------------------------------------------------------------------------------------ item 1: build

async function buildApps() {
  mkdirSync(resolve(APP_ROOT, OUT), { recursive: true });
  const run = (args) => spawnSync(process.execPath, ['build/build.mjs', ...args], { cwd: APP_ROOT, encoding: 'utf8' });
  const a = run(['--out', APP]);
  const b = run(['--seed', 'seed/demo-seed.json', '--out', DEMO]);
  ok(1, 'build (no seed) exits 0', a.status === 0, (a.stdout + a.stderr).split('\n')[0]);
  ok(1, 'build (demo seed) exits 0', b.status === 0, (b.stdout + b.stderr).split('\n')[0]);
  for (const file of [APP, DEMO]) {
    const html = readFileSync(resolve(APP_ROOT, file), 'utf8');
    const outside = html.replace(/<script type="text\/plain" id="pdfjs-(?:lib|worker)">[\s\S]*?<\/script>/g, '');
    const urls = [...outside.matchAll(/\bhttps?:\/\/[^\s"'`<>)\\]+/gi)].map((m) => m[0]);
    const allowed = new Set(['http://www.w3.org/2000/svg']);
    eq(1, `${file}: no http(s) URLs outside the two pdf.js blocks (XML namespace names allowed)`, urls.filter((u) => !allowed.has(u)), []);
    ok(1, `${file}: single file (no <link>, no <script src>, no external src/href)`,
      !/<link\b/i.test(outside) && !/<script\b[^>]*\bsrc\s*=/i.test(outside) && !/\b(?:src|href)\s*=\s*["'](?!#|data:|blob:)[^"']+["']/i.test(outside.replace(/<svg[\s\S]*?<\/svg>/g, '')));
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
    ok(1, `${file}: CSP meta present and strict`, csp && /default-src 'none'/.test(csp[1]) && !/unsafe-eval|https?:|\*/.test(csp[1]) && /connect-src blob: data:/.test(csp[1]), csp ? csp[1] : 'missing');
    ok(1, `${file}: CSP meta comes before any script`, csp && html.indexOf(csp[0]) < html.indexOf('<script'));
    eq(1, `${file}: pdf.js lib + worker embedded once each`, [(html.match(/id="pdfjs-lib"/g) || []).length, (html.match(/id="pdfjs-worker"/g) || []).length], [1, 1]);
  }
  ok(1, 'build output is ONE file (only the html is written)', existsSync(resolve(APP_ROOT, APP)) && existsSync(resolve(APP_ROOT, DEMO)));
}

async function sessionHealth(ui, item, tag, { allowErrors = [] } = {}) {
  const errors = ui.errors().filter((e) => !allowErrors.some((re) => re.test(e.text)));
  eq(item, `${tag}: no console errors / uncaught exceptions`, errors.map((e) => `${e.source}: ${e.text.slice(0, 160)}`), []);
  eq(item, `${tag}: no network requests leaving the machine`, ui.externalRequests().map((r) => r.url), []);
  eq(item, `${tag}: no CSP violations`, await ui.violations(), []);
}

// ------------------------------------------------------------------------------------------------ demo seed

async function seedRun() {
  const seed = JSON.parse(readFileSync(resolve(APP_ROOT, 'seed/demo-seed.json'), 'utf8'));
  const ui = await startEdge({ label: 'seed', root: OUT });
  try {
    await ui.open(fileUrl(DEMO));
    await step(2, 'demo seed first run', async () => {
      const latest = bookedMonths(seed.state).at(-1); // the newest month the bank booked
      const v = await month(ui);
      eq(2, 'demo seed: first run opens its latest month', v.label, Budget_label(latest));
      const st = await ui.state();
      ok(2, 'demo seed: state = seed state (loaded unchanged)', isDeepStrictEqual(st, seed.state), diffPaths(st, seed.state).join(' | '));
      const stored = await ui.eval(() => localStorage.getItem('budget-nl:v1'));
      ok(2, 'demo seed: saved to storage on first run', stored && isDeepStrictEqual(JSON.parse(stored), st));
      ok(2, 'demo seed: month screen has tiles, savings card, recap and list', v.tiles.length === 5 && v.save && v.recap && v.groups.length > 0);
      eq(2, 'demo seed: prev enabled, next disabled on the latest month', [v.prevDisabled, v.nextDisabled], [false, true]);
    });
    await step(16, 'demo seed screenshots + layout', async () => {
      for (const width of [1100, 400]) {
        for (const scheme of ['light', 'dark']) await ui.shot('seed-month', { width, scheme });
      }
    });
    for (const M of monthsWithData(seed.state)) {
      await step(11, `demo seed ${M} recap`, async () => {
        await goMonth(ui, M);
        const { v } = await checkMonthScreen(ui, 11, M, `seed ${M}`);
        eq(11, `seed ${M}: "✓ Matches" text`, v.recap.check && v.recap.check.text, CHECK_OK);
      });
      await step(12, `demo seed ${M} alerts`, async () => {
        const st = await ui.state();
        const v = await month(ui);
        const want = alertsOf(st, M);
        const shown = v.groups.filter((g) => g.badges.length).map((g) => g.cat).sort();
        eq(12, `seed ${M}: "Higher than normal" badges on exactly the categories the alert rule gives`, shown, want.map((a) => a.categoryId).sort(), want.length ? `diffs ${want.map((a) => `${a.categoryId}:${Math.round(a.diff)}`).join(',')}` : 'none expected');
        for (const a of want) {
          const g = v.groups.find((x) => x.cat === a.categoryId);
          const m = g && /^Higher than normal \(\+€([\d,]+)\)$/.exec(g.badges[0] || '');
          ok(12, `seed ${M}: badge text for ${a.categoryId}`, m && Math.abs(Number(m[1].replace(/,/g, '')) * 100 - a.diff) <= 100, g && g.badges[0]);
        }
      });
    }
    await step(12, 'demo seed goal bar', async () => {
      const st = await ui.state();
      const M = monthsWithData(st).at(-1);
      await goMonth(ui, M);
      const v = await month(ui);
      const left = summaryOf(st, M).left;
      const goal = st.settings.savingsGoal;
      const pct = Math.max(0, Math.round((left * 100) / goal));
      ok(12, 'seed: savings goal bar "€x of €goal — pct%"', v.save.goal && v.save.goal.includes(`${euro(left, { whole: true })} of ${euro(goal, { whole: true })} — ${pct}%`), v.save.goal);
    });
    await step(2, 'seed only on empty storage', async () => {
      const before = (await ui.state()).transactions.length;
      await ui.click({ css: '#view-month .tx', nth: 0, child: '.tx-date' });
      await ui.click({ css: '#popover-root button', text: 'Delete' });
      await delay(400);
      await ui.reload();
      const after = (await ui.state()).transactions.length;
      eq(2, 'seed is not loaded again once storage holds data (deleted row stays deleted after reload)', after, before - 1);
    });
    await step(1, 'demo seed session health', () => sessionHealth(ui, 1, 'demo seed (Edge)'));
  } finally {
    await ui.close();
  }
}

// ------------------------------------------------------------------------------------------------ main flow

async function mainRun() {
  const ui = await startEdge({ label: 'main', root: OUT, download: true });
  const pdf1 = pdfFixture('ing-fake-1');
  const pdf2 = pdfFixture('ing-fake-2');
  const comma = csvFixture(F.comma);
  const semi = csvFixture(F.semi);
  const english = csvFixture(F.english);
  const cp = csvFixture(F.cp1252);
  const ctx = {};
  try {
    await ui.open(fileUrl(APP));

    // ---- item 2: empty first run
    await step(2, 'empty first run', async () => {
      const v = await month(ui);
      ok(2, 'no seed: empty state shown', v.empty && v.groups.length === 0 && v.tiles.length === 0);
      eq(2, 'no seed: title stays "Budget", no month switcher, no "All months"', [v.label, v.prevHidden, v.nextHidden, v.allHidden], ['Budget', true, true, true]);
      const dz = await ui.eval(() => {
        const d = document.querySelector('#view-month .dropzone');
        const r = d && d.getBoundingClientRect();
        return d && { text: window.__t.norm(d.innerText), w: r.width, h: r.height, vw: innerWidth };
      });
      ok(2, 'no seed: big drop zone ("Drag your bank statement here")', dz && /Drag your bank statement here/.test(dz.text) && dz.h >= 150 && dz.w >= 0.5 * Math.min(dz.vw, 1000), short(dz));
      eq(2, 'no seed: nothing written to storage on first run', await ui.eval(() => localStorage.getItem('budget-nl:v1')), null);
      for (const width of [1100, 400]) for (const scheme of ['light', 'dark']) await ui.shot('empty', { width, scheme });
    });

    // ---- item 3: PDF via the "Add bank file" button
    await step(3, 'PDF import via button', async () => {
      await ui.chooseFiles([F.pdf1], { css: '#btn-import' });
      const d = await ui.waitDialog(/found/);
      eq(3, 'PDF: review dialog buttons', d.buttons, ['Add', 'Cancel']);
      ok(3, 'PDF: "14 payments found (Sep 2026)"', d.body.includes('14 payments found (Sep 2026)'), d.body);
      ok(3, 'PDF: "✓ Totals match the statement"', d.body.includes('✓ Totals match the statement'));
      ctx.dialogUnknown = Number((/(\d+) not sorted yet/.exec(d.body) || [])[1]);
      for (const width of [1100, 400]) for (const scheme of ['light', 'dark']) await ui.shot('review-dialog', { width, scheme, fullPage: false });
      await ui.click(btn('Cancel'));
      await ui.waitNoDialog();
      eq(3, 'PDF: [Cancel] adds nothing', (await ui.state()).transactions.length, 0);

      await ui.chooseFiles([F.pdf1], { css: '#btn-import' });
      await ui.waitDialog(/found/);
      await ui.click(btn('Add'));
      await ui.waitFor(() => document.getElementById('month-label').textContent === 'September 2026', { timeoutMs: 5000 });
      const st = await ui.state();
      const got = st.transactions.map((t) => ({ date: t.date, name: t.name, type: t.type, amount: t.amount, bankCode: t.bankCode }));
      const want = pdf1.rows.map((r) => ({ date: r.date, name: mask(r.rawName), type: r.type, amount: r.amount, bankCode: r.bankCode }));
      const key = (r) => `${r.date}|${r.amount}`;
      eq(3, 'PDF: every row parsed (date, name, type, amount, bank code)', got.sort((a, b) => key(a).localeCompare(key(b))), want.sort((a, b) => key(a).localeCompare(key(b))));
      eq(3, 'PDF: rows match the fixture\'s expected.json too', pdf1.expected.rows.map((r) => `${r.date}|${r.rawName}|${r.type}|${r.amount}`).sort(), pdf1.rows.map((r) => `${r.date}|${r.rawName}|${r.type}|${r.amount}`).sort(), 'fixture sanity');
      const s = st.statements.find((x) => x.month === '2026-09');
      eq(3, 'PDF: statement stored (period, balances, totals)', s && { periodFrom: s.periodFrom, periodTo: s.periodTo, startBalance: s.startBalance, endBalance: s.endBalance, totalIn: s.totalIn, totalOut: s.totalOut, source: s.source },
        { ...pdf1.expected.statement, source: 'pdf' });
      eq(3, 'PDF: payments only have the known fields (no IBAN / raw text kept)', [...new Set(st.transactions.map((t) => Object.keys(t).sort().join(',')))], [TX_FIELDS.join(',')]);
      ok(3, 'PDF: fingerprints are fp_<sha-256 hex>', st.transactions.every((t) => /^fp_[0-9a-f]{64}$/.test(t.fingerprint)));
      const wrongPayee = st.transactions.filter((t) => !pdf1.rows.some((r) => r.date === t.date && r.amount === t.amount && payeeIdOf(r.rawName) === t.payeeId));
      eq(3, 'PDF: payeeId = p_ + FNV-1a 64 of the raw bank name', wrongPayee.map((t) => `${t.date} ${t.name} ${t.payeeId}`), []);
      ok(3, 'PDF: source pdf, month = booking month', st.transactions.every((t) => t.source === 'pdf' && t.month === t.date.slice(0, 7)));
      const bad = st.transactions.filter((t) => /[A-Z]{2}\d{2}[A-Z]{4}\d{6,}|\d{6,}|Kenmerk|Machtiging|Incassant|Pasvolgnr|Transactie|Term\s*:|Valutadatum|IBAN|BIC|Datum\s*\/\s*Tijd|Relatienummer/i.test(`${t.name} ${t.description}`));
      eq(3, 'PDF: descriptions cleaned (no IBAN/ids/value dates, ≥6-digit runs masked)', bad.map((t) => `${t.name}: ${t.description}`), []);
      const omsMissing = pdf1.rows.filter((r) => r.omschrijving).filter((r) => {
        const t = st.transactions.find((x) => x.date === r.date && x.amount === r.amount);
        return !t || !t.description.startsWith(r.omschrijving.split(' ')[0]);
      });
      eq(3, 'PDF: the Omschrijving text is kept as the short description', omsMissing.map((r) => r.rawName), []);
      const stored = await ui.eval(() => localStorage.getItem('budget-nl:v1') || '');
      const dom = await ui.eval(() => document.body.innerText);
      const leaks = [...pdf1.holder, 'NL00TEST', 'NL00INGB', 'NL00ZZZ', 'MDT000123'].filter((x) => stored.includes(x) || dom.includes(x) || JSON.stringify(st).includes(x));
      eq(3, 'PDF: holder name/address, IBANs and mandate ids appear nowhere (state, storage, screen)', leaks, []);
      const v = await month(ui);
      eq(3, 'PDF: 14 rows on screen', sum(v.groups.map((g) => g.rows.length)), 14);
      const t30 = v.groups.flatMap((g) => g.rows).find((r) => r.date === '30 Sep');
      ok(3, 'PDF: row shows date "30 Sep", name, pill and amount', t30 && t30.name === 'Naar Oranje spaarrekening X…' && t30.pill === "doesn't count" && t30.amount === '−€150.00', short(t30));
      const plus = v.groups.flatMap((g) => g.rows).find((r) => r.name === 'Werkgever Voorbeeld BV');
      ok(3, 'PDF: money in is green with "+"', plus && plus.amount === '+€1,312.40' && plus.amountIn, short(plus));
      const raw = await ui.eval(() => [...document.querySelectorAll('#view-month .tx-amount')].map((b) => b.textContent));
      const wraps = raw.filter((t) => !/^([+−]⁠)?€\d{1,3}(,\d{3})*\.\d{2}$/.test(t));
      eq(21, 'money on screen has no space after € and a word joiner after the sign', wraps, [], `${raw.length} amounts, e.g. ${JSON.stringify(raw[0])}`);
      eq(21, 'row amount text = formatEuro exactly', raw.includes(euroExact(131240, { sign: true })), true);
      ok(13, 'backup reminder banner shown after an import', v.banners.includes(`${BACKUP_BANNER} Make backup`), short(v.banners));
      ok(3, 'PDF: toast "14 payments added."', (await ui.toasts()).includes('14 payments added.'));
      await checkMonthScreen(ui, 3, '2026-09', 'after PDF');
    });

    // ---- item 6: unknown payees -> "Not sorted yet" -> category + rule
    await step(6, 'Not sorted yet + rules', async () => {
      const st = await ui.state();
      const unknown = st.transactions.filter((t) => t.categoryId === 'onbekend');
      eq(6, 'review dialog "N not sorted yet" = unknown payments stored', ctx.dialogUnknown, unknown.length);
      const v = await month(ui);
      eq(6, '"Not sorted yet" group is shown FIRST', v.groups[0] && v.groups[0].cat, 'onbekend');
      eq(6, '"Not sorted yet" group title + hint', v.groups[0] && [v.groups[0].name, v.groups[0].note], [`Not sorted yet (${unknown.length})`, 'Click a payment to choose what it is']);
      eq(6, 'other groups follow the usual category order', v.groups.slice(1).map((g) => g.cat), CATEGORY_ORDER.filter((c) => v.groups.some((g) => g.cat === c) && c !== 'onbekend'));
      // the question is asked inline, right under the payment's row in its new group.
      const pick = async (name, category, answer) => {
        await ui.click(rowPart(name, '.tx-date'));
        await ui.click({ css: '#popover-root .choice', text: category });
        const prompt = await ui.text({ css: '#view-month .inline-prompt span' });
        ok(6, `${name} -> ${category}: asks "Always do this for '${name}'?"`, prompt === `Always do this for '${name}'?`, prompt);
        await ui.click({ css: '#view-month .inline-prompt button', text: answer });
        await ui.key('Escape');
      };
      await pick('Huisbaas BV', 'Rent', 'Yes');
      await pick('Werkgever Voorbeeld BV', 'Income', 'Yes');
      await pick('Energiebedrijf Test BV', 'Fixed costs & subscriptions', 'Yes');
      await pick('Telecom Test BV', 'Fixed costs & subscriptions', 'Yes');
      await pick('Webwinkel Test', 'One-off', 'Only this one');
      const after = await ui.state();
      eq(6, '[Yes] made 4 rules, [Only this one] none', after.rules.length, 4);
      const huur = after.rules.find((r) => /huisbaas/i.test(r.match.nameContains || ''));
      eq(6, 'rule for Huisbaas BV', huur && { match: huur.match, set: huur.set }, { match: { nameContains: 'Huisbaas BV', bankCode: 'TEST', sign: 'out' }, set: { categoryId: 'huur', kind: 'elke-maand' } });
      const tx = (n) => after.transactions.find((t) => t.name === n);
      eq(6, 'changed payments got category + default kind', ['Huisbaas BV', 'Werkgever Voorbeeld BV', 'Energiebedrijf Test BV', 'Webwinkel Test'].map((n) => `${tx(n).categoryId}/${tx(n).kind}`),
        ['huur/elke-maand', 'inkomen/elke-maand', 'vast/elke-maand', 'eenmalig/eenmalig']);
      const v2 = await month(ui);
      eq(6, '"Not sorted yet" group now holds only the untouched payee', v2.groups[0].cat === 'onbekend' ? v2.groups[0].rows.map((r) => r.name) : [], ['J. Jansen']);
    });

    // ---- the open "Not sorted yet" payments in the plan; the popover after a category pick
    await step(6, 'unknowns in the plan + popover after a category pick', async () => {
      const st = await ui.state();
      const planMonths = bookedMonths(st).slice(-3);
      const kinds = new Map(st.categories.map((c) => [c.id, c.kind]));
      const open = st.transactions.filter((t) => planMonths.includes(t.month) && t.kind !== 'telt-niet-mee' && (kinds.get(t.categoryId) || 'unknown') === 'unknown').length;
      const line = await ui.eval(() => [...document.querySelectorAll('.save-card .save-unknown')].map((p) => window.__t.norm(p.textContent)));
      eq('extra8', 'savings card: ONE muted line "N payments still to sort — then this number is right"', line, [`${open} ${open === 1 ? 'payment' : 'payments'} still to sort — then this number is right`]);
      for (const [w, h] of [[400, 860], [1100, 650]]) {
        await ui.page.setViewport(w, h);
        await ui.settle(100);
        await ui.click(rowPart('J\\. Jansen', '.tx-date'));
        await ui.click({ css: '#popover-root .choice', text: 'One-off' });
        await ui.settle(100);
        const g = await ui.eval(() => {
          const row = document.querySelector('#view-month .tx.is-asking');
          const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; };
          const toasts = [...document.querySelectorAll('#toast-root .toast')].map(rect);
          const prompt = row && row.nextElementSibling && row.nextElementSibling.matches('.inline-prompt') ? row.nextElementSibling : null;
          const yes = prompt && prompt.querySelector('button');
          const at = yes && yes.getBoundingClientRect();
          return {
            row: row && rect(row), rowName: row && window.__t.norm(row.querySelector('.tx-name').textContent), rowCat: row && row.closest('.group').dataset.cat,
            prompt: prompt && rect(prompt), question: prompt && window.__t.norm(prompt.querySelector('span').textContent), toasts, vh: innerHeight,
            popover: Boolean(document.querySelector('#popover-root .popover')), focus: document.activeElement && document.activeElement.textContent,
            yesOnTop: at && prompt.contains(document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2)),
          };
        });
        const overlap = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        ok('extra14', `${w}×${h}: after the pick the payment's row is highlighted in its new group and fully in view`, g.row && g.rowName === 'J. Jansen' && g.rowCat === 'eenmalig' && g.row.top >= 0 && g.row.bottom <= g.vh, short(g));
        ok('extra14', `${w}×${h}: "Always do this for 'J. Jansen'?" right under that row, in view, [Yes] focused`, g.question === "Always do this for 'J. Jansen'?" && g.prompt.top >= g.row.bottom - 1 && g.prompt.bottom <= g.vh && g.focus === 'Yes' && !g.popover, short(g));
        ok('extra14', `${w}×${h}: no toast lies over the row or the question`, g.toasts.length > 0 && !g.toasts.some((t) => overlap(t, g.prompt) || overlap(t, g.row)) && g.yesOnTop, short({ row: g.row, prompt: g.prompt, toasts: g.toasts }));
        await ui.page.screenshot(join(OUT, 'shots', `rule-question-after-pick-${w}x${h}.png`));
        await ui.click({ css: '#toast-root .toast', re: '^Now in One-off', child: '.toast-action' });
        eq('extra14', `${w}×${h}: undo puts J. Jansen back in "Not sorted yet"`, (await ui.state()).transactions.find((t) => t.name === 'J. Jansen').categoryId, 'onbekend');
        eq('extra14', `${w}×${h}: and the question about the undone pick is gone`, await ui.eval(() => document.querySelectorAll('#view-month .inline-prompt, #view-month .tx.is-asking').length), 0);
      }
      await ui.page.setViewport(1100, 900);
      await ui.settle(100);
    });

    // ---- item 7: inline edits (amount + name), live recalculation, survive reload
    await step(7, 'inline amount edit', async () => {
      const before = await ui.state();
      const v0 = await month(ui);
      await ui.click(rowPart('DROGIST', '.tx-amount'));
      eq(7, 'amount editor opens with the plain amount', await ui.eval(() => document.activeElement && document.activeElement.value), '12.35');
      await ui.type('1,234.56');
      await ui.key('Enter');
      const after = await ui.state();
      const drog = after.transactions.find((t) => t.name.startsWith('DROGIST'));
      eq(7, '"1,234.56" + Enter -> −123456 cents (direction kept)', drog.amount, -123456);
      const v1 = await month(ui);
      const delta = -123456 + 1235;
      eq(7, 'tile "Daily spending" updates instantly', Math.abs(cents(v1.tiles[2].value)) - Math.abs(cents(v0.tiles[2].value)), -delta);
      eq(7, 'tile "Left this month" updates instantly', cents(v1.tiles[4].value) - cents(v0.tiles[4].value), delta);
      const leg = (v) => cents((v.bar.legend.find((l) => l.label === 'Daily spending') || {}).value);
      eq(7, 'colour bar legend updates', leg(v1) - leg(v0), -delta);
      const sl = (v, l) => cents(v.save.lines.find((x) => x.label === l).value);
      eq(7, 'savings card "Daily (average)" updates (= expected average)', sl(v1, 'Daily (average)'), dailyAvgOf(after));
      const rd = (v) => cents((v.recap.rows.find((r) => r.label === 'Daily spending') || {}).value);
      eq(7, 'recap "Daily spending" updates', rd(v1) - rd(v0), delta);
      ok(7, 'shows on the row as "−€1,234.56"', v1.groups.flatMap((g) => g.rows).some((r) => r.name.startsWith('DROGIST') && r.amount === '−€1,234.56'));
      ok(11, 'recap turns into a red warning once an amount no longer matches the statement', v1.recap.check && !v1.recap.check.ok && /difference €1,222\.21/.test(v1.recap.check.text), v1.recap.check && v1.recap.check.text);
      await delay(400);
      await ui.reload();
      const re = await ui.state();
      ok(7, 'edited amount survives a reload', re.transactions.find((t) => t.name.startsWith('DROGIST')).amount === -123456 && isDeepStrictEqual(re, after), diffPaths(re, after).join(' | '));
      await ui.click(rowPart('DROGIST', '.tx-amount'));
      await ui.type('-12,50');
      await ui.key('Enter');
      eq(7, '"-12,50" (comma for cents) -> −1250', (await ui.state()).transactions.find((t) => t.name.startsWith('DROGIST')).amount, -1250);
      await ui.click(rowPart('DROGIST', '.tx-amount'));
      await ui.type('12.35');
      await ui.key('Enter');
      eq(7, '"12.35" -> −1235 (direction kept, back to the bank amount)', (await ui.state()).transactions.find((t) => t.name.startsWith('DROGIST')).amount, -1235);
      await ui.click(rowPart('DROGIST', '.tx-amount'));
      await ui.type('999');
      await ui.key('Escape');
      eq(7, 'Esc cancels the edit', (await ui.state()).transactions.find((t) => t.name.startsWith('DROGIST')).amount, -1235);
      await ui.click(rowPart('DROGIST', '.tx-amount'));
      await ui.type('abc');
      await ui.key('Enter');
      const inv = await ui.eval(() => ({ tag: document.activeElement.tagName, invalid: document.activeElement.getAttribute('aria-invalid') }));
      eq(7, 'nonsense + Enter keeps the editor open, marked invalid', inv, { tag: 'INPUT', invalid: 'true' });
      await ui.key('Escape');
      eq(7, 'state after the edit round-trip equals the start', diffPaths(await ui.state(), before), []);
      const v2 = await month(ui);
      ok(7, 'recap ✓ again after restoring the bank amount', v2.recap.check && v2.recap.check.ok);
    });
    await step(7, 'inline rename', async () => {
      await ui.click(rowPart('SUPERMARKT 1234', '.tx-name'));
      eq(7, 'name editor opens with the current name', await ui.eval(() => document.activeElement && document.activeElement.value), 'SUPERMARKT 1234 TESTDORP');
      await ui.type('Supermarkt Testdorp');
      await ui.key('Enter');
      const prompt = await ui.text({ css: '#view-month .inline-prompt span' });
      eq(7, 'asks "Always call \'<old name>\' this from now on?"', prompt, "Always call 'SUPERMARKT 1234 TESTDORP' this from now on?");
      eq(7, 'prompt offers [Yes] [Only this one]', await ui.texts({ css: '#view-month .inline-prompt button' }), ['Yes', 'Only this one']);
      await ui.click({ css: '#view-month .inline-prompt button', text: 'Yes' });
      const st = await ui.state();
      ok(7, 'renamed payment stored', st.transactions.some((t) => t.name === 'Supermarkt Testdorp'));
      const r = st.rules.find((x) => x.set.rename);
      eq(7, '[Yes] stores a rename rule', r && { match: r.match, set: r.set }, { match: { nameContains: 'SUPERMARKT 1234 TESTDORP' }, set: { rename: 'Supermarkt Testdorp' } });
      await delay(400);
      await ui.reload();
      const v = await month(ui);
      ok(7, 'new name survives a reload (screen + state)', v.groups.flatMap((g) => g.rows).some((x) => x.name === 'Supermarkt Testdorp') && isDeepStrictEqual(await ui.state(), st));
    });

    // ---- item 4: CSVs (comma by drag & drop, semicolon by file input, English + cp1252 together)
    await step(4, 'comma CSV by drag & drop', async () => {
      const dr = await ui.drop([F.comma]);
      ok(4, 'drop overlay "Let go to read the file" shows while dragging, hides on drop', dr.shown && /Let go to read the file/.test(dr.overlayText) && dr.hiddenAfter && dr.dropPrevented, short(dr));
      const d = await ui.waitDialog(/found/);
      ok(4, 'comma CSV: "12 payments found (Oct 2026)"', d.body.includes('12 payments found (Oct 2026)'), d.body);
      ok(4, 'comma CSV: says there are no balances to check', d.body.includes("This file has no balances, so it can't be checked."));
      await ui.click(btn('Add'));
      await ui.waitFor(() => document.getElementById('month-label').textContent === 'October 2026', { timeoutMs: 5000 });
      const st = await ui.state();
      checkCsvRows(st, comma, 'comma CSV', { 'SUPERMARKT 1234 TESTDORP': 'Supermarkt Testdorp' });
      const cat = (n) => st.transactions.find((t) => t.date.startsWith('2026-10') && t.name === n);
      eq(6, 'next import auto-categorized by the [Yes] rules', ['Huisbaas BV', 'Werkgever Voorbeeld BV', 'Energiebedrijf Test BV'].map((n) => cat(n) && `${cat(n).categoryId}/${cat(n).kind}`), ['huur/elke-maand', 'inkomen/elke-maand', 'vast/elke-maand']);
      eq(6, '[Only this one] made no rule: next Webwinkel payment is "not sorted yet" again', cat('Webwinkel Test') && cat('Webwinkel Test').categoryId, 'onbekend');
      eq(7, 'rename rule applies on the next import', Boolean(cat('Supermarkt Testdorp')), true);
    });
    await step(4, 'semicolon CSV by file input', async () => {
      const n0 = (await ui.state()).transactions.length;
      await ui.setFiles('#file-input', [F.semi]);
      const d = await ui.waitDialog(/found/);
      ok(4, 'semicolon CSV: "✓ Balances match the bank"', d.body.includes('✓ Balances match the bank'), d.body);
      ok(5, 'same rows in another format: "12 were already read — skipped" + month warning', d.body.includes('12 were already read — skipped') && d.body.includes('You already read this month — duplicate payments are skipped'));
      eq(4, 'semicolon CSV: only its balances are new -> [Add] [Cancel]', d.buttons, ['Add', 'Cancel']);
      await ui.click(btn('Add'));
      await waitToast(ui, /Statement added/);
      const st = await ui.state();
      eq(4, 'semicolon CSV: no payments added', st.transactions.length, n0);
      const s = st.statements.find((x) => x.month === '2026-10');
      const w = semi.statement;
      eq(4, 'semicolon CSV: month statement from "Saldo na mutatie"', s && [s.source, s.startBalance, s.endBalance, s.totalIn, s.totalOut], ['csv', w.startBalance, w.endBalance, w.totalIn, w.totalOut]);
      eq(4, 'semicolon CSV rows are the same as the comma rows (fixture sanity)', semi.rows.map((r) => `${r.date}|${r.amount}|${r.rawName}`), comma.rows.map((r) => `${r.date}|${r.amount}|${r.rawName}`));
      const { v } = await checkMonthScreen(ui, 4, '2026-10', 'oct (csv)');
      eq(4, 'oct: "✓ Matches the bank statement"', v.recap.check && v.recap.check.text, CHECK_OK);
    });

    // ---- item 5: the same files again
    await step(5, 're-import adds nothing', async () => {
      const before = await ui.state();
      await ui.chooseFiles([F.pdf1], { css: '#btn-import' });
      let d = await ui.waitDialog(/found/);
      ok(5, 'PDF again: "14 were already read — skipped"', d.body.includes('14 were already read — skipped'), d.body);
      ok(5, 'PDF again: "You already read this month — duplicate payments are skipped"', d.body.includes('You already read this month — duplicate payments are skipped'));
      ok(5, 'PDF again: "There is nothing new to add." and only [Close]', d.body.includes('There is nothing new to add.') && isDeepStrictEqual(d.buttons, ['Close']), short(d.buttons));
      await ui.click(btn('Close'));
      await ui.drop([F.comma]);
      d = await ui.waitDialog(/found/);
      ok(5, 'comma CSV again: all 12 duplicates, warning shown', d.body.includes('12 were already read — skipped') && d.body.includes('You already read this month'), d.body);
      await ui.click(btn(d.buttons[0]));
      await ui.setFiles('#file-input', [F.semi]);
      d = await ui.waitDialog(/found/);
      ok(5, 'semicolon CSV again: nothing new (balances already stored)', isDeepStrictEqual(d.buttons, ['Close']), short(d));
      await ui.click(btn('Close'));
      eq(5, 'state unchanged by the three re-imports', diffPaths(await ui.state(), before), []);
    });

    // ---- item 3/4: second PDF (Nov) and English + Windows-1252 CSVs together
    await step(3, 'second PDF', async () => {
      await ui.chooseFiles([F.pdf2], { css: '#btn-import' });
      const d = await ui.waitDialog(/found/);
      ok(3, 'PDF 2: "30 payments found (Nov 2026)" + totals ✓', d.body.includes('30 payments found (Nov 2026)') && d.body.includes('✓ Totals match the statement'), d.body);
      await ui.click(btn('Add'));
      await ui.waitFor(() => document.getElementById('month-label').textContent === 'November 2026', { timeoutMs: 5000 });
      const st = await ui.state();
      const got = st.transactions.filter((t) => t.date.startsWith('2026-11')).map((t) => `${t.date}|${t.type}|${t.amount}|${t.bankCode}`).sort();
      eq(3, 'PDF 2: every row parsed (date, type, amount, bank code)', got, pdf2.rows.map((r) => `${r.date}|${r.type}|${r.amount}|${r.bankCode}`).sort());
      const names = st.transactions.filter((t) => t.date.startsWith('2026-11')).map((t) => t.name).sort();
      eq(3, 'PDF 2: names (cleaned, rename rule applied)', names, pdf2.rows.map((r) => (r.rawName === 'SUPERMARKT 1234 TESTDORP' ? 'Supermarkt Testdorp' : mask(r.rawName))).sort());
      const leaks = pdf2.holder.filter((h) => JSON.stringify(st.transactions.filter((t) => t.source === 'pdf')).includes(h));
      eq(3, 'PDF 2: holder name/address not imported', leaks, []);
      const { v } = await checkMonthScreen(ui, 3, '2026-11', 'nov (pdf)');
      eq(11, 'nov: "✓ Matches the bank statement"', v.recap.check && v.recap.check.text, CHECK_OK);
    });
    await step(4, 'English + Windows-1252 CSV together', async () => {
      await ui.chooseFiles([F.english, F.cp1252], { css: '#btn-import' });
      const d = await ui.waitDialog(/found/);
      ok(4, 'two files: "20 payments found (Dec 2026 – Jan 2027)"', d.body.includes('20 payments found (Dec 2026 – Jan 2027)'), d.body);
      ok(4, 'two files: per-file lines + English file balances ✓ + cp1252 "no balances"', /ing-fake-english\.csv: 12 payments/.test(d.body) && /ing-fake-cp1252\.csv: 8 payments/.test(d.body) && d.body.includes('ing-fake-english.csv: ✓ Balances match the bank') && d.body.includes('ing-fake-cp1252.csv: This file has no balances'), d.body);
      await ui.click(btn('Add'));
      await ui.waitFor(() => document.getElementById('month-label').textContent === 'January 2027', { timeoutMs: 5000 });
      const st = await ui.state();
      eq(4, 'fixture sanity: cp1252 file is not UTF-8', cp.encoding, 'windows-1252');
      checkCsvRows(st, english, 'English CSV', { 'SUPERMARKT 1234 TESTDORP': 'Supermarkt Testdorp' });
      checkCsvRows(st, cp, 'Windows-1252 CSV', {});
      const jan = await month(ui);
      const shown = jan.groups.flatMap((g) => g.rows.map((r) => r.name));
      eq(4, 'cp1252: accents decoded on screen', ['Naïef Theater Test', 'Patisserie Noël Test', 'Zoë de Vries', 'Crêperie Test', 'Café De Brug Test'].filter((x) => !shown.includes(x)), []);
      const dec = st.transactions.find((t) => t.date === '2026-12-23');
      ok(4, 'English: quoted "" inside a field kept as one quote', dec && dec.description.includes('"13th month"'), dec && dec.description);
      const s = st.statements.find((x) => x.month === '2026-12');
      eq(4, 'English: statement from "Resulting balance"', s && [s.startBalance, s.endBalance, s.totalIn, s.totalOut], [english.statement.startBalance, english.statement.endBalance, english.statement.totalIn, english.statement.totalOut]);
      ok(4, 'English CSV: the rules made from Dutch bank names still match (salary -> Income)', st.transactions.some((t) => t.date === '2026-12-23' && t.categoryId === 'inkomen'));
      await goMonth(ui, '2026-12');
      const { v } = await checkMonthScreen(ui, 4, '2026-12', 'dec (English csv)');
      eq(11, 'dec: "✓ Matches the bank statement"', v.recap.check && v.recap.check.text, CHECK_OK);
    });

    // ---- item 8: move the September rent to October
    await step(8, 'Belongs to month', async () => {
      await goMonth(ui, '2026-09');
      const before = await ui.state();
      const rent = before.transactions.find((t) => t.name === 'Huisbaas BV' && t.date === '2026-09-29');
      const sep0 = summaryOf(before, '2026-09');
      const oct0 = summaryOf(before, '2026-10');
      await ui.click(rowPart('Huisbaas BV', '.tx-date'));
      const label = await ui.text({ css: '#popover-root label.field .pop-label' });
      eq(8, 'popover has "Belongs to month"', label, 'Belongs to month');
      const opts = await ui.eval(() => [...document.querySelectorAll('#popover-root select option')].map((o) => o.textContent));
      ok(8, 'month choices around the payment month, paid month marked', opts.includes('September 2026 (paid)') && opts.includes('October 2026'), short(opts));
      const val = await ui.selectByKeys({ css: '#popover-root select' }, '2026-10');
      eq(8, 'select moved to October 2026', val, '2026-10');
      await ui.key('Escape');
      const st = await ui.state();
      eq(8, 'payment now counts for 2026-10', st.transactions.find((t) => t.id === rent.id).month, '2026-10');
      eq(8, 'September fixed costs no longer include it', summaryOf(st, '2026-09').fixed - sep0.fixed, 105000);
      eq(8, 'October fixed costs include it', summaryOf(st, '2026-10').fixed - oct0.fixed, -105000);
      let v = await month(ui);
      const row = v.groups.flatMap((g) => g.rows).find((r) => r.id === rent.id);
      ok(8, 'September: row faded with "counts in October 2026"', row && row.faded && row.note === 'counts in October 2026', short(row));
      const sepRec = v.recap.rows.find((r) => r.label === 'Paid for another month');
      eq(8, 'September recap: "Paid for another month −€1,050.00"', sepRec && sepRec.value, '−€1,050.00');
      await checkMonthScreen(ui, 8, '2026-09', 'sep after move');
      eq(8, 'September still "✓ Matches the bank statement"', v.recap.check && v.recap.check.text, CHECK_OK);
      await ui.click({ css: '#next-month' });
      v = await month(ui);
      const row2 = v.groups.flatMap((g) => g.rows).find((r) => r.id === rent.id);
      ok(8, 'October: row counts, note "paid in September 2026"', row2 && !row2.faded && row2.note === 'paid in September 2026', short(row2));
      const octRec = v.recap.rows.find((r) => r.label === 'Already paid in an earlier month');
      eq(8, 'October recap: "Already paid in an earlier month +€1,050.00"', octRec && octRec.value, '+€1,050.00');
      await checkMonthScreen(ui, 8, '2026-10', 'oct after move');
      eq(8, 'October still "✓ Matches the bank statement"', v.recap.check && v.recap.check.text, CHECK_OK);
    });

    // ---- a month that is not read in yet, and a payment that is paid in a later month
    await step(8, 'not-yet-booked month + paid in a later month', async () => {
      const move = async (M, name, target) => {
        await goMonth(ui, M);
        await ui.click(rowPart(name, '.tx-date'));
        await ui.selectByKeys({ css: '#popover-root select' }, target);
        await ui.key('Escape');
      };
      // December rent (paid 1 dec) counts for November: November gets it back as "Will be paid in a later month".
      await move('2026-12', 'Huisbaas BV', '2026-11');
      await goMonth(ui, '2026-11');
      let v = await month(ui);
      const later = v.recap.rows.find((r) => r.label === 'Will be paid in a later month');
      eq('extra19', 'November recap: "Will be paid in a later month +€1,050.00"', later && later.value, '+€1,050.00');
      await checkMonthScreen(ui, 'extra19', '2026-11', 'nov with december rent');
      eq('extra19', 'November still "✓ Matches the bank statement"', v.recap.check && v.recap.check.text, CHECK_OK);
      await goMonth(ui, '2026-12');
      await checkMonthScreen(ui, 'extra19', '2026-12', 'dec without its rent');
      await move('2026-12', 'Huisbaas BV', '2026-12');

      // January's bank costs (paid 2 jan) count for February 2027, a month the bank has not booked.
      const st0 = await ui.state();
      const cost = st0.transactions.find((t) => t.name === 'Kosten ING Go' && t.date === '2027-01-02');
      await move('2027-01', 'Kosten ING Go', '2027-02');
      await move('2026-12', 'Huisbaas BV', '2027-02'); // rent paid early: calc would call February "higher than normal"
      const st = await ui.state();
      ok('extra2', 'fixture: calc.alerts reports February (the screen must not show it)', (await ui.eval(() => Budget.calc.alerts(Budget.store.get(), '2027-02').length)) > 0);
      eq('extra2', 'fixture: February 2027 only holds the moved payment', [monthsWithData(st).includes('2027-02'), bookedMonths(st).includes('2027-02')], [true, false]);
      await ui.reload();
      eq('extra2', 'the app opens on the latest BOOKED month (January 2027), not on February', (await month(ui)).label, 'January 2027');
      ok('extra2', '▶ still reaches February 2027', !(await month(ui)).nextDisabled);
      await ui.click({ css: '#next-month' });
      v = await month(ui);
      eq('extra2', '▶ opens February 2027', v.label, 'February 2027');
      const note = await ui.eval(() => [...document.querySelectorAll('#view-month .month-note')].map((n) => ({ text: window.__t.norm(n.textContent), color: getComputedStyle(n).color })));
      eq('extra2', 'one calm note at the top: "This month has not been read yet. …"', note.map((n) => n.text),
        ['This month has not been read yet. It only shows payments that were made earlier for this month.']);
      ok('extra2', 'the note is not red', note.length === 1 && !isRed(note[0].color), short(note));
      const red = await ui.eval(() => ({
        shortfall: Boolean(document.querySelector('#view-month .shortfall')),
        tile: document.querySelector('#view-month .tile-left').className,
        tileColor: getComputedStyle(document.querySelector('#view-month .tile-left .tile-value')).color,
        stripe: getComputedStyle(document.querySelector('#view-month .tile-left'), '::before').backgroundColor,
      }));
      ok('extra2', 'no red "Short" label and no red "Left this month" tile (grey stripe)', !red.shortfall && !/\bshort\b/.test(red.tile) && /\bpending\b/.test(red.tile) && !isRed(red.tileColor) && !isRed(red.stripe), short(red));
      const redTexts = await ui.eval(() => [...document.querySelectorAll('#view-month *')].filter(window.__t.visible)
        .filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
        .filter((e) => { const [r, g, b] = getComputedStyle(e).color.match(/\d+/g).map(Number); return r - Math.max(g, b) >= 60; })
        .map((e) => window.__t.describe(e)));
      eq('extra2', 'nothing red on the month that is not read in yet (no "Higher than normal" badge either)', redTexts, []);
      eq('extra2', 'February shows the moved payment ("paid in January 2027")', v.groups.flatMap((g) => g.rows).filter((r) => r.id === cost.id).map((r) => r.note), ['paid in January 2027']);
      await ui.shot('month-not-booked', { width: 1100 });
      await ui.shot('month-not-booked', { width: 400, scheme: 'dark' });
      await ui.click({ css: '#btn-all' });
      const row = await ui.eval(() => {
        const tr = [...document.querySelectorAll('#all-months .x-table tbody tr')].find((r) => /February 2027/.test(r.textContent));
        const g = document.querySelector('#all-months .x-group[data-month="2027-02"]');
        const shortBar = g && g.querySelector('.x-short');
        return tr && {
          text: window.__t.norm(tr.children[0].innerText), over: window.__t.norm(tr.children[3].textContent), overColor: getComputedStyle(tr.children[3]).color,
          pending: g && g.classList.contains('x-pending'), shortFill: shortBar ? getComputedStyle(shortBar).fill : null,
        };
      });
      ok('extra2', 'All months: February 2027 marked "not read yet", greyed, no red shortfall', row && row.text === 'February 2027 not read yet' && row.pending && !isRed(row.overColor) && (!row.shortFill || !isRed(row.shortFill)), short(row));
      await ui.shot('all-months-not-booked', { width: 1100 });
      await ui.shot('all-months-not-booked', { width: 400, scheme: 'dark' });
      await ui.click({ css: '#btn-all' });
      await move('2027-02', 'Kosten ING Go', '2027-01');
      await move('2027-02', 'Huisbaas BV', '2026-12');
      eq('extra2', 'moved back: January 2027 holds its bank costs again, February is gone', [(await ui.state()).transactions.find((t) => t.id === cost.id).month, monthsWithData(await ui.state()).includes('2027-02')], ['2027-01', false]);
    });

    // ---- item 9: add by hand, delete + undo
    await step(9, 'add by hand', async () => {
      await goMonth(ui, '2026-09');
      const before = await ui.state();
      const v0 = await month(ui);
      await ui.click({ css: '#view-month .list-head button', text: '+ Add' });
      const d = await ui.waitDialog(/Add payment/);
      eq(9, 'add dialog: fields', await ui.texts({ css: '#dialog-root .field > span' }), ['Date', 'Name', 'Amount (€)', 'In or out', 'Category']);
      eq(9, 'add dialog: buttons', d.buttons, ['Add', 'Cancel']);
      const todayIso = todayLocal();
      const wantIso = todayIso.startsWith('2026-09') ? todayIso : '2026-09-01';
      const nlText = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
      const dateField = () => ui.eval(() => {
        const input = document.querySelector('#dialog-root input[name=date]');
        return input && { type: input.type, value: input.value, placeholder: input.placeholder, words: window.__t.norm(document.getElementById('add-date-long').textContent) };
      });
      let df = await dateField();
      eq('extra18', 'date is a day-month-year text field dd-mm-yyyy (no <input type=date>), defaulting to the month on screen', df && [df.type, df.placeholder, df.value],
        ['text', 'dd-mm-yyyy', nlText(wantIso)]);
      eq('extra18', 'no browser date picker in the dialog', await ui.eval(() => document.querySelectorAll('#dialog-root input[type=date]').length), 0);
      eq('extra18', 'the date is shown in words next to it', df && df.words, wantIso === '2026-09-01' ? 'Tuesday 1 September 2026' : df.words);
      await ui.click({ css: '#dialog-root input[name=date]' });
      await ui.selectAll();
      await ui.type('3.9.2026');
      df = await dateField();
      eq('extra18', 'typing "3.9.2026" shows "Thursday 3 September 2026" at once', df.words, 'Thursday 3 September 2026');
      await ui.selectAll();
      await ui.type('31-09-2026');
      await ui.click(btn('Add'));
      eq('extra18', 'an impossible date gives a plain error and the dialog stays', [await ui.text({ css: '#dialog-root .form-error' }), (await ui.dialog()).title],
        ['This date is not right. Type day-month-year, for example 1-10-2026.', 'Add payment']);
      await ui.click({ css: '#dialog-root input[name=date]' });
      await ui.selectAll();
      await ui.type(nlText(wantIso));
      const date = wantIso;
      await ui.click(btn('Add'));
      eq(9, 'empty name -> "Fill in a name." and the dialog stays', [await ui.text({ css: '#dialog-root .form-error' }), (await ui.dialog()) && (await ui.dialog()).title], ['Fill in a name.', 'Add payment']);
      await ui.click({ css: '#dialog-root input[name=name]' });
      await ui.type('Markt (contant)');
      await ui.click({ css: '#dialog-root input[inputmode=decimal]' });
      await ui.type('12.50');
      eq(9, '"Money out" is preselected, category "Daily spending"', await ui.eval(() => [document.querySelector('#dialog-root [data-dir=out]').getAttribute('aria-pressed'), document.querySelector('#dialog-root select').value]), ['true', 'dagelijks']);
      await ui.click(btn('Add'));
      await ui.waitNoDialog();
      const st = await ui.state();
      const added = st.transactions.find((t) => t.name === 'Markt (contant)');
      eq(9, 'hand payment stored', added && { date: added.date, amount: added.amount, categoryId: added.categoryId, kind: added.kind, source: added.source, fingerprint: added.fingerprint, type: added.type, bankCode: added.bankCode },
        { date, amount: -1250, categoryId: 'dagelijks', kind: 'wisselend', source: 'hand', fingerprint: '', type: '', bankCode: '' });
      ctx.handId = added && added.id;
      const v1 = await month(ui);
      ok(9, 'hand payment on screen', v1.groups.flatMap((g) => g.rows).some((r) => r.name === 'Markt (contant)' && r.amount === '−€12.50'));
      eq(9, 'daily tile grew by €12.50', Math.abs(cents(v1.tiles[2].value)) - Math.abs(cents(v0.tiles[2].value)), 1250);
      const nv = v1.recap.rows.find((r) => r.label === 'Added by you, not via the bank');
      ok(9, 'recap separates the cash payment and still reconciles', nv && nv.value === '+€12.50' && v1.recap.check && v1.recap.check.ok, short(nv));
      eq(9, 'nothing else changed', st.transactions.length, before.transactions.length + 1);
    });
    await step(9, 'delete + undo', async () => {
      const before = await ui.state();
      await ui.click(rowPart('Markt \\(contant\\)', '.tx-date'));
      await ui.click({ css: '#popover-root button', text: 'Delete' });
      let st = await ui.state();
      eq(9, 'deleted from the state', st.transactions.length, before.transactions.length - 1);
      ok(9, 'deleted from the screen', !(await month(ui)).groups.flatMap((g) => g.rows).some((r) => r.name === 'Markt (contant)'));
      const toast = await ui.eval(() => [...document.querySelectorAll('#toast-root .toast')].map((t) => window.__t.norm(t.innerText)).find((t) => t.startsWith('Deleted')));
      ok(9, 'toast "Deleted — Undo"', toast && /^Deleted Undo/.test(toast), toast);
      await delay(6500);
      ok(9, 'undo toast still there after 6.5 s', await ui.exists({ css: '#toast-root .toast', re: '^Deleted' }));
      await ui.click({ css: '#toast-root .toast', re: '^Deleted', child: '.toast-action' });
      st = await ui.state();
      eq(9, 'undo brings it back unchanged (same id, fields)', diffPaths(st, before), []);
      ok(9, 'back on screen', (await month(ui)).groups.flatMap((g) => g.rows).some((r) => r.name === 'Markt (contant)'));
      await delay(400);
      await ui.reload();
      eq(9, 'hand payment survives a reload', diffPaths(await ui.state(), st), []);
    });

    // ---- item 10: My normal month
    await step(10, 'normal month', async () => {
      await goMonth(ui, '2026-09');
      const st0 = await ui.state();
      const nm0 = await ui.eval(() => Budget.calc.normalMonth(Budget.store.get()));
      const v0 = await month(ui);
      eq(10, 'savings card: 3-line sum + total', v0.save.lines.map((l) => l.label), ['Comes in (normal month)', 'Fixed costs', 'Daily (average)', 'Left to save']);
      eq(10, 'savings card: daily average = expected (last ≤3 months with data)', nm0.dailyAvg, dailyAvgOf(st0));
      eq(10, 'savings card: total = in + fixed + daily', nm0.save, nm0.income + nm0.fixed + nm0.dailyAvg);
      eq(10, 'savings card: "About €x per month", x rounded DOWN to a multiple of 5', v0.save.big, `About ${euro(Math.floor(nm0.save / 500) * 500, { whole: true })} per month`);
      eq(10, 'savings card: shown lines = calc', v0.save.lines.map((l) => cents(l.value)), [nm0.income, nm0.fixed, nm0.dailyAvg, nm0.save]);
      await ui.click({ css: '#view-month .save-card .link-btn', text: 'Change normal month' });
      const d = await ui.waitDialog(/My normal month/);
      eq(10, 'editor groups = categories of the monthly payees', await ui.texts({ css: '#dialog-root .nm-group h3' }), [...new Set(nm0.items.map((i) => i.categoryId))].map((id) => st0.categories.find((c) => c.id === id)).map((c) => (c.kind === 'unknown' ? 'Not sorted yet' : c.name)));
      const sal = nm0.items.find((i) => i.name === 'Werkgever Voorbeeld BV' && i.side === 'in');
      eq(10, 'salary item keyed by side + payeeId of the raw bank name', sal && sal.key, `in:${payeeIdOf('Werkgever Voorbeeld BV')}`);
      ok(10, 'editor lists the salary with its last amount as default', sal && (await ui.eval(() => document.querySelector('#dialog-root input[aria-label="Normal amount for Werkgever Voorbeeld BV"]').value)) === (sal.lastActual / 100).toFixed(2), short(sal));
      ok(10, 'only "every month" payees are listed', nm0.items.every((i) => st0.transactions.some((t) => t.name === i.name && t.kind === 'elke-maand')), short(nm0.items.map((i) => i.name)));
      eq(10, 'editor buttons', d.buttons, ['Save', 'Cancel']);
      const lasts = await ui.texts({ css: '#dialog-root .nm-last' });
      eq('extra7', 'each row: "last time €x", or "last month €x (N payments)" when its month had more payments',
        lasts, nm0.items.map((i) => (i.lastCount > 1 ? `last month ${euro(Math.abs(i.lastActual))} (${i.lastCount} payments)` : `last time ${euro(Math.abs(i.lastActual))}`)));
      await ui.click({ css: '#dialog-root input[aria-label="Normal amount for Werkgever Voorbeeld BV"]' });
      const sel = await ui.eval(() => { const a = document.activeElement; return { start: a.selectionStart, end: a.selectionEnd, len: a.value.length }; });
      ok('extra1', 'clicking a normal amount selects its whole content', sel.start === 0 && sel.end === sel.len && sel.len > 0, short(sel));
      await ui.type('2000');
      await ui.click(btn('Save'));
      await ui.waitNoDialog();
      const st1 = await ui.state();
      eq(10, 'normal amount stored under item.key as a positive magnitude', st1.normalAmounts[sal.key], 200000);
      const nm1 = await ui.eval(() => Budget.calc.normalMonth(Budget.store.get()));
      eq(10, 'savings plan income drops by (last − normal)', nm1.income - nm0.income, 200000 - sal.normal);
      const v1 = await month(ui);
      eq(10, 'savings card number changes accordingly', v1.save.big, `About ${euro(Math.floor(nm1.save / 500) * 500, { whole: true })} per month`);
      eq(10, 'savings plan total drops by the same amount', nm1.save - nm0.save, 200000 - sal.normal, `${v0.save.big} -> ${v1.save.big}`);
      const salSep = st1.transactions.find((t) => t.date === '2026-09-25').amount;
      const other = sum(st1.transactions.filter((t) => t.month === '2026-09' && t.kind === 'elke-maand' && t.categoryId === 'inkomen' && t.name !== 'Werkgever Voorbeeld BV').map((t) => t.amount));
      const row = (v, l) => v.recap.rows.find((r) => r.label === l);
      eq(10, 'sep recap "Normal income" = normal salary + other monthly income', row(v1, 'Normal income') && cents(row(v1, 'Normal income').value), 200000 + other);
      eq(10, 'sep recap "Less than normal" = actual − normal (negative)', row(v1, 'Less than normal') && cents(row(v1, 'Less than normal').value), salSep - 200000);
      ok(10, 'sep recap still reconciles', v1.recap.check && v1.recap.check.ok);
      await goMonth(ui, '2026-12');
      const v2 = await month(ui);
      const salDec = st1.transactions.find((t) => t.date === '2026-12-23').amount;
      eq(10, 'dec recap "Extra income (one-off/more than normal)" includes actual − normal', row(v2, 'Extra income (one-off/more than normal)') && cents(row(v2, 'Extra income (one-off/more than normal)').value),
        salDec - 200000 + sum(st1.transactions.filter((t) => t.month === '2026-12' && t.categoryId === 'inkomen' && t.kind !== 'elke-maand' && t.kind !== 'telt-niet-mee').map((t) => t.amount)));
      ok(10, 'dec recap still reconciles', v2.recap.check && v2.recap.check.ok);
    });

    // ---- a typed amount equal to the shown default is stored; "Only this one" rename counts once
    await step(10, 'normal month: typed default + rename', async () => {
      const nm0 = await ui.eval(() => Budget.calc.normalMonth(Budget.store.get()));
      const pick = nm0.items.find((i) => !i.custom && i.side === 'uit');
      ok('extra1', 'fixture: a monthly cost without a stored normal amount', Boolean(pick), short(nm0.items.map((i) => [i.name, i.custom])));
      await ui.click({ css: '#view-month .save-card .link-btn', text: 'Change normal month' });
      await ui.waitDialog(/My normal month/);
      const shown = await ui.eval((key) => document.querySelector(`#dialog-root input[data-key="${key}"]`).value, pick.key);
      await ui.click({ css: `#dialog-root input[data-key="${pick.key}"]` });
      await ui.type(shown); // the same amount the field already showed
      await ui.click(btn('Save'));
      await ui.waitNoDialog();
      eq('extra1', `typing the shown amount (${shown}) for ${pick.name} stores it as its normal amount`, (await ui.state()).normalAmounts[pick.key], Math.abs(pick.lastActual));

      // "Only this one" rename of the newest salary payment: still ONE payee, nothing counted twice.
      const st = await ui.state();
      const salary = st.transactions.filter((t) => t.name === 'Werkgever Voorbeeld BV' && t.kind === 'elke-maand').sort((a, b) => b.date.localeCompare(a.date))[0];
      const M = salary.month;
      await goMonth(ui, M);
      const before = await ui.eval(() => Budget.calc.normalMonth(Budget.store.get()));
      const big0 = (await month(ui)).save.big;
      await ui.click({ css: '#view-month .tx', re: `^${Number(salary.date.slice(8))} \\w+ Werkgever Voorbeeld BV`, child: '.tx-name' });
      await ui.selectAll();
      await ui.type('Salaris (eigen naam)');
      await ui.key('Enter');
      await ui.click({ css: '#view-month .inline-prompt button', text: 'Only this one' });
      const after = await ui.eval(() => Budget.calc.normalMonth(Budget.store.get()));
      const pid = payeeIdOf('Werkgever Voorbeeld BV');
      eq('extra1', '"Only this one" rename: still one salary item, same income in the plan',
        [after.items.filter((i) => i.payeeId === pid).length, after.items.length, after.income], [1, before.items.length, before.income]);
      eq('extra1', '"Only this one" rename: the savings card number does not change', (await month(ui)).save.big, big0);
      eq('extra1', 'the renamed payment keeps its payeeId', (await ui.state()).transactions.find((t) => t.id === salary.id).payeeId, salary.payeeId);
      await ui.click({ css: '#view-month .save-card .link-btn', text: 'Change normal month' });
      await ui.waitDialog(/My normal month/);
      const rows = await ui.eval((key) => [...document.querySelectorAll('#dialog-root input')].filter((i) => i.dataset.key === key).length, `in:${pid}`);
      eq('extra1', 'the editor shows the salary once', rows, 1);
      await ui.click(btn('Cancel'));
      await ui.click({ css: '#view-month .tx', re: 'Salaris \\(eigen naam\\)', child: '.tx-name' });
      await ui.selectAll();
      await ui.type('Werkgever Voorbeeld BV');
      await ui.key('Enter');
      await ui.click({ css: '#view-month .inline-prompt button', text: 'Only this one' });
      eq('extra1', 'name put back', (await ui.state()).transactions.find((t) => t.id === salary.id).name, 'Werkgever Voorbeeld BV');
      // Undo of a rename takes its "Always use this name for …?" question away too.
      await ui.click({ css: '#view-month .tx', re: `^${Number(salary.date.slice(8))} \\w+ Werkgever Voorbeeld BV`, child: '.tx-name' });
      await ui.selectAll();
      await ui.type('Tijdelijke naam');
      await ui.key('Enter');
      ok('extra4', 'rename asks "Always call … this from now on?"', await ui.exists({ css: '#view-month .inline-prompt' }));
      await ui.click({ css: '#toast-root .toast', re: '^Name changed', child: '.toast-action' });
      eq('extra4', 'undo of the rename: old name back, question gone', [(await ui.state()).transactions.find((t) => t.id === salary.id).name, await ui.exists({ css: '#view-month .inline-prompt' })], ['Werkgever Voorbeeld BV', false]);
    });

    // ---- item 11: recap vs statement, red warning, undo of the last edit
    await step(11, 'recap reconciles + red warning', async () => {
      await goMonth(ui, '2026-09');
      let v = await month(ui);
      eq(11, 'sep shows "✓ Matches the bank statement"', v.recap.check && v.recap.check.text, CHECK_OK);
      ok(11, 'sep shows "Your balance went up/down by … this month."', /^Your balance went (up|down) by €\d{1,3}(,\d{3})*\.\d{2} this month\.$/.test(v.recap.change), v.recap.change);
      await ui.click(rowPart('Kosten ING Go', '.tx-amount'));
      await ui.type('3.95');
      await ui.key('Enter');
      v = await month(ui);
      const rec = reconcileOf(await ui.state(), '2026-09');
      ok(11, 'changed amount -> red warning with the difference', v.recap.check && !v.recap.check.ok && v.recap.check.text.includes(`difference ${euro(Math.abs(rec.diff))}`), v.recap.check && v.recap.check.text);
      ok(11, 'warning shown in the red (error) style', isRed(v.recap.check.color) && (await ui.eval(() => document.querySelector('.recap-card .check').className)) === 'check bad', v.recap.check.color);
      await ui.click({ css: '#toast-root .toast', re: '^Amount changed', child: '.toast-action' });
      v = await month(ui);
      ok(11, 'undo of the last edit -> ✓ again', v.recap.check && v.recap.check.ok && (await ui.state()).transactions.find((t) => t.name === 'Kosten ING Go' && t.date === '2026-09-28').amount === -295);
    });

    // ---- item 12: All months, savings goal, Higher than normal
    await step(12, 'All months', async () => {
      await ui.click({ css: '#btn-all' });
      const st = await ui.state();
      const months = monthsWithData(st);
      const view = await ui.eval(() => ({
        hidden: document.getElementById('all-months').hidden,
        groups: [...document.querySelectorAll('#all-months .x-group')].map((g) => g.getAttribute('data-month')),
        bars: document.querySelectorAll('#all-months .x-bar').length,
        rows: [...document.querySelectorAll('#all-months .x-table tbody tr')].map((tr) => [...tr.children].map((td) => window.__t.norm(td.textContent))),
        label: document.getElementById('month-label').textContent,
        btn: document.getElementById('btn-all').textContent,
      }));
      ok(12, 'All months view shown (title + "Back to month")', !view.hidden && view.label === 'All months' && view.btn === 'Back to month', short(view.label));
      eq(12, 'chart: one group per month with data', view.groups, months);
      ok(12, 'chart has bars', view.bars >= months.length);
      const want = months.slice().reverse().map((m) => { const s = summaryOf(st, m); return [Budget_label(m), euro(s.moneyIn), euro(s.moneyOut), euro(s.left, { sign: true })]; });
      eq(12, 'table per month: In = Σ money in, Out = Σ money out, Left = In − Out (independent sums)', view.rows, want);
      ok('extra13', 'Out is never negative', view.rows.every((r) => !r[2].startsWith('−')), short(view.rows.map((r) => r[2])));
      eq('extra20', '"All months" title shown once (top bar only)', await ui.eval(() => [...document.querySelectorAll('h1, h2, h3')].filter(window.__t.visible).filter((h) => window.__t.norm(h.textContent) === 'All months').length), 1);
      for (const width of [1100, 400]) for (const scheme of ['light', 'dark']) await ui.shot('all-months', { width, scheme });
      await ui.click({ css: '#all-months .x-month-link', text: 'October 2026' });
      eq(12, 'click a month in the table opens it', (await month(ui)).label, 'October 2026');
      await ui.click({ css: '#btn-all' });
      await ui.click({ css: '#all-months .x-group[data-month="2026-11"]' });
      eq(12, 'click a month in the chart opens it', (await month(ui)).label, 'November 2026');
    });
    await step(12, 'Income tile: money in that is still "Not sorted yet"', async () => {
      const st = await ui.state();
      const kinds = new Map(st.categories.map((c) => [c.id, c.kind]));
      let seen = 0;
      for (const M of monthsWithData(st)) {
        await goMonth(ui, M);
        const unknownIn = st.transactions.filter((t) => t.month === M && t.kind !== 'telt-niet-mee' && (kinds.get(t.categoryId) || 'unknown') === 'unknown' && t.amount > 0)
          .reduce((a, t) => a + t.amount, 0);
        const subs = await ui.texts({ css: '#view-month .tile-in .tile-sub' });
        eq('extra13', `${M}: Income tile says "+€x not sorted yet" exactly when money in is still unknown`, subs, unknownIn ? ['what came in', `${euro(unknownIn, { sign: true })} not sorted yet`] : ['what came in']);
        if (unknownIn) seen++;
      }
      ok('extra13', 'fixture: at least one month has unknown money in', seen > 0);
    });
    await step(12, 'savings goal', async () => {
      await goMonth(ui, '2026-11');
      const v0 = await month(ui);
      eq('extra6', 'no goal yet: nothing about a goal in the savings card (no "set a savings goal" link)', [v0.save.goal, await ui.texts({ css: '.save-card button, .save-card a' })], ['', ['Change normal month']]);
      // delete a payment, change the goal in Settings, then press the OLD toast's "Undo".
      const before = await ui.state();
      const victim = before.transactions.find((t) => t.month === '2026-11' && t.name === 'Webwinkel Test') || before.transactions.find((t) => t.month === '2026-11' && t.kind === 'wisselend');
      await ui.click({ css: `#view-month .tx[data-id="${victim.id}"]`, child: '.tx-date' });
      await ui.click({ css: '#popover-root button', text: 'Delete' });
      ok('extra4', 'delete shows "Deleted — Undo"', await ui.eval(() => {
        const t = [...document.querySelectorAll('#toast-root .toast')].find((x) => x.querySelector('.toast-msg').textContent === 'Deleted');
        window.__oldUndo = t && t.querySelector('.toast-action');
        return Boolean(window.__oldUndo);
      }));
      await openMenuItem(ui, 'Settings');
      await ui.waitDialog(/Settings/);
      await ui.click({ css: '#x-goal-input' });
      await ui.type('300');
      await ui.key('Enter');
      ok(12, '"✓ Saved" after Enter', (await ui.text({ css: '#dialog-root .x-saved' })) === '✓ Saved');
      eq('extra4', 'the newer undoable change (savings goal) removed the old "Deleted" undo toast', [await ui.eval(() => window.__oldUndo.isConnected), (await ui.toasts()).includes('Deleted')], [false, false]);
      await ui.eval(() => { window.__oldUndo.click(); return true; }); // a press that still reaches the old button
      const afterOld = await ui.state();
      eq('extra4', "the old toast's undo does NOT revert the savings goal, and the payment stays deleted",
        [afterOld.settings.savingsGoal, afterOld.transactions.some((t) => t.id === victim.id)], [30000, false]);
      await ui.click(btn('Done'));
      const st = await ui.state();
      eq(12, 'goal stored in cents', st.settings.savingsGoal, 30000);
      const v = await month(ui);
      const left = summaryOf(st, '2026-11').left;
      const pct = Math.max(0, Math.round((left * 100) / 30000));
      ok(12, 'goal bar "€x of €300 — pct%"', v.save.goal && v.save.goal.includes(`${euro(left, { whole: true })} of €300 — ${pct}%`), v.save.goal);
      eq(12, 'goal bar fill width', v.save.goalFill, `${Math.min(100, pct)}%`);
      eq('extra6', 'savings card: only "Change normal month" as a control (no "change savings goal")', await ui.texts({ css: '.save-card button, .save-card a' }), ['Change normal month']);
      await ui.click({ css: '#btn-all' });
      const line = await ui.eval(() => Boolean(document.querySelector('#all-months .x-goal-line')) && window.__t.norm(document.querySelector('#all-months .x-legend').innerText));
      ok(12, 'chart shows the goal line + legend "Savings goal €300"', line && line.includes('Savings goal €300'), short(line));
      await ui.click({ css: '#btn-all' });
    });
    await step(12, 'Higher than normal', async () => {
      await goMonth(ui, '2027-01');
      let st = await ui.state();
      const prevJan = bookedMonths(st).filter((m) => m < '2027-01');
      ok(12, 'January has ≥ 2 earlier months with data', prevJan.length >= 2, short(prevJan));
      await ui.click({ css: '#view-month .list-head button', text: '+ Add' });
      await ui.waitDialog(/Add payment/);
      await ui.type('Fietsenmaker (contant)');
      await ui.click({ css: '#dialog-root input[inputmode=decimal]' });
      await ui.type('500');
      await ui.click(btn('Add'));
      await ui.waitNoDialog();
      st = await ui.state();
      for (const M of monthsWithData(st)) {
        await goMonth(ui, M);
        const v = await month(ui);
        const want = bookedMonths(st).includes(M) ? alertsOf(st, M) : []; // no badges on a month not read in yet
        eq(12, `${M}: badges exactly where the alert rule says`, v.groups.filter((g) => g.badges.length).map((g) => g.cat).sort(), want.map((a) => a.categoryId).sort());
        for (const a of want) {
          const g = v.groups.find((x) => x.cat === a.categoryId);
          const m = g && /^Higher than normal \(\+€([\d,]+)\)$/.exec(g.badges[0] || '');
          ok(12, `${M}: "${g && g.badges[0]}" ≈ +${euro(a.diff, { whole: true })}`, m && Math.abs(Number(m[1].replace(/,/g, '')) * 100 - a.diff) <= 100);
          ok(12, `${M}: ${a.categoryId} total turns red`, g && g.alert && isRed(g.totalColor), g && g.totalColor);
        }
        if (bookedMonths(st).filter((m) => m < M).length < 2) eq(12, `${M}: fewer than 2 earlier months -> no badges at all`, v.groups.flatMap((g) => g.badges), []);
      }
      const jan = alertsOf(st, '2027-01');
      ok(12, 'January daily spending triggers the badge (fixture sanity)', jan.some((a) => a.categoryId === 'dagelijks'), short(jan));
    });

    // ---- item 16: a full toast stack (the app keeps at most 4) next to a dialog
    await step(16, 'toasts vs dialog buttons', async () => {
      await goMonth(ui, '2026-09');
      // Every control of the open dialog (fields, choices, buttons): none may lie under a toast.
      const covered = () => ui.eval(() => {
        const toasts = [...document.querySelectorAll('#toast-root .toast')].map((t) => t.getBoundingClientRect());
        const box = document.querySelector('#dialog-root .dialog');
        const body = box.querySelector('.dialog-body').getBoundingClientRect();
        return [...box.querySelectorAll('button, input, select')].filter(window.__t.visible).map((b) => {
          const r = b.getBoundingClientRect();
          if (r.bottom <= body.top || r.top >= body.bottom) { if (!b.closest('.dialog-actions')) return null; } // scrolled out of the body
          const hit = toasts.find((t) => t.left < r.right && t.right > r.left && t.top < r.bottom && t.bottom > r.top);
          const top = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + r.height / 2, innerHeight - 1));
          const label = b.textContent.trim() || b.name || b.type;
          if (top && top.closest('.toast')) return `${label}: centre covered`;
          return hit ? `${label}: ${Math.round(r.bottom - hit.top)} px of its ${Math.round(r.height)} px covered` : null;
        }).filter(Boolean);
      });
      for (const [w, h] of [[1100, 900], [1100, 650], [400, 860]]) {
        await ui.page.setViewport(w, h);
        await ui.settle(100);
        await ui.eval(() => {
          document.getElementById('toast-root').replaceChildren();
          for (const m of ['14 payments added.', 'Statement added.', '30 payments added.']) Budget.ui.toast(m, { ms: 60000 });
          Budget.ui.toast('Now counts in October 2026', { action: { label: 'Undo', onClick() {} }, ms: 60000 });
          return true;
        });
        await ui.click({ css: '#view-month .list-head button', text: '+ Add' });
        await ui.waitDialog(/Add payment/);
        await ui.settle(100);
        await ui.page.screenshot(join(OUT, 'shots', `toasts-over-dialog-${w}x${h}.png`));
        eq(16, `4 toasts (the app keeps up to 4) + "Add payment" at ${w}x${h}: no toast lies over any dialog control`, await covered(), [], `screenshot shots/toasts-over-dialog-${w}x${h}.png`);
        await ui.eval(() => { const b = [...document.querySelectorAll('#dialog-root .dialog-actions button')].find((x) => x.textContent === 'Add'); b.click(); return true; });
        await ui.settle();
        await ui.page.screenshot(join(OUT, 'shots', `toasts-over-dialog-error-${w}x${h}.png`));
        eq(16, `same at ${w}x${h}, after "Fill in a name." makes the dialog taller: every control still clear`, await covered(), [], `screenshot shots/toasts-over-dialog-error-${w}x${h}.png`);
        const toastsOk = await ui.eval(() => [...document.querySelectorAll('#toast-root .toast')].every((t) => { const r = t.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }));
        ok(16, `${w}x${h}: the toasts stay readable in the window`, toastsOk);
        await ui.key('Escape');
        await ui.eval(() => { document.getElementById('toast-root').replaceChildren(); Budget.ui.updateToastSpace(); return true; });
      }
      await ui.page.setViewport(1100, 900);
      await ui.settle(100);
    });

    // ---- item 16: English text, light/dark readable, 1100 and 400 px without horizontal scroll
    await step(16, 'layout + readability', async () => {
      const views = [
        ['month-sep', async () => goMonth(ui, '2026-09')],
        ['month-jan', async () => goMonth(ui, '2027-01')],
        ['popover', async () => { await goMonth(ui, '2026-09'); await ui.click(rowPart('Webwinkel Test', '.tx-date')); }],
        ['normal-month', async () => { await ui.key('Escape'); await ui.click({ css: '#view-month .save-card .link-btn', text: 'Change normal month' }); await ui.waitDialog(/My normal month/); }],
        ['settings', async () => { await ui.click(btn('Cancel')); await openMenuItem(ui, 'Settings'); await ui.waitDialog(/Settings/); }],
        ['menu', async () => { await ui.click(btn('Done')); await ui.click({ css: '#btn-menu' }); }],
        ['all-months-400', async () => { await ui.key('Escape'); await ui.click({ css: '#btn-all' }); }],
      ];
      for (const [name, open] of views) {
        await open();
        for (const width of [400, 1100]) {
          await ui.setWidth(width);
          const o = await ui.eval(overflowReport);
          ok(16, `${name} @${width}px: no horizontal page scroll`, o.scrollWidth <= o.vw && o.count === 0, o.count ? short(o.overflow) : `scrollWidth ${o.scrollWidth} <= ${o.vw}`);
          for (const scheme of ['light', 'dark']) {
            await ui.page.colorScheme(scheme);
            await ui.parkMouse();
            await ui.settle(100);
            const c = await ui.eval(contrastReport, 'body');
            ok(16, `${name} @${width}px ${scheme}: text contrast ≥ WCAG AA (${c.checked} texts)`, c.failures.length === 0, c.failures.length ? short(c.failures.slice(0, 4)) : '');
            if (width === 400) await ui.shot(name, { width, scheme });
          }
          await ui.page.colorScheme('light');
        }
        const t = await ui.eval(uiTexts);
        const hits = [t.text, ...t.attrs].join(' | ').match(new RegExp(DUTCH_UI.source, 'gi')) || [];
        eq(16, `${name}: no Dutch / broken words in the UI text`, [...new Set(hits)], []);
      }
      await ui.click({ css: '#btn-all' });
      for (const scheme of ['light', 'dark']) {
        await ui.page.colorScheme(scheme);
        await ui.hover({ css: '#view-month .tx', re: 'Werkgever Voorbeeld BV' });
        const c = await ui.eval(contrastReport, '#view-month .group[data-cat="inkomen"]');
        ok(16, `hovered income row (${scheme}): green amount still ≥ 4.5:1`, c.failures.length === 0 && c.checked > 0, c.failures.length ? short(c.failures) : `${c.checked} texts`);
      }
      await ui.page.colorScheme('light');
      await ui.parkMouse();
      eq(16, 'html lang="en", title "Budget"', await ui.eval(() => [document.documentElement.lang, document.title]), ['en', 'Budget']);
      for (const width of [1100, 400]) for (const scheme of ['light', 'dark']) await ui.shot('month-sep-full', { width, scheme });
      await ui.setWidth(400);
      for (const id of ['#btn-import', '#btn-menu', '#btn-all', '#prev-month']) {
        const r = await ui.eval((s) => window.__t.prepClick({ css: s }), id);
        ok(16, `400px: ${id} visible and clickable`, r.ok, r.reason || '');
      }
      await ui.click(rowPart('Webwinkel Test', '.tx-date'));
      const pop = await ui.eval(() => { const r = document.querySelector('#popover-root .popover').getBoundingClientRect(); return { left: r.left, right: r.right, vw: document.documentElement.clientWidth }; });
      ok(16, '400px: row popover fits inside the window', pop.left >= 0 && pop.right <= pop.vw, short(pop));
      await ui.key('Escape');
      await ui.setWidth(1100);
    });

    // ---- pills, edit affordance, faded rows, row columns, narrow labels
    await step(16, 'month screen details', async () => {
      await goMonth(ui, '2026-09');
      for (const width of [1100, 400]) {
        await ui.setWidth(width);
        for (const scheme of ['light', 'dark']) {
          await ui.page.colorScheme(scheme);
          await ui.parkMouse();
          await ui.settle(50);
          const d = await ui.eval(() => {
            const T = window.__t;
            const rgb = (c) => (String(c).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
            const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; const [r, g, b] = rgb(c); return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
            const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
            const bgOf = (el) => { for (let a = el; a; a = a.parentElement) { const c = getComputedStyle(a).backgroundColor; if (!/rgba\(.*,\s*0\)$/.test(c) && c !== 'transparent') return c; } return getComputedStyle(document.body).backgroundColor; };
            const rows = [...document.querySelectorAll('#view-month .tx')].filter(T.visible);
            const pills = rows.map((r) => r.querySelector('.pill'));
            const names = rows.map((r) => r.querySelector('.tx-name'));
            const amounts = rows.map((r) => r.querySelector('.tx-amount'));
            const links = [...document.querySelectorAll('#view-month .link-btn, #view-month .x-month-link')].filter(T.visible);
            const catColors = new Set(['--cat-huur', '--cat-vast', '--cat-dagelijks', '--cat-eenmalig', '--cat-inkomen', '--cat-zorg'].map((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()));
            const hex = (c) => '#' + rgb(c).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
            const col = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; };
            const unknown = document.querySelector('#view-month .group.unknown .tx');
            const other = document.querySelector('#view-month .group:not(.unknown) .tx');
            return {
              pillColours: [...new Set(pills.map((p) => hex(getComputedStyle(p).color)))].filter((c) => catColors.has(c)),
              pillBorder: Math.min(...pills.map((p) => ratio(getComputedStyle(p).borderTopColor, bgOf(p.parentElement)))),
              pillText: Math.min(...pills.map((p) => ratio(getComputedStyle(p).color, bgOf(p)))),
              underline: [...new Set([...names, ...amounts].map((b) => getComputedStyle(b.querySelector('.edit-text')).textDecorationStyle))],
              minHit: Math.min(...[...names, ...amounts].map((b) => b.getBoundingClientRect().height)),
              amountCell: amounts.every((b) => { const cell = b.getBoundingClientRect(); const row = b.parentElement.getBoundingClientRect(); return Math.abs(cell.right - (row.right - 8)) < 2 && cell.width >= 50; }),
              minLink: links.length ? Math.min(...links.map((l) => l.getBoundingClientRect().height)) : null,
              faded: rows.filter((r) => r.classList.contains('faded')).map((r) => ({ opacity: getComputedStyle(r).opacity, style: getComputedStyle(r.querySelector('.tx-name')).fontStyle })),
              align: unknown && other ? {
                date: [col(unknown.querySelector('.tx-date'))[0], col(other.querySelector('.tx-date'))[0]],
                amountRight: [col(unknown.querySelector('.tx-amount'))[1], col(other.querySelector('.tx-amount'))[1]],
                pillLeft: [col(unknown.querySelector('.pill'))[0], col(other.querySelector('.pill'))[0]],
              } : null,
            };
          });
          const tag = `${width}px ${scheme}`;
          eq('extra9', `${tag}: kind pills use no category colour`, d.pillColours, []);
          ok('extra12', `${tag}: pill outline ≥ 3:1 against the row, pill text ≥ 4.5:1`, d.pillBorder >= 3 && d.pillText >= 4.5, `outline ${d.pillBorder.toFixed(2)}, text ${d.pillText.toFixed(2)}`);
          eq('extra10', `${tag}: names and amounts have a dashed underline`, d.underline, ['dashed']);
          ok('extra10', `${tag}: name/amount hit areas ≥ 32 px high`, d.minHit >= 32, `min ${d.minHit}`);
          ok('extra10', `${tag}: the amount button fills its cell (whole cell starts the edit)`, d.amountCell);
          ok('extra10', `${tag}: text links ≥ 24 px high`, d.minLink === null || d.minLink >= 24, `min ${d.minLink}`);
          ok('extra12', `${tag}: rows that do not count are not faded with opacity (muted + italic instead)`, d.faded.length > 0 && d.faded.every((f) => f.opacity === '1' && f.style === 'italic'), short(d.faded));
          ok('extra16', `${tag}: "Not sorted yet" rows line up with the other groups (date, pill, amount)`, d.align && Math.abs(d.align.date[0] - d.align.date[1]) <= 1 && Math.abs(d.align.amountRight[0] - d.align.amountRight[1]) <= 1 && (width < 560 || Math.abs(d.align.pillLeft[0] - d.align.pillLeft[1]) <= 1), short(d.align));
        }
      }
      await ui.page.colorScheme('light');
      await ui.hover({ css: '#view-month .tx', re: 'Werkgever Voorbeeld BV', child: '.tx-name' });
      ok('extra10', 'hover shows the pencil next to the name', await ui.eval(() => getComputedStyle(document.querySelector('#view-month .tx-name:hover .pencil')).visibility === 'visible'));
      await ui.parkMouse();
      await ui.setWidth(360);
      const top = await ui.eval(() => {
        const r = (id) => document.getElementById(id).getBoundingClientRect();
        const label = [...document.querySelectorAll('#btn-import > span')].filter(window.__t.visible).map((s) => s.textContent);
        return { label, sameRow: Math.abs(r('btn-import').top - r('btn-menu').top) < 2 && Math.abs(r('btn-import').top - r('btn-all').top) < 2, scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth };
      });
      ok('extra20', '360 px: the import button reads "Read file" and fits on one row with "All months" and ⋯', isDeepStrictEqual(top.label, ['Read file']) && top.sameRow && top.scroll, short(top));
      await ui.shot('topbar-360', { width: 360, fullPage: false });
      await ui.setWidth(1100);
      eq('extra20', '1100 px: "Add bank file"', await ui.eval(() => [...document.querySelectorAll('#btn-import > span')].filter(window.__t.visible).map((s) => s.textContent)), ['Add bank file']);
      const pcts = await ui.eval(() => [...document.querySelectorAll('#view-month .legend li')].map((li) => [window.__t.norm(li.querySelector('strong').textContent), li.querySelector('.muted').textContent]));
      ok('extra15', 'legend: no non-zero part shows "0%"', pcts.length > 0 && pcts.every(([v, p]) => !(cents(v) > 0 && p === '0%')), short(pcts));
    });

    // ---- item 14: print
    await step(14, 'print view', async () => {
      await goMonth(ui, '2026-09');
      await ui.eval(() => { window.__printed = 0; window.print = () => { window.__printed++; }; return true; });
      await openMenuItem(ui, 'Print');
      eq(14, 'menu "Print" calls window.print()', await ui.eval(() => window.__printed), 1);
      for (const scheme of ['light', 'dark']) {
        await ui.send('Emulation.setEmulatedMedia', { media: 'print', features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await ui.settle(100);
        const p = await ui.eval(() => {
          const T = window.__t;
          const cs = (el) => getComputedStyle(el);
          const controls = [...document.querySelectorAll('button, input, select, a[href], [role=button], [tabindex]')]
            .filter(T.visible).filter((b) => !b.matches('.tx-name, .tx-amount, .pill, .tile')).map(T.describe); // tiles print as plain tiles
          const dot = document.querySelector('#view-month .group[data-cat="inkomen"] .dot');
          return {
            controls,
            banners: [...document.querySelectorAll('#banners *')].filter(T.visible).length,
            toasts: [...document.querySelectorAll('#toast-root *')].filter(T.visible).length,
            shown: ['.tile', '.save-card', '.recap-card', '.list-card', '.bar-card'].map((s) => [...document.querySelectorAll(s)].filter(T.visible).length > 0),
            body: [cs(document.body).backgroundColor, cs(document.body).color],
            cards: [...new Set([...document.querySelectorAll('.card')].map((c) => cs(c).backgroundColor))],
            dot: dot && [cs(dot).printColorAdjust || cs(dot).webkitPrintColorAdjust, cs(dot).backgroundColor],
            pills: [...document.querySelectorAll('#view-month .pill')].filter(T.visible).length,
          };
        });
        eq(14, `print (${scheme} screen): no buttons/menus/inputs visible`, p.controls, []);
        eq(14, `print (${scheme}): banners + toasts hidden`, [p.banners, p.toasts], [0, 0]);
        eq(14, `print (${scheme}): tiles, bar, savings card, recap and list printed`, p.shown, [true, true, true, true, true]);
        eq(14, `print (${scheme}): white background, black text`, p.body, ['rgb(255, 255, 255)', 'rgb(0, 0, 0)']);
        ok(14, `print (${scheme}): cards white`, p.cards.every((c) => c === 'rgb(255, 255, 255)' || c === 'rgba(0, 0, 0, 0)'), short(p.cards));
        eq(14, `print (${scheme}): colour dots kept in the light palette (print-color-adjust: exact, Income #15803d)`, p.dot, ['exact', 'rgb(21, 128, 61)']);
        await ui.page.screenshot(join(OUT, 'shots', `print-month-1100-${scheme}.png`), { fullPage: true });
      }
      await ui.send('Emulation.setEmulatedMedia', { media: '', features: [] });
      await ui.page.pdf(join(OUT, 'shots', 'print-month.pdf'));
      ok(14, 'print PDF written (Page.printToPDF)', existsSync(resolve(APP_ROOT, OUT, 'shots', 'print-month.pdf')));
    });

    // ---- Hide words cleans existing payments at once; learned rules can be edited
    await step(16, 'Settings: hidden words + edit a rule', async () => {
      await goMonth(ui, '2026-09');
      const st0 = await ui.state();
      const word = 'Testdorp';
      const hit = st0.transactions.filter((t) => new RegExp(`\\b${word}\\b`, 'i').test(`${t.name} ${t.description}`));
      ok('extra3', `fixture: payments with "${word}" in their name or description`, hit.length > 0, String(hit.length));
      await openMenuItem(ui, 'Settings');
      await ui.waitDialog(/Settings/);
      // the hint says hidden text does not come back, and why.
      const hint = await ui.eval(() => {
        const section = document.getElementById('x-hidden-words').closest('section');
        const p = section && section.querySelector('.x-hint');
        return p ? p.textContent.replace(/\s+/g, ' ').trim() : null;
      });
      ok('extra3', 'Hide words: the hint says removed words do not come back because the app does not keep the bank\'s original text',
        /it does not come back/.test(hint || '') && /because the app does not keep the original text from the bank\./.test(hint || ''), hint);
      await ui.click({ css: '#x-hidden-words' });
      await ui.type(word);
      await ui.key('Enter');
      const st1 = await ui.state();
      eq('extra3', 'the word is stored and removed from the existing payments in the same step', [st1.settings.hiddenWords, st1.transactions.filter((t) => new RegExp(`\\b${word}\\b`, 'i').test(`${t.name} ${t.description}`)).length], [[word], 0]);
      const toast = (await ui.toasts()).find((t) => t.startsWith('Saved.'));
      eq('extra3', 'toast says how many payments changed', toast, `Saved. ${hit.length} ${hit.length === 1 ? 'payment' : 'payments'} changed.`);
      const shown = await ui.eval((w) => [...document.querySelectorAll('#view-month .tx-name')].some((b) => b.textContent.includes(w)), word);
      eq('extra3', 'the names on the month screen changed at once (behind the dialog)', shown, false);
      await ui.shot('settings-hidden-words', { width: 1100, fullPage: false });
      await ui.shot('settings-hidden-words', { width: 400, scheme: 'dark', fullPage: false });
      await ui.click({ css: '#toast-root .toast', re: '^Saved\\. \\d+', child: '.toast-action' });
      const st2 = await ui.state();
      eq('extra3', '"Undo" brings the names and the empty word list back', [st2.settings.hiddenWords, diffPaths(st2.transactions, st0.transactions)], [[], []]);
      eq('extra3', 'and the field in the dialog shows the list as it is again', await ui.eval(() => document.getElementById('x-hidden-words').value), '');

      // edit a learned rule (category, kind, name); saving gives it a fresh createdAt.
      const rule = st2.rules.find((r) => /telecom/i.test(r.match.nameContains || ''));
      await ui.click({ css: '#dialog-root .x-rules li', re: 'Telecom Test BV', child: 'button' });
      eq('extra5', 'Rules: [Change] opens the editor with the category and kind buttons of the popover', await ui.eval(() => {
        const box = document.querySelector('#dialog-root .x-rule-editing');
        return box && [...box.querySelectorAll('.choice-row')].map((r) => r.getAttribute('aria-label'));
      }), ['What is it?', 'Kind of payment']);
      eq('extra5', 'the editor starts on the rule as it is', await ui.texts({ css: '#dialog-root .x-rule-editing .choice[aria-pressed="true"]' }), ['Fixed costs & subscriptions', 'every month']);
      await ui.click({ css: '#dialog-root .x-rule-editing .choice', text: 'One-off' });
      await ui.click({ css: '#dialog-root .x-rule-editing .choice', text: 'varies' });
      await ui.click({ css: '#dialog-root .x-rule-editing input' });
      await ui.type('Telefoon');
      await ui.shot('settings-rule-edit', { width: 1100, fullPage: false });
      await ui.shot('settings-rule-edit', { width: 400, scheme: 'dark', fullPage: false });
      await ui.click({ css: '#dialog-root .x-rule-editing button', text: 'Save' });
      const st3 = await ui.state();
      const edited = st3.rules.find((r) => r.id === rule.id);
      eq('extra5', 'saved: category, kind and rename text changed, match kept', edited && { match: edited.match, set: edited.set }, { match: rule.match, set: { categoryId: 'eenmalig', kind: 'wisselend', rename: 'Telefoon' } });
      ok('extra5', 'saved: the rule got a fresh createdAt (newest rule first)', edited && edited.createdAt > rule.createdAt && st3.rules.every((r) => r.id === rule.id || r.createdAt <= edited.createdAt), `${rule.createdAt} -> ${edited && edited.createdAt}`);
      eq('extra5', 'the list shows the new rule text first', (await ui.texts({ css: '#dialog-root .x-rules li .x-rule-text' }))[0], "Name contains 'Telecom Test BV' and bank TEST and money out → One-off · varies · call it: 'Telefoon'");
      await ui.click({ css: '#toast-root .toast', re: '^Rule changed', child: '.toast-action' });
      eq('extra5', '"Undo" puts the rule back', diffPaths((await ui.state()).rules, st2.rules), []);
      await ui.click(btn('Done'));
    });

    // ---- item 13: backup -> wipe -> restore -> identical
    await step(13, 'backup + restore', async () => {
      let v = await month(ui);
      ok(13, 'reminder banner still there before the backup', v.banners.some((b) => b.startsWith(BACKUP_BANNER)), short(v.banners));
      const undoBefore = await ui.eval(() => Budget.store.topUndoToken());
      await openMenuItem(ui, 'Make backup');
      const name = `budget-backup-${todayLocal()}.json`; // the date on the PC's clock
      const file = join(ui.downloadDir, name);
      let backup = null;
      for (let i = 0; i < 50 && !backup; i++) {
        try { backup = JSON.parse(readFileSync(file, 'utf8')); } catch { await delay(100); }
      }
      ok(13, `"Make backup" downloads ${name}`, Boolean(backup), readdirSync(ui.downloadDir).join(', '));
      eq(13, 'backup file format {app, version, exportedAt, state}', backup && [backup.app, backup.version, typeof backup.exportedAt, Object.keys(backup).sort()], ['budget-nl', 1, 'string', ['app', 'exportedAt', 'state', 'version']]);
      await delay(400);
      const original = await ui.state();
      eq(13, 'backup state = app state (lastBackupAt = exportedAt)', diffPaths(backup.state, original), []);
      eq(13, 'lastBackupAt stored', original.settings.lastBackupAt, backup.exportedAt);
      v = await month(ui);
      ok(13, 'reminder banner gone after the backup', !v.banners.some((b) => b.startsWith(BACKUP_BANNER)), short(v.banners));
      ok(13, 'toast "Backup downloaded: …"', (await ui.toasts()).includes(`Backup downloaded: ${name}`));
      ok('extra4', '"Make backup" keeps the last edit undoable (keepUndo)', undoBefore && (await ui.eval((t) => Budget.store.canUndo(t), undoBefore)), String(undoBefore));

      await openMenuItem(ui, 'Settings');
      await ui.waitDialog(/Settings/);
      await ui.click({ css: '#dialog-root button', text: 'Clear everything…' });
      let d = await ui.waitDialog(/removed/);
      eq(13, 'Clear everything: first confirm', d.buttons, ['Yes, clear', 'Cancel']);
      await ui.click(btn('Yes, clear'));
      d = await ui.waitDialog(/Really clear everything/);
      eq(13, 'Clear everything: second confirm', d.buttons, ['Clear everything', 'Cancel']);
      await ui.click(btn('Clear everything'));
      await delay(200);
      const wiped = await ui.state();
      eq(13, 'state empty after "Clear everything"', [wiped.transactions.length, wiped.statements.length, wiped.rules.length, (await month(ui)).empty], [0, 0, 0, true]);
      await ui.eval(() => { localStorage.clear(); return true; });
      await ui.reload();
      eq(13, 'storage cleared + reload -> empty first-run screen', [(await month(ui)).empty, await ui.eval(() => localStorage.length)], [true, 0]);

      await ui.click({ css: '#btn-menu' });
      await ui.chooseFiles([file], { css: '#menu-root .menu-item', text: 'Restore backup' });
      d = await ui.waitDialog(/Restore/);
      ok(13, 'restore asks to confirm, with counts', d.body.includes(`It holds ${original.transactions.length} payments`) && d.body.includes('Your current data (0 payments) will be replaced.'), d.body);
      eq(13, 'restore confirm buttons', d.buttons, ['Restore', 'Cancel']);
      await ui.click(btn('Restore'));
      await waitToast(ui, /Backup restored/);
      const restored = await ui.state();
      eq(13, 'restored state is deeply identical to the original', diffPaths(restored, original), []);
      ok(13, 'isDeepStrictEqual(restored, original)', isDeepStrictEqual(restored, original));
      await delay(400);
      await ui.reload();
      eq(13, 'identical after a reload too', diffPaths(await ui.state(), original), []);
      v = await month(ui);
      ok(13, 'no banner after the restore', v.banners.length === 0, short(v.banners));
      ok(13, 'restore opens the latest (booked) month', v.label === Budget_label(bookedMonths(original).at(-1)), v.label);
      ctx.backupFile = file;
    });

    await step(1, 'main session health', () => sessionHealth(ui, 1, 'main session (Edge, whole flow)'));
  } finally {
    for (const i of ui.incidents) console.log(`INFO  toast closed by the driver because it covered a click target: ${i}`);
    await ui.close();
  }
  return ctx;
}

/** CSV rows in the state vs the independent CSV reader (date, name, type, amount, bank code, cleaned description). */
function checkCsvRows(st, fx, tag, renames) {
  const months = new Set(fx.rows.map((r) => r.date.slice(0, 7)));
  const got = st.transactions.filter((t) => t.source === 'csv' && months.has(t.date.slice(0, 7)))
    .map((t) => `${t.date}|${t.name}|${t.type}|${t.amount}|${t.bankCode}`).sort();
  const want = fx.rows.map((r) => `${r.date}|${renames[r.rawName] || mask(r.rawName)}|${r.type}|${r.amount}|${r.bankCode}`).sort();
  eq(4, `${tag}: every row (date, name, type, amount, bank code)`, got, want);
  const dirty = st.transactions.filter((t) => t.source === 'csv' && months.has(t.date.slice(0, 7)))
    .filter((t) => /[A-Z]{2}\d{2}[A-Z]{4}\d{6,}|\d{6,}|Kenmerk|Reference|Machtiging|Mandate|Incassant|Creditor|Pasvolgnr|Card sequence|Transactie|Transaction:|Term:|Valutadatum|Value date|IBAN|Datum\s*\/\s*Tijd|Date\/time/i.test(`${t.name} ${t.description}`));
  eq(4, `${tag}: descriptions cleaned`, dirty.map((t) => `${t.name}: ${t.description}`), []);
}

// ------------------------------------------------------------------------------------------------ item 17

async function robustRun() {
  const ui = await startEdge({ label: 'robust', root: OUT });
  try {
    await ui.open(fileUrl(APP));
    await step(17, 'bad files on an empty app', async () => {
      for (const [file, how] of [[F.notIng, 'chooser'], [F.corrupt, 'drop'], [F.garbage, 'input']]) {
        const before = await ui.state();
        if (how === 'chooser') await ui.chooseFiles([file], { css: '#btn-import' });
        else if (how === 'drop') await ui.drop([file]);
        else await ui.setFiles('#file-input', [file]);
        const d = await ui.waitDialog(/./);
        eq(17, `${file}: friendly message`, [d.title, d.body, d.buttons], ['File not read', READ_ERROR, ['Close']]);
        await ui.click(btn('Close'));
        eq(17, `${file}: nothing changed`, diffPaths(await ui.state(), before), []);
      }
      eq(17, 'bad files: still the empty first-run screen, nothing stored', [(await month(ui)).empty, await ui.eval(() => localStorage.getItem('budget-nl:v1'))], [true, null]);
    });
    await step(17, 'bad file next to data', async () => {
      await ui.setFiles('#file-input', [F.pdf1]);
      await ui.waitDialog(/found/);
      await ui.click(btn('Add'));
      await delay(400);
      const before = await ui.state();
      await ui.setFiles('#file-input', [F.semi, F.garbage]);
      const d = await ui.waitDialog(/found/);
      ok(17, 'good + bad file together: good one listed, bad one named with the message', d.body.includes('12 payments found') && d.body.includes(`garbage.csv: ${READ_ERROR}`), d.body);
      await ui.click(btn('Cancel'));
      await ui.setFiles('#file-input', [F.corrupt]);
      await ui.waitDialog(/not read/);
      await ui.click(btn('Close'));
      eq(17, 'corrupt file after an import: data unchanged', diffPaths(await ui.state(), before), []);
    });
    await step(17, 'bad files session health', () => sessionHealth(ui, 17, 'bad files'));
  } finally {
    await ui.close();
  }

  // storage disabled: the profile blocks site data for every site (Edge content setting, real SecurityError)
  const blocked = await startEdge({ label: 'blocked', root: OUT, preferences: { profile: { default_content_setting_values: { cookies: 2 } } } });
  try {
    await blocked.open(fileUrl(APP));
    await step(17, 'storage disabled', async () => {
      const probe = await blocked.eval(() => { try { return typeof localStorage.getItem('x'); } catch (e) { return `throws: ${e.name}`; } });
      ok(17, 'storage really is blocked in this profile', /^throws/.test(probe), probe);
      let v = await month(blocked);
      ok(17, 'red banner "Your data is NOT being saved…"', v.banners.some((b) => b.startsWith(STORAGE_BANNER)), short(v.banners));
      eq(17, 'banner is the red (error) kind', await blocked.eval(() => document.querySelector('#banners .banner').className.includes('error')), true);
      eq(17, 'store.storageOk() === false', await blocked.eval(() => Budget.store.storageOk()), false);
      await blocked.chooseFiles([F.pdf1], { css: '#btn-import' });
      await blocked.waitDialog(/found/);
      await blocked.click(btn('Add'));
      await delay(500);
      v = await month(blocked);
      ok(17, 'app keeps working in memory (import shows September 2026)', v.label === 'September 2026' && v.groups.length > 0, v.label);
      ok(17, 'red banner stays (not replaced by the backup reminder)', v.banners.length === 1 && v.banners[0].startsWith(STORAGE_BANNER), short(v.banners));
      await blocked.click(rowPart('DROGIST', '.tx-amount'));
      await blocked.type('20.00');
      await blocked.key('Enter');
      eq(17, 'editing works without storage', (await blocked.state()).transactions.find((t) => t.name.startsWith('DROGIST')).amount, -2000);
      await blocked.shot('storage-blocked', { width: 400 });
    });
    await step(17, 'storage disabled health', () => sessionHealth(blocked, 17, 'storage disabled'));
  } finally {
    await blocked.close();
  }

  // corrupt stored JSON
  const bad = await startEdge({ label: 'corrupt', root: OUT });
  try {
    await bad.open(fileUrl(APP));
    await step(17, 'corrupt stored JSON', async () => {
      const raw = '{"version":1,"transactions":[{"date":"2026-09-0';
      await bad.eval((r) => { localStorage.setItem('budget-nl:v1', r); return true; }, raw);
      await bad.reload();
      const d = await bad.dialog();
      eq(17, 'recovery prompt "Saved data is damaged" [Restore backup] [Start over]', d && [d.title, d.buttons], ['Saved data is damaged', ['Restore backup', 'Start over']]);
      const keys = await bad.eval(() => Object.keys(localStorage).sort());
      const copy = keys.find((k) => /^budget-nl:v1:corrupt-\d+$/.test(k));
      ok(17, 'corrupt string kept under budget-nl:v1:corrupt-<ts>', copy && (await bad.eval((k) => localStorage.getItem(k), copy)) === raw, short(keys));
      eq(17, 'original key not overwritten while the prompt is open', await bad.eval(() => localStorage.getItem('budget-nl:v1')), raw);
      ok(17, 'no crash: app shell + top bar are there', await bad.eval(() => Boolean(window.Budget && Budget.app && document.querySelector('.topbar') && window.__t.visible(document.querySelector('#btn-import')))));
      await bad.shot('corrupt-prompt', { width: 400, fullPage: false });
      await bad.click(btn('Start over'));
      await delay(400);
      const v = await month(bad);
      ok(17, '"Start over" -> empty budget, storage usable again', v.empty && (await bad.eval(() => Budget.store.storageOk())) && JSON.parse(await bad.eval(() => localStorage.getItem('budget-nl:v1'))).transactions.length === 0);
      ok(17, 'corrupt copy still kept after "Start over"', (await bad.eval((k) => localStorage.getItem(k), copy)) === raw);
      await bad.eval(() => { localStorage.setItem('budget-nl:v1', '{"version":1,"transactions":"kapot"}'); return true; });
      await bad.reload();
      const d2 = await bad.dialog();
      eq(17, 'valid JSON with a broken structure -> same recovery prompt', d2 && d2.title, 'Saved data is damaged');
    });
    await step(17, 'corrupt JSON health', () => sessionHealth(bad, 17, 'corrupt stored JSON'));
  } finally {
    await bad.close();
  }
}

// ------------------------------------------------------------------------------------------------ clickable tiles
// The clickable tiles on the demo seed (FAKE), in its own fresh profile. Labels follow the six points of the
// tile design: [TILES-1] the tiles (5, clickable look, fit at every width), [TILES-2] the popup (modal, title, ✕/Esc/
// backdrop, focus back, keyboard only, scrolls inside, phone sheet), [TILES-3] what a popup shows (one line per name,
// unfold, total = tile, moved payments), [TILES-4] the "Left this month" sum, [TILES-5] read-only, [TILES-6] every
// month, light/dark, 400/360 px, print, no HTML from bank text, never stale (undo, import while open).

const TILE_KEYS = ['income', 'fixed', 'daily', 'oneoff', 'left'];
const TILE_LABEL = { income: 'Income', fixed: 'Fixed costs', daily: 'Daily spending', oneoff: 'One-off', unknown: 'Not sorted yet', left: 'Left this month' };
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDay = (iso) => `${Number(iso.slice(8, 10))} ${SHORT_MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const tileSpec = (key) => ({ css: `#view-month .tile[data-tile="${key}"]` });
const topX = { css: '#dialog-root .dialog-backdrop:last-child .dialog-x' };

// The top dialog as the user sees it (normalised text).
function readPopup() {
  const n = window.__t.norm;
  const all = [...document.querySelectorAll('#dialog-root .dialog')];
  const d = all[all.length - 1];
  if (!d) return null;
  const label = d.getAttribute('aria-labelledby');
  const amt = (el) => (el ? n(el.textContent) : null);
  return {
    count: all.length,
    tp: d.classList.contains('tp'),
    title: n(d.querySelector('h2').textContent),
    role: d.getAttribute('role'),
    modal: d.getAttribute('aria-modal'),
    labelled: label && document.getElementById(label) ? n(document.getElementById(label).textContent) : null,
    rows: [...d.querySelectorAll('.tp-row')].map((b) => ({
      key: b.getAttribute('data-key'),
      name: n(b.querySelector('.tp-name-text').textContent),
      sub: b.querySelector('.tp-count') ? n(b.querySelector('.tp-count').textContent) : null,
      amount: amt(b.querySelector('.tp-amt')),
      green: b.querySelector('.tp-amt').classList.contains('amount-in'),
      expanded: b.getAttribute('aria-expanded'),
      controls: b.getAttribute('aria-controls'),
      dot: getComputedStyle(b.querySelector('.dot')).backgroundColor,
    })),
    pays: [...d.querySelectorAll('.tp-pays')].filter((l) => !l.hidden).map((l) => ({
      id: l.id,
      items: [...l.querySelectorAll('.tp-pay')].map((p) => ({
        date: n(p.querySelector('.tp-date').textContent),
        desc: p.querySelector('.tp-desc') ? n(p.querySelector('.tp-desc').textContent) : '',
        tags: [...p.querySelectorAll('.tp-tag')].map((t) => n(t.textContent)),
        amount: amt(p.querySelector('.tp-amt')),
      })),
    })),
    total: d.querySelector('.tp-total') ? { label: n(d.querySelector('.tp-total > span').textContent), value: amt(d.querySelector('.tp-total .tp-amt')), cls: d.querySelector('.tp-total .tp-amt').className } : null,
    notes: [...d.querySelectorAll('.tp-notes li')].map((li) => n(li.textContent)),
    empty: d.querySelector('.tp-empty') ? n(d.querySelector('.tp-empty').textContent) : null,
    editable: d.querySelectorAll('input, select, textarea, [contenteditable], .editable').length,
  };
}

function focusInfo() {
  const a = document.activeElement;
  const cs = a ? getComputedStyle(a) : null;
  return {
    tile: a && a.dataset ? a.dataset.tile || null : null,
    key: a && a.getAttribute ? a.getAttribute('data-key') : null,
    inDialog: Boolean(a && a.closest && a.closest('#dialog-root .dialog-backdrop:last-child .dialog')),
    expanded: a && a.getAttribute ? a.getAttribute('aria-expanded') : null,
    ring: cs ? { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) } : null,
    what: a ? window.__t.describe(a).slice(0, 60) : null,
  };
}

/** The tiles as numbers (cents), read from the screen. */
async function tileCents(ui) {
  const v = await month(ui);
  const keys = await ui.eval(() => [...document.querySelectorAll('#view-month .tile')].map((t) => t.dataset.tile));
  return Object.fromEntries(keys.map((k, i) => [k, cents(v.tiles[i].value)]));
}

/** Expected labels on one payment. */
function expectTags(key, pay) {
  const tags = [];
  if (pay.kind === 'eenmalig' && key !== 'oneoff') tags.push('one-off');
  if (pay.paidIn) tags.push(`paid ${shortDay(pay.date)}`);
  if (key !== 'unknown' && pay.value < 0) tags.push(key === 'income' ? 'out' : 'back');
  return tags;
}

/** Checks the open popup of section `key` against the independent expectation; returns the popup. */
async function checkSectionPopup(ui, st, M, key, tag, tiles) {
  const t = tilesOf(st, M);
  const exp = t[key];
  const p = await ui.eval(readPopup);
  if (!p) throw new Error(`${tag}: no popup open`);
  eq('TILES-2', `${tag}: title "${TILE_LABEL[key]} — ${Budget_label(M)}"`, p.title, `${TILE_LABEL[key]} — ${Budget_label(M)}`);
  ok('TILES-2', `${tag}: role=dialog, aria-modal=true, labelled by its title`, p.tp && p.role === 'dialog' && p.modal === 'true' && p.labelled === p.title, short(p.labelled));
  const total = p.total && cents(p.total.value);
  eq('TILES-3', `${tag}: "Total" = the independent total`, [p.total && p.total.label, total], ['Total', exp.total]);
  if (tiles && key in tiles) eq('TILES-3', `${tag}: "Total" = the tile, same cents`, total, tiles[key]);
  const got = p.rows.map((r) => `${r.name}|${cents(r.amount)}|${r.sub || ''}`).sort();
  const want = exp.lines.map((l) => `${l.name || 'No name'}|${l.total}|${l.count > 1 ? `${l.count} payments` : ''}`).sort();
  eq('TILES-3', `${tag}: one line per name (name, total, count)`, got, want);
  const size = (r) => (key === 'unknown' ? Math.abs(cents(r.amount)) : cents(r.amount));
  ok('TILES-3', `${tag}: biggest first`, p.rows.every((r, i) => i === 0 || size(p.rows[i - 1]) >= size(r)), short(p.rows.map((r) => r.amount)));
  eq('TILES-3', `${tag}: the lines add up to the total`, sum(p.rows.map((r) => cents(r.amount))), total);
  ok('TILES-3', `${tag}: every name is a button with aria-expanded=false and its colour dot`, p.rows.every((r) => r.expanded === 'false' && r.controls && !/rgba\(0, 0, 0, 0\)/.test(r.dot)));
  // (a payment paid in this month that counts in another one is in the notes, so the line does not say "no payments")
  if (!exp.lines.length) {
    const empty = exp.elsewhere.length ? 'No payments that count in this month.' : 'No payments in this month.';
    eq('TILES-6', `${tag}: nothing counts here -> "${empty}"`, p.empty, empty);
  }
  const notes = exp.elsewhere.slice().sort((a, b) => b.date.localeCompare(a.date))
    .map((x) => `${shortDay(x.date)} · ${x.name || 'No name'} · ${euro(x.value, { sign: key === 'unknown' })} — counts in ${Budget_label(x.countsIn)}`);
  if (key === 'income' && t.unknown.moneyIn > 0) notes.push(`${euro(t.unknown.moneyIn, { sign: true })} not sorted yet — not in this total`);
  if (key === 'unknown' && exp.lines.length) notes.push("Choose what it is in the list 'All payments, by colour'.");
  eq('TILES-3', `${tag}: grey notes (payments paid here that count in another month)`, p.notes, notes);
  eq('TILES-5', `${tag}: read-only (no fields or edit buttons)`, p.editable, 0);
  return p;
}

/** Unfolds the first name of the open popup and checks its payments; folds it again. */
async function checkUnfold(ui, st, M, key, tag) {
  const exp = tilesOf(st, M)[key];
  const p0 = await ui.eval(readPopup);
  if (!p0.rows.length) return;
  const first = p0.rows[0];
  const line = exp.lines.find((l) => (l.name || 'No name') === first.name && l.total === cents(first.amount));
  await ui.click({ css: '#dialog-root .dialog-backdrop:last-child .tp-payee', nth: 0 });
  const p1 = await ui.eval(readPopup);
  eq('TILES-3', `${tag}: clicking "${first.name}" unfolds it (aria-expanded=true)`, [p1.rows[0].expanded, p1.pays.map((l) => l.id)], ['true', [first.controls]]);
  const want = line ? line.payments.map((x) => ({ date: shortDay(x.date), desc: x.description.replace(/\s+/g, ' ').trim(), tags: expectTags(key, x), amount: euro(x.value, { sign: key === 'unknown' }) })) : null;
  eq('TILES-3', `${tag}: its payments (date d mmm, description, labels, amount), newest first`, p1.pays[0] && p1.pays[0].items, want);
  await ui.click({ css: '#dialog-root .dialog-backdrop:last-child .tp-payee', nth: 0 });
  eq('TILES-3', `${tag}: a second click folds it again`, (await ui.eval(readPopup)).rows[0].expanded, 'false');
}

/** Checks the open "Left this month" popup: lines add up exactly to the tile. */
async function checkOverPopup(ui, st, M, tag, tiles) {
  const t = tilesOf(st, M);
  const p = await ui.eval(readPopup);
  eq('TILES-4', `${tag}: title`, p.title, `Left this month — ${Budget_label(M)}`);
  const want = [['Income', t.income.amount], ['Fixed costs', t.fixed.amount], ['Daily spending', t.daily.amount], ['One-off', t.oneoff.amount]];
  if (t.unknown.moneyIn || t.unknown.moneyOut) want.push(['Not sorted yet', t.unknown.amount]);
  eq('TILES-4', `${tag}: one line per part (Not sorted yet only when not zero)`, p.rows.map((r) => [r.name, cents(r.amount)]), want);
  eq('TILES-4', `${tag}: the lines add up EXACTLY to "Left this month" = the tile`, [sum(p.rows.map((r) => cents(r.amount))), p.total && p.total.label, cents(p.total.value)],
    [t.left, 'Left this month', tiles ? tiles.left : t.left]);
  const both = t.unknown.moneyIn && t.unknown.moneyOut;
  const nk = p.rows.find((r) => r.name === 'Not sorted yet');
  if (nk) eq('TILES-4', `${tag}: Not sorted yet shows money in and out when it has both`, nk.sub, both ? `${euro(t.unknown.moneyIn, { sign: true })} in, ${euro(t.unknown.moneyOut, { sign: true })} out` : null);
  eq('TILES-4', `${tag}: one grey note for what does not count (savings …)`, p.notes.map((x) => x.replace(/\(net .*\)\.$/, '(net …).')),
    t.notCounted.count ? [`Not in this sum: ${t.notCounted.count} ${t.notCounted.count === 1 ? "payment that doesn't count" : "payments that don't count"}, such as savings (net …).`] : []);
  if (t.notCounted.count) ok('TILES-4', `${tag}: the note's amount`, cents(p.notes[0].replace(/^.*\(net /, '')) === t.notCounted.amount, p.notes[0]);
  eq('TILES-5', `${tag}: read-only`, p.editable, 0);
  return p;
}

/** Closes the top popup the given way and checks that it is gone and where the focus went. */
async function closePopup(ui, how, tag, { expectTile = null, expectKey = null, left = 0 } = {}) {
  if (how === 'Esc') await ui.key('Escape');
  else if (how === '✕') await ui.click(topX);
  else {
    const spot = await ui.eval(() => {
      const el = document.elementFromPoint(6, 6);
      return el && el.classList.contains('dialog-backdrop') && el === document.querySelector('#dialog-root .dialog-backdrop:last-child');
    });
    if (!spot) throw new Error(`${tag}: (6, 6) is not on the top backdrop`);
    await ui.clickAt(6, 6);
  }
  const count = await ui.eval(() => document.querySelectorAll('#dialog-root .dialog').length);
  const f = await ui.eval(focusInfo);
  eq('TILES-2', `${tag}: ${how} closes the popup`, count, left);
  if (expectTile) eq('TILES-2', `${tag}: focus back on the tile after ${how}`, f.tile, expectTile, f.what);
  if (expectKey) eq('TILES-2', `${tag}: focus back on the line after ${how}`, f.key, expectKey, f.what);
}

async function tilesRun() {
  const seed = JSON.parse(readFileSync(resolve(APP_ROOT, 'seed/demo-seed.json'), 'utf8'));
  const ui = await startEdge({ label: 'tiles', root: OUT });
  const closeWays = ['Esc', '✕', 'backdrop'];
  let way = 0;
  try {
    await ui.open(fileUrl(DEMO));

    await step('TILES-1', 'five clickable tiles that fit', async () => {
      const st = await ui.state();
      const M = bookedMonths(st).at(-1);
      const info = () => ui.eval(() => [...document.querySelectorAll('#view-month .tile')].map((t) => {
        const r = t.getBoundingClientRect();
        const cs = getComputedStyle(t);
        const more = t.querySelector('.tile-more');
        return {
          key: t.dataset.tile, tag: t.tagName, type: t.type, popup: t.getAttribute('aria-haspopup'), cursor: cs.cursor, transform: cs.transform,
          top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), border: cs.borderTopColor, bg: cs.backgroundColor,
          stripe: getComputedStyle(t, '::before').backgroundColor, more: more && window.__t.visible(more) ? window.__t.norm(more.textContent) : null,
        };
      }));
      const tiles = await info();
      eq('TILES-1', 'five tiles in order: Income, Fixed costs, Daily spending, One-off, Left this month', (await month(ui)).tiles.map((x) => x.label), ['Income', 'Fixed costs', 'Daily spending', 'One-off', 'Left this month']);
      eq('TILES-1', 'each tile is a <button type=button aria-haspopup=dialog> with a pointer cursor and a "View ›" hint',
        tiles.map((x) => [x.tag, x.type, x.popup, x.cursor, x.more]), TILE_KEYS.map(() => ['BUTTON', 'button', 'dialog', 'pointer', 'View']));
      const t = tilesOf(st, M);
      eq('TILES-1', 'tile numbers = the independent totals (One-off = one-off spending)', await tileCents(ui),
        { income: t.income.total, fixed: t.fixed.total, daily: t.daily.total, oneoff: t.oneoff.total, left: t.left });
      const pink = await ui.eval(() => getComputedStyle(document.documentElement).getPropertyValue('--cat-eenmalig').trim());
      eq('TILES-1', 'the One-off tile has the one-off colour stripe', tiles.find((x) => x.key === 'oneoff').stripe, pink === '#db2777' ? 'rgb(219, 39, 119)' : pink);
      ok('TILES-1', '1100 px: all five in one row', new Set(tiles.map((x) => x.top)).size === 1, short(tiles.map((x) => x.top)));
      await ui.hover(tileSpec('fixed'));
      const hovered = (await info()).find((x) => x.key === 'fixed');
      ok('TILES-1', 'hover: no transform / lift, only border + background change', hovered.transform === 'none' && hovered.top === tiles[1].top && (hovered.border !== tiles[1].border || hovered.bg !== tiles[1].bg), short({ before: tiles[1], hovered }));
      await ui.parkMouse();
      const rows = async () => { const x = await info(); return x.map((a) => a.top); };
      await ui.setWidth(760);
      let tops = await rows();
      ok('TILES-1', '760 px: 3 + 2 (One-off and Left side by side)', tops[0] === tops[1] && tops[1] === tops[2] && tops[3] === tops[4] && tops[3] > tops[0], short(tops));
      for (const w of [400, 360]) {
        await ui.setWidth(w);
        const x = await info();
        tops = x.map((a) => a.top);
        ok('TILES-1', `${w} px: 2 + 2 + 1, "Left this month" full width at the bottom`, tops[0] === tops[1] && tops[2] === tops[3] && tops[4] > tops[2] && tops[2] > tops[0]
          && x[4].left === x[0].left && x[4].right === x[1].right, short(x.map((a) => [a.top, a.left, a.right])));
        const o = await ui.eval(overflowReport);
        ok('TILES-1', `${w} px: no horizontal scroll`, o.scrollWidth <= o.vw && o.count === 0, o.count ? short(o.overflow) : `scrollWidth ${o.scrollWidth} <= ${o.vw}`);
        await ui.shot('tiles', { width: w, fullPage: false });
      }
      await ui.setWidth(1100);
      for (const scheme of ['light', 'dark']) await ui.shot('tiles', { width: 1100, scheme, fullPage: false });
    });

    const st0 = await ui.state();
    await step('TILES-3', 'every tile of every month: totals, names, unfold, close (Esc, ✕, backdrop)', async () => {
      for (const M of monthsWithData(st0)) {
        await goMonth(ui, M);
        const tiles = await tileCents(ui);
        for (const key of TILE_KEYS) {
          const tag = `${M} ${TILE_LABEL[key]}`;
          await ui.click(tileSpec(key));
          if (key === 'left') {
            const p = await checkOverPopup(ui, st0, M, tag, tiles);
            for (const row of p.rows) {
              const sub = row.key.slice(5);
              await ui.click({ css: '#dialog-root .dialog-backdrop:last-child .tp-line', text: undefined, re: `^${row.name}` });
              const c = await ui.eval(readPopup);
              eq('TILES-4', `${tag}: clicking "${row.name}" opens its popup on top`, [c.count, c.title], [2, `${TILE_LABEL[sub]} — ${Budget_label(M)}`]);
              await checkSectionPopup(ui, st0, M, sub, `${tag} › ${row.name}`, sub === 'unknown' ? null : tiles);
              const how = closeWays[way++ % 3];
              await closePopup(ui, how, `${tag} › ${row.name}`, { expectKey: row.key, left: 1 });
            }
          } else {
            await checkSectionPopup(ui, st0, M, key, tag, tiles);
            await checkUnfold(ui, st0, M, key, tag);
          }
          const how = closeWays[way++ % 3];
          await closePopup(ui, how, tag, { expectTile: key });
        }
      }
      eq('TILES-5', 'opening, unfolding and closing every popup changed nothing', diffPaths(await ui.state(), st0), []);
    });

    await step('TILES-3', 'moved payment: grey note where it was paid, "paid" where it counts', async () => {
      const moved = st0.transactions.find((x) => x.month !== x.date.slice(0, 7) && x.kind !== 'telt-niet-mee');
      ok('TILES-3', 'fixture: the demo seed has a payment paid in one month that counts in the next', Boolean(moved), short(moved));
      await goMonth(ui, moved.date.slice(0, 7));
      await ui.click(tileSpec('fixed'));
      const p = await ui.eval(readPopup);
      const note = `${shortDay(moved.date)} · ${moved.name} · ${euro(-moved.amount)} — counts in ${Budget_label(moved.month)}`;
      const paidHere = st0.transactions.filter((x) => x.month === moved.date.slice(0, 7) && x.kind !== 'telt-niet-mee' && ['huur', 'zorg', 'vast'].includes(x.categoryId));
      ok('TILES-3', `paid month: grey note "${note}", not in the total`, p.notes.includes(note) && cents(p.total.value) === -sum(paidHere.map((x) => x.amount))
        && !paidHere.some((x) => x.id === moved.id), short({ notes: p.notes, total: p.total }));
      await ui.shot('tiles-popup-moved-note', { width: 1100, fullPage: false });
      await ui.key('Escape');
      await goMonth(ui, moved.month);
      await ui.click(tileSpec('fixed'));
      const idx = (await ui.eval(readPopup)).rows.findIndex((r) => r.name === moved.name);
      await ui.click({ css: '#dialog-root .tp-payee', nth: idx });
      const q = await ui.eval(readPopup);
      ok('TILES-3', `month it counts for: its row says "paid ${shortDay(moved.date)}"`, q.pays.some((l) => l.items.some((x) => x.date === shortDay(moved.date) && x.tags.includes(`paid ${shortDay(moved.date)}`))), short(q.pays));
      await ui.shot('tiles-popup-paid', { width: 400, scheme: 'dark', fullPage: false });
      await ui.key('Escape');
    });

    await step('TILES-2', 'keyboard only', async () => {
      await goMonth(ui, bookedMonths(st0).at(-1));
      await ui.eval(() => { document.getElementById('btn-menu').focus(); return true; });
      let f = null;
      for (let i = 0; i < 15; i++) {
        await ui.key('Tab');
        f = await ui.eval(focusInfo);
        if (f.tile) break;
      }
      eq('TILES-2', 'Tab reaches the first tile', f.tile, 'income', f.what);
      ok('TILES-1', 'a tile focused by keyboard shows a visible focus ring', f.ring.style === 'solid' && f.ring.width >= 2, short(f.ring));
      await ui.key('Enter');
      let p = await ui.eval(readPopup);
      f = await ui.eval(focusInfo);
      ok('TILES-2', 'Enter opens the popup and moves the focus into it', p && p.title.startsWith('Income') && f.inDialog, f.what);
      const inside = [];
      for (let i = 0; i < 14; i++) { await ui.key('Tab'); inside.push((await ui.eval(focusInfo)).inDialog); }
      for (let i = 0; i < 6; i++) { await ui.key('Tab', { shift: true }); inside.push((await ui.eval(focusInfo)).inDialog); }
      ok('TILES-2', 'Tab and Shift+Tab keep the focus inside the popup', inside.every(Boolean), short(inside));
      await ui.eval(() => { document.querySelector('#dialog-root .dialog .dialog-body').focus(); return true; }); // where the focus starts
      for (let i = 0; i < 6; i++) {
        await ui.key('Tab');
        f = await ui.eval(focusInfo);
        if (f.key && f.key.startsWith('payee:')) break;
      }
      ok('TILES-2', 'from the popup body (where the focus starts) Tab reaches the first name', f.key && f.key.startsWith('payee:'), f.what);
      await ui.key('Space');
      eq('TILES-2', 'Space unfolds the name', (await ui.eval(focusInfo)).expanded, 'true');
      await ui.key('Enter');
      eq('TILES-2', 'Enter folds it again', (await ui.eval(focusInfo)).expanded, 'false');
      await ui.key('Escape');
      f = await ui.eval(focusInfo);
      ok('TILES-2', 'Esc closes it; focus back on the tile, with its focus ring', !(await ui.eval(readPopup)) && f.tile === 'income' && f.ring.style === 'solid', short(f));
      await ui.key('Tab');
      await ui.key('Space');
      p = await ui.eval(readPopup);
      ok('TILES-2', 'Tab to "Fixed costs" + Space opens its popup', p && p.title.startsWith('Fixed costs'), p && p.title);
      await ui.key('Escape');
      eq('TILES-2', 'Esc: focus back on "Fixed costs"', (await ui.eval(focusInfo)).tile, 'fixed');
      await ui.key('Tab', { times: 3 });
      eq('TILES-2', 'Tab, Tab, Tab: "Left this month"', (await ui.eval(focusInfo)).tile, 'left');
      await ui.key('Enter');
      for (let i = 0; i < 6; i++) {
        await ui.key('Tab');
        f = await ui.eval(focusInfo);
        if (f.key === 'line:fixed') break;
      }
      eq('TILES-4', 'keyboard: Tab reaches the "Fixed costs" line of the Left sum', f.key, 'line:fixed');
      await ui.key('Enter');
      p = await ui.eval(readPopup);
      eq('TILES-4', 'Enter on a line opens that tile\'s popup on top', [p.count, p.title.split(' — ')[0], (await ui.eval(focusInfo)).inDialog], [2, 'Fixed costs', true]);
      await ui.key('Escape');
      eq('TILES-2', 'Esc closes only the top popup; focus back on its line', [(await ui.eval(readPopup)).count, (await ui.eval(focusInfo)).key], [1, 'line:fixed']);
      await ui.key('Escape');
      eq('TILES-2', 'Esc again: all closed, focus on "Left this month"', [await ui.eval(readPopup), (await ui.eval(focusInfo)).tile], [null, 'left']);
    });

    await step('TILES-2', 'long content scrolls inside the popup; phone size = full-width sheet', async () => {
      await ui.page.setViewport(400, 480);
      await ui.settle(100);
      await ui.click(tileSpec('daily'));
      const n = (await ui.eval(readPopup)).rows.length;
      for (let i = 0; i < n; i++) await ui.click({ css: '#dialog-root .tp-payee', nth: i });
      const g = await ui.eval(() => {
        const d = document.querySelector('#dialog-root .dialog');
        const b = d.querySelector('.dialog-body');
        const r = d.getBoundingClientRect();
        // vw: the width fixed content gets (the backdrop, inset 0). While a dialog is open the page is locked (overflow
        // hidden) and a classic scrollbar keeps its room, which documentElement.clientWidth no longer leaves out.
        const vw = document.querySelector('#dialog-root .dialog-backdrop').getBoundingClientRect().right;
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw, vh: innerHeight, clientWidth: document.documentElement.clientWidth,
          scroll: b.scrollHeight > b.clientHeight + 4, overflowY: getComputedStyle(b).overflowY, pageScroll: document.documentElement.scrollWidth };
      });
      ok('TILES-2', '400×480: a full-width sheet at the bottom of the window', Math.abs(g.left) <= 1 && Math.abs(g.right - g.vw) <= 1 && Math.abs(g.bottom - g.vh) <= 1 && g.top >= 0, short(g));
      ok('TILES-2', '400×480: long content scrolls inside the popup (the popup fits in the window)', g.scroll && g.overflowY === 'auto' && g.bottom - g.top <= g.vh, short(g));
      await ui.page.screenshot(join(OUT, 'shots', 'tiles-popup-sheet-400x480.png'));
      await ui.key('Escape');
      await ui.page.setViewport(1100, 900);
      await ui.settle(100);
      await ui.click(tileSpec('fixed'));
      const c = await ui.eval(() => {
        const r = document.querySelector('#dialog-root .dialog').getBoundingClientRect();
        return { left: r.left, right: r.right, vw: document.querySelector('#dialog-root .dialog-backdrop').getBoundingClientRect().right, width: r.width };
      });
      ok('TILES-2', '1100 px: a centred dialog', Math.abs(c.left - (c.vw - c.right)) <= 2 && c.width <= 560, short(c));
      await ui.key('Escape');
      // A double-click on a tile (the second click lands on the backdrop) must leave the popup open.
      const at = await ui.eval((s) => window.__t.prepClick(s), tileSpec('income')); // left of the centred dialog: the 2nd click hits the backdrop
      for (const clickCount of [1, 2]) {
        await ui.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount });
        await ui.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount });
      }
      await ui.settle(100);
      const dbl = await ui.eval(readPopup);
      const onBackdrop = await ui.eval((x, y) => document.elementFromPoint(x, y).classList.contains('dialog-backdrop'), at.x, at.y);
      ok('TILES-2', 'a double-click on a tile opens its popup and leaves it open (2nd click on the backdrop)', dbl && dbl.title.startsWith('Income') && dbl.count === 1 && onBackdrop, short({ title: dbl && dbl.title, onBackdrop }));
      const fd = await ui.eval(focusInfo);
      ok('TILES-2', 'after the double-click the focus is still inside the popup (not on <body>)', fd.inDialog, fd.what);
      await closePopup(ui, 'backdrop', 'after the double-click, one normal click on the backdrop', { expectTile: 'income' });
    });

    await step('TILES-6', '400 and 360 px: no horizontal scroll with any popup open; light + dark contrast', async () => {
      for (const width of [1100, 400, 360]) {
        await ui.setWidth(width);
        for (const key of TILE_KEYS) {
          await ui.click(tileSpec(key));
          if (key !== 'left' && (await ui.exists({ css: '#dialog-root .tp-payee' }))) await ui.click({ css: '#dialog-root .tp-payee', nth: 0 });
          const o = await ui.eval(overflowReport);
          ok('TILES-6', `${TILE_LABEL[key]} popup @${width}px: no horizontal scroll`, o.scrollWidth <= o.vw && o.count === 0, o.count ? short(o.overflow) : `scrollWidth ${o.scrollWidth} <= ${o.vw}`);
          if (width !== 360) {
            for (const scheme of ['light', 'dark']) {
              await ui.page.colorScheme(scheme);
              await ui.parkMouse();
              await ui.settle(50);
              const c = await ui.eval(contrastReport, '#dialog-root .dialog');
              ok('TILES-6', `${TILE_LABEL[key]} popup @${width}px ${scheme}: text contrast ≥ WCAG AA (${c.checked} texts)`, c.checked > 3 && c.failures.length === 0, c.failures.length ? short(c.failures.slice(0, 4)) : '');
              if (width === 400 || key === 'left') await ui.shot(`tiles-popup-${key}`, { width, scheme, fullPage: false });
            }
            await ui.page.colorScheme('light');
          }
          await ui.key('Escape');
        }
      }
      for (const scheme of ['light', 'dark']) {
        await ui.page.colorScheme(scheme);
        for (const width of [1100, 400]) {
          await ui.setWidth(width);
          await ui.parkMouse();
          const c = await ui.eval(contrastReport, '#view-month .tiles');
          ok('TILES-6', `tiles @${width}px ${scheme}: text contrast ≥ WCAG AA, "View" included (${c.checked} texts)`, c.failures.length === 0 && c.checked >= 15, c.failures.length ? short(c.failures.slice(0, 4)) : '');
          await ui.hover(tileSpec('oneoff'));
          const h = await ui.eval(contrastReport, '#view-month .tile-oneoff');
          ok('TILES-6', `hovered tile @${width}px ${scheme}: contrast ≥ WCAG AA`, h.failures.length === 0 && h.checked > 0, h.failures.length ? short(h.failures) : '');
        }
      }
      await ui.page.colorScheme('light');
      await ui.parkMouse();
      await ui.setWidth(1100);
    });

    await step('TILES-6', 'print: the popup is not printed, the tiles are (without "View")', async () => {
      await ui.click(tileSpec('fixed'));
      await ui.send('Emulation.setEmulatedMedia', { media: 'print', features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await ui.settle(100);
      const p = await ui.eval(() => ({
        popup: [...document.querySelectorAll('#dialog-root .dialog, #dialog-root .dialog-backdrop')].some(window.__t.visible),
        tiles: [...document.querySelectorAll('#view-month .tile')].filter(window.__t.visible).length,
        more: [...document.querySelectorAll('#view-month .tile-more')].filter(window.__t.visible).length,
      }));
      eq('TILES-6', 'print with a popup open: popup hidden, 5 tiles printed, no "View"', p, { popup: false, tiles: 5, more: 0 });
      await ui.page.screenshot(join(OUT, 'shots', 'tiles-print-with-popup-open.png'), { fullPage: true });
      await ui.send('Emulation.setEmulatedMedia', { media: '', features: [] });
      await ui.settle();
      ok('TILES-6', 'after printing the popup is still there on screen', Boolean(await ui.eval(readPopup)));
      await ui.key('Escape');
    });

    await step('TILES-6', 'undo while a popup is open: fresh numbers, toast and popup do not hide each other', async () => {
      const M = bookedMonths(st0).at(-1);
      await goMonth(ui, M);
      const before = await ui.state();
      const victim = before.transactions.filter((x) => x.month === M && x.categoryId === 'dagelijks').sort((a, b) => a.amount - b.amount)[0];
      await ui.click({ css: `#view-month .tx[data-id="${victim.id}"]`, child: '.tx-date' });
      await ui.click({ css: '#popover-root button', text: 'Delete' });
      await ui.click(tileSpec('daily'));
      let tiles = await tileCents(ui);
      let st = await ui.state();
      await checkSectionPopup(ui, st, M, 'daily', `${M} after delete`, tiles);
      const z = await ui.eval(() => {
        const toast = [...document.querySelectorAll('#toast-root .toast')].find((t) => t.textContent.startsWith('Deleted'));
        const action = toast && toast.querySelector('.toast-action');
        const a = action && action.getBoundingClientRect();
        const topAtAction = a && document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2);
        const tr = toast && toast.getBoundingClientRect();
        const covered = [...document.querySelectorAll('#dialog-root .dialog button')].filter(window.__t.visible).filter((b) => {
          const r = b.getBoundingClientRect();
          return tr && r.left < tr.right && r.right > tr.left && r.top < tr.bottom && r.bottom > tr.top;
        }).map((b) => window.__t.describe(b));
        return { toast: Boolean(toast), actionOnTop: Boolean(topAtAction && action.contains(topAtAction)), covered };
      });
      ok('TILES-6', 'the undo toast shows over the backdrop and can be clicked; it covers no popup control', z.toast && z.actionOnTop && !z.covered.length, short(z));
      await ui.page.setViewport(400, 700);
      await ui.settle(150);
      const zs = await ui.eval(() => {
        const toast = [...document.querySelectorAll('#toast-root .toast')].find((t) => t.textContent.startsWith('Deleted'));
        const action = toast && toast.querySelector('.toast-action');
        const a = action && action.getBoundingClientRect();
        const topAt = a && document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2);
        const sheet = document.querySelector('#dialog-root .dialog').getBoundingClientRect();
        const t = toast.getBoundingClientRect();
        return { sheetBottom: Math.round(sheet.bottom), toastTop: Math.round(t.top), actionOnTop: Boolean(topAt && action.contains(topAt)) };
      });
      ok('TILES-6', '400 px: the sheet stops above the toast, and the toast stays clickable', zs.sheetBottom <= zs.toastTop && zs.actionOnTop, short(zs));
      await ui.page.screenshot(join(OUT, 'shots', 'tiles-popup-sheet-with-toast-400x700.png'));
      await ui.page.setViewport(1100, 900);
      await ui.settle(150);
      await ui.click({ css: '#toast-root .toast', re: '^Deleted', child: '.toast-action' });
      st = await ui.state();
      eq('TILES-6', 'undo brought the payment back', diffPaths(st, before), []);
      const fu = await ui.eval(focusInfo);
      ok('TILES-2', 'after "Undo" in the toast the focus is back inside the popup (not on <body>)', fu.inDialog, fu.what);
      tiles = await tileCents(ui);
      const p = await ui.eval(readPopup);
      ok('TILES-6', 'the popup stayed open and shows the NEW numbers (= the tile, = the data)', p && cents(p.total.value) === tiles.daily && tiles.daily === tilesOf(st, M).daily.total, short({ popup: p && p.total, tile: tiles.daily }));
      await checkSectionPopup(ui, st, M, 'daily', `${M} after undo`, tiles);
      await ui.key('Escape');
      eq('TILES-2', 'Esc after the re-render: focus back on the (new) tile', (await ui.eval(focusInfo)).tile, 'daily');
    });

    await step('TILES-6', 'Not sorted yet with money in and out; text from the bank is never HTML', async () => {
      const M = bookedMonths(st0).at(-1);
      await goMonth(ui, M);
      const add = async (name, amount, dirIn, category) => {
        await ui.click({ css: '#view-month .list-head button', text: '+ Add' });
        await ui.waitDialog(/Add payment/);
        await ui.type(name);
        await ui.click({ css: '#dialog-root input[inputmode=decimal]' });
        await ui.type(amount);
        if (dirIn) await ui.click({ css: '#dialog-root [data-dir=in]' });
        if (category) await ui.selectByKeys({ css: '#dialog-root select' }, category);
        await ui.click(btn('Add'));
        await ui.waitNoDialog();
      };
      await add('Terug van buurman', '25.00', true, 'onbekend');
      const evil = '<img src=x onerror="window.__xss=1"><b>vet</b> & co';
      await add(evil, '3.00', false, null);
      const st = await ui.state();
      const tiles = await tileCents(ui);
      const t = tilesOf(st, M);
      ok('TILES-4', 'fixture: Not sorted yet now has money in and money out', t.unknown.moneyIn > 0 && t.unknown.moneyOut < 0, short(t.unknown));
      await ui.click(tileSpec('left'));
      await checkOverPopup(ui, st, M, `${M} Not sorted yet in + out`, tiles);
      await ui.click({ css: '#dialog-root .tp-line', re: '^Not sorted yet' });
      const nk = await checkSectionPopup(ui, st, M, 'unknown', `${M} › Not sorted yet`, null);
      eq('TILES-4', 'Not sorted yet popup: total = in + out, money in green with +', [cents(nk.total.value), nk.rows.filter((r) => r.green).map((r) => r.name)], [t.unknown.amount, ['Terug van buurman']]);
      await ui.shot('tiles-popup-not-sorted', { width: 1100, fullPage: false });
      await ui.key('Escape');
      await ui.key('Escape');
      await ui.click(tileSpec('income'));
      await checkSectionPopup(ui, st, M, 'income', `${M} Income with money in still to sort`, tiles);
      await ui.key('Escape');
      await ui.click(tileSpec('daily'));
      const d = await ui.eval((name) => {
        const box = document.querySelector('#dialog-root .dialog');
        const row = [...box.querySelectorAll('.tp-name-text')].find((x) => x.textContent === name);
        return { shown: Boolean(row), html: box.querySelectorAll('img, b').length, xss: window.__xss === undefined ? null : window.__xss };
      }, evil);
      eq('TILES-6', 'a name with HTML shows as plain text in the popup (no <img>/<b>, nothing ran)', d, { shown: true, html: 0, xss: null });
      await ui.key('Escape');
      for (const name of [evil, 'Terug van buurman']) {
        const id = (await ui.state()).transactions.find((x) => x.name === name).id;
        await ui.click({ css: `#view-month .tx[data-id="${id}"]`, child: '.tx-date' });
        await ui.click({ css: '#popover-root button', text: 'Delete' });
      }
      eq('TILES-6', 'cleaned up: state as before', diffPaths(await ui.state(), st0), []);
    });

    await step('TILES-6', 'a month that only holds a moved payment, and an empty month', async () => {
      const M = bookedMonths(st0).at(-1);
      const later = `${M.slice(0, 5)}${String(Number(M.slice(5)) + 2).padStart(2, '0')}`;
      const one = st0.transactions.find((x) => x.month === M && x.categoryId === 'eenmalig');
      await goMonth(ui, M);
      await ui.click({ css: `#view-month .tx[data-id="${one.id}"]`, child: '.tx-date' });
      await ui.selectByKeys({ css: '#popover-root select' }, later);
      await ui.key('Escape');
      let st = await ui.state();
      ok('TILES-6', `fixture: ${later} only holds the moved payment and is not booked`, monthsWithData(st).includes(later) && !bookedMonths(st).includes(later));
      await ui.click(tileSpec('oneoff'));
      await checkSectionPopup(ui, st, M, 'oneoff', `${M} One-off after the move`, await tileCents(ui));
      await ui.key('Escape');
      await goMonth(ui, later);
      let tiles = await tileCents(ui);
      for (const key of TILE_KEYS) {
        await ui.click(tileSpec(key));
        if (key === 'left') {
          const p = await checkOverPopup(ui, st, later, `${later} (moved only) Left`, tiles);
          ok('TILES-6', `${later}: the Left total is not red (month not booked yet)`, !/\bneg\b/.test(p.total.cls), p.total.cls);
        } else {
          await checkSectionPopup(ui, st, later, key, `${later} (moved only) ${TILE_LABEL[key]}`, tiles);
          await checkUnfold(ui, st, later, key, `${later} (moved only) ${TILE_LABEL[key]}`);
        }
        await ui.key('Escape');
      }
      await ui.shot('tiles-month-moved-only', { width: 1100, fullPage: false });
      await goMonth(ui, M);
      await ui.click({ css: `#view-month .tx[data-id="${one.id}"]`, child: '.tx-date' });
      await ui.selectByKeys({ css: '#popover-root select' }, M);
      await ui.key('Escape');
      eq('TILES-6', 'moved back', diffPaths(await ui.state(), st0), []);

      // An empty month: a statement without payments (set up through the store; fake numbers).
      const empty = `${M.slice(0, 4)}-0${Number(bookedMonths(st0)[0].slice(5)) - 1}`;
      await ui.eval((m) => {
        Budget.store.update((d) => { d.statements.push({ month: m, periodFrom: `${m}-01`, periodTo: `${m}-28`, startBalance: 12345, endBalance: 12345, totalIn: 0, totalOut: 0, source: 'pdf', importedAt: '2026-07-01T00:00:00.000Z' }); }, { undoLabel: 'test' });
        return true;
      }, empty);
      st = await ui.state();
      await goMonth(ui, empty);
      tiles = await tileCents(ui);
      eq('TILES-6', `${empty} (no payments): every tile €0.00`, tiles, { income: 0, fixed: 0, daily: 0, oneoff: 0, left: 0 });
      for (const key of TILE_KEYS) {
        await ui.click(tileSpec(key));
        if (key === 'left') await checkOverPopup(ui, st, empty, `${empty} (empty) Left`, tiles);
        else await checkSectionPopup(ui, st, empty, key, `${empty} (empty) ${TILE_LABEL[key]}`, tiles);
        await ui.key('Escape');
      }
      await ui.eval(() => { Budget.store.undo(); return true; });
      eq('TILES-6', 'empty month removed again', diffPaths(await ui.state(), st0), []);
    });

    await step('TILES-6', 'an import while a popup is open: the popup closes (the month changed), never stale', async () => {
      await goMonth(ui, bookedMonths(st0).at(-1));
      await ui.click(tileSpec('fixed'));
      await ui.drop([F.comma]);
      await ui.waitDialog(/found/);
      eq('TILES-6', 'the review dialog opens on top of the popup', (await ui.eval(readPopup)).count, 2);
      await ui.click(btn('Add'));
      await ui.waitFor(() => document.getElementById('month-label').textContent === 'October 2026', { timeoutMs: 5000 });
      eq('TILES-6', 'after the import shows October 2026, no popup of the old month is left', await ui.eval(() => document.querySelectorAll('#dialog-root .dialog').length), 0);
      const st = await ui.state();
      const tiles = await tileCents(ui);
      await ui.click(tileSpec('left'));
      await checkOverPopup(ui, st, '2026-10', 'October 2026 after the import', tiles);
      await ui.key('Escape');
    });

    await step('TILES-6', 'tiles session health', () => sessionHealth(ui, 'TILES-6', 'tiles (Edge)'));
  } finally {
    await ui.close();
  }
  await tilesFocusRun();
}

// Focus and layout of the popups on made-up data (FAKE names and amounts, loaded through Budget.store.importBackup
// in a fresh profile of the build without seed): the focus never leaves an open popup, the keyboard scrolls a long
// popup (not the page behind it), and every amount in a popup ends in one column.
async function tilesFocusRun() {
  const tx = (id, date, amount, categoryId, name, extra = {}) => ({ id, date, month: date.slice(0, 7), name, description: '', amount, categoryId,
    type: 'Incasso', source: 'pdf', fingerprint: `f${id}`, ...extra });
  const backup = (transactions) => ({ app: 'budget-nl', version: 1, exportedAt: '2026-10-25T10:00:00Z',
    state: { version: 1, transactions, statements: [], rules: [], normalAmounts: {}, settings: {} } });
  const ui = await startEdge({ label: 'tiles-focus', root: OUT, width: 1100, height: 700 });
  const load = async (b, M) => {
    await ui.eval((bk, m) => { Budget.store.importBackup(bk); Budget.app.go({ view: 'month', month: m }); return true; }, b, M);
    await ui.settle();
  };
  const where = () => ui.eval(() => {
    const ds = [...document.querySelectorAll('#dialog-root .dialog')];
    const d = ds[ds.length - 1];
    const a = document.activeElement;
    return { count: ds.length, inTop: Boolean(d && d.contains(a)), body: Boolean(d && a === d.querySelector('.dialog-body')),
      what: window.__t.describe(a).slice(0, 60), bodyScroll: d ? Math.round(d.querySelector('.dialog-body').scrollTop) : null, pageScroll: Math.round(scrollY) };
  });
  try {
    await ui.open(fileUrl(APP));
    const many = [tx('m0', '2026-09-25', 250000, 'inkomen', 'Werkgever BV'), tx('m1', '2026-09-03', -2500, 'onbekend', 'J. Jansen'),
      tx('m2', '2026-09-01', -86500, 'huur', 'Huisbaas BV'), tx('m3', '2026-09-27', -15000, 'huur', 'Huisbaas BV', { month: '2026-10' })];
    for (let i = 0; i < 120; i++) many.push(tx(`d${i}`, `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`, -(100 + i), 'dagelijks', `Winkel ${i}`));
    await load(backup(many), '2026-09');

    await step('TILES-2', 'a long popup scrolls with the keyboard right after it opens (not the page behind it)', async () => {
      await ui.eval(() => { window.scrollTo(0, 0); return true; });
      await ui.click(tileSpec('daily'));
      const w0 = await where();
      ok('TILES-2', "opened by a click: the focus is on the popup's scrolling body", w0.count === 1 && w0.body, w0.what);
      await ui.key('PageDown');
      await ui.waitFor(() => document.querySelector('#dialog-root .dialog-body').scrollTop > 0, { timeoutMs: 3000 }).catch(() => null);
      await ui.settle(150);
      const w1 = await where();
      ok('TILES-2', 'Page Down scrolls the list inside the popup; the page behind it stays put', w1.bodyScroll > 0 && w1.pageScroll === w0.pageScroll, short({ w0, w1 }));
      await ui.key('ArrowDown');
      await ui.settle(300);
      const w2 = await where();
      ok('TILES-2', 'Arrow Down scrolls it further', w2.bodyScroll > w1.bodyScroll && w2.pageScroll === w0.pageScroll, short({ w1, w2 }));
      await ui.key('Tab');
      const w3 = await ui.eval(focusInfo);
      ok('TILES-2', 'Tab from there goes to the first name inside the popup', w3.inDialog && /^payee:/.test(w3.key || ''), w3.what);
      await ui.key('Escape');
      await ui.click(tileSpec('daily'));
      await ui.key('Tab', { shift: true });
      const w4 = await ui.eval(focusInfo);
      ok('TILES-2', 'Shift+Tab right after opening stays inside the popup (the ✕)', w4.inDialog && /dialog-x/.test(w4.what || ''), w4.what);
      await ui.key('Escape');
      eq('TILES-2', 'Esc: focus back on the tile', (await ui.eval(focusInfo)).tile, 'daily');
    });

    await step('TILES-2', 'a mouse press on a part of a popup that cannot take the focus (title, padding, toast text) keeps it inside', async () => {
      // A real press at a point inside the element matched by css (dx/dy from its left/top, or from its right/bottom
      // when negative); returns what lies at that point, so the check knows the press hit the title and not the ✕.
      const pressOn = async (css, dx, dy) => {
        const pt = await ui.eval((s, x, y) => {
          const all = [...document.querySelectorAll(s)];
          const n = all[all.length - 1];
          if (!n) return null;
          const r = n.getBoundingClientRect();
          const px = x >= 0 ? r.left + x : r.right + x;
          const py = y >= 0 ? r.top + y : r.bottom + y;
          const hit = document.elementFromPoint(px, py);
          return { x: Math.round(px), y: Math.round(py), hit: window.__t.describe(hit).slice(0, 40), inside: Boolean(hit && (hit === n || n.contains(hit))) };
        }, css, dx, dy);
        if (!pt || !pt.inside) throw new Error(`press point not on ${css}: ${JSON.stringify(pt)}`);
        await ui.clickAt(pt.x, pt.y);
        return pt.hit;
      };
      for (const [what, dx] of [['the title text', 30], ['the title strip next to the ✕', -70]]) {
        await ui.eval(() => { window.scrollTo(0, 0); return true; });
        await ui.click(tileSpec('daily'));
        const hit = await pressOn('#dialog-root .dialog > h2', dx, 26);
        const w0 = await where();
        ok('TILES-2', `a press on ${what} (${hit}): the focus stays on the popup's body, not on <body>`, w0.count === 1 && w0.inTop && w0.body, w0.what);
        await ui.key('PageDown');
        await ui.waitFor(() => document.querySelector('#dialog-root .dialog-body').scrollTop > 0, { timeoutMs: 3000 }).catch(() => null);
        await ui.settle(150);
        const w1 = await where();
        ok('TILES-2', `... then Page Down scrolls the popup, not the page behind it`, w1.bodyScroll > 0 && w1.pageScroll === w0.pageScroll, short({ w0, w1 }));
        await ui.key('Escape');
      }
      await ui.click(tileSpec('daily'));
      await ui.click({ css: '#dialog-root .tp-payee', nth: 1 });
      const name = (await where()).what;
      await pressOn('#dialog-root .dialog > h2', 30, 26);
      let w = await where();
      ok('TILES-2', 'a press on the title after clicking a name: the focus stays on that name', w.inTop && w.what === name, short({ name, now: w.what }));
      await ui.eval(() => { Budget.ui.toast('Just a message'); return true; });
      await ui.settle();
      await pressOn('#toast-root .toast-msg', 8, 6);
      w = await where();
      ok('TILES-2', 'a press on the text of a toast: the focus stays inside the popup', w.count === 1 && w.inTop && w.what === name, w.what);
      await ui.click({ css: '#toast-root .toast', re: '^Just a message', child: '.toast-close' });
      await ui.key('Escape');
      await ui.click(tileSpec('left'));
      await ui.click({ css: '#dialog-root .tp-line', nth: 0 });
      await pressOn('#dialog-root .dialog > h2', 30, 26);
      w = await where();
      ok('TILES-2', 'Left > Income, a press on the top popup\'s title: the focus stays inside the top popup', w.count === 2 && w.inTop, w.what);
      await ui.key('Escape');
      await ui.key('Escape');
      eq('TILES-2', 'all closed, focus on "Left this month"', [(await where()).count, (await ui.eval(focusInfo)).tile], [0, 'left']);
      // The same for a dialog with buttons: a press on its text, title or button strip keeps the focus inside it.
      for (const [what, css, dx, dy] of [['text', '#dialog-root .dialog-body > p', 8, 6], ['title', '#dialog-root .dialog > h2', 30, 26], ['button strip', '#dialog-root .dialog-actions', 6, -6]]) {
        await ui.eval(() => { Budget.ui.confirm('This is a test question.'); return true; });
        await ui.settle();
        await pressOn(css, dx, dy);
        w = await where();
        ok('TILES-2', `a dialog with buttons, a press on its ${what}: the focus stays inside the dialog`, w.count === 1 && w.inTop, w.what);
        await ui.key('Escape');
      }
      eq('TILES-2', 'all dialogs closed', (await where()).count, 0);
    });

    await step('TILES-2', 'the focus never ends up on <body> while a popup is open', async () => {
      // A toast closed with its × while a popup is open.
      await ui.click(tileSpec('daily'));
      await ui.eval(() => { Budget.ui.toast('Just a message'); return true; });
      await ui.settle();
      await ui.click({ css: '#toast-root .toast', re: '^Just a message', child: '.toast-close' });
      let w = await where();
      ok('TILES-2', 'a toast closed with its ×: focus back inside the popup', w.count === 1 && w.inTop, w.what);
      // The focused name disappears through a store change (another tab, an undo).
      await ui.click({ css: '#dialog-root .tp-payee', nth: 0 });
      const gone = await ui.eval(() => document.activeElement.getAttribute('data-key'));
      await ui.eval((k) => { const name = k.split('|')[1]; Budget.store.update((d) => { d.transactions = d.transactions.filter((t) => t.name.toLowerCase() !== name); }, { undoLabel: 'test' }); return true; }, gone);
      await ui.settle();
      w = await where();
      ok('TILES-2', `the focused name (${gone}) was removed by a store change: focus stays inside the popup`, w.count === 1 && w.inTop, w.what);
      await ui.eval(() => { Budget.store.undo(); return true; });
      await ui.settle();
      await ui.key('Escape');
      // Left this month > Not sorted yet, then the only Not sorted yet payment is sorted (another tab, an undo): its Left line
      // is gone, so Esc cannot put the focus back on it.
      await ui.click(tileSpec('left'));
      await ui.click({ css: '#dialog-root .tp-line', re: '^Not sorted yet' });
      eq('TILES-2', 'Left > Not sorted yet: two popups', (await where()).count, 2);
      await ui.eval(() => { Budget.store.update((d) => { for (const t of d.transactions) if (t.categoryId === 'onbekend') t.categoryId = 'dagelijks'; }, { undoLabel: 'test' }); return true; });
      await ui.settle();
      const lines = await ui.eval(() => [...document.querySelectorAll('#dialog-root .dialog')][0].querySelectorAll('.tp-line').length);
      eq('TILES-2', 'fixture: the Left sum lost its Not sorted yet line', lines, 4);
      await ui.key('Escape');
      w = await where();
      ok('TILES-2', 'Esc closes the Not sorted yet popup; the focus goes into the Left popup (its line is gone)', w.count === 1 && w.inTop, w.what);
      await ui.key('Escape');
      eq('TILES-2', 'Esc again: all closed, focus on "Left this month"', [(await where()).count, (await ui.eval(focusInfo)).tile], [0, 'left']);
      await ui.eval(() => { Budget.store.undo(); return true; });
      await ui.settle();
    });

    await step('TILES-2', 'while a dialog is open the page behind it never scrolls; the keys scroll the dialog (long "My normal month", the ✕ of a popup)', async () => {
      // 12 FAKE "every month" payees in two months make "My normal month" longer than the window and 120
      // FAKE daily payments make the page and the Daily spending popup long (window 400 x 700).
      const list = [];
      for (const m of ['2026-08', '2026-09']) {
        list.push(tx(`in-${m}`, `${m}-01`, 300000, 'inkomen', 'Werkgever BV', { kind: 'elke-maand' }));
        for (let i = 0; i < 12; i++) list.push(tx(`v${i}-${m}`, `${m}-${String(2 + i).padStart(2, '0')}`, -(1000 + i * 10), 'vast', `Abonnement nep ${i}`, { kind: 'elke-maand' }));
      }
      for (let i = 0; i < 120; i++) list.push(tx(`k${i}`, `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`, -(100 + i), 'dagelijks', `Winkel ${i}`, { kind: 'wisselend' }));
      await load(backup(list), '2026-09');
      await ui.page.setViewport(400, 700);
      await ui.settle(100);
      const layout = () => ui.eval(() => ({
        tiles: [...document.querySelectorAll('#view-month .tile')].map((t) => { const r = t.getBoundingClientRect(); return `${Math.round(r.left)}+${Math.round(r.width)}`; }).join(' '),
        // The width fixed content gets: without a dialog the window minus a classic scrollbar; with one the backdrop.
        fixedWidth: (() => { const bd = document.querySelector('#dialog-root .dialog-backdrop'); return bd ? Math.round(bd.getBoundingClientRect().width) : document.documentElement.clientWidth; })(),
        scrollbar: window.innerWidth - document.documentElement.clientWidth, locked: document.documentElement.classList.contains('dialog-open'),
      }));
      const textPoint = (css, nth) => ui.eval((s, n) => {
        const node = document.querySelectorAll(s)[n];
        const range = document.createRange();
        range.selectNodeContents(node);
        const r = range.getClientRects()[0];
        const x = r.left + Math.min(12, r.width / 2);
        const y = r.top + r.height / 2;
        return { x: Math.round(x), y: Math.round(y), hit: window.__t.describe(document.elementFromPoint(x, y)).slice(0, 40) };
      }, css, nth);
      await ui.eval(() => { window.scrollTo(0, 0); return true; });
      const l0 = await layout();
      ok('TILES-2', 'fixture: the page is longer than the window', await ui.eval(() => document.documentElement.scrollHeight > innerHeight + 600), short(l0));

      // 1. "My normal month" just opened: the focus is on "Save" (outside the scrolling body).
      await ui.eval(() => { Budget.uiMonth.openNormalMonth(); return true; });
      await ui.settle(100);
      const n0 = await where();
      const nOver = await ui.eval(() => { const b = document.querySelector('#dialog-root .dialog-body'); return b.scrollHeight - b.clientHeight; });
      ok('TILES-2', 'fixture: "My normal month" is longer than the window, focus on Save', n0.count === 1 && nOver > 200 && /Save/.test(n0.what), short({ n0, nOver }));
      const l1 = await layout();
      ok('TILES-2', 'opening a dialog locks the page without moving it sideways (tiles in the same place, a scrollbar keeps its room)', l1.locked && l1.tiles === l0.tiles && l1.fixedWidth === l0.fixedWidth, short({ l0, l1 }));
      await ui.key('PageDown');
      await ui.settle(300);
      const n1 = await where();
      ok('TILES-2', 'focus on Save, Page Down: the dialog scrolls, the page behind it stays put', n1.bodyScroll > 0 && n1.pageScroll === 0, short({ n0, n1 }));
      await ui.key('Home');
      await ui.settle(100);
      eq('TILES-2', '... Home: back to the top of the dialog', [(await where()).bodyScroll, (await where()).pageScroll], [0, 0]);

      // 2. A press on the text of a payee name (no control): the dialog's body takes the focus, so the keys scroll it.
      const p = await textPoint('#dialog-root .nm-name', 2);
      await ui.clickAt(p.x, p.y);
      const n2 = await where();
      ok('TILES-2', `a press on the text of a name (${p.hit}): the focus goes to the dialog's scrolling body`, n2.count === 1 && n2.body, short(n2));
      await ui.key('PageDown');
      await ui.settle(300);
      const n3 = await where();
      ok('TILES-2', '... then Page Down scrolls the dialog, not the page behind it', n3.bodyScroll > 0 && n3.pageScroll === 0, short({ n2, n3 }));
      await ui.key('ArrowDown', { times: 3 });
      await ui.settle(300);
      const n4 = await where();
      ok('TILES-2', '... Arrow Down scrolls it further, the page stays put', n4.bodyScroll > n3.bodyScroll && n4.pageScroll === 0, short({ n3, n4 }));
      await ui.key('End');
      await ui.key('PageDown');
      await ui.key('ArrowDown', { times: 3 });
      await ui.settle(300);
      const n5 = await where();
      ok('TILES-2', '... at the end of the list Page Down / Arrow Down do not scroll the page behind it either', n5.bodyScroll >= nOver - 1 && n5.pageScroll === 0, short({ nOver, n5 }));
      // 3. A mouse wheel on the backdrop (outside the dialog box) does not scroll the page either.
      await ui.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 6, y: 350, deltaX: 0, deltaY: 600 });
      await ui.settle(400);
      eq('TILES-2', 'a mouse wheel on the backdrop: the page behind the dialog stays put', (await where()).pageScroll, 0);
      await ui.key('Escape');
      const l2 = await layout();
      ok('TILES-2', 'Esc: dialog closed, the page is unlocked and in the same place', (await where()).count === 0 && !l2.locked && l2.tiles === l0.tiles, short(l2));
      await ui.eval(() => { document.activeElement.blur(); return true; });
      await ui.key('PageDown');
      await ui.waitFor(() => scrollY > 0, { timeoutMs: 3000 }).catch(() => null);
      ok('TILES-2', 'with no dialog open, Page Down scrolls the page again', (await where()).pageScroll > 0, short(await where()));
      // Let the (smooth) keyboard scroll end before going back to the top, so it cannot move the page during the next click.
      await ui.waitFor(() => new Promise((r) => { const y = scrollY; setTimeout(() => r(scrollY === y), 250); }), { timeoutMs: 4000 }).catch(() => null);
      await ui.eval(() => { window.scrollTo({ top: 0, behavior: 'instant' }); return true; });
      await ui.settle(100);

      // 4. The ✕ of a long tile popup (one Shift+Tab from its body): Page Down scrolls the popup, not the page.
      await ui.click(tileSpec('daily'));
      await ui.key('Tab', { shift: true });
      const x0 = await where();
      ok('TILES-2', 'Daily spending popup, Shift+Tab: the focus is on the ✕', x0.count === 1 && /dialog-x/.test(x0.what), x0.what);
      await ui.key('PageDown');
      await ui.settle(300);
      const x1 = await where();
      ok('TILES-2', 'focus on the ✕, Page Down: the popup scrolls, the page behind it stays put', x1.bodyScroll > 0 && x1.pageScroll === x0.pageScroll && /dialog-x/.test(x1.what), short({ x0, x1 }));
      await ui.key('Space');
      eq('TILES-2', 'Space on the ✕ still presses it (popup closed, focus back on the tile)', [(await where()).count, (await ui.eval(focusInfo)).tile], [0, 'daily']);
      await ui.page.setViewport(1100, 700);
      await ui.settle(100);
    });

    await step('TILES-3', 'every amount in a popup ends in one column (lines, unfolded payments, Total)', async () => {
      await load(backup([
        tx('a1', '2026-06-25', 200000, 'inkomen', 'Werkgever BV'), tx('a2', '2026-06-03', 2500, 'onbekend', 'J. Jansen'),
        tx('a3', '2026-06-01', -86500, 'huur', 'Huisbaas BV'), tx('a4', '2026-06-02', -1295, 'vast', 'Telefoon BV'), tx('a5', '2026-06-20', -1295, 'vast', 'Telefoon BV'),
        tx('a6', '2026-06-15', -4000, 'dagelijks', 'Supermarkt'), tx('a7', '2026-06-16', -2499, 'eenmalig', 'Webwinkel Test'),
      ]), '2026-06');
      for (const width of [1100, 400, 360]) {
        await ui.page.setViewport(width, 700);
        await ui.settle(100);
        for (const key of TILE_KEYS) {
          await ui.click(tileSpec(key));
          const n = await ui.eval(() => document.querySelectorAll('#dialog-root .tp-payee').length);
          for (let i = 0; i < n; i++) await ui.click({ css: '#dialog-root .tp-payee', nth: i });
          const e = await ui.eval(() => {
            const d = document.querySelector('#dialog-root .dialog');
            const right = (sel) => [...d.querySelectorAll(sel)].filter((x) => x.offsetParent).map((x) => Math.round(x.getBoundingClientRect().right));
            return { lines: right('.tp-row > .tp-amt'), pays: right('.tp-pay > .tp-amt'), total: right('.tp-total > .tp-amt') };
          });
          const all = new Set([...e.lines, ...e.pays, ...e.total]);
          ok('TILES-3', `${TILE_LABEL[key]} @${width}px: every amount ends at the same x (${e.lines.length} lines, ${e.pays.length} payments, the bottom line)`, all.size === 1 && e.total.length === 1, short(e));
          await ui.key('Escape');
        }
      }
      await ui.page.setViewport(1100, 700);
      await ui.settle(100);
      await ui.click(tileSpec('fixed'));
      await ui.click({ css: '#dialog-root .tp-payee', nth: 1 });
      await ui.shot('tiles-popup-one-column', { width: 1100, fullPage: false });
      await ui.key('Escape');
    });

    await step('TILES-6', 'tiles focus session health', () => sessionHealth(ui, 'TILES-6', 'tiles focus (Edge)'));
  } finally {
    await ui.close();
  }
}

// ------------------------------------------------------------------------------------------------ run

const started = Date.now();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => {
    console.error(`interrupted (${sig}), closing browsers …`);
    Promise.allSettled([...openUis].map((u) => u.close()))
      .finally(() => {
        rmSync(resolve(APP_ROOT, OUT, 'profiles'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        process.exit(130);
      });
  });
}
try {
  rmSync(resolve(APP_ROOT, OUT, 'shots'), { recursive: true, force: true });
  await buildApps();
  const parts = { seed: seedRun, tiles: tilesRun, main: mainRun, robust: robustRun };
  for (const [name, run] of Object.entries(parts)) if (!ONLY || ONLY === name) await run();
} catch (err) {
  report('run', 'script crashed', false, String((err && err.stack) || err).slice(0, 800));
} finally {
  if (!KEEP) rmSync(resolve(APP_ROOT, OUT, 'downloads'), { recursive: true, force: true });
  rmSync(resolve(APP_ROOT, OUT, 'profiles'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

const byItem = new Map();
for (const r of results) {
  const k = String(r.item);
  if (!byItem.has(k)) byItem.set(k, { pass: 0, fail: 0, failed: [] });
  const e = byItem.get(k);
  if (r.pass) e.pass++; else { e.fail++; e.failed.push(r.name); }
}
console.log('\n==== summary per check group ====');
for (const [k, e] of [...byItem].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`item ${k.padStart(3)}: ${e.fail ? 'FAIL' : 'PASS'}  (${e.pass} passed, ${e.fail} failed)${e.fail ? `  -> ${e.failed.join(' | ')}` : ''}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length} checks, ${failed} failed, ${Math.round((Date.now() - started) / 1000)} s. Screenshots: ${OUT}/shots/`);
writeFileSync(resolve(APP_ROOT, OUT, 'e2e-results.json'), JSON.stringify(results, null, 1));
process.exitCode = failed ? 1 : 0;
