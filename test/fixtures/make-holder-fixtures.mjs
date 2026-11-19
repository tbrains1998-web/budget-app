// Generates the FAKE fixtures for the account-holder privacy checks. Every name, address,
// IBAN and amount is invented test data. The holder is the same fake person as in the other fixtures:
// "T. Tester, Teststraat 1, 1234 AB Voorbeeldstad". Payee names and descriptions repeat that holder in the forms
// seen on real statements: "<Firstname> <Surname>" (own account at another bank), "T TESTER", "HR T TESTER",
// "Tester T.", "(TESTER )", the town alone, "Teststraat 1A" / "Teststraat 1 A", "1234AB Voorbeeldstad".
//   ing-fake-holder.pdf          (+ src/ing-fake-holder.html, ing-fake-holder.expected.json) 2 pages, March 2027
//   ing-fake-holder.items.json   what Budget.importPdf.extract() returns for that PDF in Edge (pdf.js text items)
//   ing-fake-holder.csv          Dutch header, ';', 11 columns with saldo, April 2027; same holder forms
// The PDF is printed like make-fixtures.mjs does (HTML replica of the ING statement layout -> Edge headless
// --print-to-pdf) and read back with the app's own import-pdf.js + pdf.js in a fresh Edge profile under .tmp/fixtures/.
//   node test/fixtures/make-holder-fixtures.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_ROOT, EDGE_EXE, fileUrl, launchEdge } from '../lib/cdp.mjs';

const FIXTURES = dirname(fileURLToPath(import.meta.url));
const SRC = join(FIXTURES, 'src');
const TMP = join(APP_ROOT, '.tmp', 'fixtures');
const OWN_IBAN = 'NL00INGB0000000000';
export const HOLDER = ['T. Tester', 'Teststraat 1', '1234 AB Voorbeeldstad'];
const START_BALANCE = 250000;

function euro(cents, { signed = false, grouped = true } = {}) {
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100));
  const text = `${grouped ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.') : whole},${String(abs % 100).padStart(2, '0')}`;
  if (signed) return (cents < 0 ? '-' : '+') + text;
  return cents < 0 ? `-${text}` : text;
}
const iso = (dmy) => dmy.split('-').reverse().join('-');
const ymd = (dmy) => dmy.split('-').reverse().join('');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---- the March 2027 statement, newest first ------------------------------------------------------------

const MAR_ROWS = [
  { date: '31-03-2027', name: 'Tom Tester', type: 'Online bankieren', amount: -50000,
    details: ['Omschrijving: Naar mijn rekening bij andere bank', 'IBAN: NL00RABO0000000077', 'Valutadatum: 31-03-2027'] },
  { date: '30-03-2027', name: 'Belastingdienst', type: 'Verzamelbetaling', amount: 9700,
    details: ['Omschrijving: Kinderopvangtoeslag maart 2027 (TESTER )', 'IBAN: NL00TEST0000000005', 'Kenmerk: 0000000000000002',
      'Valutadatum: 30-03-2027'] },
  { date: '28-03-2027', name: 'T TESTER', type: 'Overschrijving', amount: 25000,
    details: ['Omschrijving: Van eigen spaarpot', 'IBAN: NL00ABNA0000000088', 'Valutadatum: 28-03-2027'] },
  { date: '27-03-2027', name: 'HR T TESTER', type: 'Online bankieren', amount: -10000,
    details: ['Omschrijving: Sparen bij andere bank', 'IBAN: NL00ABNA0000000088', 'Valutadatum: 27-03-2027'] },
  { date: '25-03-2027', name: 'Werkgever Voorbeeld BV', type: 'Overschrijving', amount: 214560,
    details: ['Omschrijving: Salaris maart 2027 T. Tester', 'IBAN: NL00TEST0000000002', 'Kenmerk: SAL-2027-03',
      'Valutadatum: 25-03-2027'] },
  { date: '22-03-2027', name: 'Energiebedrijf Test BV', type: 'Incasso', amount: -9700,
    details: ['Omschrijving: Termijnbedrag maart 2027 levering Voorbeeldstad', 'IBAN: NL00TEST0000000006',
      'Kenmerk: 0000112233448', 'Machtiging ID: ENE-000456', 'Incassant ID: NL00ZZZ111111111111', 'Doorlopende incasso',
      'Valutadatum: 22-03-2027'] },
  { date: '20-03-2027', name: 'Zorgverzekeraar Test NV', type: 'Incasso', amount: -13485,
    details: ['Omschrijving: Premie maart 2027 Tester T.', 'IBAN: NL00TEST0000000001', 'Kenmerk: 2027030000001',
      'Valutadatum: 20-03-2027'] },
  // page 2
  { date: '18-03-2027', name: 'Webwinkel Test', type: 'iDEAL', amount: -4995,
    details: ['Omschrijving: Bestelling bezorgen 1234AB Voorbeeldstad', 'IBAN: NL00TEST0000000004',
      'Kenmerk: 18-03-2027 20:11 0050001112223399', 'Valutadatum: 18-03-2027'] },
  { date: '15-03-2027', name: 'Gemeente Voorbeeldstad', type: 'Incasso', amount: -3150,
    details: ['Omschrijving: Afvalstoffenheffing 2027 Teststraat 1 A', 'IBAN: NL00TEST0000000019', 'Kenmerk: AFV-2027-01',
      'Valutadatum: 15-03-2027'] },
  { date: '12-03-2027', name: 'ApotheekDeLinde NLD', type: 'Betaalautomaat', amount: -1245,
    details: ['Pasvolgnr: 003 12-03-2027 10:12', 'Transactie: A00093 Term: XX000000', 'Valutadatum: 12-03-2027'] },
  { date: '10-03-2027', name: 'Webwinkel Test', type: 'Online bankieren', amount: -2500,
    details: ['Omschrijving: XQZ743QK0RLRHFYX0', 'IBAN: NL00TEST0000000004', 'Valutadatum: 10-03-2027'] },
  { date: '02-03-2027', name: 'Huisbaas BV', type: 'Overschrijving', amount: -105000,
    details: ['Omschrijving: Huur maart 2027 Teststraat 1A', 'IBAN: NL00TEST0123456789', 'Kenmerk: HUUR-2027-03',
      'Valutadatum: 02-03-2027'] },
];
const MAR_PAGES = [7, 5];

// What the app must store for each row (name, description), in the same order. The holder never survives.
export const MAR_CLEAN = [
  ['Online bankieren', 'Naar mijn rekening bij andere bank'],
  ['Belastingdienst', 'Kinderopvangtoeslag maart 2027'],
  ['Overschrijving', 'Van eigen spaarpot'],
  ['Online bankieren', 'Sparen bij andere bank'],
  ['Werkgever Voorbeeld BV', 'Salaris maart 2027'],
  ['Energiebedrijf Test BV', 'Termijnbedrag maart 2027 levering'],
  ['Zorgverzekeraar Test NV', 'Premie maart 2027'],
  ['Webwinkel Test', 'Bestelling bezorgen'],
  ['Gemeente', 'Afvalstoffenheffing 2027'],
  ['ApotheekDeLinde NLD', ''],
  ['Webwinkel Test', '…'],
  ['Huisbaas BV', 'Huur maart 2027'],
];

// ---- the April 2027 CSV, oldest first (written newest first) -------------------------------------------

const APR_ROWS = [
  { date: '02-04-2027', name: 'Huisbaas BV', iban: 'NL00TEST0123456789', code: 'OV', type: 'Overschrijving', amount: -105000,
    msg: 'Naam: Huisbaas BV Omschrijving: Huur april 2027 Teststraat 1 IBAN: NL00TEST0123456789 Kenmerk: HUUR-2027-04 Valutadatum: 02-04-2027' },
  { date: '05-04-2027', name: 'Gemeente Voorbeeldstad', iban: 'NL00TEST0000000019', code: 'IC', type: 'Incasso', amount: -3150,
    msg: 'Naam: Gemeente Voorbeeldstad Omschrijving: Afvalstoffenheffing 2027 IBAN: NL00TEST0000000019 Kenmerk: AFV-2027-02 Valutadatum: 05-04-2027' },
  { date: '10-04-2027', name: 'HR T TESTER', iban: 'NL00ABNA0000000088', code: 'OV', type: 'Overschrijving', amount: 10000,
    msg: 'Naam: HR T TESTER Omschrijving: Terug van andere bank IBAN: NL00ABNA0000000088 Valutadatum: 10-04-2027' },
  { date: '20-04-2027', name: 'Energiebedrijf Test BV', iban: 'NL00TEST0000000006', code: 'IC', type: 'Incasso', amount: -9700,
    msg: 'Naam: Energiebedrijf Test BV Omschrijving: Termijnbedrag april 2027 levering Teststraat 1A 1234AB Voorbeeldstad IBAN: NL00TEST0000000006 Kenmerk: 0000112233449 Machtiging ID: ENE-000456 Incassant ID: NL00ZZZ111111111111 Doorlopende incasso Valutadatum: 20-04-2027' },
  { date: '22-04-2027', name: 'Belastingdienst', iban: 'NL00TEST0000000005', code: 'GT', type: 'Verzamelbetaling', amount: 9700,
    msg: 'Naam: Belastingdienst Omschrijving: Kinderopvangtoeslag april 2027 (TESTER ) IBAN: NL00TEST0000000005 Kenmerk: 0000000000000003 Valutadatum: 22-04-2027' },
  { date: '25-04-2027', name: 'Werkgever Voorbeeld BV', iban: 'NL00TEST0000000002', code: 'OV', type: 'Overschrijving', amount: 214560,
    msg: 'Naam: Werkgever Voorbeeld BV Omschrijving: Salaris april 2027 Tester T. IBAN: NL00TEST0000000002 Kenmerk: SAL-2027-04 Valutadatum: 25-04-2027' },
  { date: '28-04-2027', name: 'Tom Tester', iban: 'NL00RABO0000000077', code: 'GT', type: 'Online bankieren', amount: -50000,
    msg: 'Naam: Tom Tester Omschrijving: Naar eigen rekening IBAN: NL00RABO0000000077 Valutadatum: 28-04-2027' },
];
// After a PDF with this holder block was read (newest first, like the file).
export const APR_CLEAN = [
  ['Online bankieren', 'Naar eigen rekening'],
  ['Werkgever Voorbeeld BV', 'Salaris april 2027'],
  ['Belastingdienst', 'Kinderopvangtoeslag april 2027'],
  ['Energiebedrijf Test BV', 'Termijnbedrag april 2027 levering'],
  ['Overschrijving', 'Terug van andere bank'],
  ['Gemeente', 'Afvalstoffenheffing 2027'],
  ['Huisbaas BV', 'Huur april 2027'],
];
const NL_HEADER = ['Datum', 'Naam / Omschrijving', 'Rekening', 'Tegenrekening', 'Code', 'Af Bij', 'Bedrag (EUR)',
  'Mutatiesoort', 'Mededelingen', 'Saldo na mutatie', 'Tag'];

// ---- HTML replica (same layout and CSS as make-fixtures.mjs) -------------------------------------------

const STATEMENT_CSS = `
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 8pt; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
p { margin: 0; }
.page { position: relative; width: 210mm; height: 297mm; overflow: hidden; break-after: page; }
.page:last-child { break-after: auto; }
.title { position: absolute; left: 50pt; top: 42pt; font-size: 12pt; font-weight: bold; }
.holder { position: absolute; left: 50pt; top: 100pt; line-height: 11pt; font-size: 9pt; }
.meta { position: absolute; left: 330pt; top: 100pt; display: grid; grid-template-columns: 80pt 150pt; row-gap: 4pt; font-size: 8pt; }
.meta .label, .saldo .label { color: #555; }
.saldo { position: absolute; left: 330pt; top: 150pt; display: grid; grid-template-columns: 115pt 115pt; row-gap: 8pt; }
.saldo .value { font-size: 10pt; font-weight: bold; }
.meta.small { top: 40pt; }
.table { position: absolute; left: 50pt; width: 510pt; }
.first .table { top: 235pt; }
.next .table { top: 90pt; }
.thead, .tx { display: grid; grid-template-columns: 57pt 262pt 101pt 90pt; }
.thead { font-weight: bold; padding-bottom: 3pt; border-bottom: 0.75pt solid #000; }
.tx { padding: 4pt 0 5pt; border-bottom: 0.4pt solid #b0b0b0; line-height: 10pt; }
.tx .name { display: flex; flex-direction: column; padding-right: 8pt; }
.tx .name b { font-weight: bold; }
.r, .amount { text-align: right; }
.footer { position: absolute; left: 50pt; right: 35pt; bottom: 28pt; font-size: 6.5pt; line-height: 9pt; color: #333; }
.footer .pagenr { position: absolute; right: 0; bottom: 9pt; }
.footer .code { position: absolute; right: 0; bottom: 0; }`;

function statementHtml({ rows, rowsPerPage, periodFrom, periodTo, startBalance }) {
  const totalIn = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  const totalOut = rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0);
  const endBalance = startBalance + totalIn - totalOut;
  const account = 'NL00 INGB 0000 0000 00';
  const meta = (cls, pairs) => `<div class="meta${cls}">${pairs.map(([l, v]) => `<span class="label">${l}</span><span>${v}</span>`).join('')}</div>`;
  const tableHead = '<div class="thead"><span>Geboekt op</span><span>Naam / Omschrijving / Mededeling</span><span>Type</span><span class="r">Bedrag (EUR)</span></div>';
  const txRow = (r) => `<div class="tx"><span class="date">${r.date}</span><div class="name"><b>${esc(r.name)}</b>${r.details.map((d) => `<span>${esc(d)}</span>`).join('')}</div>`
    + `<span class="type">${esc(r.type)}</span><span class="amount">${euro(r.amount, { signed: true })}</span></div>`;
  const footer = (n) => '<div class="footer"><p>Dit product valt onder het depositogarantiestelsel. Meer informatie vindt u in het informatieblad depositogarantiestelsel.</p>'
    + '<p>ING Bank N.V., statutair gevestigd te Amsterdam, Handelsregister nr. 00000000. TESTBESTAND MET NEPGEGEVENS.</p>'
    + `<p class="pagenr">Pagina ${n} van ${rowsPerPage.length}</p><p class="code">A-PAYPS01</p></div>`;
  let from = 0;
  const pages = rowsPerPage.map((count, i) => {
    const pageRows = rows.slice(from, from + count);
    from += count;
    const head = i === 0
      ? `<p class="title">Afschrift Betaalrekening</p><div class="holder">${HOLDER.map((l) => `<p>${esc(l)}</p>`).join('')}</div>`
        + meta('', [['Periode', `${periodFrom} t/m ${periodTo}`], ['Rekeningnummer', account]])
        + '<div class="saldo"><span class="label">Beginsaldo (EUR)</span><span class="label">Totaal bij (EUR)</span>'
        + `<span class="value">${euro(startBalance)}</span><span class="value">${euro(totalIn)}</span>`
        + '<span class="label">Eindsaldo (EUR)</span><span class="label">Totaal af (EUR)</span>'
        + `<span class="value">${euro(endBalance)}</span><span class="value">${euro(totalOut)}</span></div>`
      : meta(' small', [['Rekeningnummer', account], ['Periode', `${periodFrom} t/m ${periodTo}`]]);
    return `<section class="page ${i === 0 ? 'first' : 'next'}">\n${head}\n<div class="table">${tableHead}\n${pageRows.map(txRow).join('\n')}\n</div>\n${footer(i + 1)}\n</section>`;
  });
  assert.equal(from, rows.length, 'rowsPerPage must cover every row');
  const html = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<title>Afschrift Betaalrekening (NEP)</title>
<!-- FAKE test fixture: replica of the ING "Afschrift Betaalrekening" layout whose payments repeat the
     fake holder's name and address. Generated by test/fixtures/make-holder-fixtures.mjs. -->
<style>${STATEMENT_CSS}
</style>
</head>
<body>
${pages.join('\n')}
</body>
</html>
`;
  const expected = {
    statement: { periodFrom: iso(periodFrom), periodTo: iso(periodTo), startBalance, endBalance, totalIn, totalOut },
    rows: rows.map((r) => ({ date: iso(r.date), rawName: r.name, amount: r.amount, type: r.type })),
  };
  return { html, expected };
}

const quote = (v) => `"${String(v).replace(/"/g, '""')}"`;

function csv(rows, startBalance) {
  let balance = startBalance;
  const lines = rows.map((r) => {
    balance += r.amount;
    return [ymd(r.date), r.name, OWN_IBAN, r.iban, r.code, r.amount < 0 ? 'Af' : 'Bij', euro(Math.abs(r.amount), { grouped: false }),
      r.type, r.msg, euro(balance, { grouped: false }), ''].map(quote).join(';');
  }).reverse();
  return [NL_HEADER.map(quote).join(';'), ...lines].join('\n');
}

// ---- printing and reading back -------------------------------------------------------------------------

function run(exe, args) {
  return new Promise((ok, fail) => {
    const p = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${exe} exited with ${code}`))));
    p.on('error', fail);
  });
}

async function printPdf(htmlPath, pdfPath) {
  const profile = join(TMP, 'edge-print-holder');
  await rm(profile, { recursive: true, force: true });
  await mkdir(profile, { recursive: true });
  try {
    await run(EDGE_EXE, ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions',
      '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href]);
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

// A page with pdf.js embedded as inert text (like the build does) and the app's own util/store/import-pdf.
async function devPage() {
  const read = (p) => readFile(join(APP_ROOT, p), 'utf8');
  const scripts = await Promise.all(['src/js/util.js', 'src/js/store.js', 'src/js/import-pdf.js'].map(read));
  const html = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>fixture extract</title></head><body>
<input type="file" id="file">
<script type="text/plain" id="pdfjs-lib">${await read('vendor/pdf.min.mjs')}</script>
<script type="text/plain" id="pdfjs-worker">${await read('vendor/pdf.worker.min.mjs')}</script>
${scripts.map((s) => `<script>\n${s}\n</script>`).join('\n')}
</body></html>`;
  const path = join(TMP, 'holder-extract.html');
  await writeFile(path, html, 'utf8');
  return path;
}

async function checkLayout(edge, htmlPath) {
  await edge.open(pathToFileURL(htmlPath).href);
  await edge.printMedia(true);
  const problems = await edge.eval(() => {
    const out = [];
    document.querySelectorAll('.page').forEach((page, i) => {
      const footerTop = page.querySelector('.footer').getBoundingClientRect().top;
      const rows = page.querySelectorAll('.tx');
      const last = rows[rows.length - 1].getBoundingClientRect();
      if (last.bottom > footerTop - 6) out.push(`page ${i + 1}: rows reach the footer`);
      page.querySelectorAll('.date, .type, .amount, .name b, .name span').forEach((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        if (range.getClientRects().length > 1) out.push(`page ${i + 1}: "${el.textContent}" wraps`);
      });
    });
    return out;
  });
  await edge.printMedia(false);
  assert.deepEqual(problems, [], htmlPath);
}

// ---- main ----------------------------------------------------------------------------------------------

await mkdir(SRC, { recursive: true });
await mkdir(TMP, { recursive: true });
const mar = statementHtml({ rows: MAR_ROWS, rowsPerPage: MAR_PAGES, periodFrom: '01-03-2027', periodTo: '31-03-2027', startBalance: START_BALANCE });
const paths = { html: join(SRC, 'ing-fake-holder.html'), pdf: join(FIXTURES, 'ing-fake-holder.pdf') };
await writeFile(paths.html, mar.html, 'utf8');
// expected.json: statement + rows like the other fixtures, the holder lines, and the clean [name, description] per
// row the app must store: clean (the PDF) and csvClean (the CSV, read after the PDF).
await writeFile(join(FIXTURES, 'ing-fake-holder.expected.json'),
  `${JSON.stringify({ ...mar.expected, holder: HOLDER, clean: MAR_CLEAN, csvClean: APR_CLEAN }, null, 2)}\n`, 'utf8');
await writeFile(join(FIXTURES, 'ing-fake-holder.csv'), csv(APR_ROWS, mar.expected.statement.endBalance), 'utf8');
await printPdf(paths.html, paths.pdf);

const page = await devPage();
const profileDir = '.tmp/fixtures/edge-holder-extract';
const edge = await launchEdge({ profileDir, width: 1100 });
try {
  await checkLayout(edge, paths.html);
  await edge.open(fileUrl(page));
  await edge.setFiles('#file', [paths.pdf]);
  const pages = await edge.eval(async () => {
    const file = document.getElementById('file').files[0];
    return Budget.importPdf.extract(await file.arrayBuffer());
  });
  assert.equal(pages.length, MAR_PAGES.length);
  assert.deepEqual(edge.errors(), [], 'no console errors while reading the PDF');
  await writeFile(join(FIXTURES, 'ing-fake-holder.items.json'), `${JSON.stringify(pages, null, 1)}\n`, 'utf8');
  console.log(JSON.stringify({ pdf: paths.pdf, pages: pages.length, rows: MAR_ROWS.length, ...mar.expected.statement,
    csvRows: APR_ROWS.length }, null, 1));
} finally {
  await edge.close();
  await rm(join(APP_ROOT, profileDir), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await rm(page, { force: true });
}
