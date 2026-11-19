// Unit tests for src/js/import-pdf.js (Budget.importPdf). parse() runs in a vm context (no DOM) on the text
// items that extract() produced from test/fixtures/ing-fake-1.pdf (ing-fake-1.items.json); the result must
// equal ing-fake-1.expected.json exactly. All data is fake.
//
// Browser check (opt-in, launches Edge headless and LibreWolf headless with temp profiles):
//   BUDGET_BROWSER=1 node --test test/unit/import-pdf.test.mjs        (BUDGET_GECKO=firefox for Firefox)
// It builds .tmp/pdf-dev/pdf-dev.html (pdf.js embedded as inert text like the build does, the app's CSP, the import
// modules inline), runs extract() + parse() on the PDF, compares the items with ing-fake-1.items.json, then runs
// the whole importer (review dialog, Add, re-import). BUDGET_UPDATE_ITEMS=1 rewrites the items file from
// Edge's output instead of comparing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

const ITEMS_PATH = 'test/fixtures/ing-fake-1.items.json';
const PDF_PATH = 'test/fixtures/ing-fake-1.pdf';
const EXPECTED = JSON.parse(read('test/fixtures/ing-fake-1.expected.json'));
const ITEMS = existsSync(new URL(ITEMS_PATH, root)) ? JSON.parse(read(ITEMS_PATH)) : null; // null until first written
const READ_ERROR = "I can't read this file. Is it an ING statement (PDF) or ING download (CSV)?";
const HOLDER_PDF = 'test/fixtures/ing-fake-holder.pdf'; // made by test/fixtures/make-holder-fixtures.mjs
const HOLDER_ITEMS = JSON.parse(read('test/fixtures/ing-fake-holder.items.json'));

function load() {
  const context = vm.createContext({ TextEncoder, TextDecoder, crypto: globalThis.crypto, console, setTimeout, clearTimeout });
  for (const f of ['util.js', 'store.js', 'import-pdf.js']) vm.runInContext(read(`src/js/${f}`), context, { filename: f });
  return context.Budget;
}

const { importPdf } = load();
const parse = (pages) => plain(importPdf.parse(pages));
const pick = (rows) => rows.map(({ date, rawName, amount, type }) => ({ date, rawName, amount, type }));
const copyPages = () => JSON.parse(JSON.stringify(ITEMS));
const rowItems = (pages, date) => {
  const dmy = date.split('-').reverse().join('-');
  for (const page of pages) {
    const start = page.items.find((i) => i.str === dmy);
    if (start) return { page, items: page.items.filter((i) => i.y >= start.y - 1) };
  }
  throw new Error(`no row ${date}`);
};

test('the items fixture is what extract() returns: pages of {str, x, y, w, h, fontName, bold}', () => {
  assert.equal(ITEMS.length, 2);
  for (const page of ITEMS) {
    assert.ok(page.width > 590 && page.height > 840, 'A4 in pt');
    for (const item of page.items) {
      assert.deepEqual(Object.keys(item).sort(), ['bold', 'fontName', 'h', 'str', 'w', 'x', 'y']);
      assert.ok(item.str.trim() !== '', 'whitespace-only items are dropped');
    }
  }
});

test('parse(): statement and rows equal ing-fake-1.expected.json exactly, totals check ok', () => {
  const result = parse(ITEMS);
  assert.deepEqual(result.statement, EXPECTED.statement);
  assert.deepEqual(pick(result.rows), EXPECTED.rows);
  assert.deepEqual(result.check, { kind: 'totals', ok: true });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(Object.keys(result.rows[0]).sort(), ['amount', 'date', 'iban', 'rawDescription', 'rawName', 'type']);
});

test('parse(): detail lines -> iban + description; ids, card data and dates are left out', () => {
  const rows = parse(ITEMS).rows;
  const byName = Object.fromEntries(rows.map((r) => [r.rawName, r]));
  assert.equal(byName['Huisbaas BV'].iban, 'NL00TEST0123456789');
  assert.equal(byName['Huisbaas BV'].rawDescription, 'Omschrijving: Huur oktober 2026 Teststraat 1');
  assert.equal(
    byName['Energiebedrijf Test BV'].rawDescription,
    'Omschrijving: Termijnbedrag energie september 2026 klantnummer 112233445 levering Teststraat 1 Voorbeeldstad stroom en gas',
    'a wrapped Omschrijving is joined into one line',
  );
  assert.equal(byName['Kosten ING Go'].rawDescription, '01-08-2026 - 31-08-2026\nING BANK N.V.', 'free text lines are kept');
  assert.equal(byName['Kosten ING Go'].iban, '');
  assert.equal(byName['SUPERMARKT 1234 TESTDORP'].rawDescription, '', 'card payment: only card data, nothing kept');
  assert.equal(byName['Zorgverzekeraar Test NV'].iban, 'NL00TEST0000000001');
  for (const row of rows) {
    assert.doesNotMatch(row.rawDescription, /Kenmerk|Machtiging|Incassant|Valutadatum|Datum\/Tijd|Pasvolgnr|Transactie|Term:|Relatienummer|Doorlopende|IBAN/i, row.rawName);
    assert.doesNotMatch(`${row.rawName} ${row.rawDescription}`, /T\. Tester|Pagina|depositogarantie|statutair|A-PAYPS01/, row.rawName);
  }
});

test('parse(): common words only count as a label with a colon ("Term 3 schoolgeld" is kept)', () => {
  const pages = copyPages();
  const omschrijving = pages[1].items.find((i) => i.str === 'Omschrijving: Terug van sparen');
  pages[1].items.push({ ...omschrijving, str: 'Term 3 schoolgeld', y: omschrijving.y + 5 });
  pages[1].items.push({ ...omschrijving, str: 'Naam: Test Ontvanger', y: omschrijving.y + 7.5 });
  const row = parse(pages).rows.find((r) => r.rawName.startsWith('Van Oranje'));
  assert.equal(row.rawDescription, 'Omschrijving: Terug van sparen Term 3 schoolgeld');
});

test('parse(): the holder block of page 1 is returned as privateTexts, never as a row', () => {
  const result = parse(ITEMS);
  assert.deepEqual(result.privateTexts, ['T. Tester', 'Teststraat 1', '1234 AB Voorbeeldstad']);
});

test('parse(): independent of item order, item splitting and small baseline jitter', () => {
  const pages = copyPages();
  for (const page of pages) {
    const split = [];
    for (const item of page.items) {
      const amount = /^([+-])(.+)$/.exec(item.str);
      if (amount && item.x > 500) {
        // "+1.312,40" as two items "+" and "1.312,40"
        split.push({ ...item, str: amount[1], w: 4 }, { ...item, str: amount[2], x: item.x + 4, w: item.w - 4 });
      } else if (item.bold && item.str.includes(' ') && item.x > 100 && item.x < 110) {
        // a payee name as one item per word
        let x = item.x;
        for (const word of item.str.split(' ')) {
          const w = (item.w * word.length) / item.str.length;
          split.push({ ...item, str: word, x, w });
          x += w + 2;
        }
      } else {
        split.push({ ...item, y: item.y + (item.x % 2 > 1 ? 0.8 : -0.8) });
      }
    }
    page.items = split.reverse();
  }
  const result = parse(pages);
  assert.deepEqual(result.statement, EXPECTED.statement);
  assert.deepEqual(pick(result.rows), EXPECTED.rows);
  assert.equal(result.check.ok, true);
});

test('parse(): a payment whose details continue on the next page stays one payment', () => {
  const pages = copyPages();
  // Move the last two detail lines of page 1's last payment (22-09) to page 2, right under its table header.
  const last = pages[0].items.filter((i) => i.str === 'Datum/Tijd: 22-09-2026 19:03:11' || i.str === 'Valutadatum: 22-09-2026');
  pages[0].items = pages[0].items.filter((i) => !last.includes(i));
  const header = pages[1].items.find((i) => i.str === 'Geboekt op');
  last.forEach((item, n) => pages[1].items.push({ ...item, y: header.y + 6 + n * 4 }));
  pages[1].items.push({ ...last[0], str: 'Omschrijving: tweede deel', y: header.y + 14 });
  const result = parse(pages);
  assert.equal(result.rows.length, 14);
  assert.equal(result.rows.find((r) => r.rawName === 'J. Jansen').rawDescription, 'Omschrijving: Terug voor de pizza\nOmschrijving: tweede deel');
  assert.equal(result.check.ok, true);
});

test('parse(): a missing payment or a wrong total is reported, never silently accepted', () => {
  const pages = copyPages();
  const { page, items } = rowItems(pages, '2026-09-28');
  const drop = new Set(items.filter((i) => i.y < items[0].y + 1));
  page.items = page.items.filter((i) => !drop.has(i)); // the -2,95 payment's first line is gone
  const result = parse(pages);
  assert.equal(result.rows.length, 13);
  assert.equal(result.check.ok, false);
  assert.ok(result.warnings.some((w) => w.includes('went out') && w.includes('€1,630.42') && w.includes('€1,633.37')), result.warnings.join(' | '));

  const wrongTotal = copyPages();
  wrongTotal[0].items.find((i) => i.str === '1.655,40').str = '1.655,41';
  const bad = parse(wrongTotal);
  assert.equal(bad.check.ok, false);
  assert.ok(bad.warnings.some((w) => w.includes('came in')));
  assert.ok(bad.warnings.some((w) => w.includes('Start balance + in − out')));
});

test('parse(): without the saldo grid there is no statement and a warning', () => {
  const pages = copyPages();
  pages[0].items = pages[0].items.filter((i) => !/saldo|totaal/i.test(i.str));
  const result = parse(pages);
  assert.equal(result.statement, null);
  assert.equal(result.check.ok, false);
  assert.equal(result.rows.length, 14);
  assert.ok(result.warnings[0].startsWith("I couldn't find the totals of the statement"));
});

test('parse(): unknown types are kept, unsigned amounts are read as + with a warning', () => {
  const pages = copyPages();
  pages[1].items.find((i) => i.str === 'iDEAL').str = 'Wero betaling';
  pages[1].items.find((i) => i.str === '+200,00').str = '200,00';
  const result = parse(pages);
  assert.equal(result.rows.find((r) => r.rawName === 'Webwinkel Test').type, 'Wero betaling');
  assert.equal(result.rows.find((r) => r.rawName.startsWith('Van Oranje')).amount, 20000);
  assert.ok(result.warnings.includes('1 amount had no + or −; I read it as money in.'), result.warnings.join(' | '));
  assert.equal(result.check.ok, true);
  // Two unsigned amounts: plural.
  pages[0].items.find((i) => i.str === '+1.312,40').str = '1.312,40';
  assert.ok(parse(pages).warnings.includes('2 amounts had no + or −; I read them as money in.'));
});

test('parse(): the holder fixture (ing-fake-holder) reads exactly and returns its holder block', () => {
  const holder = JSON.parse(read('test/fixtures/ing-fake-holder.expected.json'));
  const result = parse(JSON.parse(read('test/fixtures/ing-fake-holder.items.json')));
  assert.deepEqual(result.statement, holder.statement);
  assert.deepEqual(pick(result.rows), holder.rows);
  assert.deepEqual(result.check, { kind: 'totals', ok: true });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.privateTexts, holder.holder);
  assert.equal(result.rows.find((r) => r.rawName === 'Belastingdienst').rawDescription, 'Omschrijving: Kinderopvangtoeslag maart 2027 (TESTER )');
});

test('parse(): a wrapped type and a bold name over two lines are joined', () => {
  const pages = copyPages();
  const start = pages[1].items.find((i) => i.str === 'Telecom Test BV');
  const type = pages[1].items.find((i) => i.str === 'Incasso' && i.y === start.y);
  type.str = 'Periodieke';
  pages[1].items.push({ ...type, str: 'overschrijving', y: start.y + 9.75 });
  pages[1].items.push({ ...start, str: 'Afdeling Test', y: start.y + 4 });
  for (const i of pages[1].items) if (i.y > start.y + 1 && i.y < start.y + 12 && i.str.startsWith('Omschrijving')) i.y = start.y + 14;
  const row = parse(pages).rows.find((r) => r.rawName.startsWith('Telecom'));
  assert.equal(row.rawName, 'Telecom Test BV Afdeling Test');
  assert.equal(row.type, 'Periodieke overschrijving');
});

test('parse(): not an ING statement -> ImportError with the friendly message', () => {
  const cases = [
    [],
    [{ width: 595, height: 842, items: [] }],
    [{ width: 595, height: 842, items: [{ str: 'Factuur 2026-001', x: 50, y: 60, w: 80, h: 10, fontName: 'f1', bold: false }] }],
  ];
  for (const pages of cases) {
    assert.throws(() => importPdf.parse(pages), (err) => err.name === 'ImportError' && err.message === READ_ERROR);
  }
});

// ---- browser check (opt-in) ------------------------------------------------------------------------------

const BROWSER = process.env.BUDGET_BROWSER === '1';
const UPDATE_ITEMS = process.env.BUDGET_UPDATE_ITEMS === '1';
const GECKO = process.env.BUDGET_GECKO || 'librewolf';
const DEV_PAGE = '.tmp/pdf-dev/pdf-dev.html';
const CSP = "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src blob: data:";
const PAGE_SCRIPTS = ['util.js', 'store.js', 'categorize.js', 'import-csv.js', 'import-pdf.js', 'ui-kit.js', 'import.js'];

function embeddable(name, text) {
  assert.doesNotMatch(text, /<\/script|<!--|<script/i, `${name} cannot be embedded raw`);
  return text;
}

// The dev page: everything inline, like dist/Budget.html will be, opened from file://.
function buildDevPage() {
  const scripts = PAGE_SCRIPTS.map((f) => `<script>\n${embeddable(f, read(`src/js/${f}`))}\n</script>`).join('\n');
  const html = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>import dev</title>
<script>window.__violations = []; document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.violatedDirective));</script>
</head>
<body>
<input type="file" id="file" multiple>
<div id="dialog-root"></div>
<div id="toast-root"></div>
<script type="text/plain" id="pdfjs-lib">${embeddable('pdf.min.mjs', read('vendor/pdf.min.mjs'))}</script>
<script type="text/plain" id="pdfjs-worker">${embeddable('pdf.worker.min.mjs', read('vendor/pdf.worker.min.mjs'))}</script>
${scripts}
<script>Budget.store.load();</script>
</body>
</html>
`;
  mkdirSync(new URL('.tmp/pdf-dev/', root), { recursive: true });
  writeFileSync(new URL(DEV_PAGE, root), html);
}

async function extractInPage(browser, path = PDF_PATH) {
  await browser.setFiles('#file', [path]);
  return browser.eval(async () => {
    const started = performance.now();
    const file = document.getElementById('file').files[0];
    const pages = await Budget.importPdf.extract(await file.arrayBuffer());
    return { pages, parsed: Budget.importPdf.parse(pages), ms: Math.round(performance.now() - started) };
  });
}

// Reads the files through Budget.importer.readFiles, captures the dialog, optionally clicks a button.
async function importInPage(browser, paths, button) {
  await browser.setFiles('#file', paths);
  return browser.eval(async (label) => {
    const p = await Budget.importer.readFiles([...document.getElementById('file').files]);
    const dialog = document.querySelector('#dialog-root .dialog');
    const text = dialog ? dialog.innerText : '';
    const buttons = dialog ? [...dialog.querySelectorAll('.dialog-actions button')].map((b) => b.textContent) : [];
    const target = dialog && [...dialog.querySelectorAll('.dialog-actions button')].find((b) => b.textContent === label);
    if (target) target.click();
    const state = Budget.store.get();
    return {
      text,
      buttons,
      fingerprints: p.transactions.map((t) => t.fingerprint),
      dialogOpen: Boolean(document.querySelector('#dialog-root .dialog')),
      toast: document.getElementById('toast-root').innerText,
      transactions: state.transactions.length,
      statements: state.statements.map((s) => `${s.month}:${s.source}`).sort(),
      lastImportAt: state.settings.lastImportAt,
      violations: window.__violations,
    };
  }, button);
}

async function browserRun(launch, label) {
  const { fileUrl } = await import('../lib/cdp.mjs');
  const browser = await launch();
  try {
    await browser.open(fileUrl(DEV_PAGE));
    const { pages, parsed, ms } = await extractInPage(browser);
    assert.deepEqual(parsed.statement, EXPECTED.statement, `${label}: statement`);
    assert.deepEqual(pick(parsed.rows), EXPECTED.rows, `${label}: rows`);
    assert.equal(parsed.check.ok, true);
    // pdf.js numbers the documents of a page (g_d0_, g_d1_ … in font ids); this is the page's second PDF.
    const sameDoc = (pages) => JSON.parse(JSON.stringify(pages).replace(/"g_d\d+_/g, '"g_d0_'));
    const holder = await extractInPage(browser, HOLDER_PDF);
    assert.deepEqual(sameDoc(holder.pages), HOLDER_ITEMS, `${label}: extract() of ${HOLDER_PDF} differs from its items fixture`);
    assert.deepEqual(plain(holder.parsed.privateTexts), ['T. Tester', 'Teststraat 1', '1234 AB Voorbeeldstad']);

    const first = await importInPage(browser, [PDF_PATH, 'test/fixtures/ing-fake-comma.csv', 'test/fixtures/ing-fake-semicolon.csv'], 'Add');
    assert.match(first.text, /38 payments found \(Sep – Oct 2026\)/);
    assert.match(first.text, /✓ Totals match the statement/);
    assert.match(first.text, /✓ Balances match the bank/);
    assert.match(first.text, /has no balances, so it can't be checked/);
    assert.match(first.text, /12 were already read — skipped/);
    assert.match(first.text, /\d+ not sorted yet/);
    assert.deepEqual(first.buttons, ['Add', 'Cancel']);
    assert.equal(first.dialogOpen, false, 'Add closes the dialog');
    assert.equal(first.transactions, 26);
    assert.deepEqual(first.statements, ['2026-09:pdf', '2026-10:csv']);
    assert.ok(first.lastImportAt);
    assert.match(first.toast, /26 payments added/);

    const again = await importInPage(browser, [PDF_PATH], 'Close');
    assert.match(again.text, /14 payments found \(Sep 2026\)/);
    assert.match(again.text, /14 were already read — skipped/);
    assert.match(again.text, /You already read this month — duplicate payments are skipped/);
    assert.match(again.text, /There is nothing new to add/);
    assert.deepEqual(again.buttons, ['Close']);
    assert.equal(again.transactions, 26, 're-import adds nothing');

    const broken = await importInPage(browser, ['vendor/LICENSE'], 'Close');
    assert.match(broken.text, /I can't read this file\. Is it an ING statement \(PDF\) or ING download \(CSV\)\?/);
    assert.equal(broken.transactions, 26);

    assert.deepEqual(again.violations, [], `${label}: CSP violations`);
    assert.deepEqual(browser.errors(), [], `${label}: console errors`);
    assert.deepEqual(browser.externalRequests(), [], `${label}: network`);
    return { ms, pages, fingerprints: first.fingerprints };
  } finally {
    await browser.close();
  }
}

test(`browser: extract() + importer in Edge and ${GECKO} (file://, the app's CSP)`, { skip: !BROWSER && 'set BUDGET_BROWSER=1' }, async () => {
  const { launchEdge } = await import('../lib/cdp.mjs');
  const { launchGecko } = await import('../lib/bidi.mjs');
  buildDevPage();
  const edge = await browserRun(() => launchEdge({ width: 1100 }), 'edge');
  if (UPDATE_ITEMS) writeFileSync(new URL(ITEMS_PATH, root), `${JSON.stringify(edge.pages, null, 1)}\n`);
  else assert.deepEqual(edge.pages, ITEMS, `edge: extract() items differ from ${ITEMS_PATH}`);
  const gecko = await browserRun(() => launchGecko({ browser: GECKO, width: 1100 }), GECKO);
  assert.deepEqual(gecko.pages, edge.pages, `${GECKO}: extract() items differ from edge`);
  assert.deepEqual(gecko.fingerprints, edge.fingerprints, 'same fingerprints in both browsers');
  console.log(`extract+parse: edge ${edge.ms} ms, ${GECKO} ${gecko.ms} ms`);
});
