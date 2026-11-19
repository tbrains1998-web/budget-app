// Unit tests for the clickable tiles: Budget.calc.tileBreakdown and the pure popup helpers of
// src/js/ui-month.js (Budget.uiMonth.helpers). util.js, store.js, calc.js, ui-kit.js and ui-month.js run as classic
// scripts in a vm context without a DOM. All payees and amounts are fake (and the demo seed is fake).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const context = vm.createContext({ TextEncoder });
for (const f of ['util.js', 'calc.js', 'ui-kit.js', 'ui-month.js']) {
  vm.runInContext(read(`../../src/js/${f}`), context, { filename: f });
}
const { calc, util, uiMonth } = context.Budget;
const h = uiMonth.helpers;
const plain = (v) => JSON.parse(JSON.stringify(v));
const WJ = String.fromCharCode(0x2060); // formatEuro: word joiner after a sign

const CATEGORIES = [
  { id: 'inkomen', name: 'Income', kind: 'income' },
  { id: 'huur', name: 'Rent', kind: 'fixed' },
  { id: 'zorg', name: 'Health & insurance', kind: 'fixed' },
  { id: 'vast', name: 'Fixed costs & subscriptions', kind: 'fixed' },
  { id: 'dagelijks', name: 'Daily spending', kind: 'daily' },
  { id: 'eenmalig', name: 'One-off', kind: 'oneoff' },
  { id: 'sparen', name: 'Savings & own accounts', kind: 'transfer' },
  { id: 'onbekend', name: 'Not sorted yet (?)', kind: 'unknown' },
];
const DEFAULT_KIND = { inkomen: 'elke-maand', huur: 'elke-maand', zorg: 'elke-maand', vast: 'elke-maand',
  dagelijks: 'wisselend', eenmalig: 'eenmalig', sparen: 'telt-niet-mee', onbekend: 'wisselend' };
const SECTIONS = ['income', 'fixed', 'daily', 'oneoff', 'unknown'];

let nextId = 0;
function tx(date, amount, categoryId, name, extra = {}) {
  return { id: `t_${++nextId}`, date, month: date.slice(0, 7), name, description: '', amount, categoryId,
    kind: DEFAULT_KIND[categoryId] || 'wisselend', type: 'Incasso', bankCode: '', source: 'pdf', fingerprint: '', ...extra };
}

function makeState(transactions = [], statements = []) {
  return { version: 1, categories: CATEGORIES, transactions, statements, rules: [], normalAmounts: {},
    settings: { savingsGoal: 0, hiddenWords: [], lastBackupAt: null, lastImportAt: null } };
}

const sum = (list, f = (x) => x) => list.reduce((a, x) => a + f(x), 0);

/** The numbers the five tiles show, computed from monthSummary, in the tiles' own sense. */
function tileNumbers(state, month) {
  const s = calc.monthSummary(state, month);
  return { income: s.income, fixed: -s.fixed + 0, daily: -s.daily + 0, oneoff: -s.oneoff + 0, left: s.left, unknown: s.unknown };
}

/**
 * Everything that must hold for one month: each popup total = its tile in cents (and = the sum of its lines and of
 * its payments), the Left sum adds up to the Left tile, nothing counted is lost or counted twice.
 */
function assertReconciles(state, month, tag) {
  const b = calc.tileBreakdown(state, month);
  const tiles = tileNumbers(state, month);
  const s = calc.monthSummary(state, month);
  for (const key of SECTIONS) {
    const sec = b[key];
    assert.equal(sec.total, tiles[key], `${tag} ${key}: popup total = tile`);
    assert.equal(sec.total, sec.dir * sec.amount + 0, `${tag} ${key}: total = dir × amount`);
    assert.equal(sum(sec.payees, (p) => p.total), sec.total, `${tag} ${key}: Σ payee lines = total`);
    assert.equal(sec.moneyIn + sec.moneyOut, sec.amount, `${tag} ${key}: in + out = amount`);
    assert.equal(sum(sec.payees, (p) => p.count), sec.count, `${tag} ${key}: payment count`);
    for (const p of sec.payees) {
      assert.equal(sum(p.payments, (x) => x.value), p.total, `${tag} ${key} ${p.name}: Σ payments = payee total`);
      assert.equal(sum(p.payments, (x) => x.amount), p.amount, `${tag} ${key} ${p.name}: Σ amounts`);
      for (const x of p.payments) {
        assert.equal(x.countsIn, month, `${tag}: a counted payment counts in this month`);
        assert.equal(x.value, sec.dir * x.amount + 0, `${tag}: value = dir × amount`);
        assert.equal(x.paidIn, util.monthOf(x.date) !== x.countsIn ? util.monthOf(x.date) : null, `${tag}: paidIn = the month paid when it is not the month it counts for`);
      }
    }
    for (const x of sec.elsewhere) {
      assert.notEqual(x.countsIn, month, `${tag}: an elsewhere payment counts in another month`);
      assert.equal(util.monthOf(x.date), month, `${tag}: an elsewhere payment was paid in this month`);
      assert.equal(x.paidIn, month, `${tag}: an elsewhere payment has paidIn = the month it was paid`);
    }
    assert.equal(h.tileEmptyText(sec), sec.elsewhere.length ? 'No payments that count in this month.' : 'No payments in this month.', `${tag} ${key}: empty text`);
  }
  assert.equal(b.unknown.moneyIn, s.unknownIn, `${tag}: Not sorted yet money in = monthSummary.unknownIn`);
  assert.equal(b.unknown.moneyOut, s.unknownOut, `${tag}: Not sorted yet money out = monthSummary.unknownOut`);
  assert.equal(b.left.total, tiles.left, `${tag}: Left total = Left tile`);
  assert.equal(sum(b.left.parts, (p) => p.amount), b.left.total, `${tag}: Left parts add up`);
  const over = h.overSum(b);
  assert.equal(over.total, tiles.left, `${tag}: Left popup total = tile`);
  assert.equal(sum(over.lines, (l) => l.amount), tiles.left, `${tag}: Left popup lines add up to the tile`);
  assert.deepEqual(plain(over.lines.map((l) => l.key)).slice(0, 4), ['income', 'fixed', 'daily', 'oneoff'], `${tag}: Left lines order`);
  assert.equal(over.lines.some((l) => l.key === 'unknown'), Boolean(s.unknownIn || s.unknownOut), `${tag}: Not sorted yet line only when not zero`);
  // Every counted payment is in exactly one section; payments that do not count are only in notCounted / elsewhere.
  const counted = state.transactions.filter((t) => t.month === month && t.kind !== 'telt-niet-mee');
  const ids = SECTIONS.flatMap((k) => b[k].payees.flatMap((p) => p.payments.map((x) => x.id)));
  assert.equal(new Set(ids).size, ids.length, `${tag}: no payment twice`);
  const kinds = new Map(CATEGORIES.map((c) => [c.id, c.kind]));
  assert.deepEqual(plain(ids).sort(), counted.filter((t) => kinds.get(t.categoryId) !== 'transfer').map((t) => t.id).sort(), `${tag}: every counted payment once`);
  const recap = calc.monthRecap(state, month);
  assert.equal(b.left.notCounted.amount, recap.transfersNet, `${tag}: notCounted = the recap's transfersNet`);
  const movedTransfers = state.transactions.filter((t) => util.monthOf(t.date) === month && t.month !== month && t.kind !== 'telt-niet-mee' && kinds.get(t.categoryId) === 'transfer');
  assert.equal(sum(SECTIONS.flatMap((k) => b[k].elsewhere), (x) => x.amount) + sum(movedTransfers, (t) => t.amount), recap.paidForOtherMonth,
    `${tag}: the elsewhere notes = the recap's "paid for another month" (transfers aside)`);
  return b;
}

test('tileBreakdown: one line per name, biggest first; totals are the tile numbers', () => {
  const s = makeState([
    tx('2026-09-25', 131240, 'inkomen', 'Werkgever BV'),
    tx('2026-09-02', 45000, 'inkomen', 'Uitkering'),
    tx('2026-09-16', 45000, 'inkomen', 'uitkering '),
    tx('2026-09-29', -105000, 'huur', 'Huisbaas BV'),
    tx('2026-09-05', -19645, 'zorg', 'Zorgverzekeraar NV'),
    tx('2026-09-28', -295, 'vast', 'Kosten ING Go'),
    tx('2026-09-10', -5000, 'dagelijks', 'Supermarkt'),
    tx('2026-09-20', -7000, 'dagelijks', 'Supermarkt'),
    tx('2026-09-21', 1500, 'dagelijks', 'Supermarkt'),
    tx('2026-09-12', -2499, 'eenmalig', 'PayPal'),
    tx('2026-09-30', -15000, 'sparen', 'Naar Oranje spaarrekening'),
  ]);
  const b = assertReconciles(s, '2026-09', 'sep');
  assert.deepEqual(plain(b.income.payees.map((p) => [p.name, p.total, p.count])), [['Werkgever BV', 131240, 1], ['uitkering', 90000, 2]]);
  assert.equal(b.income.payees[1].name, 'uitkering', 'the name of the newest payment, trimmed');
  assert.deepEqual(plain(b.fixed.payees.map((p) => [p.categoryId, p.name, p.total])), [['huur', 'Huisbaas BV', 105000], ['zorg', 'Zorgverzekeraar NV', 19645], ['vast', 'Kosten ING Go', 295]]);
  assert.equal(b.fixed.total, 124940);
  const shop = b.daily.payees[0];
  assert.deepEqual(plain(shop.payments.map((x) => [x.date, x.amount, x.value])), [['2026-09-21', 1500, -1500], ['2026-09-20', -7000, 7000], ['2026-09-10', -5000, 5000]], 'newest first; money back is negative');
  assert.equal(b.daily.total, 10500);
  assert.equal(b.oneoff.total, 2499);
  assert.equal(b.unknown.total, 0);
  assert.deepEqual(plain(b.left), { total: 221240 - 124940 - 10500 - 2499, parts: [
    { key: 'income', amount: 221240 }, { key: 'fixed', amount: -124940 }, { key: 'daily', amount: -10500 }, { key: 'oneoff', amount: -2499 }, { key: 'unknown', amount: 0 },
  ], notCounted: { amount: -15000, count: 1 } });
  const pay = b.fixed.payees[0].payments[0];
  assert.deepEqual(plain(pay), { id: pay.id, date: '2026-09-29', name: 'Huisbaas BV', description: '', amount: -105000, value: 105000,
    kind: 'elke-maand', categoryId: 'huur', paidIn: null, countsIn: '2026-09' });
});

test('tileBreakdown: same name in two categories of one tile = two lines (each with its own colour)', () => {
  const s = makeState([tx('2026-09-01', -1000, 'zorg', 'Gemeente'), tx('2026-09-02', -3000, 'vast', 'gemeente')]);
  const b = assertReconciles(s, '2026-09', 'two categories');
  assert.deepEqual(plain(b.fixed.payees.map((p) => [p.categoryId, p.name])), [['vast', 'gemeente'], ['zorg', 'Gemeente']]);
});

test('moved payment: not in the month it was paid (grey note), in the month it counts for ("paid 27 Sep")', () => {
  const s = makeState([
    tx('2026-09-27', -15000, 'huur', 'Stephan', { month: '2026-10' }),
    tx('2026-09-29', -105000, 'huur', 'Huisbaas BV'),
    tx('2026-10-03', -8000, 'dagelijks', 'Markt'),
    tx('2026-12-30', 50000, 'inkomen', 'Werkgever BV', { month: '2027-01' }),
  ]);
  const sep = assertReconciles(s, '2026-09', 'sep');
  assert.equal(sep.fixed.total, 105000, 'paid in September, counts in October: not in September\'s total');
  assert.deepEqual(plain(sep.fixed.payees.map((p) => p.name)), ['Huisbaas BV']);
  assert.deepEqual(plain(sep.fixed.elsewhere.map((x) => [x.name, x.date, x.value, x.countsIn])), [['Stephan', '2026-09-27', 15000, '2026-10']]);
  assert.equal(h.elsewhereText('fixed', sep.fixed.elsewhere[0]), `27 Sep · Stephan · €150.00 — counts in October 2026`);
  assert.equal(sep.fixed.elsewhere[0].paidIn, '2026-09', 'the same payment has the same paidIn in both months');
  assert.deepEqual(plain(h.paymentTags('fixed', sep.fixed.elsewhere[0])), ['paid 27 Sep'], 'so tagging an elsewhere item keeps its label');
  const oct = assertReconciles(s, '2026-10', 'oct');
  assert.equal(oct.fixed.total, 15000);
  const moved = oct.fixed.payees[0].payments[0];
  assert.equal(moved.paidIn, '2026-09');
  assert.deepEqual(plain(h.paymentTags('fixed', moved)), ['paid 27 Sep']);
  assert.deepEqual(plain(oct.fixed.elsewhere), []);
  const jan = assertReconciles(s, '2027-01', 'jan (a month that only holds a moved payment)');
  assert.equal(jan.income.total, 50000);
  assert.deepEqual(plain(h.paymentTags('income', jan.income.payees[0].payments[0])), ['paid 30 Dec']);
  const dec = assertReconciles(s, '2026-12', 'dec');
  assert.equal(dec.income.total, 0);
  assert.equal(h.elsewhereText('income', dec.income.elsewhere[0]), `30 Dec · Werkgever BV · €500.00 — counts in January 2027`);
  assert.equal(h.tileEmptyText(dec.income), 'No payments that count in this month.', 'not "no payments" above a note dated in this month');
  assert.equal(h.tileEmptyText(dec.fixed), 'No payments in this month.');
});

test('a "doesn\'t count" payment is never in a tile, nor an elsewhere note; it is in the Left note', () => {
  const s = makeState([
    tx('2026-09-15', -10000, 'sparen', 'Naar spaarrekening'),
    tx('2026-09-16', 5000, 'sparen', 'Van spaarrekening', { kind: 'wisselend' }), // counted kind, transfer category
    tx('2026-09-17', -2000, 'dagelijks', 'Terugbetaling vriend', { kind: 'telt-niet-mee' }),
    tx('2026-09-18', -3000, 'dagelijks', 'Moved and not counted', { kind: 'telt-niet-mee', month: '2026-10' }),
    tx('2026-09-19', -4000, 'dagelijks', 'Winkel'),
  ]);
  const b = assertReconciles(s, '2026-09', 'transfers');
  assert.equal(b.daily.total, 4000);
  assert.deepEqual(plain(b.daily.elsewhere), []);
  assert.deepEqual(plain(b.left.notCounted), { amount: -10000 + 5000 - 2000 - 3000, count: 4 });
  const over = h.overSum(b);
  assert.equal(over.note, `Not in this sum: 4 payments that don't count, such as savings (net −${WJ}€100.00).`);
  const one = h.overSum(calc.tileBreakdown(makeState([tx('2026-09-15', -10000, 'sparen', 'Naar spaarrekening')]), '2026-09'));
  assert.equal(one.note, `Not in this sum: 1 payment that doesn't count, such as savings (net −${WJ}€100.00).`);
});

test('Not sorted yet: money in and out; the Left line shows only when not zero, with in/out when both', () => {
  const both = makeState([
    tx('2026-09-01', 100000, 'inkomen', 'Werkgever BV'),
    tx('2026-09-03', 2500, 'onbekend', 'J. Jansen'),
    tx('2026-09-04', -850, 'onbekend', 'A. de Vries'),
    tx('2026-09-05', -400, 'onbekend', 'A. de Vries'),
    tx('2026-09-06', -20000, 'huur', 'Huisbaas BV'),
  ]);
  const b = assertReconciles(both, '2026-09', 'both');
  assert.deepEqual(plain([b.unknown.total, b.unknown.amount, b.unknown.moneyIn, b.unknown.moneyOut]), [1250, 1250, 2500, -1250]);
  assert.deepEqual(plain(b.unknown.payees.map((p) => [p.name, p.total])), [['J. Jansen', 2500], ['A. de Vries', -1250]], 'biggest size first');
  const over = h.overSum(b);
  assert.deepEqual(plain(over.lines.map((l) => [l.key, l.label, l.amount])), [
    ['income', 'Income', 100000], ['fixed', 'Fixed costs', -20000], ['daily', 'Daily spending', 0], ['oneoff', 'One-off', 0], ['unknown', 'Not sorted yet', 1250]]);
  assert.equal(over.lines[4].sub, `+${WJ}€25.00 in, −${WJ}€12.50 out`);
  assert.equal(over.total, 81250);
  assert.equal(h.tileMoney('unknown', 2500), `+${WJ}€25.00`);
  assert.equal(h.tileMoney('unknown', -1250), `−${WJ}€12.50`);
  assert.equal(h.unknownInText(b.unknown.moneyIn), `+${WJ}€25.00 not sorted yet`, 'tile + Income note: signed like every other "+€x"');
  assert.deepEqual(plain(h.paymentTags('unknown', b.unknown.payees[1].payments[0])), [], 'no "back" on the signed Not sorted yet list');

  const onlyIn = h.overSum(calc.tileBreakdown(makeState([tx('2026-09-03', 2500, 'onbekend', 'J. Jansen')]), '2026-09'));
  assert.deepEqual(plain(onlyIn.lines.map((l) => [l.key, l.amount, l.sub])).at(-1), ['unknown', 2500, null]);
  const evenOut = makeState([tx('2026-09-03', 2500, 'onbekend', 'J. Jansen'), tx('2026-09-04', -2500, 'onbekend', 'J. Jansen')]);
  const even = h.overSum(assertReconciles(evenOut, '2026-09', 'in = out'));
  assert.deepEqual(plain(even.lines.at(-1)), { key: 'unknown', label: 'Not sorted yet', amount: 0, sub: `+${WJ}€25.00 in, −${WJ}€25.00 out` },
    'in and out that cancel out: still shown (there is something to choose), adding €0');
  const none = h.overSum(calc.tileBreakdown(makeState([tx('2026-09-03', -2500, 'dagelijks', 'Winkel')]), '2026-09'));
  assert.deepEqual(plain(none.lines.map((l) => l.key)), ['income', 'fixed', 'daily', 'oneoff']);
});

test('one-off income belongs in Income (label "one-off"); money back and money out get "back" / "out"', () => {
  const s = makeState([
    tx('2026-09-23', 24500, 'inkomen', 'Belastingdienst', { kind: 'eenmalig' }),
    tx('2026-09-25', 131240, 'inkomen', 'Werkgever BV'),
    tx('2026-09-26', -1000, 'inkomen', 'Werkgever BV', { kind: 'wisselend' }),
    tx('2026-09-12', -5999, 'eenmalig', 'Webwinkel'),
    tx('2026-09-14', 5999, 'eenmalig', 'Webwinkel', { kind: 'eenmalig' }),
    tx('2026-09-15', 1200, 'zorg', 'Zorgverzekeraar NV'),
  ]);
  const b = assertReconciles(s, '2026-09', 'one-off income');
  assert.equal(b.income.total, 24500 + 131240 - 1000);
  const tax = b.income.payees.find((p) => p.name === 'Belastingdienst').payments[0];
  assert.deepEqual(plain(h.paymentTags('income', tax)), ['one-off']);
  const minus = b.income.payees.find((p) => p.name === 'Werkgever BV').payments.find((x) => x.amount < 0);
  assert.deepEqual(plain(h.paymentTags('income', minus)), ['out']);
  assert.equal(b.oneoff.total, 0, 'a refund cancels the purchase');
  assert.deepEqual(plain(b.oneoff.payees[0].payments.map((x) => h.paymentTags('oneoff', x))), [['back'], []], 'no "one-off" label inside One-off');
  assert.equal(b.fixed.total, -1200);
  assert.equal(h.tileMoney('fixed', -1200), `−${WJ}€12.00`);
  assert.deepEqual(plain(h.paymentTags('fixed', b.fixed.payees[0].payments[0])), ['back']);
});

test('an empty month (statement only, no payments): everything €0, Left = 4 lines, no notes', () => {
  const s = makeState([tx('2026-08-10', -1000, 'dagelijks', 'Winkel')], [{ month: '2026-09', startBalance: 100, endBalance: 100, source: 'pdf' }]);
  assert.ok(calc.monthsWithData(s).includes('2026-09'));
  const b = assertReconciles(s, '2026-09', 'empty');
  for (const key of SECTIONS) {
    assert.deepEqual(plain([b[key].total, b[key].count, b[key].payees, b[key].elsewhere]), [0, 0, [], []], key);
    assert.ok(!Object.is(b[key].total, -0), `${key}: no negative zero`);
  }
  assert.deepEqual(plain(h.overSum(b)), { lines: [
    { key: 'income', label: 'Income', amount: 0, sub: null }, { key: 'fixed', label: 'Fixed costs', amount: 0, sub: null },
    { key: 'daily', label: 'Daily spending', amount: 0, sub: null }, { key: 'oneoff', label: 'One-off', amount: 0, sub: null }], total: 0, note: null });
  assert.equal(h.tileMoney('fixed', b.fixed.total), `€0.00`);
  const nothing = calc.tileBreakdown(makeState(), '2026-09');
  assert.equal(nothing.left.total, 0);
});

test('category ids that are not in the state count as Not sorted yet (like monthSummary)', () => {
  const s = makeState([tx('2026-09-01', -500, 'weg', 'Oud'), tx('2026-09-02', -700, 'dagelijks', 'Winkel')]);
  const b = assertReconciles(s, '2026-09', 'unknown id');
  assert.deepEqual(plain(b.unknown.payees.map((p) => [p.categoryId, p.name, p.total])), [['onbekend', 'Oud', -500]]);
});

test('popup helpers: titles, "Left this month" colours (no red for a month not booked yet)', () => {
  assert.equal(h.tileTitle('fixed', '2026-09'), 'Fixed costs — September 2026');
  assert.equal(h.tileTitle('oneoff', '2027-01'), 'One-off — January 2027');
  assert.equal(h.tileTitle('unknown', '2026-10'), 'Not sorted yet — October 2026');
  assert.equal(h.tileTitle('left', '2026-12'), 'Left this month — December 2026');
  assert.equal(h.leftClass(100, true), 'pos');
  assert.equal(h.leftClass(0, true), 'pos');
  assert.equal(h.leftClass(-1, true), 'neg');
  assert.equal(h.leftClass(-1, false), null);
  assert.equal(h.leftClass(100, false), null);
  assert.equal(h.tileMoney('fixed', 105000), `€1,050.00`);
  assert.equal(typeof uiMonth.openTilePopup, 'function');
  assert.equal(typeof uiMonth.closeTilePopups, 'function');
});

test('demo seed: in every month each popup total = its tile, and the Left sum adds up to the Left tile', () => {
  const seed = JSON.parse(read('../../seed/demo-seed.json'));
  const state = seed.state;
  const months = calc.monthsWithData(state);
  assert.ok(months.length >= 3);
  let moved = 0;
  let unknown = 0;
  let oneoff = 0;
  for (const m of months) {
    const b = assertReconciles(state, m, `seed ${m}`);
    moved += SECTIONS.reduce((n, k) => n + b[k].elsewhere.length, 0);
    unknown += b.unknown.count;
    oneoff += b.oneoff.count;
  }
  assert.ok(moved > 0 && unknown > 0 && oneoff > 0, 'the seed has a moved payment, a Not sorted yet payment and a one-off');
});

test('random data (moved, doesn\'t count, transfers, hand, unknown, refunds): every popup = its tile, Left adds up', () => {
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const kinds = ['elke-maand', 'wisselend', 'eenmalig', 'telt-niet-mee'];
  const months = ['2026-08', '2026-09', '2026-10'];
  const cats = [...CATEGORIES.map((c) => c.id), 'verdwenen'];
  for (let round = 0; round < 60; round++) {
    const transactions = [];
    for (let i = 0; i < 70; i++) {
      const date = `${months[rand(3)]}-${String(1 + rand(28)).padStart(2, '0')}`;
      const moved = rand(5) === 0 ? months[rand(3)] : date.slice(0, 7);
      transactions.push(tx(date, rand(200001) - 100000, cats[rand(cats.length)], `${['Payee', 'payee ', 'PAYEE'][rand(3)]} ${rand(6)}`,
        { month: moved, kind: kinds[rand(4)], source: rand(6) === 0 ? 'hand' : 'csv' }));
    }
    const s = makeState(transactions);
    for (const m of [...months, '2026-11']) assertReconciles(s, m, `round ${round} ${m}`);
  }
});

test('tileBreakdown never changes the state', () => {
  const s = makeState([
    tx('2026-09-27', -15000, 'huur', 'Stephan', { month: '2026-10' }),
    tx('2026-09-03', 2500, 'onbekend', 'J. Jansen'),
    tx('2026-09-15', -10000, 'sparen', 'Naar spaarrekening'),
  ]);
  const frozen = JSON.stringify(s);
  const deepFreeze = (v) => {
    if (v && typeof v === 'object') {
      Object.freeze(v);
      Object.values(v).forEach(deepFreeze);
    }
    return v;
  };
  deepFreeze(s);
  for (const m of ['2026-09', '2026-10']) {
    const b = calc.tileBreakdown(s, m);
    h.overSum(b);
  }
  assert.equal(JSON.stringify(s), frozen);
});
