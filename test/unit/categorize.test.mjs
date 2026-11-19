// Unit tests for src/js/categorize.js (Budget.categorize). util.js and store.js (for the default categories and
// default kinds) run with it as classic scripts in a vm context. All payees are fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function load() {
  const context = vm.createContext({ TextEncoder, TextDecoder, crypto: globalThis.crypto, console, setTimeout, clearTimeout });
  for (const f of ['util.js', 'store.js', 'categorize.js', 'import-pdf.js']) vm.runInContext(read(`src/js/${f}`), context, { filename: f });
  return context.Budget;
}

const Budget = load();
const { categorize: cat } = Budget;
const CATEGORIES = plain(Budget.store.DEFAULT_CATEGORIES);

function state({ rules = [], hiddenWords = [], categories = CATEGORIES } = {}) {
  return { version: 1, categories, transactions: [], statements: [], rules, normalAmounts: {}, settings: { savingsGoal: 0, hiddenWords, lastBackupAt: null, lastImportAt: null } };
}

function run(raw, s = state()) {
  return plain(cat.categorize({ rawDescription: '', type: '', iban: '', ...raw }, s));
}

function userRule(match, set, createdAt = '2026-10-01T10:00:00.000Z') {
  return { id: `r_${Math.random().toString(36).slice(2)}`, match, set, createdAt };
}

test('BUILTIN_RULES: frozen, generic, every rule sets a known category', () => {
  assert.ok(Object.isFrozen(cat.BUILTIN_RULES) && Object.isFrozen(cat.BUILTIN_RULES[0].match));
  const ids = new Set(CATEGORIES.map((c) => c.id));
  for (const rule of cat.BUILTIN_RULES) {
    assert.match(rule.id, /^builtin:/);
    assert.ok(ids.has(rule.set.categoryId), rule.id);
    assert.ok(Object.keys(rule.match).length > 0, rule.id);
  }
  assert.doesNotMatch(JSON.stringify(cat.BUILTIN_RULES), /\d{4,}|NL\d\d|test|jansen/i, 'no ids, IBANs or fixture names');
});

test('the fake PDF statement: built-in rules categorize the generic payees, the rest is onbekend', () => {
  const pages = JSON.parse(read('test/fixtures/ing-fake-1.items.json'));
  const rows = Budget.importPdf.parse(pages).rows;
  const got = Object.fromEntries(rows.map((r) => {
    const c = run(r);
    return [r.rawName, `${c.categoryId}/${c.kind}`];
  }));
  assert.deepEqual(got, {
    'Naar Oranje spaarrekening X12345678': 'sparen/telt-niet-mee',
    'Huisbaas BV': 'onbekend/wisselend',
    'Kosten ING Go': 'vast/elke-maand',
    'Zorgverzekeraar Test NV': 'zorg/elke-maand',
    'Werkgever Voorbeeld BV': 'onbekend/wisselend',
    'SUPERMARKT 1234 TESTDORP': 'dagelijks/wisselend',
    'J. Jansen': 'onbekend/wisselend',
    'Webwinkel Test': 'onbekend/wisselend',
    'Energiebedrijf Test BV': 'onbekend/wisselend',
    'Van Oranje spaarrekening X12345679': 'sparen/telt-niet-mee',
    'Telecom Test BV': 'onbekend/wisselend',
    'Geldautomaat TESTDORP': 'dagelijks/wisselend',
    Belastingdienst: 'inkomen/elke-maand',
    'DROGIST TEST 0042 TESTDORP': 'dagelijks/wisselend',
  });
});

test('built-in words match whole words; some only at the start of the name; accents and case ignored', () => {
  const c = (rawName, amount = -1000, type = '') => run({ rawName, amount, type }).categoryId;
  assert.equal(c('Albert Heijn 1234 TESTDORP'), 'dagelijks');
  assert.equal(c('PLUS TESTDORP'), 'dagelijks');
  assert.equal(c('Streaming Plus Test'), 'onbekend', "'plus' only at the start");
  assert.equal(c('Spartaan Test'), 'onbekend', 'no partial words');
  assert.equal(c('CZ Zorgverzekeringen'), 'zorg');
  assert.equal(c('Czapla Test'), 'onbekend');
  assert.equal(c('UNIVÉ ZORG'), 'zorg');
  assert.equal(c('Ben de Test'), 'onbekend', 'only "ben nederland" is the telecom brand');
  assert.equal(c('BEN NEDERLAND B.V.'), 'vast');
  assert.equal(c('KPN B.V.'), 'vast');
  assert.equal(c('Vattenfall Klantenservice'), 'vast');
  assert.equal(c('Belastingdienst', -5000), 'onbekend', 'tax paid is not income');
  assert.equal(c('UWV', 90000), 'inkomen', 'benefit payers: money in is income');
  assert.equal(c('Sociale Verzekeringsbank', 30000), 'inkomen');
  assert.equal(run({ rawName: 'SVB', amount: 30000 }).kind, 'elke-maand');
  assert.equal(c('Automaat Test', -2000, 'Geldautomaat'), 'dagelijks', 'cash by type');
  assert.equal(c('Oranjespaarrekening', 100), 'sparen', 'spaarrekening also inside a word');
  assert.equal(c('PayPal Europe'), 'eenmalig');
  assert.equal(run({ rawName: 'PayPal Europe', amount: -1000 }).kind, 'wisselend');
  assert.equal(c('Jumbo Test', 500), 'onbekend', 'money in from a shop: let the user choose');
});

test('a refund from a fixed-cost payee keeps the category but is eenmalig', () => {
  assert.deepEqual(run({ rawName: 'Zilveren Kruis', amount: 4500 }).kind, 'eenmalig');
  assert.deepEqual(run({ rawName: 'Zilveren Kruis', amount: 4500 }).categoryId, 'zorg');
  assert.deepEqual(run({ rawName: 'Zilveren Kruis', amount: -12000 }).kind, 'elke-maand');
  assert.deepEqual(run({ rawName: 'Eneco', amount: 9000 }).categoryId, 'vast');
});

test('default kind per category when no rule sets one', () => {
  const expected = {
    inkomen: 'elke-maand', huur: 'elke-maand', zorg: 'elke-maand', vast: 'elke-maand', dagelijks: 'wisselend',
    eenmalig: 'eenmalig', sparen: 'telt-niet-mee', onbekend: 'wisselend',
  };
  for (const [categoryId, kind] of Object.entries(expected)) {
    const s = state({ rules: [userRule({ nameContains: 'Test Ontvanger' }, { categoryId })] });
    assert.deepEqual(run({ rawName: 'Test Ontvanger', amount: -100 }, s), { categoryId, kind, name: 'Test Ontvanger', description: '' }, categoryId);
  }
});

test('user rules come first, newest first (createdAt, then position)', () => {
  const rules = [
    userRule({ nameContains: 'supermarkt' }, { categoryId: 'eenmalig' }, '2026-10-01T10:00:00.000Z'),
    userRule({ nameContains: 'SUPERMARKT 1234' }, { categoryId: 'vast' }, '2026-10-02T10:00:00.000Z'),
    userRule({ nameContains: 'supermarkt' }, { categoryId: 'huur' }, '2026-09-01T10:00:00.000Z'),
  ];
  assert.equal(run({ rawName: 'SUPERMARKT 1234 TESTDORP', amount: -500 }, state({ rules })).categoryId, 'vast');
  const sameTime = [
    userRule({ nameContains: 'supermarkt' }, { categoryId: 'eenmalig' }),
    userRule({ nameContains: 'supermarkt' }, { categoryId: 'huur' }),
  ];
  assert.equal(run({ rawName: 'SUPERMARKT 1234 TESTDORP', amount: -500 }, state({ rules: sameTime })).categoryId, 'huur');
  const userBeatsBuiltin = [userRule({ nameContains: 'Belastingdienst', sign: 'in' }, { categoryId: 'eenmalig', kind: 'eenmalig' })];
  assert.deepEqual(run({ rawName: 'Belastingdienst', amount: 11800 }, state({ rules: userBeatsBuiltin })), {
    categoryId: 'eenmalig', kind: 'eenmalig', name: 'Belastingdienst', description: '',
  });
});

test('a rule matches only when all its conditions hold; sign-only, empty and unknown conditions never match', () => {
  const r = (match) => run({ rawName: 'Huisbaas BV', rawDescription: 'Omschrijving: Huur november', amount: -105000, iban: 'NL00TEST0123456789' },
    state({ rules: [userRule(match, { categoryId: 'huur' })] })).categoryId;
  assert.equal(r({ nameContains: 'huisbaas' }), 'huur');
  assert.equal(r({ nameContains: 'Huisbaas', sign: 'out', bankCode: 'test' }), 'huur', 'bank code from the IBAN, any case');
  assert.equal(r({ nameContains: 'Huisbaas', sign: 'in' }), 'onbekend');
  assert.equal(r({ nameContains: 'Huisbaas', bankCode: 'INGB' }), 'onbekend');
  assert.equal(r({ descriptionContains: 'huur nov' }), 'huur', 'matched on the cleaned description');
  assert.equal(r({ descriptionContains: 'NL00TEST' }), 'onbekend', 'IBANs are not in the cleaned description');
  assert.equal(r({ sign: 'out' }), 'onbekend');
  assert.equal(r({}), 'onbekend');
  assert.equal(r({ nameContains: '   ' }), 'onbekend');
  assert.equal(r({ nameContains: 'Huisbaas', futureCondition: 'x' }), 'onbekend');
  const deleted = state({ rules: [userRule({ nameContains: 'Huisbaas' }, { categoryId: 'weg' })] });
  assert.equal(run({ rawName: 'Huisbaas BV', amount: -1 }, deleted).categoryId, 'onbekend', 'unknown category id is ignored');
});

test('rename rules: display name replaced; category rules match the old or the new name', () => {
  const rules = [
    userRule({ nameContains: 'SUPERMARKT 1234' }, { rename: 'Supermarkt' }, '2026-10-01T10:00:00.000Z'),
    userRule({ nameContains: 'Supermarkt', sign: 'out' }, { categoryId: 'eenmalig', kind: 'eenmalig' }, '2026-10-02T10:00:00.000Z'),
    userRule({ nameContains: 'Werkgever' }, { rename: 'Salaris' }, '2026-10-01T10:00:00.000Z'),
    userRule({ nameContains: 'Salaris', sign: 'in' }, { categoryId: 'inkomen' }, '2026-10-03T10:00:00.000Z'),
  ];
  assert.deepEqual(run({ rawName: 'SUPERMARKT 1234 TESTDORP', amount: -500 }, state({ rules })), {
    categoryId: 'eenmalig', kind: 'eenmalig', name: 'Supermarkt', description: '',
  });
  assert.deepEqual(run({ rawName: 'Werkgever Voorbeeld BV', amount: 131240 }, state({ rules })), {
    categoryId: 'inkomen', kind: 'elke-maand', name: 'Salaris', description: '',
  });
});

test('a kind-only rule sets the kind of whatever category was chosen', () => {
  const rules = [userRule({ nameContains: 'Kosten ING' }, { kind: 'wisselend' })];
  assert.deepEqual(run({ rawName: 'Kosten ING Go', amount: -295 }, state({ rules })), {
    categoryId: 'vast', kind: 'wisselend', name: 'Kosten ING Go', description: '',
  });
});

test('hidden words are removed from names and descriptions (whole words, any case); an empty name falls back to the type', () => {
  const s = state({ hiddenWords: ['Tester', 'van der Test'] });
  const c = run({ rawName: 'Hr T TESTER', rawDescription: 'Omschrijving: voor tester en Testerdam van der  Test', amount: 1000, type: 'Overschrijving' }, s);
  assert.equal(c.name, 'Hr T');
  assert.equal(c.description, 'voor en Testerdam');
  assert.equal(run({ rawName: 'tester', amount: 1000, type: 'Overschrijving' }, s).name, 'Overschrijving');
  assert.equal(run({ rawName: '', amount: 1000, type: '' }, s).name, 'Payment');
});

test('cleaning: no IBANs, ids or runs of 6+ digits in name or description', () => {
  const c = run({
    rawName: 'Naar Oranje spaarrekening X12345678',
    rawDescription: 'Omschrijving: Premie polis 99887766\nIBAN: NL00TEST0000000001\nKenmerk: 2026100000001',
    amount: -15000,
  });
  assert.equal(c.name, 'Naar Oranje spaarrekening X…');
  assert.equal(c.description, 'Premie polis …');
  assert.doesNotMatch(`${c.name} ${c.description}`, /\d{6,}|NL00/);
});

test('accepts a payment-shaped input too: {name, description, bankCode}', () => {
  const rules = [userRule({ nameContains: 'Huisbaas', bankCode: 'TEST' }, { categoryId: 'huur' })];
  assert.equal(cat.categorize({ name: 'Huisbaas BV', description: 'Huur', amount: -1, type: '', bankCode: 'TEST' }, state({ rules })).categoryId, 'huur');
});

test('ruleFromTx: category rules (by name, bank code, direction) and rename rules (no direction)', () => {
  const tx = { name: ' Huisbaas BV ', amount: -105000, bankCode: 'TEST', categoryId: 'huur', kind: 'elke-maand' };
  const byWord = plain(cat.ruleFromTx(tx, 'category'));
  assert.match(byWord.id, /^r_/);
  assert.ok(!Number.isNaN(Date.parse(byWord.createdAt)));
  assert.deepEqual({ match: byWord.match, set: byWord.set }, {
    match: { nameContains: 'Huisbaas BV', bankCode: 'TEST', sign: 'out' },
    set: { categoryId: 'huur', kind: 'elke-maand' },
  });
  const byObject = plain(cat.ruleFromTx({ ...tx, bankCode: '' }, { categoryId: 'huur', kind: 'elke-maand' }));
  assert.deepEqual(byObject.match, { nameContains: 'Huisbaas BV', sign: 'out' });
  const rename = plain(cat.ruleFromTx({ name: 'SUPERMARKT 1234 TESTDORP', amount: -500, bankCode: '' }, { rename: 'Supermarkt' }));
  assert.deepEqual({ match: rename.match, set: rename.set }, { match: { nameContains: 'SUPERMARKT 1234 TESTDORP' }, set: { rename: 'Supermarkt' } });
  const typeError = (err) => err.name === 'TypeError'; // thrown inside the vm realm
  assert.throws(() => cat.ruleFromTx(tx, {}), typeError);
  assert.throws(() => cat.ruleFromTx(tx, 'rename'), typeError);
});

test('glued card-terminal names: shop words also match at the start of a glued word', () => {
  const c = (rawName, amount = -1245) => run({ rawName, amount, type: 'Betaalautomaat' }).categoryId;
  assert.equal(c('ApotheekDeLinde NLD'), 'dagelijks');
  assert.equal(c('APOTHEEKDELINDE NLD'), 'dagelijks');
  assert.equal(c('DrogisterijTestdorp'), 'dagelijks');
  assert.equal(c('DrogistTest 0042'), 'dagelijks');
  assert.equal(c('SupermarktPlaza Test'), 'dagelijks');
  assert.equal(c('KruidvatTestdorp NLD'), 'dagelijks');
  assert.equal(c('Apotheek De Linde'), 'dagelijks', 'separate words still match');
  // False positives stay low: only at the START of a glued word, and only the unambiguous shop words.
  assert.equal(c('DeLindeApotheek NLD'), 'onbekend', 'not in the middle of a glued word');
  assert.equal(c('Streaming Plus Test'), 'onbekend', "'plus' only as the first word of the name");
  assert.equal(c('Plusmarkt Test'), 'onbekend', "'plus' never glued");
  assert.equal(c('Spartaan Test'), 'onbekend');
  assert.equal(c('Coopertest'), 'onbekend');
  assert.equal(c('Dirkzwager Test'), 'onbekend');
  assert.equal(c('ApotheekDeLinde NLD', 500), 'onbekend', 'money in from a shop: let the user choose');
});

test('rules match the raw bank name too: a rule learned before a word was hidden keeps working', () => {
  const rules = [userRule({ nameContains: 'Hr J. Testnaam', sign: 'in' }, { categoryId: 'inkomen', kind: 'elke-maand' })];
  const hidden = state({ rules, hiddenWords: ['Testnaam'] });
  const c = run({ rawName: 'Hr J. Testnaam', rawDescription: 'Omschrijving: bijdrage huishouden', amount: 50000, type: 'Overschrijving' }, hidden);
  assert.deepEqual(c, { categoryId: 'inkomen', kind: 'elke-maand', name: 'Hr J.', description: 'bijdrage huishouden' });
  // A rename rule matched on the raw name, and the cleaned name still works for rules made after hiding.
  const renamed = state({ hiddenWords: ['Testnaam'], rules: [
    userRule({ nameContains: 'testnaam' }, { rename: 'Bijdrage' }, '2026-10-01T10:00:00.000Z'),
    userRule({ nameContains: 'Bijdrage', sign: 'in' }, { categoryId: 'inkomen' }, '2026-10-02T10:00:00.000Z'),
  ] });
  assert.equal(run({ rawName: 'Hr J. Testnaam', amount: 50000 }, renamed).name, 'Bijdrage');
  assert.equal(run({ rawName: 'Hr J. Testnaam', amount: 50000 }, renamed).categoryId, 'inkomen');
  const after = state({ hiddenWords: ['Testnaam'], rules: [userRule({ nameContains: 'Hr J.', sign: 'in' }, { categoryId: 'eenmalig' })] });
  assert.equal(run({ rawName: 'Hr J. Testnaam', amount: 50000 }, after).categoryId, 'eenmalig');
  // The raw description is never matched (it still holds IBANs and ids).
  const byIban = state({ rules: [userRule({ descriptionContains: 'NL00TEST' }, { categoryId: 'huur' })] });
  assert.equal(run({ rawName: 'Huisbaas BV', rawDescription: 'IBAN: NL00TEST0123456789', amount: -1 }, byIban).categoryId, 'onbekend');
});

// ---- the account holder --------------------------------------------------------------------------------

const HOLDER = ['T. Tester', 'Teststraat 1', '1234 AB Voorbeeldstad'];
const SALT = '00112233445566778899aabbccddeeff';
const privacy = (lines = HOLDER, salt = SALT) => ({ salt, hashes: cat.hashTokens(cat.holderTokens(lines), salt) });
const strip = (text, lines = HOLDER, isName = false) => {
  const p = privacy(lines);
  return cat.stripPrivate(text, cat.privacyTest(p.salt, p.hashes), isName);
};
const clean = (text, lines = HOLDER, isName = false) => Budget.util.cleanDescription(strip(text, lines, isName));

test('holderTokens: surname, other name words, street, postcode and town; never initials or prefixes alone', () => {
  const tokens = (lines) => plain(cat.holderTokens(lines)).map((t) => `${t.kind}:${t.canon}`).sort();
  assert.deepEqual(tokens(HOLDER), ['name:tester', 'place:1234ab', 'place:voorbeeldstad', 'street:teststraat']);
  assert.deepEqual(tokens(['Hr T.J. van der Tester', 'Lange Teststraat 12 A', '1234AB VOORBEELDSTAD']),
    ['name:tester', 'name:van der tester', 'place:1234ab', 'place:voorbeeldstad', 'street:lange teststraat']);
  assert.deepEqual(tokens(['De heer Tom Tester en/of Mw. A.B. de Vries-Jansen', 'Teststraat 1-3', '1234 AB Den Testhaag']), [
    'name:de vries-jansen', 'name:jansen', 'name:tester', 'name:tom', 'name:vries', 'name:vries-jansen',
    'place:1234ab', 'place:den testhaag', 'street:teststraat']);
  assert.deepEqual(tokens(['Mw Ål Tëster', 'Postbus 123', '1234 AB Voorbeeldstad']),
    ['name:tester', 'place:1234ab', 'place:voorbeeldstad'], 'accents folded; "Al" is too short; Postbus is no street name');
  assert.deepEqual(tokens([]), []);
  assert.deepEqual(tokens(null), []);
});

test('hashTokens: salted SHA-256, kind digit + 32 hex, no plain text; another salt gives other hashes', () => {
  const a = plain(cat.hashTokens(cat.holderTokens(HOLDER), SALT));
  const b = plain(cat.hashTokens(cat.holderTokens(HOLDER), 'ffeeddccbbaa99887766554433221100'));
  assert.equal(a.length, 4);
  for (const h of a) assert.match(h, /^[123][0-9a-f]{32}$/);
  assert.equal(a.filter((h) => b.includes(h)).length, 0);
  assert.doesNotMatch(JSON.stringify(a), /tester|teststraat|voorbeeldstad|1234/i);
  assert.deepEqual(plain(cat.hashTokens(cat.holderTokens(HOLDER), null)), [], 'no salt, no hashes');
});

test('stripPrivate: every holder form seen on statements is removed (holder cases from the vm tests + real-statement forms)', () => {
  const cases = [
    ['Omschrijving: Termijnbedrag energie klantnummer 112233445 levering Teststraat 1 Voorbeeldstad stroom en gas', 'Termijnbedrag energie klantnummer … levering stroom en gas'],
    ['Omschrijving: levering Voorbeeldstad', 'levering'],
    ['Omschrijving: Huur oktober 2026 Teststraat 1A', 'Huur oktober 2026'],
    ['Omschrijving: Huur oktober 2026 Teststraat 1 A', 'Huur oktober 2026'],
    ['Omschrijving: Levering 1234AB Voorbeeldstad', 'Levering'],
    ['Omschrijving: Levering 1234 ab voorbeeldstad', 'Levering'],
    ['Teststraat 1, 1234 AB Voorbeeldstad, stroom', 'stroom'],
    ['Kinderopvangtoeslag 2027 (TESTER )', 'Kinderopvangtoeslag 2027'],
    ['Premie maart Tester T.', 'Premie maart'],
    ['Premie maart Tester, T.', 'Premie maart'],
    ['Salaris voor T. Tester', 'Salaris voor'],
    ['Toeslag Tëster', 'Toeslag', 'accents ignored'],
  ];
  for (const [text, expected, note] of cases) assert.equal(clean(text), expected, note || text);
  const names = [['T TESTER', ''], ['HR T TESTER', ''], ['Tester T.', ''], ['T. Tester', ''], ['Tom Tester', ''],
    ['Mw. A. van der Tester', ''], ['Gemeente Voorbeeldstad', 'Gemeente'], ['Tester Installatietechniek BV', 'Installatietechniek BV']];
  for (const [name, expected] of names) assert.equal(clean(name, HOLDER, true), expected, name);
});

test('stripPrivate: whole words only, short tokens and prefixes never alone, nothing else changes', () => {
  const kept = ['Testers en Teststraatje', 'Voorbeeldstadion Test', 'T. de Vries', 'van der Berg', 'Teststraat1', '1234 ABC',
    'Huur 1 AB', 'SUPERMARKT 1234 TESTDORP', 'Kosten ING Go', ''];
  for (const text of kept) assert.equal(strip(text), text, text);
  assert.equal(strip('Huur (Teststraat 1)'), 'Huur', 'empty brackets go');
  // A surname with a prefix: the prefix only goes together with the surname.
  const lines = ['T. van der Tester', 'Teststraat 1', '1234 AB Voorbeeldstad'];
  assert.equal(clean('Betaling aan T. VAN DER TESTER', lines), 'Betaling aan');
  assert.equal(clean('Van der Berg bv', lines), 'Van der Berg bv');
  assert.equal(strip('Tester', HOLDER, false), '', 'a description that is only the surname');
  assert.equal(cat.stripPrivate('Tester', null), 'Tester', 'no hashes: nothing to strip');
});

test('categorize with holder hashes: names and descriptions cleaned, empty names fall back to the type', () => {
  const s = state();
  s.settings.privacySalt = SALT;
  s.settings.privateTokenHashes = privacy().hashes;
  assert.deepEqual(run({ rawName: 'HR T TESTER', rawDescription: 'Omschrijving: Sparen Teststraat 1A', amount: -10000, type: 'Online bankieren' }, s),
    { categoryId: 'onbekend', kind: 'wisselend', name: 'Online bankieren', description: 'Sparen' });
  // options.privacy wins over the state's (the importer passes the file's holder too).
  const empty = state();
  assert.equal(cat.categorize({ rawName: 'Tom Tester', amount: -1, type: 'Overschrijving' }, empty, { privacy: privacy() }).name, 'Overschrijving');
  assert.equal(cat.categorize({ rawName: 'Tom Tester', amount: -1, type: 'Overschrijving' }, empty).name, 'Tom Tester');
});

test('recleanState: re-applies hidden words, holder hashes and masking to every payment; counts changes', () => {
  const tx = (name, description, extra = {}) => ({ id: `t_${name}`, date: '2026-09-01', month: '2026-09', name, description,
    amount: -100, categoryId: 'onbekend', kind: 'wisselend', type: 'Overschrijving', bankCode: '', source: 'csv', fingerprint: '', ...extra });
  const draft = state({ hiddenWords: ['Testnaam'] });
  draft.transactions = [
    tx('Hr J. Testnaam', 'bijdrage huishouden'),
    tx('T TESTER', 'Huur Teststraat 1A'),
    tx('Webwinkel Test', 'XQZ743QK0RLRHFYX0'),
    tx('Huisbaas BV', 'Huur oktober'),
    tx('Testnaam', '', { type: '' }),
  ];
  draft.settings.privacySalt = SALT;
  draft.settings.privateTokenHashes = privacy().hashes;
  assert.equal(cat.recleanState(draft), 4);
  assert.deepEqual(draft.transactions.map((t) => [t.name, t.description]), [
    ['Hr J.', 'bijdrage huishouden'],
    ['Overschrijving', 'Huur'],
    ['Webwinkel Test', '…'],
    ['Huisbaas BV', 'Huur oktober'],
    ['Payment', ''],
  ]);
  assert.equal(cat.recleanState(draft), 0, 'running it again changes nothing');
  assert.equal(cat.recleanState(state()), 0);
});

test('ruleFromTx -> next import of the same payee is categorized by that rule', () => {
  const first = run({ rawName: 'Huisbaas BV', amount: -105000, iban: 'NL00TEST0123456789' });
  assert.equal(first.categoryId, 'onbekend');
  const tx = { name: first.name, amount: -105000, bankCode: 'TEST', categoryId: 'huur', kind: 'elke-maand' };
  const rules = [plain(cat.ruleFromTx(tx, 'category'))];
  assert.deepEqual(run({ rawName: 'Huisbaas BV', amount: -105000, iban: 'NL00TEST0123456789' }, state({ rules })), {
    categoryId: 'huur', kind: 'elke-maand', name: 'Huisbaas BV', description: '',
  });
  assert.equal(run({ rawName: 'Huisbaas BV', amount: 5000, iban: 'NL00TEST0123456789' }, state({ rules })).categoryId, 'onbekend', 'money in is another case');
});
