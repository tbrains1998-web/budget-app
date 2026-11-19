/* Budget.store: the single app state, its persistence in localStorage, validation/migration, backups,
   undo and change events. The state returned by get() is deep-frozen: change it only through update(). */
(function () {
  'use strict';

  const Budget = (globalThis.Budget = globalThis.Budget || {});
  const util = Budget.util;

  const KEY = 'budget-nl:v1';
  const VERSION = 1;
  const SAVE_DELAY_MS = 300;
  const UNDO_LIMIT = 20;
  const TX_KINDS = Object.freeze(['elke-maand', 'wisselend', 'eenmalig', 'telt-niet-mee']);
  const KIND_FOR_CATEGORY_KIND = Object.freeze({
    income: 'elke-maand',
    fixed: 'elke-maand',
    daily: 'wisselend',
    oneoff: 'eenmalig',
    transfer: 'telt-niet-mee',
    unknown: 'wisselend',
  });
  const CATEGORY_KINDS = Object.keys(KIND_FOR_CATEGORY_KIND);
  const PAYEE_ID_RE = /^p_[0-9a-f]{16}$/;
  const NORMAL_KEY_RE = /^(in|uit):p_[0-9a-f]{16}$/;

  // Rules never keep hidden words or the holder's name/address Data written by an older
  // version may still have such rules: they are cleaned when that data is read (load, backup, seed). Needs
  // Budget.categorize (loaded after the store; absent in store-only contexts such as the build's seed check).
  function withCleanRules(next) {
    const categorize = Budget.categorize;
    if (!categorize || typeof categorize.cleanRules !== 'function' || !next.rules.length) return next;
    try {
      const draft = clone(next);
      return categorize.cleanRules(draft) ? normalizeState(draft) : next;
    } catch (err) {
      console.error('Budget: cleaning rules failed', err);
      return next; // never let this make good data look damaged
    }
  }

  const DEFAULT_CATEGORIES = deepFreeze([
    { id: 'inkomen', name: 'Income', kind: 'income', color: '#15803d', colorDark: '#4ade80' },
    { id: 'huur', name: 'Rent', kind: 'fixed', color: '#7c3aed', colorDark: '#a78bfa' },
    { id: 'zorg', name: 'Health & insurance', kind: 'fixed', color: '#0e7490', colorDark: '#22d3ee' },
    { id: 'vast', name: 'Fixed costs & subscriptions', kind: 'fixed', color: '#2563eb', colorDark: '#60a5fa' },
    { id: 'dagelijks', name: 'Daily spending', kind: 'daily', color: '#ea580c', colorDark: '#fb923c' },
    { id: 'eenmalig', name: 'One-off', kind: 'oneoff', color: '#db2777', colorDark: '#f472b6' },
    { id: 'sparen', name: 'Savings & own accounts', kind: 'transfer', color: '#98a2b3', colorDark: '#6b7585' },
    { id: 'onbekend', name: 'Not sorted yet (?)', kind: 'unknown', color: '#9ca3af', colorDark: '#6b7280' },
  ]);
  const DEFAULT_IDS = new Set(DEFAULT_CATEGORIES.map((c) => c.id));

  // Upgrade steps: MIGRATIONS[i] turns a version i+1 state into version i+2. Version 1 is the first format.
  const MIGRATIONS = [];

  let state = deepFreeze(emptyState());
  let loaded = false; // nothing is written before load() has read what is stored
  let hasStored = false; // storage holds (or held, when corrupt) a state: the seed must not be loaded
  let readFailed = false; // storage could not be read: never write, or real data could be overwritten
  let protectCorrupt = false; // corrupt data could not be copied aside: don't overwrite it until the user chooses
  let writeOk = true;
  let dirty = false;
  let saveTimer = null;
  const undoStack = [];
  const listeners = new Map();

  // ---- helpers -----------------------------------------------------------------------------------

  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function text(value) {
    if (typeof value === 'string') return value;
    return value === null || value === undefined ? '' : String(value);
  }

  function centsOrNull(value) {
    return isNumber(value) ? Math.round(value) + 0 : null;
  }

  function stringOrNull(value) {
    return typeof value === 'string' ? value : null;
  }

  function list(value, what) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error(`The list of ${what} is damaged.`);
    return value;
  }

  function freshId(value, prefix, seen) {
    const id = typeof value === 'string' && value && !seen.has(value) ? value : util.uid(prefix);
    seen.add(id);
    return id;
  }

  function emptyState() {
    return {
      version: VERSION,
      categories: clone(DEFAULT_CATEGORIES),
      transactions: [],
      statements: [],
      rules: [],
      normalAmounts: {},
      settings: { savingsGoal: 0, hiddenWords: [], lastBackupAt: null, lastImportAt: null, privacySalt: null, privateTokenHashes: [] },
    };
  }

  // 'in' for payments in an income-kind category, 'uit' for a fixed-kind category, else null.
  function sideOf(categoryId, categories = state.categories) {
    const category = categories.find((c) => c.id === categoryId);
    if (!category) return null;
    if (category.kind === 'income') return 'in';
    if (category.kind === 'fixed') return 'uit';
    return null;
  }

  // Default kind of a payment in a category when no rule says otherwise.
  function defaultKind(categoryId, categories = state.categories) {
    const category = categories.find((c) => c.id === categoryId);
    return KIND_FOR_CATEGORY_KIND[category ? category.kind : 'unknown'] || 'wisselend';
  }

  // ---- validation --------------------------------------------------------------------------------

  // Brings an older state up to VERSION. A missing version counts as 1.
  function migrate(input) {
    const from = input.version === undefined ? 1 : input.version;
    if (!Number.isInteger(from) || from < 1) throw new Error('The version of the data is unknown.');
    if (from > VERSION) throw new Error('This data comes from a newer version of the app.');
    let result = input;
    for (let v = from; v < VERSION; v++) result = MIGRATIONS[v - 1](result);
    return { ...result, version: VERSION };
  }

  // The built-in categories always come from DEFAULT_CATEGORIES (in that order); extra ones are kept.
  function normalizeCategories(value) {
    const result = clone(DEFAULT_CATEGORIES);
    const seen = new Set(DEFAULT_IDS);
    list(value, 'categories').forEach((c, i) => {
      if (!isObject(c) || typeof c.id !== 'string' || !c.id) throw new Error(`Category ${i + 1} is damaged.`);
      if (seen.has(c.id)) return;
      seen.add(c.id);
      result.push({
        ...c,
        name: text(c.name) || c.id,
        kind: CATEGORY_KINDS.includes(c.kind) ? c.kind : 'unknown',
        color: text(c.color),
        colorDark: text(c.colorDark),
      });
    });
    return result;
  }

  function normalizeTransaction(tx, i, categories, known, ids) {
    if (!isObject(tx) || !util.isValidDate(tx.date) || !isNumber(tx.amount)) {
      throw new Error(`Payment ${i + 1} is damaged (the date or amount is wrong).`);
    }
    const categoryId = known.has(tx.categoryId) ? tx.categoryId : 'onbekend';
    const name = text(tx.name);
    return {
      ...tx,
      id: freshId(tx.id, 't', ids),
      // Who the payment is with; never changes when the name is edited. Missing (old data, hand-made payments):
      // made from the current name.
      payeeId: typeof tx.payeeId === 'string' && PAYEE_ID_RE.test(tx.payeeId) ? tx.payeeId : util.payeeId(name),
      month: util.isValidMonth(tx.month) ? tx.month : util.monthOf(tx.date),
      name,
      description: text(tx.description),
      amount: Math.round(tx.amount) + 0,
      categoryId,
      kind: TX_KINDS.includes(tx.kind) ? tx.kind : defaultKind(categoryId, categories),
      type: text(tx.type),
      bankCode: typeof tx.bankCode === 'string' && /^[A-Z]{4}$/.test(tx.bankCode) ? tx.bankCode : '',
      source: text(tx.source),
      fingerprint: text(tx.fingerprint),
    };
  }

  function normalizeStatement(s, i) {
    if (!isObject(s) || !util.isValidMonth(s.month)) throw new Error(`Statement ${i + 1} is damaged.`);
    return {
      ...s,
      periodFrom: stringOrNull(s.periodFrom),
      periodTo: stringOrNull(s.periodTo),
      startBalance: centsOrNull(s.startBalance),
      endBalance: centsOrNull(s.endBalance),
      totalIn: centsOrNull(s.totalIn),
      totalOut: centsOrNull(s.totalOut),
      source: text(s.source),
      importedAt: stringOrNull(s.importedAt),
    };
  }

  // match.payeeId: a payee rule; an id in any other form is dropped (a rule with nothing left
  // to match on never matches).
  function normalizeRule(rule, i, ids) {
    if (!isObject(rule) || !isObject(rule.match) || !isObject(rule.set)) throw new Error(`Rule ${i + 1} is damaged.`);
    let match = rule.match;
    if (match.payeeId !== undefined) {
      const { payeeId, ...rest } = match;
      const id = typeof payeeId === 'string' ? payeeId.trim().toLowerCase() : '';
      match = PAYEE_ID_RE.test(id) ? { ...rest, payeeId: id } : rest;
    }
    return { ...rule, match, id: freshId(rule.id, 'r', ids), createdAt: stringOrNull(rule.createdAt) };
  }

  // normalAmounts: { '<side>:<payeeId>': positive cents }. Keys of the first format (a lowercased
  // display name) are converted by finding the 'every month' income/fixed payments with that name; when such a
  // payee has both sides, the side its payments add up to wins (the old meaning). Old keys that match no payment
  // are dropped; a new-format key always wins over a converted one.
  function normalizeAmounts(value, transactions, categories) {
    if (value === undefined || value === null) return {};
    if (!isObject(value)) throw new Error('The usual amounts are damaged.');
    const result = {};
    const old = [];
    for (const [key, cents] of Object.entries(value)) {
      if (!isNumber(cents)) continue;
      if (NORMAL_KEY_RE.test(key)) result[key] = Math.abs(Math.round(cents)) + 0;
      else old.push([key, cents]);
    }
    if (!old.length) return result;
    const byName = new Map(); // old key -> [{side, payeeId, amount}]
    for (const tx of transactions) {
      const side = tx.kind === 'elke-maand' ? sideOf(tx.categoryId, categories) : null;
      if (!side) continue;
      const key = tx.name.trim().toLowerCase();
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push({ side, payeeId: tx.payeeId, amount: tx.amount });
    }
    for (const [key, cents] of old) {
      const payees = byName.get(String(key).trim().toLowerCase());
      if (!payees) continue;
      const sides = new Set(payees.map((p) => p.side));
      let side = [...sides][0];
      if (sides.size > 1) {
        const sum = payees.reduce((s, p) => s + p.amount, 0);
        side = sum > 0 || (sum === 0 && cents > 0) ? 'in' : 'uit';
      }
      for (const p of payees) {
        const newKey = `${side}:${p.payeeId}`;
        if (p.side === side && !(newKey in result)) result[newKey] = Math.abs(Math.round(cents)) + 0;
      }
    }
    return result;
  }

  function normalizeSettings(value) {
    if (value === undefined || value === null) value = {};
    if (!isObject(value)) throw new Error('The settings are damaged.');
    const hashes = Array.isArray(value.privateTokenHashes)
      ? value.privateTokenHashes.filter((h) => typeof h === 'string' && /^[0-9a-f]{8,128}$/.test(h)) : [];
    return {
      ...value,
      savingsGoal: isNumber(value.savingsGoal) && value.savingsGoal > 0 ? Math.round(value.savingsGoal) : 0,
      hiddenWords: Array.isArray(value.hiddenWords) ? value.hiddenWords.filter((w) => typeof w === 'string') : [],
      lastBackupAt: stringOrNull(value.lastBackupAt),
      lastImportAt: stringOrNull(value.lastImportAt),
      // Salted hashes of the account holder's name/address parts; never the text itself.
      privacySalt: typeof value.privacySalt === 'string' && /^[0-9a-f]{16,128}$/.test(value.privacySalt) ? value.privacySalt : null,
      privateTokenHashes: [...new Set(hashes)],
    };
  }

  // Returns a complete, valid copy of a state. Fills defaults for missing fields, keeps unknown fields,
  // throws an Error with a plain message when the structure is broken.
  function normalizeState(input) {
    if (!isObject(input)) throw new Error('This data is not a budget.');
    const src = migrate(input);
    const categories = normalizeCategories(src.categories);
    const known = new Set(categories.map((c) => c.id));
    const txIds = new Set();
    const ruleIds = new Set();
    const transactions = list(src.transactions, 'payments')
      .map((tx, i) => normalizeTransaction(tx, i, categories, known, txIds));
    return {
      ...src,
      version: VERSION,
      categories,
      transactions,
      statements: list(src.statements, 'statements').map(normalizeStatement),
      rules: list(src.rules, 'rules').map((rule, i) => normalizeRule(rule, i, ruleIds)),
      normalAmounts: normalizeAmounts(src.normalAmounts, transactions, categories),
      settings: normalizeSettings(src.settings),
    };
  }

  // Accepts a backup object or its JSON text; returns the normalized state or throws a plain message.
  function parseBackup(input) {
    let backup = input;
    if (typeof backup === 'string') {
      try {
        backup = JSON.parse(backup);
      } catch {
        throw new Error('This file is not a valid backup.');
      }
    }
    if (!isObject(backup) || backup.app !== 'budget-nl') throw new Error('This file is not a backup from this budget app.');
    if (isNumber(backup.version) && backup.version > VERSION) {
      throw new Error('This backup comes from a newer version of the app.');
    }
    if (!isObject(backup.state)) throw new Error('This backup is incomplete.');
    let next;
    try {
      next = normalizeState(backup.state);
    } catch (err) {
      throw new Error(`This backup can't be restored. ${err.message}`);
    }
    return withCleanRules(next);
  }

  // ---- persistence -------------------------------------------------------------------------------

  function storage() {
    return globalThis.localStorage;
  }

  function storageOk() {
    return writeOk && !readFailed && !protectCorrupt;
  }

  function write() {
    if (!loaded || readFailed || protectCorrupt) return;
    const before = storageOk();
    try {
      storage().setItem(KEY, JSON.stringify(state));
      writeOk = true;
      hasStored = true;
    } catch {
      writeOk = false;
      dirty = true; // try again on the next flush
    }
    if (before !== storageOk()) emit({ source: 'storage', undoLabel: null, undoToken: null });
  }

  function flush() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!dirty) return;
    dirty = false;
    write();
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DELAY_MS);
  }

  function cancelSave() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
    dirty = false;
  }

  function probeWrite() {
    try {
      storage().setItem(`${KEY}:probe`, '1');
      storage().removeItem(`${KEY}:probe`);
      return true;
    } catch {
      return false;
    }
  }

  // Copies corrupt data aside under `${KEY}:corrupt-<ts>`, once: reloading with the same corrupt data reuses
  // the earlier copy. Returns the key, or null when the copy could not be stored.
  function keepCorrupt(raw) {
    try {
      const ls = storage();
      for (let i = 0; i < ls.length; i++) {
        const key = ls.key(i);
        if (key && key.startsWith(`${KEY}:corrupt-`) && ls.getItem(key) === raw) return key;
      }
      const key = `${KEY}:corrupt-${Date.now()}`;
      ls.setItem(key, raw);
      return key;
    } catch {
      return null;
    }
  }

  function isEmpty(s) {
    return s.transactions.length === 0 && s.statements.length === 0;
  }

  // Reads the stored state. Never throws. Returns {ok, empty, corrupt, storage} and for corrupt data also
  // {backupKey (null when it could not be copied aside), error}. Does not emit 'change'.
  function load() {
    cancelSave();
    undoStack.length = 0;
    state = deepFreeze(emptyState());
    loaded = true;
    protectCorrupt = false;
    let raw;
    try {
      raw = storage().getItem(KEY);
      readFailed = false;
    } catch {
      readFailed = true;
      hasStored = false;
      return { ok: true, empty: true, corrupt: false, storage: false };
    }
    writeOk = probeWrite();
    hasStored = raw !== null;
    if (raw === null) return { ok: true, empty: true, corrupt: false, storage: storageOk() };
    let read;
    try {
      read = normalizeState(JSON.parse(raw));
    } catch (err) {
      const backupKey = keepCorrupt(raw);
      protectCorrupt = backupKey === null;
      return { ok: false, empty: true, corrupt: true, storage: storageOk(), backupKey, error: err.message };
    }
    state = deepFreeze(withCleanRules(read));
    if (state !== read) scheduleSave(); // the stored copy loses the old rule text too
    return { ok: true, empty: isEmpty(state), corrupt: false, storage: storageOk() };
  }

  // ---- state changes -----------------------------------------------------------------------------

  function emit(info) {
    for (const cb of listeners.get('change') || []) {
      try {
        cb(state, info);
      } catch (err) {
        console.error('Budget: error in a change listener', err);
      }
    }
  }

  // Swaps in a new state. With an undoLabel the previous state goes on the undo stack under a new unique undo
  // token, which is returned (else null). A change without a label clears the stack, so an undo never silently
  // throws away later changes, unless keepUndo is set (bookkeeping such as lastBackupAt).
  function commit(next, { undoLabel, source, keepUndo = false }) {
    let undoToken = null;
    if (undoLabel) {
      undoToken = util.uid('u');
      undoStack.push({ state, label: undoLabel, token: undoToken });
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    } else if (!keepUndo) {
      undoStack.length = 0;
    }
    state = deepFreeze(next);
    scheduleSave();
    emit({ source, undoLabel: undoLabel || null, undoToken });
    return undoToken;
  }

  function get() {
    return state;
  }

  /**
   * fn mutates a draft copy of the state (its return value is ignored). The result is validated, saved (debounced)
   * and announced. If fn or the validation throws, nothing changes and the error is rethrown.
   * Returns the undo token (a string) when undoLabel is given, else null.
   * {keepUndo: true}: a change without undoLabel that leaves the undo stack alone (e.g. settings.lastBackupAt).
   */
  function update(fn, { undoLabel, keepUndo = false } = {}) {
    const draft = clone(state);
    fn(draft);
    return commit(normalizeState(draft), { undoLabel, source: 'update', keepUndo });
  }

  // The later of two ISO times (null when neither is a time).
  function newerTime(a, b) {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (!Number.isFinite(ta)) return Number.isFinite(tb) ? b : null;
    if (!Number.isFinite(tb)) return a;
    return tb > ta ? b : a;
  }

  // Undo puts back an older state, but never an older lastBackupAt (the backup really was made: the newer of the
  // two is kept, also when the current state was wiped by "Clear everything"), and never forgets the privacy hashes
  // learned since; the restored payments and rules are cleaned with them.
  function carryOver(restored, current) {
    const from = current.settings;
    const had = restored.settings.privateTokenHashes || [];
    const settings = { ...restored.settings, lastBackupAt: newerTime(restored.settings.lastBackupAt, from.lastBackupAt) };
    let learned = false;
    if (from.privacySalt && (!restored.settings.privacySalt || restored.settings.privacySalt === from.privacySalt)) {
      settings.privacySalt = from.privacySalt;
      settings.privateTokenHashes = [...new Set([...had, ...from.privateTokenHashes])];
      learned = settings.privacySalt !== restored.settings.privacySalt || settings.privateTokenHashes.length > had.length;
    }
    const next = { ...restored, settings };
    const categorize = Budget.categorize;
    if (!learned || !categorize || typeof categorize.recleanState !== 'function') return deepFreeze(next);
    const draft = clone(next); // the older payments lose the holder's name/address too
    categorize.recleanState(draft);
    return deepFreeze(draft);
  }

  /**
   * Restores the state from before the newest change that had an undoLabel and returns that label, or null.
   * undo(token): only when the newest undoable change is the one with that token; otherwise nothing changes and
   * the result is null. undo() / undo(null): the newest one, whatever it is.
   */
  function undo(token) {
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return null;
    if (token !== undefined && token !== null && token !== entry.token) return null;
    undoStack.pop();
    state = carryOver(entry.state, state);
    scheduleSave();
    emit({ source: 'undo', undoLabel: entry.label, undoToken: entry.token });
    return entry.label;
  }

  // canUndo(): anything to undo; canUndo(token): undo(token) would do something.
  function canUndo(token) {
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return false;
    return token === undefined || token === null || token === entry.token;
  }

  // The token of the newest undoable change (e.g. right after reset() or importBackup()), or null.
  function topUndoToken() {
    const entry = undoStack[undoStack.length - 1];
    return entry ? entry.token : null;
  }

  function on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(cb);
    return () => listeners.get(event).delete(cb);
  }

  // A backup of the current state. Its copy has settings.lastBackupAt = exportedAt; after a successful
  // download the caller should store the same value so a later restore gives an identical state.
  function exportBackup() {
    const exportedAt = new Date().toISOString();
    const copy = clone(state);
    copy.settings.lastBackupAt = exportedAt;
    return { app: 'budget-nl', version: VERSION, exportedAt, state: copy };
  }

  // Replaces the whole state with a backup (object or JSON text). Throws an Error with a plain message.
  function importBackup(backup) {
    const next = parseBackup(backup);
    protectCorrupt = false;
    commit(next, { undoLabel: 'Backup restored', source: 'backup' });
    flush();
    return state;
  }

  // Loads the embedded seed (a backup object) on first run only, i.e. when nothing is stored yet.
  function loadSeedIfEmpty(seed) {
    if (!seed || hasStored) return false;
    let next;
    try {
      next = parseBackup(seed);
    } catch (err) {
      console.error('Budget: the built-in data is not valid:', err.message);
      return false;
    }
    undoStack.length = 0;
    state = deepFreeze(next);
    dirty = true;
    flush();
    emit({ source: 'seed', undoLabel: null, undoToken: null });
    return true;
  }

  // Wipes everything back to an empty state ("Clear everything" / "Start over"); undoable.
  function reset() {
    protectCorrupt = false;
    commit(emptyState(), { undoLabel: 'Everything cleared', source: 'reset' });
    flush();
    return state;
  }

  // Another tab of the app saved: adopt its state instead of overwriting it later with an older one.
  function onStorageEvent(event) {
    if (event.key !== KEY || typeof event.newValue !== 'string' || !loaded || readFailed) return;
    let next;
    try {
      next = normalizeState(JSON.parse(event.newValue));
    } catch {
      return;
    }
    cancelSave();
    undoStack.length = 0;
    hasStored = true;
    protectCorrupt = false;
    state = deepFreeze(next);
    emit({ source: 'other-tab', undoLabel: null, undoToken: null });
  }

  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('pagehide', flush);
    globalThis.addEventListener('storage', onStorageEvent);
  }
  if (globalThis.document && typeof globalThis.document.addEventListener === 'function') {
    globalThis.document.addEventListener('visibilitychange', () => {
      if (globalThis.document.visibilityState === 'hidden') flush();
    });
  }

  Budget.store = {
    KEY,
    VERSION,
    TX_KINDS,
    DEFAULT_CATEGORIES,
    load,
    get,
    update,
    undo,
    canUndo,
    topUndoToken,
    on,
    exportBackup,
    importBackup,
    loadSeedIfEmpty,
    storageOk,
    reset,
    flush,
    defaultKind,
    sideOf,
    emptyState,
    migrate,
  };
})();
