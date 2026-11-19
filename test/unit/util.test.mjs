// Unit tests for src/js/util.js (Budget.util), loaded as a classic script in a vm context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SRC = new URL('../../src/js/util.js', import.meta.url);

function loadUtil(globals = {}) {
  const context = vm.createContext({ TextEncoder, ...globals });
  vm.runInContext(readFileSync(SRC, 'utf8'), context, { filename: 'util.js' });
  return context.Budget.util;
}

const util = loadUtil({ crypto: globalThis.crypto });
const MINUS = '−';
const WJ = '⁠'; // invisible word joiner after a sign
const E = '€'; // formatEuro writes no space after €
const NEG = `${MINUS}${WJ}${E}`; // "−€"
const POS = `+${WJ}${E}`; // "+€"

test('formatEuro: €1,234.56 format, U+2212 minus, sign and whole options; no space after €, U+2060 after a sign', () => {
  const cases = [
    [123456, {}, `${E}1,234.56`],
    [0, {}, `${E}0.00`],
    [5, {}, `${E}0.05`],
    [100, {}, `${E}1.00`],
    [-1250, {}, `${NEG}12.50`],
    [100000000, {}, `${E}1,000,000.00`],
    [-123456789, {}, `${NEG}1,234,567.89`],
    [1250, { sign: true }, `${POS}12.50`],
    [-1250, { sign: true }, `${NEG}12.50`],
    [0, { sign: true }, `${E}0.00`],
    [34500, { whole: true }, `${E}345`],
    [34950, { whole: true }, `${E}350`],
    [34949, { whole: true }, `${E}349`],
    [-34950, { whole: true }, `${NEG}350`],
    [-40, { whole: true }, `${E}0`],
    [40, { whole: true, sign: true }, `${E}0`],
    [120000, { whole: true, sign: true }, `${POS}1,200`],
    [-0, {}, `${E}0.00`],
    [1234.6, {}, `${E}12.35`],
    [Number.NaN, {}, `${E}0.00`],
    [undefined, {}, `${E}0.00`],
  ];
  for (const [cents, opts, expected] of cases) {
    assert.equal(util.formatEuro(cents, opts), expected, `${cents} ${JSON.stringify(opts)}`);
  }
  assert.equal(util.formatEuro(1250), '€12.50', 'options are optional');
  assert.equal(util.formatEuro(-1250), '−⁠€12.50', 'the exact characters');
  for (const cents of [0, 1250, -1250, 123456789]) {
    assert.doesNotMatch(util.formatEuro(cents, { sign: true }), / /, 'no ordinary space a line could break at');
    assert.doesNotMatch(util.formatEuro(cents, { whole: true }), / /);
  }
});

test('parseEuro: accepted inputs', () => {
  const cases = [
    ['12,50', 1250],
    ['12.50', 1250],
    ['12,5', 1250],
    ['12', 1200],
    ['0', 0],
    ['0,05', 5],
    [',50', 50],
    ['1.234,56', 123456],
    ['1,234.56', 123456],
    ['1.234', 123400],
    ['1,234', 123400],
    ['1.234.567,89', 123456789],
    ['1,234,567.89', 123456789],
    ['1234,56', 123456],
    ['1234.56', 123456],
    ['-12,50', -1250],
    [`${MINUS}12,50`, -1250],
    ['+12,50', 1250],
    ['€ 12', 1200],
    ['€12,50', 1250],
    ['-€ 12,50', -1250],
    ['€ -12,50', -1250],
    [`${MINUS}€ 1.234,56`, -123456],
    ['  12 , 50  ', 1250],
    ['1 234,56', 123456],
    [' 12,50 ', 1250],
    ['EUR 12,50', 1250],
    ['12 euro', 1200],
    ['12,-', 1200],
    ['-0', 0],
    ['€ 12,50', 1250],
    ['−⁠€ 1.234,56', -123456],
    ['+⁠€ 12,50', 1250],
    ['1 234,56', 123456],
    [' 12,50 ', 1250],
  ];
  for (const [input, expected] of cases) {
    assert.equal(util.parseEuro(input), expected, JSON.stringify(input));
  }
  assert.ok(Object.is(util.parseEuro('-0'), 0), 'no negative zero');
});

test('parseEuro: invalid inputs return null', () => {
  for (const input of ['', '   ', 'abc', '12a', '1.2.3', '12.', '1,2,3', '1.23.456', '1234.567', '12,345,67',
    '--12', '12-', '1.234,567', '1,234.5.6', '€', '.', null, undefined, '99999999999999999']) {
    assert.equal(util.parseEuro(input), null, JSON.stringify(input));
  }
});

test('formatEuro and parseEuro round-trip', () => {
  for (const cents of [0, 1, 99, 100, 1250, -1250, 123456, -987654321]) {
    assert.equal(util.parseEuro(util.formatEuro(cents)), cents);
    assert.equal(util.parseEuro(util.formatEuro(cents, { sign: true })), cents);
  }
});

test('monthOf, monthLabel, shortDate', () => {
  assert.equal(util.monthOf('2026-09-29'), '2026-09');
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
    'November', 'December'];
  months.forEach((name, i) => assert.equal(util.monthLabel(`2026-${String(i + 1).padStart(2, '0')}`), `${name} 2026`));
  assert.equal(util.shortDate('2026-09-29'), '29 Sep');
  assert.equal(util.shortDate('2026-03-01'), '1 Mar');
  assert.equal(util.shortDate('2026-10-05'), '5 Oct');
  assert.equal(util.shortDate('2026-05-31'), '31 May');
  assert.equal(util.monthLabel('2026-13'), '2026-13', 'invalid month returned unchanged');
  assert.equal(util.shortDate('nope'), 'nope');
  assert.equal(util.monthLabel(undefined), '');
});

test('longDate: weekday, day, month and year in English, never shifted by the time zone', () => {
  assert.equal(util.longDate('2026-10-01'), 'Thursday 1 October 2026');
  assert.equal(util.longDate('2026-10-25'), 'Sunday 25 October 2026');
  assert.equal(util.longDate('2028-02-29'), 'Tuesday 29 February 2028');
  assert.equal(util.longDate('2027-01-04'), 'Monday 4 January 2027');
  assert.equal(util.longDate('2026-02-30'), '2026-02-30', 'invalid date returned unchanged');
  assert.equal(util.longDate(undefined), '');
});

test('todayIso: the date on the PC\'s own clock (its local time zone), at any time of day', () => {
  assert.equal(util.todayIso(new Date(2026, 9, 25, 0, 30)), '2026-10-25'); // 00:30 local
  assert.equal(util.todayIso(new Date(2026, 9, 24, 23, 59)), '2026-10-24'); // 23:59 local
  assert.equal(util.todayIso(new Date(2027, 0, 1, 0, 1)), '2027-01-01'); // new year, winter time
  assert.equal(util.todayIso(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  assert.match(util.todayIso(), /^\d{4}-\d{2}-\d{2}$/);
  // The same instant is another day in another time zone: todayIso follows the zone of the process it runs in.
  const instants = ['2026-10-24T22:30:00Z', '2026-12-31T23:30:00Z'];
  const expected = { UTC: '2026-10-24 2026-12-31', 'Asia/Tokyo': '2026-10-25 2027-01-01', 'America/Los_Angeles': '2026-10-24 2026-12-31' };
  for (const [zone, want] of Object.entries(expected)) {
    const out = spawnSync(process.execPath, ['-e', `const vm = require('node:vm'); const c = vm.createContext({ TextEncoder });
      vm.runInContext(require('node:fs').readFileSync(${JSON.stringify(fileURLToPath(SRC))}, 'utf8'), c);
      process.stdout.write(${JSON.stringify(instants)}.map((d) => c.Budget.util.todayIso(new Date(d))).join(' '));`],
    { env: { ...process.env, TZ: zone }, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, want, zone);
  }
});

test('parseDateNl: Dutch ways of typing a date; impossible dates are refused', () => {
  const good = {
    '1-10-2026': '2026-10-01', '01-10-2026': '2026-10-01', '1/10/2026': '2026-10-01', '1.10.2026': '2026-10-01',
    '2026-10-01': '2026-10-01', ' 31-12-2026 ': '2026-12-31', '29-2-2028': '2028-02-29', '2026-1-5': '2026-01-05',
  };
  for (const [input, expected] of Object.entries(good)) assert.equal(util.parseDateNl(input), expected, input);
  for (const input of ['31-9-2026', '29-2-2027', '0-10-2026', '1-13-2026', '1-10/2026', '1-10-26', '2026/10/01',
    'gisteren', '', null, undefined, '1 oktober 2026', '2026-10-01T00:00']) {
    assert.equal(util.parseDateNl(input), null, String(input));
  }
});

test('payeeId: p_ + FNV-1a 64 of the lowercased, trimmed name', () => {
  assert.equal(util.payeeId('  Huisbaas BV '), `p_${util.fnv1a64('huisbaas bv')}`);
  assert.equal(util.payeeId('HUISBAAS BV'), util.payeeId('huisbaas bv'));
  assert.notEqual(util.payeeId('Huisbaas BV'), util.payeeId('Huisbaas B.V.'));
  assert.match(util.payeeId(''), /^p_[0-9a-f]{16}$/);
  assert.match(util.payeeId(null), /^p_[0-9a-f]{16}$/);
});

test('sha256Hex: synchronous SHA-256, same as node:crypto (also for long and non-ASCII text)', () => {
  const samples = ['', 'abc', '€ ünïcode ✓', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'q'.repeat(1000)];
  for (let i = 0; i < 200; i++) samples.push(randomBytes(i).toString('base64'));
  for (const s of samples) assert.equal(util.sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s.slice(0, 20)));
});

test('randomHex: hex of the asked length, different each time, also without crypto', () => {
  assert.match(util.randomHex(16), /^[0-9a-f]{32}$/);
  assert.notEqual(util.randomHex(16), util.randomHex(16));
  assert.match(loadUtil().randomHex(8), /^[0-9a-f]{16}$/);
});

test('isValidDate / isValidMonth', () => {
  assert.ok(util.isValidDate('2026-02-28'));
  assert.ok(util.isValidDate('2028-02-29'), 'leap year');
  assert.ok(!util.isValidDate('2026-02-29'));
  assert.ok(!util.isValidDate('2026-13-01'));
  assert.ok(!util.isValidDate('2026-09-31'));
  assert.ok(!util.isValidDate('29-09-2026'));
  assert.ok(!util.isValidDate(20260929));
  assert.ok(util.isValidMonth('2026-12'));
  assert.ok(!util.isValidMonth('2026-00'));
  assert.ok(!util.isValidMonth('2026-9'));
});

test('addMonths handles year boundaries in both directions', () => {
  assert.equal(util.addMonths('2026-12', 1), '2027-01');
  assert.equal(util.addMonths('2026-01', -1), '2025-12');
  assert.equal(util.addMonths('2026-09', 0), '2026-09');
  assert.equal(util.addMonths('2026-09', 13), '2027-10');
  assert.equal(util.addMonths('2026-09', -21), '2024-12');
  assert.equal(util.addMonths('2026-11', 2), '2027-01');
  assert.throws(() => util.addMonths('2026-13', 1), (err) => err.name === 'TypeError');
});

test('uid: prefix and uniqueness', () => {
  const ids = new Set(Array.from({ length: 2000 }, () => util.uid('t')));
  assert.equal(ids.size, 2000);
  for (const id of ids) assert.match(id, /^t_[0-9a-z]+$/);
  assert.match(loadUtil().uid('r'), /^r_[0-9a-z]+$/, 'works without crypto');
});

test('hash: SHA-256 hex when crypto.subtle exists', async () => {
  const expected = createHash('sha256').update('2026-09-29|-19645|Zorgverzekeraar X|Premie okt|Incasso').digest('hex');
  const result = util.hash('2026-09-29|-19645|Zorgverzekeraar X|Premie okt|Incasso');
  assert.equal(typeof result.then, 'function', 'returns a promise');
  assert.equal(await result, expected);
  assert.equal(await util.hash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('hash: FNV-1a 64 fallback without crypto.subtle or when digest fails', async () => {
  const noCrypto = loadUtil();
  assert.equal(await noCrypto.hash(''), 'cbf29ce484222325');
  assert.equal(await noCrypto.hash('a'), 'af63dc4c8601ec8c');
  assert.equal(await noCrypto.hash('foobar'), '85944171f73967e8');
  assert.equal(noCrypto.fnv1a64('foobar'), '85944171f73967e8');
  const failing = loadUtil({ crypto: { subtle: { digest: () => Promise.reject(new Error('SecurityError')) } } });
  assert.equal(await failing.hash('foobar'), '85944171f73967e8');
  assert.match(await noCrypto.hash('€ ünïcode'), /^[0-9a-f]{16}$/);
});

test('cleanDescription: ING CSV "Mededelingen" with all id fields', () => {
  const raw = 'Naam: Huisbaas BV Omschrijving: Huur oktober 2026 IBAN: NL00TEST0123456789 Kenmerk: 2026100012345678 '
    + 'Machtiging ID: MDT-0001 Incassant ID: NL00ZZZ000000000000 Doorlopende incasso Valutadatum: 01-10-2026';
  assert.equal(util.cleanDescription(raw), 'Huur oktober 2026');
});

test('cleanDescription: multi-line PDF description', () => {
  const raw = [
    'Omschrijving: Premie basisverzekering',
    'periode 01-10-2026 - 01-11-2026',
    'IBAN: NL00TEST0123456789',
    'Kenmerk: 123456789012',
    'Machtiging ID: ABC123456',
    'Incassant ID: NL00ZZZ123456780000',
    'Doorlopende incasso',
    'Valutadatum: 01-10-2026',
  ].join('\n');
  assert.equal(util.cleanDescription(raw), 'Premie basisverzekering periode 01-10-2026 - 01-11-2026');
});

test('cleanDescription: card payment details are removed', () => {
  const raw = 'Pasvolgnr: 003 14-05-2026 10:12\r\nTransactie: A00012 Term: XX000000\r\nApple Pay\r\nValutadatum: 14-05-2026';
  assert.equal(util.cleanDescription(raw), 'Apple Pay');
  assert.equal(util.cleanDescription('Datum/Tijd: 14-05-2026 10:12:33 Pasvolgnr: 003'), '');
  assert.equal(util.cleanDescription('Relatienummer 123456789'), '');
  assert.equal(util.cleanDescription('Tijd: 10:12 Datum: 14-05-2026'), '');
});

test('cleanDescription: masks digit runs, strips loose IBANs, keeps normal words', () => {
  assert.equal(util.cleanDescription('Factuur 1234567 klantnr 98765'), 'Factuur … klantnr 98765');
  assert.equal(util.cleanDescription('Terugbetaling NL00 TEST 0123 4567 89 lening'), 'Terugbetaling lening');
  assert.equal(util.cleanDescription('Termijn 3 van 12'), 'Termijn 3 van 12', '"Term" only as a label');
  assert.equal(util.cleanDescription('Betalingskenmerk 12345'), 'Betalingskenmerk 12345');
  assert.equal(util.cleanDescription('  veel   spaties \t en\n regels  '), 'veel spaties en regels');
  assert.equal(util.cleanDescription('omschrijving: kleine letters kenmerk: abc'), 'kleine letters');
  assert.equal(util.cleanDescription(null), '');
  assert.equal(util.cleanDescription(undefined), '');
  assert.ok(!/\d{6,}/.test(util.cleanDescription('Order 2026000123 en 99999999')));
});

test('cleanDescription: random reference codes are masked; dates, amounts and normal words are kept', () => {
  assert.equal(util.cleanDescription('XQZ743QK0RLRHFYX0'), '…', 'a 17-character reference without a 6-digit run');
  assert.equal(util.cleanDescription('Omschrijving: XQZ743QK0RLRHFYX0'), '…');
  assert.equal(util.cleanDescription('Betaling ABCD1234EFGH voor les'), 'Betaling … voor les');
  assert.equal(util.cleanDescription('Ref 7Q9X2K4M'), 'Ref …', 'exactly 8 characters, 4 digits');
  for (const kept of ['Factuur 2026-0456 op 01-10-2026 bedrag € 1.234,56 termijn 3', 'Windows10Pro iPhone15 PS5 A00012 1234AB Termijnbedrag']) {
    assert.equal(util.cleanDescription(kept), kept, 'dates, amounts, < 3 digits, < 8 characters and plain words stay');
  }
  assert.equal(util.cleanDescription('Naar Oranje spaarrekening X12345678'), 'Naar Oranje spaarrekening X…', 'digit runs are masked first');
  assert.equal(util.cleanDescription(util.cleanDescription('Ref XQZ743QK0RLRHFYX0 en 99887766')), 'Ref … en …', 'idempotent');
});

test('cleanDescription: at most 80 characters, cut at a word and marked with …', () => {
  const long = 'Bestelling met een hele lange omschrijving die maar doorgaat en doorgaat en nog veel langer is dan nodig';
  const result = util.cleanDescription(long);
  assert.ok(result.length <= 80, `${result.length}`);
  assert.ok(result.endsWith('…'));
  assert.ok(long.startsWith(result.slice(0, -1)));
  assert.ok(!result.slice(0, -1).endsWith(' '));
  const noSpaces = 'x'.repeat(200);
  assert.equal(util.cleanDescription(noSpaces).length, 80);
  assert.equal(util.cleanDescription('kort'), 'kort');
});

test('bankCodeFromIban', () => {
  assert.equal(util.bankCodeFromIban('NL00INGB0000000000'), 'INGB');
  assert.equal(util.bankCodeFromIban('nl00 revo 0123 4567 89'), 'REVO');
  assert.equal(util.bankCodeFromIban('NL00TEST0123456789'), 'TEST');
  assert.equal(util.bankCodeFromIban('BE00123456789012'), '', 'numeric bank code');
  assert.equal(util.bankCodeFromIban(''), '');
  assert.equal(util.bankCodeFromIban(null), '');
  assert.equal(util.bankCodeFromIban('INGB'), '');
});
