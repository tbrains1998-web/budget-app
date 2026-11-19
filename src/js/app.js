/* Budget.app: start-up (load, seed, recovery from corrupt data), routing between the month screen and
   "All months", the top bar, the ⋯ menu and reading bank files (button, file picker, drag & drop). */
(function () {
  'use strict';

  const Budget = (globalThis.Budget = globalThis.Budget || {});

  // [label, Budget.uiExtras function]
  const MENU_ITEMS = [
    ['Make backup', 'backupNow'],
    ['Restore backup', 'restoreFromFile'],
    ['Print', 'print'],
    ['Settings', 'openSettings'],
  ];
  const READ_ERROR = "I can't read this file. Is it an ING statement (PDF) or ING download (CSV)?";

  let started = false;
  let route = { view: 'month', month: null };
  let months = []; // months with data, oldest first
  let lastMonth = null; // last month shown; "Back to month" returns there
  let lastImportAt = null; // settings.lastImportAt at the previous change, to notice a new import
  let closeMenu = null; // set while the ⋯ menu is open

  const $ = (id) => document.getElementById(id);
  const extras = () => Budget.uiExtras || {};

  function monthsWithData() {
    return Budget.calc.monthsWithData(Budget.store.get()).slice().sort();
  }

  /**
   * No month → the newest month the bank booked (not a month that only holds a payment moved there).
   * A month without data → the closest earlier one, else the oldest. null when there is no data.
   */
  function nearestMonth(month) {
    if (!months.length) return null;
    if (!month) {
      const latest = Budget.calc.latestBookedMonth(Budget.store.get());
      return latest && months.includes(latest) ? latest : months[months.length - 1];
    }
    if (months.includes(month)) return month;
    const earlier = months.filter((m) => m < month);
    return earlier.length ? earlier[earlier.length - 1] : months[0];
  }

  // ---------------------------------------------------------------- routing

  /** route: {view: 'month', month} (month omitted = the last one shown) or {view: 'all'}. */
  function go(next) {
    if (closeMenu) closeMenu(false);
    const target = next && next.view === 'all' ? { view: 'all' } : { view: 'month', month: (next && next.month) || lastMonth };
    const moved = target.view !== route.view || target.month !== route.month;
    route = target;
    render();
    if (moved) window.scrollTo(0, 0);
  }

  function render() {
    if (route.view === 'all' && !(months.length && extras().renderAll)) route = { view: 'month', month: lastMonth };
    if (route.view === 'month') {
      route.month = nearestMonth(route.month);
      if (route.month) lastMonth = route.month;
    }
    const all = route.view === 'all';
    renderTopbar(all);
    $('view-month').hidden = all;
    $('all-months').hidden = !all;
    if (all) {
      Budget.uiMonth.closePopover(false);
      if (Budget.uiMonth.closeTilePopups) Budget.uiMonth.closeTilePopups();
      extras().renderAll();
    } else {
      Budget.uiMonth.render(route.month);
      if (route.month && extras().decorateMonth) extras().decorateMonth(route.month);
    }
    if (extras().renderBanners) extras().renderBanners();
  }

  function renderTopbar(all) {
    const index = months.indexOf(route.month);
    let label = 'Budget';
    if (all) label = 'All months';
    else if (route.month) label = Budget.util.monthLabel(route.month);
    $('month-label').textContent = label;
    $('prev-month').hidden = all || !route.month;
    $('next-month').hidden = all || !route.month;
    $('prev-month').disabled = index <= 0;
    $('next-month').disabled = index < 0 || index === months.length - 1;
    const btnAll = $('btn-all');
    btnAll.hidden = !months.length || !extras().renderAll;
    btnAll.textContent = all ? 'Back to month' : 'All months';
  }

  function step(delta) {
    const next = months[months.indexOf(route.month) + delta];
    if (next) go({ view: 'month', month: next });
  }

  // After an import, show the newest month it added (a booked one when there is one: not the month a payment was
  // only moved to); otherwise stay where the user is.
  function onStoreChange() {
    const before = months;
    months = monthsWithData();
    const state = Budget.store.get();
    const importAt = state.settings.lastImportAt;
    if (importAt !== lastImportAt) {
      lastImportAt = importAt;
      const added = months.filter((m) => !before.includes(m));
      const booked = added.filter((m) => Budget.calc.isBookedMonth(state, m));
      const pick = booked.length ? booked : added;
      if (pick.length) {
        go({ view: 'month', month: pick[pick.length - 1] });
        return;
      }
    }
    render();
  }

  // ---------------------------------------------------------------- menu

  function openMenu() {
    const { el } = Budget.ui;
    const button = $('btn-menu');
    const root = $('menu-root');
    const items = MENU_ITEMS.map(([label, fn]) =>
      el(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          class: 'menu-item',
          disabled: !extras()[fn],
          onclick: () => {
            closeMenu(false);
            extras()[fn]();
          },
        },
        label,
      ),
    );
    const enabled = items.filter((item) => !item.disabled);
    const menu = el('div', { class: 'menu', role: 'menu', 'aria-label': 'More' }, items);
    const onPointer = (e) => {
      if (!menu.contains(e.target) && !button.contains(e.target)) closeMenu(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu(true);
      } else if (e.key === 'Tab') {
        closeMenu(false);
      } else if (menu.contains(document.activeElement) && enabled.length) {
        const at = enabled.indexOf(document.activeElement);
        let next = -1;
        if (e.key === 'ArrowDown') next = (at + 1) % enabled.length;
        else if (e.key === 'ArrowUp') next = (at - 1 + enabled.length) % enabled.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = enabled.length - 1;
        if (next < 0) return;
        e.preventDefault();
        enabled[next].focus();
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    root.replaceChildren(menu);
    button.setAttribute('aria-expanded', 'true');
    closeMenu = (refocus) => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
      root.replaceChildren();
      button.setAttribute('aria-expanded', 'false');
      closeMenu = null;
      if (refocus) button.focus();
    };
    if (enabled.length) enabled[0].focus();
  }

  // ---------------------------------------------------------------- bank files

  function pickFiles() {
    $('file-input').click();
  }

  /** Hands files to the importer, which shows its own review dialog. */
  function importFiles(files) {
    if (!files || !files.length) return Promise.resolve();
    return Promise.resolve()
      .then(() => Budget.importer.readFiles(files))
      .catch((err) => {
        console.error(err);
        Budget.ui.toast(READ_ERROR);
      });
  }

  function wireFiles() {
    const input = $('file-input');
    input.addEventListener('change', () => {
      importFiles(input.files).finally(() => {
        input.value = ''; // so picking the same file again fires 'change'
      });
    });

    const overlay = $('drop-overlay');
    let depth = 0; // dragenter/dragleave pairs: the overlay hides when the drag leaves the window
    const hasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
    const hide = () => {
      depth = 0;
      overlay.hidden = true;
    };
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      overlay.hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // also stops the browser from opening a dropped file in place of the app
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth -= 1;
      if (depth <= 0) hide();
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      hide();
      importFiles(e.dataTransfer.files);
    });
    // No mouse events fire during a drag; one arriving while the overlay shows means a leave was missed.
    window.addEventListener('mousemove', () => {
      if (!overlay.hidden) hide();
    });
  }

  // ---------------------------------------------------------------- start

  function showRecovery(result) {
    const restore = extras().restoreFromFile;
    const kept = result.backupKey ? ' A copy of it was kept.' : '';
    const actions = [{ label: 'Start over', onClick: () => Budget.store.reset() }];
    if (restore) actions.unshift({ label: 'Restore backup', primary: true, onClick: () => restore() });
    Budget.ui.dialog({
      title: 'Saved data is damaged',
      body: Budget.ui.el(
        'p',
        {},
        `I can't read the data in this browser.${kept} Restore a backup, or start over with an empty budget.`,
      ),
      actions,
    });
  }

  /** Runs once, on DOMContentLoaded. */
  function start() {
    if (started) return;
    started = true;
    $('prev-month').addEventListener('click', () => step(-1));
    $('next-month').addEventListener('click', () => step(1));
    $('btn-all').addEventListener('click', () => go(route.view === 'all' ? { view: 'month', month: lastMonth } : { view: 'all' }));
    $('btn-import').addEventListener('click', pickFiles);
    $('btn-menu').addEventListener('click', () => (closeMenu ? closeMenu(false) : openMenu()));
    wireFiles();

    const result = Budget.store.load();
    if (!result.corrupt) Budget.store.loadSeedIfEmpty(window.BUDGET_SEED || null);
    months = monthsWithData();
    lastImportAt = Budget.store.get().settings.lastImportAt;
    Budget.store.on('change', onStoreChange);
    go({ view: 'month', month: null });
    if (result.corrupt) showRecovery(result);
  }

  Budget.app = { start, go, pickFiles };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
