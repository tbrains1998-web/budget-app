/* Budget.importPdf: ING "Afschrift Betaalrekening" PDF -> raw rows + statement.
   extract(arrayBuffer) reads the positioned text with pdf.js (DOM, browser only); parse(pages) is pure.

   Where pdf.js comes from: the built Budget.html holds vendor/pdf.min.mjs and
   vendor/pdf.worker.min.mjs verbatim as inert text in two script elements of type text/plain with the ids
   pdfjs-lib and pdfjs-worker. Both are imported from blob: URLs; importing the worker module sets globalThis.pdfjsWorker, so pdf.js runs
   its worker code on the main thread (CSP needs only `script-src blob:`). Without those elements (the dev page
   src/index.html) the same two files are imported from ../vendor/: that works over http and in Gecko from
   file://; Edge/Chrome refuse module imports from file://, so there extract() rejects with a plain message. */
(function () {
  'use strict';

  const Budget = (globalThis.Budget = globalThis.Budget || {});
  const { util } = Budget;

  const NOT_ING = "I can't read this file. Is it an ING statement (PDF) or ING download (CSV)?";
  const NO_PDFJS = "This version of the app can't read PDF files. Try an ING download (CSV).";
  const BOLD_FONT = /bold|black|heavy|semibold|demi/i;
  const FONT_WAIT_MS = 2000;

  const LINE_TOLERANCE = 2; // pt: items on the same baseline (±) form one line
  const COLUMN_TOLERANCE = 5; // pt: an item belongs to a column when it starts at most this far left of it
  const WORD_GAP = 1; // pt: a wider gap between two items means a space
  const MAX_LINE_GAP = 40; // pt: a bigger vertical gap ends a payment's detail lines
  const LABEL_REACH = 40; // pt: how far below its label a saldo value may be
  const PRIVATE_MIN_LENGTH = 4;
  // Column offsets from the date column (the usual ING layout) for headers whose items run together.
  const DEFAULT_OFFSETS = { name: 57, type: 319 };

  const DATE_RE = /^(\d{2})-(\d{2})-(\d{4})$/;
  const AMOUNT_TEXT = '[+\\-−–]?\\s?(?:\\d{1,3}(?:\\.\\d{3})+|\\d+),\\d{2}';
  const AMOUNT_RE = new RegExp(`^${AMOUNT_TEXT}$`);
  const TYPE_AND_AMOUNT_RE = new RegExp(`^(.*?)\\s*(${AMOUNT_TEXT})$`);
  const PERIOD_RE = /(\d{2}-\d{2}-\d{4})\s*t\/m\s*(\d{2}-\d{2}-\d{4})/i;
  const SALDO_LABELS = {
    startBalance: /^beginsaldo/i,
    totalIn: /^totaal\s+bij/i,
    endBalance: /^eindsaldo/i,
    totalOut: /^totaal\s+af/i,
  };
  const FOOTER_RE = /depositogarantiestelsel|statutair gevestigd|handelsregister|^pagina \d+ van \d+|^A-[A-Z0-9]+$/i;
  // Detail lines that never go into the description (ids, card data, dates). Labels that are also common
  // words only count with their colon.
  const SKIP_LINE_RE = /^(?:(?:BIC|Kenmerk|Machtiging\s+ID|Incassant\s+ID|Valutadatum|Datum\s*\/\s*Tijd|Pasvolgnr|Relatienummer|Doorlopende\s+incasso)\b|(?:Naam|Term|Transactie)\s*:)/i;
  const IBAN_LINE_RE = /^IBAN\b\s*:?\s*(.*)$/i;
  const OMSCHRIJVING_RE = /^Omschrijving\s*:\s*(.*)$/i;
  const HEADER_TEXT_RE = /^(?:periode|rekeningnummer|afschrift|beginsaldo|eindsaldo|totaal|iban|bic|datum|pagina)\b/i;

  function importError(message) {
    const err = new Error(message);
    err.name = 'ImportError';
    return err;
  }

  // ---- extraction (browser) ----------------------------------------------------------------------

  let pdfjsPromise = null;
  let queue = Promise.resolve();

  async function importEmbedded(id, devFile) {
    const node = document.getElementById(id);
    if (!node) return import(new URL(`../vendor/${devFile}`, document.baseURI).href);
    const url = URL.createObjectURL(new Blob([node.textContent], { type: 'text/javascript' }));
    try {
      return await import(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Loads pdf.js once. A failed load is not cached, so a later file can try again.
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = (async () => {
        try {
          const lib = await importEmbedded('pdfjs-lib', 'pdf.min.mjs');
          await importEmbedded('pdfjs-worker', 'pdf.worker.min.mjs');
          return lib;
        } catch (err) {
          pdfjsPromise = null;
          console.error('Budget: pdf.js could not load', err);
          throw importError(NO_PDFJS);
        }
      })();
    }
    return pdfjsPromise;
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  // The PostScript name of a font (e.g. 'AAAAAA+Arial-BoldMT'); '' when pdf.js does not deliver it in time.
  function fontName(page, loadedName) {
    return new Promise((resolve) => {
      const done = (font) => resolve((font && font.name) || '');
      if (page.commonObjs.has(loadedName)) {
        done(page.commonObjs.get(loadedName));
        return;
      }
      const timer = setTimeout(() => resolve(''), FONT_WAIT_MS);
      page.commonObjs.get(loadedName, (font) => {
        clearTimeout(timer);
        done(font);
      });
    });
  }

  async function readPage(page) {
    const [x0, y0, x1, y1] = page.view;
    const height = y1 - y0;
    const content = await page.getTextContent();
    await page.getOperatorList(); // makes pdf.js deliver the font objects (their names tell bold)
    const bold = {};
    for (const loadedName of Object.keys(content.styles)) bold[loadedName] = BOLD_FONT.test(await fontName(page, loadedName));
    const items = content.items
      .filter((item) => typeof item.str === 'string' && item.str.trim() !== '')
      .map((item) => ({
        str: item.str,
        x: round2(item.transform[4] - x0),
        y: round2(height - (item.transform[5] - y0)),
        w: round2(item.width),
        h: round2(item.height),
        fontName: item.fontName,
        bold: bold[item.fontName] === true,
      }));
    page.cleanup();
    return { width: round2(x1 - x0), height: round2(height), items };
  }

  async function extractNow(arrayBuffer) {
    const lib = await loadPdfjs();
    const task = lib.getDocument({
      data: new Uint8Array(arrayBuffer),
      useWasm: false,
      useSystemFonts: false,
      disableFontFace: true,
      fontExtraProperties: true,
      isImageDecoderSupported: false,
      enableXfa: false,
      verbosity: lib.VerbosityLevel.ERRORS,
    });
    try {
      const pdf = await task.promise;
      const pages = [];
      for (let n = 1; n <= pdf.numPages; n++) pages.push(await readPage(await pdf.getPage(n)));
      return pages;
    } finally {
      await task.destroy();
    }
  }

  /**
   * arrayBuffer -> Promise<pages>, pages = [{width, height, items: [{str, x, y, w, h, fontName, bold}]}]
   * (pt; x = left edge from the page's left side, y = baseline from the page's TOP). Files are read one at a time.
   */
  function extract(arrayBuffer) {
    const run = queue.then(() => extractNow(arrayBuffer));
    queue = run.catch(() => {});
    return run;
  }

  // ---- layout helpers ----------------------------------------------------------------------------

  // Items -> lines (same baseline ± LINE_TOLERANCE), top to bottom, each sorted left to right.
  function toLines(items) {
    const sorted = items.filter((i) => typeof i.str === 'string' && i.str.trim() !== '').sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const item of sorted) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(item.y - line.y) <= LINE_TOLERANCE) line.items.push(item);
      else lines.push({ y: item.y, items: [item] });
    }
    for (const line of lines) line.items.sort((a, b) => a.x - b.x);
    return lines;
  }

  function joinText(items) {
    let out = '';
    let end = null;
    for (const item of items) {
      if (end !== null && item.x - end > WORD_GAP) out += ' ';
      out += item.str;
      end = item.x + (item.w || 0);
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  // The table header line ("Geboekt op | Naam / Omschrijving / Mededeling | Type | Bedrag (EUR)") -> columns.
  function tableColumns(line) {
    const text = joinText(line.items);
    if (!/geboekt\s*op/i.test(text) || !/bedrag/i.test(text)) return null;
    const find = (re) => line.items.find((i) => re.test(i.str.trim()));
    const date = find(/^geboekt/i) || line.items[0];
    const at = (re, offset) => {
      const item = find(re);
      return item && item !== date ? item.x : date.x + offset;
    };
    return { name: at(/^naam/i, DEFAULT_OFFSETS.name), type: at(/^type\b/i, DEFAULT_OFFSETS.type) };
  }

  function dmyToIso(text) {
    const m = DATE_RE.exec(text);
    const date = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    return date && util.isValidDate(date) ? date : null;
  }

  function cents(text) {
    return util.parseEuro(text.replace(/[−–]/g, '-'));
  }

  // A line split into the table's columns: date | name | type + amount.
  function splitColumns(line, cols) {
    const date = [];
    const name = [];
    const rest = [];
    for (const item of line.items) {
      if (item.x < cols.name - COLUMN_TOLERANCE) date.push(item);
      else if (item.x < cols.type - COLUMN_TOLERANCE) name.push(item);
      else rest.push(item);
    }
    return { date, name, rest };
  }

  // The first line of a payment: a date in the date column and an amount at the end of the line.
  function rowStart(parts) {
    const date = dmyToIso(joinText(parts.date));
    const m = date && TYPE_AND_AMOUNT_RE.exec(joinText(parts.rest));
    if (!m) return null;
    const boldName = parts.name.length > 0 && parts.name.every((i) => i.bold) && !parts.date.every((i) => i.bold);
    return {
      date,
      nameParts: [joinText(parts.name)],
      type: m[1].trim(),
      amountText: m[2],
      nameOpen: boldName, // bold lines right below a bold name continue it
      lines: [],
      inOmschrijving: false,
      iban: '',
    };
  }

  // One detail line (name column; a wrapped type in the type column) of the current payment.
  function addDetail(tx, parts) {
    const text = joinText(parts.name);
    const typeText = joinText(parts.rest);
    if (typeText && !AMOUNT_RE.test(typeText)) tx.type = `${tx.type} ${typeText}`.trim();
    if (!text) return;
    if (tx.nameOpen && parts.name.every((i) => i.bold)) {
      tx.nameParts.push(text);
      return;
    }
    tx.nameOpen = false;
    const iban = IBAN_LINE_RE.exec(text);
    const omschrijving = OMSCHRIJVING_RE.exec(text);
    if (iban) {
      if (!tx.iban) tx.iban = iban[1].replace(/\s+/g, '').toUpperCase();
      tx.inOmschrijving = false;
    } else if (SKIP_LINE_RE.test(text)) {
      tx.inOmschrijving = false;
    } else if (omschrijving) {
      tx.lines.push(`Omschrijving: ${omschrijving[1]}`);
      tx.inOmschrijving = true;
    } else if (tx.inOmschrijving) {
      tx.lines[tx.lines.length - 1] += ` ${text}`; // Omschrijving wraps over several lines
    } else {
      tx.lines.push(text);
    }
  }

  function toRawRow(tx) {
    return {
      date: tx.date,
      rawName: tx.nameParts.join(' ').trim(),
      rawDescription: tx.lines.join('\n'),
      amount: cents(tx.amountText),
      type: tx.type,
      iban: tx.iban,
    };
  }

  // ---- statement header --------------------------------------------------------------------------

  function findPeriod(lines) {
    for (const line of lines) {
      const m = PERIOD_RE.exec(joinText(line.items));
      const from = m && dmyToIso(m[1]);
      const to = m && dmyToIso(m[2]);
      if (from && to) return { periodFrom: from, periodTo: to };
    }
    return null;
  }

  // The value of a saldo label: in the label item itself, below it (2x2 grid) or to its right.
  function labelValue(label, items) {
    const own = new RegExp(`(${AMOUNT_TEXT})$`).exec(label.str.trim());
    if (own) return cents(own[1]);
    const left = label.x - 20;
    const right = label.x + label.w + 20;
    let best = null;
    let bestScore = Infinity;
    for (const item of items) {
      const text = item.str.trim();
      if (item === label || !AMOUNT_RE.test(text)) continue;
      const dy = item.y - label.y;
      const below = dy > LINE_TOLERANCE && dy <= LABEL_REACH && item.x <= right && item.x + item.w >= left;
      const beside = Math.abs(dy) <= LINE_TOLERANCE && item.x > label.x + label.w;
      if (!below && !beside) continue;
      const score = below ? dy + Math.abs(item.x - label.x) / 100 : LABEL_REACH + item.x - label.x;
      if (score < bestScore) {
        best = item;
        bestScore = score;
      }
    }
    return best ? cents(best.str.trim()) : null;
  }

  // Fills the saldo values still missing in found from these items.
  function findSaldi(items, found) {
    for (const [key, re] of Object.entries(SALDO_LABELS)) {
      if (Number.isSafeInteger(found[key])) continue;
      const label = items.find((i) => re.test(i.str.trim()));
      const value = label ? labelValue(label, items) : null;
      if (value !== null) found[key] = value;
    }
  }

  // Text on the left of page 1 above the table (the holder's name and address): never imported, and
  // removed from names and descriptions by the importer.
  function privateTexts(items, page) {
    const left = items.filter((i) => !i.bold && i.x + i.w < page.width / 2);
    return toLines(left)
      .map((line) => joinText(line.items))
      .filter((t) => t.length >= PRIVATE_MIN_LENGTH && !HEADER_TEXT_RE.test(t) && !PERIOD_RE.test(t) && !AMOUNT_RE.test(t));
  }

  // ---- reconciliation ----------------------------------------------------------------------------

  function reconcile(rows, statement, warnings) {
    const fmt = util.formatEuro;
    let sumIn = 0;
    let sumOut = 0;
    for (const row of rows) {
      if (row.amount > 0) sumIn += row.amount;
      else sumOut -= row.amount;
    }
    if (!statement) {
      warnings.push("I couldn't find the totals of the statement, so I can't check that everything adds up.");
      return false;
    }
    const { startBalance, endBalance, totalIn, totalOut } = statement;
    let ok = true;
    if (sumIn !== totalIn) {
      ok = false;
      warnings.push(`Added up, ${fmt(sumIn)} came in, but the statement says ${fmt(totalIn)}.`);
    }
    if (sumOut !== totalOut) {
      ok = false;
      warnings.push(`Added up, ${fmt(sumOut)} went out, but the statement says ${fmt(totalOut)}.`);
    }
    if (startBalance + totalIn - totalOut !== endBalance) {
      ok = false;
      warnings.push('Start balance + in − out is not equal to the end balance on the statement.');
    }
    return ok;
  }

  // ---- public ------------------------------------------------------------------------------------

  /**
   * pages (from extract) -> {rows, statement, check, warnings, privateTexts}
   *  rows: [{date, rawName, rawDescription, amount (cents, + = in), type, iban}] in statement order (newest first).
   *    rawDescription: the Omschrijving (wrapped lines joined) and free text lines, '\n'-separated; never the
   *    Kenmerk/Machtiging/Incassant/Valutadatum/Datum-Tijd/Pasvolgnr/Transactie/Relatienummer lines.
   *  statement: {periodFrom, periodTo, startBalance, endBalance, totalIn, totalOut} (cents; totalOut positive,
   *    as printed) or null when the header could not be read.
   *  check: {kind: 'totals', ok}: rows add up to Totaal bij/af and begin + bij − af = eind.
   *  privateTexts: the holder block of page 1 (to strip from names/descriptions; never store it).
   * Throws an Error (name 'ImportError') with a plain message when this is not an ING statement.
   */
  function parse(pages) {
    const warnings = [];
    const rows = [];
    const saldi = {};
    let period = null;
    let hidden = [];
    let cols = null;
    let tx = null;
    let collecting = false; // detail lines go to tx; paused by footers and gaps, resumed below a page's table header
    let unsigned = 0;
    let foundTable = false;

    const finish = () => {
      if (!tx) return;
      if (!/^[+\-−–]/.test(tx.amountText)) unsigned++;
      rows.push(toRawRow(tx));
      tx = null;
    };

    (pages || []).forEach((page, pageIndex) => {
      const lines = toLines(page.items || []);
      const headerIndex = lines.findIndex((line) => tableColumns(line));
      const top = headerIndex >= 0 ? lines.slice(0, headerIndex) : lines;
      const topItems = top.flatMap((line) => line.items);
      if (!period) period = findPeriod(top);
      findSaldi(topItems, saldi);
      if (pageIndex === 0 && headerIndex >= 0) hidden = privateTexts(topItems, page);

      if (headerIndex >= 0) {
        cols = tableColumns(lines[headerIndex]);
        foundTable = true;
        collecting = true; // lines above the page's first date continue the previous page's last payment
      } else {
        finish(); // without a table header the page's top can't be told apart from a payment's details
      }
      if (!cols) return;

      let lastY = null;
      for (const line of headerIndex >= 0 ? lines.slice(headerIndex + 1) : lines) {
        const parts = splitColumns(line, cols);
        const start = rowStart(parts);
        const gap = lastY !== null && line.y - lastY > MAX_LINE_GAP;
        lastY = line.y;
        if (start) {
          finish();
          tx = start;
          collecting = true;
        } else if (gap || parts.date.length || FOOTER_RE.test(joinText(line.items))) {
          collecting = false;
        } else if (tx && collecting) {
          addDetail(tx, parts);
        }
      }
    });
    finish();

    const complete = period && Object.keys(SALDO_LABELS).every((key) => Number.isSafeInteger(saldi[key]));
    const statement = complete
      ? {
        ...period,
        startBalance: saldi.startBalance,
        endBalance: saldi.endBalance,
        totalIn: Math.abs(saldi.totalIn),
        totalOut: Math.abs(saldi.totalOut),
      }
      : null;
    if (!foundTable || (!rows.length && !statement)) throw importError(NOT_ING);

    if (unsigned === 1) warnings.push('1 amount had no + or −; I read it as money in.');
    else if (unsigned) warnings.push(`${unsigned} amounts had no + or −; I read them as money in.`);
    if (statement) {
      const outside = rows.filter((r) => r.date < statement.periodFrom || r.date > statement.periodTo).length;
      if (outside) warnings.push(`${outside} ${outside === 1 ? 'payment falls' : 'payments fall'} outside the period of the statement.`);
    }
    const ok = reconcile(rows, statement, warnings);
    return { rows, statement, check: { kind: 'totals', ok }, warnings, privateTexts: hidden };
  }

  Budget.importPdf = { extract, parse };
})();
