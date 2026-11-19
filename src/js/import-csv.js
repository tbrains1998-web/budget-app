/* Budget.importCsv: ING CSV download ("Af- en bijschrijvingen") -> raw rows.
   Both separators (',' and ';'), quoted fields (RFC 4180), Dutch and English headers mapped by name,
   Af/Bij sign, yyyymmdd dates, decimal comma. The caller decodes the bytes (UTF-8 or Windows-1252).
   With "Saldo na mutatie" the balance chain is checked and per-month balances are derived.
   Pure: no DOM, no storage. */
(function () {
  'use strict';

  const Budget = (globalThis.Budget = globalThis.Budget || {});
  const { util } = Budget;

  const NOT_ING = "I can't read this file. Is it an ING statement (PDF) or ING download (CSV)?";
  const SAVINGS = 'This looks like a download of a savings account. Only read your current account '
    + '(ING: download "Af- en bijschrijvingen", CSV).';
  const NO_ROWS = 'There are no payments in this file.';
  const MAX_BREAKS_SHOWN = 3;

  // Column -> header names (lowercase, single spaces, ' / ' around slashes), Dutch then English.
  const COLUMNS = {
    date: ['datum', 'date'],
    name: ['naam / omschrijving', 'name / description'],
    counterparty: ['tegenrekening', 'counterparty'],
    code: ['code'],
    direction: ['af bij', 'debit / credit'],
    amount: ['bedrag (eur)', 'amount (eur)'],
    type: ['mutatiesoort', 'transaction type'],
    notes: ['mededelingen', 'notifications'],
    balance: ['saldo na mutatie', 'resulting balance'],
  };
  const REQUIRED = ['date', 'name', 'direction', 'amount'];
  const SEPARATORS = [';', ',', '\t'];

  // ING transaction codes -> the Dutch type text (used for English files and when Mutatiesoort is empty).
  const CODE_TYPES = {
    AC: 'Acceptgiro',
    BA: 'Betaalautomaat',
    DV: 'Diversen',
    FL: 'Filiaalboeking',
    GF: 'Telefonisch bankieren',
    GM: 'Geldautomaat',
    GT: 'Online bankieren',
    IC: 'Incasso',
    ID: 'iDEAL',
    IW: 'iDEAL | Wero',
    OV: 'Overschrijving',
    PK: 'Opname kantoor',
    PO: 'Periodieke overschrijving',
    ST: 'Storting',
    VZ: 'Verzamelbetaling',
    WERO: 'Wero',
  };

  // English Mededelingen labels -> Dutch, so later cleaning and fingerprints treat both languages alike.
  const ENGLISH_LABELS = {
    'name': 'Naam',
    'description': 'Omschrijving',
    'reference': 'Kenmerk',
    'mandate id': 'Machtiging ID',
    'creditor id': 'Incassant ID',
    'value date': 'Valutadatum',
    'card sequence no.': 'Pasvolgnr',
    'date/time': 'Datum/Tijd',
    'transaction': 'Transactie',
    'currency': 'Valuta',
    'rate': 'Koers',
    'mark-up': 'Opslag',
    'fee': 'Kosten',
    'other party': 'Overige partij',
  };
  const ENGLISH_LABEL_RE = /\b(Name|Description|Reference|Mandate ID|Creditor ID|Value date|Card sequence no\.|Date\/time|Transaction|Currency|Rate|Mark-up|Fee|Other party):/gi;

  function importError(message) {
    const err = new Error(message);
    err.name = 'ImportError';
    return err;
  }

  // ---- RFC 4180 ----------------------------------------------------------------------------------

  // text -> records (arrays of fields). Quoted fields may hold separators, newlines and "" for a quote.
  // Accepts CRLF, LF and CR line endings and a missing final newline.
  function parseRecords(text, sep) {
    const records = [];
    let record = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c !== '"') field += c;
        else if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else if (c === '"') {
        quoted = true;
      } else if (c === sep) {
        record.push(field);
        field = '';
      } else if (c === '\r' || c === '\n') {
        record.push(field);
        records.push(record);
        record = [];
        field = '';
        if (c === '\r' && text[i + 1] === '\n') i++;
      } else {
        field += c;
      }
    }
    if (quoted) throw importError(NOT_ING);
    if (field !== '' || record.length) {
      record.push(field);
      records.push(record);
    }
    return records;
  }

  // ---- header ------------------------------------------------------------------------------------

  function headerKey(cell) {
    return cell.replace(/^﻿/, '').trim().toLowerCase().replace(/\s*\/\s*/g, ' / ').replace(/\s+/g, ' ');
  }

  // header cells -> {columns: {name: index}, english} or null when it isn't an ING payment-account header.
  function mapHeader(cells) {
    const keys = cells.map(headerKey);
    const columns = {};
    let english = false;
    for (const [column, names] of Object.entries(COLUMNS)) {
      const index = keys.findIndex((k) => names.includes(k));
      if (index < 0) continue;
      columns[column] = index;
      if (keys[index] === names[names.length - 1] && names.length > 1) english = true;
    }
    return REQUIRED.every((c) => c in columns) ? { columns, english } : null;
  }

  function looksLikeSavings(cells) {
    const keys = cells.map(headerKey);
    return keys.includes('rekening naam') || (keys.includes('omschrijving') && keys.includes('bedrag'));
  }

  function firstLine(text) {
    const end = text.search(/\r|\n/);
    return end < 0 ? text : text.slice(0, end);
  }

  // Finds the separator whose first line is an ING header.
  function detectFormat(text) {
    const line = firstLine(text);
    for (const sep of SEPARATORS) {
      const cells = parseRecords(line, sep)[0] || [];
      const header = mapHeader(cells);
      if (header) return { sep, ...header };
      if (looksLikeSavings(cells)) throw importError(SAVINGS);
    }
    throw importError(NOT_ING);
  }

  // ---- fields ------------------------------------------------------------------------------------

  // yyyymmdd, dd-mm-yyyy or yyyy-mm-dd -> 'YYYY-MM-DD', or null.
  function parseDate(cell) {
    const s = cell.trim();
    let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s) || /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    let date = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
    if (!date) {
      m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
      date = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    }
    return date && util.isValidDate(date) ? date : null;
  }

  function parseDirection(cell) {
    const s = cell.trim().toLowerCase();
    if (s === 'af' || s === 'debit') return -1;
    if (s === 'bij' || s === 'credit') return 1;
    return 0;
  }

  // ING amounts are positive with a decimal comma ("1810,52"; hand-made files: "1.024,45").
  function parseAmount(cell) {
    const cents = util.parseEuro(cell);
    return cents === null ? null : Math.abs(cents);
  }

  function dutchLabels(text) {
    return text
      .replace(ENGLISH_LABEL_RE, (all, label) => `${ENGLISH_LABELS[label.toLowerCase()]}:`)
      .replace(/\bRecurrent SEPA direct debit\b/gi, 'Doorlopende incasso');
  }

  function cell(record, columns, column) {
    const index = columns[column];
    return index === undefined ? '' : String(record[index] ?? '');
  }

  // One record -> raw row (+ balance), or null when date, direction or amount can't be read.
  function toRow(record, { columns, english }) {
    const date = parseDate(cell(record, columns, 'date'));
    const sign = parseDirection(cell(record, columns, 'direction'));
    const amount = parseAmount(cell(record, columns, 'amount'));
    if (!date || !sign || amount === null) return null;
    const code = cell(record, columns, 'code').trim().toUpperCase();
    const typeText = cell(record, columns, 'type').trim();
    const notes = cell(record, columns, 'notes').trim();
    const balanceText = cell(record, columns, 'balance').trim();
    return {
      row: {
        date,
        rawName: cell(record, columns, 'name').trim(),
        rawDescription: english ? dutchLabels(notes) : notes,
        amount: sign * amount,
        type: (english && CODE_TYPES[code]) || typeText || CODE_TYPES[code] || code,
        iban: cell(record, columns, 'counterparty').replace(/\s+/g, '').toUpperCase(),
      },
      balance: balanceText ? util.parseEuro(balanceText) : null,
    };
  }

  // ---- balances ----------------------------------------------------------------------------------

  function longDate(date) {
    return `${util.shortDate(date)} ${date.slice(0, 4)}`;
  }

  function totals(entries) {
    let totalIn = 0;
    let totalOut = 0;
    for (const { row } of entries) {
      if (row.amount > 0) totalIn += row.amount;
      else totalOut -= row.amount;
    }
    return { totalIn, totalOut };
  }

  // entries newest first. Balance before the oldest entry and after the newest one, plus the totals.
  function summary(entries) {
    const newest = entries[0];
    const oldest = entries[entries.length - 1];
    return {
      periodFrom: oldest.row.date,
      periodTo: newest.row.date,
      startBalance: oldest.balance - oldest.row.amount,
      endBalance: newest.balance,
      ...totals(entries),
    };
  }

  // entries newest first: saldo[older] + amount[newer] must equal saldo[newer]. Returns the newer dates
  // where the chain breaks.
  function chainBreaks(entries) {
    const breaks = [];
    for (let i = 0; i + 1 < entries.length; i++) {
      if (entries[i + 1].balance + entries[i].row.amount !== entries[i].balance) breaks.push(entries[i].row.date);
    }
    return breaks;
  }

  function breakWarning(breaks) {
    const shown = breaks.slice(0, MAX_BREAKS_SHOWN).map(longDate).join(', ');
    const more = breaks.length > MAX_BREAKS_SHOWN ? ` and ${breaks.length - MAX_BREAKS_SHOWN} more times` : '';
    return `The balances in this file don't add up (at ${shown}${more}). Maybe a payment is missing.`;
  }

  function monthStatements(entries) {
    const byMonth = new Map();
    for (const entry of entries) {
      const month = util.monthOf(entry.row.date);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(entry);
    }
    return [...byMonth].map(([month, list]) => ({ month, ...summary(list) })).sort((a, b) => a.month.localeCompare(b.month));
  }

  // ---- public ------------------------------------------------------------------------------------

  /**
   * text -> {rows, statement, monthStatements, check, warnings, english}
   *  rows: [{date, rawName, rawDescription, amount (cents, + = in), type, iban}], newest first.
   *  statement: whole file {periodFrom, periodTo, startBalance, endBalance, totalIn, totalOut} (cents, totalOut
   *    positive) when every row has "Saldo na mutatie", else null. monthStatements: the same per month.
   *  check: {kind: 'saldo', ok} when balances exist, else null. warnings: plain sentences.
   * Throws an Error (name 'ImportError') with a plain message when the text isn't an ING CSV.
   */
  function parse(text) {
    const source = String(text ?? '').replace(/^﻿/, '');
    const format = detectFormat(source);
    const records = parseRecords(source, format.sep).slice(1);
    const warnings = [];
    const entries = [];
    let bad = 0;
    records.forEach((record, i) => {
      if (record.every((c) => c.trim() === '')) return;
      const entry = toRow(record, format);
      if (entry) {
        entries.push(entry);
      } else {
        bad++;
        warnings.push(`I couldn't read row ${i + 2}, so it was skipped.`);
      }
    });
    if (!entries.length) throw importError(bad ? NOT_ING : NO_ROWS);
    if (bad > entries.length) throw importError(NOT_ING);

    // ING lists the newest first; a file sorted the other way is turned around.
    if (entries[0].row.date < entries[entries.length - 1].row.date) entries.reverse();

    let statement = null;
    let months = [];
    let check = null;
    if ('balance' in format.columns && entries.every((e) => Number.isSafeInteger(e.balance))) {
      const breaks = chainBreaks(entries);
      check = { kind: 'saldo', ok: breaks.length === 0 && bad === 0 };
      if (breaks.length) warnings.push(breakWarning(breaks));
      statement = summary(entries);
      months = monthStatements(entries);
    } else if ('balance' in format.columns) {
      warnings.push("Not every payment has a balance, so I can't check the balances.");
    }
    return { rows: entries.map((e) => e.row), statement, monthStatements: months, check, warnings, english: format.english };
  }

  Budget.importCsv = { parse };
})();
