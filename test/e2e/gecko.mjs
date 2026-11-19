// End-to-end test of the built app in Gecko through the REAL UI: check groups 1, 3, 4, 7, 13, 15 and 16.
//
//   node test/e2e/gecko.mjs              LibreWolf (the default here), headless
//   node test/e2e/gecko.mjs --firefox    Firefox 158 (dark colour scheme; light after the restart in item 15)
//
// Builds its own copy (node build/build.mjs --out .tmp/e2e-gecko/gecko-<browser>/Budget.html, no seed), starts the browser
// on a fresh profile under .tmp/e2e-gecko/ and drives the page with real input: pointer clicks on elements, key presses,
// the file picker that "Add bank file" opens (answered with input.setFiles) and synthetic drag & drop of
// files onto the window. Asserts on DOM text and on Budget.store / Budget.calc state. Only FAKE fixtures are used.
// Every check prints PASS/FAIL (INFO = observation, no verdict; ERROR = the harness itself broke, so unverified).
// Exit code 1 on any FAIL or ERROR.
import { spawnSync } from 'node:child_process';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileUrl } from '../lib/bidi.mjs';
import { APP_ROOT, Fail, Report, Ui, delay, expectSoon, launch, quit, restart } from './gecko-lib.mjs';

const args = process.argv.slice(2);
const BROWSER = args.includes('--firefox') ? 'firefox' : 'librewolf';
const OUT = `.tmp/e2e-gecko/gecko-${BROWSER}`;
const HTML = `${OUT}/Budget.html`;
const PROFILE = `${OUT}/profile`;
const DOWNLOADS = `${OUT}/downloads`;
// LibreWolf: a user.js that asks for dark pages (content-override 0); resistFingerprinting still forces light.
const SCHEME = 'dark';
const SCHEME_AFTER_RESTART = BROWSER === 'firefox' ? 'light' : 'dark';
// The two prefs a LibreWolf profile can set to keep site data on close (see the persistence test).
const KEEP_DATA_PREFS = { 'privacy.sanitize.sanitizeOnShutdown': false, 'privacy.clearOnShutdown_v2.cookiesAndStorage': false };
const FIX = 'test/fixtures';
const XML_NAMESPACES = new Set(['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xhtml', 'http://www.w3.org/1999/xlink',
  'http://www.w3.org/XML/1998/namespace']);
// ING transaction codes -> Dutch type text (ING's own list).
const CODE_TYPES = { AC: 'Acceptgiro', BA: 'Betaalautomaat', DV: 'Diversen', FL: 'Filiaalboeking', GF: 'Telefonisch bankieren',
  GM: 'Geldautomaat', GT: 'Online bankieren', IC: 'Incasso', ID: 'iDEAL', OV: 'Overschrijving', PK: 'Opname kantoor',
  PO: 'Periodieke overschrijving', ST: 'Storting', VZ: 'Verzamelbetaling' };
// Texts from the fixtures that must never be stored or shown: holder name/address, account numbers, ids.
const HOLDER = ['T. Tester', 'Tester', 'Teststraat', 'Voorbeeldstad', '1234 AB'];
const SECRET_RE = /NL\d{2}\s?(?:TEST|INGB|ZZZ)|\bIBAN\b|Kenmerk|Machtiging|Incassant|Pasvolgnr|Valutadatum|Relatienummer|Transactie:|Term:|\b(?:XX|YY|ZZ)0000\d\d\b|\b[A-E]000\d\d\b|HUUR-2026|SAL-202[67]|TEL202609|TEL-000789|MDT000123|ENE-000456|F2026-0456|\d{6,}/;

const R = new Report(`${BROWSER}: `);
const S = { b: null, ui: null }; // current browser + input driver (replaced by the restart in item 15)

// ------------------------------------------------------------------------------------------------ small helpers

const euro = (cents) => {
  const abs = Math.abs(cents);
  return `€${String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(abs % 100).padStart(2, '0')}`;
};

/** The app's money text as plain text: "−⁠€12.50" -> "−€12.50". */
const plain = (s) => (s == null ? s : String(s).replace(/[⁠​]/g, '').replace(/[   ]/g, ' '));
const plainDeep = (v) => (typeof v === 'string' ? plain(v) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plainDeep(x)])) : v);

/** The date of an instant on the PC's own clock (local time zone), as YYYY-MM-DD. */
const dayLocal = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** '−€1,234.56' / '+€12.00' / '€5' -> cents (signed). */
function parseMoney(text) {
  const t = plain(String(text)).trim();
  const m = /([+−-]?)\s*€\s*(\d[\d,]*)(?:\.(\d{2}))?/.exec(t);
  if (!m) return null;
  const cents = Number(m[2].replace(/,/g, '')) * 100 + Number(m[3] || 0);
  return m[1] === '−' || m[1] === '-' ? -cents : cents;
}

const cleanName = (raw) => raw.replace(/\d{6,}/g, '…').replace(/\s+/g, ' ').trim();

function firstDiff(a, b, path = '$') {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return `${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

/** RFC 4180 CSV -> rows with the fields the importer must reproduce (independent of the app's parser). */
function parseIngCsv(text) {
  text = text.replace(/^﻿/, '');
  const sep = text.slice(0, text.indexOf('\n')).includes('";"') ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...data] = rows.filter((r) => r.length > 1);
  const col = (...names) => header.findIndex((h) => names.includes(h));
  const iDate = col('Datum', 'Date');
  const iName = col('Naam / Omschrijving', 'Name / Description');
  const iCode = col('Code');
  const iDir = col('Af Bij', 'Debit/credit');
  const iAmount = col('Bedrag (EUR)', 'Amount (EUR)');
  const iType = col('Mutatiesoort', 'Transaction type');
  const iNotes = col('Mededelingen', 'Notifications');
  const iSaldo = col('Saldo na mutatie', 'Resulting balance');
  const english = header.includes('Date');
  return {
    english,
    hasSaldo: iSaldo >= 0,
    rows: data.map((r) => {
      const cents = Math.round(Number(r[iAmount].replace(/\./g, '').replace(',', '.')) * 100);
      const d = r[iDate];
      return {
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        rawName: r[iName],
        amount: /^(af|debit)$/i.test(r[iDir]) ? -cents : cents,
        type: r[iType],
        dutchType: CODE_TYPES[r[iCode]] || r[iType],
        notes: r[iNotes],
        saldo: iSaldo >= 0 ? Math.round(Number(r[iSaldo].replace(/\./g, '').replace(',', '.')) * 100) : null,
      };
    }),
  };
}

// ------------------------------------------------------------------------------------------------ page helpers

const b = () => S.b;
const ui = () => S.ui;

async function flushed() {
  await b().eval(() => Budget.store.flush());
}

const state = () => b().eval(() => Budget.store.get());
const label = () => b().eval(() => document.getElementById('month-label').textContent.trim());
const dialogText = () => b().eval(() => {
  const all = document.querySelectorAll('#dialog-root .dialog');
  return all.length ? all[all.length - 1].innerText : null;
});
const toastText = () => b().eval(() => document.getElementById('toast-root').innerText);

async function waitDialog(reason, timeoutMs = 25000) {
  return expectSoon(b(), () => {
    const all = document.querySelectorAll('#dialog-root .dialog');
    return all.length ? all[all.length - 1].innerText : null;
  }, reason, timeoutMs);
}

async function waitLabel(text, reason) {
  return expectSoon(b(), (t) => document.getElementById('month-label').textContent.trim() === t, `${reason} (label is "${await label()}")`, 10000, text);
}

/** Clicks something that opens a file picker and answers the picker with files (like a user picking them). */
async function pickFiles(clickFinder, files, what) {
  const before = b().fileDialogs.length;
  const clicked = await ui().click(clickFinder);
  if (!clicked) throw new Fail(`${what}: the control to click was not found`);
  const end = Date.now() + 5000;
  while (b().fileDialogs.length === before && Date.now() < end) await delay(50);
  const ev = b().fileDialogs[b().fileDialogs.length - 1];
  if (b().fileDialogs.length === before || !ev || !ev.element) throw new Fail(`${what}: clicking it did not open a file picker`);
  await b().send('input.setFiles', { context: b().context, element: { sharedId: ev.element.sharedId }, files: files.map((f) => resolve(APP_ROOT, f)) });
  return ev;
}

/** Synthetic drag & drop of files onto the element at (x%, y%) of the window. */
async function dropFiles(files, at = [0.5, 0.5]) {
  const payload = [];
  for (const f of files) {
    payload.push({ name: f.split('/').pop(), type: f.endsWith('.pdf') ? 'application/pdf' : 'text/csv', b64: (await readFile(join(APP_ROOT, f))).toString('base64') });
  }
  return b().eval((list, pos) => {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    const target = document.elementFromPoint(innerWidth * pos[0], innerHeight * pos[1]) || document.body;
    const overlay = document.getElementById('drop-overlay');
    const fire = (type) => target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    const r = { target: `${target.tagName.toLowerCase()}${target.id ? '#' + target.id : ''}.${[...target.classList].join('.')}` };
    r.enterHandled = !fire('dragenter');
    r.overlayShown = !overlay.hidden && overlay.getBoundingClientRect().width > 0;
    r.overlayText = overlay.innerText.replace(/\s+/g, ' ').trim();
    r.overHandled = !fire('dragover');
    r.dropHandled = !fire('drop');
    r.overlayHiddenAfter = overlay.hidden;
    return r;
  }, payload, at);
}

/**
 * Ids, account numbers and long digit runs in any bank-derived text (all payments of `source`), and — for PDF
 * payments only, because only a PDF tells the app who the holder is — the holder's name/address anywhere.
 */
function privacyProblems(st, source, extraText = '', month = null) {
  const problems = [];
  const txs = st.transactions.filter((t) => t.source === source && (!month || t.month === month));
  const bankText = []; // texts that come from the bank file: no ids, account numbers or long digit runs
  for (const t of txs) bankText.push([`${t.date} name`, t.name], [`${t.date} description`, t.description], [`${t.date} type`, t.type]);
  for (const r of st.rules) bankText.push(['rule', JSON.stringify(r.match) + JSON.stringify(r.set)]);
  bankText.push(['normalAmounts', Object.keys(st.normalAmounts).join('|')]);
  if (extraText) bankText.push(['page text', extraText]);
  for (const [where, text] of bankText) {
    const m = SECRET_RE.exec(text);
    if (m) problems.push(`${where} "${String(text).slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, ' ')}" contains "${m[0]}"`);
  }
  if (source === 'pdf') {
    const everything = [...bankText, ['settings', JSON.stringify(st.settings)], ['statements', JSON.stringify(st.statements)]];
    for (const [where, text] of everything) {
      for (const h of HOLDER) {
        const i = String(text).indexOf(h);
        if (i >= 0) problems.push(`${where} "${String(text).slice(Math.max(0, i - 40), i + 30).replace(/\s+/g, ' ')}" contains holder text "${h}"`);
      }
    }
  }
  return [...new Set(problems)];
}

// One self-contained page function: layout, readability and language checks on what is on screen now.
// scope: CSS selector of the layer to check for overlaps (top dialog / popover / page).
function pageAudit(scope) {
  const ctx = document.createElement('canvas').getContext('2d');
  const rgba = (c) => {
    if (!c) return null;
    ctx.fillStyle = '#010203';
    ctx.fillStyle = c;
    const s = String(ctx.fillStyle);
    let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
    if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 1];
    m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    m = /^color\(srgb\s+([^)]+)\)$/.exec(s) || /^color\(srgb\s+([^)]+)\)$/.exec(c);
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number);
      return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
    }
    return null;
  };
  const blend = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, c) => {
    const [x, y] = [lum(a), lum(c)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className : el.className && el.className.baseVal;
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls.trim().split(/\s+/).join('.') : ''}`;
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && !el.closest('[hidden]');
  };

  // 1) horizontal overflow
  const vw = document.documentElement.clientWidth;
  const overflow = { scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, viewport: vw, offenders: [] };
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right <= vw + 1 && r.left >= -1) continue;
    let clipped = false;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).overflowX !== 'visible') {
        const ar = a.getBoundingClientRect();
        if (ar.right <= vw + 1 && ar.left >= -1) {
          clipped = true;
          break;
        }
      }
    }
    if (!clipped) overflow.offenders.push(`${describe(el)} [${Math.round(r.left)}..${Math.round(r.right)}] "${(el.textContent || '').trim().slice(0, 30)}"`);
  }

  // 2) overlapping controls in the active layer
  const layer = document.querySelector(scope) || document.body;
  const controls = [...layer.querySelectorAll('button, input:not([type=hidden]), select, [role=button], a[href]')].filter(visible);
  const overlaps = [];
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i];
      const c = controls[j];
      if (a.contains(c) || c.contains(a)) continue;
      const p = a.getBoundingClientRect();
      const q = c.getBoundingClientRect();
      const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
      const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
      if (w > 2 && h > 2) overlaps.push(`${describe(a)} "${a.textContent.trim().slice(0, 20)}" × ${describe(c)} "${c.textContent.trim().slice(0, 20)}" (${Math.round(w)}×${Math.round(h)} px)`);
    }
  }

  // 3) contrast of every visible text in the active layer, against what is really under it (backgrounds and
  //    opacity up the tree). Text behind a modal backdrop is not checked here (it is checked on its own screen).
  const texts = [];
  const seen = new Set();
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.nodeValue.trim() || el.closest('option, noscript, script, style, title')) continue;
    seen.add(el);
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const svg = el instanceof SVGElement;
    let fg = rgba(svg ? cs.fill : cs.color);
    if (!fg) continue;
    let opacity = 1;
    let unknown = false;
    const layers = [];
    for (let a = el; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      opacity *= Number(s.opacity);
      if (a !== el || !svg) {
        if (s.backgroundImage && s.backgroundImage !== 'none') unknown = true;
        const c = rgba(s.backgroundColor);
        if (c && c[3] > 0) layers.push(c);
        if (c && c[3] >= 1) break;
      }
    }
    if (unknown) continue;
    let bg = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) bg = blend(layers[i], bg);
    fg = blend([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    texts.push({ el: describe(el), text: n.nodeValue.trim().slice(0, 40), ratio: Math.round(ratio(fg, bg) * 100) / 100, size, large,
      fg: fg.slice(0, 3).map(Math.round).join(','), bg: bg.slice(0, 3).map(Math.round).join(',') });
  }

  // 4) clipped text (cut off without an ellipsis)
  const clippedText = [];
  for (const el of seen) {
    if (!visible(el) || el instanceof SVGElement) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    if (el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && el.clientWidth > 0) clippedText.push(`${describe(el)} "${el.textContent.trim().slice(0, 40)}" (${el.scrollWidth} > ${el.clientWidth})`);
  }

  // 5) language and number format of what a user reads (bank-derived names/descriptions excluded)
  const data = new Set();
  for (const t of Budget.store.get().transactions) {
    if (t.name) data.add(t.name);
    if (t.description) data.add(t.description);
  }
  let uiText = document.body.innerText;
  for (const d of [...data].sort((x, y) => y.length - x.length)) uiText = uiText.split(d).join(' ');
  const attrs = [...document.querySelectorAll('[title], [aria-label], [placeholder]')]
    .filter((el) => !el.closest('[hidden]'))
    .flatMap((el) => ['title', 'aria-label', 'placeholder'].map((k) => el.getAttribute(k)).filter(Boolean));
  let attrText = attrs.join(' | ');
  for (const d of [...data].sort((x, y) => y.length - x.length)) attrText = attrText.split(d).join(' ');
  const dutch = [];
  const DUTCH = /\b(Annuleren|Opslaan|Verwijderen|Sluiten|Fout|Instellingen|Ongedaan|Vorige maand|Volgende maand|Inkomsten|Uitgaven|Spaardoel|maand|maanden|betaling|betalingen|niet|geen|nog|januari|februari|maart|mei|juni|juli|augustus|oktober|undefined|NaN|null|Infinity|true|false)\b|\[object|Invalid Date/g;
  for (const [where, text] of [['text', uiText], ['attributes', attrText]]) {
    for (const m of text.matchAll(DUTCH)) dutch.push(`${where}: "${text.slice(Math.max(0, m.index - 25), m.index + m[0].length + 25).replace(/\s+/g, ' ')}"`);
  }
  // Money the app writes (bank texts left out): "€1,234.56", signed "−⁠€12.50".
  const badMoney = [];
  for (const m of uiText.matchAll(/[+−-]?⁠?€\s*[\d.,]*\d/g)) {
    if (!/^(?:[+−]⁠)?€\d{1,3}(,\d{3})*(\.\d{2})?$/.test(m[0])) badMoney.push(JSON.stringify(m[0]));
  }
  const badDates = [...document.querySelectorAll('.tx-date')].map((e) => e.textContent.trim())
    .filter((t) => !/^\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/.test(t));
  return {
    overflow,
    overlaps,
    lowContrast: texts.filter((t) => t.ratio < (t.large ? 3 : 4.5)),
    texts: texts.length,
    minRatio: texts.reduce((m, t) => Math.min(m, t.ratio), 99),
    clippedText,
    dutch,
    badMoney,
    badDates,
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
}

/** Runs pageAudit at 1100 and 400 px and reports item 16 results for one screen. */
async function auditScreen(name, scope, prepare) {
  for (const width of [1100, 400]) {
    await b().setViewport(width, 900);
    await delay(250);
    if (prepare) await prepare(width);
    await delay(150);
    const a = await b().eval(pageAudit, scope);
    const tag = `${name} @${width}px`;
    R.check('16', `${tag}: no horizontal page scroll`, a.overflow.scrollWidth <= a.overflow.viewport + 1 && !a.overflow.offenders.length,
      `page is ${a.overflow.scrollWidth}px wide in a ${a.overflow.viewport}px viewport; sticking out: ${a.overflow.offenders.slice(0, 4).join('; ') || 'none'}`);
    R.check('16', `${tag}: controls do not overlap`, !a.overlaps.length, a.overlaps.slice(0, 4).join('; '));
    const bad = a.lowContrast.filter((t) => t.ratio < 3);
    R.check('16', `${tag}: text readable (${a.dark ? 'dark' : 'light'}; contrast ≥ 3:1 for all ${a.texts} texts)`, !bad.length,
      bad.slice(0, 5).map((t) => `${t.el} "${t.text}" ${t.ratio}:1 (fg ${t.fg} on ${t.bg})`).join('; '), `lowest ${a.minRatio}:1`);
    const weak = a.lowContrast.filter((t) => t.ratio >= 3);
    if (weak.length) R.info('16', `${tag}: below WCAG AA but ≥ 3:1`, weak.slice(0, 6).map((t) => `${t.el} "${t.text}" ${t.ratio}:1`).join('; '));
    if (a.clippedText.length) R.info('16', `${tag}: text cut off without ellipsis`, a.clippedText.slice(0, 5).join('; '));
    R.check('16', `${tag}: English UI text, €1,234.56 money and English dates`, !a.dutch.length && !a.badMoney.length && !a.badDates.length,
      [...a.dutch.slice(0, 3), ...a.badMoney.slice(0, 3).map((m) => `money "${m}"`), ...a.badDates.slice(0, 3).map((d) => `date "${d}"`)].join('; '));
  }
  await b().setViewport(1100, 900);
}

// ------------------------------------------------------------------------------------------------ the checks

async function item1Build() {
  await R.step('1', 'build', async () => {
    const run = spawnSync(process.execPath, ['build/build.mjs', '--out', HTML], { cwd: APP_ROOT, encoding: 'utf8' });
    if (run.status !== 0) throw new Fail(`build failed: ${run.stderr || run.stdout}`);
    R.pass('1', `node build/build.mjs --out ${HTML}`);
    const html = await readFile(join(APP_ROOT, HTML), 'utf8');
    const external = [...html.matchAll(/<(script|link|img|iframe|object|embed|source|audio|video)\b[^>]*?\b(src|href|data)\s*=\s*["']([^"']*)["']/gi)]
      .filter((m) => !/^(data:|blob:|#)/i.test(m[3]));
    R.check('1', 'single file: no external script/style/image references', !external.length, external.map((m) => m[0].slice(0, 80)).join('; '));
    const blocks = html.match(/<script type="text\/plain" id="pdfjs-(lib|worker)">/g) || [];
    R.check('1', 'pdf.js lib + worker embedded as inert text', blocks.length === 2, `${blocks.length} pdf.js blocks`);
    const outside = html.replace(/<script type="text\/plain" id="pdfjs-(lib|worker)">[\s\S]*?<\/script>/g, '');
    const urls = [...outside.matchAll(/https?:\/\/[^\s"'`<>)\\]+/gi)].map((m) => m[0]).filter((u) => !XML_NAMESPACES.has(u));
    R.check('1', 'no http(s) URLs outside pdf.js (XML namespace names allowed)', !urls.length, urls.slice(0, 5).join(' '));
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
    const firstCode = Math.min(...['<script', '<style'].map((t) => html.indexOf(t)).filter((i) => i >= 0));
    R.check('1', 'CSP meta present before any script/style, default-src none, no http(s) source',
      csp && csp.index < firstCode && /default-src 'none'/.test(csp[1]) && !/https?:/.test(csp[1]) && !/unsafe-eval/.test(csp[1]),
      csp ? `CSP "${csp[1]}" at ${csp.index}, first script/style at ${firstCode}` : 'no CSP meta', csp && csp[1]);
  });
}

async function item1Open() {
  await R.step('1', `opens in ${BROWSER} via file://`, async () => {
    await b().open(fileUrl(HTML));
    await expectSoon(b(), () => window.Budget && Budget.store && document.querySelector('#view-month .dropzone'), 'the app did not render its empty state');
    const info = await b().eval(() => ({
      title: document.title,
      lang: document.documentElement.lang,
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || null,
      violations: window.__t2csp || null,
      origin: location.origin,
      protocol: location.protocol,
      empty: document.querySelector('.dropzone')?.innerText.replace(/\s+/g, ' ').trim(),
      storageOk: Budget.store.storageOk(),
      banners: document.getElementById('banners').innerText.trim(),
    }));
    R.check('1', 'renders, title "Budget", lang en, page CSP active', info.title === 'Budget' && info.lang === 'en' && info.csp && info.protocol === 'file:', JSON.stringify(info));
    R.check('1', 'no CSP violations at start', Array.isArray(info.violations) && !info.violations.length, JSON.stringify(info.violations));
    R.check('1', 'no console errors at start', !b().errors().length, JSON.stringify(b().errors().slice(0, 3)));
    R.check('1', 'no network requests leaving the machine', !b().externalRequests().length, JSON.stringify(b().externalRequests().slice(0, 3)));
    R.check('1', 'localStorage works on file:// (no red storage banner)', info.storageOk && !info.banners, `storageOk ${info.storageOk}, banners "${info.banners}"`);
    R.info('2', 'empty state (no seed)', info.empty);
  });
}

async function checkRowsMatch(item, what, month, expected, source, { typeOf = (r) => r.type } = {}) {
  const st = await state();
  const got = st.transactions.filter((t) => t.month === month && t.source === source);
  R.check(item, `${what}: ${expected.length} payments stored for ${month}`, got.length === expected.length, `stored ${got.length}, expected ${expected.length}`);
  const left = [...got];
  const missing = [];
  for (const row of expected) {
    const i = left.findIndex((t) => t.date === row.date && t.amount === row.amount && t.name === cleanName(row.rawName) && t.type === typeOf(row));
    if (i < 0) missing.push(`${row.date} ${row.rawName} ${row.amount} ${typeOf(row)}`);
    else left.splice(i, 1);
  }
  R.check(item, `${what}: every row has the right date, name, type and amount`, !missing.length && !left.length,
    `${missing.length} expected rows not found (e.g. ${missing.slice(0, 2).join(' | ')}); unexpected: ${left.slice(0, 2).map((t) => `${t.date} ${t.name} ${t.amount} ${t.type}`).join(' | ')}`);
  return got;
}

async function item3Pdf() {
  const exp1 = JSON.parse(await readFile(join(APP_ROOT, FIX, 'ing-fake-1.expected.json'), 'utf8'));
  await R.step('3', 'PDF import via "Add bank file" + file picker', async () => {
    const ev = await pickFiles('#btn-import', [`${FIX}/ing-fake-1.pdf`], 'Add bank file');
    R.check('3', 'the button opens a file picker that allows several files', ev.multiple === true, `multiple=${ev.multiple}`);
    const text = await waitDialog('no review dialog after picking ing-fake-1.pdf');
    R.check('3', 'review dialog: "14 payments found (Sep 2026)"', text.includes('14 payments found (Sep 2026)'), JSON.stringify(text));
    R.check('3', 'review dialog: "✓ Totals match the statement"', text.includes('✓ Totals match the statement'), JSON.stringify(text));
    const unknown = Number((/(\d+) not sorted yet/.exec(text) || [])[1] || 0);
    if (!(await ui().clickButton('#dialog-root', /^Add$/))) throw new Fail('no [Add] button in the review dialog');
    await waitLabel('September 2026', 'after [Add] the app did not open September 2026');
    R.check('3', 'toast "14 payments added."', (await toastText()).includes('14 payments added.'), await toastText());
    const got = await checkRowsMatch('3', 'PDF', '2026-09', exp1.rows, 'pdf');
    const st = await state();
    const stmt = st.statements.find((s) => s.month === '2026-09');
    const want = exp1.statement;
    R.check('3', 'statement stored: period, begin/end balance, totals', stmt && ['periodFrom', 'periodTo', 'startBalance', 'endBalance', 'totalIn', 'totalOut'].every((k) => stmt[k] === want[k]),
      `stored ${JSON.stringify(stmt)}, expected ${JSON.stringify(want)}`);
    const unknownStored = got.filter((t) => t.categoryId === 'onbekend').length;
    R.check('3', 'dialog "not sorted yet" count matches what was stored as Not sorted yet', unknown === unknownStored, `dialog ${unknown}, stored ${unknownStored}`);
    await flushed();
    const raw = await b().eval(() => localStorage.getItem('budget-nl:v1'));
    const page = await b().eval(() => document.body.innerText);
    const problems = privacyProblems(st, 'pdf', page);
    for (const h of HOLDER) if (raw.includes(h)) problems.push(`localStorage contains holder text "${h}"`);
    R.check('3', 'descriptions cleaned: no IBAN/ids/terminal data, ≥6-digit runs masked, holder name/address nowhere (state, storage, page)', !problems.length, problems.slice(0, 4).join('; '));
    const examples = got.filter((t) => t.description).slice(0, 3).map((t) => `${t.name}: "${t.description}"`).join(' | ');
    R.info('3', 'cleaned description examples', examples);
    const ui3 = await b().eval(() => ({
      check: document.querySelector('.recap-card .check')?.textContent.trim() || null,
      rows: document.querySelectorAll('#view-month .tx').length,
      firstGroup: document.querySelector('#view-month .group')?.getAttribute('data-cat'),
      hint: document.querySelector('#view-month .group.unknown .gnote')?.textContent.trim() || null,
    }));
    R.check('3', 'month screen: 14 rows, recap "✓ Matches the bank statement"', ui3.rows === 14 && ui3.check === '✓ Matches the bank statement', JSON.stringify(ui3));
    if (unknownStored) {
      R.check('3', '"Not sorted yet" group first with its hint', ui3.firstGroup === 'onbekend' && ui3.hint === 'Click a payment to choose what it is', JSON.stringify(ui3));
    }
  });

  const exp2 = JSON.parse(await readFile(join(APP_ROOT, FIX, 'ing-fake-2.expected.json'), 'utf8'));
  await R.step('3', 'PDF import by dropping the file on the window (synthetic drag & drop)', async () => {
    const d = await dropFiles([`${FIX}/ing-fake-2.pdf`], [0.5, 0.6]);
    R.check('3', 'drag over the window shows the full-window overlay "Let go to read the file"', d.enterHandled && d.overlayShown && d.overlayText.startsWith('Let go to read the file'), JSON.stringify(d));
    R.check('3', 'drop is taken by the app (browser does not open the file) and the overlay hides', d.dropHandled && d.overHandled && d.overlayHiddenAfter, JSON.stringify(d));
    const text = await waitDialog('no review dialog after dropping ing-fake-2.pdf');
    R.check('3', `review dialog: "${exp2.rows.length} payments found (Nov 2026)" and totals ✓`,
      text.includes(`${exp2.rows.length} payments found (Nov 2026)`) && text.includes('✓ Totals match the statement'), JSON.stringify(text));
    if (!(await ui().clickButton('#dialog-root', /^Add$/))) throw new Fail('no [Add] button');
    await waitLabel('November 2026', 'after [Add] the app did not open November 2026');
    await checkRowsMatch('3', 'dropped PDF', '2026-11', exp2.rows, 'pdf');
    const st = await state();
    const stmt = st.statements.find((s) => s.month === '2026-11');
    R.check('3', 'November statement stored with the right balances', stmt && stmt.startBalance === exp2.statement.startBalance && stmt.endBalance === exp2.statement.endBalance,
      JSON.stringify(stmt));
    const problems = privacyProblems(st, 'pdf', await b().eval(() => document.body.innerText), '2026-11');
    R.check('3', 'November: descriptions cleaned, holder data nowhere', !problems.length, problems.slice(0, 4).join('; '));
    const recap = await b().eval(() => document.querySelector('.recap-card .check')?.textContent.trim() || null);
    R.check('3', 'November recap reconciles with the statement', recap === '✓ Matches the bank statement', recap);
  });
}

async function item4Csv() {
  const read = async (f, enc = 'utf-8') => parseIngCsv(new TextDecoder(enc).decode(await readFile(join(APP_ROOT, FIX, f))));
  const comma = await read('ing-fake-comma.csv');
  const semi = await read('ing-fake-semicolon.csv');
  const eng = await read('ing-fake-english.csv');
  const win = await read('ing-fake-cp1252.csv', 'windows-1252');

  await R.step('4', 'CSV with commas (9 columns, no saldo), dropped on the window', async () => {
    const d = await dropFiles([`${FIX}/ing-fake-comma.csv`], [0.5, 0.05]);
    R.check('4', 'drop on the top bar is accepted too ("anywhere on the window")', d.dropHandled && d.overlayShown, JSON.stringify(d));
    const text = await waitDialog('no review dialog for the comma CSV');
    R.check('4', `review: "${comma.rows.length} payments found (Oct 2026)", says it cannot check without saldo`,
      text.includes(`${comma.rows.length} payments found (Oct 2026)`) && text.includes("This file has no balances, so it can't be checked."), JSON.stringify(text));
    await ui().clickButton('#dialog-root', /^Add$/);
    await waitLabel('October 2026', 'October 2026 not opened after the comma CSV');
    await checkRowsMatch('4', 'comma CSV', '2026-10', comma.rows, 'csv');
    const st = await state();
    const inSum = st.transactions.filter((t) => t.month === '2026-10' && t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const outSum = st.transactions.filter((t) => t.month === '2026-10' && t.amount < 0).reduce((s, t) => s + t.amount, 0);
    R.check('4', 'comma CSV totals: Σ in (Bij) €1,627.40, Σ out (Af) €1,780.97', inSum === 162740 && outSum === -178097, `in ${inSum}, out ${outSum}`);
    const problems = privacyProblems(st, 'csv');
    R.check('4', 'comma CSV: no IBAN/Kenmerk/terminal ids stored', !problems.length, problems.slice(0, 4).join('; '));
    const own = st.transactions.filter((t) => t.source === 'csv' && HOLDER.some((h) => t.description.includes(h)));
    if (own.length) {
      R.info('4', 'CSV descriptions keep the fixture holder\'s street when the other party typed it (a CSV has no holder block; "Hide words" is the remedy)',
        own.map((t) => `"${t.description}"`).join(' | '));
    }
  });

  await R.step('4', 'CSV with semicolons (11 columns, saldo) — same rows, via the button', async () => {
    await pickFiles('#btn-import', [`${FIX}/ing-fake-semicolon.csv`], 'Add bank file');
    const text = await waitDialog('no review dialog for the semicolon CSV');
    R.check('4', `review: all ${semi.rows.length} already read and skipped, saldo check ✓, "You already read this month"`,
      text.includes(`${semi.rows.length} were already read — skipped`) && text.includes('✓ Balances match the bank')
        && text.includes('You already read this month — duplicate payments are skipped'), JSON.stringify(text));
    const hasAdd = await ui().clickButton('#dialog-root', /^Add$/);
    if (!hasAdd) await ui().clickButton('#dialog-root', /^Close$/);
    await delay(400);
    const st = await state();
    const oct = st.transactions.filter((t) => t.month === '2026-10');
    R.check('4', 'no duplicates: still 12 payments in October', oct.length === 12, `${oct.length} payments`);
    const stmt = st.statements.find((s) => s.month === '2026-10');
    const start = semi.rows[semi.rows.length - 1].saldo - semi.rows[semi.rows.length - 1].amount;
    R.check('4', `saldo chain gives October begin ${euro(start)} / end ${euro(semi.rows[0].saldo)}`, stmt && stmt.startBalance === start && stmt.endBalance === semi.rows[0].saldo, JSON.stringify(stmt));
    await waitLabel('October 2026', 'October 2026 not shown');
    const recap = await b().eval(() => document.querySelector('.recap-card .check')?.textContent.trim() || null);
    R.check('4', 'October recap reconciles with the CSV saldo', recap === '✓ Matches the bank statement', recap);
  });

  await R.step('4', 'CSV with English header (BOM, Debit/Credit), dropped', async () => {
    await dropFiles([`${FIX}/ing-fake-english.csv`]);
    const text = await waitDialog('no review dialog for the English CSV');
    R.check('4', `review: "${eng.rows.length} payments found (Dec 2026)" and saldo check ✓`,
      text.includes(`${eng.rows.length} payments found (Dec 2026)`) && text.includes('✓ Balances match the bank'), JSON.stringify(text));
    await ui().clickButton('#dialog-root', /^Add$/);
    await waitLabel('December 2026', 'December 2026 not opened after the English CSV');
    const got = await checkRowsMatch('4', 'English CSV', '2026-12', eng.rows, 'csv', { typeOf: (r) => r.dutchType });
    const salary = got.find((t) => /Werkgever/.test(t.name));
    R.check('4', 'quoted "" inside a field is read as one quote', salary && salary.description.includes('"13th month"') && !salary.description.includes('""'), salary && salary.description);
    const problems = privacyProblems(await state(), 'csv');
    R.check('4', 'English CSV: no Reference/IBAN/ids stored', !problems.length, problems.slice(0, 4).join('; '));
  });

  await R.step('4', 'CSV in Windows-1252 (accents, €), via the button', async () => {
    await pickFiles('#btn-import', [`${FIX}/ing-fake-cp1252.csv`], 'Add bank file');
    const text = await waitDialog('no review dialog for the Windows-1252 CSV');
    R.check('4', `review: "${win.rows.length} payments found (Jan 2027)"`, text.includes(`${win.rows.length} payments found (Jan 2027)`), JSON.stringify(text));
    await ui().clickButton('#dialog-root', /^Add$/);
    await waitLabel('January 2027', 'January 2027 not opened after the Windows-1252 CSV');
    const got = await checkRowsMatch('4', 'Windows-1252 CSV', '2027-01', win.rows, 'csv');
    const names = got.map((t) => t.name);
    const wanted = ['Naïef Theater Test', 'Patisserie Noël Test', 'Zoë de Vries', 'Crêperie Test', 'Café De Brug Test'];
    R.check('4', 'accented names decoded correctly', wanted.every((n) => names.includes(n)), `names: ${names.join(', ')}`);
    const zoe = got.find((t) => t.name === 'Zoë de Vries');
    const st = await state();
    R.check('4', 'no U+FFFD anywhere; "crêpes, € 12,50" kept in the description', !JSON.stringify(st).includes('�') && zoe && zoe.description.includes('crêpes, € 12,50'), zoe && zoe.description);
    const page = await b().eval(() => document.getElementById('view-month').innerText);
    R.check('4', 'accented names shown on the month screen', wanted.every((n) => page.includes(n)), page.slice(0, 200));
  });
}

async function readScreen() {
  return plainDeep(await b().eval(() => {
    const val = (sel) => document.querySelector(sel)?.textContent.trim() || null;
    const sum = {};
    for (const row of document.querySelectorAll('.save-card dl.sum > div')) sum[row.querySelector('dt').textContent.trim()] = row.querySelector('dd').textContent.trim();
    const recap = {};
    for (const tr of document.querySelectorAll('.recap-card table.recap tr')) recap[tr.querySelector('th').textContent.trim()] = tr.querySelector('td').textContent.trim();
    const legend = {};
    for (const li of document.querySelectorAll('.bar-card .legend li')) legend[li.childNodes[1]?.textContent.trim()] = li.querySelector('strong')?.textContent.trim();
    return {
      tiles: { in: val('.tile-in .tile-value'), fixed: val('.tile-fixed .tile-value'), daily: val('.tile-daily .tile-value'), oneoff: val('.tile-oneoff .tile-value'), left: val('.tile-left .tile-value') },
      big: val('.save-card .save-big strong'),
      sum,
      recap,
      change: val('.recap-change'),
      legend,
    };
  }));
}

const rowPart = async (name, date, part) => plain(await b().eval((n, d, p) => {
  const row = [...document.querySelectorAll('#view-month .tx')]
    .find((r) => r.querySelector('.tx-name')?.textContent.trim() === n && r.querySelector('.tx-date')?.textContent.trim() === d);
  const el = row && row.querySelector(p);
  return el ? el.textContent.trim() : null;
}, name, date, part));

function rowFinder(name, date, part) {
  return [(n, d, p) => {
    const row = [...document.querySelectorAll('#view-month .tx')].find((r) => r.querySelector('.tx-name')?.textContent.trim() === n && r.querySelector('.tx-date')?.textContent.trim() === d);
    return row ? row.querySelector(p) : null;
  }, name, date, part];
}

async function clickRow(name, date, part) {
  const [fn, ...rest] = rowFinder(name, date, part);
  return ui().click(fn, ...rest);
}

async function item7Edit() {
  await R.step('7', 'inline amount edit updates tiles, bar, savings card and recap at once', async () => {
    await waitLabel('January 2027', 'January 2027 is not on screen');
    const before = await readScreen();
    const nmBefore = await b().eval(() => Budget.calc.normalMonth(Budget.store.get()));
    if (!(await clickRow('Kosten ING Go', '2 Jan', '.tx-amount'))) throw new Fail('row "Kosten ING Go" (2 Jan) not found on January 2027');
    const input = await b().eval(() => ({ tag: document.activeElement.tagName, value: document.activeElement.value, selected: document.activeElement.selectionEnd - document.activeElement.selectionStart }));
    R.check('7', 'click on the amount opens an inline input with the amount selected', input.tag === 'INPUT' && input.value === '2.95' && input.selected === 4, JSON.stringify(input));
    await ui().type('12.95');
    await ui().press('Enter');
    await delay(200);
    const after = await readScreen();
    const tx = (await state()).transactions.find((t) => t.name === 'Kosten ING Go' && t.date === '2027-01-02');
    R.check('7', 'store: amount is now −€12.95 (direction kept without typing a minus)', tx && tx.amount === -1295, JSON.stringify(tx && tx.amount));
    R.check('7', 'row shows −€12.95', (await rowPart('Kosten ING Go', '2 Jan', '.tx-amount')) === '−€12.95', await rowPart('Kosten ING Go', '2 Jan', '.tx-amount'));
    const d = (k) => parseMoney(after.tiles[k]) - parseMoney(before.tiles[k]);
    R.check('7', 'tile "Fixed costs" +€10.00 and "Left this month" −€10.00', d('fixed') === 1000 && d('left') === -1000 && d('in') === 0 && d('daily') === 0 && d('oneoff') === 0,
      `before ${JSON.stringify(before.tiles)} after ${JSON.stringify(after.tiles)}`);
    const legendKey = 'Fixed costs & subscriptions';
    R.check('7', 'colour bar legend "Fixed costs & subscriptions" +€10.00', parseMoney(after.legend[legendKey]) - parseMoney(before.legend[legendKey]) === 1000,
      `before ${before.legend[legendKey]} after ${after.legend[legendKey]} (${JSON.stringify(after.legend)})`);
    R.check('7', 'recap "Fixed costs" −€10.00 more', parseMoney(after.recap['Fixed costs']) - parseMoney(before.recap['Fixed costs']) === -1000,
      `before ${before.recap['Fixed costs']} after ${after.recap['Fixed costs']}`);
    const nm = await b().eval(() => Budget.calc.normalMonth(Budget.store.get()));
    R.check('7', 'savings card: "Fixed costs" line −€10.00 (normal = latest amount) and total −€10.00',
      parseMoney(after.sum['Fixed costs']) - parseMoney(before.sum['Fixed costs']) === -1000 && parseMoney(after.sum['Left to save']) - parseMoney(before.sum['Left to save']) === -1000,
      `before ${JSON.stringify(before.sum)} after ${JSON.stringify(after.sum)}`);
    const bigWant = `€${String(Math.floor(Math.abs(nm.saveRounded) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
    R.check('7', `savings card big number follows (now ${after.big}, rounded down to a multiple of 5)`,
      after.big === bigWant && nm.saveRounded % 500 === 0 && nm.saveRounded <= nm.save && nm.save - nm.saveRounded < 500 && nmBefore.save - nm.save === 1000,
      `big "${after.big}", calc ${JSON.stringify({ save: nm.save, saveRounded: nm.saveRounded, before: nmBefore.save })}`);
  });

  await R.step('7', 'amount edit: Esc cancels, nonsense is refused, several formats accepted', async () => {
    await clickRow('Kosten ING Go', '2 Jan', '.tx-amount');
    await ui().type('99');
    await ui().press('Escape');
    await delay(150);
    let tx = (await state()).transactions.find((t) => t.name === 'Kosten ING Go' && t.date === '2027-01-02');
    R.check('7', 'Esc cancels the edit', tx.amount === -1295 && (await rowPart('Kosten ING Go', '2 Jan', '.tx-amount')) === '−€12.95', String(tx.amount));
    await clickRow('Kosten ING Go', '2 Jan', '.tx-amount');
    await ui().type('abc');
    await ui().press('Enter');
    await delay(150);
    const stillEditing = await b().eval(() => document.activeElement.tagName === 'INPUT' && document.activeElement.getAttribute('aria-invalid') === 'true');
    await ui().press('Escape');
    tx = (await state()).transactions.find((t) => t.name === 'Kosten ING Go' && t.date === '2027-01-02');
    R.check('7', '"abc" + Enter is refused (input stays, marked invalid), nothing saved', stillEditing && tx.amount === -1295, `stillEditing ${stillEditing}, amount ${tx.amount}`);
    for (const [typed, want] of [['15.60', -1560], ['1,234.56', -123456], ['1.234,56', -123456], ['-12,50', -1250], ['14.60', -1460]]) {
      await clickRow('Café De Brug Test', '4 Jan', '.tx-amount');
      await ui().type(typed);
      await ui().press('Enter');
      await delay(150);
      const cafe = (await state()).transactions.find((t) => t.name === 'Café De Brug Test');
      R.check('7', `typing "${typed}" on an expense stores ${want} cents`, cafe && cafe.amount === want, `stored ${cafe && cafe.amount}`);
    }
  });

  await R.step('7', 'inline rename with the "Always call … this from now on?" prompt', async () => {
    const rulesBefore = (await state()).rules.length;
    if (!(await clickRow('Café De Brug Test', '4 Jan', '.tx-name'))) throw new Fail('name button of "Café De Brug Test" not found');
    const input = await b().eval(() => ({ tag: document.activeElement.tagName, value: document.activeElement.value }));
    R.check('7', 'click on the name opens an inline input with the name', input.tag === 'INPUT' && input.value === 'Café De Brug Test', JSON.stringify(input));
    await ui().press('Control+a');
    await ui().type('Café De Brug');
    await ui().press('Enter');
    await delay(200);
    const prompt = await b().eval(() => document.querySelector('#view-month .inline-prompt')?.innerText.replace(/\s+/g, ' ').trim() || null);
    R.check('7', 'prompt "Always call \'Café De Brug Test\' this from now on? [Yes] [Only this one]"', prompt === "Always call 'Café De Brug Test' this from now on? Yes Only this one", JSON.stringify(prompt));
    await ui().clickButton('#view-month .inline-prompt', /^Only this one$/);
    await delay(150);
    const st = await state();
    const cafe = st.transactions.find((t) => t.date === '2027-01-04' && t.amount === -1460);
    const gone = await b().eval(() => !document.querySelector('#view-month .inline-prompt'));
    R.check('7', '"Only this one": name changed, prompt gone, no rule made', cafe && cafe.name === 'Café De Brug' && gone && st.rules.length === rulesBefore,
      `name ${cafe && cafe.name}, prompt gone ${gone}, rules ${rulesBefore}→${st.rules.length}`);
    R.check('7', 'row shows the new name', (await rowPart('Café De Brug', '4 Jan', '.tx-name')) === 'Café De Brug', String(await rowPart('Café De Brug', '4 Jan', '.tx-name')));
  });

  await R.step('7', 'edits survive a reload', async () => {
    const before = await state();
    const screen = await readScreen();
    await b().reload();
    await expectSoon(b(), () => window.Budget && document.querySelector('#view-month .tx'), 'month screen did not render after reload');
    await waitLabel('January 2027', 'reload did not reopen January 2027');
    const after = await state();
    const diff = firstDiff(before.transactions, after.transactions);
    R.check('7', 'store after reload equals store before (amount −€12.95, name "Café De Brug")', !diff, diff);
    const screen2 = await readScreen();
    R.check('7', 'tiles/savings/recap identical after reload', !firstDiff(screen, screen2), firstDiff(screen, screen2));
    R.check('7', 'rows show the edits after reload', (await rowPart('Kosten ING Go', '2 Jan', '.tx-amount')) === '−€12.95' && (await rowPart('Café De Brug', '4 Jan', '.tx-name')) === 'Café De Brug', '');
  });
}

// The clickable tiles in Gecko (the cheap part of edge.mjs [TILES-1..6]).
function readTilePopup() {
  const all = [...document.querySelectorAll('#dialog-root .dialog')];
  const d = all[all.length - 1];
  if (!d || !d.classList.contains('tp')) return null;
  const t = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  return {
    count: all.length,
    title: t(d.querySelector('h2')),
    role: d.getAttribute('role'),
    modal: d.getAttribute('aria-modal'),
    rows: [...d.querySelectorAll('.tp-row')].map((r) => ({ name: t(r.querySelector('.tp-name-text')), amount: t(r.querySelector('.tp-amt')), expanded: r.getAttribute('aria-expanded') })),
    pays: [...d.querySelectorAll('.tp-pays')].filter((l) => !l.hidden).map((l) => l.querySelectorAll('.tp-pay').length),
    total: t(d.querySelector('.tp-total .tp-amt')),
    editable: d.querySelectorAll('input, select, textarea, .editable').length,
  };
}

const tileFocus = () => b().eval(() => ({ open: document.querySelectorAll('#dialog-root .dialog').length, tile: (document.activeElement && document.activeElement.dataset && document.activeElement.dataset.tile) || null }));

async function itemTiles() {
  await R.step('TILES', 'clickable tiles: every popup total = its tile; Esc, ✕ and backdrop close it, focus back on the tile', async () => {
    await waitLabel('January 2027', 'January 2027 is not on screen');
    const tiles = (await b().eval(() => [...document.querySelectorAll('#view-month .tile')].map((t) => ({
      key: t.dataset.tile, tag: t.tagName, label: t.querySelector('.tile-label').textContent.trim(), value: t.querySelector('.tile-value').textContent.trim(),
      top: Math.round(t.getBoundingClientRect().top), cursor: getComputedStyle(t).cursor,
    }))));
    R.check('TILES-1', 'five tile buttons: Income, Fixed costs, Daily spending, One-off, Left this month (one row at 1100 px, pointer cursor)',
      JSON.stringify(tiles.map((x) => x.label)) === JSON.stringify(['Income', 'Fixed costs', 'Daily spending', 'One-off', 'Left this month'])
        && tiles.every((x) => x.tag === 'BUTTON' && x.cursor === 'pointer' && x.top === tiles[0].top), JSON.stringify(tiles));
    const st = await state();
    const s = await b().eval(() => Budget.calc.monthSummary(Budget.store.get(), '2027-01'));
    const want = { income: s.income, fixed: -s.fixed, daily: -s.daily, oneoff: -s.oneoff, left: s.left };
    R.check('TILES-1', 'tile numbers = monthSummary (One-off = one-off spending)', tiles.every((x) => parseMoney(x.value) === want[x.key] + 0), `${JSON.stringify(tiles.map((x) => [x.key, x.value]))} vs ${JSON.stringify(want)}`);
    const ways = ['Escape', '✕', 'backdrop'];
    let i = 0;
    for (const tile of tiles) {
      if (!(await ui().click(`#view-month .tile[data-tile="${tile.key}"]`))) throw new Fail(`tile ${tile.key} not found`);
      const p = (await expectSoon(b(), readTilePopup, `the ${tile.label} popup did not open`));
      R.check('TILES-2', `${tile.label}: modal popup "${tile.label} — January 2027"`, p.title === `${tile.label} — January 2027` && p.role === 'dialog' && p.modal === 'true', JSON.stringify(p.title));
      const lines = p.rows.reduce((a, r) => a + parseMoney(r.amount), 0);
      R.check('TILES-3', `${tile.label}: total ${p.total} = the tile, and the lines add up to it`, parseMoney(p.total) === parseMoney(tile.value) && lines === parseMoney(p.total),
        `total ${p.total}, tile ${tile.value}, lines ${lines}`);
      R.check('TILES-5', `${tile.label}: read-only`, p.editable === 0, String(p.editable));
      if (tile.key !== 'left' && p.rows.length) {
        await ui().click('#dialog-root .tp-payee');
        const q = (await b().eval(readTilePopup));
        R.check('TILES-3', `${tile.label}: clicking a name unfolds its payments`, q.rows[0].expanded === 'true' && q.pays.length === 1 && q.pays[0] >= 1, JSON.stringify(q.pays));
      }
      if (tile.key === 'left') {
        await ui().click('#dialog-root .tp-line');
        const c = (await expectSoon(b(), () => document.querySelectorAll('#dialog-root .dialog').length === 2 && document.querySelector('#dialog-root .dialog-backdrop:last-child h2').textContent, 'a line of the Left sum did not open its popup'));
        R.check('TILES-4', 'a line of the Left sum opens that tile\'s popup on top', c === 'Income — January 2027', JSON.stringify(c));
        await ui().press('Escape');
        await delay(100);
        R.check('TILES-2', 'Esc closes only the top popup', (await tileFocus()).open === 1, JSON.stringify(await tileFocus()));
      }
      const how = ways[i++ % ways.length];
      if (how === 'Escape') await ui().press('Escape');
      else if (how === '✕') await ui().click('#dialog-root .dialog-backdrop:last-child .dialog-x');
      else await ui().clickAt(5, 5);
      await delay(150);
      const f = await tileFocus();
      R.check('TILES-2', `${tile.label}: ${how} closes the popup, focus back on the tile`, f.open === 0 && f.tile === tile.key, JSON.stringify(f));
    }
    const after = await state();
    R.check('TILES-5', 'looking at the popups changed nothing', !firstDiff(st, after), firstDiff(st, after));
  });
  await auditScreen('"Fixed costs" popup', '#dialog-root .dialog', async () => {
    if (!(await b().eval(() => document.querySelector('#dialog-root .dialog.tp')))) {
      await ui().click('#view-month .tile[data-tile="fixed"]');
      await expectSoon(b(), readTilePopup, 'the Fixed costs popup did not open');
      await ui().click('#dialog-root .tp-payee');
    }
  });
  await auditScreen('"Left this month" popup', '#dialog-root .dialog', async () => {
    if (!(await b().eval(() => document.querySelector('#dialog-root .dialog.tp h2').textContent.startsWith('Left')))) {
      await ui().press('Escape');
      await ui().click('#view-month .tile[data-tile="left"]');
      await expectSoon(b(), readTilePopup, 'the Left popup did not open');
    }
  });
  await ui().press('Escape');
  await delay(100);
  await R.step('TILES', 'popup focus and layout: the popup body holds the focus, Page Down scrolls the popup, amounts in one column', async () => {
    // 40 FAKE extra payments (copies of a January 2027 payment) make the Daily spending list longer than the
    // popup; the change is undone at the end and the state must be exactly as before.
    const before = await state();
    await b().eval(() => {
      Budget.store.update((d) => {
        const base = d.transactions.find((t) => t.month === '2027-01');
        for (let i = 0; i < 40; i++) {
          d.transactions.push({ ...base, id: `gecko-long-${i}`, fingerprint: `gecko-long-${i}`, name: `Testwinkel ${i}`, description: '', amount: -(100 + i),
            categoryId: 'dagelijks', kind: 'wisselend', date: `2027-01-${String(1 + (i % 28)).padStart(2, '0')}`, month: '2027-01' });
        }
      }, { undoLabel: 'test' });
      return true;
    });
    try {
      await b().setViewport(1100, 600);
      await b().eval(() => { window.scrollTo(0, 0); return true; });
      if (!(await ui().click('#view-month .tile[data-tile="daily"]'))) throw new Fail('tile daily not found');
      await expectSoon(b(), readTilePopup, 'the Daily spending popup did not open');
      const g0 = await b().eval(() => {
        const body = document.querySelector('#dialog-root .dialog-body');
        return { overflow: body.scrollHeight - body.clientHeight, top: body.scrollTop, page: Math.round(scrollY), focusOnBody: document.activeElement === body,
          focus: `${document.activeElement.tagName}.${document.activeElement.className}` };
      });
      R.check('TILES-2', 'a popup opened by a click has the focus on its scrolling body (inside the popup)', g0.focusOnBody, JSON.stringify(g0));
      R.check('TILES-2', 'fixture: the list is longer than the popup', g0.overflow > 200, JSON.stringify(g0));
      await ui().press('\uE00F'); // Page Down
      await delay(500);
      const g1 = await b().eval(() => ({ top: Math.round(document.querySelector('#dialog-root .dialog-body').scrollTop), page: Math.round(scrollY) }));
      R.check('TILES-2', 'Page Down scrolls the list inside the popup, not the page behind it', g1.top > g0.top && g1.page === g0.page, `${JSON.stringify(g0)} -> ${JSON.stringify(g1)}`);
      // A press on the title (it cannot take the focus) keeps the focus on the popup body, so Page Down still scrolls
      // the popup; the same for a press on the text of a toast.
      const focusNow = () => b().eval(() => {
        const ds = [...document.querySelectorAll('#dialog-root .dialog')];
        const d = ds[ds.length - 1];
        const a = document.activeElement;
        return { dialogs: ds.length, inTop: Boolean(d && d.contains(a)), onBody: Boolean(d && a === d.querySelector('.dialog-body')), active: a === document.body ? 'BODY' : `${a.tagName}.${a.className}`,
          top: d ? Math.round(d.querySelector('.dialog-body').scrollTop) : null, page: Math.round(scrollY) };
      });
      if (!(await ui().click('#dialog-root .dialog > h2'))) throw new Fail('the popup title was not found');
      await delay(150);
      const h0 = await focusNow();
      R.check('TILES-2', 'a press on the popup title: the focus stays on the popup body (not on <body>)', h0.dialogs === 1 && h0.onBody, JSON.stringify(h0));
      await ui().press(''); // Page Down
      await delay(500);
      const h1 = await focusNow();
      R.check('TILES-2', '... then Page Down scrolls the popup further, not the page behind it', h1.top > h0.top && h1.page === g0.page, `${JSON.stringify(h0)} -> ${JSON.stringify(h1)}`);
      await b().eval(() => { Budget.ui.toast('Just a message'); return true; });
      await delay(150);
      if (!(await ui().click('#toast-root .toast-msg'))) throw new Fail('the toast text was not found');
      await delay(150);
      const t0 = await focusNow();
      R.check('TILES-2', 'a press on the text of a toast: the focus stays inside the popup', t0.dialogs === 1 && t0.inTop, JSON.stringify(t0));
      await b().eval(() => { for (const n of document.querySelectorAll('#toast-root .toast')) n.budgetDismiss(); return true; });
      await delay(100);
      const e = await b().eval(() => {
        const d = document.querySelector('#dialog-root .dialog');
        [...d.querySelectorAll('.tp-payee')].slice(0, 3).forEach((x) => x.click()); // unfold the three biggest names
        const right = (sel) => [...d.querySelectorAll(sel)].filter((x) => x.offsetParent).map((x) => Math.round(x.getBoundingClientRect().right));
        return { lines: right('.tp-row > .tp-amt').length, pays: right('.tp-pay > .tp-amt'), total: right('.tp-total > .tp-amt'), x: [...new Set(right('.tp-row > .tp-amt'))] };
      });
      const xs = new Set([...e.x, ...e.pays, ...e.total]);
      R.check('TILES-3', 'every amount in the popup ends at the same x (names, unfolded payments, Total)', xs.size === 1 && e.pays.length > 0 && e.total.length === 1, JSON.stringify(e));
      await ui().press('Escape');
      await delay(150);
      const back = await tileFocus();
      R.check('TILES-2', 'Esc: closed, focus back on the tile', back.open === 0 && back.tile === 'daily', JSON.stringify(back));
    } finally {
      await b().setViewport(1100, 900);
      await b().eval(() => { Budget.store.undo(); return true; });
      await delay(300);
    }
    const after = await state();
    R.check('TILES-5', 'the fake payments are gone again (state as before)', !firstDiff(before, after), firstDiff(before, after));
  });
  await R.step('TILES', 'while a dialog is open the page behind it never scrolls; the keys scroll the dialog (long "My normal month", the ✕ of a popup)', async () => {
    // 30 FAKE "every month" payees in January 2027 make "My normal month" and the Fixed costs popup
    // longer than the window (and the page long); undone at the end, the state must be exactly as before.
    const before = await state();
    await b().eval(() => {
      Budget.store.update((d) => {
        const base = d.transactions.find((t) => t.month === '2027-01');
        for (let i = 0; i < 30; i++) {
          d.transactions.push({ ...base, id: `gecko-vast-${i}`, fingerprint: `gecko-vast-${i}`, name: `Abonnement nep ${i}`, description: '', amount: -(1000 + i * 10),
            categoryId: 'vast', kind: 'elke-maand', date: `2027-01-${String(1 + (i % 28)).padStart(2, '0')}`, month: '2027-01', payeeId: undefined });
        }
      }, { undoLabel: 'test' });
      return true;
    });
    const where = () => b().eval(() => {
      const ds = [...document.querySelectorAll('#dialog-root .dialog')];
      const d = ds[ds.length - 1];
      const a = document.activeElement;
      const body = d && d.querySelector('.dialog-body');
      return { dialogs: ds.length, onBody: Boolean(body && a === body), active: a === document.body ? 'BODY' : `${a.tagName}.${a.className}`,
        top: body ? Math.round(body.scrollTop) : null, over: body ? body.scrollHeight - body.clientHeight : null, page: Math.round(scrollY),
        locked: document.documentElement.classList.contains('dialog-open'),
        tiles: [...document.querySelectorAll('#view-month .tile')].map((t) => Math.round(t.getBoundingClientRect().left)).join(' ') };
    });
    try {
      await b().setViewport(400, 700);
      await b().eval(() => { window.scrollTo(0, 0); return true; });
      await delay(200);
      const p0 = await where();
      R.check('TILES-2', 'fixture: the page is longer than the window', await b().eval(() => document.documentElement.scrollHeight > innerHeight + 600), JSON.stringify(p0));
      await b().eval(() => { Budget.uiMonth.openNormalMonth(); return true; });
      await delay(300);
      const n0 = await where();
      R.check('TILES-2', 'fixture: "My normal month" is longer than the window, focus on Save', n0.dialogs === 1 && n0.over > 200 && /btn primary/.test(n0.active), JSON.stringify(n0));
      R.check('TILES-2', 'opening a dialog locks the page without moving it sideways (tiles in the same place)', n0.locked && n0.tiles === p0.tiles, `${p0.tiles} -> ${n0.tiles}`);
      await ui().press('PageDown');
      await delay(500);
      const n1 = await where();
      R.check('TILES-2', 'focus on Save, Page Down: the dialog scrolls, the page behind it stays put', n1.top > 0 && n1.page === 0, `${JSON.stringify(n0)} -> ${JSON.stringify(n1)}`);
      await b().eval(() => { document.querySelector('#dialog-root .dialog-body').scrollTop = 0; return true; });
      const pt = await b().eval(() => {
        const node = document.querySelectorAll('#dialog-root .nm-name')[2];
        const range = document.createRange();
        range.selectNodeContents(node);
        const r = range.getClientRects()[0];
        return { x: Math.round(r.left + Math.min(12, r.width / 2)), y: Math.round(r.top + r.height / 2) };
      });
      await ui().clickAt(pt.x, pt.y);
      await delay(200);
      const n2 = await where();
      R.check('TILES-2', 'a press on the text of a name: the focus goes to the dialog\'s scrolling body (not the box)', n2.dialogs === 1 && n2.onBody, JSON.stringify(n2));
      await ui().press('PageDown');
      await delay(500);
      const n3 = await where();
      R.check('TILES-2', '... then Page Down scrolls the dialog, not the page behind it', n3.top > 0 && n3.page === 0, `${JSON.stringify(n2)} -> ${JSON.stringify(n3)}`);
      await ui().press('ArrowDown');
      await ui().press('ArrowDown');
      await delay(500);
      const n4 = await where();
      R.check('TILES-2', '... Arrow Down scrolls it further, the page stays put', n4.top > n3.top && n4.page === 0, `${JSON.stringify(n3)} -> ${JSON.stringify(n4)}`);
      await ui().press('End');
      await delay(300);
      await ui().press('PageDown');
      await delay(500);
      const n5 = await where();
      R.check('TILES-2', '... at the end of the list Page Down does not scroll the page behind it either', n5.top >= n5.over - 1 && n5.page === 0, JSON.stringify(n5));
      await ui().wheelAt(6, 350, 600);
      await delay(500);
      R.check('TILES-2', 'a mouse wheel on the backdrop: the page behind the dialog stays put', (await where()).page === 0, JSON.stringify(await where()));
      await ui().press('Escape');
      await delay(200);
      const n6 = await where();
      R.check('TILES-2', 'Esc: closed, the page is unlocked and in the same place', n6.dialogs === 0 && !n6.locked && n6.tiles === p0.tiles, JSON.stringify(n6));
      await b().eval(() => { document.activeElement.blur(); return true; });
      await ui().press('PageDown');
      await delay(600);
      R.check('TILES-2', 'with no dialog open, Page Down scrolls the page again', (await where()).page > 0, JSON.stringify(await where()));
      await b().eval(() => { window.scrollTo(0, 0); return true; });
      await delay(200);
      if (!(await ui().click('#view-month .tile[data-tile="fixed"]'))) throw new Fail('tile fixed not found');
      await expectSoon(b(), readTilePopup, 'the Fixed costs popup did not open');
      await ui().press('Shift+Tab');
      await delay(150);
      const x0 = await where();
      R.check('TILES-2', 'Fixed costs popup, Shift+Tab: the focus is on the ✕ (fixture: the list is long)', /dialog-x/.test(x0.active) && x0.over > 200, JSON.stringify(x0));
      await ui().press('PageDown');
      await delay(500);
      const x1 = await where();
      R.check('TILES-2', 'focus on the ✕, Page Down: the popup scrolls, the page behind it stays put', x1.top > 0 && x1.page === x0.page && /dialog-x/.test(x1.active), `${JSON.stringify(x0)} -> ${JSON.stringify(x1)}`);
      await ui().press('Escape');
      await delay(150);
      const back = await tileFocus();
      R.check('TILES-2', 'Esc: closed, focus back on the tile', back.open === 0 && back.tile === 'fixed', JSON.stringify(back));
    } finally {
      await b().eval(() => {
        for (let i = 0; i < 5 && document.querySelector('#dialog-root .dialog'); i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      });
      await b().setViewport(1100, 900);
      await b().eval(() => { window.scrollTo(0, 0); Budget.store.undo(); return true; });
      await delay(300);
    }
    const after = await state();
    R.check('TILES-5', 'the fake fixed costs are gone again (state as before)', !firstDiff(before, after), firstDiff(before, after));
  });
}

async function item16Screens() {
  await R.step('16', 'layout, readability and language on every screen at 1100 and 400 px', async () => {
    const scheme = await b().eval(() => ({ dark: matchMedia('(prefers-color-scheme: dark)').matches, bg: getComputedStyle(document.body).backgroundColor }));
    R.info('16', `colour scheme in this run: ${scheme.dark ? 'dark' : 'light'} (body ${scheme.bg})`, BROWSER === 'librewolf' ? 'LibreWolf: resistFingerprinting forces light even with a dark content-override' : '');
    await waitLabel('January 2027', 'January 2027 not on screen');
    await auditScreen('month January 2027 (with backup banner)', 'body');
    for (let i = 0; i < 4; i++) await ui().click('#prev-month');
    await waitLabel('September 2026', 'four clicks on ◀ from January 2027 did not reach September 2026');
    R.pass('16', 'month switcher ◀ steps back month by month to September 2026');
    await auditScreen('month September 2026 (statement)', 'body');
    await auditScreen('category popover', '#popover-root', async () => {
      await b().eval(() => Budget.uiMonth.closePopover(false));
      const ok = await clickRow('Huisbaas BV', '29 Sep', '.pill');
      if (!ok) throw new Fail('pill of "Huisbaas BV" not found');
      await expectSoon(b(), () => document.querySelector('#popover-root .popover'), 'popover did not open');
    });
    await b().eval(() => Budget.uiMonth.closePopover(false));
    await auditScreen('My normal month', '#dialog-root .dialog', async () => {
      if (!(await b().eval(() => document.querySelector('#dialog-root .dialog')))) {
        await ui().clickButton('.save-card', /Change normal month/);
        await waitDialog('"My normal month" did not open');
      }
    });
    // a real click into a normal amount selects all of it in Gecko too (typing replaces the amount).
    await ui().click('#dialog-root .nm-row input');
    await delay(100);
    const sel = await b().eval(() => { const a = document.activeElement; return { tag: a.tagName, start: a.selectionStart, end: a.selectionEnd, len: a.value.length }; });
    R.check('16', '"My normal month": clicking an amount selects the whole field', sel.tag === 'INPUT' && sel.start === 0 && sel.end === sel.len && sel.len > 0, JSON.stringify(sel));
    await ui().press('Escape');
    // "+ Add" has a day-month-year date field that shows the date in words as you type.
    await ui().clickButton('#view-month .list-head', /^\+ Add$/);
    await waitDialog('"Add payment" did not open');
    const today = dayLocal(new Date());
    const want = today.startsWith('2026-09') ? today : '2026-09-01';
    const words = (iso) => {
      const [y, m, d] = iso.split('-').map(Number);
      const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
      const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1];
      return `${day} ${d} ${month} ${y}`;
    };
    const field = () => b().eval(() => ({ type: document.querySelector('#dialog-root input[name=date]')?.type, value: document.querySelector('#dialog-root input[name=date]')?.value,
      words: document.getElementById('add-date-long')?.textContent.trim() }));
    let f = await field();
    R.check('16', `"Add payment": day-month-year date field ${want.slice(8)}-${want.slice(5, 7)}-${want.slice(0, 4)} with "${words(want)}"`,
      f.type === 'text' && f.value === `${want.slice(8)}-${want.slice(5, 7)}-${want.slice(0, 4)}` && f.words === words(want), JSON.stringify(f));
    await ui().click('#dialog-root input[name=date]');
    await ui().press('Control+a');
    await ui().type('3.9.2026');
    await delay(100);
    f = await field();
    R.check('16', '"Add payment": typing 3.9.2026 shows "Thursday 3 September 2026" at once', f.words === 'Thursday 3 September 2026', JSON.stringify(f));
    await ui().press('Escape');
    await R.step('16', 'dialog buttons stay clickable while an undo toast is showing', async () => {
      // An inline edit shows "Amount changed — Undo" for 8 s; open "My normal month" right after it.
      // Checked where the dialog reaches the bottom of the window (it does with a normal amount of monthly payees).
      const name = 'Huisbaas BV';
      const before = (await state()).transactions.find((t) => t.name === name && t.date === '2026-09-29').amount;
      for (const [w, h] of [[400, 860], [1100, 650]]) {
        await b().setViewport(w, h);
        await delay(200);
        await clickRow(name, '29 Sep', '.tx-amount');
        await ui().type('1050.01');
        await ui().press('Enter');
        await delay(150);
        await ui().clickButton('.save-card', /Change normal month/);
        await waitDialog('"My normal month" did not open');
        const hits = await b().eval(() => {
          const toast = document.querySelector('#toast-root .toast');
          const d = document.querySelector('#dialog-root .dialog').getBoundingClientRect();
          return { toast: Boolean(toast), dialogBottom: Math.round(d.bottom), buttons: [...document.querySelectorAll('#dialog-root .dialog-actions button')].map((btn) => {
            const r = btn.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return { label: btn.textContent.trim(), clickable: btn.contains(top), coveredBy: top && !btn.contains(top) ? (top.closest('.toast') ? 'the undo toast' : top.className) : null };
          }) };
        });
        const covered = hits.buttons.filter((x) => !x.clickable);
        R.check('16', `${w}×${h}: "My normal month" [Save]/[Cancel] clickable while the undo toast shows`, hits.toast && !covered.length,
          hits.toast ? covered.map((x) => `[${x.label}] covered by ${x.coveredBy}`).join('; ') + ` (dialog bottom ${hits.dialogBottom}px)` : 'no toast appeared after the edit (precondition)');
        await ui().press('Escape');
        await clickRow(name, '29 Sep', '.tx-amount');
        await ui().type((Math.abs(before) / 100).toFixed(2));
        await ui().press('Enter');
        await delay(150);
        const back = (await state()).transactions.find((t) => t.name === name && t.date === '2026-09-29').amount;
        if (back !== before) throw new Error(`could not restore the amount (${back} vs ${before})`);
        await b().eval(() => {
          for (const t of document.querySelectorAll('#toast-root .toast')) t.remove(); // the next screens are audited without toasts
          return true;
        });
      }
      await b().setViewport(1100, 900);
    });
    await auditScreen('Settings', '#dialog-root .dialog', async () => {
      if (!(await b().eval(() => document.querySelector('#dialog-root .dialog')))) {
        await ui().click('#btn-menu');
        await ui().clickButton('#menu-root', /^Settings$/);
        await waitDialog('Settings did not open');
      }
    });
    await ui().press('Escape');
    await auditScreen('review dialog (same PDF again)', '#dialog-root .dialog', async () => {
      if (!(await b().eval(() => document.querySelector('#dialog-root .dialog')))) {
        await dropFiles([`${FIX}/ing-fake-1.pdf`]);
        await waitDialog('no dialog for the re-imported PDF');
      }
    });
    const again = await dialogText();
    R.info('5', 're-import of ing-fake-1.pdf', JSON.stringify(again));
    await ui().press('Escape');
    await ui().click('#btn-all');
    await expectSoon(b(), () => !document.getElementById('all-months').hidden && document.querySelector('#all-months svg'), 'All months did not open');
    await auditScreen('All months', 'body');
    await ui().click('#btn-all');
    R.check('16', 'no console errors while switching screens', !b().errors().length, JSON.stringify(b().errors().slice(0, 3)));
  });
}

/** Waits for a finished download matching re that was written after `since` (ms epoch). */
async function waitDownload(dir, re, since, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let names = [];
    try {
      names = await readdir(join(APP_ROOT, dir));
    } catch {
      // not there yet
    }
    let hit = null;
    for (const n of names.filter((x) => re.test(x))) {
      if ((await stat(join(APP_ROOT, dir, n))).mtimeMs >= since - 2000) hit = n;
    }
    if (hit) {
      try {
        return { name: hit, json: JSON.parse(await readFile(join(APP_ROOT, dir, hit), 'utf8')) };
      } catch {
        // still being written
      }
    }
    if (Date.now() > end) throw new Fail(`no ${re} in ${dir} after ${timeoutMs / 1000} s (files: ${names.join(', ') || 'none'})`);
    await delay(200);
  }
}

let SNAPSHOT = null;

async function item13Backup() {
  await R.step('13', 'backup banner after import, "Make backup" downloads the full state, banner goes away', async () => {
    const banner = await b().eval(() => document.getElementById('banners').innerText.replace(/\s+/g, ' ').trim());
    R.check('13', 'yellow banner "New month read — please make a backup"', banner.startsWith('New month read — please make a backup')
      && (await b().eval(() => Boolean(document.querySelector('#banners .banner.warn')))), JSON.stringify(banner));
    await ui().click('#btn-menu');
    const clickedAt = Date.now();
    if (!(await ui().clickButton('#menu-root', /^Make backup$/))) throw new Fail('menu item "Make backup" not found');
    const file = await waitDownload(DOWNLOADS, /^budget-backup-\d{4}-\d{2}-\d{2}\.json$/, clickedAt);
    R.pass('13', `downloaded ${file.name}`);
    await delay(300);
    await flushed();
    const st = await state();
    const t = await toastText();
    R.check('13', 'toast "Backup downloaded: budget-backup-….json"', t.includes(`Backup downloaded: ${file.name}`), t);
    const bannerAfter = await b().eval(() => document.getElementById('banners').innerText.trim());
    R.check('13', 'banner gone after the backup', !bannerAfter, JSON.stringify(bannerAfter));
    const j = file.json;
    R.check('13', 'backup file format {app:"budget-nl", version:1, exportedAt, state}', j.app === 'budget-nl' && j.version === 1 && typeof j.exportedAt === 'string' && j.state,
      JSON.stringify(Object.keys(j)));
    R.check('13', 'backup lastBackupAt = exportedAt = stored lastBackupAt', j.state.settings.lastBackupAt === j.exportedAt && st.settings.lastBackupAt === j.exportedAt,
      `${j.state.settings.lastBackupAt} / ${j.exportedAt} / ${st.settings.lastBackupAt}`);
    const diff = firstDiff(j.state, st);
    R.check('13', 'backup state equals the app state', !diff, diff);
    // The date of the backup on the clock the page sees (the PC's time zone; LibreWolf's resistFingerprinting makes it UTC).
    const pageDay = await b().eval((iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }, j.exportedAt);
    R.check('13', 'file name date = the day of the backup in the time zone the page runs in', file.name === `budget-backup-${pageDay}.json`, `${file.name} vs ${pageDay} (PC: ${dayLocal(new Date(j.exportedAt))})`);
    SNAPSHOT = { state: st, file: `${DOWNLOADS}/${file.name}` };
  });

  await R.step('13', 'clear storage → empty app → "Restore backup" → identical state', async () => {
    if (!SNAPSHOT) throw new Fail('no backup from the previous step');
    await delay(500); // the debounced save is done
    await b().eval(() => {
      localStorage.clear();
      return true;
    });
    await b().reload();
    await expectSoon(b(), () => window.Budget && document.querySelector('#view-month .dropzone'), 'after clearing storage the empty state did not show');
    R.check('13', 'after clearing storage the app starts empty', (await state()).transactions.length === 0, String((await state()).transactions.length));
    await auditScreen('empty state (no seed)', 'body');
    await ui().click('#btn-menu');
    await pickFiles(() => [...document.querySelectorAll('#menu-root button')].find((x) => x.textContent.trim() === 'Restore backup'), [SNAPSHOT.file], 'Restore backup');
    const text = await waitDialog('no confirm dialog after picking the backup');
    const n = SNAPSHOT.state.transactions.length;
    const months = new Set(SNAPSHOT.state.transactions.map((t) => t.month)).size;
    R.check('13', `confirm: "It holds ${n} payments from ${months} months" … "will be replaced"`, text.includes(`It holds ${n} payments from ${months} months`) && text.includes('will be replaced'), JSON.stringify(text));
    if (!(await ui().clickButton('#dialog-root', /^Restore$/))) throw new Fail('no [Restore] button');
    await expectSoon(b(), () => Budget.store.get().transactions.length > 0, 'state still empty after [Restore]');
    await delay(300);
    const st = await state();
    const diff = firstDiff(SNAPSHOT.state, st);
    R.check('13', 'restored state is identical to the state at backup time', !diff, diff);
    R.check('13', 'toast "Backup restored", latest month opened, no banner', (await toastText()).includes('Backup restored') && (await label()) === 'January 2027'
      && !(await b().eval(() => document.getElementById('banners').innerText.trim())), `${await toastText()} / ${await label()}`);
    await b().reload();
    await expectSoon(b(), () => window.Budget && document.querySelector('#view-month .tx'), 'month screen did not render after reload');
    const diff2 = firstDiff(SNAPSHOT.state, await state());
    R.check('13', 'restored state survives a reload', !diff2, diff2);
  });
}

async function item15Restart() {
  // Only when the browser came back: after a failed restart S.b is the browser that already quit, so the steps of
  // the second session cannot run (their commands would reject; before a fix they hung and the run ended without
  // its summary, exit code 13).
  let restarted = false;
  await R.step('15', `data persists after a full ${BROWSER} restart (normal shutdown)`, async () => {
    if (!SNAPSHOT) throw new Fail('no snapshot from item 13');
    await delay(500);
    await flushed();
    const errorsBefore = b().errors();
    R.check('1', `no console errors during the whole first ${BROWSER} session`, !errorsBefore.length, JSON.stringify(errorsBefore.slice(0, 3)));
    const csp = await b().eval(() => window.__t2csp);
    R.check('1', 'no CSP violations after PDF imports (pdf.js runs from blob:)', !csp.length, JSON.stringify(csp));
    R.check('1', 'still no external network requests', !b().externalRequests().length, JSON.stringify(b().externalRequests().slice(0, 3)));
    const { browser: next, shutdown } = await restart(b(), { colorScheme: SCHEME_AFTER_RESTART });
    S.b = next;
    S.ui = new Ui(next);
    restarted = true;
    R.check('15', 'browser quit by itself through browser.close (no kill)', shutdown.clean, JSON.stringify(shutdown), `${shutdown.ms} ms, exit code ${shutdown.exitCode}`);
    if (next.launchRetries) R.info('15', 'harness: the fresh tab was opened again after the restart (the start tab was replaced meanwhile)', `${next.launchRetries} retry`);
    if (next.reusedStartTab) R.info('15', 'harness: no new tab could be opened after the restart; the start tab of the browser is driven instead');
    await b().open(fileUrl(HTML));
    await expectSoon(b(), () => window.Budget && (document.querySelector('#view-month .tx') || document.querySelector('#view-month .dropzone')), 'app did not render after the restart');
    const st = await state();
    const diff = firstDiff(SNAPSHOT.state, st);
    R.check('15', 'all data still there after the restart (state identical)', !diff, diff || '', `${st.transactions.length} payments`);
    R.check('15', 'renders the latest month after the restart', (await label()) === 'January 2027', await label());
  });
  if (!restarted) {
    R.fail('15', `the second ${BROWSER} session did not start, so its checks were skipped${BROWSER === 'firefox' ? ' (incl. 16: light colour scheme)' : ''}`,
      'see the error of item 15 above');
    return; // the final quit() still closes S.b when it runs (a browser that already quit is fine there)
  }
  if (BROWSER === 'firefox') {
    await R.step('16', 'light colour scheme (Firefox after restart)', async () => {
      await auditScreen('month January 2027 (light)', 'body');
      await ui().click('#btn-all');
      await expectSoon(b(), () => !document.getElementById('all-months').hidden && document.querySelector('#all-months svg'), 'All months did not open');
      await auditScreen('All months (light)', 'body');
    });
  }
  R.check('1', `no console errors in the second ${BROWSER} session`, !b().errors().length, JSON.stringify(b().errors().slice(0, 3)));
}

// ------------------------------------------------------------------------------------------------ main

console.log(`Gecko e2e — ${BROWSER}, file ${HTML}, profile ${PROFILE}`);
await rm(join(APP_ROOT, DOWNLOADS), { recursive: true, force: true }); // a backup left by an earlier run must not be mistaken for this one
await item1Build();
try {
  S.b = await launch({ browser: BROWSER, profileDir: PROFILE, wipe: true, colorScheme: SCHEME, downloadDir: DOWNLOADS, prefs: KEEP_DATA_PREFS });
  S.ui = new Ui(S.b);
  const version = S.b.session?.capabilities ? `${S.b.session.capabilities.browserName} ${S.b.session.capabilities.browserVersion}` : '?';
  R.info('', `browser ${version}, started in ${S.b.startMs} ms`);
  await item1Open();
  await item3Pdf();
  await item4Csv();
  await item7Edit();
  await itemTiles();
  await item16Screens();
  await item13Backup();
  await item15Restart();
} catch (err) {
  R.fail('', 'run aborted', String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err));
} finally {
  if (S.b) {
    const q = await quit(S.b);
    if (!q.clean) R.info('', 'final quit needed a kill', JSON.stringify(q));
  }
}
console.log(`\n${BROWSER}: ${R.summary()}`);
if (R.failed.length) {
  console.log('Failures:');
  for (const f of R.failed) console.log(`  ${f.status} [${f.item}] ${f.name} — ${f.reason}`);
}
process.exitCode = R.failed.length ? 1 : 0;
