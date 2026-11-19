// Unit tests for the pure helpers of src/js/ui-extras.js (Budget.uiExtras.pure).
// The real util.js, calc.js and ui-kit.js are loaded with it in a vm context without a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const FILES = ['util.js', 'calc.js', 'ui-kit.js', 'ui-extras.js'].map((f) => [f, readFileSync(new URL(`../../src/js/${f}`, import.meta.url), 'utf8')]);

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

function load() {
  const context = vm.createContext({});
  for (const [filename, code] of FILES) vm.runInContext(code, context, { filename });
  // Results are copied into this realm so deepEqual compares plain values.
  const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return Object.fromEntries(Object.entries(context.Budget.uiExtras.pure).map(([k, f]) => [k, (...args) => plain(f(...args))]));
}

const tx = (date, categoryId, amount, kind = 'wisselend') => ({ date, month: date.slice(0, 7), categoryId, amount, kind });

function fakeState(transactions) {
  return { categories: CATEGORIES, transactions, statements: [], settings: {} };
}

test('loads without a DOM and exposes the public API', () => {
  const context = vm.createContext({});
  vm.runInContext(FILES.at(-1)[1], context);
  const api = context.Budget.uiExtras;
  for (const name of ['renderAll', 'decorateMonth', 'renderBanners', 'backupNow', 'restoreFromFile', 'print', 'openSettings']) {
    assert.equal(typeof api[name], 'function', name);
  }
});

test('niceScale covers the range with whole-euro steps and includes 0', () => {
  const { niceScale } = load();
  for (const [lo, hi] of [[0, 123456], [-25000, 180000], [0, 0], [-999, 50], [0, 7]]) {
    const s = niceScale(lo, hi);
    assert.ok(s.lo <= lo && s.hi >= hi, `${lo}..${hi}`);
    assert.ok(s.step >= 100 && s.step % 100 === 0, `step ${s.step}`);
    assert.ok(s.ticks.includes(0), 'zero tick');
    assert.ok(s.ticks.length >= 2 && s.ticks.length <= 8, `ticks ${s.ticks.length}`);
    assert.deepEqual([...s.ticks].sort((a, b) => a - b), [...s.ticks]);
  }
});

test('monthSeries: oldest first, money out stacked in category order, transfers excluded', () => {
  const { monthSeries } = load();
  const series = monthSeries(
    fakeState([
      tx('2026-09-24', 'inkomen', 120000, 'elke-maand'),
      tx('2026-09-10', 'dagelijks', -30000),
      tx('2026-09-01', 'huur', -60000, 'elke-maand'),
      tx('2026-09-02', 'zorg', -10000, 'elke-maand'),
      tx('2026-09-25', 'sparen', -5000),
      tx('2026-09-25', 'sparen', -7000, 'telt-niet-mee'),
      tx('2026-09-12', 'weg', -1000),
      tx('2026-08-24', 'inkomen', 100000, 'elke-maand'),
      tx('2026-08-14', 'eenmalig', -105000, 'eenmalig'),
    ]),
  );
  assert.deepEqual(series.map((m) => m.month), ['2026-08', '2026-09']);
  const sep = series[1];
  assert.deepEqual(
    sep.stack.map((s) => [s.categoryId, s.value]),
    [['huur', 60000], ['zorg', 10000], ['dagelijks', 30000], ['onbekend', 1000]],
  );
  assert.deepEqual([sep.income, sep.spend, sep.left], [120000, 101000, 19000]);
  assert.deepEqual([series[0].income, series[0].spend, series[0].left], [100000, 105000, -5000]);
});

test('monthSeries: In = Σ money in, Out = Σ money out (never negative), Left = In − Out', () => {
  const { monthSeries } = load();
  // A big 'Not sorted yet' money-in must not make "Out" negative (income − left). FAKE amounts.
  const series = monthSeries(
    fakeState([
      tx('2026-11-25', 'inkomen', 200000, 'elke-maand'),
      tx('2026-11-20', 'onbekend', 500000),
      tx('2026-11-02', 'huur', -105000, 'elke-maand'),
      tx('2026-11-05', 'dagelijks', -10000),
      tx('2026-11-06', 'dagelijks', 1500), // a refund
      tx('2026-11-07', 'inkomen', -3000), // a repayment to an income payee
      tx('2026-11-08', 'sparen', 40000), // transfer in a transfer category: left out
    ]),
  );
  const nov = series[0];
  assert.deepEqual([nov.income, nov.spend, nov.left], [701500, 118000, 583500]);
  assert.ok(nov.spend >= 0);
  assert.equal(nov.stack.reduce((sum, s) => sum + s.value, 0), nov.spend, 'the stack adds up to Out');
  assert.deepEqual(nov.stack.map((s) => [s.categoryId, s.value]), [['inkomen', 3000], ['huur', 105000], ['dagelijks', 10000]]);
});

test('monthSeries: a refund larger than the spending still shows the money out (and the refund in In)', () => {
  const { monthSeries } = load();
  const series = monthSeries(fakeState([tx('2026-09-03', 'dagelijks', -1000), tx('2026-09-04', 'dagelijks', 1500)]));
  assert.deepEqual(series[0].stack, [{ categoryId: 'dagelijks', value: 1000 }]);
  assert.deepEqual([series[0].income, series[0].spend, series[0].left], [1500, 1000, 500]);
});

test('monthSeries marks a month that is not booked yet (only a payment moved there)', () => {
  const { monthSeries } = load();
  const rent = { ...tx('2026-10-31', 'huur', -60000, 'elke-maand'), month: '2026-11', source: 'pdf' };
  const series = monthSeries(fakeState([{ ...tx('2026-10-01', 'dagelijks', -1000), source: 'pdf' }, rent]));
  assert.deepEqual(series.map((m) => [m.month, m.booked]), [['2026-10', true], ['2026-11', false]]);
});

test('barPath rounds only the data end and stays inside the bar', () => {
  const { barPath } = load();
  assert.equal(barPath(10, 100, 40, 20, 4), 'M10 100V44Q10 40 14 40H26Q30 40 30 44V100Z');
  assert.equal(barPath(10, 100, 140, 20, 4), 'M10 100V136Q10 140 14 140H26Q30 140 30 136V100Z');
  assert.equal(barPath(10, 100, 98, 20, 4), 'M10 100V100Q10 98 12 98H28Q30 98 30 100V100Z');
  assert.equal(barPath(0, 50, 20, 10, 0), 'M0 50V20Q0 20 0 20H10Q10 20 10 20V50Z');
});

function series(n, overrides = {}) {
  return Array.from({ length: n }, (_, i) => ({
    month: `2026-${String((i % 12) + 1).padStart(2, '0')}`,
    income: 150000,
    spend: 120000,
    left: 30000,
    stack: [{ categoryId: 'huur', value: 80000 }, { categoryId: 'dagelijks', value: 40000 }],
    ...overrides,
  }));
}

function pathNumbers(path) {
  return path.match(/-?\d+(\.\d+)?/g).map(Number);
}

test('chartLayout fits the width, scrolls when months do not fit, never yields NaN', () => {
  const { chartLayout } = load();
  const narrow = chartLayout(series(3), { width: 336 });
  assert.equal(narrow.width, 336);
  const many = chartLayout(series(24), { width: 336 });
  assert.ok(many.width > 336, 'scrolls');
  for (const layout of [narrow, many, chartLayout(series(1), { width: 1000, goal: 50000 })]) {
    for (const g of layout.groups) {
      for (const b of g.bars) {
        for (const v of pathNumbers(b.path)) assert.ok(Number.isFinite(v), b.path);
      }
    }
    assert.ok(layout.groups.every((g) => g.x >= layout.plotLeft && g.x + g.w <= layout.plotRight + 0.5));
  }
});

test('chartLayout: stack sits on the baseline, shortfall goes below it, goal line on scale', () => {
  const { chartLayout } = load();
  const layout = chartLayout(series(2, { left: -20000, income: 100000, spend: 120000 }), { width: 600, goal: 30000 });
  const roles = layout.groups[0].bars.map((b) => b.role);
  assert.deepEqual(roles, ['in', 'out', 'out', 'short']);
  const short = layout.groups[0].bars[3];
  const ys = pathNumbers(short.path).filter((_, i) => i % 2 === 1);
  assert.ok(Math.max(...ys) > layout.zeroY, 'shortfall below zero');
  const firstOut = pathNumbers(layout.groups[0].bars[1].path);
  assert.ok(Math.abs(firstOut[1] - layout.zeroY) < 0.11, 'stack starts at zero');
  assert.ok(layout.goalY > layout.plotTop && layout.goalY < layout.zeroY);
  assert.equal(chartLayout(series(2), { width: 600 }).goalY, null);
});

test('chartLayout: an all-zero month still produces a valid scale', () => {
  const { chartLayout } = load();
  const layout = chartLayout(series(1, { income: 0, spend: 0, left: 0, stack: [] }), { width: 400 });
  assert.equal(layout.groups[0].bars.length, 0);
  assert.ok(layout.ticks.every((t) => Number.isFinite(t.y)));
});

test('chartSvg: one clickable group per month, escaped text, no NaN/undefined', () => {
  const { chartLayout, chartSvg } = load();
  const s = series(3);
  s[0].stack = [{ categoryId: 'x"><script>', value: 1000 }];
  const svg = chartSvg(chartLayout(s, { width: 500, goal: 20000 }), s);
  assert.equal((svg.match(/class="x-group"/g) || []).length, 3);
  assert.ok(!/NaN|undefined/.test(svg));
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('x-goal-line'));
  assert.ok(svg.includes('>Jan<') && svg.includes('>2026<'));
});

test('chartSvg: a month that is not booked yet is greyed (x-pending) and says so', () => {
  const { chartLayout, chartSvg } = load();
  const s = series(2);
  s[1] = { ...s[1], booked: false, left: -60000, income: 0, spend: 60000 };
  const svg = chartSvg(chartLayout(s, { width: 500 }), s);
  assert.equal((svg.match(/class="x-group x-pending"/g) || []).length, 1);
  assert.match(svg, /Not read yet\./);
});

test('backupFileName uses the date on the PC\'s own clock (local time, not UTC)', () => {
  const { backupFileName } = load();
  assert.equal(backupFileName(new Date(2026, 9, 4, 23, 59)), 'budget-backup-2026-10-04.json'); // 23:59 local
  assert.equal(backupFileName(new Date(2026, 9, 25, 0, 30)), 'budget-backup-2026-10-25.json'); // 00:30 local, the next day
  assert.equal(backupFileName(new Date(2027, 0, 31, 0, 1)), 'budget-backup-2027-01-31.json'); // winter time
});

test('needsBackupReminder: only when an import is newer than the last backup', () => {
  const { needsBackupReminder } = load();
  assert.equal(needsBackupReminder({ lastImportAt: null, lastBackupAt: null }), false);
  assert.equal(needsBackupReminder({ lastImportAt: '2026-10-01T10:00:00.000Z', lastBackupAt: null }), true);
  assert.equal(needsBackupReminder({ lastImportAt: '2026-10-01T10:00:00.000Z', lastBackupAt: '2026-10-01T09:00:00.000Z' }), true);
  assert.equal(needsBackupReminder({ lastImportAt: '2026-10-01T10:00:00.000Z', lastBackupAt: '2026-10-01T10:00:01.000Z' }), false);
  assert.equal(needsBackupReminder(undefined), false);
});

test('parseWordList trims, collapses spaces and deduplicates case-insensitively', () => {
  const { parseWordList } = load();
  assert.deepEqual(parseWordList(' Jansen, de  Vries,, jansen ;Test\n'), ['Jansen', 'de Vries', 'Test']);
  assert.deepEqual(parseWordList(''), []);
});

test('centsToInput', () => {
  const { centsToInput } = load();
  assert.equal(centsToInput(30000), '300');
  assert.equal(centsToInput(25050), '250.50');
  assert.equal(centsToInput(5), '0.05');
  assert.equal(centsToInput(0), '');
  assert.equal(centsToInput(undefined), '');
});

test('ruleSummary describes conditions and effects in plain words', () => {
  const { ruleSummary } = load();
  const r = ruleSummary(
    { match: { nameContains: 'huisbaas bv', sign: 'out', bankCode: 'TEST' }, set: { categoryId: 'huur', kind: 'elke-maand', rename: 'Huisbaas' } },
    CATEGORIES,
  );
  assert.equal(r.when, "Name contains 'huisbaas bv' and bank TEST and money out");
  assert.equal(r.then, "→ Rent · every month · call it: 'Huisbaas'");
  assert.deepEqual(ruleSummary({ match: {}, set: {} }, CATEGORIES), { when: 'All payments', then: '→ nothing' });
});

test('goalView formats calc.goalProgress (whole euros, no space after €)', () => {
  const { goalView } = load();
  assert.equal(goalView(null), null);
  assert.deepEqual(goalView({ goal: 30000, left: 18000, pct: 60 }), { text: '€180 of €300 — 60%', width: 60, reached: false, short: false });
  const over = goalView({ goal: 30000, left: 45000, pct: 150 });
  assert.equal(over.text, '€450 of €300 — 150%');
  assert.equal(over.width, 100);
  assert.equal(over.reached, true);
  const neg = goalView({ goal: 30000, left: -5000, pct: 0 });
  assert.equal(neg.text, '−⁠€50 of €300 — 0%');
  assert.equal(neg.width, 0);
  assert.equal(neg.short, true);
});

test('describeBackup accepts only budget-nl backups', () => {
  const { describeBackup } = load();
  assert.equal(describeBackup(null), null);
  assert.equal(describeBackup({ app: 'other', state: { transactions: [] } }), null);
  assert.equal(describeBackup({ app: 'budget-nl', state: {} }), null);
  const info = describeBackup({
    app: 'budget-nl',
    exportedAt: new Date(2026, 9, 24, 12, 0).toISOString(), // noon on the PC's clock
    state: { transactions: [{ month: '2026-09' }, { month: '2026-09' }, { month: '2026-10' }] },
  });
  assert.deepEqual(info, { transactions: 3, months: 2, exportedDay: '2026-10-24' });
  assert.equal(describeBackup({ app: 'budget-nl', exportedAt: 'nope', state: { transactions: [] } }).exportedDay, null);
});

test('describeBackup counts months by t.month, else the month of t.date', () => {
  const { describeBackup } = load();
  const info = describeBackup({
    app: 'budget-nl',
    exportedAt: new Date(2026, 9, 25, 0, 30).toISOString(), // 00:30 on the 25th on the PC's clock
    state: { transactions: [{ date: '2026-08-03' }, { month: '2026-09', date: '2026-08-30' }, { date: '2026-09-02', month: '' }] },
  });
  assert.deepEqual(info, { transactions: 3, months: 2, exportedDay: '2026-10-25' });
});

test('restoreMessage: singular/plural for payments and months', () => {
  const { restoreMessage } = load();
  assert.equal(
    restoreMessage({ transactions: 1, months: 1, exportedDay: '2026-10-24' }, 1),
    'Restore backup from 24 Oct 2026? It holds 1 payment from 1 month. Your current data (1 payment) will be replaced.',
  );
  assert.equal(
    restoreMessage({ transactions: 62, months: 3, exportedDay: null }, 0),
    'Restore backup? It holds 62 payments from 3 months. Your current data (0 payments) will be replaced.',
  );
});

test('ruleSetFrom: what an edited rule does; at least one thing must stay', () => {
  const { ruleSetFrom } = load();
  assert.deepEqual(ruleSetFrom({ categoryId: 'huur', kind: 'elke-maand', rename: '  Huis  baas ' }), { set: { categoryId: 'huur', kind: 'elke-maand', rename: 'Huis baas' } });
  assert.deepEqual(ruleSetFrom({ categoryId: '', kind: 'wisselend', rename: '' }), { set: { kind: 'wisselend' } });
  assert.match(ruleSetFrom({ categoryId: '', kind: '', rename: '  ' }).error, /^Choose a category, a kind or a name/);
});

test('hiddenWordsMessage says how many payments changed', () => {
  const { hiddenWordsMessage } = load();
  assert.equal(hiddenWordsMessage(0), 'Saved. No payment had to change.');
  assert.equal(hiddenWordsMessage(1), 'Saved. 1 payment changed.');
  assert.equal(hiddenWordsMessage(12), 'Saved. 12 payments changed.');
});
