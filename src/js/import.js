/* Budget.importer: reads bank files (ING PDF statement or ING CSV download) into a preview: cleaned and
   categorized payments with fingerprints, duplicates skipped, statement totals checked.
   Shows the review dialog and adds the result in one undoable step ("Import").
   preview(files) does the same work without any UI (used by tests). */
(function () {
  'use strict';

  const Budget = (globalThis.Budget = globalThis.Budget || {});

  const READ_ERROR = "I can't read this file. Is it an ING statement (PDF) or ING download (CSV)?";
  const PASSWORD_ERROR = "This PDF file is protected with a password. I can't read it.";
  const TOO_BIG = 'This file is too big to be a bank file.';
  const MAX_BYTES = 20 * 1024 * 1024;
  const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
  const PDF_MAGIC_WITHIN = 1024;
  // pdf.js errors for files that simply aren't readable PDFs (no need to log them).
  const PDF_FILE_ERRORS = new Set(['InvalidPDFException', 'MissingPDFException', 'UnknownErrorException', 'FormatError']);
  const CHECK_OK = { pdf: '✓ Totals match the statement', csv: '✓ Balances match the bank' };
  const CHECK_BAD = { pdf: "Note: the totals don't match the statement.", csv: "Note: the balances in this file don't match." };
  const NO_CHECK = "This file has no balances, so it can't be checked.";
  // Text after the first "Omschrijving:" up to the next label or the end of the line (fingerprint input).
  const OMSCHRIJVING_RE = /(?:^|\s)Omschrijving:\s*(.*?)(?=\s+(?:Naam|Omschrijving|IBAN|BIC|Kenmerk|Machtiging ID|Incassant ID|Valutadatum|Datum\/Tijd|Pasvolgnr|Transactie|Term|Valuta|Koers|Opslag|Kosten|Overige partij):|\s+Doorlopende incasso\b|\s+Relatienummer\b|\n|$)/;

  function importError(message) {
    const err = new Error(message);
    err.name = 'ImportError';
    return err;
  }

  // ---- reading -----------------------------------------------------------------------------------

  async function readBytes(file) {
    if (typeof file.size === 'number' && file.size > MAX_BYTES) throw importError(TOO_BIG);
    return new Uint8Array(await file.arrayBuffer());
  }

  function isPdf(bytes) {
    const last = Math.min(bytes.length, PDF_MAGIC_WITHIN) - PDF_MAGIC.length;
    for (let i = 0; i <= last; i++) {
      if (PDF_MAGIC.every((b, j) => bytes[i + j] === b)) return true;
    }
    return false;
  }

  // UTF-8 (with or without BOM), else Windows-1252.
  function decodeText(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }

  function userMessage(err) {
    if (err && err.name === 'ImportError') return err.message;
    if (err && err.name === 'PasswordException') return PASSWORD_ERROR;
    if (!(err && PDF_FILE_ERRORS.has(err.name))) console.error('Budget: reading the file failed', err);
    return READ_ERROR;
  }

  // ---- statements --------------------------------------------------------------------------------

  // The statements this file adds: a PDF's when it covers one month and adds up; a CSV's per month when the
  // balance chain holds.
  function fileStatements(kind, parsed, warnings) {
    const { util } = Budget;
    if (kind === 'csv') return parsed.check && parsed.check.ok ? parsed.monthStatements.map((s) => ({ ...s, source: 'csv' })) : [];
    const s = parsed.statement;
    if (!s || s.startBalance + s.totalIn - s.totalOut !== s.endBalance) return [];
    const month = util.monthOf(s.periodFrom);
    if (util.monthOf(s.periodTo) !== month) {
      warnings.push("This statement covers more than one month, so its balances are not used for the month check.");
      return [];
    }
    return [{ month, ...s, source: 'pdf' }];
  }

  const STATEMENT_FIELDS = ['month', 'source', 'periodFrom', 'periodTo', 'startBalance', 'endBalance', 'totalIn', 'totalOut'];

  function sameStatement(a, b) {
    return STATEMENT_FIELDS.every((key) => a[key] === b[key]);
  }

  function covers(a, b) {
    return a.periodFrom <= b.periodFrom && a.periodTo >= b.periodTo;
  }

  // One statement per month and source. The new one replaces the old unless the old covers more; partly
  // overlapping periods are joined (begin of the earliest, end of the latest; totals then unknown).
  function mergeStatement(old, next) {
    if (!old.periodFrom || !old.periodTo || covers(next, old)) return next;
    if (covers(old, next)) return old;
    const first = old.periodFrom < next.periodFrom ? old : next;
    const last = old.periodTo > next.periodTo ? old : next;
    return {
      ...next,
      periodFrom: first.periodFrom,
      startBalance: first.startBalance,
      periodTo: last.periodTo,
      endBalance: last.endBalance,
      totalIn: null,
      totalOut: null,
    };
  }

  // ---- payments ----------------------------------------------------------------------------------

  function squash(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
  }

  // fp_ + hash of date|amount|payee|first Omschrijving|type from the raw row. The n-th
  // identical row of one file gets |n appended, so two equal payments on one day are both kept, while
  // reading the same file again gives the same fingerprints.
  async function fingerprints(rows) {
    const seen = new Map();
    const result = [];
    for (const raw of rows) {
      const m = OMSCHRIJVING_RE.exec(raw.rawDescription || '');
      const base = [raw.date, raw.amount, squash(raw.rawName), squash(m ? m[1] : ''), squash(raw.type)].join('|');
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      result.push(`fp_${await Budget.util.hash(n > 1 ? `${base}|${n}` : base)}`);
    }
    return result;
  }

  // Payee ids already in use, and for payments whose id was made from their display name (data from before
  // payeeId existed, hand-made payments) that name -> id, so such a payee stays one payee.
  function payeeIndex(state) {
    const { util } = Budget;
    const ids = new Set();
    const byName = new Map();
    for (const tx of state.transactions) {
      ids.add(tx.payeeId);
      const key = String(tx.name ?? '').trim().toLowerCase();
      if (tx.payeeId === util.payeeId(tx.name) && !byName.has(key)) byName.set(key, tx.payeeId);
    }
    return { ids, byName };
  }

  // payeeId from the RAW bank name; a payee never seen under that id but shown under the same name as a
  // name-made id keeps that id.
  function payeeIdFor(raw, displayName, index) {
    const id = Budget.util.payeeId(raw.rawName);
    if (index.ids.has(id)) return id;
    return index.byName.get(String(displayName).trim().toLowerCase()) || id;
  }

  function toTransaction(raw, source, fingerprint, state, privacy, index) {
    const { util, categorize } = Budget;
    let c = categorize.categorize(raw, state, { privacy });
    const payeeId = payeeIdFor(raw, c.name, index);
    // A payee kept under an older id: its payee rules (match.payeeId) name that id, so test them with it too.
    if (payeeId !== util.payeeId(raw.rawName)) c = categorize.categorize({ ...raw, payeeId }, state, { privacy });
    return {
      id: util.uid('t'),
      payeeId,
      date: raw.date,
      month: util.monthOf(raw.date),
      name: c.name,
      description: c.description,
      amount: raw.amount,
      categoryId: c.categoryId,
      kind: c.kind,
      type: raw.type,
      bankCode: util.bankCodeFromIban(raw.iban),
      source,
      fingerprint,
    };
  }

  async function parseFile(file) {
    const bytes = await readBytes(file);
    if (isPdf(bytes)) {
      const pages = await Budget.importPdf.extract(bytes.buffer);
      return { kind: 'pdf', parsed: Budget.importPdf.parse(pages) };
    }
    return { kind: 'csv', parsed: Budget.importCsv.parse(decodeText(bytes)) };
  }

  // Months of this import that were read before: a statement or bank payments (not hand-added) booked in them.
  function monthsReadBefore(state, months) {
    const before = new Set(state.statements.map((s) => s.month));
    for (const tx of state.transactions) if (tx.source !== 'hand') before.add(Budget.util.monthOf(tx.date));
    return months.filter((m) => before.has(m));
  }

  function sortedUnique(values) {
    return [...new Set(values)].sort();
  }

  // The salt for the holder hashes while the state has none yet: one per page session, so two previews made
  // before the first import is added agree.
  let sessionSalt = null;

  // The holder hashes this import uses: the state's plus those of the holder blocks of the PDFs being read. Each
  // PDF's block is read on its own (two statements can name different holders: a personal and a joint account,
  // or the old and the new address), and every block cleans every row of the batch (PDF and CSV).
  function privacyFor(state, entries) {
    const { util, categorize } = Budget;
    const stateSalt = state.settings.privacySalt;
    const salt = stateSalt || sessionSalt || (sessionSalt = util.randomHex(16));
    const have = new Set(stateSalt ? state.settings.privateTokenHashes : []);
    const tokens = entries.flatMap((e) => categorize.holderTokens((e.parsed && e.parsed.privateTexts) || []));
    const newHashes = categorize.hashTokens(tokens, salt).filter((h) => !have.has(h));
    return { salt, hashes: [...have, ...newHashes], newHashes };
  }

  /**
   * files (FileList or File[]) -> Promise<preview>, nothing is changed:
   * {files: [{name, kind, ok, error?, found, duplicates, months, check, warnings}], transactions (new),
   *  statements (new), found, duplicates, unknown, months, existingMonths, privacy: {salt, newHashes}}
   * The holder blocks of all PDFs in the batch (each read on its own) are used for every file (a CSV read together
   * with a PDF too).
   */
  async function preview(files) {
    const state = Budget.store.get();
    const unknownIds = new Set(state.categories.filter((c) => c.kind === 'unknown').map((c) => c.id));
    const known = new Set(state.transactions.map((t) => t.fingerprint).filter(Boolean));
    const result = { files: [], transactions: [], statements: [], found: 0, duplicates: 0, unknown: 0, months: [], existingMonths: [] };

    const entries = [];
    for (const file of Array.from(files || [])) {
      const name = String(file.name || '');
      try {
        entries.push({ name, ...(await parseFile(file)) });
      } catch (err) {
        entries.push({ name, error: userMessage(err) });
      }
    }
    const privacy = privacyFor(state, entries);
    result.privacy = { salt: privacy.salt, newHashes: privacy.newHashes };
    const index = payeeIndex(state);

    for (const entry of entries) {
      const { name, kind, parsed } = entry;
      if (entry.error !== undefined) {
        result.files.push({ name, ok: false, error: entry.error });
        continue;
      }
      const warnings = [...parsed.warnings];
      const prints = await fingerprints(parsed.rows);
      let duplicates = 0;
      parsed.rows.forEach((raw, i) => {
        if (known.has(prints[i])) {
          duplicates++;
          return;
        }
        known.add(prints[i]);
        const tx = toTransaction(raw, kind, prints[i], state, privacy, index);
        if (unknownIds.has(tx.categoryId)) result.unknown++;
        result.transactions.push(tx);
      });
      for (const s of fileStatements(kind, parsed, warnings)) {
        const pending = [...state.statements, ...result.statements];
        if (!pending.some((o) => sameStatement(o, s))) result.statements.push(s);
      }
      const months = sortedUnique(parsed.rows.map((r) => Budget.util.monthOf(r.date)));
      result.files.push({ name, kind, ok: true, found: parsed.rows.length, duplicates, months, check: parsed.check, warnings });
      result.found += parsed.rows.length;
      result.duplicates += duplicates;
      result.months = sortedUnique([...result.months, ...months]);
    }
    const touched = sortedUnique([...result.months, ...result.statements.map((s) => s.month)]);
    result.existingMonths = monthsReadBefore(state, touched);
    return result;
  }

  // Keeps the holder hashes of this import (never the text) and removes those parts from the payments read
  // before too (e.g. a CSV read before the first PDF). A preview made with another salt can't be merged: its
  // payments are already clean, only the hashes are not kept.
  function rememberPrivacy(draft, privacy) {
    if (!privacy || !privacy.newHashes || !privacy.newHashes.length) return;
    if (!draft.settings.privacySalt) {
      draft.settings.privacySalt = privacy.salt;
      draft.settings.privateTokenHashes = [];
    }
    if (draft.settings.privacySalt !== privacy.salt) return;
    draft.settings.privateTokenHashes = [...new Set([...draft.settings.privateTokenHashes, ...privacy.newHashes])];
    Budget.categorize.recleanState(draft);
  }

  /**
   * Adds the preview's new payments and statements in one undoable step ("Import"), sets lastImportAt, keeps
   * the holder hashes and opens the newest month. Payments that arrived in the meantime are skipped.
   * Returns {added, statements}.
   */
  function commit(p) {
    const { store } = Budget;
    const state = store.get();
    const present = new Set(state.transactions.map((t) => t.fingerprint).filter(Boolean));
    const transactions = p.transactions.filter((t) => !present.has(t.fingerprint));
    const statements = p.statements.filter((s) => !state.statements.some((o) => sameStatement(o, s)));
    if (!transactions.length && !statements.length) return { added: 0, statements: 0 };
    const now = new Date().toISOString();
    store.update(
      (draft) => {
        draft.transactions.push(...transactions.map((t) => ({ ...t })));
        for (const s of statements) {
          const next = { ...s, importedAt: now };
          const at = draft.statements.findIndex((o) => o.month === s.month && o.source === s.source);
          if (at < 0) draft.statements.push(next);
          else draft.statements[at] = mergeStatement(draft.statements[at], next);
        }
        draft.settings.lastImportAt = now;
        rememberPrivacy(draft, p.privacy);
      },
      { undoLabel: 'Import' },
    );
    const months = sortedUnique([...transactions.map((t) => t.month), ...statements.map((s) => s.month)]);
    if (Budget.app && months.length) Budget.app.go({ view: 'month', month: months[months.length - 1] });
    return { added: transactions.length, statements: statements.length };
  }

  // ---- review dialog -----------------------------------------------------------------------------

  function shortMonth(month) {
    const { util } = Budget;
    return `${util.shortMonthName(month)} ${month.slice(0, 4)}`;
  }

  // ['2026-09'] -> 'Sep 2026'; ['2026-09', '2026-10'] -> 'Sep – Oct 2026'; across years 'Dec 2026 – Jan 2027'.
  function monthsText(months) {
    if (!months.length) return '';
    const first = months[0];
    const last = months[months.length - 1];
    if (first === last) return shortMonth(first);
    const from = first.slice(0, 4) === last.slice(0, 4) ? shortMonth(first).slice(0, -5) : shortMonth(first);
    return `${from} – ${shortMonth(last)}`;
  }

  function paymentsText(n) {
    return `${n} ${n === 1 ? 'payment' : 'payments'}`;
  }

  // File names may hold an account number (ING CSV: <IBAN>_<from>_<to>.csv): never show it.
  function safeName(name) {
    return name.replace(/[A-Z]{2}\d{2}\s?[A-Z]{4}(?:\s?\d){6,}/gi, '…').replace(/\d{6,}/g, '…');
  }

  function listOf(items) {
    if (items.length < 2) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }

  function checkView(f, prefix) {
    const { el } = Budget.ui;
    const list = f.warnings.length ? el('ul', {}, f.warnings.map((w) => el('li', {}, w))) : null;
    if (f.check && f.check.ok) return [el('p', { class: 'check ok' }, prefix + CHECK_OK[f.kind]), list && el('div', { class: 'muted' }, list)];
    if (f.check) return el('div', { class: 'check bad' }, el('strong', {}, prefix + CHECK_BAD[f.kind]), list);
    return [el('p', { class: 'muted' }, prefix + NO_CHECK), list && el('div', { class: 'check bad' }, list)];
  }

  function reviewBody(p) {
    const { el } = Budget.ui;
    const { util } = Budget;
    const many = p.files.length > 1;
    const read = p.files.filter((f) => f.ok);
    const parts = [];
    if (read.length) {
      const months = p.months.length ? ` (${monthsText(p.months)})` : '';
      parts.push(el('p', {}, el('strong', {}, `${paymentsText(p.found)} found${months}`)));
    }
    for (const f of read) {
      const prefix = many ? `${safeName(f.name)}: ` : '';
      if (many) parts.push(el('p', { class: 'muted' }, `${prefix}${paymentsText(f.found)}${f.months.length ? ` (${monthsText(f.months)})` : ''}`));
      parts.push(checkView(f, prefix));
    }
    if (p.duplicates) parts.push(el('p', {}, `${p.duplicates} ${p.duplicates === 1 ? 'was' : 'were'} already read — skipped`));
    if (p.unknown) parts.push(el('p', {}, `${p.unknown} not sorted yet`));
    if (p.existingMonths.length) {
      const text = p.existingMonths.length === 1 && p.months.length <= 1
        ? 'You already read this month — duplicate payments are skipped'
        : `You already read ${listOf(p.existingMonths.map(util.monthLabel))} before — duplicate payments are skipped`;
      parts.push(el('p', { class: 'banner warn' }, text));
    }
    for (const f of p.files.filter((x) => !x.ok)) parts.push(el('p', { class: 'check bad' }, many ? `${safeName(f.name)}: ${f.error}` : f.error));
    if (read.length && !p.transactions.length && !p.statements.length) parts.push(el('p', {}, 'There is nothing new to add.'));
    return parts;
  }

  function showReview(p) {
    const { ui } = Budget;
    const hasNew = p.transactions.length > 0 || p.statements.length > 0;
    let title = 'Nothing new';
    if (hasNew) title = 'Read bank file';
    else if (!p.files.some((f) => f.ok)) title = 'File not read';
    const add = () => {
      const done = commit(p);
      if (done.added) ui.toast(`${paymentsText(done.added)} added.`);
      else ui.toast(done.statements ? 'Statement added.' : 'There was nothing new left to add.');
    };
    return ui.dialog({
      title,
      body: reviewBody(p),
      actions: hasNew
        ? [{ label: 'Add', primary: true, onClick: add }, { label: 'Cancel' }]
        : [{ label: 'Close', primary: true }],
    });
  }

  /** Reads the files and shows the review dialog ([Add] [Cancel]); resolves with the preview. */
  async function readFiles(files) {
    const p = await preview(files);
    if (p.files.length) showReview(p);
    return p;
  }

  Budget.importer = { readFiles, preview, commit };
})();
