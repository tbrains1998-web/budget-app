// Unit tests for src/js/import.js (Budget.importer). The real util, store, categorize, import-csv and import-pdf
// modules run as classic scripts in a vm context with an in-memory localStorage. Budget.ui and Budget.app are
// small fakes (the dialog body is captured as a tree), and Budget.importPdf.extract returns the pdf.js items
// of the fake statement (test/fixtures/ing-fake-1.items.json) instead of running pdf.js. All data is fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

const FILES = ['util.js', 'store.js', 'calc.js', 'categorize.js', 'import-csv.js', 'import-pdf.js', 'import.js'];
const ITEMS = JSON.parse(read('test/fixtures/ing-fake-1.items.json'));
const PDF_BYTES = readFileSync(new URL('test/fixtures/ing-fake-1.pdf', root));
const COMMA = read('test/fixtures/ing-fake-comma.csv');
const SEMICOLON = read('test/fixtures/ing-fake-semicolon.csv');
const READ_ERROR = "I can't read this file. Is it an ING statement (PDF) or ING download (CSV)?";
const TX_KEYS = ['amount', 'bankCode', 'categoryId', 'date', 'description', 'fingerprint', 'id', 'kind', 'month', 'name', 'payeeId', 'source', 'type'];

// Fake Budget.ui.el: a {tag, attrs, children} tree; textOf() reads it back.
function el(tag, attrs, ...children) {
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs) || 'tag' in attrs) {
    children.unshift(attrs);
    attrs = {};
  }
  return { tag, attrs, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (Array.isArray(node)) return node.map(textOf).filter(Boolean).join('\n');
  if (typeof node === 'object') return node.children.map(textOf).filter(Boolean).join(['ul', 'div'].includes(node.tag) ? '\n' : '');
  return String(node);
}

function setup({ extract } = {}) {
  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    key: (i) => [...storage.keys()][i] ?? null,
    get length() {
      return storage.size;
    },
  };
  const errors = [];
  const quietConsole = { ...console, error: (...args) => errors.push(args) };
  const context = vm.createContext({ TextEncoder, TextDecoder, crypto: globalThis.crypto, console: quietConsole, setTimeout, clearTimeout, localStorage });
  for (const f of FILES) vm.runInContext(read(`src/js/${f}`), context, { filename: f });
  const B = context.Budget;
  const dialogs = [];
  const toasts = [];
  const routes = [];
  B.ui = { el, dialog: (options) => dialogs.push(options) && (() => {}), toast: (message) => toasts.push(message) };
  B.app = { go: (route) => routes.push(plain(route)) };
  B.importPdf.extract = extract || (async () => JSON.parse(JSON.stringify(ITEMS)));
  B.store.load();
  return { B, dialogs, toasts, routes, errors, storage };
}

function file(name, content) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
  return { name, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer };
}

const pdfFile = () => file('afschrift-sep.pdf', PDF_BYTES);
const sha = (text) => `fp_${createHash('sha256').update(text).digest('hex')}`;
const lastDialog = (dialogs) => {
  const d = dialogs[dialogs.length - 1];
  return { title: d.title, text: textOf(d.body), labels: plain(d.actions.map((a) => a.label)), actions: d.actions };
};

test('PDF preview: 14 cleaned, categorized payments + the September statement; nothing changes yet', async () => {
  const { B } = setup();
  const before = B.store.get();
  const p = plain(await B.importer.preview([pdfFile()]));
  assert.equal(B.store.get(), before, 'preview does not touch the state');
  assert.equal(p.found, 14);
  assert.equal(p.duplicates, 0);
  assert.equal(p.unknown, 6);
  assert.deepEqual(p.months, ['2026-09']);
  assert.deepEqual(p.existingMonths, []);
  assert.deepEqual(p.files, [{ name: 'afschrift-sep.pdf', kind: 'pdf', ok: true, found: 14, duplicates: 0, months: ['2026-09'], check: { kind: 'totals', ok: true }, warnings: [] }]);
  assert.deepEqual(p.statements, [{ month: '2026-09', periodFrom: '2026-09-01', periodTo: '2026-09-30', startBalance: 84512, endBalance: 86715, totalIn: 165540, totalOut: 163337, source: 'pdf' }]);
  assert.equal(p.transactions.length, 14);
  for (const tx of p.transactions) {
    assert.deepEqual(Object.keys(tx).sort(), TX_KEYS);
    assert.equal(tx.source, 'pdf');
    assert.equal(tx.month, tx.date.slice(0, 7));
    assert.match(tx.fingerprint, /^fp_[0-9a-f]{64}$/);
    assert.match(tx.id, /^t_/);
  }
  const rent = p.transactions.find((t) => t.name === 'Huisbaas BV');
  assert.deepEqual({ ...rent, id: '', fingerprint: '' }, {
    id: '', payeeId: B.util.payeeId('Huisbaas BV'), date: '2026-09-29', month: '2026-09', name: 'Huisbaas BV', description: 'Huur oktober 2026', amount: -105000,
    categoryId: 'onbekend', kind: 'wisselend', type: 'Overschrijving', bankCode: 'TEST', source: 'pdf', fingerprint: '',
  });
  assert.equal(p.transactions.find((t) => t.name.startsWith('SUPERMARKT')).bankCode, '');
});

test('cleaning: no IBAN, ids, 6+ digit runs or holder name/address in any imported name or description', async () => {
  const { B } = setup();
  const pdf = plain(await B.importer.preview([pdfFile()]));
  const csv = plain(await B.importer.preview([file('a.csv', COMMA), file('b.csv', SEMICOLON)]));
  for (const tx of [...pdf.transactions, ...csv.transactions]) {
    const text = `${tx.name} | ${tx.description}`;
    assert.doesNotMatch(text, /\d{6,}/, text);
    assert.doesNotMatch(text, /\b[A-Z]{2}\d{2}\s?[A-Z]{4}/, text);
    assert.doesNotMatch(text, /Kenmerk|Machtiging|Incassant|Valutadatum|Pasvolgnr|Transactie|Term:|IBAN|Naam:|Omschrijving:/i, text);
  }
  // The PDF names its holder (page 1), so that name and address are removed too; a CSV does not name the holder.
  for (const tx of pdf.transactions) assert.doesNotMatch(`${tx.name} | ${tx.description}`, /T\. Tester|Teststraat 1|1234 AB/);
  assert.ok(pdf.transactions.some((t) => t.name === 'Naar Oranje spaarrekening X…'), 'account number in a payee name is masked');
});

test('fingerprints: SHA-256 of date|amount|payee|first Omschrijving|type from the raw data, stable across reads', async () => {
  const { B } = setup();
  const a = plain(await B.importer.preview([pdfFile()]));
  const b = plain(await B.importer.preview([pdfFile()]));
  assert.deepEqual(a.transactions.map((t) => t.fingerprint), b.transactions.map((t) => t.fingerprint));
  assert.equal(new Set(a.transactions.map((t) => t.fingerprint)).size, 14);
  const fp = (name) => a.transactions.find((t) => t.name === name).fingerprint;
  assert.equal(fp('Huisbaas BV'), sha('2026-09-29|-105000|Huisbaas BV|Huur oktober 2026 Teststraat 1|Overschrijving'));
  assert.equal(fp('SUPERMARKT 1234 TESTDORP'), sha('2026-09-24|-4873|SUPERMARKT 1234 TESTDORP||Betaalautomaat'));
  const c = plain(await B.importer.preview([file('a.csv', COMMA)]));
  const garage = c.transactions.find((t) => t.name === 'Garage Test BV');
  assert.equal(garage.fingerprint, sha('2026-10-27|-24500|Garage Test BV|Factuur 2026-0456; APK en onderhoud|Online bankieren'));
});

test('two identical payments in one file are both kept; reading the file again skips both', async () => {
  const header = SEMICOLON.split('\n')[0];
  const coffee = '"20261005";"Koffiebar Test";"NL00INGB0000000000";"";"BA";"Af";"3,50";"Betaalautomaat";"Pasvolgnr: 003";"10,00";""';
  const text = `${header}\n${coffee}\n${coffee.replace('"10,00"', '"13,50"')}`;
  const { B } = setup();
  const p = await B.importer.preview([file('koffie.csv', text)]);
  assert.equal(p.transactions.length, 2);
  assert.notEqual(p.transactions[0].fingerprint, p.transactions[1].fingerprint);
  B.importer.commit(p);
  const again = plain(await B.importer.preview([file('koffie.csv', text)]));
  assert.equal(again.duplicates, 2);
  assert.equal(again.transactions.length, 0);
});

test('review dialog for a new PDF: summary, [Add] commits in one undoable step and opens the month', async () => {
  const { B, dialogs, toasts, routes } = setup();
  await B.importer.readFiles([pdfFile()]);
  const d = lastDialog(dialogs);
  assert.equal(d.title, 'Read bank file');
  assert.deepEqual(d.labels, ['Add', 'Cancel']);
  assert.equal(d.text, ['14 payments found (Sep 2026)', '✓ Totals match the statement', '6 not sorted yet'].join('\n'));
  assert.equal(B.store.get().transactions.length, 0, 'nothing is added before Add');

  d.actions[0].onClick();
  const state = B.store.get();
  assert.equal(state.transactions.length, 14);
  assert.equal(state.statements.length, 1);
  assert.ok(state.statements[0].importedAt);
  assert.equal(state.settings.lastImportAt, state.statements[0].importedAt);
  assert.deepEqual(routes, [{ view: 'month', month: '2026-09' }]);
  assert.deepEqual(toasts, ['14 payments added.']);
  assert.equal(B.store.undo(), 'Import');
  assert.equal(B.store.get().transactions.length, 0);
  assert.equal(B.store.get().settings.lastImportAt, null);
});

test('re-importing the same statement adds nothing and warns about the month', async () => {
  const { B, dialogs } = setup();
  B.importer.commit(await B.importer.preview([pdfFile()]));
  const before = B.store.get();
  const p = plain(await B.importer.readFiles([pdfFile()]));
  assert.equal(p.duplicates, 14);
  assert.deepEqual(p.transactions, []);
  assert.deepEqual(p.statements, [], 'the same statement is not added twice');
  assert.deepEqual(p.existingMonths, ['2026-09']);
  const d = lastDialog(dialogs);
  assert.equal(d.title, 'Nothing new');
  assert.deepEqual(d.labels, ['Close']);
  assert.equal(d.text, [
    '14 payments found (Sep 2026)',
    '✓ Totals match the statement',
    '14 were already read — skipped',
    'You already read this month — duplicate payments are skipped',
    'There is nothing new to add.',
  ].join('\n'));
  assert.deepEqual(plain(B.importer.commit(p)), { added: 0, statements: 0 });
  assert.equal(B.store.get(), before);
});

test('comma CSV then semicolon CSV: all rows are duplicates, but the balances add the October statement', async () => {
  const { B, dialogs, toasts } = setup();
  await B.importer.readFiles([file('komma.csv', COMMA)]);
  let d = lastDialog(dialogs);
  assert.equal(d.text, ['12 payments found (Oct 2026)', "This file has no balances, so it can't be checked.", '6 not sorted yet'].join('\n'));
  d.actions[0].onClick();
  assert.equal(B.store.get().transactions.length, 12);
  assert.equal(B.store.get().statements.length, 0);

  await B.importer.readFiles([file('puntkomma.csv', SEMICOLON)]);
  d = lastDialog(dialogs);
  assert.equal(d.title, 'Read bank file');
  assert.equal(d.text, [
    '12 payments found (Oct 2026)',
    '✓ Balances match the bank',
    '12 were already read — skipped',
    'You already read this month — duplicate payments are skipped',
  ].join('\n'));
  d.actions[0].onClick();
  const state = B.store.get();
  assert.equal(state.transactions.length, 12);
  assert.deepEqual(plain(state.statements.map((s) => [s.month, s.source, s.startBalance, s.endBalance])), [['2026-10', 'csv', 86715, 71358]]);
  assert.equal(toasts[toasts.length - 1], 'Statement added.');
});

test('several files at once: one summary over all of them, per-file lines, duplicates across files skipped', async () => {
  const { B, dialogs } = setup();
  const p = plain(await B.importer.readFiles([pdfFile(), file('komma.csv', COMMA), file('puntkomma.csv', SEMICOLON)]));
  assert.equal(p.found, 38);
  assert.equal(p.duplicates, 12);
  assert.equal(p.transactions.length, 26);
  assert.deepEqual(p.statements.map((s) => `${s.month}:${s.source}`), ['2026-09:pdf', '2026-10:csv']);
  const d = lastDialog(dialogs);
  assert.deepEqual(d.text.split('\n').slice(0, 7), [
    '38 payments found (Sep – Oct 2026)',
    'afschrift-sep.pdf: 14 payments (Sep 2026)',
    'afschrift-sep.pdf: ✓ Totals match the statement',
    'komma.csv: 12 payments (Oct 2026)',
    "komma.csv: This file has no balances, so it can't be checked.",
    'puntkomma.csv: 12 payments (Oct 2026)',
    'puntkomma.csv: ✓ Balances match the bank',
  ]);
  assert.match(d.text, /12 were already read — skipped/);
});

test('the same payment from the PDF and from a CSV gets the same fingerprint (Dutch and English CSV)', async () => {
  const { B } = setup();
  B.importer.commit(await B.importer.preview([pdfFile()]));
  const dutch = [
    '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen"',
    '"20260929";"Huisbaas BV";"NL00INGB0000000000";"NL00TEST0123456789";"OV";"Af";"1050,00";"Overschrijving";"Naam: Huisbaas BV Omschrijving: Huur oktober 2026 Teststraat 1 IBAN: NL00TEST0123456789 Kenmerk: HUUR-2026-10 Valutadatum: 29-09-2026"',
    '"20260928";"Kosten ING Go";"NL00INGB0000000000";"";"DV";"Af";"2,95";"Diversen";"1 aug t/m 31 aug 2026 ING BANK N.V. Valutadatum: 28-09-2026"',
    '"20260924";"SUPERMARKT 1234 TESTDORP";"NL00INGB0000000000";"";"BA";"Af";"48,73";"Betaalautomaat";"Pasvolgnr: 003 24-09-2026 17:42 Transactie: A00012 Term: XX000000 Valutadatum: 24-09-2026"',
  ].join('\n');
  const english = dutch
    .replace('"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen"',
      '"Date";"Name / Description";"Account";"Counterparty";"Code";"Debit/credit";"Amount (EUR)";"Transaction type";"Notifications"')
    .replace(/"Af"/g, '"Debit"')
    .replace('"Overschrijving"', '"Transfer"').replace('"Diversen"', '"Various"').replace('"Betaalautomaat"', '"Payment terminal"')
    .replace('Naam: ', 'Name: ').replace('Omschrijving: ', 'Description: ').replace('Kenmerk: ', 'Reference: ');
  for (const text of [dutch, english]) {
    const p = plain(await B.importer.preview([file('sep.csv', text)]));
    assert.equal(p.found, 3);
    assert.equal(p.duplicates, 3, 'all three were already read from the PDF');
    assert.deepEqual(p.existingMonths, ['2026-09']);
  }
});

test('rules and hidden words from the state are applied in the preview', async () => {
  const { B } = setup();
  B.store.update((s) => {
    s.rules.push({ id: 'r_1', match: { nameContains: 'Huisbaas', sign: 'out' }, set: { categoryId: 'huur' }, createdAt: '2026-10-01T00:00:00.000Z' });
    s.settings.hiddenWords = ['Jansen'];
  });
  const p = plain(await B.importer.preview([pdfFile()]));
  const rent = p.transactions.find((t) => t.amount === -105000);
  assert.equal(rent.categoryId, 'huur');
  assert.equal(rent.kind, 'elke-maand');
  assert.equal(p.transactions.find((t) => t.amount === 2500).name, 'J.');
  assert.equal(p.unknown, 5);
});

test('Windows-1252 and UTF-8-with-BOM bytes are decoded', async () => {
  const header = '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen"';
  const text = `${header}\n"20261003";"Café Test";"NL00INGB0000000000";"";"BA";"Af";"4,50";"Betaalautomaat";"Omschrijving: crème € 4,50"`;
  const cp1252 = Uint8Array.from(text, (ch) => (ch === '€' ? 0x80 : ch.charCodeAt(0)));
  const { B } = setup();
  const p = plain(await B.importer.preview([file('cp1252.csv', cp1252)]));
  assert.equal(p.transactions[0].name, 'Café Test');
  assert.equal(p.transactions[0].description, 'crème € 4,50');
  const bom = plain(await B.importer.preview([file('bom.csv', `﻿${text}`)]));
  assert.equal(bom.transactions[0].name, 'Café Test');
  assert.equal(bom.transactions[0].fingerprint, p.transactions[0].fingerprint);
});

test('unreadable files: friendly message, nothing changes; one bad file does not block the others', async () => {
  const { B, dialogs, errors } = setup();
  await B.importer.readFiles([file('foto.jpg', 'ÿØÿà not a bank file')]);
  let d = lastDialog(dialogs);
  assert.equal(d.title, 'File not read');
  assert.equal(d.text, READ_ERROR);
  assert.deepEqual(d.labels, ['Close']);
  assert.equal(B.store.get().transactions.length, 0);

  const savings = '"Datum","Omschrijving","Rekening","Rekening naam","Tegenrekening","Af Bij","Bedrag","Valuta","Mutatiesoort","Mededelingen","Saldo na mutatie"\n';
  const p = plain(await B.importer.readFiles([file('NL00INGB0001234567_01-10-2026_31-10-2026.csv', savings), file('komma.csv', COMMA)]));
  assert.equal(p.transactions.length, 12);
  d = lastDialog(dialogs);
  assert.deepEqual(d.labels, ['Add', 'Cancel']);
  assert.match(d.text, /…_01-10-2026_31-10-2026\.csv: This looks like a download of a savings account/);
  assert.doesNotMatch(d.text, /NL00INGB|1234567/, 'no account number from the file name');
  assert.deepEqual(errors, [], 'expected failures are not logged as errors');

  const big = { name: 'groot.csv', size: 25 * 1024 * 1024, arrayBuffer: async () => { throw new Error('should not be read'); } };
  const tooBig = plain(await B.importer.preview([big]));
  assert.deepEqual(tooBig.files, [{ name: 'groot.csv', ok: false, error: 'This file is too big to be a bank file.' }]);
});

test('PDF failures: corrupt -> read error, password -> own message, unexpected error -> read error + logged', async () => {
  const failing = (name) => async () => {
    const err = new Error('pdf.js says no');
    err.name = name;
    throw err;
  };
  for (const [name, message, logged] of [
    ['InvalidPDFException', READ_ERROR, 0],
    ['PasswordException', "This PDF file is protected with a password. I can't read it.", 0],
    ['TypeError', READ_ERROR, 1],
  ]) {
    const { B, errors } = setup({ extract: failing(name) });
    const p = plain(await B.importer.preview([pdfFile()]));
    assert.deepEqual(p.files, [{ name: 'afschrift-sep.pdf', ok: false, error: message }], name);
    assert.equal(errors.length, logged, name);
  }
  const { B } = setup({ extract: async () => [{ width: 595, height: 842, items: [] }] });
  assert.equal((await B.importer.preview([pdfFile()])).files[0].error, READ_ERROR, 'a PDF without an ING table');
});

test('a statement that does not add up is shown in red and its saldi are not stored', async () => {
  const pages = JSON.parse(JSON.stringify(ITEMS));
  pages[0].items.find((i) => i.str === '1.633,37').str = '1.633,38';
  const { B, dialogs } = setup({ extract: async () => JSON.parse(JSON.stringify(pages)) });
  const p = plain(await B.importer.readFiles([pdfFile()]));
  assert.equal(p.files[0].check.ok, false);
  assert.deepEqual(p.statements, []);
  assert.equal(p.transactions.length, 14);
  const body = dialogs[0].body;
  const bad = body.flat().find((n) => n && n.attrs && n.attrs.class === 'check bad');
  assert.ok(bad, 'a .check.bad block');
  assert.match(textOf(bad), /^Note: the totals don't match the statement\.\nAdded up, €1,633\.37 went out, but the statement says €1,633\.38\./);
});

test('CSV statements of one month: overlapping downloads are joined, a covering download replaces', async () => {
  const lines = SEMICOLON.split('\n');
  const header = lines[0];
  const rows = lines.slice(1);
  const early = [header, ...rows.filter((l) => l.slice(1, 9) <= '20261015')].join('\n'); // 1–15 oct
  const late = [header, ...rows.filter((l) => l.slice(1, 9) >= '20261008')].join('\n'); // 8–28 oct
  const { B } = setup();
  B.importer.commit(await B.importer.preview([file('early.csv', early)]));
  let s = plain(B.store.get().statements);
  assert.deepEqual(s.map((x) => [x.periodFrom, x.periodTo, x.startBalance, x.endBalance]), [['2026-10-01', '2026-10-15', 86715, -6682]]);
  B.importer.commit(await B.importer.preview([file('late.csv', late)]));
  s = plain(B.store.get().statements);
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].periodFrom, s[0].periodTo, s[0].startBalance, s[0].endBalance, s[0].totalIn, s[0].totalOut], ['2026-10-01', '2026-10-28', 86715, 71358, null, null]);
  assert.equal(B.store.get().transactions.length, 12);
  B.importer.commit(await B.importer.preview([file('full.csv', SEMICOLON)]));
  s = plain(B.store.get().statements);
  assert.deepEqual([s[0].periodFrom, s[0].periodTo, s[0].totalIn, s[0].totalOut], ['2026-10-01', '2026-10-28', 162740, 178097]);
});

test('commit skips payments that were added after the preview was made', async () => {
  const { B } = setup();
  const one = await B.importer.preview([pdfFile()]);
  const two = await B.importer.preview([pdfFile()]);
  assert.deepEqual(plain(B.importer.commit(one)), { added: 14, statements: 1 });
  const state = B.store.get();
  assert.deepEqual(plain(B.importer.commit(two)), { added: 0, statements: 0 });
  assert.equal(B.store.get(), state, 'no change, no extra undo step');
});

// ---- the account holder's name and address ------------------------------------------------
// test/fixtures/ing-fake-holder.* (made by make-holder-fixtures.mjs): a FAKE statement whose holder block is
// "T. Tester / Teststraat 1 / 1234 AB Voorbeeldstad" and whose payments repeat that holder in many forms.

const HOLDER = JSON.parse(read('test/fixtures/ing-fake-holder.expected.json'));
const HOLDER_ITEMS = JSON.parse(read('test/fixtures/ing-fake-holder.items.json'));
const HOLDER_PDF = readFileSync(new URL('test/fixtures/ing-fake-holder.pdf', root));
const HOLDER_CSV = read('test/fixtures/ing-fake-holder.csv');
const holderPdf = () => file('afschrift-mrt.pdf', HOLDER_PDF);
const holderCsv = () => file('apr.csv', HOLDER_CSV);
const holderSetup = () => setup({ extract: async () => JSON.parse(JSON.stringify(HOLDER_ITEMS)) });
// Every part of the holder block, in any case, with or without accents or the postcode space; plus the first
// name the payee "Tom Tester" adds.
const LEAK_RE = /\b(?:tester|teststraat|voorbeeldstad|tom)\b|1234\s?ab/i;
const leaks = (text) => String(text).normalize('NFD').replace(/\p{M}/gu, '').match(new RegExp(LEAK_RE.source, 'gi')) || [];
const pairs = (txs) => plain(txs.map((t) => [t.name, t.description]));

test('holder privacy: nothing of the holder block survives in state, localStorage or the backup', async () => {
  const { B, storage } = holderSetup();
  const p = plain(await B.importer.preview([holderPdf()]));
  assert.deepEqual(pairs(p.transactions), HOLDER.clean, 'every row cleaned exactly');
  assert.equal(p.files[0].check.ok, true);
  B.importer.commit(p);
  B.store.flush();
  const state = B.store.get();
  assert.deepEqual(leaks(JSON.stringify(state)), [], 'state');
  assert.deepEqual(leaks([...storage.values()].join('\n')), [], 'localStorage');
  assert.deepEqual(leaks(JSON.stringify(B.store.exportBackup())), [], 'backup');
  // Only salted hashes are kept: a salt and 4 hashes (surname, street, postcode, town).
  assert.match(state.settings.privacySalt, /^[0-9a-f]{32}$/);
  assert.equal(state.settings.privateTokenHashes.length, 4);
  for (const h of state.settings.privateTokenHashes) assert.match(h, /^[123][0-9a-f]{32}$/);
  // Reference-code mask and glued shop names on the same statement.
  assert.equal(state.transactions.find((t) => t.date === '2027-03-10').description, '…', 'reference code masked');
  assert.equal(state.transactions.find((t) => t.name === 'ApotheekDeLinde NLD').categoryId, 'dagelijks', 'glued shop name');
});

test('holder privacy: a later CSV (no holder block) is cleaned with the remembered hashes', async () => {
  const { B, storage } = holderSetup();
  B.importer.commit(await B.importer.preview([holderPdf()]));
  const salt = B.store.get().settings.privacySalt;
  const c = plain(await B.importer.preview([holderCsv()]));
  assert.deepEqual(pairs(c.transactions), HOLDER.csvClean);
  assert.deepEqual(c.privacy.newHashes, [], 'a CSV adds no hashes');
  B.importer.commit(c);
  B.store.flush();
  assert.equal(B.store.get().settings.privacySalt, salt, 'the salt never changes');
  assert.deepEqual(leaks([...storage.values()].join('\n')), []);
});

test('holder privacy: a CSV read BEFORE the first PDF is cleaned when the PDF is added; undo keeps it clean', async () => {
  const { B } = holderSetup();
  B.importer.commit(await B.importer.preview([holderCsv()]));
  assert.ok(leaks(JSON.stringify(B.store.get().transactions)).length > 0, 'a CSV alone has no holder block, so its rows still name the holder');
  B.importer.commit(await B.importer.preview([holderPdf()]));
  const csvRows = B.store.get().transactions.filter((t) => t.source === 'csv');
  assert.deepEqual(pairs(csvRows), HOLDER.csvClean, 'cleaned when the PDF came in');
  assert.deepEqual(leaks(JSON.stringify(B.store.get())), []);
  assert.equal(B.store.undo(), 'Import');
  const after = B.store.get();
  assert.equal(after.transactions.length, 7, 'the PDF payments are gone again');
  assert.deepEqual(pairs(after.transactions), HOLDER.csvClean, 'but the CSV rows do not get the holder back');
  assert.equal(after.settings.privateTokenHashes.length, 4, 'and the hashes are kept');
  assert.deepEqual(leaks(JSON.stringify(after)), []);
});

test('holder privacy: CSV and PDF in one import (CSV first) - the PDF holder block cleans the CSV too', async () => {
  const { B } = holderSetup();
  const p = plain(await B.importer.preview([holderCsv(), holderPdf()]));
  assert.equal(p.transactions.length, 19);
  assert.deepEqual(leaks(JSON.stringify(p.transactions)), []);
  assert.equal(p.privacy.newHashes.length, 4);
  assert.doesNotMatch(JSON.stringify(p.privacy), LEAK_RE, 'the preview holds no plain holder text either');
});

test('holder privacy: prefixes, first names and two holders in the block (ing-fake-1 with another holder)', async () => {
  const pages = JSON.parse(JSON.stringify(ITEMS));
  const at = (str) => pages[0].items.find((i) => i.str === str);
  at('T. Tester').str = 'Hr Tom van der Tëster en/of Mw A. Tester-de Vries';
  at('Teststraat 1').str = 'Lange Teststraat 12 B';
  at('1234 AB Voorbeeldstad').str = '1234AB VOORBEELDSTAD';
  pages.flatMap((p) => p.items).find((i) => i.str === 'J. Jansen').str = 'T. VAN DER TESTER';
  const { B } = setup({ extract: async () => JSON.parse(JSON.stringify(pages)) });
  const p = plain(await B.importer.preview([pdfFile()]));
  assert.equal(p.files[0].check.ok, true);
  const row = p.transactions.find((t) => t.date === '2026-09-22');
  assert.equal(row.name, 'Online bankieren', 'the holder as payee: name hidden, the type is shown');
  const text = JSON.stringify(p.transactions).replace(/Teststraat 1/g, ''); // not this holder's street
  assert.deepEqual(leaks(text), []);
  assert.doesNotMatch(text, /\b(?:vries|lange|12 b)\b/i);
  assert.ok(p.transactions.some((t) => t.description === 'Huur oktober 2026 Teststraat 1'),
    'a different street ("Teststraat", not the holder\'s "Lange Teststraat") stays');
});

test('payeeId at import: from the RAW bank name, before hidden words, holder data and rename rules', async () => {
  const { B } = setup();
  B.store.update((s) => {
    s.settings.hiddenWords = ['Jansen'];
    s.rules.push({ id: 'r_1', match: { nameContains: 'Huisbaas' }, set: { rename: 'Mijn huisbaas' }, createdAt: '2026-10-01T00:00:00.000Z' });
  });
  const p = plain(await B.importer.preview([pdfFile()]));
  const rent = p.transactions.find((t) => t.amount === -105000);
  assert.equal(rent.name, 'Mijn huisbaas');
  assert.equal(rent.payeeId, B.util.payeeId('Huisbaas BV'));
  const jansen = p.transactions.find((t) => t.amount === 2500);
  assert.equal(jansen.name, 'J.');
  assert.equal(jansen.payeeId, B.util.payeeId('J. Jansen'));
  for (const t of p.transactions) assert.match(t.payeeId, /^p_[0-9a-f]{16}$/);
  B.importer.commit(p);
  // Renaming never changes it.
  B.store.update((s) => { s.transactions.find((t) => t.amount === -105000).name = 'Huur'; });
  assert.equal(B.store.get().transactions.find((t) => t.amount === -105000).payeeId, B.util.payeeId('Huisbaas BV'));
});

test('payeeId at import: a payee from older data (id made from its name) stays one payee after a rename rule', async () => {
  const { B } = setup();
  // Old data: no payeeId (the store makes it from the name), shown as "Salaris" thanks to a rename rule.
  B.store.update((s) => {
    s.transactions.push({ id: 't_old', date: '2026-08-25', month: '2026-08', name: 'Salaris', description: '', amount: 131240,
      categoryId: 'inkomen', kind: 'elke-maand', type: 'Overschrijving', bankCode: 'TEST', source: 'pdf', fingerprint: 'fp_old' });
    s.rules.push({ id: 'r_1', match: { nameContains: 'Werkgever Voorbeeld' }, set: { rename: 'Salaris', categoryId: 'inkomen' }, createdAt: '2026-09-01T00:00:00.000Z' });
  });
  const old = B.store.get().transactions[0].payeeId;
  assert.equal(old, B.util.payeeId('Salaris'));
  B.importer.commit(await B.importer.preview([pdfFile()]));
  const salary = B.store.get().transactions.find((t) => t.date === '2026-09-25');
  assert.equal(salary.name, 'Salaris');
  assert.equal(salary.payeeId, old, 'same payee as the August payment');
  const nm = B.calc.normalMonth(B.store.get());
  assert.deepEqual(plain(nm.items.filter((i) => i.name === 'Salaris').map((i) => [i.key, i.normal])), [[`in:${old}`, 131240]],
    'one "Salaris" item, counted once');
  assert.equal(nm.income, 131240 + 11800, 'salary + the Belastingdienst toeslag of the fixture');
});

test('one payee + rules on the raw name, end to end: hidden word added between two imports - one payee, rule still works', async () => {
  const H = '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen";"Saldo na mutatie";"Tag"';
  const csv = (d, saldo) => `${H}\n"${d}";"Hr J. Testnaam";"NL00INGB0000000000";"NL11RABO0000000000";"OV";"Bij";"500,00";"Overschrijving";"Omschrijving: bijdrage huishouden";"${saldo}";""`;
  const { B } = setup();
  B.importer.commit(await B.importer.preview([file('sep.csv', csv('20260915', '1500,00'))]));
  // The user makes it income, "Always do this" (rule), then hides their surname.
  B.store.update((d) => {
    const x = d.transactions[0];
    x.categoryId = 'inkomen';
    x.kind = 'elke-maand';
    d.rules.push(B.categorize.ruleFromTx({ ...x }, 'category'));
  });
  let cleaned = null;
  B.store.update((d) => {
    d.settings.hiddenWords = ['Testnaam'];
    cleaned = B.categorize.recleanState(d);
  });
  assert.equal(cleaned, 1);
  assert.equal(B.store.get().transactions[0].name, 'Hr J.');
  const p = plain(await B.importer.preview([file('oct.csv', csv('20261015', '2000,00'))]));
  assert.equal(p.transactions[0].name, 'Hr J.');
  assert.equal(p.transactions[0].categoryId, 'inkomen', 'the rule (learned on "Hr J. Testnaam") still matches the raw name');
  B.importer.commit(p);
  const nm = B.calc.normalMonth(B.store.get());
  assert.equal(nm.items.length, 1, 'one payee');
  assert.equal(nm.income, 50000, 'normal income counted once');
  assert.doesNotMatch(JSON.stringify(B.store.get().transactions), /Testnaam/);
});
