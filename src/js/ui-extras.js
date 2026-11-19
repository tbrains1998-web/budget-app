/* Budget.uiExtras: "All months" overview, savings-goal bar, "Higher than normal" badges,
   backup/restore, banners, print and the settings dialog. */
(function () {
  'use strict';

  const Budget = (globalThis.Budget = globalThis.Budget || {});

  const KIND_LABELS = {
    'elke-maand': 'every month',
    wisselend: 'varies',
    eenmalig: 'one-off',
    'telt-niet-mee': "doesn't count",
  };
  const OVER_COLOR = 'var(--cat-over)';
  const SHORT_COLOR = 'var(--neg)';
  const CHART = {
    height: 230,
    padTop: 12,
    padRight: 8,
    padBottom: 38,
    padLeft: 60,
    minGroup: 46, // px per month; below this the chart scrolls sideways inside its card
    maxBar: 22,
    barGap: 2,
    stackGap: 2,
    radius: 4,
    fallbackWidth: 640,
  };

  const fmt = (cents, opts) => Budget.util.formatEuro(cents, opts);

  // ---------------------------------------------------------------- pure helpers

  /** Rounded axis range and tick values (cents) covering lo..hi; steps are whole euros. */
  function niceScale(lo, hi, maxTicks = 4) {
    if (hi - lo <= 0) hi = lo + 10000;
    const raw = (hi - lo) / maxTicks;
    const mag = Math.max(100, 10 ** Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((f) => f * mag).find((s) => s >= raw);
    const niceLo = Math.floor(lo / step) * step;
    const niceHi = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let v = niceLo; v <= niceHi; v += step) ticks.push(v);
    return { lo: niceLo, hi: niceHi, step, ticks };
  }

  function categoryKinds(state) {
    return new Map(state.categories.map((c) => [c.id, c.kind]));
  }

  /**
   * Per month (oldest first), from the payments that count in it, transfers left out:
   * income = Σ money in, spend = Σ money out (as a positive number, never below 0), left = income − spend (= "Left
   * this month"), stack = the money out per category (in category order; it adds up to spend) and booked = false
   * for a month the bank has not booked yet.
   */
  function monthSeries(state) {
    const { calc } = Budget;
    const kinds = categoryKinds(state);
    const order = state.categories.map((c) => c.id);
    return calc
      .monthsWithData(state)
      .slice()
      .sort()
      .map((month) => {
        const summary = calc.monthSummary(state, month);
        const perCat = new Map();
        let income = 0;
        let spend = 0;
        for (const tx of summary.rows) {
          const id = kinds.has(tx.categoryId) ? tx.categoryId : 'onbekend';
          if ((kinds.get(id) || 'unknown') === 'transfer') continue;
          if (tx.amount > 0) {
            income += tx.amount;
          } else if (tx.amount < 0) {
            spend -= tx.amount;
            perCat.set(id, (perCat.get(id) || 0) - tx.amount);
          }
        }
        const stack = [...perCat.keys()]
          .sort((a, b) => order.indexOf(a) - order.indexOf(b))
          .map((id) => ({ categoryId: id, value: perCat.get(id) }));
        return { month, income, spend, left: income - spend, stack, booked: calc.isBookedMonth(state, month) };
      });
  }

  /** SVG path for a bar from yBase to yEnd with rounded corners (radius r) at the yEnd side only. */
  function barPath(x, yBase, yEnd, w, r) {
    const n = (v) => Math.round(v * 10) / 10;
    const d = yEnd < yBase ? 1 : -1;
    const rr = Math.max(0, Math.min(r, w / 2, Math.abs(yBase - yEnd)));
    return (
      `M${n(x)} ${n(yBase)}V${n(yEnd + d * rr)}` +
      `Q${n(x)} ${n(yEnd)} ${n(x + rr)} ${n(yEnd)}H${n(x + w - rr)}` +
      `Q${n(x + w)} ${n(yEnd)} ${n(x + w)} ${n(yEnd + d * rr)}V${n(yBase)}Z`
    );
  }

  /** Geometry for the month chart; all numbers are SVG user units (= CSS px at scale 1). */
  function chartLayout(series, { goal = 0, width = CHART.fallbackWidth } = {}) {
    const C = CHART;
    const count = Math.max(series.length, 1);
    const groupW = Math.max(C.minGroup, (width - C.padLeft - C.padRight) / count);
    const fullW = Math.max(width, Math.round(C.padLeft + C.padRight + groupW * count));
    const values = [0, goal > 0 ? goal : 0];
    for (const m of series) {
      values.push(m.income, m.left, m.stack.reduce((sum, s) => sum + s.value, 0));
    }
    const scale = niceScale(Math.min(...values), Math.max(...values));
    const top = C.padTop;
    const bottom = C.height - C.padBottom;
    const y = (v) => top + ((scale.hi - v) / (scale.hi - scale.lo)) * (bottom - top);
    const zeroY = y(0);
    const barW = Math.min(C.maxBar, (groupW - 12 - 2 * C.barGap) / 3);
    const groups = series.map((m, i) => {
      const x = C.padLeft + i * groupW;
      const x0 = x + (groupW - 3 * barW - 2 * C.barGap) / 2;
      const bars = [];
      if (m.income > 0) {
        bars.push({ role: 'in', path: barPath(x0, zeroY, y(m.income), barW, C.radius) });
      }
      let acc = 0;
      m.stack.forEach((seg, k) => {
        const isTop = k === m.stack.length - 1;
        const base = y(acc) - (k > 0 ? C.stackGap : 0);
        const end = Math.min(y(acc + seg.value), base - 1);
        acc += seg.value;
        bars.push({
          role: 'out',
          categoryId: seg.categoryId,
          path: barPath(x0 + barW + C.barGap, base, end, barW, isTop ? C.radius : 0),
        });
      });
      if (m.left !== 0) {
        bars.push({
          role: m.left > 0 ? 'left' : 'short',
          path: barPath(x0 + 2 * (barW + C.barGap), zeroY, y(m.left), barW, C.radius),
        });
      }
      return { month: m.month, x, w: groupW, cx: x + groupW / 2, bars, pending: m.booked === false };
    });
    return {
      width: fullW,
      height: C.height,
      plotLeft: C.padLeft,
      plotRight: fullW - C.padRight,
      plotTop: top,
      plotBottom: bottom,
      zeroY,
      goalY: goal > 0 ? y(goal) : null,
      ticks: scale.ticks.map((v) => ({ value: v, y: y(v) })),
      groups,
    };
  }

  /** The date of an instant in the PC's own time zone as YYYY-MM-DD (util.todayIso). */
  function isoDay(date) {
    return Budget.util.todayIso(date);
  }

  /** budget-backup-YYYY-MM-DD.json with the local date of `date`. */
  function backupFileName(date) {
    return `budget-backup-${isoDay(date)}.json`;
  }

  /** True when a bank file was imported after the last backup (or no backup was ever made). */
  function needsBackupReminder(settings) {
    const imported = Date.parse(settings && settings.lastImportAt);
    if (!Number.isFinite(imported)) return false;
    const backedUp = Date.parse(settings.lastBackupAt);
    return !Number.isFinite(backedUp) || imported > backedUp;
  }

  /** "Jansen, de  Vries,, jansen" → ['Jansen', 'de Vries'] (trimmed, deduplicated case-insensitively). */
  function parseWordList(text) {
    const seen = new Set();
    const words = [];
    for (const part of String(text || '').split(/[,;\n]/)) {
      const word = part.trim().replace(/\s+/g, ' ');
      const key = word.toLowerCase();
      if (!word || seen.has(key)) continue;
      seen.add(key);
      words.push(word);
    }
    return words;
  }

  /** Cents → plain input text: 30000 → '300', 25050 → '250.50', 0 → ''. */
  function centsToInput(cents) {
    if (!Number.isFinite(cents) || cents <= 0) return '';
    return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
  }

  /**
   * The name shown for a payee rule (match.payeeId): that payee's newest payment as it is shown now (its name may
   * have lost hidden words or the holder's name, which the rule does not keep either), or null.
   */
  function payeeName(payeeId, transactions) {
    let best = null;
    for (const t of transactions || []) {
      const id = typeof t.payeeId === 'string' && t.payeeId ? t.payeeId : Budget.util.payeeId(t.name);
      if (id === payeeId && (!best || String(t.date) > String(best.date))) best = t;
    }
    return best ? best.name : null;
  }

  /**
   * One-line description of a rule: {when, then}. transactions (optional): to name the payee of a payee
   * rule ("Same receiver as 'X'").
   */
  function ruleSummary(rule, categories, transactions = []) {
    const match = rule.match || {};
    const set = rule.set || {};
    const when = [];
    if (match.payeeId) {
      const who = match.sign === 'in' ? 'sender' : match.sign === 'out' ? 'receiver' : 'sender or receiver';
      const name = payeeName(match.payeeId, transactions);
      when.push(name === null ? `same ${who} as a payment that is no longer there` : `same ${who} as '${name}'`);
    }
    if (match.nameContains) when.push(`name contains '${match.nameContains}'`);
    if (match.descriptionContains) when.push(`description contains '${match.descriptionContains}'`);
    if (match.bankCode) when.push(`bank ${match.bankCode}`);
    if (match.sign === 'in') when.push('money in');
    if (match.sign === 'out') when.push('money out');
    const text = when.length ? when.join(' and ') : 'all payments';
    const then = [];
    if (set.categoryId) {
      const cat = categories.find((c) => c.id === set.categoryId);
      then.push(cat ? cat.name : set.categoryId);
    }
    if (set.kind) then.push(KIND_LABELS[set.kind] || set.kind);
    if (set.rename) then.push(`call it: '${set.rename}'`);
    return { when: text.charAt(0).toUpperCase() + text.slice(1), then: `→ ${then.join(' · ') || 'nothing'}` };
  }

  /** Display model for the savings-goal bar from calc.goalProgress, or null when no goal is set. */
  function goalView(progress) {
    if (!progress) return null;
    return {
      text: `${fmt(progress.left, { whole: true })} of ${fmt(progress.goal, { whole: true })} — ${progress.pct}%`,
      width: Math.min(100, progress.pct),
      reached: progress.left >= progress.goal,
      short: progress.left < 0,
    };
  }

  /** Quick shape check of a parsed backup file, for the confirm text. Full validation is store.importBackup. */
  function describeBackup(backup) {
    const state = backup && backup.app === 'budget-nl' ? backup.state : null;
    if (!state || !Array.isArray(state.transactions)) return null;
    const exported = new Date(backup.exportedAt);
    const monthOf = (t) => {
      if (!t) return null;
      if (typeof t.month === 'string' && t.month) return t.month;
      return typeof t.date === 'string' && /^\d{4}-\d{2}/.test(t.date) ? t.date.slice(0, 7) : null;
    };
    return {
      transactions: state.transactions.length,
      months: new Set(state.transactions.map(monthOf).filter(Boolean)).size,
      exportedDay: Number.isNaN(exported.getTime()) ? null : isoDay(exported),
    };
  }

  function countText(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  /** The "Restore backup" question, with singular/plural for payments and months. */
  function restoreMessage(info, currentCount) {
    const made = info.exportedDay ? ` from ${Budget.util.shortDate(info.exportedDay)} ${info.exportedDay.slice(0, 4)}` : '';
    return (
      `Restore backup${made}? It holds ${countText(info.transactions, 'payment', 'payments')} from ` +
      `${countText(info.months, 'month', 'months')}. Your current data (${countText(currentCount, 'payment', 'payments')}) ` +
      'will be replaced.'
    );
  }

  /**
   * What a rule does after editing it in Settings › Rules: {set} or {error} (a plain message).
   * categoryId / kind: '' = leave unchanged; rename: '' = keep the name.
   */
  function ruleSetFrom({ categoryId = '', kind = '', rename = '' } = {}) {
    const set = {};
    if (categoryId) set.categoryId = categoryId;
    if (kind) set.kind = kind;
    const name = String(rename || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (name) set.rename = name;
    if (!Object.keys(set).length) return { error: 'Choose a category, a kind or a name. Or delete the rule.' };
    return { set };
  }

  /** 'Sep' for '2026-09'. */
  function shortMonth(month) {
    return Budget.util.shortMonthName(month);
  }

  function catColor(id) {
    return `var(--cat-${id})`;
  }

  /** The chart as an SVG string. Every text goes through ui.esc. */
  function chartSvg(layout, series) {
    const esc = Budget.ui.esc;
    const n = (v) => Math.round(v * 10) / 10;
    const parts = [];
    for (const t of layout.ticks) {
      if (t.value !== 0) {
        parts.push(`<line class="x-grid" x1="${layout.plotLeft}" x2="${layout.plotRight}" y1="${n(t.y)}" y2="${n(t.y)}"/>`);
      }
      parts.push(
        `<text class="x-axis" x="${layout.plotLeft - 8}" y="${n(t.y)}" dy="0.35em" text-anchor="end">` +
          `${esc(fmt(t.value, { whole: true }))}</text>`,
      );
    }
    layout.groups.forEach((g, i) => {
      const m = series[i];
      const label = Budget.util.monthLabel(g.month);
      const pendingText = g.pending ? ' Not read yet.' : '';
      const aria = `${label}: in ${fmt(m.income)}, out ${fmt(m.spend)}, left ${fmt(m.left)}.${pendingText} Click to open.`;
      const marks = g.bars.map((b) => {
        const style = b.role === 'out' ? ` style="fill:${esc(catColor(b.categoryId))}"` : '';
        return `<path class="x-bar x-${b.role}" d="${b.path}"${style}/>`;
      });
      const showYear = i === 0 || g.month.endsWith('-01');
      const textY = layout.plotBottom + 17;
      parts.push(
        `<g class="x-group${g.pending ? ' x-pending' : ''}" data-month="${esc(g.month)}" tabindex="0" role="button" aria-label="${esc(aria)}">` +
          `<rect class="x-hit" x="${n(g.x + 2)}" y="2" width="${n(g.w - 4)}" height="${layout.height - 4}" rx="8"/>` +
          marks.join('') +
          `<text class="x-axis x-month" x="${n(g.cx)}" y="${textY}" text-anchor="middle">${esc(shortMonth(g.month))}</text>` +
          (showYear
            ? `<text class="x-axis" x="${n(g.cx)}" y="${textY + 14}" text-anchor="middle">${esc(g.month.slice(0, 4))}</text>`
            : '') +
          '</g>',
      );
    });
    parts.push(
      `<line class="x-zero-line" x1="${layout.plotLeft}" x2="${layout.plotRight}" y1="${n(layout.zeroY)}" y2="${n(layout.zeroY)}"/>`,
    );
    if (layout.goalY !== null) {
      parts.push(
        `<line class="x-goal-line" x1="${layout.plotLeft}" x2="${layout.plotRight}" y1="${n(layout.goalY)}" y2="${n(layout.goalY)}"/>`,
      );
    }
    return (
      `<svg class="x-chart-svg" viewBox="0 0 ${layout.width} ${layout.height}" role="group" ` +
      `aria-label="Income, spending and what was left per month">${parts.join('')}</svg>`
    );
  }

  // ---------------------------------------------------------------- DOM helpers

  function el(tag, attrs, ...children) {
    return Budget.ui.el(tag, attrs, ...children);
  }

  function on(node, type, handler) {
    node.addEventListener(type, handler);
    return node;
  }

  function button(cls, label, handler) {
    return on(el('button', { type: 'button', class: cls }, label), 'click', handler);
  }

  function showError(title, message) {
    Budget.ui.dialog({ title, body: el('p', {}, message), actions: [{ label: 'OK', primary: true }] });
  }

  /** The month the app opens on: the newest month the bank booked. */
  function latestMonth(state) {
    return Budget.calc.latestBookedMonth(state);
  }

  /** Toast with "Undo" for exactly the change that returned token. */
  function undoToast(message, token, onUndo) {
    return Budget.ui.undoToast(message, token, { onUndo });
  }

  // ---------------------------------------------------------------- All months

  let chartObserver = null;

  function renderAll() {
    const root = document.getElementById('all-months');
    if (!root) return;
    if (chartObserver) {
      chartObserver.disconnect();
      chartObserver = null;
    }
    const state = Budget.store.get();
    const series = monthSeries(state);
    // The top bar already says "All months"; the card has no second heading.
    const card = (...children) => el('section', { class: 'card x-all', 'aria-label': 'All months' }, ...children);
    if (!series.length) {
      root.replaceChildren(card(el('p', { class: 'muted' }, 'No months yet. Add a bank file first.')));
      return;
    }
    const goal = state.settings.savingsGoal > 0 ? state.settings.savingsGoal : 0;
    const scroller = el('div', { class: 'x-chart-scroll' });
    const tip = el('div', { class: 'x-tip', hidden: '' });
    const chart = el('div', { class: 'x-chart' }, scroller, tip);
    root.replaceChildren(card(chart, chartLegend(state, series, goal), monthTable(series)));
    let drawnWidth = -1;
    const draw = () => {
      const width = Math.round(chart.clientWidth);
      if (width === drawnWidth) return;
      drawnWidth = width;
      drawChart({ scroller, tip, chart }, state, series, goal, width || CHART.fallbackWidth);
    };
    draw();
    if (typeof ResizeObserver === 'function') {
      chartObserver = new ResizeObserver(draw);
      chartObserver.observe(chart);
    }
  }

  function drawChart(parts, state, series, goal, width) {
    const { scroller, tip, chart } = parts;
    const layout = chartLayout(series, { goal, width });
    scroller.innerHTML = chartSvg(layout, series);
    const svg = scroller.firstElementChild;
    if (layout.width > width) svg.style.width = `${layout.width}px`;
    scroller.scrollLeft = scroller.scrollWidth;
    tip.hidden = true;
    const byMonth = new Map(series.map((m) => [m.month, m]));
    for (const group of svg.querySelectorAll('.x-group')) {
      const month = group.getAttribute('data-month');
      const open = () => Budget.app.go({ view: 'month', month });
      const show = () => showTip(tip, chart, svg, layout, byMonth.get(month), state.categories);
      on(group, 'click', open);
      on(group, 'keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
      on(group, 'pointerenter', show);
      on(group, 'focus', show);
      on(group, 'pointerleave', () => (tip.hidden = true));
      on(group, 'blur', () => (tip.hidden = true));
    }
  }

  function tipRow(value, label, color, cls) {
    return el(
      'div',
      { class: `x-tip-row ${cls || ''}`.trim() },
      el('span', { class: 'x-tip-key', style: `--c:${color}` }),
      el('span', { class: 'x-tip-label' }, label),
      el('strong', {}, value),
    );
  }

  function showTip(tip, chart, svg, layout, m, categories) {
    const names = new Map(categories.map((c) => [c.id, c.name]));
    const short = m.left < 0 && m.booked !== false;
    const rows = [
      el('div', { class: 'x-tip-title' }, Budget.util.monthLabel(m.month)),
      m.booked === false ? el('div', { class: 'x-tip-note' }, 'not read yet') : null,
      tipRow(fmt(m.income), 'Income', catColor('inkomen'), 'x-tip-in'),
      tipRow(fmt(m.spend), 'Spending', 'transparent'),
      ...m.stack.map((s) => tipRow(fmt(s.value), names.get(s.categoryId) || s.categoryId, catColor(s.categoryId), 'x-tip-sub')),
      tipRow(fmt(m.left, { sign: true }), short ? 'Short' : 'Left', short ? SHORT_COLOR : OVER_COLOR),
    ].filter(Boolean);
    tip.replaceChildren(...rows);
    tip.hidden = false;
    const g = layout.groups.find((x) => x.month === m.month);
    const svgBox = svg.getBoundingClientRect();
    const chartBox = chart.getBoundingClientRect();
    const scale = svgBox.width / layout.width;
    const right = svgBox.left - chartBox.left + (g.x + g.w) * scale;
    const left = svgBox.left - chartBox.left + g.x * scale;
    const tipW = tip.offsetWidth;
    let x = right + 6;
    if (x + tipW > chartBox.width) x = left - tipW - 6;
    tip.style.left = `${Math.max(0, Math.min(x, chartBox.width - tipW))}px`;
  }

  function chartLegend(state, series, goal) {
    const used = new Set(series.flatMap((m) => m.stack.map((s) => s.categoryId)));
    const key = (color, label, cls) =>
      el('li', {}, el('span', { class: `x-key ${cls || ''}`.trim(), style: `--c:${color}` }), label);
    const items = [key(catColor('inkomen'), 'Income', 'x-key-in')];
    for (const c of state.categories) {
      if (used.has(c.id)) items.push(key(catColor(c.id), c.name));
    }
    items.push(key(OVER_COLOR, 'Left'));
    if (series.some((m) => m.left < 0 && m.booked !== false)) items.push(key(SHORT_COLOR, 'Short'));
    if (series.some((m) => m.booked === false)) items.push(key('var(--text-muted)', 'Not read yet', 'x-key-pending'));
    if (goal > 0) items.push(key(OVER_COLOR, `Savings goal ${fmt(goal, { whole: true })}`, 'x-key-line'));
    return el('ul', { class: 'x-legend' }, ...items);
  }

  function monthTable(series) {
    const rows = series
      .slice()
      .reverse()
      .map((m) => {
        const pending = m.booked === false;
        let leftCls = m.left < 0 ? 'x-neg' : 'x-pos';
        if (pending) leftCls = 'x-pending-num';
        return el(
          'tr',
          { class: pending ? 'x-pending-row' : null },
          el(
            'td',
            {},
            button('x-month-link', Budget.util.monthLabel(m.month), () => Budget.app.go({ view: 'month', month: m.month })),
            pending ? el('span', { class: 'x-pending-label' }, 'not read yet') : null,
          ),
          el('td', { class: 'x-num' }, fmt(m.income)),
          el('td', { class: 'x-num' }, fmt(m.spend)),
          el('td', { class: `x-num ${leftCls}` }, fmt(m.left, { sign: true })),
        );
      });
    return el(
      'table',
      { class: 'x-table' },
      el(
        'thead',
        {},
        el('tr', {}, el('th', {}, 'Month'), el('th', { class: 'x-num' }, 'In'), el('th', { class: 'x-num' }, 'Out'), el('th', { class: 'x-num' }, 'Left')),
      ),
      el('tbody', {}, ...rows),
    );
  }

  // ---------------------------------------------------------------- month screen decorations

  function decorateMonth(month) {
    const state = Budget.store.get();
    decorateAlerts(state, month);
    renderGoalBar(state, month);
  }

  function decorateAlerts(state, month) {
    for (const node of document.querySelectorAll('.group[data-cat] .x-badge')) node.remove();
    for (const node of document.querySelectorAll('.group.x-alert')) node.classList.remove('x-alert');
    // A month the bank has not booked yet holds only payments made early for it: comparing it with whole months
    // means nothing, and it shows no red at all.
    if (!Budget.calc.isBookedMonth(state, month)) return;
    for (const alert of Budget.calc.alerts(state, month)) {
      const group = document.querySelector(`.group[data-cat="${CSS.escape(alert.categoryId)}"]`);
      const badges = group && group.querySelector('.badges');
      if (!badges) continue;
      group.classList.add('x-alert');
      badges.append(
        el(
          'span',
          {
            class: 'x-badge',
            title: `On average ${fmt(Math.abs(alert.average), { whole: true })} in earlier months, now ${fmt(Math.abs(alert.amount), { whole: true })}`,
          },
          `Higher than normal (${fmt(Math.abs(alert.diff), { whole: true, sign: true })})`, // "+⁠€x": never wraps
        ),
      );
    }
  }

  // The bar only (nothing else in the savings card); the goal itself is set in ⋯ › Settings.
  function renderGoalBar(state, month) {
    const mount = document.getElementById('goal-bar');
    if (!mount) return;
    const view = goalView(Budget.calc.goalProgress(state, month));
    if (!view) {
      mount.replaceChildren();
      return;
    }
    const short = view.short && Budget.calc.isBookedMonth(state, month); // no red for a month not read in yet
    const cls = ['x-goal', view.reached ? 'x-goal-reached' : '', short ? 'x-goal-short' : ''].join(' ').trim();
    mount.replaceChildren(
      el(
        'div',
        { class: cls },
        el(
          'div',
          { class: 'x-goal-head' },
          el('span', {}, 'Savings goal this month'),
          el('span', { class: 'x-goal-text' }, view.reached ? `✓ ${view.text}` : view.text),
        ),
        el(
          'div',
          {
            class: 'x-goal-track',
            role: 'progressbar',
            'aria-valuemin': '0',
            'aria-valuemax': '100',
            'aria-valuenow': String(view.width),
            'aria-label': 'Savings goal',
          },
          el('div', { class: 'x-goal-fill', style: `width:${view.width}%` }),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- banners, backup, print

  function renderBanners() {
    const root = document.getElementById('banners');
    if (!root) return;
    const banners = [];
    if (Budget.store.storageOk() === false) {
      banners.push(
        el(
          'div',
          { class: 'banner error x-banner', role: 'alert' },
          el('span', {}, 'Your data is NOT being saved in this browser — make a backup'),
          button('btn', 'Make backup', backupNow),
        ),
      );
    } else if (needsBackupReminder(Budget.store.get().settings)) {
      banners.push(
        el(
          'div',
          { class: 'banner warn x-banner' },
          el('span', {}, 'New month read — please make a backup'),
          button('btn primary', 'Make backup', backupNow),
        ),
      );
    }
    root.replaceChildren(...banners);
  }

  function backupNow() {
    const backup = Budget.store.exportBackup();
    const name = backupFileName(new Date(backup.exportedAt));
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const link = el('a', { href: url, download: name, hidden: '' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    // Bookkeeping only: the last edit stays undoable (keepUndo).
    Budget.store.update(
      (s) => {
        s.settings.lastBackupAt = backup.exportedAt;
      },
      { keepUndo: true },
    );
    Budget.ui.toast(`Backup downloaded: ${name}`);
  }

  function restoreFromFile() {
    const input = el('input', { type: 'file', accept: '.json,application/json', hidden: '' });
    on(input, 'change', () => {
      const file = input.files && input.files[0];
      input.remove();
      if (file) restoreFile(file);
    });
    on(input, 'cancel', () => input.remove());
    document.body.append(input);
    input.click();
  }

  async function restoreFile(file) {
    const title = 'Restore backup';
    let backup;
    try {
      backup = JSON.parse(await file.text());
    } catch {
      showError(title, 'I can\'t read this file. Choose a Budget backup file (budget-backup-….json).');
      return;
    }
    const info = describeBackup(backup);
    if (!info) {
      showError(title, 'This is not a Budget backup. Choose a file with a name like budget-backup-2026-10-01.json.');
      return;
    }
    const current = Budget.store.get().transactions.length;
    const ok = await Budget.ui.confirm(restoreMessage(info, current), { title, okLabel: 'Restore', danger: true });
    if (!ok) return;
    try {
      Budget.store.importBackup(backup);
    } catch (err) {
      showError(title, (err && err.message) || 'I can\'t restore this backup. Nothing was changed.');
      return;
    }
    undoToast('Backup restored', Budget.store.topUndoToken());
    const month = latestMonth(Budget.store.get());
    if (month) Budget.app.go({ view: 'month', month });
  }

  function print() {
    window.print();
  }

  // ---------------------------------------------------------------- settings

  /** A small "✓ Saved" note next to a field: {node, flash()}. */
  function savedNote() {
    const node = el('span', { class: 'x-saved', 'aria-live': 'polite' });
    let timer = 0;
    const flash = () => {
      node.textContent = '✓ Saved';
      clearTimeout(timer);
      timer = setTimeout(() => (node.textContent = ''), 2000);
    };
    return { node, flash };
  }

  /** Saves on change and on Enter (Enter must not submit or close the dialog). */
  function onCommit(input, save) {
    on(input, 'change', save);
    on(input, 'keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      save();
    });
  }

  function goalSection(autofocus) {
    const input = el('input', {
      id: 'x-goal-input',
      class: 'input',
      type: 'text',
      autofocus,
      inputmode: 'decimal',
      autocomplete: 'off',
      placeholder: 'e.g. 300',
      value: centsToInput(Budget.store.get().settings.savingsGoal),
    });
    const error = el('p', { class: 'x-error', hidden: '' });
    const note = savedNote();
    onCommit(input, () => {
      const text = input.value.trim();
      const cents = text === '' ? 0 : Budget.util.parseEuro(text);
      input.setAttribute('aria-invalid', String(cents === null));
      error.hidden = cents !== null;
      if (cents === null) {
        error.textContent = 'I don\'t understand that amount. For example, type 300 or 250.50.';
        return;
      }
      const goal = Math.abs(cents);
      input.value = centsToInput(goal);
      if (goal === Budget.store.get().settings.savingsGoal) return;
      Budget.store.update((s) => {
        s.settings.savingsGoal = goal;
      }, { undoLabel: 'Savings goal changed' });
      note.flash();
    });
    return el(
      'section',
      { class: 'x-set' },
      el('h3', {}, el('label', { for: 'x-goal-input' }, 'Savings goal per month')),
      el('div', { class: 'x-field' }, el('span', { class: 'x-prefix' }, '€'), input, note.node),
      error,
      el('p', { class: 'muted x-hint' }, 'How much you want to have left each month. Leave empty = no savings goal.'),
    );
  }

  /** Choice buttons of the month screen's popover (Budget.uiMonth), plus a first "don't change" button. */
  function choiceGroup(label, keep, choices, onKeep) {
    const keepBtn = el('button', { type: 'button', class: 'choice', 'aria-pressed': String(keep), 'data-key': 'keep' }, 'don\'t change');
    on(keepBtn, 'click', onKeep);
    return el(
      'div',
      { class: 'pop-section' },
      el('span', { class: 'pop-label' }, label),
      el('div', { class: 'choice-row', role: 'group', 'aria-label': label }, keepBtn, ...choices),
    );
  }

  /** Inline editor of one rule: category, kind and rename. Saving gives the rule a fresh createdAt. */
  function ruleEditor(rule, state, done) {
    const ui = Budget.uiMonth || {};
    const edit = {
      categoryId: rule.set.categoryId || '',
      kind: rule.set.kind || '',
      rename: rule.set.rename || '',
    };
    const box = el('div', { class: 'x-rule-edit' });
    const rename = el('input', {
      type: 'text',
      class: 'input',
      maxlength: 80,
      autocomplete: 'off',
      placeholder: 'empty = don\'t change the name',
      value: edit.rename,
      'aria-label': 'Name becomes',
    });
    const error = el('p', { class: 'x-error', role: 'alert', hidden: '' });
    const text = ruleSummary(rule, state.categories, state.transactions);
    const drawChoices = () => {
      const categories = ui.categoryChoices
        ? ui.categoryChoices(state.categories, edit.categoryId, (id) => {
          edit.categoryId = id;
          if (Budget.store.defaultKind) edit.kind = Budget.store.defaultKind(id);
          redraw('cat:' + id);
        })
        : [];
      const kinds = ui.kindChoices
        ? ui.kindChoices(edit.kind, (k) => {
          edit.kind = k;
          redraw('kind:' + k);
        })
        : [];
      return [
        choiceGroup('What is it?', !edit.categoryId, categories, () => {
          edit.categoryId = '';
          redraw('keep-cat');
        }),
        choiceGroup('Kind of payment', !edit.kind, kinds, () => {
          edit.kind = '';
          redraw('keep-kind');
        }),
      ];
    };
    const groups = el('div', { class: 'x-rule-choices' });
    function redraw(focusKey) {
      groups.replaceChildren(...drawChoices());
      if (!focusKey) return;
      const [scope, key] = focusKey === 'keep-cat' ? [groups.children[0], 'keep'] : focusKey === 'keep-kind' ? [groups.children[1], 'keep'] : [groups, focusKey];
      const target = scope && [...scope.querySelectorAll('[data-key]')].find((n) => n.getAttribute('data-key') === key);
      if (target) target.focus();
    }
    redraw(null);
    const save = () => {
      const result = ruleSetFrom({ ...edit, rename: rename.value });
      if (result.error) {
        error.textContent = result.error;
        error.hidden = false;
        return;
      }
      const token = Budget.store.update(
        (s) => {
          const r = s.rules.find((x) => x.id === rule.id);
          if (!r) return;
          r.set = result.set;
          r.createdAt = new Date().toISOString();
          // A typed "Name becomes" never keeps a hidden word or the holder's name.
          if (Budget.categorize && typeof Budget.categorize.cleanRules === 'function') Budget.categorize.cleanRules(s);
        },
        { undoLabel: 'Rule changed' },
      );
      done();
      undoToast('Rule changed', token, done);
    };
    on(rename, 'keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      save();
    });
    box.append(
      el('strong', { class: 'x-rule-text x-rule-when' }, text.when),
      groups,
      el('label', { class: 'field x-rule-rename' }, el('span', {}, 'Name becomes'), rename),
      error,
      el('div', { class: 'x-rule-actions' }, button('btn primary small', 'Save', save), button('btn small', 'Cancel', () => done())),
    );
    return box;
  }

  function rulesSection() {
    const list = el('ul', { class: 'x-rules' });
    let editing = null; // id of the rule being edited
    const draw = () => {
      const state = Budget.store.get();
      const rules = state.rules
        .slice()
        .reverse()
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      if (!rules.length) {
        list.replaceChildren(
          el('li', { class: 'muted x-empty' }, "No rules yet. They are made when you choose 'Always do this' for a payment."),
        );
        return;
      }
      if (editing && !rules.some((r) => r.id === editing)) editing = null;
      list.replaceChildren(
        ...rules.map((rule) => {
          if (rule.id === editing) {
            return el(
              'li',
              { class: 'x-rule-editing' },
              ruleEditor(rule, state, () => {
                editing = null;
                draw();
              }),
            );
          }
          const text = ruleSummary(rule, state.categories, state.transactions);
          return el(
            'li',
            {},
            el('div', { class: 'x-rule-text' }, el('strong', {}, text.when), el('span', { class: 'muted' }, text.then)),
            el(
              'div',
              { class: 'x-rule-buttons' },
              button('btn ghost small', 'Change', () => {
                editing = rule.id;
                draw();
                const first = list.querySelector('.x-rule-editing [aria-pressed="true"]');
                if (first) first.focus();
              }),
              button('btn ghost danger small', 'Delete', () => {
                const token = Budget.store.update((s) => {
                  s.rules = s.rules.filter((r) => r.id !== rule.id);
                }, { undoLabel: 'Rule deleted' });
                draw();
                undoToast('Rule deleted', token, draw);
              }),
            ),
          );
        }),
      );
    };
    draw();
    return el(
      'section',
      { class: 'x-set' },
      el('h3', {}, 'Rules'),
      el('p', { class: 'muted x-hint' }, 'With these, payments are sorted by themselves when a file is read.'),
      list,
    );
  }

  function hiddenWordsSection() {
    const input = el('input', {
      id: 'x-hidden-words',
      class: 'input',
      type: 'text',
      autocomplete: 'off',
      placeholder: 'e.g. Jansen',
      value: Budget.store.get().settings.hiddenWords.join(', '),
    });
    const note = savedNote();
    onCommit(input, () => {
      const words = parseWordList(input.value);
      input.value = words.join(', ');
      if (words.join('\n') === Budget.store.get().settings.hiddenWords.join('\n')) return;
      let changed = 0;
      // The payments already read in are cleaned in the same step, so the names change at once.
      const token = Budget.store.update((s) => {
        s.settings.hiddenWords = words;
        if (Budget.categorize && typeof Budget.categorize.recleanState === 'function') changed = Budget.categorize.recleanState(s);
      }, { undoLabel: 'Hidden words changed' });
      note.flash();
      undoToast(hiddenWordsMessage(changed), token, () => {
        input.value = Budget.store.get().settings.hiddenWords.join(', '); // the field follows the undo
      });
    });
    return el(
      'section',
      { class: 'x-set' },
      el('h3', {}, el('label', { for: 'x-hidden-words' }, 'Hide words')),
      el('div', { class: 'x-field' }, input, note.node),
      el(
        'p',
        { class: 'muted x-hint' },
        'These words are left out of payment names, for example your own last name. Separate them with commas. ' +
          'If you later take a word out of this list, it does not come back in payments that already lost it, ' +
          'because the app does not keep the original text from the bank.',
      ),
    );
  }

  /** Toast text after saving "Hide words": how many payments changed. */
  function hiddenWordsMessage(changed) {
    if (!changed) return 'Saved. No payment had to change.';
    return `Saved. ${countText(changed, 'payment', 'payments')} changed.`;
  }

  function wipeSection(closeSettings) {
    return el(
      'section',
      { class: 'x-set x-wipe' },
      el('h3', {}, 'Clear everything'),
      el('p', { class: 'muted x-hint' }, 'Removes all payments, rules and settings from this browser.'),
      button('btn danger', 'Clear everything…', async () => {
        closeSettings();
        const title = 'Clear everything';
        const first = await Budget.ui.confirm(
          'All your payments, statements, rules and settings will be removed from this browser.',
          { title, okLabel: 'Yes, clear', danger: true },
        );
        if (!first) return;
        const second = await Budget.ui.confirm('Really clear everything? Make a backup first if you are not sure.', {
          title,
          okLabel: 'Clear everything',
          danger: true,
        });
        if (!second) return;
        Budget.store.reset();
        undoToast('Everything cleared', Budget.store.topUndoToken());
      }),
    );
  }

  /** Settings dialog. opts.focus === 'goal' puts the cursor in the savings-goal field. */
  function openSettings(opts = {}) {
    const close = Budget.ui.dialog({
      title: 'Settings',
      body: el(
        'div',
        { class: 'x-settings' },
        goalSection(opts.focus === 'goal'),
        rulesSection(),
        hiddenWordsSection(),
        wipeSection(() => close()),
      ),
      actions: [{ label: 'Done', primary: true }],
    });
    return close;
  }

  Budget.uiExtras = {
    renderAll,
    decorateMonth,
    renderBanners,
    backupNow,
    restoreFromFile,
    print,
    openSettings,
    pure: {
      niceScale,
      monthSeries,
      barPath,
      chartLayout,
      chartSvg,
      backupFileName,
      needsBackupReminder,
      parseWordList,
      centsToInput,
      ruleSummary,
      ruleSetFrom,
      goalView,
      describeBackup,
      restoreMessage,
      hiddenWordsMessage,
    },
  };
})();
