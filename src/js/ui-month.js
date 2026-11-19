/* Budget.uiMonth: the month screen — tiles, colour bar, savings card, recap, the grouped payment list with
   inline editing and a row popover, "+ Add" and the "My normal month" editor.
   All bank-derived text reaches the page as text nodes (Budget.ui.el), never as markup. */
(function () {
  'use strict';

  const Budget = (globalThis.Budget = globalThis.Budget || {});

  const KIND_LABELS = {
    'elke-maand': 'every month',
    wisselend: 'varies',
    eenmalig: 'one-off',
    'telt-niet-mee': "doesn't count",
  };
  // Category kinds whose payments are spending (the colour bar and "Left this month").
  const SPEND_KINDS = new Set(['fixed', 'daily', 'oneoff', 'unknown']);
  const GROUP_NOTES = {
    inkomen: 'what came in',
    huur: 'your home',
    zorg: 'health insurance and other insurance',
    vast: 'subscriptions, energy, phone',
    dagelijks: 'groceries, shops, cash',
    eenmalig: 'now and then, not every month',
    sparen: "between your own accounts — doesn't count",
  };
  const UNKNOWN_HINT = 'Click a payment to choose what it is';
  // A month the bank has not booked yet: it only holds payments made earlier for it, or added by hand.
  const NOT_BOOKED_NOTE = 'This month has not been read yet. It only shows payments that were made earlier for this month.';
  const NOT_BOOKED_HAND_NOTE = 'This month has not been read yet. It only shows payments you added yourself.';
  const DATE_EXAMPLE = '1-10-2026';
  const MOVE_WINDOW = 2; // "Belongs to month" offers the payment month ± this many months
  const POP_GAP = 6; // px between a row and its popover
  const POP_MARGIN = 12; // px the popover keeps from the window edges
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // The tiles in screen order: [key (calc.tileBreakdown section, 'left' = Left this month), class, label, note].
  const TILES = [
    ['income', 'tile-in', 'Income', 'what came in'],
    ['fixed', 'tile-fixed', 'Fixed costs', 'rent, health and fixed costs'],
    ['daily', 'tile-daily', 'Daily spending', 'groceries, shops, cash'],
    ['oneoff', 'tile-oneoff', 'One-off', 'single purchases, now and then'],
    ['left', 'tile-left', 'Left this month', 'income minus spending'],
  ];
  const TILE_TITLES = {
    income: 'Income',
    fixed: 'Fixed costs',
    daily: 'Daily spending',
    oneoff: 'One-off',
    unknown: 'Not sorted yet',
    left: 'Left this month',
  };

  // ---------------------------------------------------------------- pure helpers (no DOM)

  function catTitle(category) {
    return category.kind === 'unknown' ? 'Not sorted yet' : category.name;
  }

  /** Inline style giving a category's colour as --c (CSS variable per id, the stored colour as fallback). */
  function colorStyle(category) {
    const fallback = /^#[0-9a-f]{3,8}$/i.test(category.color || '') ? category.color : 'var(--text-muted)';
    return /^[a-z0-9-]+$/i.test(category.id) ? `--c: var(--cat-${category.id}, ${fallback})` : `--c: ${fallback}`;
  }

  /** Cents → editable text without sign or thousands separators: -123456 → '1234.56'. */
  function plainAmount(cents) {
    return (Math.abs(cents) / 100).toFixed(2);
  }

  /** '2026-10-01' → '01-10-2026', the way the date field shows it. */
  function isoToNl(iso) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '';
  }

  /** Default date of "+ Add": today when today falls in the month on screen (or there is none), else its 1st. */
  function defaultAddDate(month, today) {
    return !month || String(today).startsWith(month) ? today : `${month}-01`;
  }

  /**
   * Amount typed in an inline editor → cents, or null when it is not a usable amount.
   * Without an explicit + or − the payment keeps its direction: typing 12.50 on an expense gives −1250.
   */
  function parseAmountInput(text, currentAmount) {
    const cents = Budget.util.parseEuro(text);
    if (!cents) return null;
    const explicit = /^[-−–+]/.test(String(text).replace(/[\s€⁠​]+/g, ''));
    if (explicit) return cents;
    return currentAmount < 0 ? -Math.abs(cents) : Math.abs(cents);
  }

  /**
   * The payments shown for a month, grouped by category: everything that counts in the month or was paid
   * in it. "Not sorted yet" comes first, then the categories in their usual order; empty groups are left out.
   * item.counts is false for faded rows (doesn't count, or moved to another month).
   */
  function listForMonth(state, month) {
    const { monthOf } = Budget.util;
    const byCat = new Map(state.categories.map((c) => [c.id, []]));
    const fallback = state.categories.find((c) => c.kind === 'unknown') || state.categories[0];
    for (const tx of state.transactions) {
      const paidMonth = monthOf(tx.date);
      if (tx.month !== month && paidMonth !== month) continue;
      const list = byCat.get(tx.categoryId) || byCat.get(fallback.id);
      list.push({
        tx,
        counts: tx.month === month && tx.kind !== 'telt-niet-mee',
        countsIn: tx.month !== month ? tx.month : null,
        paidIn: paidMonth !== month ? paidMonth : null,
      });
    }
    const ordered = [
      ...state.categories.filter((c) => c.kind === 'unknown'),
      ...state.categories.filter((c) => c.kind !== 'unknown'),
    ];
    return ordered
      .filter((category) => byCat.get(category.id).length)
      .map((category) => {
        const items = byCat
          .get(category.id)
          .sort((a, b) => b.tx.date.localeCompare(a.tx.date) || a.tx.name.localeCompare(b.tx.name, 'en'));
        const counted = items.filter((i) => i.counts);
        const shown = counted.length ? counted : items;
        return {
          category,
          items,
          total: shown.reduce((sum, i) => sum + i.tx.amount, 0),
          faded: !counted.length,
        };
      });
  }

  /** Colour bar: spending per category plus "Left" (relative to income), or relative to spending on a shortfall. */
  function barView(summary, categories) {
    const parts = categories
      .filter((c) => SPEND_KINDS.has(c.kind) && -summary.byCategory[c.id] > 0)
      .map((c) => ({ id: c.id, label: catTitle(c), style: colorStyle(c), value: -summary.byCategory[c.id] }));
    const spent = parts.reduce((sum, p) => sum + p.value, 0);
    if (summary.left > 0) parts.push({ id: 'over', label: 'Left', style: '--c: var(--cat-over)', value: summary.left });
    const shortfall = summary.left < 0 ? -summary.left : 0;
    return { parts, shortfall, total: shortfall ? spent : summary.income };
  }

  /** Share of a legend part: '60%'; a part that is not zero but rounds to 0 % shows '<1%'; '' without a total. */
  function pctLabel(value, total) {
    if (!(total > 0)) return '';
    const pct = Math.round((value / total) * 100);
    return pct === 0 && value > 0 ? '<1%' : `${pct}%`;
  }

  /**
   * Rows of "What really happened" (rows of €0 hidden, saldo rows only when a statement gives them) and how much
   * the balance changed: the statement's end − start when known, else the sum of the rows.
   */
  function recapView(recap) {
    const lines = [
      ['Normal income', recap.normalIncome],
      [recap.extraIncome < 0 ? 'Less than normal' : 'Extra income (one-off/more than normal)', recap.extraIncome],
      ['Fixed costs', recap.fixed],
      ['Daily spending', recap.daily],
      ['One-off spending', recap.oneoff],
      ['Not sorted yet', recap.unknown],
      ['Paid for another month', recap.paidForOtherMonth],
      ['Already paid in an earlier month', recap.paidInEarlierMonth],
      ['Will be paid in a later month', recap.paidInLaterMonth],
      ['Savings & own accounts (net)', recap.transfersNet],
      ['Added by you, not via the bank', recap.notViaBank],
    ];
    const rows = lines.filter(([, value]) => value).map(([label, value]) => ({ label, value, saldo: false }));
    const known = recap.startBalance !== null && recap.endBalance !== null;
    if (recap.startBalance !== null) rows.unshift({ label: 'Balance at start of month', value: recap.startBalance, saldo: true });
    if (recap.endBalance !== null) rows.push({ label: 'Balance at end of month', value: recap.endBalance, saldo: true });
    return { rows, change: known ? recap.endBalance - recap.startBalance : recap.change };
  }

  /**
   * The calm note at the top of a month the bank has not booked yet, or null for a booked month.
   * Only hand-added payments in it: says so; otherwise (payments moved there) the standard text.
   */
  function notBookedNote(state, month) {
    const { calc, util } = Budget;
    if (!month || calc.isBookedMonth(state, month)) return null;
    const own = state.transactions.filter((t) => t.month === month || util.monthOf(t.date) === month);
    const onlyHand = own.length > 0 && own.every((t) => t.source === 'hand' && util.monthOf(t.date) === month);
    return onlyHand ? NOT_BOOKED_HAND_NOTE : NOT_BOOKED_NOTE;
  }

  /** The months the savings plan reads (calc.normalMonth): the last (up to) 3 booked months. */
  function planMonths(state) {
    const { calc, util } = Budget;
    const booked = calc.bookedMonths(state);
    const months = booked.length ? booked : [...new Set(state.transactions.map((t) => util.monthOf(t.date)))].sort();
    return months.slice(-3);
  }

  /** How many counted 'Not sorted yet' payments the plan's months hold (they are not in the plan yet). */
  function planUnknowns(state) {
    const months = new Set(planMonths(state));
    const kinds = new Map(state.categories.map((c) => [c.id, c.kind]));
    return state.transactions.filter(
      (t) => months.has(t.month) && t.kind !== 'telt-niet-mee' && (kinds.get(t.categoryId) || 'unknown') === 'unknown',
    ).length;
  }

  function planUnknownsText(count) {
    if (!count) return null;
    return `${count} ${count === 1 ? 'payment' : 'payments'} still to sort — then this number is right`;
  }

  /** Months offered in "Belongs to month": the payment month ± MOVE_WINDOW, plus where it counts now. */
  function monthOptions(tx) {
    const { monthOf, addMonths } = Budget.util;
    const paid = monthOf(tx.date);
    const months = new Set([tx.month]);
    for (let n = -MOVE_WINDOW; n <= MOVE_WINDOW; n++) months.add(addMonths(paid, n));
    return [...months].sort();
  }

  function matchKey(match) {
    return JSON.stringify(
      Object.keys(match || {})
        .filter((k) => match[k] !== undefined && match[k] !== null && match[k] !== '')
        .sort()
        .map((k) => [k, String(match[k]).toLowerCase()]),
    );
  }

  /**
   * Adds a rule, or merges its `set` into an existing rule with the same match ("creates/updates a rule"). An
   * updated rule gets the new rule's createdAt, so it counts as the newest (user rules are tried newest first).
   */
  function upsertRule(rules, rule) {
    const key = matchKey(rule.match);
    const same = rules.find((r) => matchKey(r.match) === key);
    if (same) {
      Object.assign(same.set, rule.set);
      same.createdAt = rule.createdAt || new Date().toISOString();
    } else {
      rules.push(rule);
    }
  }

  /**
   * Gives other still-unknown payments of the same payee (same payeeId; not just the same shown name:
   * two payees can look alike once words are hidden) and direction the category/kind of tx; returns how many.
   */
  function applyToUnknownTwins(draft, tx) {
    const { payeeIdOf } = Budget.calc;
    const unknownIds = new Set(draft.categories.filter((c) => c.kind === 'unknown').map((c) => c.id));
    const id = payeeIdOf(tx);
    let count = 0;
    for (const t of draft.transactions) {
      if (t.id === tx.id || !unknownIds.has(t.categoryId)) continue;
      if (payeeIdOf(t) !== id) continue;
      if (Math.sign(t.amount) !== Math.sign(tx.amount)) continue;
      t.categoryId = tx.categoryId;
      t.kind = tx.kind;
      count++;
    }
    return count;
  }

  /**
   * "Always use this name? Yes": every other payment of the same payee (payeeId) still called oldName
   * gets newName too (what the new rename rule will do on the next import). The payee (payeeId) and its normal
   * amount stay as they are. Returns the count.
   */
  function renameTwins(draft, txId, oldName, newName) {
    const { payeeKey, payeeIdOf } = Budget.calc;
    const oldKey = payeeKey(oldName);
    const source = draft.transactions.find((t) => t.id === txId);
    const id = source ? payeeIdOf(source) : null;
    let count = 0;
    for (const t of draft.transactions) {
      if (t.id === txId || payeeKey(t.name) !== oldKey || (id && payeeIdOf(t) !== id)) continue;
      t.name = newName;
      count++;
    }
    return count;
  }

  /**
   * "My normal month" fields [{item (from calc.normalMonth), text, touched}] → {changes: [[key, cents|null]]} or
   * {error: item}. touched: the user typed in the field. A typed amount is stored (as a positive magnitude)
   * even when it equals the amount shown, so it stays the normal amount; an untouched field changes nothing;
   * an empty field (null) goes back to the last amount.
   */
  function normalChanges(fields) {
    const changes = [];
    for (const { item, text, touched } of fields) {
      if (!String(text ?? '').trim()) {
        if (item.custom) changes.push([item.key, null]);
        continue;
      }
      if (!touched) continue;
      const cents = Budget.util.parseEuro(text);
      if (cents === null) return { error: item };
      const magnitude = Math.abs(cents);
      if (item.custom && magnitude === Math.abs(item.normal)) continue;
      changes.push([item.key, magnitude]);
    }
    return { changes };
  }

  /** Popup title: "Fixed costs — September 2026". */
  function tileTitle(key, month) {
    return `${TILE_TITLES[key]} — ${Budget.util.monthLabel(month)}`;
  }

  /** How a tile popup writes money: like its tile (no sign; money back as −), 'Not sorted yet' with + and −. */
  function tileMoney(sectionKey, cents) {
    return Budget.util.formatEuro(cents, sectionKey === 'unknown' ? { sign: true } : {});
  }

  /**
   * The small labels on one payment in a tile popup: 'one-off' (a one-off outside the One-off tile, e.g. one-off
   * income), 'paid 27 Sep' (paid in another month than it counts for), 'back' / 'out' (money back on a spending
   * tile / money out on the income tile).
   */
  function paymentTags(sectionKey, pay) {
    const tags = [];
    if (pay.kind === 'eenmalig' && sectionKey !== 'oneoff') tags.push('one-off');
    if (pay.paidIn) tags.push(`paid ${Budget.util.shortDate(pay.date)}`);
    if (sectionKey !== 'unknown' && pay.value < 0) tags.push(sectionKey === 'income' ? 'out' : 'back');
    return tags;
  }

  /** "+€25.00 not sorted yet": money in still to sort, on the Income tile and in its popup (signed). */
  function unknownInText(cents) {
    return `${Budget.util.formatEuro(cents, { sign: true })} not sorted yet`;
  }

  /**
   * The line a tile popup shows when no payment counts in its month. When some were paid in this month but count in
   * another one (the grey notes under it), it does not say there were no payments at all.
   */
  function tileEmptyText(section) {
    return section.elsewhere.length ? 'No payments that count in this month.' : 'No payments in this month.';
  }

  /** The grey note for a payment paid in this month that counts in another: "27 Sep · Stephan · €150.00 — counts in October 2026". */
  function elsewhereText(sectionKey, pay) {
    const { shortDate, monthLabel } = Budget.util;
    return `${shortDate(pay.date)} · ${pay.name || 'No name'} · ${tileMoney(sectionKey, pay.value)} — counts in ${monthLabel(pay.countsIn)}`;
  }

  /**
   * "Left this month" as a sum: one line per part, Not sorted yet only when it holds money in or out;
   * Σ lines.amount = total = the tile. note: payments that do not count (savings etc.), or null.
   */
  function overSum(breakdown) {
    const { unknown, left } = breakdown;
    const both = unknown.moneyIn && unknown.moneyOut;
    const lines = left.parts
      .filter((p) => p.key !== 'unknown' || unknown.moneyIn || unknown.moneyOut)
      .map((p) => ({
        key: p.key,
        label: TILE_TITLES[p.key],
        amount: p.amount,
        sub: p.key === 'unknown' && both
          ? `${fmt(unknown.moneyIn, { sign: true })} in, ${fmt(unknown.moneyOut, { sign: true })} out`
          : null,
      }));
    const n = left.notCounted.count;
    const note = n
      ? `Not in this sum: ${n} ${n === 1 ? "payment that doesn't count" : "payments that don't count"}, such as savings (net ${fmt(left.notCounted.amount, { sign: true })}).`
      : null;
    return { lines, total: left.total, note };
  }

  /** The small line under a payee in "My normal month": its last amount (and how many payments it was). */
  function lastLabel(item) {
    const amount = Budget.util.formatEuro(Math.abs(item.lastActual));
    return item.lastCount > 1 ? `last month ${amount} (${item.lastCount} payments)` : `last time ${amount}`;
  }

  // ---------------------------------------------------------------- module state

  let current = null; // month on screen; null = empty state
  let popover = null; // {txId, focusKey}
  let renamePrompt = null; // {txId, oldName}: "Always use this name for …?" under that row
  let rulePrompt = null; // {txId}: "Always do this for …?" under that row, after a category was picked
  let focusAfter = null; // {txId, part} to focus after the next render (keyboard edits)
  // Open tile popups, bottom first (a line in "Left this month" opens another one on top):
  // [{seq, key, month, body, close, parent, expanded: Set of payee keys}]
  const tilePopups = [];
  let tileSeq = 0;

  const el = (...args) => Budget.ui.el(...args);
  const fmt = (cents, opts) => Budget.util.formatEuro(cents, opts);

  function findTx(state, id) {
    return state.transactions.find((t) => t.id === id);
  }

  function rowElement(txId) {
    return [...document.querySelectorAll('#view-month .tx')].find((row) => row.dataset.id === txId) || null;
  }

  const PART_SELECTOR = { name: '.tx-name', amount: '.tx-amount', pill: '.pill', prompt: '.btn' };

  function focusRow(txId, part) {
    const row = rowElement(txId);
    if (!row) return;
    const scope = part === 'prompt' ? row.nextElementSibling : row;
    const target = scope && scope.querySelector(PART_SELECTOR[part]);
    if (target) target.focus();
  }

  /** Undo toast for the change with this token. */
  function showUndo(message, token) {
    return Budget.ui.undoToast(message, token);
  }

  /** Changes one payment through the store (undoable) and offers undo. */
  function editTx(txId, mutate, message) {
    const token = Budget.store.update(
      (draft) => {
        const tx = findTx(draft, txId);
        if (tx) mutate(tx);
      },
      { undoLabel: message },
    );
    showUndo(message, token);
  }

  /**
   * Stores a rule built by the categorizer (null: nothing of it could be kept, see categorize.ruleFromTx);
   * applyToOthers(draft) changes matching existing payments and returns how many.
   */
  function saveRule(rule, applyToOthers, message, verb) {
    let others = 0;
    const token = Budget.store.update(
      (draft) => {
        if (rule) upsertRule(draft.rules, rule);
        others = applyToOthers(draft);
      },
      { undoLabel: 'Rule saved' },
    );
    const more = others ? ` Also ${others} other ${others === 1 ? 'payment' : 'payments'} ${verb}.` : '';
    showUndo(message + more, token);
  }

  // ---------------------------------------------------------------- render

  /** Renders the month screen for `month` ('YYYY-MM'), or the empty state when month is null. */
  function render(month) {
    if (month !== current) {
      renamePrompt = null;
      rulePrompt = null;
    }
    current = month || null;
    const root = document.getElementById('view-month');
    const state = Budget.store.get();
    // A question about a change that is gone again (undone, or the payment deleted) is not asked any more.
    if (rulePrompt) {
      const tx = findTx(state, rulePrompt.txId);
      if (!tx || tx.categoryId !== rulePrompt.categoryId) rulePrompt = null;
    }
    if (renamePrompt) {
      const tx = findTx(state, renamePrompt.txId);
      if (!tx || tx.name === renamePrompt.oldName) renamePrompt = null;
    }
    if (current) {
      const summary = Budget.calc.monthSummary(state, current);
      const note = notBookedNote(state, current);
      const parts = [
        note ? el('p', { class: 'month-note', role: 'note' }, note) : null,
        tilesView(Budget.calc.tileBreakdown(state, current), !note),
        barCard(summary, state.categories, !note),
        el('div', { class: 'cards-2' }, savingsCard(state), recapCard(state, current)),
        listCard(state, current),
      ];
      root.replaceChildren(...parts.filter(Boolean)); // (replaceChildren would turn a null into the text "null")
    } else {
      root.replaceChildren(emptyView());
    }
    if (popover) drawPopover(false);
    syncTilePopups();
    if (focusAfter) {
      const { txId, part } = focusAfter;
      focusAfter = null;
      focusRow(txId, part);
    }
  }

  /** A small "›" (also turned down for an opened name in a tile popup). */
  function chevronIcon(cls) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'm6 3 5 5-5 5');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  /** One tile: a button that opens its popup. Only phrasing content (spans) inside a button. */
  function tile(key, cls, label, value, subs, valueCls) {
    return el(
      'button',
      {
        type: 'button',
        class: `tile ${cls}`,
        'data-tile': key,
        'aria-haspopup': 'dialog',
        onclick: (e) => {
          e.currentTarget.focus(); // so the focus comes back here when the popup closes (also after a mouse click)
          openTilePopup(key);
        },
      },
      el('span', { class: 'tile-label' }, label),
      el('span', { class: valueCls ? `tile-value ${valueCls}` : 'tile-value' }, value),
      [subs].flat().filter(Boolean).map((sub) => (sub instanceof Node ? sub : el('span', { class: 'tile-sub' }, sub))),
      el('span', { class: 'tile-more no-print' }, 'View', chevronIcon('tile-chev')),
    );
  }

  /** The colour class of "Left this month": green, red on a shortfall, neither for a month not booked yet. */
  function leftClass(left, booked) {
    if (booked && left < 0) return 'neg';
    if (!booked || left < 0) return null;
    return 'pos';
  }

  /**
   * The five tiles from calc.tileBreakdown, the same numbers their popups add up to.
   * booked: false for a month the bank has not booked yet — no red "short" colour there.
   */
  function tilesView(b, booked = true) {
    const left = b.left.total;
    const unknownIn = b.unknown.moneyIn > 0 ? el('span', { class: 'tile-sub tile-extra' }, unknownInText(b.unknown.moneyIn)) : null;
    let leftTile = 'tile-left';
    if (booked && left < 0) leftTile += ' short';
    else if (!booked) leftTile += ' pending';
    const values = { income: fmt(b.income.total), fixed: fmt(b.fixed.total), daily: fmt(b.daily.total), oneoff: fmt(b.oneoff.total), left: fmt(left, { sign: true }) };
    return el(
      'section',
      { class: 'tiles', 'aria-label': 'This month in short' },
      TILES.map(([key, cls, label, note]) => {
        if (key === 'left') return tile(key, leftTile, label, values.left, note, leftClass(left, booked));
        return tile(key, cls, label, values[key], key === 'income' ? [note, unknownIn] : note);
      }),
    );
  }

  // ---------------------------------------------------------------- tile popups (read-only)

  function tileElement(key) {
    return [...document.querySelectorAll('#view-month .tile')].find((t) => t.dataset.tile === key) || null;
  }

  /** Opens the popup of tile `key` ('income' … 'left', or 'unknown' from the Left sum) over the page. */
  function openTilePopup(key, parent = null) {
    if (!current || !TILE_TITLES[key]) return;
    closePopover(false);
    const entry = { seq: ++tileSeq, key, month: current, body: el('div', { class: 'tp-body' }), close: null, parent, expanded: new Set() };
    drawTilePopup(entry);
    tilePopups.push(entry);
    entry.close = Budget.ui.dialog({
      title: tileTitle(key, entry.month),
      body: entry.body,
      className: 'tp',
      closeButton: true,
      onClose: () => tilePopupClosed(entry),
    });
  }

  /** After a popup closed: forget it; when the element that opened it was re-rendered meanwhile, focus its successor. */
  function tilePopupClosed(entry) {
    const i = tilePopups.indexOf(entry);
    if (i >= 0) tilePopups.splice(i, 1);
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const opener = entry.parent
      ? [...entry.parent.body.querySelectorAll('[data-key]')].find((n) => n.getAttribute('data-key') === `line:${entry.key}`)
      : tileElement(entry.key);
    if (opener && opener.isConnected) opener.focus();
  }

  /** Closes every tile popup (newest first). */
  function closeTilePopups() {
    for (const entry of [...tilePopups].reverse()) if (entry.close) entry.close();
    tilePopups.length = 0;
  }

  /**
   * After a render: popups of another month close, the others are drawn again from the current data. When the
   * focused control is gone after that (its name disappeared, a toast was clicked away), the focus goes back into
   * the top popup instead of staying on <body> (aria-modal).
   */
  function syncTilePopups() {
    if (!tilePopups.length) return;
    if (tilePopups.some((p) => p.month !== current)) {
      closeTilePopups();
      return;
    }
    for (const entry of tilePopups) drawTilePopup(entry);
    if (typeof Budget.ui.keepFocusInDialog === 'function') Budget.ui.keepFocusInDialog();
  }

  /** (Re)builds a popup's content; keeps opened names, the scroll position and the focused control. */
  function drawTilePopup(entry) {
    const b = Budget.calc.tileBreakdown(Budget.store.get(), entry.month);
    const scroller = entry.body.parentElement;
    const scroll = scroller ? scroller.scrollTop : 0;
    const active = entry.body.contains(document.activeElement) ? document.activeElement.getAttribute('data-key') : null;
    entry.body.replaceChildren(...(entry.key === 'left' ? overPopupView(entry, b) : sectionPopupView(entry, b)));
    if (scroller) scroller.scrollTop = scroll;
    if (active) {
      const again = [...entry.body.querySelectorAll('[data-key]')].find((n) => n.getAttribute('data-key') === active);
      if (again) again.focus({ preventScroll: true });
    }
  }

  function totalLine(label, value, cls) {
    return el('div', { class: 'tp-total' }, el('span', {}, label), el('span', { class: cls ? `tp-amt ${cls}` : 'tp-amt' }, value));
  }

  /** Income, Fixed costs, Daily spending, One-off or Not sorted yet: one line per name, total = the tile. */
  function sectionPopupView(entry, b) {
    const section = b[entry.key];
    const categories = new Map(Budget.store.get().categories.map((c) => [c.id, c]));
    const parts = [];
    if (section.payees.length) {
      parts.push(el('ul', { class: 'tp-list' }, section.payees.map((payee, i) => payeeView(entry, section, payee, categories, i))));
    } else {
      parts.push(el('p', { class: 'muted tp-empty' }, tileEmptyText(section)));
    }
    parts.push(totalLine('Total', tileMoney(section.key, section.total)));
    const notes = section.elsewhere.map((pay) => elsewhereText(section.key, pay));
    if (section.key === 'income' && b.unknown.moneyIn > 0) notes.push(`${unknownInText(b.unknown.moneyIn)} — not in this total`);
    if (section.key === 'unknown' && section.count) notes.push("Choose what it is in the list 'All payments, by colour'.");
    if (notes.length) parts.push(el('ul', { class: 'tp-notes' }, notes.map((text) => el('li', {}, text))));
    return parts;
  }

  function payeeView(entry, section, payee, categories, index) {
    const open = entry.expanded.has(payee.key);
    const listId = `tp-${entry.seq}-${index}`;
    const category = categories.get(payee.categoryId) || { id: 'onbekend', color: '' };
    const list = el(
      'ul',
      { class: 'tp-pays', id: listId, hidden: !open },
      payee.payments.map((pay) => {
        const tags = paymentTags(section.key, pay);
        return el(
          'li',
          { class: 'tp-pay' },
          el('span', { class: 'tp-date' }, Budget.util.shortDate(pay.date)),
          el(
            'span',
            { class: 'tp-pay-main' },
            pay.description ? el('span', { class: 'tp-desc' }, pay.description) : null,
            tags.map((t) => el('span', { class: 'tp-tag' }, t)),
          ),
          el('span', { class: section.key === 'unknown' && pay.value > 0 ? 'tp-amt amount-in' : 'tp-amt' }, tileMoney(section.key, pay.value)),
        );
      }),
    );
    const button = el(
      'button',
      {
        type: 'button',
        class: 'tp-row tp-payee',
        style: colorStyle(category),
        'aria-expanded': String(open),
        'aria-controls': listId,
        'data-key': `payee:${payee.key}`,
        onclick: (e) => {
          const nowOpen = !entry.expanded.has(payee.key);
          if (nowOpen) entry.expanded.add(payee.key);
          else entry.expanded.delete(payee.key);
          e.currentTarget.setAttribute('aria-expanded', String(nowOpen));
          list.hidden = !nowOpen;
        },
      },
      el('span', { class: 'dot' }),
      el(
        'span',
        { class: 'tp-name' },
        el('span', { class: 'tp-name-text' }, payee.name || 'No name'),
        payee.count > 1 ? el('span', { class: 'tp-count' }, `${payee.count} payments`) : null,
      ),
      el('span', { class: section.key === 'unknown' && payee.total > 0 ? 'tp-amt amount-in' : 'tp-amt' }, tileMoney(section.key, payee.total)),
      chevronIcon('tp-chev'),
    );
    return el('li', { class: 'tp-item' }, button, list);
  }

  /** "Left this month": Income − Fixed costs − Daily spending − One-off (± Not sorted yet) = the tile. */
  function overPopupView(entry, b) {
    const sum = overSum(b);
    const booked = Budget.calc.isBookedMonth(Budget.store.get(), entry.month);
    const lines = sum.lines.map((line) =>
      el(
        'li',
        { class: 'tp-item' },
        el(
          'button',
          {
            type: 'button',
            class: `tp-row tp-line tp-line-${line.key}`,
            'aria-haspopup': 'dialog',
            'data-key': `line:${line.key}`,
            onclick: (e) => {
              e.currentTarget.focus();
              openTilePopup(line.key, entry);
            },
          },
          el('span', { class: 'dot' }),
          el('span', { class: 'tp-name' }, el('span', { class: 'tp-name-text' }, line.label), line.sub ? el('span', { class: 'tp-count' }, line.sub) : null),
          el('span', { class: 'tp-amt' }, fmt(line.amount, { sign: true })),
          chevronIcon('tp-chev'),
        ),
      ),
    );
    return [
      el('ul', { class: 'tp-list tp-sum' }, lines),
      totalLine('Left this month', fmt(sum.total, { sign: true }), leftClass(sum.total, booked)),
      sum.note ? el('ul', { class: 'tp-notes' }, el('li', {}, sum.note)) : null,
    ].filter(Boolean);
  }

  function barCard(summary, categories, booked = true) {
    const view = barView(summary, categories);
    const head = el(
      'div',
      { class: 'bar-head' },
      el('h2', {}, 'Where did the money go?'),
      view.shortfall && booked ? el('span', { class: 'shortfall' }, `Short ${fmt(view.shortfall)}`) : null,
    );
    if (!view.parts.length) {
      return el('section', { class: 'card bar-card' }, head, el('p', { class: 'muted' }, 'No income or spending in this month yet.'));
    }
    const describe = view.parts.map((p) => `${p.label} ${fmt(p.value)}`).join(', ');
    return el(
      'section',
      { class: 'card bar-card' },
      head,
      el(
        'div',
        { class: 'bar', role: 'img', 'aria-label': describe },
        view.parts.map((p) => el('span', { style: `${p.style}; flex-grow: ${p.value}`, title: `${p.label}: ${fmt(p.value)}` })),
      ),
      el(
        'ul',
        { class: 'legend' },
        view.parts.map((p) =>
          el('li', { style: p.style }, el('span', { class: 'dot' }), p.label, el('strong', {}, fmt(p.value)), el('span', { class: 'muted' }, pctLabel(p.value, view.total))),
        ),
      ),
    );
  }

  function savingsCard(state) {
    const nm = Budget.calc.normalMonth(state);
    const short = nm.save < 0;
    const big = short
      ? el('p', { class: 'save-big neg' }, 'You are about ', el('strong', {}, fmt(Math.abs(nm.saveRounded), { whole: true })), ' per month short')
      : el('p', { class: 'save-big' }, 'About ', el('strong', {}, fmt(nm.saveRounded, { whole: true })), ' per month');
    const line = (label, value, cls) => el('div', { class: cls }, el('dt', {}, label), el('dd', {}, value));
    const unknown = planUnknownsText(planUnknowns(state));
    return el(
      'section',
      { class: 'card save-card' },
      el('h2', {}, 'How much can I save?'),
      big,
      el(
        'dl',
        { class: 'sum' },
        line('Comes in (normal month)', fmt(nm.income, { sign: true })),
        line('Fixed costs', fmt(nm.fixed, { sign: true })),
        line('Daily (average)', fmt(nm.dailyAvg, { sign: true })),
        line('Left to save', fmt(nm.save), short ? 'total neg' : 'total'),
      ),
      unknown ? el('p', { class: 'muted save-unknown' }, unknown) : null,
      el('div', { id: 'goal-bar' }),
      el('button', { type: 'button', class: 'link-btn no-print', onclick: openNormalMonth }, 'Change normal month'),
    );
  }

  function recapCard(state, month) {
    const recap = Budget.calc.monthRecap(state, month);
    const view = recapView(recap);
    const table = el(
      'table',
      { class: 'recap' },
      el(
        'tbody',
        {},
        view.rows.map((r) =>
          el('tr', { class: r.saldo ? 'saldo' : null }, el('th', { scope: 'row' }, r.label), el('td', {}, fmt(r.value, { sign: !r.saldo }))),
        ),
      ),
    );
    let change = 'Your balance stayed the same this month.';
    if (view.change) change = `Your balance went ${view.change > 0 ? 'up' : 'down'} by ${fmt(Math.abs(view.change))} this month.`;
    let check = null;
    if (recap.statementCheck && recap.statementCheck.ok) {
      check = el('p', { class: 'check ok' }, '✓ Matches the bank statement');
    } else if (recap.statementCheck) {
      check = el(
        'p',
        { class: 'check bad' },
        `Note: this doesn't match the bank statement (difference ${fmt(Math.abs(recap.statementCheck.diff))}). ` +
          'Is a payment missing, or is something in twice?',
      );
    }
    return el(
      'section',
      { class: 'card recap-card' },
      el('h2', {}, 'What really happened'),
      view.rows.length ? table : el('p', { class: 'muted' }, 'Nothing happened in this month yet.'),
      el('p', { class: 'recap-change' }, change),
      check,
    );
  }

  function listCard(state, month) {
    const groups = listForMonth(state, month);
    const card = el(
      'section',
      { class: 'card list-card' },
      el(
        'div',
        { class: 'list-head' },
        el('h2', {}, 'All payments, by colour'),
        el('button', { type: 'button', class: 'btn small', onclick: () => openAdd(month) }, '+ Add'),
      ),
      groups.length ? groups.map(groupView) : el('p', { class: 'muted list-empty' }, 'No payments in this month yet.'),
    );
    card.addEventListener('click', onListClick);
    return card;
  }

  function groupView(group) {
    const { category } = group;
    const unknown = category.kind === 'unknown';
    const rows = el('div', { class: 'rows' });
    for (const item of group.items) {
      rows.append(rowView(item));
      if (renamePrompt && renamePrompt.txId === item.tx.id) rows.append(renamePromptView(item.tx));
      else if (rulePrompt && rulePrompt.txId === item.tx.id) rows.append(rulePromptView(item.tx));
    }
    const note = unknown ? UNKNOWN_HINT : GROUP_NOTES[category.id];
    let totalCls = 'gtotal';
    if (group.faded) totalCls += ' muted';
    else if (group.total > 0) totalCls += ' amount-in';
    return el(
      'section',
      { class: unknown ? 'group unknown' : 'group', 'data-cat': category.id, style: colorStyle(category) },
      el(
        'div',
        { class: 'ghead' },
        el('span', { class: 'dot' }),
        el('span', { class: 'gname' }, unknown ? `${catTitle(category)} (${group.items.length})` : catTitle(category)),
        note ? el('span', { class: 'gnote' }, note) : null,
        el('span', { class: 'badges' }),
        el('span', { class: totalCls, title: group.faded ? "doesn't count" : null }, fmt(group.total, { sign: true })),
      ),
      rows,
    );
  }

  /** Small pencil shown next to a name or amount on hover/focus: "you can change this". */
  function pencilIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('class', 'pencil');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M11.2 2.3a1.4 1.4 0 0 1 2 0l.5.5a1.4 1.4 0 0 1 0 2L6 12.5 2.5 13.5l1-3.5zM10 3.5l2.5 2.5');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  function rowView({ tx, counts, countsIn, paidIn }) {
    const { monthLabel, shortDate } = Budget.util;
    let note = '';
    if (countsIn) note = `counts in ${monthLabel(countsIn)}`;
    else if (paidIn) note = `paid in ${monthLabel(paidIn)}`;
    let amountCls = 'tx-amount editable';
    if (tx.amount > 0) amountCls += ' amount-in';
    let rowCls = counts ? 'tx' : 'tx faded';
    if (rulePrompt && rulePrompt.txId === tx.id) rowCls += ' is-asking';
    return el(
      'div',
      { class: rowCls, 'data-id': tx.id },
      el('span', { class: 'tx-date' }, shortDate(tx.date)),
      el(
        'div',
        { class: 'tx-main' },
        el('button', { type: 'button', class: 'tx-name editable', title: 'Change name' }, el('span', { class: 'edit-text' }, tx.name || 'No name'), pencilIcon()),
        tx.description ? el('span', { class: 'tx-desc' }, tx.description) : null,
        note ? el('span', { class: 'tx-note' }, note) : null,
      ),
      el('button', { type: 'button', class: `pill kind-${tx.kind}`, 'aria-haspopup': 'dialog', title: 'Choose what it is' }, KIND_LABELS[tx.kind]),
      el('button', { type: 'button', class: amountCls, title: 'Change amount' }, pencilIcon(), el('span', { class: 'edit-text' }, fmt(tx.amount, { sign: true }))),
    );
  }

  function emptyIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 48 48');
    svg.setAttribute('width', '56');
    svg.setAttribute('height', '56');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M24 6v24m-9-9 9 9 9-9M8 36v6h32v-6');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '3');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  function emptyView() {
    return el(
      'div',
      { class: 'empty' },
      el(
        'button',
        { type: 'button', class: 'dropzone', onclick: () => Budget.app.pickFiles() },
        emptyIcon(),
        el('span', { class: 'dropzone-title' }, 'Drag your bank statement here'),
        el('span', { class: 'dropzone-sub' }, 'An ING statement (PDF) or an ING download (CSV). More files at once is fine too.'),
        el('span', { class: 'btn primary' }, 'Or choose a file'),
      ),
      el('p', { class: 'muted empty-note' }, 'Everything stays on this computer. Nothing is sent anywhere.'),
      el('button', { type: 'button', class: 'btn ghost', onclick: () => openAdd(null) }, '+ Add a payment yourself'),
    );
  }

  // ---------------------------------------------------------------- inline editing

  function onListClick(e) {
    const row = e.target.closest('.tx');
    if (!row || e.target.closest('input')) return;
    const tx = findTx(Budget.store.get(), row.dataset.id);
    if (!tx) return;
    if (e.target.closest('.tx-name')) startRename(row, tx);
    else if (e.target.closest('.tx-amount')) startAmountEdit(row, tx);
    else openPopover(tx.id);
  }

  /**
   * Swaps btn for input. Enter or leaving the field saves, Esc cancels. commit(value, byKey) returns
   * 'saved' (the store re-renders the screen), 'unchanged' or 'invalid' (Enter keeps editing; blur cancels).
   */
  function inlineEdit(btn, input, commit) {
    btn.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const restore = (byKey) => {
      if (input.isConnected) input.replaceWith(btn);
      if (byKey) btn.focus();
    };
    const finish = (save, byKey) => {
      if (done) return;
      done = true; // before commit: the re-render it causes may fire blur on this input
      const result = save ? commit(input.value, byKey) : 'cancel';
      if (result === 'invalid' && byKey) {
        done = false;
        input.setAttribute('aria-invalid', 'true');
        input.select();
        return;
      }
      if (result !== 'saved') restore(byKey);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true, true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false, true);
      }
    });
    input.addEventListener('blur', () => finish(true, false));
  }

  function startAmountEdit(row, tx) {
    closePopover(false);
    dropPrompts();
    const input = el('input', {
      type: 'text',
      class: 'inline-input',
      inputmode: 'decimal',
      autocomplete: 'off',
      'aria-label': `Amount of ${tx.name}`,
      value: plainAmount(tx.amount),
    });
    inlineEdit(row.querySelector('.tx-amount'), input, (value, byKey) => {
      const cents = parseAmountInput(value, tx.amount);
      if (cents === null) {
        if (!byKey) Budget.ui.toast('I don\'t understand that amount. For example, type 12.50.');
        return 'invalid';
      }
      if (cents === tx.amount) return 'unchanged';
      if (byKey) focusAfter = { txId: tx.id, part: 'amount' };
      editTx(tx.id, (t) => (t.amount = cents), 'Amount changed');
      return 'saved';
    });
  }

  function startRename(row, tx) {
    closePopover(false);
    dropPrompts();
    const input = el('input', {
      type: 'text',
      class: 'inline-input',
      autocomplete: 'off',
      maxlength: 80,
      'aria-label': 'Name',
      value: tx.name,
    });
    inlineEdit(row.querySelector('.tx-name'), input, (value, byKey) => {
      const name = value.trim().replace(/\s+/g, ' ');
      if (!name || name === tx.name) return 'unchanged';
      renamePrompt = { txId: tx.id, oldName: tx.name };
      if (byKey) focusAfter = { txId: tx.id, part: 'prompt' };
      editTx(tx.id, (t) => (t.name = name), 'Name changed');
      return 'saved';
    });
  }

  function dropRenamePrompt() {
    if (!renamePrompt) return;
    const row = rowElement(renamePrompt.txId);
    const box = row && row.nextElementSibling;
    if (box && box.classList.contains('inline-prompt')) box.remove();
    renamePrompt = null;
  }

  function renamePromptView(tx) {
    const { oldName } = renamePrompt;
    return el(
      'div',
      { class: 'inline-prompt no-print', role: 'group', 'aria-label': 'Remember name' },
      el('span', {}, `Always call '${oldName}' this from now on?`),
      el('button', { type: 'button', class: 'btn primary small', onclick: () => saveRenameRule(tx.id, oldName) }, 'Yes'),
      el(
        'button',
        {
          type: 'button',
          class: 'btn small',
          onclick: () => {
            dropRenamePrompt();
            focusRow(tx.id, 'name');
          },
        },
        'Only this one',
      ),
    );
  }

  function saveRenameRule(txId, oldName) {
    renamePrompt = null;
    const tx = findTx(Budget.store.get(), txId);
    if (!tx) return;
    const rule = Budget.categorize.ruleFromTx({ ...tx, name: oldName }, { rename: tx.name }, Budget.store.get());
    saveRule(rule, (draft) => renameTwins(draft, tx.id, oldName, tx.name), `'${oldName}' is now called '${tx.name}'.`, 'renamed');
  }

  // ---------------------------------------------------------------- choice buttons (popover + Settings › Rules)

  /** One coloured-dot button per category; onPick(categoryId). Shared with the rule editor in Settings. */
  function categoryChoices(categories, selectedId, onPick) {
    return categories.map((c) =>
      el(
        'button',
        {
          type: 'button',
          class: 'choice',
          style: colorStyle(c),
          'aria-pressed': String(c.id === selectedId),
          'data-key': `cat:${c.id}`,
          onclick: () => onPick(c.id),
        },
        el('span', { class: 'dot' }),
        catTitle(c),
      ),
    );
  }

  /** One button per kind (every month / varies / one-off / doesn't count); onPick(kind). */
  function kindChoices(selectedKind, onPick) {
    return Object.keys(KIND_LABELS).map((k) =>
      el(
        'button',
        {
          type: 'button',
          class: `choice kind-${k}`,
          'aria-pressed': String(k === selectedKind),
          'data-key': `kind:${k}`,
          onclick: () => onPick(k),
        },
        KIND_LABELS[k],
      ),
    );
  }

  // ---------------------------------------------------------------- row popover

  function openPopover(txId) {
    dropPrompts();
    if (popover && popover.txId === txId) {
      closePopover(true);
      return;
    }
    closePopover(false);
    popover = { txId, focusKey: null };
    document.addEventListener('pointerdown', onOutsidePointer, true);
    document.addEventListener('keydown', onPopoverKey);
    window.addEventListener('resize', placePopover);
    window.addEventListener('budget:toasts', placePopover);
    drawPopover(true);
  }

  /** Closes the popover; refocus puts the keyboard focus back on the row's pill. */
  function closePopover(refocus) {
    if (!popover) return;
    const { txId } = popover;
    popover = null;
    document.removeEventListener('pointerdown', onOutsidePointer, true);
    document.removeEventListener('keydown', onPopoverKey);
    window.removeEventListener('resize', placePopover);
    window.removeEventListener('budget:toasts', placePopover);
    document.getElementById('popover-root').replaceChildren();
    for (const row of document.querySelectorAll('#view-month .tx.is-open')) row.classList.remove('is-open');
    if (refocus) focusRow(txId, 'pill');
  }

  function onOutsidePointer(e) {
    if (e.target.closest('#popover-root, #dialog-root, #toast-root')) return;
    const row = e.target.closest('.tx');
    if (row && row.dataset.id === popover.txId) return;
    closePopover(false);
  }

  function onPopoverKey(e) {
    if (e.key === 'Escape') closePopover(true);
  }

  /** (Re)builds the popover for the current state; closes it when its row is no longer on screen. */
  function drawPopover(first) {
    const state = Budget.store.get();
    const tx = findTx(state, popover.txId);
    const row = tx && rowElement(tx.id);
    if (!row) {
      closePopover(false);
      return;
    }
    for (const other of document.querySelectorAll('#view-month .tx.is-open')) other.classList.remove('is-open');
    row.classList.add('is-open');
    const root = document.getElementById('popover-root');
    const active = root.contains(document.activeElement) ? document.activeElement.getAttribute('data-key') : null;
    const focusKey = popover.focusKey || active;
    popover.focusKey = null;
    const box = popoverView(state, tx);
    root.replaceChildren(box);
    if (first) revealPopover();
    placePopover();
    const keyed = focusKey && [...box.querySelectorAll('[data-key]')].find((n) => n.getAttribute('data-key') === focusKey);
    const target = keyed || (first ? box.querySelector('[aria-pressed="true"]') : null);
    if (target) target.focus({ preventScroll: true });
  }

  /** The part of the window the popover may use: not under the toasts at the bottom. */
  function usableHeight() {
    const space = Budget.ui.toastSpace ? Budget.ui.toastSpace() : 0;
    return window.innerHeight - space;
  }

  /**
   * Scrolls the page (only when needed) so the popover's row and the popover itself are both in view and clear of
   * the toasts: the row near the top of the window with the popover under it.
   */
  function revealPopover() {
    const box = document.querySelector('#popover-root .popover');
    const row = popover && rowElement(popover.txId);
    if (!box || !row) return;
    const r = row.getBoundingClientRect();
    const h = box.offsetHeight;
    const viewH = usableHeight();
    const rowInView = r.top >= POP_MARGIN && r.bottom <= viewH - POP_MARGIN;
    const fitsBelow = r.bottom + POP_GAP + h <= viewH - POP_MARGIN;
    const fitsAbove = r.top - POP_GAP - h >= POP_MARGIN;
    if (rowInView && (fitsBelow || fitsAbove)) return;
    window.scrollBy(0, r.top - POP_MARGIN * 4);
  }

  /** Puts the popover under its row (or above it), inside the window and clear of the toasts. */
  function placePopover() {
    const box = document.querySelector('#popover-root .popover');
    const row = popover && rowElement(popover.txId);
    if (!box || !row) return;
    const r = row.getBoundingClientRect();
    const viewW = document.documentElement.clientWidth;
    const viewH = usableHeight();
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const left = Math.max(16, Math.min(r.right - w, viewW - w - 16));
    let top;
    if (r.bottom + POP_GAP + h <= viewH - POP_MARGIN) top = r.bottom + POP_GAP;
    else if (r.top - POP_GAP - h >= POP_MARGIN) top = r.top - POP_GAP - h;
    else top = Math.max(POP_MARGIN, Math.min(r.bottom + POP_GAP, viewH - POP_MARGIN - h)); // nothing fits: stay in view
    box.style.left = `${left + window.scrollX}px`;
    box.style.top = `${top + window.scrollY}px`;
  }

  function popoverView(state, tx) {
    const { monthLabel, monthOf, shortDate } = Budget.util;
    const categories = categoryChoices(state.categories, tx.categoryId, (id) => setCategory(tx.id, id));
    const kinds = kindChoices(tx.kind, (k) => setKind(tx.id, k));
    const paid = monthOf(tx.date);
    const select = el(
      'select',
      { class: 'input', 'data-key': 'month', onchange: (e) => moveTx(tx.id, e.target.value) },
      monthOptions(tx).map((m) => el('option', { value: m }, m === paid ? `${monthLabel(m)} (paid)` : monthLabel(m))),
    );
    select.value = tx.month;
    return el(
      'div',
      { class: 'popover', role: 'dialog', 'aria-label': `Payment: ${tx.name}` },
      el(
        'div',
        { class: 'pop-head' },
        el(
          'div',
          {},
          el('div', { class: 'pop-title' }, tx.name || 'No name'),
          el('div', { class: 'pop-sub' }, `${shortDate(tx.date)} · ${fmt(tx.amount, { sign: true })}`),
        ),
        el('button', { type: 'button', class: 'btn ghost icon small', 'aria-label': 'Close', 'data-key': 'close', onclick: () => closePopover(true) }, '×'),
      ),
      el(
        'div',
        { class: 'pop-section' },
        el('span', { class: 'pop-label' }, 'What is it?'),
        el('div', { class: 'choice-row', role: 'group', 'aria-label': 'What is it?' }, categories),
      ),
      el(
        'div',
        { class: 'pop-section' },
        el('span', { class: 'pop-label' }, 'Kind of payment'),
        el('div', { class: 'choice-row', role: 'group', 'aria-label': 'Kind of payment' }, kinds),
      ),
      el('label', { class: 'pop-section field' }, el('span', { class: 'pop-label' }, 'Belongs to month'), select),
      el(
        'div',
        { class: 'pop-foot' },
        el('button', { type: 'button', class: 'btn ghost danger small', 'data-key': 'delete', onclick: () => removeTx(tx.id) }, 'Delete'),
      ),
    );
  }

  /**
   * "Always do this for '<name>'?" [Yes] [Only this one], right under the payment's row in its NEW group, so it is
   * always clear which payment the question is about.
   */
  function rulePromptView(tx) {
    return el(
      'div',
      { class: 'inline-prompt no-print', role: 'group', 'aria-label': 'Make rule' },
      el('span', {}, `Always do this for '${tx.name}'?`),
      el('button', { type: 'button', class: 'btn primary small', 'data-key': 'rule-yes', onclick: () => saveCategoryRule(tx.id) }, 'Yes'),
      el(
        'button',
        {
          type: 'button',
          class: 'btn small',
          'data-key': 'rule-no',
          onclick: () => {
            dropRulePrompt();
            focusRow(tx.id, 'pill');
          },
        },
        'Only this one',
      ),
    );
  }

  function dropRulePrompt() {
    if (!rulePrompt) return;
    const row = rowElement(rulePrompt.txId);
    const box = row && row.nextElementSibling;
    if (box && box.classList.contains('inline-prompt')) box.remove();
    if (row) row.classList.remove('is-asking');
    rulePrompt = null;
  }

  function dropPrompts() {
    dropRenamePrompt();
    dropRulePrompt();
  }

  /** Scrolls (only when needed) so the row and its inline question are in view and clear of the toasts. */
  function revealPrompt(txId) {
    const row = rowElement(txId);
    const box = row && row.nextElementSibling;
    if (!row || !box || !box.classList.contains('inline-prompt')) return;
    const top = row.getBoundingClientRect().top;
    const bottom = box.getBoundingClientRect().bottom;
    const viewH = usableHeight();
    if (top >= POP_MARGIN && bottom <= viewH - POP_MARGIN) return;
    const room = viewH - 2 * POP_MARGIN;
    // the block in the middle of the free part of the window (its top in view when it is taller than that)
    const target = bottom - top <= room ? POP_MARGIN + (room - (bottom - top)) / 2 : POP_MARGIN * 4;
    window.scrollBy(0, top - target);
  }

  function setCategory(txId, categoryId) {
    const state = Budget.store.get();
    const tx = findTx(state, txId);
    const category = state.categories.find((c) => c.id === categoryId);
    if (!tx || !category || tx.categoryId === categoryId) return;
    closePopover(false);
    dropRenamePrompt();
    rulePrompt = { txId, categoryId };
    focusAfter = { txId, part: 'prompt' };
    const kind = Budget.store.defaultKind(categoryId);
    editTx(
      txId,
      (t) => {
        t.categoryId = categoryId;
        t.kind = kind;
      },
      `Now in ${catTitle(category)}`,
    );
    // The row moved to its new group: bring it and the question into view, clear of the toast that just appeared.
    revealPrompt(txId);
  }

  function setKind(txId, kind) {
    const tx = findTx(Budget.store.get(), txId);
    if (!tx || tx.kind === kind) return;
    popover.focusKey = `kind:${kind}`;
    editTx(txId, (t) => (t.kind = kind), `Kind: ${KIND_LABELS[kind]}`);
  }

  function moveTx(txId, month) {
    popover.focusKey = 'month';
    editTx(txId, (t) => (t.month = month), `Now counts in ${Budget.util.monthLabel(month)}`);
  }

  function removeTx(txId) {
    closePopover(false);
    const token = Budget.store.update(
      (draft) => {
        draft.transactions = draft.transactions.filter((t) => t.id !== txId);
      },
      { undoLabel: 'Deleted' },
    );
    showUndo('Deleted', token);
  }

  function saveCategoryRule(txId) {
    rulePrompt = null;
    const tx = findTx(Budget.store.get(), txId);
    if (!tx) return;
    focusAfter = { txId, part: 'pill' };
    const rule = Budget.categorize.ruleFromTx(tx, 'category', Budget.store.get());
    saveRule(rule, (draft) => applyToUnknownTwins(draft, tx), `Remembered for '${tx.name}'.`, 'changed');
  }

  // ---------------------------------------------------------------- dialogs

  function field(label, ...controls) {
    return el('label', { class: 'field' }, el('span', {}, label), ...controls);
  }

  /** Selects the whole field when it gets focus (also by a click), so typing replaces the amount. */
  function selectOnFocus(input) {
    let fresh = false;
    input.addEventListener('focus', () => {
      input.select();
      fresh = true;
    });
    input.addEventListener('mouseup', (e) => {
      if (fresh) e.preventDefault(); // the click that gave focus must not undo the selection
      fresh = false;
    });
    input.addEventListener('keydown', () => (fresh = false));
    input.addEventListener('blur', () => (fresh = false));
  }

  /** "+ Add": a payment by hand (e.g. cash). month = the month on screen (null on the empty state). */
  function openAdd(month) {
    const { util, store } = Budget;
    const state = store.get();
    const defaultCategory = (dir) => {
      const wanted = dir === 'in' ? 'income' : 'daily';
      return (state.categories.find((c) => c.kind === wanted) || state.categories[0]).id;
    };
    let dir = 'out';
    let categoryTouched = false;

    const date = el('input', {
      type: 'text',
      class: 'input',
      name: 'date',
      autocomplete: 'off',
      maxlength: 10,
      placeholder: 'dd-mm-yyyy',
      'aria-describedby': 'add-date-long',
      value: isoToNl(defaultAddDate(month, util.todayIso())),
    });
    const dateLong = el('div', { class: 'field-hint', id: 'add-date-long', 'aria-live': 'polite' });
    const showDate = () => {
      const iso = util.parseDateNl(date.value);
      dateLong.textContent = iso ? util.longDate(iso) : `Type day-month-year, for example ${DATE_EXAMPLE}`;
      dateLong.classList.toggle('field-hint-bad', !iso);
    };
    date.addEventListener('input', showDate);
    showDate();
    const name = el('input', { type: 'text', class: 'input', name: 'name', maxlength: 80, autocomplete: 'off', placeholder: 'e.g. Market (cash)', autofocus: true });
    const amount = el('input', { type: 'text', class: 'input', name: 'amount', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00' });
    const category = el(
      'select',
      { class: 'input', onchange: () => (categoryTouched = true) },
      state.categories.map((c) => el('option', { value: c.id }, catTitle(c))),
    );
    category.value = defaultCategory(dir);
    const dirButtons = [
      ['out', 'Money out'],
      ['in', 'Money in'],
    ].map(([value, label]) => el('button', { type: 'button', class: 'choice', 'aria-pressed': String(value === dir), 'data-dir': value }, label));
    for (const btn of dirButtons) {
      btn.addEventListener('click', () => {
        dir = btn.dataset.dir;
        for (const other of dirButtons) other.setAttribute('aria-pressed', String(other === btn));
        if (!categoryTouched) category.value = defaultCategory(dir);
      });
    }
    const error = el('p', { class: 'form-error', role: 'alert', hidden: true });
    const form = el(
      'div',
      {},
      field('Date', date, dateLong),
      field('Name', name),
      field('Amount (€)', amount),
      el('div', { class: 'field', role: 'group', 'aria-label': 'Money in or out' }, el('span', {}, 'In or out'), el('div', { class: 'choice-row' }, dirButtons)),
      field('Category', category),
      error,
    );

    const fail = (input, message) => {
      error.textContent = message;
      error.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return false;
    };
    const submit = () => {
      for (const input of [date, name, amount]) input.removeAttribute('aria-invalid');
      if (!date.value.trim()) return fail(date, `Fill in a date, for example ${DATE_EXAMPLE}.`);
      const iso = util.parseDateNl(date.value);
      if (!iso) return fail(date, `This date is not right. Type day-month-year, for example ${DATE_EXAMPLE}.`);
      const txName = name.value.trim().replace(/\s+/g, ' ');
      if (!txName) return fail(name, 'Fill in a name.');
      const cents = util.parseEuro(amount.value);
      if (!cents) return fail(amount, 'Fill in an amount, for example 12.50.');
      const tx = {
        id: util.uid('t'),
        date: iso,
        month: util.monthOf(iso),
        name: txName,
        description: '',
        amount: dir === 'in' ? Math.abs(cents) : -Math.abs(cents),
        categoryId: category.value,
        kind: store.defaultKind(category.value),
        type: '',
        bankCode: '',
        source: 'hand',
        fingerprint: '',
      };
      const token = store.update((draft) => draft.transactions.push(tx), { undoLabel: 'Added' });
      showUndo(tx.month === current ? 'Added' : `Added to ${util.monthLabel(tx.month)}`, token);
      if (tx.month !== current) Budget.app.go({ view: 'month', month: tx.month });
      return true;
    };

    const close = Budget.ui.dialog({
      title: 'Add payment',
      body: form,
      actions: [{ label: 'Add', primary: true, onClick: submit }, { label: 'Cancel' }],
    });
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      if (submit() !== false) close();
    });
  }

  /** "My normal month": the normal amount per monthly payee. */
  function openNormalMonth() {
    const state = Budget.store.get();
    const nm = Budget.calc.normalMonth(state);
    const fields = [];
    const groups = state.categories
      .map((category) => ({ category, items: nm.items.filter((i) => i.categoryId === category.id) }))
      .filter((g) => g.items.length);
    const groupViews = groups.map(({ category, items }) =>
      el(
        'section',
        { class: 'nm-group' },
        el('h3', { style: colorStyle(category) }, el('span', { class: 'dot' }), catTitle(category)),
        items.map((item) => {
          const input = el('input', {
            type: 'text',
            class: 'input',
            inputmode: 'decimal',
            autocomplete: 'off',
            'aria-label': `Normal amount for ${item.name}`,
            'data-key': item.key,
            value: plainAmount(item.normal),
          });
          const entry = { item, input, touched: false };
          input.addEventListener('input', () => (entry.touched = true));
          selectOnFocus(input);
          fields.push(entry);
          return el(
            'div',
            { class: 'nm-row' },
            el('div', { class: 'nm-name' }, item.name, el('span', { class: 'nm-last' }, lastLabel(item))),
            input,
          );
        }),
      ),
    );
    const error = el('p', { class: 'form-error', role: 'alert', hidden: true });
    const body = el(
      'div',
      {},
      el(
        'p',
        {},
        'What normally comes in every month, and what normally goes out? Was an amount higher or lower once, ' +
          'for example because of a late payment? Then fill in the normal amount here.',
      ),
      groupViews.length
        ? groupViews
        : el('p', { class: 'muted' }, "No payments that come back every month yet. Click a payment and choose 'every month'."),
      el(
        'p',
        { class: 'nm-daily' },
        `Daily spending: on average ${fmt(-nm.dailyAvg)} per month. The app works this out itself ` +
          '(average of the last months, at most 3).',
      ),
      fields.length ? el('p', { class: 'muted' }, 'Leave a box empty = use the amount from last time.') : null,
      error,
    );

    const save = () => {
      for (const { input } of fields) input.removeAttribute('aria-invalid');
      const result = normalChanges(fields.map(({ item, input, touched }) => ({ item, text: input.value, touched })));
      if (result.error) {
        const bad = fields.find((f) => f.item === result.error);
        bad.input.setAttribute('aria-invalid', 'true');
        bad.input.focus();
        error.textContent = `I don't understand the amount for '${result.error.name}'. For example, type 830 or 830.50.`;
        error.hidden = false;
        return false;
      }
      if (!result.changes.length) return true;
      const token = Budget.store.update(
        (draft) => {
          for (const [key, cents] of result.changes) {
            if (cents === null) delete draft.normalAmounts[key];
            else draft.normalAmounts[key] = Math.abs(cents);
          }
        },
        { undoLabel: 'Normal month changed' },
      );
      showUndo('Normal month changed', token);
      return true;
    };

    const close = Budget.ui.dialog({
      title: 'My normal month',
      body,
      actions: fields.length ? [{ label: 'Save', primary: true, onClick: save }, { label: 'Cancel' }] : [{ label: 'Close', primary: true }],
    });
    body.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      if (save() !== false) close();
    });
  }

  Budget.uiMonth = {
    render,
    closePopover,
    openTilePopup,
    closeTilePopups,
    openNormalMonth,
    categoryChoices,
    kindChoices,
    KIND_LABELS,
    catTitle,
    helpers: {
      parseAmountInput,
      listForMonth,
      barView,
      pctLabel,
      recapView,
      notBookedNote,
      planMonths,
      planUnknowns,
      planUnknownsText,
      monthOptions,
      upsertRule,
      applyToUnknownTwins,
      renameTwins,
      normalChanges,
      lastLabel,
      plainAmount,
      isoToNl,
      defaultAddDate,
      tileTitle,
      tileMoney,
      tileEmptyText,
      unknownInText,
      paymentTags,
      elsewhereText,
      overSum,
      leftClass,
    },
  };
})();
