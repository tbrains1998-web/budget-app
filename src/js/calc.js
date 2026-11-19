/* Budget.calc: month totals, the month recap that reconciles with the bank statement, the "normal month"
   savings plan, "higher than normal" alerts and savings-goal progress. Pure: reads a state, never changes it.
   All amounts are signed cents like the transactions (+ money in, − money out). */
(function () {
  'use strict';

  const Budget = (globalThis.Budget = globalThis.Budget || {});

  const NOT_COUNTED = 'telt-niet-mee';
  const EVERY_MONTH = 'elke-maand';
  const SUMMARY_KINDS = ['income', 'fixed', 'daily', 'oneoff', 'transfer', 'unknown'];
  const ALERT_KINDS = new Set(['fixed', 'daily', 'oneoff']); // spending categories only
  const ALERT_MIN_PREVIOUS = 2;
  const ALERT_MIN_DIFF = 1000;
  const SAVE_STEP = 500;
  const PAYEE_ID_RE = /^p_[0-9a-f]{16}$/;

  function monthOf(date) {
    return Budget.util.monthOf(date);
  }

  function cents(value) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? n + 0 : 0;
  }

  // The lowercased, trimmed display name. No longer the normalAmounts key (that is normalKey); kept for callers
  // that compare names.
  function payeeKey(name) {
    return String(name ?? '').trim().toLowerCase();
  }

  // Who a payment is with: tx.payeeId; made from the name when missing (store.update fills it).
  function payeeIdOf(tx) {
    return typeof tx.payeeId === 'string' && PAYEE_ID_RE.test(tx.payeeId) ? tx.payeeId : Budget.util.payeeId(tx.name);
  }

  // Key for state.normalAmounts: side ('in' | 'uit') + ':' + payeeId, e.g. 'in:p_0123456789abcdef'.
  function normalKey(side, payeeId) {
    return `${side}:${payeeId}`;
  }

  // 'in' for an income-kind category, 'uit' for a fixed-kind category, else null.
  function sideOfKind(kind) {
    if (kind === 'income') return 'in';
    if (kind === 'fixed') return 'uit';
    return null;
  }

  // The stored normal amount as a positive magnitude, or null when none is stored.
  function storedNormal(state, key) {
    const value = Object.prototype.hasOwnProperty.call(state.normalAmounts, key) ? state.normalAmounts[key] : null;
    return typeof value === 'number' && Number.isFinite(value) ? Math.abs(cents(value)) : null;
  }

  function withSide(side, magnitude) {
    return (side === 'in' ? magnitude : -magnitude) + 0;
  }

  // categoryId -> category kind. Ids missing from state.categories are treated as 'onbekend'.
  function categoryKinds(state) {
    const kinds = new Map();
    for (const c of state.categories) kinds.set(c.id, SUMMARY_KINDS.includes(c.kind) ? c.kind : 'unknown');
    return {
      id: (tx) => (kinds.has(tx.categoryId) ? tx.categoryId : 'onbekend'),
      of: (categoryId) => kinds.get(categoryId) || 'unknown',
    };
  }

  function byDateDesc(a, b) {
    if (a.date === b.date) return 0;
    return a.date < b.date ? 1 : -1;
  }

  // Every month the user can open: months payments count for, months they were booked in, statement months.
  // Oldest first.
  function monthsWithData(state) {
    const months = new Set(state.statements.map((s) => s.month));
    for (const tx of state.transactions) {
      months.add(tx.month);
      months.add(monthOf(tx.date));
    }
    return [...months].sort();
  }

  // Months the bank booked something in: months with a statement or with an imported (not
  // hand-added) payment dated in them. A month that only holds payments moved there is not booked. Oldest first.
  function bookedMonths(state) {
    const months = new Set(state.statements.map((s) => s.month));
    for (const tx of state.transactions) if (tx.source !== 'hand') months.add(monthOf(tx.date));
    return [...months].sort();
  }

  // The newest booked month (the month the app opens on); when nothing is booked, the newest month with any
  // data; null when there is no data at all.
  function latestBookedMonth(state) {
    const booked = bookedMonths(state);
    if (booked.length) return booked[booked.length - 1];
    const any = monthsWithData(state);
    return any.length ? any[any.length - 1] : null;
  }

  function isBookedMonth(state, month) {
    return bookedMonths(state).includes(month);
  }

  // Months that averages are based on: the booked months. Months that only hold payments moved there, or only
  // hand-added ones, would drag averages down. When nothing was ever imported, every month with a payment
  // dated in it counts.
  function averageMonths(state) {
    const booked = bookedMonths(state);
    if (booked.length) return booked;
    return [...new Set(state.transactions.map((tx) => monthOf(tx.date)))].sort();
  }

  // Totals of the payments that count for month (tx.month === month and kind ≠ telt-niet-mee).
  // left = income + fixed + daily + oneoff + unknown (transfers don't count). unknownIn (≥ 0) and unknownOut (≤ 0)
  // split the 'Not sorted yet' payments into money in and money out (unknown = unknownIn + unknownOut).
  // rows = those payments, otherRows = payments booked in or moved to this month that don't count here. Both
  // newest first.
  function monthSummary(state, month) {
    const cats = categoryKinds(state);
    const totals = { income: 0, fixed: 0, daily: 0, oneoff: 0, transfer: 0, unknown: 0 };
    let unknownIn = 0;
    let unknownOut = 0;
    const byCategory = {};
    for (const c of state.categories) byCategory[c.id] = 0;
    const rows = [];
    const otherRows = [];
    for (const tx of state.transactions) {
      if (tx.month === month && tx.kind !== NOT_COUNTED) {
        const amount = cents(tx.amount);
        const id = cats.id(tx);
        const kind = cats.of(id);
        byCategory[id] = (byCategory[id] || 0) + amount;
        totals[kind] += amount;
        if (kind === 'unknown') {
          if (amount > 0) unknownIn += amount;
          else unknownOut += amount;
        }
        rows.push(tx);
      } else if (tx.month === month || monthOf(tx.date) === month) {
        otherRows.push(tx);
      }
    }
    rows.sort(byDateDesc);
    otherRows.sort(byDateDesc);
    const left = totals.income + totals.fixed + totals.daily + totals.oneoff + totals.unknown;
    return { ...totals, unknownIn: unknownIn + 0, unknownOut: unknownOut + 0, byCategory, left, rows, otherRows };
  }

  // The month screen's tiles and what lies behind each one. One source for the tile numbers AND
  // their popups, so the two can never disagree. Sections, by category kind of the COUNTED payments of month
  // (tx.month === month, kind ≠ telt-niet-mee, the same set as monthSummary):
  //   income (Income, value = amount), fixed (Fixed costs), daily (Daily spending), oneoff (One-off)
  //   (value = −amount: spending is positive, money back negative), unknown (Not sorted yet, value = amount, signed).
  // section = {key, dir (+1 | −1: value = dir × amount), total (Σ value = the number the tile shows), amount (Σ signed
  //   amounts = monthSummary[key]), moneyIn (Σ amounts > 0), moneyOut (Σ amounts < 0), count,
  //   payees: one per category + shown name (lowercased, trimmed), biggest value first ('unknown': biggest size first):
  //     [{key, categoryId, name (of its newest payment), total, amount, count, payments (newest first)}],
  //   elsewhere: payments of this section's kind PAID in month (by date) that count for another month (not in total),
  //     newest first}.
  // payment = {id, date, name, description, amount, value, kind, categoryId, paidIn (the month of date, 'YYYY-MM', when
  //   that is another month than the one it counts for — also on the elsewhere notes — else null), countsIn (tx.month)}.
  // left = {total (= monthSummary.left, the "Left this month" tile), parts: [{key, amount}] for income, fixed, daily,
  //   oneoff, unknown (signed, Σ = total), notCounted: {amount, count}} — notCounted = payments that do not count
  //   ("doesn't count" paid in month, plus counted payments in a transfer category): the recap's transfersNet.
  const TILE_SECTIONS = [
    ['income', 1],
    ['fixed', -1],
    ['daily', -1],
    ['oneoff', -1],
    ['unknown', 1],
  ];

  function tilePayment(tx, categoryId, dir) {
    const amount = cents(tx.amount);
    const paid = monthOf(tx.date);
    return {
      id: tx.id,
      date: tx.date,
      name: String(tx.name ?? '').trim(),
      description: String(tx.description ?? ''),
      amount,
      value: dir * amount + 0,
      kind: tx.kind,
      categoryId,
      paidIn: paid !== tx.month ? paid : null, // against the month it counts for, not the month on screen
      countsIn: tx.month,
    };
  }

  function byPaymentOrder(a, b) {
    return byDateDesc(a, b) || a.name.localeCompare(b.name, 'en') || String(a.id).localeCompare(String(b.id));
  }

  function tileBreakdown(state, month) {
    const cats = categoryKinds(state);
    const sections = {};
    for (const [key, dir] of TILE_SECTIONS) {
      sections[key] = { key, dir, total: 0, amount: 0, moneyIn: 0, moneyOut: 0, count: 0, payees: new Map(), elsewhere: [] };
    }
    const notCounted = { amount: 0, count: 0 };
    for (const tx of state.transactions) {
      const amount = cents(tx.amount);
      const categoryId = cats.id(tx);
      const kind = cats.of(categoryId);
      const paidHere = monthOf(tx.date) === month;
      if (tx.kind === NOT_COUNTED) {
        if (paidHere) {
          notCounted.amount += amount;
          notCounted.count++;
        }
        continue;
      }
      if (tx.month !== month) {
        if (paidHere && sections[kind]) sections[kind].elsewhere.push(tilePayment(tx, categoryId, sections[kind].dir));
        continue;
      }
      if (kind === 'transfer') {
        notCounted.amount += amount;
        notCounted.count++;
        continue;
      }
      const section = sections[kind];
      const payment = tilePayment(tx, categoryId, section.dir);
      section.total += payment.value;
      section.amount += amount;
      if (amount > 0) section.moneyIn += amount;
      else section.moneyOut += amount;
      section.count++;
      const groupKey = `${categoryId}|${payeeKey(tx.name)}`;
      let payee = section.payees.get(groupKey);
      if (!payee) {
        payee = { key: groupKey, categoryId, name: '', total: 0, amount: 0, count: 0, payments: [] };
        section.payees.set(groupKey, payee);
      }
      payee.total += payment.value;
      payee.amount += amount;
      payee.count++;
      payee.payments.push(payment);
    }

    const result = {};
    for (const [key] of TILE_SECTIONS) {
      const s = sections[key];
      const size = key === 'unknown' ? (p) => Math.abs(p.total) : (p) => p.total;
      const payees = [...s.payees.values()].map((p) => {
        p.payments.sort(byPaymentOrder);
        return { ...p, name: p.payments[0].name, total: p.total + 0, amount: p.amount + 0 };
      });
      payees.sort((a, b) => size(b) - size(a) || a.name.localeCompare(b.name, 'en') || a.key.localeCompare(b.key));
      result[key] = {
        key,
        dir: s.dir,
        total: s.total + 0,
        amount: s.amount + 0,
        moneyIn: s.moneyIn + 0,
        moneyOut: s.moneyOut + 0,
        count: s.count,
        payees,
        elsewhere: s.elsewhere.sort(byPaymentOrder),
      };
    }
    const parts = TILE_SECTIONS.map(([key]) => ({ key, amount: result[key].amount }));
    result.left = {
      total: parts.reduce((sum, p) => sum + p.amount, 0) + 0,
      parts,
      notCounted: { amount: notCounted.amount + 0, count: notCounted.count },
    };
    return result;
  }

  // The statement for month with both balances; a PDF statement wins over CSV, then the newest import.
  function statementFor(state, month) {
    const candidates = state.statements.filter((s) => s.month === month
      && Number.isSafeInteger(s.startBalance) && Number.isSafeInteger(s.endBalance));
    candidates.sort((a, b) => (a.source === 'pdf' ? 0 : 1) - (b.source === 'pdf' ? 0 : 1)
      || String(b.importedAt || '').localeCompare(String(a.importedAt || '')));
    return candidates[0] || null;
  }

  // "What really happened" for month M. change = sum of all rows = sum of the bank payments
  // booked in M, so startBalance + change = endBalance whenever the data is complete.
  //  - income in M splits per payee (key 'in:<payeeId>'): 'every month' income -> normal part
  //    (normalAmounts, else the actual total) + extra (actual − normal, may be negative); other income is extra;
  //  - fixed/daily/oneoff/unknown: counted payments of M by category kind;
  //  - paidForOtherMonth: booked in M, counts for another month;
  //  - paidInEarlierMonth / paidInLaterMonth: counts for M but booked before / after M (added back, sign flipped);
  //  - transfersNet: telt-niet-mee payments booked in M, plus counted payments in a transfer category;
  //  - notViaBank: minus the hand-added payments booked in M (cash etc. never moved the bank balance).
  function monthRecap(state, month) {
    const cats = categoryKinds(state);
    const rows = {
      normalIncome: 0,
      extraIncome: 0,
      fixed: 0,
      daily: 0,
      oneoff: 0,
      unknown: 0,
      paidForOtherMonth: 0,
      paidInEarlierMonth: 0,
      paidInLaterMonth: 0,
      transfersNet: 0,
      notViaBank: 0,
    };
    const regularIncome = new Map(); // normalKey -> actual total this month
    for (const tx of state.transactions) {
      const amount = cents(tx.amount);
      const bookedIn = monthOf(tx.date);
      const bookedHere = bookedIn === month;
      if (bookedHere && tx.source === 'hand') rows.notViaBank -= amount;
      if (tx.kind === NOT_COUNTED) {
        if (bookedHere) rows.transfersNet += amount;
        continue;
      }
      if (tx.month !== month) {
        if (bookedHere) rows.paidForOtherMonth += amount;
        continue;
      }
      if (bookedIn < month) rows.paidInEarlierMonth -= amount;
      else if (bookedIn > month) rows.paidInLaterMonth -= amount;
      const kind = cats.of(cats.id(tx));
      if (kind === 'income') {
        if (tx.kind === EVERY_MONTH) {
          const key = normalKey('in', payeeIdOf(tx));
          regularIncome.set(key, (regularIncome.get(key) || 0) + amount);
        } else {
          rows.extraIncome += amount;
        }
      } else if (kind === 'transfer') {
        rows.transfersNet += amount;
      } else {
        rows[kind] += amount;
      }
    }
    for (const [key, actual] of regularIncome) {
      const stored = storedNormal(state, key);
      const normal = stored === null ? actual : stored;
      rows.normalIncome += normal;
      rows.extraIncome += actual - normal;
    }
    for (const key of Object.keys(rows)) rows[key] += 0; // no negative zeros
    const change = Object.values(rows).reduce((sum, v) => sum + v, 0);
    const statement = statementFor(state, month);
    if (!statement) return { startBalance: null, ...rows, change, endBalance: null, statementCheck: null };
    const diff = statement.startBalance + change - statement.endBalance;
    return {
      startBalance: statement.startBalance,
      ...rows,
      change,
      endBalance: statement.endBalance,
      statementCheck: { ok: diff === 0, diff },
    };
  }

  // The display name of a payee group: the names of its payments in their latest month, newest first; different
  // names are joined with " + ".
  function groupName(latest) {
    const seen = new Set();
    const names = [];
    for (const tx of [...latest].sort(byDateDesc)) {
      const key = payeeKey(tx.name);
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(String(tx.name ?? '').trim());
    }
    return names.join(' + ');
  }

  // "My normal month": one item per payee (payeeId) AND side ('in' = income-kind category,
  // 'uit' = fixed-kind category) with 'every month' payments that count for one of the last 2 booked months (or
  // later). item = {key: normalKey(side, payeeId), payeeId, side, name, categoryId (of the newest payment in the
  // latest month), normal (signed: + for in, − for uit), lastActual (signed total of that payee+side in its latest
  // month), lastCount (payments in that month), custom}; normal = ±normalAmounts[key] when stored, else lastActual.
  // dailyAvg = average counted daily spending over the last (up to) 3 booked months.
  // save = income + fixed + dailyAvg; saveRounded = save rounded down to a multiple of €5.
  function normalMonth(state) {
    const cats = categoryKinds(state);
    const months = averageMonths(state);
    const from = months.slice(-2)[0];
    const groups = new Map();
    for (const tx of from === undefined ? [] : state.transactions) {
      if (tx.kind !== EVERY_MONTH || tx.month < from) continue;
      const side = sideOfKind(cats.of(tx.categoryId));
      if (!side) continue;
      const payeeId = payeeIdOf(tx);
      const key = normalKey(side, payeeId);
      const group = groups.get(key);
      if (!group) groups.set(key, { key, payeeId, side, month: tx.month, latest: [tx] });
      else if (tx.month > group.month) Object.assign(group, { month: tx.month, latest: [tx] });
      else if (tx.month === group.month) group.latest.push(tx);
    }

    const order = new Map(state.categories.map((c, i) => [c.id, i]));
    const items = [...groups.values()].map((g) => {
      const newest = [...g.latest].sort(byDateDesc)[0];
      const lastActual = g.latest.reduce((sum, tx) => sum + cents(tx.amount), 0) + 0;
      const stored = storedNormal(state, g.key);
      return {
        key: g.key,
        payeeId: g.payeeId,
        side: g.side,
        name: groupName(g.latest),
        categoryId: newest.categoryId,
        normal: stored === null ? lastActual : withSide(g.side, stored),
        lastActual,
        lastCount: g.latest.length,
        custom: stored !== null,
      };
    });
    items.sort((a, b) => order.get(a.categoryId) - order.get(b.categoryId) || a.name.localeCompare(b.name, 'en')
      || a.key.localeCompare(b.key));

    let income = 0;
    let fixed = 0;
    for (const item of items) {
      if (item.side === 'in') income += item.normal;
      else fixed += item.normal;
    }

    const dailyMonths = new Set(months.slice(-3));
    let daily = 0;
    for (const tx of state.transactions) {
      if (tx.kind !== NOT_COUNTED && dailyMonths.has(tx.month) && cats.of(cats.id(tx)) === 'daily') daily += cents(tx.amount);
    }
    const dailyAvg = dailyMonths.size ? Math.round(daily / dailyMonths.size) + 0 : 0;
    const save = income + fixed + dailyAvg;
    return { items, income, fixed, dailyAvg, save, saveRounded: Math.floor(save / SAVE_STEP) * SAVE_STEP + 0 };
  }

  // "Higher than normal": spending categories (kind fixed/daily/oneoff: huur, zorg, vast,
  // dagelijks, eenmalig; never onbekend, income or transfers) whose spending in month is more than 25 % above the
  // average of all earlier booked months AND at least € 10 more. Spending = the size of the counted negative
  // amounts only (refunds and other money in are left out). Needs ≥ 2 earlier months.
  // amount/average are signed like transactions (−spending); diff = extra spending (> 0).
  function alerts(state, month) {
    const previous = averageMonths(state).filter((m) => m < month);
    if (previous.length < ALERT_MIN_PREVIOUS) return [];
    const cats = categoryKinds(state);
    const wanted = new Set([month, ...previous]);
    const spending = new Map(); // `${month}|${categoryId}` -> spent cents (positive)
    for (const tx of state.transactions) {
      const amount = cents(tx.amount);
      if (tx.kind === NOT_COUNTED || !wanted.has(tx.month) || amount >= 0) continue;
      const key = `${tx.month}|${cats.id(tx)}`;
      spending.set(key, (spending.get(key) || 0) - amount);
    }
    const n = previous.length;
    const result = [];
    for (const c of state.categories) {
      if (!ALERT_KINDS.has(cats.of(c.id))) continue;
      const spent = spending.get(`${month}|${c.id}`) || 0;
      const spentBefore = previous.reduce((sum, m) => sum + (spending.get(`${m}|${c.id}`) || 0), 0);
      // spent > 1.25 × average and spent − average ≥ € 10, in exact integer arithmetic
      if (spent * n * 4 <= spentBefore * 5 || spent * n - spentBefore < ALERT_MIN_DIFF * n) continue;
      const average = Math.round(spentBefore / n) + 0;
      result.push({ categoryId: c.id, amount: -spent + 0, average: -average + 0, diff: spent - average });
    }
    return result;
  }

  // Savings goal vs "Left this month"; null when no goal is set. pct is not capped (may exceed 100).
  function goalProgress(state, month) {
    const goal = cents(state.settings.savingsGoal);
    if (goal <= 0) return null;
    const left = monthSummary(state, month).left;
    return { goal, left, pct: Math.max(0, Math.round((left * 100) / goal)) };
  }

  Budget.calc = {
    payeeKey,
    payeeIdOf,
    normalKey,
    monthsWithData,
    bookedMonths,
    latestBookedMonth,
    isBookedMonth,
    monthSummary,
    tileBreakdown,
    monthRecap,
    normalMonth,
    alerts,
    goalProgress,
  };
})();
