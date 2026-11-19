// Unit tests for the pure helpers of src/js/ui-month.js (Budget.uiMonth.helpers).
// The real util.js, calc.js and ui-kit.js run with it as classic scripts in a vm context without a DOM.
// All payees and amounts are fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const FILES = ['util.js', 'calc.js', 'ui-kit.js', 'ui-month.js'];

function load() {
  const context = vm.createContext({ TextEncoder });
  for (const f of FILES) {
    vm.runInContext(readFileSync(new URL(`../../src/js/${f}`, import.meta.url), 'utf8'), context, { filename: f });
  }
  return context.Budget;
}

const Budget = load();
const h = Budget.uiMonth.helpers;
const plain = (v) => JSON.parse(JSON.stringify(v));

const CATEGORIES = [
  { id: 'inkomen', name: 'Income', kind: 'income', color: '#15803d' },
  { id: 'huur', name: 'Rent', kind: 'fixed', color: '#7c3aed' },
  { id: 'zorg', name: 'Health & insurance', kind: 'fixed', color: '#0e7490' },
  { id: 'vast', name: 'Fixed costs & subscriptions', kind: 'fixed', color: '#2563eb' },
  { id: 'dagelijks', name: 'Daily spending', kind: 'daily', color: '#ea580c' },
  { id: 'eenmalig', name: 'One-off', kind: 'oneoff', color: '#db2777' },
  { id: 'sparen', name: 'Savings & own accounts', kind: 'transfer', color: '#98a2b3' },
  { id: 'onbekend', name: 'Not sorted yet (?)', kind: 'unknown', color: '#9ca3af' },
];

let nextId = 0;
function tx(date, amount, categoryId, name, extra = {}) {
  return {
    id: `t_${++nextId}`, date, month: date.slice(0, 7), name, description: '', amount, categoryId,
    kind: 'wisselend', type: 'Incasso', bankCode: '', source: 'pdf', fingerprint: '', ...extra,
  };
}

function makeState(transactions, extra = {}) {
  return {
    version: 1, categories: CATEGORIES, transactions, statements: [], rules: [], normalAmounts: {},
    settings: { savingsGoal: 0, hiddenWords: [], lastBackupAt: null, lastImportAt: null }, ...extra,
  };
}

test('loads without a DOM and exposes render, closePopover and the helpers', () => {
  assert.equal(typeof Budget.uiMonth.render, 'function');
  assert.equal(typeof Budget.uiMonth.closePopover, 'function');
  assert.equal(typeof Budget.ui.el, 'function');
});

test('parseAmountInput keeps the direction unless a sign is typed', () => {
  assert.equal(h.parseAmountInput('12,50', -8715), -1250);
  assert.equal(h.parseAmountInput('12.50', -8715), -1250);
  assert.equal(h.parseAmountInput('1.234,56', 100000), 123456);
  assert.equal(h.parseAmountInput('-12,50', 100000), -1250);
  assert.equal(h.parseAmountInput('−12,50', 100000), -1250);
  assert.equal(h.parseAmountInput('+12,50', -8715), 1250);
  assert.equal(h.parseAmountInput('€ 7', -100), -700);
  assert.equal(h.parseAmountInput('€ -7', 100), -700);
  assert.equal(h.parseAmountInput('', -100), null);
  assert.equal(h.parseAmountInput('0', -100), null);
  assert.equal(h.parseAmountInput('twaalf', -100), null);
});

test('plainAmount gives editable text without sign or thousands separators', () => {
  assert.equal(h.plainAmount(-123456), '1234.56');
  assert.equal(h.plainAmount(500), '5.00');
  assert.equal(h.plainAmount(0), '0.00');
});

test('listForMonth groups by category with "Not sorted yet" first and fades rows that do not count', () => {
  const state = makeState([
    tx('2026-09-01', 100000, 'inkomen', 'Uitkering BV', { kind: 'elke-maand' }),
    tx('2026-09-10', -8000, 'dagelijks', 'SUPERMARKT 1234 PLAATS'),
    tx('2026-09-12', -1500, 'dagelijks', 'Markt (contant)', { source: 'hand' }),
    tx('2026-09-15', -10000, 'sparen', 'Naar Oranje spaarrekening X00000001', { kind: 'telt-niet-mee' }),
    tx('2026-09-20', -2500, 'onbekend', 'Onbekende BV'),
    tx('2026-09-30', -60000, 'huur', 'Huisbaas BV', { kind: 'elke-maand', month: '2026-10' }), // paid early for October
    tx('2026-08-31', -12000, 'zorg', 'Zorgverzekeraar X', { kind: 'elke-maand', month: '2026-09' }), // paid in August for September
    tx('2026-10-02', -4000, 'dagelijks', 'Drogist BV'), // other month: not shown
  ]);
  const groups = plain(h.listForMonth(state, '2026-09'));
  assert.deepEqual(groups.map((g) => g.category.id), ['onbekend', 'inkomen', 'huur', 'zorg', 'dagelijks', 'sparen']);

  const daily = groups.find((g) => g.category.id === 'dagelijks');
  assert.deepEqual(daily.items.map((i) => i.tx.name), ['Markt (contant)', 'SUPERMARKT 1234 PLAATS']); // newest first
  assert.equal(daily.total, -9500);
  assert.equal(daily.faded, false);

  const rent = groups.find((g) => g.category.id === 'huur');
  assert.equal(rent.items[0].counts, false);
  assert.equal(rent.items[0].countsIn, '2026-10');
  assert.equal(rent.faded, true);
  assert.equal(rent.total, -60000); // all rows faded: the faded sum is shown (muted)

  const care = groups.find((g) => g.category.id === 'zorg');
  assert.equal(care.items[0].counts, true);
  assert.equal(care.items[0].paidIn, '2026-08');

  const savings = groups.find((g) => g.category.id === 'sparen');
  assert.equal(savings.items[0].counts, false);
  assert.equal(savings.faded, true);
});

test('barView is relative to income, with "Left", and relative to spending on a shortfall', () => {
  const ok = makeState([
    tx('2026-09-01', 100000, 'inkomen', 'Uitkering BV', { kind: 'elke-maand' }),
    tx('2026-09-02', -60000, 'huur', 'Huisbaas BV', { kind: 'elke-maand' }),
    tx('2026-09-10', -10000, 'dagelijks', 'SUPERMARKT 1234 PLAATS'),
    tx('2026-09-11', -5000, 'onbekend', 'Onbekende BV'),
    tx('2026-09-15', -20000, 'sparen', 'Naar Oranje spaarrekening X00000001', { kind: 'telt-niet-mee' }),
  ]);
  const view = plain(h.barView(Budget.calc.monthSummary(ok, '2026-09'), CATEGORIES));
  assert.deepEqual(view.parts.map((p) => [p.id, p.value]), [['huur', 60000], ['dagelijks', 10000], ['onbekend', 5000], ['over', 25000]]);
  assert.equal(view.total, 100000);
  assert.equal(view.shortfall, 0);
  assert.match(view.parts[0].style, /^--c: var\(--cat-huur, #7c3aed\)$/);

  const short = makeState([
    tx('2026-09-01', 50000, 'inkomen', 'Uitkering BV', { kind: 'elke-maand' }),
    tx('2026-09-02', -60000, 'huur', 'Huisbaas BV', { kind: 'elke-maand' }),
    tx('2026-09-10', -10000, 'dagelijks', 'SUPERMARKT 1234 PLAATS'),
  ]);
  const shortView = plain(h.barView(Budget.calc.monthSummary(short, '2026-09'), CATEGORIES));
  assert.deepEqual(shortView.parts.map((p) => p.id), ['huur', 'dagelijks']);
  assert.equal(shortView.total, 70000);
  assert.equal(shortView.shortfall, 20000);
});

test('recapView hides zero rows, labels negative extra income and uses the statement balance change', () => {
  const base = {
    normalIncome: 83000, extraIncome: 0, fixed: -61000, daily: -24050, oneoff: 0, unknown: 0,
    paidForOtherMonth: 0, paidInEarlierMonth: 0, paidInLaterMonth: 0, transfersNet: -5000, notViaBank: 1500,
  };
  const noStatement = h.recapView({ ...base, startBalance: null, endBalance: null, change: -5550, statementCheck: null });
  assert.deepEqual(plain(noStatement.rows).map((r) => r.label), [
    'Normal income', 'Fixed costs', 'Daily spending', 'Savings & own accounts (net)',
    'Added by you, not via the bank',
  ]);
  assert.equal(noStatement.change, -5550);

  const withStatement = h.recapView({
    ...base, extraIncome: -3000, startBalance: 120000, endBalance: 111450, change: -8550,
    statementCheck: { ok: false, diff: -3000 },
  });
  const labels = plain(withStatement.rows).map((r) => r.label);
  assert.equal(labels[0], 'Balance at start of month');
  assert.equal(labels.at(-1), 'Balance at end of month');
  assert.ok(labels.includes('Less than normal'));
  assert.equal(withStatement.change, -8550);
});

test('monthOptions offers the payment month ± 2 and the month it counts for now', () => {
  assert.deepEqual(plain(h.monthOptions({ date: '2026-09-30', month: '2026-09' })), [
    '2026-07', '2026-08', '2026-09', '2026-10', '2026-11',
  ]);
  assert.deepEqual(plain(h.monthOptions({ date: '2027-01-02', month: '2026-06' })), [
    '2026-06', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03',
  ]);
});

test('upsertRule merges into a rule with the same match (with a fresh createdAt), else appends', () => {
  const rules = [{ id: 'r_1', match: { nameContains: 'Huisbaas BV', sign: 'out' }, set: { categoryId: 'huur' }, createdAt: '2026-09-01T10:00:00.000Z' }];
  h.upsertRule(rules, { id: 'r_2', match: { sign: 'out', nameContains: 'huisbaas bv' }, set: { rename: 'Rent' }, createdAt: '2026-10-25T09:00:00.000Z' });
  assert.equal(rules.length, 1);
  assert.deepEqual(plain(rules[0].set), { categoryId: 'huur', rename: 'Rent' });
  assert.equal(rules[0].id, 'r_1');
  assert.equal(rules[0].createdAt, '2026-10-25T09:00:00.000Z', 'the updated rule counts as the newest');
  h.upsertRule(rules, { id: 'r_3', match: { nameContains: 'Drogist BV' }, set: { categoryId: 'dagelijks' }, createdAt: 'z' });
  assert.equal(rules.length, 2);
});

test('applyToUnknownTwins fixes only unknown payments of the same payee (payeeId, not the shown name) and direction', () => {
  const id = Budget.util.payeeId('ONBEKENDE BV 1234');
  const chosen = tx('2026-09-20', -2500, 'dagelijks', 'Onbekende BV', { kind: 'wisselend', payeeId: id });
  const draft = makeState([
    chosen,
    tx('2026-08-20', -2400, 'onbekend', ' onbekende bv ', { payeeId: id }),
    tx('2026-08-21', 2400, 'onbekend', 'Onbekende BV', { payeeId: id }), // money in: other direction
    tx('2026-08-22', -2400, 'eenmalig', 'Onbekende BV', { payeeId: id }), // already chosen by the user
    tx('2026-08-23', -2400, 'onbekend', 'Andere BV'),
    tx('2026-07-23', -2300, 'onbekend', 'Onbekende (oud)', { payeeId: id }), // same payee, renamed "Only this one"
    // The same shown name but another payee (e.g. two shops that look alike once words are hidden).
    tx('2026-08-24', -2400, 'onbekend', 'Onbekende BV', { payeeId: Budget.util.payeeId('ONBEKENDE BV 9999') }),
  ]);
  assert.equal(h.applyToUnknownTwins(draft, chosen), 2);
  assert.deepEqual(draft.transactions.map((t) => t.categoryId),
    ['dagelijks', 'dagelijks', 'onbekend', 'eenmalig', 'onbekend', 'dagelijks', 'onbekend']);
});

test('renameTwins renames the other payments with the old name; payeeIds and normal amounts stay', () => {
  const pid = Budget.util.payeeId('ENERGIE BV');
  const key = Budget.calc.normalKey('uit', pid);
  const renamed = tx('2026-09-05', -4500, 'vast', 'Energie', { kind: 'elke-maand', payeeId: pid });
  const draft = makeState([
    renamed,
    tx('2026-08-05', -4500, 'vast', 'Energie BV', { kind: 'elke-maand', payeeId: pid }),
    tx('2026-10-05', -4600, 'vast', ' energie bv', { kind: 'elke-maand', payeeId: pid }),
    tx('2026-10-06', -900, 'vast', 'Energie BV Extra', { kind: 'elke-maand' }), // a different payee
  ], { normalAmounts: { [key]: 4500 } });
  assert.equal(h.renameTwins(draft, renamed.id, 'Energie BV', 'Energie'), 2);
  assert.deepEqual(draft.transactions.map((t) => t.name), ['Energie', 'Energie', 'Energie', 'Energie BV Extra']);
  assert.deepEqual(draft.transactions.slice(0, 3).map((t) => t.payeeId), [pid, pid, pid]);
  assert.deepEqual(plain(draft.normalAmounts), { [key]: 4500 }, 'the old name-key re-keying is gone');
});

test('"Only this one" rename keeps one payee in the normal month: nothing counted twice', () => {
  const pid = Budget.util.payeeId('WERKGEVER VOORBEELD BV');
  const st = makeState([
    tx('2026-08-25', 130000, 'inkomen', 'Werkgever Voorbeeld BV', { kind: 'elke-maand', payeeId: pid }),
    tx('2026-09-25', 131240, 'inkomen', 'Werkgever Voorbeeld BV', { kind: 'elke-maand', payeeId: pid }),
  ]);
  const before = Budget.calc.normalMonth(st);
  st.transactions[1] = { ...st.transactions[1], name: 'Salaris' }; // inline rename, "Only this one": no rule, no twins
  const after = Budget.calc.normalMonth(st);
  assert.equal(after.items.length, 1);
  assert.equal(after.income, before.income);
  assert.equal(after.items[0].key, Budget.calc.normalKey('in', pid));
});

test('normalChanges stores what the user typed as a positive amount under item.key', () => {
  const income = { key: 'in:p_00000000000000a1', name: 'Uitkering BV', side: 'in', normal: 115000, lastActual: 115000, lastCount: 1, custom: false };
  const rent = { key: 'uit:p_00000000000000b2', name: 'Huisbaas BV', side: 'uit', normal: -60000, lastActual: -60000, lastCount: 1, custom: true };
  const care = { key: 'uit:p_00000000000000c3', name: 'Zorgverzekeraar X', side: 'uit', normal: -12000, lastActual: -12500, lastCount: 1, custom: true };
  const tax = { key: 'in:p_00000000000000d4', name: 'Belastingdienst', side: 'in', normal: 90000, lastActual: 90000, lastCount: 1, custom: false };
  assert.deepEqual(
    plain(h.normalChanges([
      { item: income, text: '1000', touched: true },
      { item: rent, text: '600.00', touched: true }, // same as the stored amount: nothing to do
      { item: care, text: '', touched: true }, // empty: back to the last amount
      { item: tax, text: '900,00', touched: false }, // shown, not typed: nothing stored
    ])),
    { changes: [['in:p_00000000000000a1', 100000], ['uit:p_00000000000000c3', null]] },
  );
  // The user TYPES the amount that is shown (900 = the last amount): it must be stored all the same.
  assert.deepEqual(plain(h.normalChanges([{ item: tax, text: '900', touched: true }])), { changes: [['in:p_00000000000000d4', 90000]] });
  // a cost is stored as a magnitude too, also when typed with a minus
  assert.deepEqual(plain(h.normalChanges([{ item: { ...rent, custom: false }, text: '-650', touched: true }])), { changes: [['uit:p_00000000000000b2', 65000]] });
  assert.deepEqual(plain(h.normalChanges([{ item: rent, text: 'zeshonderd', touched: true }])).error.key, 'uit:p_00000000000000b2');
  assert.deepEqual(plain(h.normalChanges([{ item: { ...income, custom: false }, text: ' ', touched: true }])), { changes: [] });
});

test('normal month end to end: a typed amount equal to the shown default is used by the recap of an earlier month', () => {
  // FAKE: June pays 900, May paid 1050 incl. a one-time correction. The user types 900 for the payee.
  const pid = Budget.util.payeeId('BELASTINGDIENST');
  const st = makeState([
    tx('2026-05-25', 105000, 'inkomen', 'Belastingdienst', { kind: 'elke-maand', payeeId: pid }),
    tx('2026-06-25', 90000, 'inkomen', 'Belastingdienst', { kind: 'elke-maand', payeeId: pid }),
  ]);
  const item = Budget.calc.normalMonth(st).items[0];
  assert.equal(plain(item).normal, 90000, 'the editor shows 900 as the default');
  const { changes } = h.normalChanges([{ item, text: '900', touched: true }]);
  for (const [key, cents] of changes) st.normalAmounts[key] = cents;
  const may = Budget.calc.monthRecap(st, '2026-05');
  assert.equal(may.normalIncome, 90000);
  assert.equal(may.extraIncome, 15000);
});

test('lastLabel: "last time" for one payment, "last month … (N payments)" for more', () => {
  assert.equal(h.lastLabel({ lastActual: -85750, lastCount: 1 }), 'last time €857.50');
  assert.equal(h.lastLabel({ lastActual: -85750, lastCount: 2 }), 'last month €857.50 (2 payments)');
  assert.equal(h.lastLabel({ lastActual: 120000, lastCount: 3 }), 'last month €1,200.00 (3 payments)');
});

test('pctLabel shows "<1%" for a part that is not zero but rounds to 0 %', () => {
  assert.equal(h.pctLabel(60000, 100000), '60%');
  assert.equal(h.pctLabel(400, 100000), '<1%');
  assert.equal(h.pctLabel(500, 100000), '1%');
  assert.equal(h.pctLabel(0, 100000), '0%');
  assert.equal(h.pctLabel(500, 0), '');
});

test('recapView shows "Will be paid in a later month" and hides it at €0', () => {
  const recap = {
    startBalance: null, endBalance: null, statementCheck: null, normalIncome: 0, extraIncome: 0, fixed: -60000, daily: 0,
    oneoff: 0, unknown: 0, paidForOtherMonth: 0, paidInEarlierMonth: 0, paidInLaterMonth: 60000, transfersNet: 0, notViaBank: 0, change: 0,
  };
  const rows = plain(h.recapView(recap).rows);
  assert.deepEqual(rows.map((r) => [r.label, r.value]), [['Fixed costs', -60000], ['Will be paid in a later month', 60000]]);
  assert.ok(!plain(h.recapView({ ...recap, paidInLaterMonth: 0 }).rows).some((r) => r.label.startsWith('Will be paid in a later')));
});

test('notBookedNote: a month that only holds payments moved there (or hand-added ones) is "not read yet"', () => {
  const st = makeState([
    tx('2026-09-30', -60000, 'huur', 'Huisbaas BV', { kind: 'elke-maand', month: '2026-10' }), // rent for October, paid early
    tx('2026-09-25', 100000, 'inkomen', 'Uitkering BV', { kind: 'elke-maand' }),
  ]);
  assert.equal(h.notBookedNote(st, '2026-09'), null);
  assert.equal(h.notBookedNote(st, '2026-10'), 'This month has not been read yet. It only shows payments that were made earlier for this month.');
  st.transactions.push(tx('2026-12-05', -1500, 'dagelijks', 'Markt (contant)', { source: 'hand' }));
  assert.equal(h.notBookedNote(st, '2026-12'), 'This month has not been read yet. It only shows payments you added yourself.');
});

test('planUnknowns counts the counted "Not sorted yet" payments of the plan months (last 3 booked)', () => {
  const st = makeState([
    tx('2026-06-10', -1000, 'onbekend', 'Oud BV'), // too old: not in the last 3 booked months
    tx('2026-07-10', -1000, 'dagelijks', 'Winkel BV'),
    tx('2026-08-10', -1000, 'onbekend', 'Onbekende BV'),
    tx('2026-09-10', 2500, 'onbekend', 'Iemand'),
    tx('2026-09-11', -2500, 'onbekend', 'Spaar BV', { kind: 'telt-niet-mee' }), // does not count
    tx('2026-09-12', -700, 'weg', 'Kapotte categorie'), // unknown category id = Not sorted yet
  ]);
  assert.deepEqual(plain(h.planMonths(st)), ['2026-07', '2026-08', '2026-09']);
  assert.equal(h.planUnknowns(st), 3);
  assert.equal(h.planUnknownsText(3), '3 payments still to sort — then this number is right');
  assert.equal(h.planUnknownsText(1), '1 payment still to sort — then this number is right');
  assert.equal(h.planUnknownsText(0), null);
});

test('"+ Add" date: day-month-year field text and the default day', () => {
  assert.equal(h.isoToNl('2026-10-01'), '01-10-2026');
  assert.equal(h.isoToNl(''), '');
  assert.equal(Budget.util.parseDateNl(h.isoToNl('2027-02-28')), '2027-02-28');
  assert.equal(h.defaultAddDate('2026-10', '2026-10-25'), '2026-10-25'); // today is in the month on screen
  assert.equal(h.defaultAddDate('2026-09', '2026-10-25'), '2026-09-01'); // another month: its 1st
  assert.equal(h.defaultAddDate(null, '2026-10-25'), '2026-10-25'); // empty state
});

test('listForMonth puts a payment with an unknown category id under "Not sorted yet" instead of failing', () => {
  const st = makeState([tx('2026-09-12', -700, 'weg', 'Kapotte categorie')]);
  const groups = plain(h.listForMonth(st, '2026-09'));
  assert.deepEqual(groups.map((g) => [g.category.id, g.items.length]), [['onbekend', 1]]);
});
