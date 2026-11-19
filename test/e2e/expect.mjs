// Independent expectations for the e2e run: fixture readers and reference calculations written from the app's
// documented rules, not from the app's code. All data involved is fake (test/fixtures, seed/demo-seed.json).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_ROOT } from '../lib/cdp.mjs';

const MINUS = '−';

// ---- money as the app shows it: "€1,234.56", "−€12.50", "+€1,200.00", whole: "€345" ------------------------------

export function euro(cents, { sign = false, whole = false } = {}) {
  const n = Math.round(cents);
  const abs = Math.abs(n);
  const units = whole ? Math.round(abs / 100) : Math.floor(abs / 100);
  const int = String(units).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = whole ? int : `${int}.${String(abs % 100).padStart(2, '0')}`;
  const shown = whole ? units : abs;
  let prefix = '';
  if (n < 0 && shown > 0) prefix = MINUS;
  else if (n > 0 && shown > 0 && sign) prefix = '+';
  return `${prefix}€${body}`;
}

/** The app's money text with plain spaces and no word joiner: "−⁠€12.50" -> "−€12.50". */
export function plainMoney(text) {
  return String(text ?? '').replace(/[⁠​]/g, '').replace(/[   ]/g, ' ');
}

/** The exact text formatEuro gives (no space after €, word joiner after a sign). */
export function euroExact(cents, opts) {
  return euro(cents, opts).replace(/^([+−])€/, '$1⁠€');
}

/** Shown money text -> cents ("−€1,234.56" -> -123456, "+€12" -> 1200); null when it is not money. */
export function cents(text) {
  const m = /([+\-−–]?)\s*€\s*(\d[\d,]*)(?:\.(\d{2}))?/.exec(plainMoney(text || ''));
  if (!m) return null;
  const value = Number(m[2].replace(/,/g, '')) * 100 + Number(m[3] || 0);
  return m[1] && m[1] !== '+' ? -value : value;
}

/** Runs of ≥ 6 digits are masked. */
export function mask(text) {
  return String(text).replace(/\d{6,}/g, '…');
}

// ---- CSV fixtures (RFC 4180, header by name) ------------------------------------------------------------------

const CODE_NL = {
  AC: 'Acceptgiro', BA: 'Betaalautomaat', DV: 'Diversen', GM: 'Geldautomaat', GT: 'Online bankieren', IC: 'Incasso',
  ID: 'iDEAL', OV: 'Overschrijving', VZ: 'Verzamelbetaling', GF: 'Telefonisch bankieren', PO: 'Periodieke overschrijving',
  ST: 'Storting',
};

function records(text, sep) {
  const out = [];
  let rec = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
    } else if (c === '"') q = true;
    else if (c === sep) { rec.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      rec.push(field); out.push(rec); rec = []; field = '';
    } else field += c;
  }
  if (field || rec.length) { rec.push(field); out.push(rec); }
  return out.filter((r) => r.some((c) => c.trim() !== ''));
}

function csvCents(text) {
  const t = String(text).trim();
  const neg = t.startsWith('-');
  const [int, dec = '0'] = t.replace(/^-/, '').replace(/\./g, '').split(',');
  const v = Number(int) * 100 + Number(dec.padEnd(2, '0'));
  return neg ? -v : v;
}

/** {encoding, english, sep, rows:[{date, rawName, amount, type, bankCode, notes, balance}], statement|null} */
export function csvFixture(rel) {
  const buf = readFileSync(resolve(APP_ROOT, rel));
  let text;
  let encoding = 'utf-8';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('windows-1252').decode(buf);
    encoding = 'windows-1252';
  }
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0];
  const sep = first.split(';').length > first.split(',').length ? ';' : ',';
  const recs = records(text, sep);
  const head = recs[0].map((h) => h.trim().toLowerCase().replace(/\s*\/\s*/g, ' / '));
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const c = {
    date: col('datum', 'date'), name: col('naam / omschrijving', 'name / description'), cp: col('tegenrekening', 'counterparty'),
    code: col('code'), dir: col('af bij', 'debit / credit'), amount: col('bedrag (eur)', 'amount (eur)'),
    type: col('mutatiesoort', 'transaction type'), notes: col('mededelingen', 'notifications'), bal: col('saldo na mutatie', 'resulting balance'),
  };
  const english = head.includes('date');
  const rows = recs.slice(1).map((r) => {
    const d = r[c.date].trim();
    const sign = /^(bij|credit)$/i.test(r[c.dir].trim()) ? 1 : -1;
    const iban = r[c.cp].replace(/\s+/g, '').toUpperCase();
    const bm = /^[A-Z]{2}\d{2}([A-Z]{4})/.exec(iban);
    return {
      date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
      rawName: r[c.name].trim(),
      amount: sign * Math.abs(csvCents(r[c.amount])),
      type: english ? CODE_NL[r[c.code].trim()] : r[c.type].trim(),
      bankCode: bm ? bm[1] : '',
      notes: r[c.notes] || '',
      balance: c.bal >= 0 && r[c.bal] !== undefined && r[c.bal].trim() !== '' ? csvCents(r[c.bal]) : null,
    };
  });
  let statement = null;
  if (rows.length && rows.every((r) => r.balance !== null)) {
    const newest = rows[0];
    const oldest = rows[rows.length - 1];
    statement = {
      month: oldest.date.slice(0, 7),
      periodFrom: oldest.date,
      periodTo: newest.date,
      startBalance: oldest.balance - oldest.amount,
      endBalance: newest.balance,
      totalIn: rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0),
      totalOut: -rows.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0),
    };
  }
  return { encoding, english, sep, rows, statement };
}

// ---- PDF fixtures: the HTML replica they were printed from + the expected JSON ----------------------------------

/** rows newest first: {date, rawName, amount, type, bankCode, omschrijving}; plus the expected statement and holder lines. */
export function pdfFixture(name) {
  const html = readFileSync(resolve(APP_ROOT, `test/fixtures/src/${name}.html`), 'utf8');
  const expected = JSON.parse(readFileSync(resolve(APP_ROOT, `test/fixtures/${name}.expected.json`), 'utf8'));
  const re = /<span class="date">(\d{2})-(\d{2})-(\d{4})<\/span>\s*<div class="name"><b>([^<]*)<\/b>(.*?)<\/div>\s*<span class="type">([^<]*)<\/span>\s*<span class="amount">([^<]*)<\/span>/gs;
  const rows = [];
  for (const m of html.matchAll(re)) {
    const details = [...m[5].matchAll(/<span>([^<]*)<\/span>/g)].map((x) => x[1]);
    const iban = details.map((d) => /^IBAN:\s*([A-Z]{2}\d{2}([A-Z]{4})\S*)/.exec(d)).find(Boolean);
    const oms = details.find((d) => d.startsWith('Omschrijving:'));
    const amt = m[7].trim();
    rows.push({
      date: `${m[3]}-${m[2]}-${m[1]}`,
      rawName: m[4].replace(/&amp;/g, '&'),
      amount: (amt.startsWith('-') ? -1 : 1) * Math.abs(csvCents(amt.replace(/^[+-]/, ''))),
      type: m[6].trim(),
      bankCode: iban ? iban[2] : '',
      omschrijving: oms ? oms.replace(/^Omschrijving:\s*/, '') : '',
    });
  }
  return { rows, expected, holder: ['T. Tester', 'Teststraat 1', '1234 AB Voorbeeldstad'] };
}

// ---- reference calculations ---------------------------------------------------------------

const ALERT_KINDS = new Set(['fixed', 'daily', 'oneoff']);

function kinds(state) {
  return new Map(state.categories.map((c) => [c.id, c.kind]));
}

/**
 * Counted payments of month M (tx.month === M, kind ≠ telt-niet-mee) per category kind; left = in − spending.
 * moneyIn / moneyOut ("All months" In / Uit): Σ positive / −Σ negative counted non-transfer payments.
 */
export function summaryOf(state, M) {
  const k = kinds(state);
  const t = { income: 0, fixed: 0, daily: 0, oneoff: 0, transfer: 0, unknown: 0 };
  const byCat = {};
  let moneyIn = 0;
  let moneyOut = 0;
  for (const tx of state.transactions) {
    if (tx.month !== M || tx.kind === 'telt-niet-mee') continue;
    const kind = k.get(tx.categoryId) || 'unknown';
    t[kind] += tx.amount;
    byCat[tx.categoryId] = (byCat[tx.categoryId] || 0) + tx.amount;
    if (kind !== 'transfer' && tx.amount > 0) moneyIn += tx.amount;
    if (kind !== 'transfer' && tx.amount < 0) moneyOut -= tx.amount;
  }
  return { ...t, byCat, moneyIn, moneyOut, left: t.income + t.fixed + t.daily + t.oneoff + t.unknown, spend: -(t.fixed + t.daily + t.oneoff + t.unknown) };
}

export function statementOf(state, M) {
  const list = state.statements.filter((s) => s.month === M && Number.isInteger(s.startBalance) && Number.isInteger(s.endBalance));
  return list.find((s) => s.source === 'pdf') || list[0] || null;
}

/** The bank balance moved by exactly the bank payments booked in M (not hand-added ones). */
export function reconcileOf(state, M) {
  const s = statementOf(state, M);
  const moved = state.transactions.filter((t) => t.date.slice(0, 7) === M && t.source !== 'hand').reduce((a, t) => a + t.amount, 0);
  if (!s) return { statement: null, moved };
  return { statement: s, moved, ok: s.startBalance + moved === s.endBalance, diff: s.startBalance + moved - s.endBalance };
}

export function monthsWithData(state) {
  const set = new Set(state.statements.map((s) => s.month));
  for (const t of state.transactions) { set.add(t.month); set.add(t.date.slice(0, 7)); }
  return [...set].sort();
}

/** Months that hold a statement or an imported (non-hand) payment booked in them. */
export function bookedMonths(state) {
  const set = new Set(state.statements.map((s) => s.month));
  for (const t of state.transactions) if (t.source !== 'hand') set.add(t.date.slice(0, 7));
  return [...set].sort();
}

/**
 * Alert rule: > 25 % above the average of the previous months AND ≥ €10 more; needs ≥ 2 previous months.
 * Only spending categories (kind fixed/daily/oneoff, never 'Not sorted yet'), and only money out counts.
 */
export function alertsOf(state, M) {
  const prev = bookedMonths(state).filter((m) => m < M);
  if (prev.length < 2) return [];
  const k = kinds(state);
  const spent = (m, id) => -state.transactions
    .filter((t) => t.month === m && t.kind !== 'telt-niet-mee' && t.categoryId === id && t.amount < 0)
    .reduce((a, t) => a + t.amount, 0);
  const out = [];
  for (const c of state.categories) {
    if (!ALERT_KINDS.has(k.get(c.id))) continue;
    const now = spent(M, c.id);
    const avg = prev.reduce((a, m) => a + spent(m, c.id), 0) / prev.length;
    if (now > 1.25 * avg && now - avg >= 1000) out.push({ categoryId: c.id, now, avg, diff: now - avg });
  }
  return out;
}

/** Average daily spending over the last (up to) 3 booked months. */
export function dailyAvgOf(state) {
  const months = bookedMonths(state).slice(-3);
  if (!months.length) return 0;
  const k = kinds(state);
  const total = state.transactions
    .filter((t) => months.includes(t.month) && t.kind !== 'telt-niet-mee' && k.get(t.categoryId) === 'daily')
    .reduce((a, t) => a + t.amount, 0);
  return Math.round(total / months.length);
}

/**
 * The clickable tiles, written from the design: the counted payments of M (tx.month === M, kind ≠
 * telt-niet-mee) per tile by category KIND — income (value = amount), fixed / daily / oneoff (value = −amount),
 * unknown 'Not sorted yet' (value = amount). One line per category + lowercased trimmed name. elsewhere = payments of that
 * kind PAID in M (date) that count for another month. left = income + fixed + daily + oneoff + unknown (signed).
 * notCounted = telt-niet-mee paid in M + counted payments in a transfer category.
 */
export function tilesOf(state, M) {
  const k = kinds(state);
  const dir = { income: 1, fixed: -1, daily: -1, oneoff: -1, unknown: 1 };
  const out = {};
  for (const key of Object.keys(dir)) out[key] = { total: 0, amount: 0, moneyIn: 0, moneyOut: 0, lines: new Map(), elsewhere: [] };
  const notCounted = { amount: 0, count: 0 };
  for (const t of state.transactions) {
    const known = k.has(t.categoryId);
    const kind = known ? k.get(t.categoryId) : 'unknown';
    const categoryId = known ? t.categoryId : 'onbekend';
    const paidHere = t.date.slice(0, 7) === M;
    if (t.kind === 'telt-niet-mee') {
      if (paidHere) { notCounted.amount += t.amount; notCounted.count++; }
      continue;
    }
    if (t.month !== M) {
      if (paidHere && out[kind]) out[kind].elsewhere.push({ date: t.date, name: t.name.trim(), value: dir[kind] * t.amount, countsIn: t.month });
      continue;
    }
    if (kind === 'transfer') { notCounted.amount += t.amount; notCounted.count++; continue; }
    const sec = out[kind];
    const value = dir[kind] * t.amount;
    sec.total += value;
    sec.amount += t.amount;
    if (t.amount > 0) sec.moneyIn += t.amount; else sec.moneyOut += t.amount;
    const key = `${categoryId}|${t.name.trim().toLowerCase()}`;
    if (!sec.lines.has(key)) sec.lines.set(key, { categoryId, total: 0, count: 0, payments: [] });
    const line = sec.lines.get(key);
    line.total += value;
    line.count++;
    line.payments.push({ date: t.date, name: t.name.trim(), value, kind: t.kind, paidIn: paidHere ? null : t.date.slice(0, 7), description: t.description || '' });
  }
  for (const sec of Object.values(out)) {
    sec.lines = [...sec.lines.values()].map((l) => {
      l.payments.sort((a, b) => b.date.localeCompare(a.date));
      return { ...l, name: l.payments[0].name };
    });
  }
  const left = out.income.amount + out.fixed.amount + out.daily.amount + out.oneoff.amount + out.unknown.amount;
  return { ...out, left, notCounted };
}

export const CATEGORY_ORDER = ['inkomen', 'huur', 'zorg', 'vast', 'dagelijks', 'eenmalig', 'sparen', 'onbekend'];
export const KIND_PILLS = { 'elke-maand': 'every month', wisselend: 'varies', eenmalig: 'one-off', 'telt-niet-mee': "doesn't count" };
// Payment fields and payeeId.
export const TX_FIELDS = ['amount', 'bankCode', 'categoryId', 'date', 'description', 'fingerprint', 'id', 'kind', 'month', 'name', 'payeeId', 'source', 'type'];

/** payeeId: 'p_' + FNV-1a 64 of the trimmed, lowercased name (independent re-implementation). */
export function payeeIdOf(name) {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(String(name ?? '').trim().toLowerCase())) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `p_${h.toString(16).padStart(16, '0')}`;
}

/** Today on the PC's own clock (local time zone) as YYYY-MM-DD. */
export function todayLocal(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
