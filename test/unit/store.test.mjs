// Unit tests for src/js/store.js (Budget.store). util.js and store.js run as classic scripts in a vm context
// with a fake localStorage, fake timers and fake window events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCES = ['util.js', 'store.js'].map((f) => [f, readFileSync(new URL(`../../src/js/${f}`, import.meta.url), 'utf8')]);
const KEY = 'budget-nl:v1';
const plain = (v) => JSON.parse(JSON.stringify(v));

function memoryStorage(initial = {}, { failWrites = false } = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    failWrites,
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem(k, v) {
      if (this.failWrites) throw new Error('QuotaExceededError');
      data.set(k, String(v));
    },
    removeItem: (k) => data.delete(k),
  };
}

// storage: a memoryStorage, or 'throws' for a localStorage getter that throws (cookies/storage disabled).
function setup({ storage = memoryStorage() } = {}) {
  const timers = new Map();
  let nextTimer = 0;
  const events = {};
  const errors = [];
  const context = {
    TextEncoder,
    crypto: globalThis.crypto,
    console: { error: (...args) => errors.push(args.join(' ')), log: console.log },
    setTimeout: (fn) => {
      timers.set(++nextTimer, fn);
      return nextTimer;
    },
    clearTimeout: (id) => timers.delete(id),
    addEventListener: (type, fn) => (events[type] = events[type] || []).push(fn),
  };
  if (storage === 'throws') {
    Object.defineProperty(context, 'localStorage', {
      get() {
        throw new Error('SecurityError: The operation is insecure.');
      },
    });
  } else {
    context.localStorage = storage;
  }
  vm.createContext(context);
  for (const [filename, code] of SOURCES) vm.runInContext(code, context, { filename });
  return {
    store: context.Budget.store,
    storage,
    errors,
    pendingTimers: () => timers.size,
    runTimers() {
      const fns = [...timers.values()];
      timers.clear();
      fns.forEach((fn) => fn());
    },
    fire: (type, event = {}) => (events[type] || []).forEach((fn) => fn(event)),
  };
}

const stored = (env) => JSON.parse(env.storage.data.get(KEY));

function fakeTx(overrides = {}) {
  return {
    id: 't_test1',
    date: '2026-09-29',
    month: '2026-09',
    name: 'Huisbaas BV',
    description: 'Huur oktober',
    amount: -85000,
    categoryId: 'huur',
    kind: 'elke-maand',
    type: 'Incasso',
    bankCode: 'TEST',
    source: 'pdf',
    fingerprint: 'fp_abc',
    ...overrides,
  };
}

function fakeBackup(transactions = [fakeTx()]) {
  return {
    app: 'budget-nl',
    version: 1,
    exportedAt: '2026-10-01T10:00:00.000Z',
    state: {
      version: 1,
      categories: [],
      transactions,
      statements: [{ month: '2026-09', periodFrom: '2026-09-01', periodTo: '2026-09-30', startBalance: 100000,
        endBalance: 15000, totalIn: 0, totalOut: 85000, source: 'pdf', importedAt: '2026-10-01T09:00:00.000Z' }],
      rules: [{ id: 'r_1', match: { nameContains: 'huisbaas' }, set: { categoryId: 'huur' }, createdAt: '2026-10-01' }],
      normalAmounts: { 'huisbaas bv': -85000 },
      settings: { savingsGoal: 20000, hiddenWords: ['Jansen'], lastBackupAt: null, lastImportAt: '2026-10-01T09:00:00.000Z' },
    },
  };
}

test('DEFAULT_CATEGORIES match the expected table', () => {
  const { store } = setup();
  assert.deepEqual(plain(store.DEFAULT_CATEGORIES), [
    { id: 'inkomen', name: 'Income', kind: 'income', color: '#15803d', colorDark: '#4ade80' },
    { id: 'huur', name: 'Rent', kind: 'fixed', color: '#7c3aed', colorDark: '#a78bfa' },
    { id: 'zorg', name: 'Health & insurance', kind: 'fixed', color: '#0e7490', colorDark: '#22d3ee' },
    { id: 'vast', name: 'Fixed costs & subscriptions', kind: 'fixed', color: '#2563eb', colorDark: '#60a5fa' },
    { id: 'dagelijks', name: 'Daily spending', kind: 'daily', color: '#ea580c', colorDark: '#fb923c' },
    { id: 'eenmalig', name: 'One-off', kind: 'oneoff', color: '#db2777', colorDark: '#f472b6' },
    { id: 'sparen', name: 'Savings & own accounts', kind: 'transfer', color: '#98a2b3', colorDark: '#6b7585' },
    { id: 'onbekend', name: 'Not sorted yet (?)', kind: 'unknown', color: '#9ca3af', colorDark: '#6b7280' },
  ]);
  assert.ok(Object.isFrozen(store.DEFAULT_CATEGORIES) && Object.isFrozen(store.DEFAULT_CATEGORIES[0]));
});

test('defaultKind per category', () => {
  const { store } = setup();
  const expected = { inkomen: 'elke-maand', huur: 'elke-maand', zorg: 'elke-maand', vast: 'elke-maand',
    dagelijks: 'wisselend', eenmalig: 'eenmalig', sparen: 'telt-niet-mee', onbekend: 'wisselend', bestaatniet: 'wisselend' };
  for (const [id, kind] of Object.entries(expected)) assert.equal(store.defaultKind(id), kind, id);
});

test('load on empty storage: empty default state, storage ok', () => {
  const env = setup();
  assert.deepEqual(plain(env.store.load()), { ok: true, empty: true, corrupt: false, storage: true });
  const s = env.store.get();
  assert.equal(s.version, 1);
  assert.equal(s.categories.length, 8);
  assert.deepEqual(plain(s.settings), { savingsGoal: 0, hiddenWords: [], lastBackupAt: null, lastImportAt: null,
    privacySalt: null, privateTokenHashes: [] }, 'privacySalt and privateTokenHashes are added');
  assert.ok(env.store.storageOk());
  assert.equal(env.storage.data.has(KEY), false, 'load does not write');
  assert.equal(env.storage.data.has(`${KEY}:probe`), false, 'probe key removed');
});

test('update: debounced save, coalesced, flushed on pagehide', () => {
  const env = setup();
  env.store.load();
  env.store.update((s) => { s.settings.savingsGoal = 10000; });
  env.store.update((s) => { s.transactions.push(fakeTx()); });
  assert.equal(env.storage.data.has(KEY), false, 'not saved synchronously');
  assert.equal(env.pendingTimers(), 1, 'one pending save');
  env.runTimers();
  assert.equal(stored(env).settings.savingsGoal, 10000);
  assert.equal(stored(env).transactions.length, 1);

  env.store.update((s) => { s.settings.savingsGoal = 25000; });
  env.fire('pagehide');
  assert.equal(stored(env).settings.savingsGoal, 25000, 'pagehide writes synchronously');
  assert.equal(env.pendingTimers(), 0);
});

test('state from get() is frozen; update works on a draft and ignores the return value', () => {
  const env = setup();
  env.store.load();
  const before = env.store.get();
  const isTypeError = (err) => err.name === 'TypeError';
  assert.throws(() => { before.settings.savingsGoal = 1; }, isTypeError);
  assert.throws(() => before.transactions.push(fakeTx()), isTypeError);
  env.store.update((s) => s.transactions.push(fakeTx()));
  assert.equal(before.transactions.length, 0, 'old state untouched');
  assert.equal(env.store.get().transactions.length, 1);
  env.store.update((s) => Object.assign(s.settings, { savingsGoal: 5000 }));
  assert.equal(env.store.get().transactions.length, 1, 'returned settings object did not replace the state');
});

test('update: a throwing fn or invalid result leaves the state unchanged', () => {
  const env = setup();
  env.store.load();
  const before = env.store.get();
  let calls = 0;
  env.store.on('change', () => calls++);
  assert.throws(() => env.store.update((s) => {
    s.settings.savingsGoal = 1;
    throw new Error('boom');
  }), /boom/);
  assert.throws(() => env.store.update((s) => { s.transactions.push({ date: 'gisteren', amount: 5 }); }),
    (err) => /Payment 1 is damaged/.test(err.message));
  assert.equal(env.store.get(), before);
  assert.equal(calls, 0);
  assert.equal(env.pendingTimers(), 0);
});

test('update normalizes: defaults filled, unknown fields kept, ids unique, floats rounded', () => {
  const env = setup();
  env.store.load();
  env.store.update((s) => {
    s.transactions.push({ date: '2026-09-03', amount: -1250.4, name: 'Supermarkt', categoryId: 'dagelijks', note: 'x' });
    s.transactions.push({ id: 'same', date: '2026-09-04', amount: 100, categoryId: 'weg' });
    s.transactions.push({ id: 'same', date: '2026-09-05', amount: -100, categoryId: 'sparen' });
  });
  const [a, b, c] = env.store.get().transactions;
  assert.equal(a.month, '2026-09');
  assert.equal(a.kind, 'wisselend');
  assert.equal(a.amount, -1250);
  assert.equal(a.note, 'x', 'unknown field kept');
  assert.equal(a.description, '');
  assert.equal(a.bankCode, '');
  assert.match(a.id, /^t_/);
  assert.equal(b.categoryId, 'onbekend', 'unknown category -> onbekend');
  assert.equal(b.kind, 'wisselend');
  assert.equal(c.kind, 'telt-niet-mee');
  assert.equal(b.id, 'same');
  assert.notEqual(c.id, 'same', 'duplicate id replaced');
});

test('change events: state and info, unsubscribe, listener errors are contained', () => {
  const env = setup();
  env.store.load();
  const seen = [];
  const off = env.store.on('change', (s, info) => seen.push([s.settings.savingsGoal, info.source, info.undoLabel]));
  env.store.on('change', () => { throw new Error('listener bug'); });
  env.store.update((s) => { s.settings.savingsGoal = 100; }, { undoLabel: 'Savings goal' });
  off();
  env.store.update((s) => { s.settings.savingsGoal = 200; });
  assert.deepEqual(seen, [[100, 'update', 'Savings goal']]);
  assert.equal(env.errors.length, 2, 'both listener errors logged');
});

test('undo: labeled changes, stack of 20, unlabeled change clears the stack', () => {
  const env = setup();
  env.store.load();
  assert.equal(env.store.undo(), null);
  for (let i = 1; i <= 25; i++) env.store.update((s) => { s.settings.savingsGoal = i; }, { undoLabel: `stap ${i}` });
  const labels = [];
  while (env.store.canUndo()) labels.push(env.store.undo());
  assert.equal(labels.length, 20);
  assert.equal(labels[0], 'stap 25');
  assert.equal(env.store.get().settings.savingsGoal, 5, 'oldest 5 steps dropped');
  assert.equal(env.store.undo(), null);

  env.store.update((s) => { s.transactions.push(fakeTx()); }, { undoLabel: 'Toegevoegd' });
  env.store.update((s) => { s.settings.lastBackupAt = '2026-10-01T00:00:00.000Z'; });
  assert.equal(env.store.canUndo(), false);

  const token = env.store.update((s) => { s.transactions = []; }, { undoLabel: 'Deleted' });
  const events = [];
  env.store.on('change', (s, info) => events.push(info));
  assert.equal(env.store.undo(), 'Deleted');
  assert.equal(env.store.get().transactions.length, 1);
  assert.deepEqual(plain(events), [{ source: 'undo', undoLabel: 'Deleted', undoToken: token }], 'info has the undoToken');
  env.runTimers();
  assert.equal(stored(env).transactions.length, 1, 'undo is saved');
});

test('undo tokens: update returns a unique token only with an undoLabel; change info carries it', () => {
  const env = setup();
  env.store.load();
  const infos = [];
  env.store.on('change', (s, info) => infos.push(info));
  const a = env.store.update((s) => { s.settings.savingsGoal = 1; }, { undoLabel: 'Een' });
  const b = env.store.update((s) => { s.settings.savingsGoal = 2; }, { undoLabel: 'Twee' });
  const none = env.store.update((s) => { s.settings.savingsGoal = 3; });
  assert.equal(typeof a, 'string');
  assert.ok(a.length > 2);
  assert.notEqual(a, b);
  assert.equal(none, null);
  assert.deepEqual(plain(infos), [
    { source: 'update', undoLabel: 'Een', undoToken: a },
    { source: 'update', undoLabel: 'Twee', undoToken: b },
    { source: 'update', undoLabel: null, undoToken: null },
  ]);
});

test('undo(token) only undoes its own change (an older toast must not undo a newer change)', () => {
  const env = setup();
  env.store.load();
  env.store.update((s) => { s.transactions.push(fakeTx({ id: 't_a' }), fakeTx({ id: 't_b', name: 'Supermarkt' })); });
  const del = env.store.update((s) => { s.transactions = s.transactions.filter((t) => t.id !== 't_a'); }, { undoLabel: 'Deleted' });
  const edit = env.store.update((s) => { s.transactions[0].amount = -100; }, { undoLabel: 'Bedrag aangepast' });
  assert.equal(env.store.topUndoToken(), edit);
  assert.equal(env.store.canUndo(del), false);
  assert.equal(env.store.canUndo(edit), true);
  const before = env.store.get();
  assert.equal(env.store.undo(del), null, 'the delete toast is stale: the newest change is the edit');
  assert.equal(env.store.get(), before, 'nothing changed');
  assert.equal(env.store.undo('u_bestaat-niet'), null);
  assert.equal(env.store.undo(42), null, 'a non-token argument never undoes');
  assert.equal(env.store.get(), before);
  assert.equal(env.store.undo(edit), 'Bedrag aangepast');
  assert.equal(env.store.get().transactions[0].amount, -85000);
  assert.equal(env.store.undo(del), 'Deleted', 'now the delete is on top');
  assert.equal(env.store.get().transactions.length, 2);
  assert.equal(env.store.undo(), null);
  assert.equal(env.store.topUndoToken(), null);
});

test('keepUndo: bookkeeping writes keep the undo stack; undo never reverts lastBackupAt', () => {
  const env = setup();
  env.store.load();
  env.store.update((s) => { s.transactions.push(fakeTx()); });
  const del = env.store.update((s) => { s.transactions = []; }, { undoLabel: 'Deleted' });
  // "Make backup" right after deleting: stores lastBackupAt without wiping the undo.
  assert.equal(env.store.update((s) => { s.settings.lastBackupAt = '2026-10-25T10:00:00.000Z'; }, { keepUndo: true }), null);
  assert.equal(env.store.canUndo(del), true, 'the delete can still be undone');
  assert.equal(env.store.undo(del), 'Deleted');
  assert.equal(env.store.get().transactions.length, 1);
  assert.equal(env.store.get().settings.lastBackupAt, '2026-10-25T10:00:00.000Z', 'the backup really was made');
  // Without keepUndo an unlabeled change still clears the stack.
  env.store.update((s) => { s.transactions = []; }, { undoLabel: 'Deleted' });
  env.store.update((s) => { s.settings.savingsGoal = 5; });
  assert.equal(env.store.canUndo(), false);
  // Restoring an older backup and undoing that keeps the newer lastBackupAt too.
  env.store.update((s) => { s.settings.lastBackupAt = '2026-10-25T11:00:00.000Z'; }, { keepUndo: true });
  env.store.importBackup(fakeBackup());
  env.store.update((s) => { s.settings.lastBackupAt = '2026-10-25T12:00:00.000Z'; }, { keepUndo: true });
  assert.equal(env.store.undo(), 'Backup restored');
  assert.equal(env.store.get().settings.lastBackupAt, '2026-10-25T12:00:00.000Z');
  assert.ok(Object.isFrozen(env.store.get().settings), 'the restored state is frozen like any other');
});

test('payeeId: filled from the name when missing or invalid, kept otherwise, never changed by a rename', () => {
  const env = setup();
  env.store.load();
  env.store.update((s) => {
    s.transactions.push(fakeTx({ id: 't_1', name: '  Markt (contant) ' }));
    s.transactions.push(fakeTx({ id: 't_2', payeeId: 'p_0123456789abcdef' }));
    s.transactions.push(fakeTx({ id: 't_3', payeeId: 'kapot' }));
  });
  const ids = plain(env.store.get().transactions.map((t) => t.payeeId));
  const fnv = (name) => {
    let h = 0xcbf29ce484222325n;
    for (const b of new TextEncoder().encode(name)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
    return `p_${h.toString(16).padStart(16, '0')}`;
  };
  assert.deepEqual(ids, [fnv('markt (contant)'), 'p_0123456789abcdef', fnv('huisbaas bv')]);
  env.store.update((s) => { s.transactions[1].name = 'Andere naam'; });
  assert.equal(env.store.get().transactions[1].payeeId, 'p_0123456789abcdef', 'rename keeps the id');
});

test('normalAmounts migration: old name keys become <side>:<payeeId>, values positive, unmatched keys dropped', () => {
  const state = fakeBackup([
    fakeTx({ id: 't_1', name: 'Huisbaas BV', categoryId: 'huur', kind: 'elke-maand', amount: -85000 }),
    fakeTx({ id: 't_2', name: 'Uitkering BV', categoryId: 'inkomen', kind: 'elke-maand', amount: 100000, payeeId: 'p_00000000000000aa' }),
    fakeTx({ id: 't_3', name: 'Uitkering BV', categoryId: 'inkomen', kind: 'elke-maand', amount: 100000, date: '2026-08-29', month: '2026-08', payeeId: 'p_00000000000000bb' }),
    // one name with a monthly income AND a monthly fixed payment: the old key meant the side its payments add up to
    fakeTx({ id: 't_4', name: 'Belastingdienst', categoryId: 'inkomen', kind: 'elke-maand', amount: 90000, payeeId: 'p_00000000000000cc' }),
    fakeTx({ id: 't_5', name: 'Belastingdienst', categoryId: 'vast', kind: 'elke-maand', amount: -5000, payeeId: 'p_00000000000000cc' }),
    fakeTx({ id: 't_6', name: 'Supermarkt', categoryId: 'dagelijks', kind: 'wisselend', amount: -5000 }),
  ]).state;
  state.normalAmounts = {
    'huisbaas bv': -85000,
    'uitkering bv': 95000,
    belastingdienst: 90000,
    supermarkt: 4000, // not elke maand: no item, dropped
    'bestaat niet': 100, // matches nothing: dropped
    'uit:p_00000000000000cc': -4000, // already new: kept (made positive), wins
  };
  const env = setup({ storage: memoryStorage({ [KEY]: JSON.stringify(state) }) });
  assert.equal(env.store.load().ok, true);
  const s = env.store.get();
  const huisbaas = s.transactions.find((t) => t.id === 't_1').payeeId;
  assert.deepEqual(plain(s.normalAmounts), {
    'uit:p_00000000000000cc': 4000,
    [`uit:${huisbaas}`]: 85000,
    'in:p_00000000000000aa': 95000,
    'in:p_00000000000000bb': 95000,
    'in:p_00000000000000cc': 90000,
  });
});

test('corrupt JSON: load does not throw, keeps the raw string, seed not loaded, restore recovers', () => {
  const env = setup({ storage: memoryStorage({ [KEY]: '{"version":1,"transactions":[' }) });
  const result = env.store.load();
  assert.equal(result.ok, false);
  assert.equal(result.corrupt, true);
  assert.match(result.backupKey, /^budget-nl:v1:corrupt-\d+$/);
  assert.equal(env.storage.data.get(result.backupKey), '{"version":1,"transactions":[');
  assert.equal(env.store.get().transactions.length, 0, 'empty state in memory');
  assert.ok(env.store.storageOk());
  assert.equal(env.store.loadSeedIfEmpty(fakeBackup()), false, 'storage is not empty');

  env.store.importBackup(fakeBackup());
  assert.equal(stored(env).transactions.length, 1, 'restored state written immediately');
});

test('corrupt data is copied aside only once across reloads', () => {
  const storage = memoryStorage({ [KEY]: 'kapot' });
  const first = setup({ storage }).store.load();
  const second = setup({ storage }).store.load();
  assert.equal(second.backupKey, first.backupKey);
  assert.equal([...storage.data.keys()].filter((k) => k.startsWith(`${KEY}:corrupt-`)).length, 1);
});

test('corrupt shapes are corrupt too (valid JSON, wrong structure or newer version)', () => {
  for (const raw of ['null', '[]', '"x"', '{"transactions":5}', '{"version":2,"transactions":[]}',
    '{"transactions":[{"date":"2026-09-01"}]}']) {
    const env = setup({ storage: memoryStorage({ [KEY]: raw }) });
    const result = env.store.load();
    assert.equal(result.corrupt, true, raw);
    assert.equal(typeof result.error, 'string');
  }
});

test('corrupt data that cannot be copied aside is never overwritten until the user chooses', () => {
  const storage = memoryStorage({ [KEY]: 'not json' });
  const env = setup({ storage });
  storage.failWrites = true;
  const result = env.store.load();
  assert.equal(result.corrupt, true);
  assert.equal(result.backupKey, null);
  assert.equal(env.store.storageOk(), false);
  storage.failWrites = false;
  env.store.update((s) => { s.settings.savingsGoal = 1; });
  env.runTimers();
  env.fire('pagehide');
  assert.equal(storage.data.get(KEY), 'not json', 'still untouched');
  env.store.reset();
  assert.equal(stored(env).transactions.length, 0, '"Opnieuw beginnen" writes');
  assert.ok(env.store.storageOk());
});

test('storage access throwing: app keeps working in memory, never writes, seed still shown', () => {
  const env = setup({ storage: 'throws' });
  const result = env.store.load();
  assert.deepEqual(plain(result), { ok: true, empty: true, corrupt: false, storage: false });
  assert.equal(env.store.storageOk(), false);
  env.store.update((s) => { s.transactions.push(fakeTx()); }, { undoLabel: 'x' });
  env.runTimers();
  env.fire('pagehide');
  assert.equal(env.store.get().transactions.length, 1);
  assert.equal(env.store.loadSeedIfEmpty(fakeBackup([fakeTx(), fakeTx({ id: 't_2' })])), true);
  assert.equal(env.store.get().transactions.length, 2);
});

test('storage full: storageOk turns false with a change event, and back when a save succeeds', () => {
  const storage = memoryStorage();
  const env = setup({ storage });
  env.store.load();
  const sources = [];
  env.store.on('change', (s, info) => sources.push(info.source));
  storage.failWrites = true;
  env.store.update((s) => { s.settings.savingsGoal = 1; });
  env.runTimers();
  assert.equal(env.store.storageOk(), false);
  assert.equal(env.store.get().settings.savingsGoal, 1, 'still works in memory');
  storage.failWrites = false;
  env.fire('pagehide');
  assert.equal(env.store.storageOk(), true, 'retried on pagehide');
  assert.equal(stored(env).settings.savingsGoal, 1);
  assert.deepEqual(sources, ['update', 'storage', 'storage']);
});

test('storage full at start: load reports it', () => {
  const storage = memoryStorage({ [KEY]: JSON.stringify(fakeBackup().state) }, { failWrites: true });
  const env = setup({ storage });
  const result = env.store.load();
  assert.equal(result.ok, true);
  assert.equal(result.storage, false);
  assert.equal(env.store.get().transactions.length, 1, 'data still readable');
});

test('nothing is written before load()', () => {
  const env = setup({ storage: memoryStorage({ [KEY]: JSON.stringify(fakeBackup().state) }) });
  env.store.update((s) => { s.transactions = []; });
  env.runTimers();
  env.fire('pagehide');
  assert.equal(stored(env).transactions.length, 1);
  env.store.load();
  assert.equal(env.store.get().transactions.length, 1);
});

test('exportBackup / importBackup round-trip gives an identical state', () => {
  const env = setup();
  env.store.load();
  env.store.importBackup(fakeBackup());
  const backup = env.store.exportBackup();
  assert.equal(backup.app, 'budget-nl');
  assert.equal(backup.version, 1);
  assert.match(backup.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(backup.state.settings.lastBackupAt, backup.exportedAt);
  env.store.update((s) => { s.settings.lastBackupAt = backup.exportedAt; });
  const before = plain(env.store.get());

  const fresh = setup();
  fresh.store.load();
  fresh.store.importBackup(JSON.stringify(backup));
  assert.deepEqual(plain(fresh.store.get()), before);
  assert.deepEqual(plain(fresh.store.get()), plain(backup.state));
});

test('importBackup validates with plain messages and changes nothing on error', () => {
  const env = setup();
  env.store.load();
  const before = env.store.get();
  const bad = [
    ['{nope', /not a valid backup/],
    [{ app: 'iets-anders', state: {} }, /not a backup from this budget app/],
    [[], /not a backup from this budget app/],
    [{ app: 'budget-nl', version: 2, state: {} }, /newer version/],
    [{ app: 'budget-nl', version: 1 }, /incomplete/],
    [{ app: 'budget-nl', version: 1, state: { transactions: {} } }, /list of payments is damaged/],
    [{ app: 'budget-nl', version: 1, state: { transactions: [{ date: '2026-02-30', amount: 1 }] } }, /Payment 1 is damaged/],
    [{ app: 'budget-nl', version: 1, state: { transactions: [fakeTx({ amount: '12' })] } }, /Payment 1/],
    [{ app: 'budget-nl', version: 1, state: { statements: [{ month: 'sep' }] } }, /Statement 1 is damaged/],
    [{ app: 'budget-nl', version: 1, state: { rules: [{ match: {} }] } }, /Rule 1 is damaged/],
    [{ app: 'budget-nl', version: 1, state: { version: 3 } }, /newer version/],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => env.store.importBackup(input), (err) => message.test(err.message), JSON.stringify(input));
  }
  assert.equal(env.store.get(), before);
});

test('importBackup is undoable', () => {
  const env = setup();
  env.store.load();
  env.store.update((s) => { s.settings.savingsGoal = 777; });
  env.store.importBackup(fakeBackup());
  assert.equal(env.store.get().settings.savingsGoal, 20000);
  assert.equal(env.store.undo(), 'Backup restored');
  assert.equal(env.store.get().settings.savingsGoal, 777);
});

test('loadSeedIfEmpty: only on first run; persisted so it is not loaded again', () => {
  const storage = memoryStorage();
  const env = setup({ storage });
  env.store.load();
  const sources = [];
  env.store.on('change', (s, info) => sources.push(info.source));
  assert.equal(env.store.loadSeedIfEmpty(null), false);
  assert.equal(env.store.loadSeedIfEmpty(fakeBackup()), true);
  assert.deepEqual(sources, ['seed']);
  assert.equal(stored(env).transactions.length, 1, 'seed saved at once');

  const second = setup({ storage });
  second.store.load();
  second.store.update((s) => { s.transactions = []; });
  second.runTimers();
  const third = setup({ storage });
  third.store.load();
  assert.equal(third.store.loadSeedIfEmpty(fakeBackup()), false, 'user emptied it: seed stays out');
  assert.equal(third.store.get().transactions.length, 0);
});

test('loadSeedIfEmpty: an invalid seed is reported, not thrown', () => {
  const env = setup();
  env.store.load();
  assert.equal(env.store.loadSeedIfEmpty({ app: 'budget-nl', state: { transactions: [{}] } }), false);
  assert.equal(env.errors.length, 1);
  assert.equal(env.store.get().transactions.length, 0);
});

test('reset empties everything and is undoable', () => {
  const env = setup();
  env.store.load();
  env.store.importBackup(fakeBackup());
  env.store.reset();
  assert.deepEqual(plain(env.store.get()), plain(env.store.emptyState()));
  assert.deepEqual(plain(stored(env)), plain(env.store.emptyState()), 'written immediately');
  assert.equal(env.store.undo(), 'Everything cleared');
  assert.equal(env.store.get().transactions.length, 1);
});

test('migrate: missing version is 1, newer version refused', () => {
  const { store } = setup();
  assert.equal(store.migrate({ transactions: [] }).version, 1);
  assert.equal(store.migrate({ version: 1 }).version, 1);
  assert.throws(() => store.migrate({ version: 2 }), (err) => /newer version/.test(err.message));
  assert.throws(() => store.migrate({ version: 0 }), (err) => /unknown/.test(err.message));
});

test('load normalizes old/partial data and keeps custom categories after the built-in ones', () => {
  const partial = {
    categories: [{ id: 'huur', name: 'Oud', kind: 'fixed', color: '#000', colorDark: '#000' },
      { id: 'hobby', name: 'Hobby', kind: 'oneoff', color: '#111', colorDark: '#222' }],
    transactions: [{ date: '2026-08-01', amount: -500, categoryId: 'hobby', name: 'Winkel' }],
  };
  const env = setup({ storage: memoryStorage({ [KEY]: JSON.stringify(partial) }) });
  assert.equal(env.store.load().ok, true);
  const s = env.store.get();
  assert.deepEqual(plain(s.categories.map((c) => c.id)),
    ['inkomen', 'huur', 'zorg', 'vast', 'dagelijks', 'eenmalig', 'sparen', 'onbekend', 'hobby']);
  assert.equal(s.categories[1].name, 'Rent', 'built-in definitions win');
  assert.equal(s.transactions[0].kind, 'eenmalig', 'default kind from the custom category kind');
  assert.deepEqual(plain(s.statements), []);
  assert.deepEqual(plain(s.normalAmounts), {});
});

test('another tab saving: its state is adopted and the pending save is dropped', () => {
  const env = setup();
  env.store.load();
  env.store.update((s) => { s.settings.savingsGoal = 1; }, { undoLabel: 'x' });
  const sources = [];
  env.store.on('change', (s, info) => sources.push(info.source));
  env.fire('storage', { key: 'iets anders', newValue: '{}' });
  env.fire('storage', { key: KEY, newValue: 'kapot' });
  assert.deepEqual(sources, [], 'foreign keys and corrupt values ignored');
  env.fire('storage', { key: KEY, newValue: JSON.stringify(fakeBackup().state) });
  assert.deepEqual(sources, ['other-tab']);
  assert.equal(env.store.get().transactions.length, 1);
  assert.equal(env.store.canUndo(), false);
  assert.equal(env.pendingTimers(), 0, 'no stale save overwrites the other tab');
});
