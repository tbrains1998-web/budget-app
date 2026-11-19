// Validates seed/demo-seed.json (FAKE demo data) by loading it the way the app does: util.js, store.js and
// calc.js run as classic scripts in a vm context with an in-memory localStorage, then Budget.store.load() and
// Budget.store.loadSeedIfEmpty(seed). Every month's recap must reconcile with its statement to the cent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const SEED_TEXT = read('../../seed/demo-seed.json');
const SEED = JSON.parse(SEED_TEXT);
const plain = (v) => JSON.parse(JSON.stringify(v));
const RECAP_ROWS = ['normalIncome', 'extraIncome', 'fixed', 'daily', 'oneoff', 'unknown', 'paidForOtherMonth',
  'paidInEarlierMonth', 'paidInLaterMonth', 'transfersNet', 'notViaBank'];

function loadApp() {
  const data = new Map();
  const localStorage = {
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
  const context = vm.createContext({
    TextEncoder,
    crypto: globalThis.crypto,
    console,
    localStorage,
    setTimeout: () => 0,
    clearTimeout: () => {},
    addEventListener: () => {},
  });
  for (const f of ['util.js', 'store.js', 'calc.js', 'categorize.js']) {
    vm.runInContext(read(`../../src/js/${f}`), context, { filename: f });
  }
  const { store, calc, util } = context.Budget;
  const loaded = store.load();
  const seeded = store.loadSeedIfEmpty(plain(SEED));
  return { Budget: context.Budget, store, calc, util, loaded, seeded, data, state: plain(store.get()) };
}

const app = loadApp();
const { calc, util, state } = app;
const months = plain(calc.monthsWithData(state));
const bookedIn = (month) => state.transactions.filter((t) => util.monthOf(t.date) === month);

test('the seed is a backup the store loads on first run without changing it', () => {
  assert.equal(SEED.app, 'budget-nl');
  assert.equal(SEED.version, 1);
  assert.ok(!Number.isNaN(Date.parse(SEED.exportedAt)));
  assert.equal(app.loaded.empty, true);
  assert.equal(app.seeded, true);
  assert.deepEqual(state, SEED.state, 'normalizing the seed must not change it');
  assert.deepEqual(JSON.parse(app.data.get(app.store.KEY)), SEED.state, 'the seed is saved to storage');
});

test('three months, each with a statement', () => {
  assert.deepEqual(months, ['2026-04', '2026-05', '2026-06']);
  assert.deepEqual(state.statements.map((s) => s.month).sort(), months);
});

test('every month reconciles exactly with its statement', () => {
  for (const month of months) {
    const r = calc.monthRecap(state, month);
    assert.deepEqual(plain(r.statementCheck), { ok: true, diff: 0 }, month);
    assert.equal(r.startBalance + r.change, r.endBalance, month);
    assert.equal(RECAP_ROWS.reduce((sum, k) => sum + r[k], 0), r.change, `${month}: rows add up to the change`);
    assert.equal(r.change, bookedIn(month).reduce((sum, t) => sum + t.amount, 0), `${month}: change = booked payments`);
  }
});

test('statement totals match the payments and the balances chain from month to month', () => {
  const sorted = [...state.statements].sort((a, b) => a.month.localeCompare(b.month));
  sorted.forEach((s, i) => {
    const booked = bookedIn(s.month);
    assert.equal(s.totalIn, booked.filter((t) => t.amount > 0).reduce((sum, t) => sum + t.amount, 0), s.month);
    assert.equal(s.totalOut, booked.filter((t) => t.amount < 0).reduce((sum, t) => sum - t.amount, 0), `${s.month} (positive, as printed)`);
    assert.equal(s.startBalance + s.totalIn - s.totalOut, s.endBalance, s.month);
    assert.equal(s.periodFrom, `${s.month}-01`);
    if (i > 0) assert.equal(s.startBalance, sorted[i - 1].endBalance, `${s.month} starts where the month before ended`);
  });
});

test('one payment is moved to the next month and both recaps account for it', () => {
  const moved = state.transactions.filter((t) => t.month !== util.monthOf(t.date));
  assert.equal(moved.length, 1);
  const [tx] = moved;
  assert.equal(tx.month, util.addMonths(util.monthOf(tx.date), 1));
  assert.equal(calc.monthRecap(state, util.monthOf(tx.date)).paidForOtherMonth, tx.amount);
  assert.equal(calc.monthRecap(state, tx.month).paidInEarlierMonth, -tx.amount);
});

test('income: salary plus benefit-style income, with a one-time extra in one month only', () => {
  const income = state.transactions.filter((t) => t.categoryId === 'inkomen');
  assert.ok(new Set(income.map((t) => t.name)).size >= 2);
  const extra = months.map((m) => calc.monthRecap(state, m).extraIncome);
  assert.equal(extra.filter((v) => v !== 0).length, 1, 'exactly one month has extra income');
  assert.ok(extra[2] > 0);
});

test('payee ids and normalAmounts keys: every payment has a payeeId; keys are <side>:<payeeId>', () => {
  for (const t of state.transactions) assert.match(t.payeeId, /^p_[0-9a-f]{16}$/, t.id);
  const benefits = state.transactions.filter((t) => t.name === 'Benefits');
  assert.equal(new Set(benefits.map((t) => t.payeeId)).size, 1, 'one payee');
  assert.notEqual(benefits[0].payeeId, util.payeeId('Benefits'), 'made from the bank name, not the renamed one');
  for (const [key, cents] of Object.entries(state.normalAmounts)) {
    assert.match(key, /^(in|uit):p_[0-9a-f]{16}$/);
    assert.ok(cents > 0, 'a positive magnitude');
  }
  assert.deepEqual(Object.keys(state.normalAmounts), [`in:${benefits[0].payeeId}`]);
  assert.equal(state.settings.privacySalt, null);
  assert.deepEqual(state.settings.privateTokenHashes, []);
});

test('the seed is already clean: recleanState changes nothing', () => {
  const draft = plain(state);
  assert.equal(app.Budget.categorize.recleanState(draft), 0);
  assert.deepEqual(draft, state);
});

test('normalAmounts overrides the last actual amount in "My normal month"', () => {
  const keys = Object.keys(state.normalAmounts);
  assert.ok(keys.length >= 1);
  const plan = calc.normalMonth(state);
  for (const key of keys) {
    const item = plan.items.find((i) => i.key === key);
    assert.ok(item, `normal-month item for ${key}`);
    assert.equal(item.custom, true);
    assert.equal(item.normal, state.normalAmounts[key]);
    assert.notEqual(item.normal, item.lastActual, 'the override must matter');
  }
  assert.ok(plan.saveRounded > 0);
  assert.equal(plan.saveRounded % 500, 0);
});

test('covers every category: rent, insurance, telecom, groceries, savings move, one unknown', () => {
  const used = new Set(state.transactions.map((t) => t.categoryId));
  for (const c of state.categories) assert.ok(used.has(c.id), `category ${c.id} used`);
  assert.equal(state.transactions.filter((t) => t.categoryId === 'onbekend').length, 1);
  const transfers = state.transactions.filter((t) => t.kind === 'telt-niet-mee');
  assert.ok(transfers.length >= 1 && transfers.every((t) => t.categoryId === 'sparen'));
  for (const t of state.transactions) assert.equal(t.kind, app.store.defaultKind(t.categoryId), `${t.id} has its category's default kind`);
});

test('two user rules, a savings goal and a "Higher than normal" alert in the last month', () => {
  assert.equal(state.rules.length, 2);
  for (const rule of state.rules) {
    assert.match(rule.id, /^r_/);
    assert.ok(Object.keys(rule.match).length && Object.keys(rule.set).length);
    assert.ok(!Number.isNaN(Date.parse(rule.createdAt)));
  }
  const renamed = state.rules.find((r) => r.set.rename);
  assert.ok(renamed && state.transactions.some((t) => t.name === renamed.set.rename), 'a rename rule shows in the data');
  assert.ok(state.settings.savingsGoal > 0);
  assert.ok(calc.goalProgress(state, '2026-06'));
  assert.deepEqual(plain(calc.alerts(state, '2026-06').map((a) => a.categoryId)), ['dagelijks']);
  assert.deepEqual(plain(calc.alerts(state, '2026-05')), []);
  assert.ok(state.settings.lastBackupAt >= state.settings.lastImportAt, 'no backup banner on first run');
});

test('privacy: fake, cleaned data only', () => {
  assert.doesNotMatch(SEED_TEXT, /\b[A-Z]{2}\d{2}\s?[A-Z]{4}(\s?\d){6,}/, 'no IBANs');
  assert.doesNotMatch(SEED_TEXT, /Kenmerk|Machtiging|Incassant|Pasvolgnr|Valutadatum/i);
  const ids = new Set();
  const prints = new Set();
  for (const t of state.transactions) {
    assert.doesNotMatch(`${t.name} ${t.description}`, /\d{6,}/, t.id);
    assert.equal(t.source, 'seed');
    assert.match(t.fingerprint, /^fp_[0-9a-f]{64}$/);
    assert.match(t.bankCode, /^([A-Z]{4})?$/);
    ids.add(t.id);
    prints.add(t.fingerprint);
  }
  assert.equal(ids.size, state.transactions.length, 'unique ids');
  assert.equal(prints.size, state.transactions.length, 'unique fingerprints');
});
