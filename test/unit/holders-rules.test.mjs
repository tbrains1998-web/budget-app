// Unit tests for: several holder blocks in one import, no reference-code
// mask on payee names + twins by payeeId, rules never keep hidden words or holder parts, undo of
// "Clear everything" keeps lastBackupAt. The real app scripts run as classic scripts in a vm context (no DOM) with an
// in-memory localStorage. All names, addresses and amounts are FAKE (two invented holders: "T. Tester" from the
// fixtures and "F. Kwakernaak").
//
// BUDGET_SRC_JS=<dir/> runs the same tests against another copy of src/js (e.g. an older copy, for a
// fails-before check); default src/js/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const BASE = process.env.BUDGET_SRC_JS || 'src/js/';
const FILES = ['util', 'store', 'calc', 'categorize', 'import-csv', 'import-pdf', 'ui-kit', 'import', 'ui-month', 'ui-extras'];

// ---- fake bank files ----------------------------------------------------------------------------------

const HOLDER_ITEMS = read('test/fixtures/ing-fake-holder.items.json'); // March 2027, holder T. Tester
const SEPT_ITEMS = read('test/fixtures/ing-fake-1.items.json'); // September 2026, holder T. Tester
const HOLDER_CSV = read('test/fixtures/ing-fake-holder.csv'); // April 2027, names T. Tester

// The September fixture as the statement of ANOTHER (fake) holder: block, payees and descriptions moved over.
function secondHolderItems() {
  const swap = [
    ['T. Tester', 'F. Kwakernaak'], ['Teststraat 1', 'Lindeboomlaan 14B'], ['1234 AB Voorbeeldstad', '9876 ZX Oosterwold'],
    ['J. Jansen', 'Fenna Kwakernaak'], ['Voorbeeldstad', 'Oosterwold'], ['TESTDORP', 'OOSTERWOLD'],
  ];
  const pages = JSON.parse(SEPT_ITEMS);
  for (const item of pages.flatMap((p) => p.items)) {
    for (const [from, to] of swap) item.str = item.str.split(from).join(to);
  }
  return pages;
}

const NL_HEADER = '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen";"Saldo na mutatie";"Tag"';
// rows oldest first: [yyyymmdd, name, counter IBAN, cents, type, message]; written newest first with a saldo chain.
function csvText(rows, start = 100000) {
  let saldo = start;
  const euro = (c) => `${Math.floor(Math.abs(c) / 100)},${String(Math.abs(c) % 100).padStart(2, '0')}`;
  const lines = rows.map(([date, name, iban, cents, type, msg]) => {
    saldo += cents;
    return [date, name, 'NL00INGB0000000000', iban, 'OV', cents < 0 ? 'Af' : 'Bij', euro(cents), type, msg, euro(saldo), '']
      .map((v) => `"${v}"`).join(';');
  });
  return [NL_HEADER, ...lines.reverse()].join('\n');
}

// July 2027 CSV of the second holder: the holder's own account, address and town in names and descriptions.
const SECOND_CSV = csvText([
  ['20270702', 'Huisbaas Test BV', 'NL00TEST0000000101', -20000, 'Overschrijving', 'Naam: Huisbaas Test BV Omschrijving: Huur juli 2027 Lindeboomlaan 14B IBAN: NL00TEST0000000101'],
  ['20270705', 'Lidl Oosterwold', '', -4560, 'Betaalautomaat', 'Pasvolgnr: 003 05-07-2027 10:10'],
  ['20270710', 'MW F KWAKERNAAK', 'NL00RABO0000000099', -10000, 'Online bankieren', 'Naam: MW F KWAKERNAAK Omschrijving: Naar eigen rekening 9876 ZX Oosterwold IBAN: NL00RABO0000000099'],
  ['20270720', 'Energie Test BV', 'NL00TEST0000000006', -9700, 'Incasso', 'Naam: Energie Test BV Omschrijving: Termijn juli levering 9876ZX OOSTERWOLD IBAN: NL00TEST0000000006'],
  ['20270725', 'Fenna Kwakernaak', 'NL00RABO0000000099', 5000, 'Online bankieren', 'Naam: Fenna Kwakernaak Omschrijving: Terug van eigen rekening IBAN: NL00RABO0000000099'],
]);

const LEAK_A = /\b(?:tester|teststraat|voorbeeldstad|tom)\b|1234\s?ab/i;
const LEAK_B = /\b(?:kwakernaak|lindeboomlaan|oosterwold|fenna)\b|9876\s?zx/i;
const leaks = (value, re) => String(typeof value === 'string' ? value : JSON.stringify(value))
  .normalize('NFD').replace(/\p{M}/gu, '').match(new RegExp(re.source, 'gi')) || [];

function file(name, content) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
  return { name, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer };
}
// Fake PDFs: the bytes only say which statement it is; extract() returns that statement's pdf.js items.
const PDF = { A: () => file('a.pdf', '%PDF-1.4\n%A'), B: () => file('b.pdf', '%PDF-1.4\n%B') };
const CSV = { A: () => file('a.csv', HOLDER_CSV), B: () => file('b.csv', SECOND_CSV) };

// ---- the app in a vm --------------------------------------------------------------------------------

function setup() {
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
  const context = vm.createContext({ TextEncoder, TextDecoder, crypto: globalThis.crypto, console, setTimeout, clearTimeout, localStorage });
  for (const f of FILES) vm.runInContext(read(`${BASE}${f}.js`), context, { filename: `${f}.js` });
  const B = context.Budget;
  B.app = { go: () => {} };
  B.importPdf.extract = async (buffer) => (new TextDecoder().decode(buffer).includes('%B') ? secondHolderItems() : JSON.parse(HOLDER_ITEMS));
  B.store.load();
  const all = () => {
    B.store.flush();
    return [JSON.stringify(B.store.get()), [...storage.values()].join('\n'), JSON.stringify(B.store.exportBackup())].join('\n');
  };
  return { B, storage, all };
}

async function importFiles(B, files) {
  const p = await B.importer.preview(files);
  B.importer.commit(p);
  return p;
}

const SALT = '00112233445566778899aabbccddeeff';
function withHolder(B, draft, lines) {
  draft.settings.privacySalt = SALT;
  draft.settings.privateTokenHashes = B.categorize.hashTokens(B.categorize.holderTokens(lines), SALT);
}
const HOLDER_A = ['T. Tester', 'Teststraat 1', '1234 AB Voorbeeldstad'];
const HOLDER_B = ['F. Kwakernaak', 'Lindeboomlaan 14B', '9876 ZX Oosterwold'];

let n = 0;
const pay = (name, amount, extra = {}) => ({ id: `t_r2_${++n}`, date: '2027-01-10', month: '2027-01', name, description: '', amount,
  categoryId: 'onbekend', kind: 'wisselend', type: 'Overschrijving', bankCode: '', source: 'csv', fingerprint: `fp_r2_${n}`, ...extra });

// ==== several holder blocks ============================================================================

test('holderTokens: two blocks in one list (two statements) give both holders\' parts', () => {
  const { B } = setup();
  const canon = (lines) => plain(B.categorize.holderTokens(lines)).map((t) => `${t.kind}:${t.canon}`).sort();
  assert.deepEqual(canon([...HOLDER_A, ...HOLDER_B]), [
    'name:kwakernaak', 'name:tester', 'place:1234ab', 'place:9876zx', 'place:oosterwold', 'place:voorbeeldstad',
    'street:lindeboomlaan', 'street:teststraat']);
  // A personal and a joint ("en/of") account: both people of the joint block.
  assert.deepEqual(canon([...HOLDER_A, 'T. Tester en/of M. Proef', 'Teststraat 1', '1234 AB Voorbeeldstad']),
    ['name:proef', 'name:tester', 'place:1234ab', 'place:voorbeeldstad', 'street:teststraat']);
  // "en/of" at the end or the start of a line; never a part of its own.
  assert.deepEqual(canon(['T. Tester en/of', 'M. Proef', 'Teststraat 1', '1234 AB Voorbeeldstad']),
    ['name:proef', 'name:tester', 'place:1234ab', 'place:voorbeeldstad', 'street:teststraat']);
  assert.deepEqual(canon(['T. Tester', 'EN/OF M. PROEF', 'Teststraat 1', '1234 AB Voorbeeldstad']),
    ['name:proef', 'name:tester', 'place:1234ab', 'place:voorbeeldstad', 'street:teststraat']);
  // One block as before; lines after its postcode line are not part of it.
  assert.deepEqual(canon([...HOLDER_A, 'Nederland']), ['name:tester', 'place:1234ab', 'place:voorbeeldstad', 'street:teststraat']);
});

test('stripping a joint holder: "van" (from) before an initial stays; title, initials and prefixes of the name go', () => {
  const { B } = setup();
  const lines = ['T. Tester en/of M. Proef', 'Teststraat 1', '1234 AB Voorbeeldstad'];
  const test = B.categorize.privacyTest(SALT, B.categorize.hashTokens(B.categorize.holderTokens(lines), SALT));
  const desc = (s) => B.categorize.stripPrivate(s, test, false);
  assert.equal(desc('Gift van M. Proef'), 'Gift van');
  assert.equal(desc('Gift van T. Tester'), 'Gift van');
  assert.equal(desc('Gift van Mw. M. Proef'), 'Gift van');
  assert.equal(desc('Salaris De heer T. van der Tester'), 'Salaris');
  assert.equal(desc('Premie Tester T. en Proef M.'), 'Premie en');
  assert.equal(B.categorize.stripPrivate('M PROEF', test, true), '');
});

for (const order of [['A', 'B', 'csvB'], ['csvB', 'B', 'A']]) {
  test(`import: two PDFs with different holders + a CSV of the second, in one import (${order.join(', ')}): no holder text kept`, async () => {
    const { B, all } = setup();
    const files = order.map((k) => (k === 'csvB' ? CSV.B() : PDF[k]()));
    const p = await importFiles(B, files);
    assert.equal(p.files.filter((f) => f.ok).length, 3);
    assert.equal(p.privacy.newHashes.length, 8, 'both holders: surname, street, postcode, town each');
    assert.deepEqual(leaks(all(), LEAK_A), [], 'first holder: state, localStorage, backup');
    assert.deepEqual(leaks(all(), LEAK_B), [], 'second holder: state, localStorage, backup');
    const st = B.store.get();
    assert.ok(st.transactions.some((t) => t.name === 'Lidl'), 'shop name kept, town gone');
    assert.ok(st.transactions.some((t) => t.description === 'Huur oktober 2026'), 'the second holder\'s street left the description');
  });
}

test('import: payments read earlier (CSV) lose the second holder when the two PDFs come in together', async () => {
  const { B, all } = setup();
  await importFiles(B, [CSV.B()]);
  assert.ok(leaks(all(), LEAK_B).length > 0, 'a CSV alone has no holder block (expected)');
  await importFiles(B, [PDF.A(), PDF.B()]);
  assert.deepEqual(leaks(all(), LEAK_A), []);
  assert.deepEqual(leaks(all(), LEAK_B), []);
  B.store.undo(); // undo of that import keeps the hashes and the cleaning
  assert.deepEqual(leaks(all(), LEAK_B), []);
  assert.equal(B.store.get().transactions.length, 5, 'only the CSV payments are left');
});

// ==== names keep reference-like words; twins by payeeId ================================================

test('names: no reference-code mask on payee names (only 6+ digit runs); descriptions keep the reference-code mask', () => {
  const { B } = setup();
  const c = (rawName, rawDescription = '') => B.categorize.categorize({ rawName, rawDescription, amount: -1000, type: 'Betaalautomaat', iban: '' }, B.store.get());
  for (const name of ['SumUp *Bakkerij123', 'CCV*FRITUUR2023', 'KRUIDVAT5678', 'Ticket2026 Festival', 'BCK*Kiosk2024', 'Zettle_*Kapsalon1234']) {
    assert.equal(c(name).name, name, name);
  }
  assert.equal(c('Naar Oranje spaarrekening C123456789').name, 'Naar Oranje spaarrekening C…', 'account numbers still masked');
  assert.equal(c('Webwinkel Test', 'Omschrijving: XQZ743QK0RLRHFYX0').description, '…', 'the description mask is unchanged');
  assert.equal(c('Webwinkel Test', 'Omschrijving: Bestelling 2027 ABC12345').description, 'Bestelling 2027 …');
});

test('recleanState ("Hide words", first PDF) never masks names: a typed name stays', () => {
  const { B } = setup();
  B.store.update((d) => {
    d.transactions.push(pay('Kerstpakket2026', -5000, { source: 'hand', fingerprint: '' }), pay('SumUp *Bakkerij123', -450),
      pay('Huur Teststraat', -60000));
  });
  let changed;
  B.store.update((d) => {
    d.settings.hiddenWords = ['Teststraat'];
    changed = B.categorize.recleanState(d);
  }, { undoLabel: 'Hidden words changed' });
  assert.equal(changed, 1);
  assert.deepEqual(plain(B.store.get().transactions.map((t) => t.name)), ['Kerstpakket2026', 'SumUp *Bakkerij123', 'Huur']);
});

test('twins: two shops that look alike are two payees; a category pick and its rule touch only the one', () => {
  const { B } = setup();
  const rows = [['SumUp *Bakkerij123', -450], ['SumUp *Kapsalon777', -3500]];
  B.store.update((d) => {
    rows.forEach(([raw, amount]) => {
      const c = B.categorize.categorize({ rawName: raw, rawDescription: '', amount, type: 'Betaalautomaat', iban: '' }, d);
      d.transactions.push(pay(c.name, amount, { payeeId: B.util.payeeId(raw) }));
    });
    // Old data: the same shown name for two different payees.
    d.transactions.push(pay('SumUp *…', -100, { payeeId: B.util.payeeId('SumUp *Fiets1234') }), pay('SumUp *…', -200, { payeeId: B.util.payeeId('SumUp *Boek5678') }));
  });
  const st = B.store.get();
  assert.notEqual(st.transactions[0].name, st.transactions[1].name);
  let twins;
  B.store.update((d) => {
    d.transactions[0].categoryId = 'dagelijks';
    twins = B.uiMonth.helpers.applyToUnknownTwins(d, { ...d.transactions[0] });
    d.transactions[2].categoryId = 'eenmalig';
    twins += B.uiMonth.helpers.applyToUnknownTwins(d, { ...d.transactions[2] });
  });
  assert.equal(twins, 0, 'no other payee changes along');
  assert.deepEqual(plain(B.store.get().transactions.map((t) => t.categoryId)), ['dagelijks', 'onbekend', 'eenmalig', 'onbekend']);
  const rule = B.categorize.ruleFromTx({ ...B.store.get().transactions[0] }, 'category');
  const later = B.categorize.categorize({ rawName: 'SumUp *Fietsenmaker2024', rawDescription: '', amount: -9900, type: 'Betaalautomaat', iban: '' },
    { ...B.store.get(), rules: [rule] });
  assert.equal(later.categoryId, 'onbekend', 'a rule for one SumUp shop does not catch another');
  const same = B.categorize.categorize({ rawName: 'SumUp *Bakkerij123', rawDescription: '', amount: -380, type: 'Betaalautomaat', iban: '' },
    { ...B.store.get(), rules: [rule] });
  assert.equal(same.categoryId, 'dagelijks', 'but it does catch the same shop');
});

// ==== rules never keep hidden words or holder parts ====================================================

test('rules: CSV first, "Always do this" on the own-account transfer, then the PDF: the rule loses the name but still works', async () => {
  const { B, all } = setup();
  await importFiles(B, [CSV.A()]);
  const tom = B.store.get().transactions.find((t) => /Tom Tester/.test(t.name));
  assert.ok(tom, 'fixture: "Tom Tester" (nothing known about the holder yet)');
  B.store.update((d) => {
    const t = d.transactions.find((x) => x.id === tom.id);
    t.categoryId = 'sparen';
    t.kind = 'telt-niet-mee';
    d.rules.push(B.categorize.ruleFromTx(t, 'category'));
  }, { undoLabel: 'Regel bewaard' });
  await importFiles(B, [PDF.A()]);
  const rules = plain(B.store.get().rules);
  assert.deepEqual(leaks(rules, LEAK_A), [], 'no holder text in the rules');
  assert.deepEqual(leaks(all(), LEAK_A), [], 'nor anywhere in state, localStorage or the backup');
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].match, { payeeId: tom.payeeId, bankCode: 'RABO', sign: 'out' }, 'the precise form: this payee');
  assert.deepEqual(rules[0].set, { categoryId: 'sparen', kind: 'telt-niet-mee' });
  // The PDF's own "Tom Tester" row (March) was categorized by the rule.
  const march = B.store.get().transactions.find((t) => t.date === '2027-03-31');
  assert.deepEqual([march.name, march.categoryId], ['Online bankieren', 'sparen']);
  // Next month the same payee is recognised again; another payment shown as "Online bankieren" is not.
  const next = csvText([
    ['20270528', 'Tom Tester', 'NL00RABO0000000077', -40000, 'Online bankieren', 'Naam: Tom Tester Omschrijving: Naar eigen rekening'],
    ['20270529', 'HR T TESTER', 'NL00RABO0000000077', -1000, 'Online bankieren', 'Naam: HR T TESTER Omschrijving: Iets anders'],
  ]);
  const p = await B.importer.preview([file('mei.csv', next)]);
  assert.deepEqual(plain(p.transactions.map((t) => [t.name, t.categoryId])), [['Online bankieren', 'onbekend'], ['Online bankieren', 'sparen']]);
  // Undo of the PDF import: the rule stays clean (the hashes are kept).
  assert.equal(B.store.undo(), 'Import');
  assert.deepEqual(leaks(B.store.get().rules, LEAK_A), []);
  assert.deepEqual(leaks(all(), LEAK_A), []);
  assert.deepEqual(plain(B.store.get().rules[0].match), { payeeId: tom.payeeId, bankCode: 'RABO', sign: 'out' });
});

test('recleanState cleans rules: hidden word in nameContains -> payee rule; in a rename -> removed; in descriptionContains -> rule deleted', () => {
  const { B } = setup();
  const testnaam = pay('Hr J. Testnaam', 50000, { payeeId: B.util.payeeId('Hr J. Testnaam'), categoryId: 'inkomen', kind: 'elke-maand' });
  const huisbaas = pay('Huisbaas BV', -100000, { payeeId: B.util.payeeId('Huisbaas BV'), categoryId: 'huur', kind: 'elke-maand', description: 'Huur Testnaam' });
  B.store.update((d) => {
    d.transactions.push(testnaam, huisbaas);
    d.rules.push(
      { id: 'r_name', match: { nameContains: 'Hr J. Testnaam', sign: 'in' }, set: { categoryId: 'inkomen', kind: 'elke-maand', rename: 'Bijdrage Testnaam huishouden' }, createdAt: '2027-01-01T10:00:00.000Z' },
      { id: 'r_desc', match: { nameContains: 'Huisbaas', descriptionContains: 'testnaam' }, set: { categoryId: 'huur' }, createdAt: '2027-01-02T10:00:00.000Z' },
      { id: 'r_only_rename', match: { nameContains: 'Huisbaas BV' }, set: { rename: 'Testnaam' }, createdAt: '2027-01-03T10:00:00.000Z' },
      { id: 'r_gone', match: { nameContains: 'Testnaam Holding' }, set: { categoryId: 'vast' }, createdAt: '2027-01-04T10:00:00.000Z' },
    );
  });
  B.store.update((d) => {
    d.settings.hiddenWords = ['Testnaam'];
    B.categorize.recleanState(d);
  }, { undoLabel: 'Hidden words changed' });
  const st = B.store.get();
  assert.deepEqual(plain(st.rules), [
    { id: 'r_name', match: { sign: 'in', payeeId: testnaam.payeeId }, set: { categoryId: 'inkomen', kind: 'elke-maand', rename: 'Bijdrage huishouden' }, createdAt: '2027-01-01T10:00:00.000Z' },
  ], 'description rule, rename-only rule and the rule with no known payee are deleted; never an empty match');
  assert.doesNotMatch(JSON.stringify(st.rules), /testnaam/i);
  assert.deepEqual(plain(st.transactions.map((t) => t.categoryId)), ['inkomen', 'huur'], 'the payments keep their category');
  // The payee rule still matches the next import of that payee (by its raw bank name).
  const c = B.categorize.categorize({ rawName: 'Hr J. Testnaam', rawDescription: '', amount: 50000, type: 'Overschrijving', iban: '' }, st);
  assert.deepEqual(plain(c), { categoryId: 'inkomen', kind: 'elke-maand', name: 'Bijdrage huishouden', description: '' });
});

test('rules without hidden words or holder parts keep exactly their meaning through recleanState', () => {
  const { B } = setup();
  const rules = [
    { id: 'r_1', match: { nameContains: 'zilveren kruis', sign: 'out' }, set: { categoryId: 'zorg', kind: 'elke-maand', rename: 'Zorgverzekering' }, createdAt: '2027-01-01T10:00:00.000Z' },
    { id: 'r_2', match: { bankCode: 'REVO', sign: 'out' }, set: { categoryId: 'dagelijks', kind: 'wisselend' }, createdAt: '2027-01-02T10:00:00.000Z' },
    { id: 'r_3', match: { nameContains: 'belastingdienst', descriptionContains: 'zorgtoeslag', sign: 'in' }, set: { categoryId: 'inkomen', kind: 'elke-maand' }, createdAt: '2027-01-03T10:00:00.000Z' },
    { id: 'r_4', match: { nameContains: 'Naar Oranje spaarrekening C123456789' }, set: { categoryId: 'sparen', rename: 'Spaarpot 2027' }, createdAt: '2027-01-04T10:00:00.000Z' },
  ];
  B.store.update((d) => {
    d.rules.push(...plain(rules));
    d.transactions.push(pay('Zilveren Kruis', -13000), pay('Tom Tester', -5000));
    d.settings.hiddenWords = ['Jansen'];
    withHolder(B, d, HOLDER_A);
    B.categorize.recleanState(d);
  });
  assert.deepEqual(plain(B.store.get().rules), rules);
});

test('ruleFromTx: a name that lost words gives a payee rule (precise, no text); with the state a typed rename is cleaned', () => {
  const { B } = setup();
  B.store.update((d) => withHolder(B, d, HOLDER_A));
  const row = (rawName, amount = -10000) => ({ rawName, rawDescription: '', amount, type: 'Online bankieren', iban: 'NL00ABNA0000000088', date: '2027-03-01' });
  const st = B.store.get();
  const shown = B.categorize.categorize(row('HR T TESTER'), st);
  assert.equal(shown.name, 'Online bankieren');
  const tx = { ...pay(shown.name, -10000, { payeeId: B.util.payeeId('HR T TESTER'), bankCode: 'ABNA' }), categoryId: 'sparen', kind: 'telt-niet-mee' };
  const rule = plain(B.categorize.ruleFromTx(tx, 'category'));
  assert.deepEqual(rule.match, { payeeId: tx.payeeId, bankCode: 'ABNA', sign: 'out' });
  const rules = { ...st, rules: [rule] };
  assert.equal(B.categorize.categorize(row('HR T TESTER'), rules).categoryId, 'sparen', 'same payee: recognised');
  assert.equal(B.categorize.categorize(row('Tom Tester'), rules).categoryId, 'onbekend', 'another payee shown the same: not');
  // A rename the user typed with the holder's name in it: the rule does not keep it.
  const typed = plain(B.categorize.ruleFromTx({ ...tx, name: 'Online bankieren' }, { rename: 'Spaarpot van T. Tester bij de bank' }, st));
  assert.deepEqual(typed.match, { payeeId: tx.payeeId, bankCode: 'ABNA' });
  assert.equal(typed.set.rename, 'Spaarpot van bij de bank', '"van" before the initial is not a surname prefix');
  assert.equal(B.categorize.ruleFromTx({ ...tx }, { rename: 'Tom Tester' }, st), null, 'nothing left: no rule');
  // An ordinary payee: the rule by name as before.
  const plainRule = plain(B.categorize.ruleFromTx(pay('Huisbaas BV', -1, { payeeId: B.util.payeeId('Huisbaas BV'), categoryId: 'huur', kind: 'elke-maand' }), 'category', st));
  assert.deepEqual(plainRule.match, { nameContains: 'Huisbaas BV', sign: 'out' });
});

test('store: payeeId in rules is validated; an old backup whose rules still hold holder text is cleaned on restore', () => {
  const { B } = setup();
  const t = pay('Tom Tester', -5000, { payeeId: B.util.payeeId('Tom Tester'), categoryId: 'sparen', kind: 'telt-niet-mee' });
  const old = { version: 1, categories: [], transactions: [t], statements: [], normalAmounts: {},
    rules: [
      { id: 'r_old', match: { nameContains: 'Tom Tester', sign: 'out' }, set: { categoryId: 'sparen' }, createdAt: '2027-01-01T00:00:00.000Z' },
      { id: 'r_bad', match: { payeeId: 'p_NOT-AN-ID', sign: 'out' }, set: { categoryId: 'vast' }, createdAt: '2027-01-01T00:00:00.000Z' },
      { id: 'r_case', match: { payeeId: `  ${t.payeeId.toUpperCase().replace('P_', 'p_')} ` }, set: { categoryId: 'vast' }, createdAt: '2027-01-01T00:00:00.000Z' },
    ],
    settings: {} };
  withHolder(B, old, HOLDER_A);
  B.store.importBackup({ app: 'budget-nl', version: 1, exportedAt: '2027-02-01T00:00:00.000Z', state: old });
  const rules = plain(B.store.get().rules);
  assert.deepEqual(leaks(rules, LEAK_A), []);
  assert.deepEqual(rules.map((r) => r.match), [{ sign: 'out', payeeId: t.payeeId }, { sign: 'out' }, { payeeId: t.payeeId }]);
  // The rule list names a payee rule by the payee's shown name (plain words), never by its id.
  const s = B.uiExtras.pure.ruleSummary(rules[0], B.store.get().categories, B.store.get().transactions);
  assert.equal(`${s.when} ${s.then}`, "Same receiver as 'Tom Tester' and money out → Savings & own accounts");
  const gone = B.uiExtras.pure.ruleSummary({ match: { payeeId: 'p_0123456789abcdef', sign: 'in' }, set: { categoryId: 'inkomen' } }, B.store.get().categories, []);
  assert.equal(gone.when, 'Same sender as a payment that is no longer there and money in');
});

// ==== undo of "Clear everything" keeps lastBackupAt ========================================================

test('undo of "Clear everything" keeps the newest lastBackupAt, so no backup reminder for data that is backed up', () => {
  const { B } = setup();
  B.store.update((d) => {
    d.transactions.push(pay('Winkel BV', -100));
    d.settings.lastImportAt = '2027-01-03T10:00:00.000Z';
  });
  B.store.update((d) => {
    d.settings.lastBackupAt = '2027-01-03T11:00:00.000Z';
  }, { keepUndo: true });
  B.store.reset();
  assert.equal(B.store.get().settings.lastBackupAt, null);
  assert.equal(B.store.undo(), 'Everything cleared');
  assert.equal(B.store.get().settings.lastBackupAt, '2027-01-03T11:00:00.000Z');
  assert.equal(B.store.get().transactions.length, 1);
  assert.equal(B.uiExtras.pure.needsBackupReminder(B.store.get()), false);
  // A backup made after an undoable change: undo keeps that newer time (as before).
  const token = B.store.update((d) => { d.transactions[0].name = 'Winkel'; }, { undoLabel: 'Naam aangepast' });
  B.store.update((d) => { d.settings.lastBackupAt = '2027-01-04T09:00:00.000Z'; }, { keepUndo: true });
  B.store.undo(token);
  assert.equal(B.store.get().settings.lastBackupAt, '2027-01-04T09:00:00.000Z');
});
