/* Budget.ui: small shared DOM helpers — element builder, HTML escaping, modal dialogs, confirm and toasts. */
(function () {
  'use strict';

  const Budget = (globalThis.Budget = globalThis.Budget || {});

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const MAX_TOASTS = 4;
  const TOAST_MS = 4000;
  const TOAST_ACTION_MS = 8000;
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  // What a mouse press may give the focus to by itself (also from code only: tabindex -1, e.g. a dialog's home).
  const PRESS_FOCUS = `${FOCUSABLE}, [tabindex], label, summary, [contenteditable]:not([contenteditable="false"])`;

  const openDialogs = []; // [{box, close}], last one is on top
  let dialogSeq = 0;

  /** HTML-escape any value (null/undefined → ''). */
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
  }

  function appendChildren(node, children) {
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }

  /**
   * el('button', {class: 'btn', type: 'button', onclick: fn}, 'Label', childNode, [more]).
   * Attributes: null/false are skipped, true becomes an empty attribute, `on<event>` functions become listeners.
   * Children: Nodes are appended, everything else becomes a text node (so data never turns into markup).
   * `attrs` may be left out: el('p', 'tekst').
   */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
      children.unshift(attrs);
      attrs = {};
    }
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    appendChildren(node, children);
    return node;
  }

  /** The ✕ of a dialog's close button (an SVG, so it looks the same in every font). */
  function crossIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M4 4l8 8M12 4l-8 8');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    svg.append(path);
    return svg;
  }

  function buttonClass(action) {
    return ['btn', action.primary ? 'primary' : '', action.danger ? 'danger' : ''].filter(Boolean).join(' ');
  }

  function topDialog() {
    return openDialogs[openDialogs.length - 1] || null;
  }

  /**
   * While a dialog is open the page behind it stays put: <html> gets the class "dialog-open" (overflow hidden, screen
   * only, so printing is not affected), so no key, wheel or touch scrolls the page under the modal dialog, also not
   * when the dialog's own list has reached its end. A classic scrollbar keeps its room ("dialog-open-gutter":
   * scrollbar-gutter stable), so the page does not shift sideways when the dialog opens or closes.
   */
  function lockPage(on) {
    const html = document.documentElement;
    if (!on) {
      html.classList.remove('dialog-open', 'dialog-open-gutter');
      return;
    }
    if (html.classList.contains('dialog-open')) return;
    html.classList.toggle('dialog-open-gutter', window.innerWidth - html.clientWidth > 0);
    html.classList.add('dialog-open');
  }

  const LINE_PX = 40; // one arrow-key step, as the browsers scroll

  /**
   * How far a key scrolls a dialog's body (px; ±Infinity = to the top / the bottom), or null for a key that does not
   * scroll. Space only when the focus is not on a button (there it presses the button).
   */
  function scrollKeyStep(e, body, onButton) {
    if (e.altKey || e.ctrlKey || e.metaKey) return null;
    const page = Math.max(LINE_PX, Math.round(body.clientHeight * 0.875));
    switch (e.key) {
      case 'ArrowDown':
        return e.shiftKey ? null : LINE_PX;
      case 'ArrowUp':
        return e.shiftKey ? null : -LINE_PX;
      case 'PageDown':
        return page;
      case 'PageUp':
        return -page;
      case 'Home':
        return -Infinity;
      case 'End':
        return Infinity;
      case ' ':
        return onButton ? null : e.shiftKey ? -page : page;
      default:
        return null;
    }
  }

  /**
   * While a dialog is open the focus belongs inside the top one (aria-modal). When it got lost — on <body> after the
   * element that had it was removed (a re-render, a toast that went away, a closed dialog whose opener is gone) —
   * it goes to the top dialog's home: its body for a dialog without buttons (so the arrow keys and Page Down scroll
   * the content), else the box. A focused toast (above the backdrop) is left alone.
   * Returns true when it moved the focus.
   */
  function keepFocusInDialog() {
    const top = topDialog();
    if (!top) return false;
    const a = document.activeElement;
    const lost = !a || a === document.body || a === document.documentElement || !a.isConnected;
    if (!lost && (top.box.contains(a) || (a.closest && a.closest('#toast-root')))) return false;
    if (!top.home.hasAttribute('tabindex')) top.home.setAttribute('tabindex', '-1');
    top.home.focus({ preventScroll: true });
    return true;
  }

  // One capture-phase listener for all dialogs: Esc closes the top dialog, Tab stays inside it, the scroll keys scroll
  // its body (also when the focus is on its ✕ or buttons).
  // Capturing at the document means no other Esc handler (popover, menu) runs while a dialog is open.
  function onDialogKeydown(e) {
    const top = topDialog();
    if (!top) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      top.close();
    } else if (e.key === 'Tab') {
      const items = [...top.box.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = top.box.contains(active);
      // A holder that only takes the focus from code (the box, or the body of a dialog without buttons): Tab goes to
      // the next control after it, Shift+Tab to the one before it, wrapping round (so Shift+Tab from the box itself
      // goes to the last control).
      if (inside && !items.includes(active)) {
        e.preventDefault();
        const after = items.find((n) => active.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
        const before = items.filter((n) => active.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING).pop();
        (e.shiftKey ? before || last : after || first).focus();
        return;
      }
      if (e.shiftKey && (!inside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    } else {
      // The focus on a part of the top dialog outside its scrolling body (the box itself, the ✕, an action button such
      // as "Save" right after the dialog opened): the browser would scroll the page behind the dialog (locked, so
      // nothing would move). Page Down / Up, the arrow keys, Home / End (and Space on the box) scroll the dialog's
      // body instead, as they do when the focus is inside it (there the browser does it by itself).
      const active = document.activeElement;
      if (!active || !top.box.contains(active) || top.body.contains(active)) return;
      const step = scrollKeyStep(e, top.body, active !== top.box);
      if (step === null) return;
      e.preventDefault();
      if (step === -Infinity) top.body.scrollTop = 0;
      else if (step === Infinity) top.body.scrollTop = top.body.scrollHeight;
      else top.body.scrollBy(0, step);
    }
  }

  /**
   * Modal dialog: .dialog-backdrop > .dialog > h2 + .dialog-body + .dialog-actions.
   * body: a Node (or array of Nodes), or an HTML string — escape every piece of data in it with esc().
   * actions: [{label, primary, danger, autofocus, onClick}]; the dialog closes after onClick unless it returns false.
   * Focus goes to an [autofocus] element in the body, else the action marked autofocus, else the first button; a
   * dialog without buttons focuses its .dialog-body (tabindex -1), so the arrow keys and Page Down scroll its content.
   * A mouse press never takes the focus out of the dialog: the home (the box, or the body of a dialog without buttons)
   * and the body have tabindex -1 (a press on text in the body focuses the body, so the keyboard scrolls it), and a
   * press on the parts around that body (title, padding) keeps the focus where it is.
   * While a dialog is open the page behind it does not scroll (lockPage), and the scroll keys pressed on a part outside
   * the body (the box, the ✕, an action button) scroll the body.
   * Esc and a click on the backdrop close it. onClose (optional) runs once, however the dialog was closed; when the
   * focus has nowhere to go back to afterwards, it goes into the dialog that is now on top (keepFocusInDialog).
   * className (optional): extra class on .dialog (and `<className>-backdrop` on its backdrop).
   * closeButton: true adds a ✕ button ("Close") in the top right corner, right after the title.
   * Returns close().
   */
  function dialog({ title = '', body = null, actions = [], onClose = null, className = '', closeButton = false } = {}) {
    const root = document.getElementById('dialog-root');
    const titleId = `dialog-title-${++dialogSeq}`;
    const returnFocus = document.activeElement;

    const bodyEl = el('div', { class: 'dialog-body' });
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else appendChildren(bodyEl, [body]);

    const buttons = actions.map((action) => el('button', { type: 'button', class: buttonClass(action) }, action.label));
    const closeX = closeButton
      ? el('button', { type: 'button', class: 'dialog-x', 'aria-label': 'Close', title: 'Close' }, crossIcon())
      : null;
    const extra = /^[a-z][a-z0-9-]*$/i.test(className) ? className : '';
    const box = el(
      'div',
      { class: ['dialog', extra, closeX ? 'has-x' : ''].filter(Boolean).join(' '), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      el('h2', { id: titleId }, title),
      closeX,
      bodyEl,
      buttons.length ? el('div', { class: 'dialog-actions' }, buttons) : null,
    );
    const backdrop = el('div', { class: extra ? `dialog-backdrop ${extra}-backdrop` : 'dialog-backdrop' }, box);

    let closed = false;
    // home: where the focus goes when nothing else in the dialog has it (see keepFocusInDialog). It can take the focus
    // from the start, so a press on text inside it focuses the home (not <body>, which is behind the modal dialog).
    // The body (the scroll container) can take the focus from code in every dialog, so a press on text in it focuses
    // the body, also in a dialog with buttons (whose home is the box): Page Down and the arrow keys then scroll the
    // dialog's own list.
    const entry = { box, body: bodyEl, home: buttons.length ? box : bodyEl, close };
    bodyEl.setAttribute('tabindex', '-1');
    entry.home.setAttribute('tabindex', '-1');
    function close() {
      if (closed) return;
      closed = true;
      backdrop.remove();
      openDialogs.splice(openDialogs.indexOf(entry), 1);
      if (!openDialogs.length) {
        document.removeEventListener('keydown', onDialogKeydown, true);
        lockPage(false);
      }
      if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
      if (onClose) onClose();
      keepFocusInDialog();
    }

    if (closeX) closeX.addEventListener('click', () => close());
    buttons.forEach((btn, i) => {
      btn.addEventListener('click', (ev) => {
        const action = actions[i];
        let result;
        try {
          result = action.onClick ? action.onClick(ev) : undefined;
        } catch (err) {
          console.error(err);
          toast('Something went wrong. Please try again.');
          return;
        }
        if (result !== false) close();
      });
    });

    // Close on a click that both starts and ends on the backdrop (not when a text selection drags out of the box).
    // The 2nd click of a double-click is ignored: double-clicking whatever opened the dialog must not close it again.
    // A press on the backdrop never takes the focus out of the dialog (it would land on <body>: the backdrop cannot
    // be focused), also not the 2nd press of a double-click, which is ignored below.
    let downOnBackdrop = false;
    backdrop.addEventListener('pointerdown', (e) => {
      downOnBackdrop = e.target === backdrop;
    });
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) e.preventDefault();
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && downOnBackdrop && !(e.detail > 1)) close();
    });
    // A press on a part of the box that cannot take the focus, outside the home (the title or the padding of a dialog
    // without buttons, whose home is its body): the browser would put the focus on <body>, so Page Down and the arrow
    // keys would scroll the page behind the popup. The focus stays where it is instead (or goes to the home when it
    // was not in this dialog, e.g. on a toast).
    box.addEventListener('mousedown', (e) => {
      const hit = e.target instanceof Element ? e.target.closest(PRESS_FOCUS) : null;
      if (hit && box.contains(hit)) return;
      e.preventDefault();
      if (!box.contains(document.activeElement)) entry.home.focus({ preventScroll: true });
    });

    if (!openDialogs.length) document.addEventListener('keydown', onDialogKeydown, true);
    lockPage(true);
    openDialogs.push(entry);
    root.append(backdrop);

    const preferred = actions.findIndex((a) => a.autofocus);
    const target = bodyEl.querySelector('[autofocus]') || buttons[preferred] || buttons[0] || entry.home;
    target.focus();
    return close;
  }

  /** Yes/no question. Resolves true for OK, false for Cancel / Esc / backdrop. message is plain text. */
  function confirm(message, { okLabel = 'OK', danger = false, title = 'Are you sure?' } = {}) {
    return new Promise((resolve) => {
      let answer = false;
      dialog({
        title,
        body: el('p', {}, message),
        actions: [
          {
            label: okLabel,
            primary: !danger,
            danger,
            onClick: () => {
              answer = true;
            },
          },
          { label: 'Cancel', autofocus: danger },
        ],
        onClose: () => resolve(answer),
      });
    });
  }

  // ---- toast space: dialogs and the row popover keep clear of the toast stack (it never covers their buttons)

  let toastSpaceNow = 0;
  let toastObserver = null;

  /** Pixels at the bottom of the window taken by the toast stack (0 when there are no toasts). */
  function toastSpace() {
    return toastSpaceNow;
  }

  /**
   * Re-measures the toast stack. Sets --toast-space on <html> (dialogs pad their bottom by it) and fires
   * 'budget:toasts' on window when it changes, so the popover can move out of the way.
   */
  function updateToastSpace() {
    const root = document.getElementById('toast-root');
    if (!root) return;
    let space = 0;
    if (root.children.length) {
      const r = root.getBoundingClientRect();
      space = Math.max(0, Math.ceil(window.innerHeight - r.top)) + 8;
    }
    if (space === toastSpaceNow) return;
    toastSpaceNow = space;
    if (space) document.documentElement.style.setProperty('--toast-space', `${space}px`);
    else document.documentElement.style.removeProperty('--toast-space');
    window.dispatchEvent(new CustomEvent('budget:toasts', { detail: { space } }));
  }

  function watchToastRoot(root) {
    if (toastObserver || typeof ResizeObserver !== 'function') return;
    toastObserver = new ResizeObserver(() => updateToastSpace());
    toastObserver.observe(root);
    window.addEventListener('resize', updateToastSpace);
  }

  /**
   * Short message at the bottom of the window; toasts stack (newest at the bottom, at most 4).
   * action: {label, onClick} adds a button (e.g. 'Undo'). The timer pauses while hovered or focused.
   * onDismiss runs once when the toast goes away (timer, ×, action or pushed out of the stack).
   * Returns dismiss().
   */
  function toast(message, { action = null, ms, onDismiss = null } = {}) {
    const root = document.getElementById('toast-root');
    const node = el('div', { class: 'toast' }, el('span', { class: 'toast-msg' }, message));
    const duration = ms || (action ? TOAST_ACTION_MS : TOAST_MS);
    let timer = 0;
    let gone = false;
    const dismiss = () => {
      clearTimeout(timer);
      if (gone) return;
      gone = true;
      const hadFocus = node.contains(document.activeElement);
      node.remove();
      updateToastSpace();
      if (hadFocus) keepFocusInDialog(); // e.g. "Undo" or × clicked while a dialog is open
      if (onDismiss) onDismiss();
    };
    node.budgetDismiss = dismiss;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(dismiss, duration);
    };
    if (action) {
      node.append(
        el(
          'button',
          {
            type: 'button',
            class: 'toast-action',
            onclick: () => {
              dismiss();
              action.onClick();
            },
          },
          action.label,
        ),
      );
    }
    node.append(el('button', { type: 'button', class: 'toast-close', 'aria-label': 'Close', onclick: dismiss }, '×'));
    // While a dialog is open, a press on the toast's text keeps the focus where it is: the text cannot take it, so it
    // would land on <body>, behind the modal dialog (its buttons still take the focus as usual).
    node.addEventListener('mousedown', (e) => {
      if (topDialog() && !(e.target instanceof Element && e.target.closest('button'))) e.preventDefault();
    });
    node.addEventListener('pointerenter', () => clearTimeout(timer));
    node.addEventListener('pointerleave', arm);
    node.addEventListener('focusin', () => clearTimeout(timer));
    node.addEventListener('focusout', arm);
    root.append(node);
    while (root.children.length > MAX_TOASTS) {
      const oldest = root.firstElementChild;
      if (typeof oldest.budgetDismiss === 'function') oldest.budgetDismiss();
      else oldest.remove();
    }
    watchToastRoot(root);
    updateToastSpace();
    arm();
    return dismiss;
  }

  // ---- undo toasts: each one undoes exactly its own change

  const undoToasts = new Map(); // undo token -> dismiss()
  let watchingUndo = false;

  // After every store change: an undo toast whose change is no longer the newest undoable one (a newer change was
  // made, it was undone, or the undo list was cleared) can do nothing any more, so it goes away.
  function pruneUndoToasts() {
    const store = Budget.store;
    for (const [token, dismiss] of [...undoToasts]) {
      if (!store.canUndo(token)) dismiss();
    }
  }

  /**
   * Toast with "Undo" for the change that returned `token` from store.update (or store.topUndoToken()).
   * The button calls store.undo(token), so it never undoes a different, newer change. Without a token it is a plain
   * toast. onUndo(label) runs after a successful undo. Returns dismiss().
   */
  function undoToast(message, token, { onUndo = null, ms = TOAST_ACTION_MS } = {}) {
    const store = Budget.store;
    if (typeof token !== 'string' || !store || typeof store.canUndo !== 'function') return toast(message, { ms: TOAST_MS });
    if (!watchingUndo && typeof store.on === 'function') {
      watchingUndo = true;
      store.on('change', pruneUndoToasts);
    }
    pruneUndoToasts();
    const dismiss = toast(message, {
      ms,
      action: {
        label: 'Undo',
        onClick: () => {
          const label = store.undo(token);
          if (label === null) toast('This can no longer be undone.');
          else if (onUndo) onUndo(label);
        },
      },
      onDismiss: () => undoToasts.delete(token),
    });
    undoToasts.set(token, dismiss);
    return dismiss;
  }

  Budget.ui = { esc, el, dialog, confirm, toast, undoToast, toastSpace, updateToastSpace, keepFocusInDialog };
})();
