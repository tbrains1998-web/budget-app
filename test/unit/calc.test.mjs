// Unit tests for src/js/calc.js (Budget.calc). util.js and calc.js run as classic scripts in a vm context.
// All payees and amounts are fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ TextEncoder });
for (const f of ['util.js', 'calc.js']) {
  vm.runInContext(readFileSync(new URL(`../../src/js/${f}`, import.meta.url), 'utf8'), context, { filename: f });
}
const { calc, util } = context.Budget;
const plain = (v) => JSON.parse(JSON.stringify(v));
const pid = (name) => util.payeeId(name);
const nk = (side, name) => `${side}:${pid(name)}`; // normalAmounts key of a payee by its (bank) name

const CATEGORIES = [
  { id: 'inkomen', name: 'Inkomen', kind: 'income' },
  { id: 'huur', name: 'Huur', kind: 'fixed' },
  { id: 'zorg', name: 'Zorg & verzekering', kind: 'fixed' },
  { id: 'vast', name: 'Fixed costs & subscriptions', kind: 'fixed' },
  { id: 'dagelijks', name: 'Daily spending', kind: 'daily' },
  { id: 'eenmalig', name: 'Eenmalig', kind: 'oneoff' },
  { id: 'sparen', name: 'Sparen & eigen rekeningen', kind: 'transfer' },
  { id: 'onbekend', name: 'Not sorted yet (?)', kind: 'unknown' },
];
const DEFAULT_KIND = { inkomen: 'elke-maand', huur: 'elke-maand', zorg: 'elke-maand', vast: 'elke-maand',
  dagelijks: 'wisselend', eenmalig: 'eenmalig', sparen: 'telt-niet-mee', onbekend: 'wisselend' };

let nextId = 0;
function tx(date, amount, categoryId, name, extra = {}) {
  return { id: `t_${++nextId}`, date, month: date.slice(0, 7), name, description: '', amount, categoryId,
    kind: DEFAULT_KIND[categoryId] || 'wisselend', type: 'Incasso', bankCode: '', source: 'pdf', fingerprint: '', ...extra };
}

function makeState({ transactions = [], statements = [], normalAmounts = {}, savingsGoal = 0 } = {}) {
  return { version: 1, categories: CATEGORIES, transactions, statements, rules: [], normalAmounts,
    settings: { savingsGoal, hiddenWords: [], lastBackupAt: null, lastImportAt: null } };
}

function statement(month, startBalance, endBalance, extra = {}) {
  return { month, periodFrom: `${month}-01`, periodTo: `${month}-28`, startBalance, endBalance, totalIn: null,
    totalOut: null, source: 'pdf', importedAt: '2026-11-01T10:00:00.000Z', ...extra };
}

const RECAP_ROWS = ['normalIncome', 'extraIncome', 'fixed', 'daily', 'oneoff', 'unknown', 'paidForOtherMonth',
  'paidInEarlierMonth', 'paidInLaterMonth', 'transfersNet', 'notViaBank'];
const rowSum = (r) => RECAP_ROWS.reduce((sum, k) => sum + r[k], 0);
const bankSum = (state, month) => state.transactions
  .filter((t) => t.date.slice(0, 7) === month && t.source !== 'hand').reduce((sum, t) => sum + t.amount, 0);

// Two months of fake data. Rent is paid on the last day of the month for the NEXT month (moved), the income
// payee pays twice in October, savings go to an own account (doesn't count), one cash payment added by hand.
function twoMonths(normalAmounts = { [nk('in', 'Uitkering BV')]: 100000 }) {
  const transactions = [
    tx('2026-09-01', 100000, 'inkomen', 'Uitkering BV'),
    tx('2026-09-02', -60000, 'huur', 'Huisbaas BV'),
    tx('2026-09-05', -12000, 'zorg', 'Zorgverzekeraar X'),
    tx('2026-09-10', -8000, 'dagelijks', 'SUPERMARKT 1234 PLAATS'),
    tx('2026-09-12', -1500, 'dagelijks', 'Markt (contant)', { source: 'hand', type: '' }),
    tx('2026-09-15', -10000, 'sparen', 'Naar Oranje spaarrekening X00000001'),
    tx('2026-09-20', -2500, 'onbekend', 'Onbekende BV'),
    tx('2026-09-25', -3000, 'eenmalig', 'Webwinkel'),
    tx('2026-09-30', -60000, 'huur', 'Huisbaas BV', { month: '2026-10' }),
    tx('2026-10-01', 90000, 'inkomen', 'Uitkering BV'),
    tx('2026-10-15', 15000, 'inkomen', 'Uitkering BV'),
    tx('2026-10-05', -12000, 'zorg', 'Zorgverzekeraar X'),
    tx('2026-10-10', -9000, 'dagelijks', 'SUPERMARKT 1234 PLAATS'),
    tx('2026-10-12', 5000, 'sparen', 'Van Oranje spaarrekening X00000001'),
    tx('2026-10-31', -60000, 'huur', 'Huisbaas BV', { month: '2026-11' }),
  ];
  return makeState({
    transactions,
    statements: [statement('2026-09', 100000, 44500), statement('2026-10', 44500, 73500)],
    normalAmounts,
  });
}

test('empty state: everything zero / null / empty, no crash', () => {
  const s = makeState();
  assert.deepEqual(plain(calc.monthsWithData(s)), []);
  const sum = calc.monthSummary(s, '2026-09');
  assert.deepEqual(plain({ ...sum, byCategory: undefined }), { income: 0, fixed: 0, daily: 0, oneoff: 0, transfer: 0,
    unknown: 0, unknownIn: 0, unknownOut: 0, left: 0, rows: [], otherRows: [] });
  assert.deepEqual(plain(Object.values(sum.byCategory)), [0, 0, 0, 0, 0, 0, 0, 0]);
  const recap = calc.monthRecap(s, '2026-09');
  assert.equal(recap.startBalance, null);
  assert.equal(recap.endBalance, null);
  assert.equal(recap.statementCheck, null);
  assert.equal(recap.change, 0);
  for (const k of RECAP_ROWS) assert.ok(Object.is(recap[k], 0), k);
  assert.deepEqual(plain(calc.normalMonth(s)), { items: [], income: 0, fixed: 0, dailyAvg: 0, save: 0, saveRounded: 0 });
  assert.deepEqual(plain(calc.alerts(s, '2026-09')), []);
  assert.equal(calc.goalProgress(s, '2026-09'), null);
  assert.deepEqual(plain(calc.bookedMonths(s)), []);
  assert.equal(calc.latestBookedMonth(s), null);
  assert.equal(calc.isBookedMonth(s, '2026-09'), false);
});

test('monthsWithData: oldest first, includes moved-to months and statement months', () => {
  const s = twoMonths();
  s.statements.push(statement('2026-07', 0, 0));
  assert.deepEqual(plain(calc.monthsWithData(s)), ['2026-07', '2026-09', '2026-10', '2026-11']);
});

test('bookedMonths / latestBookedMonth / isBookedMonth: a month with only a moved payment is not booked', () => {
  const s = twoMonths();
  // November only holds the rent paid on 31 October and moved there: the app must not open on it.
  assert.deepEqual(plain(calc.monthsWithData(s)), ['2026-09', '2026-10', '2026-11']);
  assert.deepEqual(plain(calc.bookedMonths(s)), ['2026-09', '2026-10']);
  assert.equal(calc.latestBookedMonth(s), '2026-10');
  assert.equal(calc.isBookedMonth(s, '2026-10'), true);
  assert.equal(calc.isBookedMonth(s, '2026-11'), false);
  assert.equal(calc.monthSummary(s, '2026-11').income, 0, 'that month would show € 0 income and a Short tile');
  // A statement alone makes a month booked; hand-added payments alone do not.
  s.statements.push(statement('2026-12', 73500, 73500));
  s.transactions.push(tx('2027-01-05', -500, 'dagelijks', 'Markt', { source: 'hand' }));
  assert.deepEqual(plain(calc.bookedMonths(s)), ['2026-09', '2026-10', '2026-12']);
  assert.equal(calc.latestBookedMonth(s), '2026-12');
  // Nothing imported at all: the newest month with any data.
  const handOnly = makeState({ transactions: [tx('2026-05-01', -100, 'dagelijks', 'Markt', { source: 'hand' }),
    tx('2026-06-01', -100, 'dagelijks', 'Markt', { source: 'hand', month: '2026-07' })] });
  assert.deepEqual(plain(calc.bookedMonths(handOnly)), []);
  assert.equal(calc.latestBookedMonth(handOnly), '2026-07');
});

test('monthSummary: counted payments only; moved payment counts in its target month', () => {
  const s = twoMonths();
  const sep = calc.monthSummary(s, '2026-09');
  assert.equal(sep.income, 100000);
  assert.equal(sep.fixed, -72000);
  assert.equal(sep.daily, -9500);
  assert.equal(sep.oneoff, -3000);
  assert.equal(sep.unknown, -2500);
  assert.equal(sep.transfer, 0, 'savings are telt-niet-mee');
  assert.equal(sep.left, 100000 - 72000 - 9500 - 3000 - 2500);
  assert.equal(sep.byCategory.huur, -60000, 'the rent paid on 30 sep is not in september');
  assert.equal(sep.rows.length, 7);
  assert.deepEqual(plain(sep.otherRows.map((t) => t.name)), ['Huisbaas BV', 'Naar Oranje spaarrekening X00000001']);
  assert.ok(sep.rows.every((t, i, a) => i === 0 || a[i - 1].date >= t.date), 'newest first');

  const oct = calc.monthSummary(s, '2026-10');
  assert.equal(oct.byCategory.huur, -60000, 'rent paid 30 sep counts in october');
  assert.equal(oct.income, 105000);
  assert.equal(oct.fixed, -72000);
  const nov = calc.monthSummary(s, '2026-11');
  assert.equal(nov.fixed, -60000);
  assert.equal(nov.left, -60000);
});

test('monthSummary: unknownIn / unknownOut split the Not sorted yet payments', () => {
  const s = makeState({ transactions: [
    tx('2026-09-01', 25000, 'onbekend', 'Iemand'),
    tx('2026-09-02', 1000, 'onbekend', 'Iemand anders'),
    tx('2026-09-03', -4000, 'onbekend', 'Winkel'),
    tx('2026-09-04', -700, 'bestaat-niet', 'Oud'), // unknown category id counts as onbekend
    tx('2026-09-05', -900, 'onbekend', 'Spaarpot', { kind: 'telt-niet-mee' }), // not counted
    tx('2026-08-05', 5000, 'onbekend', 'Vorige maand'),
  ] });
  const sum = calc.monthSummary(s, '2026-09');
  assert.equal(sum.unknownIn, 26000);
  assert.equal(sum.unknownOut, -4700);
  assert.equal(sum.unknown, sum.unknownIn + sum.unknownOut);
  assert.ok(Object.is(calc.monthSummary(s, '2026-07').unknownOut, 0));
});

test('monthSummary: a counted payment in a transfer category is in transfer, not in left', () => {
  const s = makeState({ transactions: [tx('2026-09-01', 50000, 'inkomen', 'Werkgever'),
    tx('2026-09-02', -10000, 'sparen', 'Spaarpot', { kind: 'elke-maand' })] });
  const sum = calc.monthSummary(s, '2026-09');
  assert.equal(sum.transfer, -10000);
  assert.equal(sum.left, 50000);
});

test('monthSummary: unknown category ids count as onbekend', () => {
  const s = makeState({ transactions: [tx('2026-09-01', -700, 'bestaat-niet', 'Iets')] });
  const sum = calc.monthSummary(s, '2026-09');
  assert.equal(sum.unknown, -700);
  assert.equal(sum.byCategory.onbekend, -700);
});

test('monthRecap: both months reconcile with their statements, moved rent in the right rows', () => {
  const s = twoMonths();
  const sep = calc.monthRecap(s, '2026-09');
  assert.deepEqual(plain(sep), {
    startBalance: 100000,
    normalIncome: 100000,
    extraIncome: 0,
    fixed: -72000,
    daily: -9500,
    oneoff: -3000,
    unknown: -2500,
    paidForOtherMonth: -60000,
    paidInEarlierMonth: 0,
    paidInLaterMonth: 0,
    transfersNet: -10000,
    notViaBank: 1500,
    change: -55500,
    endBalance: 44500,
    statementCheck: { ok: true, diff: 0 },
  });
  const oct = calc.monthRecap(s, '2026-10');
  assert.deepEqual(plain(oct), {
    startBalance: 44500,
    normalIncome: 100000,
    extraIncome: 5000,
    fixed: -72000,
    daily: -9000,
    oneoff: 0,
    unknown: 0,
    paidForOtherMonth: -60000,
    paidInEarlierMonth: 60000,
    paidInLaterMonth: 0,
    transfersNet: 5000,
    notViaBank: 0,
    change: 29000,
    endBalance: 73500,
    statementCheck: { ok: true, diff: 0 },
  });
  for (const r of [sep, oct]) assert.equal(r.startBalance + rowSum(r), r.endBalance);
});

test('monthRecap: two payments of one payee use the normal amount once; less than normal gives negative extra', () => {
  const higher = calc.monthRecap(twoMonths({ [nk('in', 'Uitkering BV')]: 100000 }), '2026-10');
  assert.equal(higher.normalIncome, 100000);
  assert.equal(higher.extraIncome, 5000);
  const lower = calc.monthRecap(twoMonths({ [nk('in', 'Uitkering BV')]: 110000 }), '2026-10');
  assert.equal(lower.normalIncome, 110000);
  assert.equal(lower.extraIncome, -5000, 'Minder dan normaal');
  assert.equal(lower.statementCheck.ok, true);
  const noNormal = calc.monthRecap(twoMonths({}), '2026-10');
  assert.equal(noNormal.normalIncome, 105000, 'without a normal amount the actual total is normal');
  assert.equal(noNormal.extraIncome, 0);
  const negativeStored = calc.monthRecap(twoMonths({ [nk('in', 'Uitkering BV')]: -100000 }), '2026-10');
  assert.equal(negativeStored.normalIncome, 100000, 'the stored value is a magnitude; the side gives the sign');
});

test('monthRecap: non-regular income is extra; the payee id comes from the trimmed, lowercased name', () => {
  const s = makeState({
    transactions: [
      tx('2026-09-01', 80000, 'inkomen', '  Uitkering BV '),
      tx('2026-09-20', 4500, 'inkomen', 'Belastingdienst', { kind: 'eenmalig' }),
    ],
    normalAmounts: { [nk('in', 'Uitkering BV')]: 75000 },
  });
  const r = calc.monthRecap(s, '2026-09');
  assert.equal(r.normalIncome, 75000);
  assert.equal(r.extraIncome, 5000 + 4500);
  assert.equal(calc.payeeKey('  Uitkering BV '), 'uitkering bv', 'payeeKey still gives the comparable name');
  assert.equal(calc.normalKey('in', 'p_0123456789abcdef'), 'in:p_0123456789abcdef');
  assert.equal(calc.payeeIdOf({ name: 'X', payeeId: 'p_0123456789abcdef' }), 'p_0123456789abcdef');
  assert.equal(calc.payeeIdOf({ name: ' X ' }), pid('x'));
});

test('monthRecap: paid in a LATER month and moved back is "paidInLaterMonth", not "earlier"', () => {
  const s = makeState({
    transactions: [tx('2026-10-03', -60000, 'huur', 'Huisbaas BV', { month: '2026-09' })],
    statements: [statement('2026-09', 1000, 1000), statement('2026-10', 1000, -59000)],
  });
  const sep = calc.monthRecap(s, '2026-09');
  assert.equal(sep.fixed, -60000);
  assert.equal(sep.paidInLaterMonth, 60000);
  assert.equal(sep.paidInEarlierMonth, 0);
  assert.equal(sep.statementCheck.ok, true);
  const oct = calc.monthRecap(s, '2026-10');
  assert.equal(oct.paidForOtherMonth, -60000);
  assert.equal(oct.statementCheck.ok, true);
  // Both directions in one month.
  const both = makeState({ transactions: [
    tx('2026-08-30', -60000, 'huur', 'Huisbaas BV', { month: '2026-09' }),
    tx('2026-10-02', -12000, 'zorg', 'Zorg X', { month: '2026-09' }),
  ] });
  const r = calc.monthRecap(both, '2026-09');
  assert.equal(r.paidInEarlierMonth, 60000);
  assert.equal(r.paidInLaterMonth, 12000);
  assert.equal(rowSum(r), 0, 'nothing was booked in september');
});

test('monthRecap: telt-niet-mee moved to another month only shows where it was booked', () => {
  const s = makeState({ transactions: [tx('2026-09-30', -5000, 'sparen', 'Spaarpot', { month: '2026-10' })] });
  assert.equal(calc.monthRecap(s, '2026-09').transfersNet, -5000);
  assert.equal(calc.monthRecap(s, '2026-09').paidForOtherMonth, 0);
  assert.equal(calc.monthRecap(s, '2026-10').change, 0);
});

test('monthRecap: mismatch with the statement is reported with the difference', () => {
  const s = twoMonths();
  s.transactions = s.transactions.filter((t) => t.name !== 'Webwinkel');
  const sep = calc.monthRecap(s, '2026-09');
  assert.equal(sep.statementCheck.ok, false);
  assert.equal(sep.statementCheck.diff, 3000, 'app counts € 30 more than the bank');
  assert.equal(sep.endBalance, 44500, 'end balance is the bank figure');
});

test('monthRecap: no statement -> balances null; PDF statement preferred; statements without balances ignored', () => {
  const s = twoMonths();
  assert.equal(calc.monthRecap(s, '2026-11').statementCheck, null);
  assert.equal(calc.monthRecap(s, '2026-11').startBalance, null);
  s.statements = [
    statement('2026-09', 0, 0, { source: 'csv', importedAt: '2026-12-01T00:00:00.000Z' }),
    statement('2026-09', 100000, 44500),
    statement('2026-09', null, null, { source: 'pdf', importedAt: '2026-12-02T00:00:00.000Z' }),
  ];
  const r = calc.monthRecap(s, '2026-09');
  assert.equal(r.startBalance, 100000);
  assert.equal(r.statementCheck.ok, true);
});

test('monthRecap reconciles for random data (moved, telt-niet-mee, hand, unknown, all categories)', () => {
  let seed = 42;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const kinds = ['elke-maand', 'wisselend', 'eenmalig', 'telt-niet-mee'];
  const months = ['2026-08', '2026-09', '2026-10'];
  for (let round = 0; round < 50; round++) {
    const transactions = [];
    for (let i = 0; i < 60; i++) {
      const date = `${months[rand(3)]}-${String(1 + rand(28)).padStart(2, '0')}`;
      const cat = CATEGORIES[rand(CATEGORIES.length)].id;
      const moved = rand(5) === 0 ? months[rand(3)] : date.slice(0, 7);
      transactions.push(tx(date, rand(200001) - 100000, cat, `Payee ${rand(6)}`,
        { month: moved, kind: kinds[rand(4)], source: rand(6) === 0 ? 'hand' : 'csv' }));
    }
    const s = makeState({ transactions, normalAmounts: { [nk('in', 'Payee 1')]: 12345, [nk('uit', 'Payee 2')]: -500 } });
    for (const m of months) {
      const r = calc.monthRecap(s, m);
      assert.equal(rowSum(r), r.change);
      assert.equal(r.change, bankSum(s, m), `round ${round} ${m}`);
    }
  }
});

test('normalMonth: items, custom normal, dailyAvg, save rounded down to € 5', () => {
  const nm = calc.normalMonth(twoMonths());
  assert.deepEqual(plain(nm.items), [
    { key: nk('in', 'Uitkering BV'), payeeId: pid('Uitkering BV'), side: 'in', name: 'Uitkering BV', categoryId: 'inkomen',
      normal: 100000, lastActual: 105000, lastCount: 2, custom: true },
    { key: nk('uit', 'Huisbaas BV'), payeeId: pid('Huisbaas BV'), side: 'uit', name: 'Huisbaas BV', categoryId: 'huur',
      normal: -60000, lastActual: -60000, lastCount: 1, custom: false },
    { key: nk('uit', 'Zorgverzekeraar X'), payeeId: pid('Zorgverzekeraar X'), side: 'uit', name: 'Zorgverzekeraar X', categoryId: 'zorg',
      normal: -12000, lastActual: -12000, lastCount: 1, custom: false },
  ]);
  assert.equal(nm.income, 100000);
  assert.equal(nm.fixed, -72000);
  assert.equal(nm.dailyAvg, -9250, 'september (incl. cash) and october; november only has moved rent');
  assert.equal(nm.save, 18750);
  assert.equal(nm.saveRounded, 18500);
});

test('normalMonth: the example numbers give "Ongeveer € 345"', () => {
  const s = makeState({
    transactions: [
      tx('2026-07-01', 120000, 'inkomen', 'Werkgever'),
      tx('2026-07-02', -61000, 'huur', 'Huisbaas BV'),
      tx('2026-07-10', -24050, 'dagelijks', 'Supermarkt'),
    ],
  });
  const nm = calc.normalMonth(s);
  assert.equal(nm.income, 120000);
  assert.equal(nm.fixed, -61000);
  assert.equal(nm.dailyAvg, -24050);
  assert.equal(nm.save, 34950);
  assert.equal(nm.saveRounded, 34500);
});

test('normalMonth: dailyAvg uses up to the last 3 booked months and rounds to whole cents', () => {
  const s = makeState({
    transactions: [
      tx('2026-06-10', -99999, 'dagelijks', 'Supermarkt'),
      tx('2026-07-10', -1000, 'dagelijks', 'Supermarkt'),
      tx('2026-08-10', -1000, 'dagelijks', 'Supermarkt'),
      tx('2026-09-10', -1001, 'dagelijks', 'Supermarkt'),
      tx('2026-12-24', -50000, 'dagelijks', 'Markt (contant)', { source: 'hand' }),
    ],
  });
  assert.equal(calc.normalMonth(s).dailyAvg, -1000, 'jun dropped, (−1000 −1000 −1001)/3 rounds to −1000; hand-only dec ignored');
});

test('normalMonth: only payees seen in the last 2 booked months; elke-maand income/fixed only', () => {
  const s = makeState({
    transactions: [
      tx('2026-07-01', -2000, 'vast', 'Oud Abonnement'),
      tx('2026-08-01', 80000, 'inkomen', 'Uitkering BV'),
      tx('2026-09-03', -1500, 'vast', 'Telecom X'),
      tx('2026-09-04', -900, 'vast', 'Energie wisselend', { kind: 'wisselend' }),
      tx('2026-09-05', -4000, 'dagelijks', 'Supermarkt', { kind: 'elke-maand' }),
      tx('2026-09-06', -10000, 'sparen', 'Spaarpot', { kind: 'elke-maand' }),
    ],
  });
  const nm = calc.normalMonth(s);
  assert.deepEqual(plain(nm.items.map((i) => i.name)), ['Uitkering BV', 'Telecom X'],
    'missed september payment still listed (seen in august); july payee dropped');
  assert.equal(nm.income, 80000);
  assert.equal(nm.fixed, -1500);
});

test('normalMonth: a cost typed without minus still counts as a cost; the side decides the sign', () => {
  const s = twoMonths({ [nk('uit', 'Huisbaas BV')]: 65000, [nk('in', 'Uitkering BV')]: -100000 });
  const nm = calc.normalMonth(s);
  assert.equal(nm.items.find((i) => i.name === 'Huisbaas BV').normal, -65000);
  assert.equal(nm.items.find((i) => i.name === 'Uitkering BV').normal, 100000);
  assert.equal(calc.monthRecap(s, '2026-10').normalIncome, 100000);
});

test('payee identity (i): "Only this one" rename keeps one payee (grouped by payeeId, names joined)', () => {
  const id = pid('Werkgever Voorbeeld BV');
  const s = makeState({
    transactions: [
      tx('2026-08-25', 131240, 'inkomen', 'Werkgever Voorbeeld BV', { payeeId: id }),
      tx('2026-09-25', 131240, 'inkomen', 'Salaris', { payeeId: id }), // renamed "Only this one"
    ],
    normalAmounts: { [`in:${id}`]: 130000 },
  });
  const nm = calc.normalMonth(s);
  assert.equal(nm.items.length, 1, 'one payee, not two');
  assert.equal(nm.items[0].name, 'Salaris', 'the name of its latest month');
  assert.equal(nm.income, 130000, 'counted once');
  // Two different names in the latest month: both shown.
  s.transactions.push(tx('2026-09-28', 1000, 'inkomen', 'Werkgever Voorbeeld BV', { payeeId: id }));
  const joined = calc.normalMonth(s).items[0];
  assert.equal(joined.name, 'Werkgever Voorbeeld BV + Salaris');
  assert.equal(joined.lastCount, 2);
  assert.equal(joined.lastActual, 132240);
});

test('payee identity (ii): hidden words changed the name in later months, still one payee', () => {
  const id = pid('Hr J. Testnaam'); // the raw bank name both months
  const s = makeState({
    transactions: [
      tx('2026-09-15', 50000, 'inkomen', 'Hr J. Testnaam', { payeeId: id }),
      tx('2026-10-15', 50000, 'inkomen', 'Hr J.', { payeeId: id }), // after "Hide words: Testnaam"
    ],
  });
  const nm = calc.normalMonth(s);
  assert.equal(nm.items.length, 1);
  assert.equal(nm.income, 50000, 'the normal income is not counted twice');
});

test('payee identity (iii): one payee with monthly income AND a monthly fixed payment gives two items', () => {
  const id = pid('Belastingdienst');
  const t = (date, amount, categoryId) => tx(date, amount, categoryId, 'Belastingdienst', { payeeId: id });
  const s = makeState({
    transactions: [
      t('2026-05-25', 90000, 'inkomen'), t('2026-05-03', -5000, 'vast'),
      t('2026-06-25', 90000, 'inkomen'), t('2026-06-03', -5000, 'vast'),
    ],
  });
  let nm = calc.normalMonth(s);
  assert.deepEqual(plain(nm.items.map((i) => [i.key, i.side, i.normal, i.lastActual])),
    [[`in:${id}`, 'in', 90000, 90000], [`uit:${id}`, 'uit', -5000, -5000]]);
  assert.equal(nm.income, 90000);
  assert.equal(nm.fixed, -5000, 'the repayment stays in the plan');
  // The UI stores magnitudes: typing 900 for both still gives + income and − cost.
  s.normalAmounts = { [`in:${id}`]: 90000, [`uit:${id}`]: 90000 };
  nm = calc.normalMonth(s);
  assert.equal(nm.income, 90000);
  assert.equal(nm.fixed, -90000);
  // A big one-off repayment kept as elke maand in 'vast' never flips the income sign.
  const big = makeState({
    transactions: [t('2026-04-25', 90000, 'inkomen'), t('2026-05-25', 90000, 'inkomen'), t('2026-06-25', 90000, 'inkomen'),
      t('2026-06-10', -300000, 'vast')],
    normalAmounts: { [`in:${id}`]: 90000 },
  });
  const may = calc.monthRecap(big, '2026-05');
  assert.equal(may.normalIncome, 90000);
  assert.equal(may.extraIncome, 0);
  const bigPlan = calc.normalMonth(big);
  assert.equal(bigPlan.income, 90000, 'normal income stays positive');
  assert.equal(bigPlan.fixed, -300000);
});

test('normalMonth: negative save rounds down (more negative) to a multiple of 500', () => {
  const s = makeState({ transactions: [tx('2026-09-01', 50000, 'inkomen', 'Werk'), tx('2026-09-02', -60100, 'huur', 'Huisbaas BV')] });
  const nm = calc.normalMonth(s);
  assert.equal(nm.save, -10100);
  assert.equal(nm.saveRounded, -10500);
});

test('normalMonth: when nothing was imported, hand-added months count', () => {
  const s = makeState({ transactions: [tx('2026-09-01', 50000, 'inkomen', 'Werk', { source: 'hand' }),
    tx('2026-09-05', -3000, 'dagelijks', 'Markt', { source: 'hand' })] });
  const nm = calc.normalMonth(s);
  assert.equal(nm.income, 50000);
  assert.equal(nm.dailyAvg, -3000);
});

function alertState(previousDaily, nowDaily, extra = []) {
  const months = ['2026-06', '2026-07', '2026-08', '2026-09'].slice(4 - previousDaily.length - 1);
  const transactions = [...previousDaily, nowDaily].map((amount, i) => tx(`${months[i]}-10`, -amount, 'dagelijks', 'Supermarkt'));
  return makeState({ transactions: [...transactions, ...extra] });
}

test('alerts: > 25 % above the average and at least € 10 more, signed like transactions', () => {
  assert.deepEqual(plain(calc.alerts(alertState([20000, 20000], 30000), '2026-09')),
    [{ categoryId: 'dagelijks', amount: -30000, average: -20000, diff: 10000 }]);
  assert.deepEqual(plain(calc.alerts(alertState([20000, 20000], 25000), '2026-09')), [], 'exactly 25 % is not more');
  assert.equal(calc.alerts(alertState([20000, 20000], 25001), '2026-09').length, 1);
  assert.deepEqual(plain(calc.alerts(alertState([2000, 2000], 2999), '2026-09')), [], '50 % but less than € 10');
  assert.equal(calc.alerts(alertState([2000, 2000], 3000), '2026-09').length, 1, 'exactly € 10 more');
  assert.equal(calc.alerts(alertState([0, 0], 1000), '2026-09').length, 1, 'nothing before, € 10 now');
});

test('alerts: needs at least 2 earlier booked months; earlier months only', () => {
  assert.deepEqual(plain(calc.alerts(alertState([20000], 90000), '2026-09')), []);
  const s = alertState([20000, 20000, 20000], 20000);
  assert.deepEqual(plain(calc.alerts(s, '2026-07')), [], 'only june is earlier');
  s.transactions.push(tx('2026-10-01', -60000, 'huur', 'Huisbaas BV', { source: 'hand' }));
  assert.deepEqual(plain(calc.alerts(s, '2026-09')), [], 'later months never count');
});

test('alerts: spending categories only, never onbekend, income or transfers; spending only, not net', () => {
  const extra = [
    tx('2026-07-01', 10000, 'inkomen', 'Werk'), tx('2026-08-01', 10000, 'inkomen', 'Werk'), tx('2026-09-01', 90000, 'inkomen', 'Werk'),
    tx('2026-09-02', -90000, 'sparen', 'Spaarpot', { kind: 'elke-maand' }),
    tx('2026-09-03', -5000, 'onbekend', 'Onbekende BV'), // was an alert before: Not sorted yet is not spending yet
    tx('2026-09-04', 8000, 'eenmalig', 'Retour webwinkel'),
  ];
  assert.deepEqual(plain(calc.alerts(alertState([1000, 1000], 1000, extra), '2026-09')), []);
  // T1 #4: earlier unknown money IN (net positive) must not make a normal month look far "higher than normal".
  const t1 = alertState([1000, 1000], 1000, [
    tx('2026-07-05', 150000, 'onbekend', 'Iemand'), tx('2026-08-05', 150000, 'onbekend', 'Iemand'),
    tx('2026-09-05', -2000, 'onbekend', 'Winkel'),
  ]);
  assert.deepEqual(plain(calc.alerts(t1, '2026-09')), []);
  // A refund in an earlier month does not lower that month's spending (net would say € 0 spent before).
  const refund = alertState([1000, 1000], 1000, [
    tx('2026-07-06', -20000, 'eenmalig', 'Webwinkel'), tx('2026-07-07', 20000, 'eenmalig', 'Webwinkel retour'),
    tx('2026-08-06', -20000, 'eenmalig', 'Webwinkel'), tx('2026-08-07', 20000, 'eenmalig', 'Webwinkel retour'),
    tx('2026-09-06', -21000, 'eenmalig', 'Webwinkel'),
  ]);
  assert.deepEqual(plain(calc.alerts(refund, '2026-09')), [], '€ 210 now vs € 200 spent before: < 25 % more');
  const refundNow = alertState([1000, 1000], 1000, [
    tx('2026-07-06', -10000, 'vast', 'Energie'), tx('2026-08-06', -10000, 'vast', 'Energie'),
    tx('2026-09-06', -20000, 'vast', 'Energie'), tx('2026-09-07', 15000, 'vast', 'Energie terug'),
  ]);
  assert.deepEqual(plain(calc.alerts(refundNow, '2026-09')), [{ categoryId: 'vast', amount: -20000, average: -10000, diff: 10000 }],
    'this month: € 200 spent, the refund does not hide it');
});

test('alerts: average over months with data includes months where the category was 0', () => {
  const s = alertState([30000, 0], 20000, [tx('2026-08-01', 100, 'inkomen', 'Rente')]);
  assert.deepEqual(plain(calc.alerts(s, '2026-09')), [{ categoryId: 'dagelijks', amount: -20000, average: -15000, diff: 5000 }]);
});

test('goalProgress', () => {
  const base = { transactions: [tx('2026-09-01', 50000, 'inkomen', 'Werk'), tx('2026-09-02', -32000, 'huur', 'Huisbaas BV')] };
  assert.equal(calc.goalProgress(makeState(base), '2026-09'), null);
  assert.deepEqual(plain(calc.goalProgress(makeState({ ...base, savingsGoal: 30000 }), '2026-09')), { goal: 30000, left: 18000, pct: 60 });
  assert.deepEqual(plain(calc.goalProgress(makeState({ ...base, savingsGoal: 12000 }), '2026-09')), { goal: 12000, left: 18000, pct: 150 });
  assert.deepEqual(plain(calc.goalProgress(makeState({ ...base, savingsGoal: 30000 }), '2026-10')), { goal: 30000, left: 0, pct: 0 });
  const short = makeState({ transactions: [tx('2026-09-02', -5000, 'huur', 'Huisbaas BV')], savingsGoal: 30000 });
  assert.deepEqual(plain(calc.goalProgress(short, '2026-09')), { goal: 30000, left: -5000, pct: 0 });
});

test('calc never mutates the state', () => {
  const s = twoMonths();
  const frozen = JSON.stringify(s);
  const deepFreeze = (v) => {
    if (v && typeof v === 'object') {
      Object.freeze(v);
      Object.values(v).forEach(deepFreeze);
    }
    return v;
  };
  deepFreeze(s);
  for (const m of ['2026-09', '2026-10', '2026-11']) {
    calc.monthSummary(s, m);
    calc.monthRecap(s, m);
    calc.alerts(s, m);
    calc.goalProgress(s, m);
    calc.isBookedMonth(s, m);
  }
  calc.normalMonth(s);
  calc.monthsWithData(s);
  calc.bookedMonths(s);
  calc.latestBookedMonth(s);
  assert.equal(JSON.stringify(s), frozen);
});
