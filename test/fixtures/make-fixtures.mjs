// Generates FAKE test fixtures. Every name, IBAN and amount is invented test data.
//   ing-fake-2.pdf  (+ src/ing-fake-2.html, ing-fake-2.expected.json)  3-page ING statement, November 2026, 30 rows
//   not-ing.pdf     (+ src/not-ing.html)  an ordinary one-page letter with dates and amounts, not a bank statement
//   corrupt.pdf     the first third of ing-fake-2.pdf (truncated bytes)
//   ing-fake-english.csv  English header, ';', 11 columns, CRLF, UTF-8 with BOM, December 2026
//   ing-fake-cp1252.csv   Dutch header, ',', 9 columns, CRLF, Windows-1252 bytes (é ë ê ï €), January 2027
//   garbage.csv           not a bank file: other columns, broken quoting, a few binary bytes
// The balances chain on from the older fixtures: ing-fake-1.pdf (Sep) -> ing-fake-*.csv (Oct, newest saldo 713,58)
// -> ing-fake-2.pdf (Nov) -> ing-fake-english.csv (Dec).
// The PDFs are printed from an HTML replica of the ING statement layout -> Edge headless --print-to-pdf.
// Afterwards the layout is measured in Edge (nothing may run into the footer or wrap in the narrow columns) and the
// PDFs are read back with the app's own import-pdf.js + pdf.js (like make-holder-fixtures.mjs).
// Needs Microsoft Edge. It overwrites the fixtures in this folder; the committed ones are what the tests expect.
//   node test/fixtures/make-fixtures.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_ROOT, EDGE_EXE, launchEdge } from '../lib/cdp.mjs';

const FIXTURES = dirname(fileURLToPath(import.meta.url));
const SRC = join(FIXTURES, 'src');
const OWN_IBAN = 'NL00INGB0000000000';
const NOV_START = 71358; // newest saldo of ing-fake-semicolon.csv (end of October)

// ---- money and dates -------------------------------------------------------------------------------

// 123456 -> "1.234,56" (PDF) or "1234,56" (CSV: no thousands separator); signed: "+1.234,56" / "-1.234,56".
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

// ---- ing-fake-2: three-page statement, November 2026 -----------------------------------------------

// Newest first. `details` = regular-weight lines under the bold payee name.
const NOV_ROWS = [
  // page 1
  { date: '30-11-2026', name: 'Naar Oranje spaarrekening X12345678', type: 'Online bankieren', amount: -250000,
    details: ['Omschrijving: Sparen november', 'Valutadatum: 30-11-2026'] },
  { date: '29-11-2026', name: 'Huisbaas BV', type: 'Overschrijving', amount: -105000,
    details: ['Omschrijving: Huur december 2026 Teststraat 1', 'IBAN: NL00TEST0123456789', 'Kenmerk: HUUR-2026-12',
      'Valutadatum: 29-11-2026'] },
  { date: '28-11-2026', name: 'Kosten ING Go', type: 'Diversen', amount: -295,
    details: ['01-10-2026 - 31-10-2026', 'ING BANK N.V.', 'Valutadatum: 28-11-2026'] },
  { date: '27-11-2026', name: 'Webwinkel Test', type: 'iDEAL', amount: -124900,
    details: ['Omschrijving: Bestelling 4400777 laptop Webwinkel Test', 'IBAN: NL00TEST0000000004',
      'Kenmerk: 27-11-2026 21:14 0050001112223334', 'Valutadatum: 27-11-2026'] },
  { date: '26-11-2026', name: 'Notaris Test BV', type: 'Overschrijving', amount: 1050000,
    details: ['Omschrijving: Uitbetaling dossier 2026-0099', 'IBAN: NL00TEST0000000010', 'Kenmerk: NOT-2026-0099',
      'Valutadatum: 26-11-2026'] },
  { date: '25-11-2026', name: 'Werkgever Voorbeeld BV', type: 'Overschrijving', amount: 214560,
    details: ['Omschrijving: Salaris november 2026', 'IBAN: NL00TEST0000000002', 'Kenmerk: SAL-2026-11',
      'Valutadatum: 25-11-2026'] },
  { date: '24-11-2026', name: 'Geldautomaat TESTDORP', type: 'Geldautomaat', amount: -10000,
    details: ['Pasvolgnr: 003 24-11-2026 12:05', 'Transactie: B00077 Term: YY000001', 'Valutadatum: 24-11-2026'] },
  { date: '23-11-2026', name: 'SUPERMARKT 1234 TESTDORP', type: 'Betaalautomaat', amount: -6341,
    details: ['Pasvolgnr: 003 23-11-2026 17:42', 'Transactie: A00091 Term: XX000000', 'Valutadatum: 23-11-2026'] },
  { date: '22-11-2026', name: 'Energiebedrijf Test BV', type: 'Incasso', amount: -9700, // long row, last on page 1
    details: ['Omschrijving: Termijnbedrag energie november 2026 klantnummer 112233445 levering Teststraat 1 '
      + 'Voorbeeldstad stroom en gas, inclusief vastrecht en netbeheerkosten volgens contract 2026', 'IBAN: NL00TEST0000000006',
    'Kenmerk: 0000112233447', 'Machtiging ID: ENE-000456', 'Incassant ID: NL00ZZZ111111111111', 'Doorlopende incasso',
    'Valutadatum: 22-11-2026'] },
  // page 2
  { date: '21-11-2026', name: 'J. Jansen', type: 'Online bankieren', amount: 4500,
    details: ['Omschrijving: Terug voor de kaartjes', 'IBAN: NL00TEST0000000003', 'Datum/Tijd: 21-11-2026 19:03:11',
      'Valutadatum: 21-11-2026'] },
  { date: '20-11-2026', name: 'Belastingdienst', type: 'Verzamelbetaling', amount: 123400,
    details: ['Omschrijving: Teruggaaf inkomstenbelasting 2025 0000000000000000', 'IBAN: NL00TEST0000000005',
      'Kenmerk: 0000000000000001', 'Valutadatum: 20-11-2026'] },
  { date: '19-11-2026', name: 'Garage Test BV', type: 'Acceptgiro', amount: -38950,
    details: ['Omschrijving: Factuur 2026-0789 onderhoud', 'IBAN: NL00TEST0000000008', 'Kenmerk: 2026078900000001',
      'Valutadatum: 19-11-2026'] },
  { date: '18-11-2026', name: 'Telecom Test BV', type: 'Incasso', amount: -2750,
    details: ['Omschrijving: Factuur november abonnement', 'IBAN: NL00TEST0000000007', 'Kenmerk: TEL202611',
      'Machtiging ID: TEL-000789', 'Incassant ID: NL00ZZZ222222222222', 'Doorlopende incasso', 'Valutadatum: 18-11-2026'] },
  { date: '17-11-2026', name: 'DROGIST TEST 0042 TESTDORP', type: 'Betaalautomaat', amount: -1879,
    details: ['Pasvolgnr: 003 17-11-2026 09:14', 'Transactie: C00102 Term: ZZ000002', 'Valutadatum: 17-11-2026'] },
  { date: '15-11-2026', name: 'Van Oranje spaarrekening X12345679', type: 'Online bankieren', amount: 50000,
    details: ['Omschrijving: Terug van sparen', 'Valutadatum: 15-11-2026'] },
  { date: '14-11-2026', name: 'SUPERMARKT 1234 TESTDORP', type: 'Betaalautomaat', amount: -8715,
    details: ['Pasvolgnr: 003 14-11-2026 16:20', 'Transactie: A00088 Term: XX000000', 'Valutadatum: 14-11-2026'] },
  { date: '13-11-2026', name: 'Zorgverzekeraar Test NV', type: 'Incasso', amount: -13485,
    details: ['Omschrijving: Premie december 2026 polis 99887766', '01-12-2026 - 01-01-2027', 'IBAN: NL00TEST0000000001',
      'Kenmerk: 2026120000001', 'Machtiging ID: MDT000123', 'Incassant ID: NL00ZZZ000000000000', 'Doorlopende incasso',
      'Valutadatum: 13-11-2026'] },
  { date: '12-11-2026', name: 'Geldautomaat TESTDORP', type: 'Geldautomaat', amount: -5000,
    details: ['Pasvolgnr: 003 12-11-2026 11:30', 'Transactie: B00070 Term: YY000001', 'Valutadatum: 12-11-2026'] },
  { date: '11-11-2026', name: 'Gemeente Testdorp', type: 'Incasso', amount: -4820,
    details: ['Omschrijving: Gemeentelijke belastingen termijn 9 van 10', 'IBAN: NL00TEST0000000011',
      'Kenmerk: AANSLAG-2026-0042', 'Doorlopende incasso', 'Valutadatum: 11-11-2026'] },
  { date: '09-11-2026', name: 'K. Bakker', type: 'Telefonisch bankieren', amount: -7500, splitAt: 2, // continues on page 3
    details: ['Omschrijving: Cadeau verjaardag, met dank voor het oppassen in oktober', 'IBAN: NL00TEST0000000013',
      'Datum/Tijd: 09-11-2026 10:41:07', 'Valutadatum: 09-11-2026'] },
  // page 3
  { date: '08-11-2026', name: 'Bakkerij Test', type: 'Betaalautomaat', amount: -735,
    details: ['Pasvolgnr: 003 08-11-2026 09:12', 'Transactie: C00099 Term: ZZ000004', 'Valutadatum: 08-11-2026'] },
  { date: '07-11-2026', name: 'Webwinkel Test', type: 'iDEAL', amount: -2495,
    details: ['Omschrijving: Bestelling 4400888 Webwinkel Test', 'IBAN: NL00TEST0000000004',
      'Kenmerk: 07-11-2026 14:21 0050004445556667', 'Valutadatum: 07-11-2026'] },
  { date: '06-11-2026', name: 'SUPERMARKT 1234 TESTDORP', type: 'Betaalautomaat', amount: -5562,
    details: ['Pasvolgnr: 003 06-11-2026 18:02', 'Transactie: A00080 Term: XX000000', 'Valutadatum: 06-11-2026'] },
  { date: '05-11-2026', name: 'Bibliotheek Test', type: 'Incasso', amount: -450,
    details: ['Omschrijving: Contributie november', 'IBAN: NL00TEST0000000014', 'Doorlopende incasso',
      'Valutadatum: 05-11-2026'] },
  { date: '04-11-2026', name: 'Café De Gouden Test', type: 'Betaalautomaat', amount: -1280,
    details: ['Pasvolgnr: 003 04-11-2026 21:15', 'Transactie: C00095 Term: ZZ000003', 'Valutadatum: 04-11-2026'] },
  { date: '03-11-2026', name: 'Waterbedrijf Test', type: 'Incasso', amount: -2180,
    details: ['Omschrijving: Voorschot water november', 'IBAN: NL00TEST0000000015', 'Doorlopende incasso',
      'Valutadatum: 03-11-2026'] },
  { date: '03-11-2026', name: 'Uitkeringsinstantie Test', type: 'Overschrijving', amount: 61250,
    details: ['Omschrijving: Uitkering november 2026', 'IBAN: NL00TEST0000000016', 'Kenmerk: UIT-2026-11',
      'Valutadatum: 03-11-2026'] },
  { date: '02-11-2026', name: 'Stichting Goede Doelen Test', type: 'Incasso', amount: -1000,
    details: ['Omschrijving: Maandelijkse gift', 'IBAN: NL00TEST0000000017', 'Doorlopende incasso', 'Valutadatum: 02-11-2026'] },
  { date: '01-11-2026', name: 'Tankstation Test TESTDORP', type: 'Betaalautomaat', amount: -6135,
    details: ['Pasvolgnr: 003 01-11-2026 08:47', 'Transactie: A00079 Term: XX000000', 'Valutadatum: 01-11-2026'] },
  { date: '01-11-2026', name: 'Kinderopvang Test BV', type: 'Incasso', amount: -118000,
    details: ['Omschrijving: Opvang november 2026', 'IBAN: NL00TEST0000000018', 'Kenmerk: KOV-2026-11', 'Doorlopende incasso',
      'Valutadatum: 01-11-2026'] },
];
const NOV_PAGES = [9, 11, 10]; // rows starting on each page

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

function statementHtml({ title, holder, account, periodFrom, periodTo, startBalance, rows, rowsPerPage }) {
  const totalIn = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  const totalOut = rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0);
  const endBalance = startBalance + totalIn - totalOut;
  const pageCount = rowsPerPage.length;
  const meta = (cls, pairs) => `<div class="meta${cls}">${pairs.map(([l, v]) => `<span class="label">${l}</span><span>${v}</span>`).join('')}</div>`;
  const tableHead = '<div class="thead"><span>Geboekt op</span><span>Naam / Omschrijving / Mededeling</span><span>Type</span><span class="r">Bedrag (EUR)</span></div>';
  const lines = (details) => details.map((d) => `<span>${esc(d)}</span>`).join('');
  const txRow = (r) => `<div class="tx"><span class="date">${r.date}</span><div class="name"><b>${esc(r.name)}</b>${lines(r.splitAt ? r.details.slice(0, r.splitAt) : r.details)}</div>`
    + `<span class="type">${esc(r.type)}</span><span class="amount">${euro(r.amount, { signed: true })}</span></div>`;
  const continuation = (r) => `<div class="tx cont"><span></span><div class="name">${lines(r.details.slice(r.splitAt))}</div><span></span><span></span></div>`;
  const footer = (n) => `<div class="footer"><p>Dit product valt onder het depositogarantiestelsel. Meer informatie vindt u in het informatieblad depositogarantiestelsel.</p>`
    + `<p>ING Bank N.V., statutair gevestigd te Amsterdam, Handelsregister nr. 00000000. TESTBESTAND MET NEPGEGEVENS.</p>`
    + `<p class="pagenr">Pagina ${n} van ${pageCount}</p><p class="code">A-PAYPS01</p></div>`;

  let from = 0;
  const pages = rowsPerPage.map((count, i) => {
    const pageRows = rows.slice(from, from + count);
    const carried = i > 0 && rows[from - 1].splitAt ? continuation(rows[from - 1]) : '';
    from += count;
    const head = i === 0
      ? `<p class="title">${title}</p><div class="holder">${holder.map((l) => `<p>${esc(l)}</p>`).join('')}</div>`
        + meta('', [['Periode', `${periodFrom} t/m ${periodTo}`], ['Rekeningnummer', account]])
        + `<div class="saldo"><span class="label">Beginsaldo (EUR)</span><span class="label">Totaal bij (EUR)</span>`
        + `<span class="value">${euro(startBalance)}</span><span class="value">${euro(totalIn)}</span>`
        + `<span class="label">Eindsaldo (EUR)</span><span class="label">Totaal af (EUR)</span>`
        + `<span class="value">${euro(endBalance)}</span><span class="value">${euro(totalOut)}</span></div>`
      : meta(' small', [['Rekeningnummer', account], ['Periode', `${periodFrom} t/m ${periodTo}`]]);
    return `<section class="page ${i === 0 ? 'first' : 'next'}">\n${head}\n<div class="table">${tableHead}\n${carried}${pageRows.map(txRow).join('\n')}\n</div>\n${footer(i + 1)}\n</section>`;
  });
  assert.equal(from, rows.length, 'rowsPerPage must cover every row');

  const html = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<title>${title} (NEP)</title>
<!-- FAKE test fixture: replica of the ING "Afschrift Betaalrekening" layout.
     Generated by test/fixtures/make-fixtures.mjs; printed with Edge headless --print-to-pdf --no-pdf-header-footer. -->
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

const NOT_ING_HTML = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<title>Uitnodiging (NEP)</title>
<!-- FAKE test fixture: an ordinary letter, NOT a bank statement. Generated by test/fixtures/make-fixtures.mjs. -->
<style>
@page { size: A4; margin: 25mm 22mm; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.45; color: #000; }
h1 { font-size: 16pt; margin: 0 0 14pt; }
table { border-collapse: collapse; margin: 10pt 0; }
td, th { border: 0.5pt solid #888; padding: 3pt 8pt; text-align: left; }
td.r { text-align: right; }
</style>
</head>
<body>
<p>Vereniging Testdorp<br>Dorpsstraat 1<br>1234 AB Testdorp</p>
<p>Testdorp, 01-11-2026</p>
<h1>Uitnodiging ledenvergadering</h1>
<p>Beste leden,</p>
<p>Op 12-12-2026 houden we de jaarlijkse ledenvergadering in het dorpshuis. We bespreken de begroting voor 2027 en
kiezen een nieuwe penningmeester. Na afloop is er koffie met appeltaart.</p>
<table>
<tr><th>Datum</th><th>Onderwerp</th><th>Bedrag</th></tr>
<tr><td>12-12-2026</td><td>Contributie 2027</td><td class="r">25,00</td></tr>
<tr><td>12-12-2026</td><td>Bijdrage kerstmarkt</td><td class="r">-7,50</td></tr>
<tr><td>01-01-2027</td><td>Totaal</td><td class="r">17,50</td></tr>
</table>
<p>Met vriendelijke groet,<br>het bestuur van Vereniging Testdorp</p>
</body>
</html>
`;

// ---- CSV fixtures ----------------------------------------------------------------------------------

const quote = (v) => `"${String(v).replace(/"/g, '""')}"`;

// rows oldest first ({date dd-mm-yyyy, name, iban, code, type, amount, msg, tag?}); written newest first.
function csv({ header, rows, sep, eol, startBalance, debitCredit, withBalance }) {
  let balance = startBalance;
  const lines = rows.map((r) => {
    balance += r.amount;
    const fields = [ymd(r.date), r.name, OWN_IBAN, r.iban, r.code, r.amount < 0 ? debitCredit[0] : debitCredit[1],
      euro(Math.abs(r.amount), { grouped: false }), r.type, r.msg];
    if (withBalance) fields.push(euro(balance, { grouped: false }), r.tag || '');
    return fields.map(quote).join(sep);
  }).reverse();
  return { text: [header.map(quote).join(sep), ...lines].join(eol) + eol, endBalance: balance };
}

const EN_HEADER = ['Date', 'Name / Description', 'Account', 'Counterparty', 'Code', 'Debit/credit', 'Amount (EUR)',
  'Transaction type', 'Notifications', 'Resulting balance', 'Tag'];
const NL_HEADER_9 = ['Datum', 'Naam / Omschrijving', 'Rekening', 'Tegenrekening', 'Code', 'Af Bij', 'Bedrag (EUR)',
  'Mutatiesoort', 'Mededelingen'];

const DEC_ROWS = [
  { date: '01-12-2026', name: 'Huisbaas BV', iban: 'NL00TEST0123456789', code: 'OV', type: 'Transfer', amount: -105000,
    msg: 'Name: Huisbaas BV Description: Rent January 2027 Teststraat 1 IBAN: NL00TEST0123456789 Reference: HUUR-2027-01 Value date: 01/12/2026' },
  { date: '02-12-2026', name: 'Kosten ING Go', iban: '', code: 'DV', type: 'Various', amount: -295,
    msg: '1 Nov through 30 Nov 2026 ING BANK N.V. Value date: 02/12/2026' },
  { date: '03-12-2026', name: 'Uitkeringsinstantie Test', iban: 'NL00TEST0000000016', code: 'OV', type: 'Transfer', amount: 61250,
    msg: 'Name: Uitkeringsinstantie Test Description: Uitkering december 2026 IBAN: NL00TEST0000000016 Reference: UIT-2026-12 Value date: 03/12/2026' },
  { date: '05-12-2026', name: 'SUPERMARKT 1234 TESTDORP', iban: '', code: 'BA', type: 'Payment terminal', amount: -4211,
    msg: 'Card sequence no.: 003 05/12/2026 16:20 Transaction: D00121 Term: XX000000 Value date: 05/12/2026', tag: '#groceries' },
  { date: '08-12-2026', name: 'Zorgverzekeraar Test NV', iban: 'NL00TEST0000000001', code: 'IC', type: 'SEPA direct debit', amount: -13485,
    msg: 'Name: Zorgverzekeraar Test NV Description: Premie januari 2027 polis 99887766 IBAN: NL00TEST0000000001 Reference: 2027010000001 Mandate ID: MDT000123 Creditor ID: NL00ZZZ000000000000 Recurrent SEPA direct debit Value date: 08/12/2026' },
  { date: '10-12-2026', name: 'Geldautomaat TESTDORP', iban: '', code: 'GM', type: 'Cash machine', amount: -5000,
    msg: 'Card sequence no.: 003 10/12/2026 12:05 Transaction: B00130 Term: YY000001 Value date: 10/12/2026' },
  { date: '12-12-2026', name: 'J. Jansen', iban: 'NL00TEST0000000003', code: 'GT', type: 'Online Banking', amount: 2000,
    msg: 'Name: J. Jansen Description: Pizza; drinks, and dessert IBAN: NL00TEST0000000003 Date/time: 12-12-2026 20:15:42 Value date: 12/12/2026' },
  { date: '15-12-2026', name: 'Webwinkel Test', iban: 'NL00TEST0000000004', code: 'ID', type: 'iDEAL', amount: -3995,
    msg: 'Name: Webwinkel Test Description: Order 4400999 Webwinkel Test IBAN: NL00TEST0000000004 Reference: 15-12-2026 10:02 0050009876543210 Value date: 15/12/2026' },
  { date: '18-12-2026', name: 'Belastingdienst', iban: 'NL00TEST0000000005', code: 'VZ', type: 'Batch payment', amount: 11800,
    msg: 'Name: Belastingdienst Description: Toeslag december 2026 0000000000000000 IBAN: NL00TEST0000000005 Reference: 0000000000000002 Value date: 18/12/2026' },
  { date: '23-12-2026', name: 'Werkgever Voorbeeld BV', iban: 'NL00TEST0000000002', code: 'OV', type: 'Transfer', amount: 214560,
    msg: 'Name: Werkgever Voorbeeld BV Description: Salary December 2026 "13th month" IBAN: NL00TEST0000000002 Reference: SAL-2026-12 Value date: 23/12/2026' },
  { date: '24-12-2026', name: 'Naar Oranje spaarrekening X12345678', iban: '', code: 'GT', type: 'Online Banking', amount: -20000,
    msg: 'Description: Savings December Value date: 24/12/2026', tag: '#savings' },
  { date: '28-12-2026', name: 'Kerstmarkt Test', iban: '', code: 'BA', type: 'Payment terminal', amount: -1850,
    msg: 'Card sequence no.: 003 28/12/2026 15:30 Transaction: D00140 Term: XX000004 Value date: 28/12/2026' },
];

const JAN_ROWS = [
  { date: '02-01-2027', name: 'Kosten ING Go', iban: '', code: 'DV', type: 'Diversen', amount: -295,
    msg: '1 dec t/m 31 dec 2026 ING BANK N.V. Valutadatum: 02-01-2027' },
  { date: '04-01-2027', name: 'Café De Brug Test', iban: '', code: 'BA', type: 'Betaalautomaat', amount: -1460,
    msg: 'Pasvolgnr: 003 04-01-2027 20:11 Transactie: A00140 Term: XX000005 Valutadatum: 04-01-2027' },
  { date: '06-01-2027', name: 'Crêperie Test', iban: '', code: 'BA', type: 'Betaalautomaat', amount: -2390,
    msg: 'Pasvolgnr: 003 06-01-2027 18:45 Transactie: A00141 Term: XX000006 Valutadatum: 06-01-2027' },
  { date: '08-01-2027', name: 'Zoë de Vries', iban: 'NL00TEST0000000019', code: 'GT', type: 'Online bankieren', amount: 1250,
    msg: 'Naam: Zoë de Vries Omschrijving: Terug voor de crêpes, € 12,50 IBAN: NL00TEST0000000019 Datum/Tijd: 08-01-2027 21:02:33 Valutadatum: 08-01-2027' },
  { date: '11-01-2027', name: 'Patisserie Noël Test', iban: '', code: 'BA', type: 'Betaalautomaat', amount: -875,
    msg: 'Pasvolgnr: 003 11-01-2027 10:05 Transactie: A00142 Term: XX000007 Valutadatum: 11-01-2027' },
  { date: '14-01-2027', name: 'Naïef Theater Test', iban: 'NL00TEST0000000020', code: 'ID', type: 'iDEAL', amount: -3600,
    msg: 'Naam: Naïef Theater Test Omschrijving: Tickets première 2 personen IBAN: NL00TEST0000000020 Kenmerk: 14-01-2027 09:30 0050001231231231 Valutadatum: 14-01-2027' },
  { date: '20-01-2027', name: 'Belastingdienst', iban: 'NL00TEST0000000005', code: 'VZ', type: 'Verzamelbetaling', amount: 11800,
    msg: 'Naam: Belastingdienst Omschrijving: Toeslag januari 2027 0000000000000000 IBAN: NL00TEST0000000005 Kenmerk: 0000000000000003 Valutadatum: 20-01-2027' },
  { date: '25-01-2027', name: 'Werkgever Voorbeeld BV', iban: 'NL00TEST0000000002', code: 'OV', type: 'Overschrijving', amount: 214560,
    msg: 'Naam: Werkgever Voorbeeld BV Omschrijving: Salaris januari 2027 IBAN: NL00TEST0000000002 Kenmerk: SAL-2027-01 Valutadatum: 25-01-2027' },
];

// Windows-1252: ASCII and U+00A0..U+00FF map to themselves; the euro sign is 0x80. Anything else is a bug here.
function cp1252(text) {
  return Buffer.from([...text].map((ch) => {
    const code = ch.codePointAt(0);
    if (ch === '€') return 0x80;
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) return code;
    throw new Error(`no Windows-1252 byte for ${ch}`);
  }));
}

const GARBAGE = Buffer.concat([
  Buffer.from([
    'Naam;Telefoon;Opmerking',
    '"Test, Piet";0600000000;"Bel na vijf uur',
    'Onafgesloten "aanhalingsteken;;;;',
    'x;y',
    '',
  ].join('\n'), 'utf8'),
  Buffer.from([0x00, 0xff, 0xfe, 0x1b, 0x5b, 0x30, 0x6d, 0x80, 0x81, 0x0a]),
  Buffer.from('1;2;3;4;5;6;7;8;9;10;11;12\n', 'utf8'),
]);

// ---- printing and checks ---------------------------------------------------------------------------

function run(exe, args) {
  return new Promise((ok, fail) => {
    const p = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${exe} exited with ${code}`))));
    p.on('error', fail);
  });
}

async function printPdf(htmlPath, pdfPath) {
  await mkdir(join(APP_ROOT, '.tmp'), { recursive: true });
  const profile = await mkdtemp(join(APP_ROOT, '.tmp', 'edge-print-'));
  try {
    await run(EDGE_EXE, ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions',
      '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href]);
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

// In print layout: every row ends above the footer, and date/type/amount never wrap.
async function checkLayout(edge, htmlPath) {
  await edge.open(pathToFileURL(htmlPath).href);
  await edge.printMedia(true);
  const problems = await edge.eval(() => {
    const out = [];
    document.querySelectorAll('.page').forEach((page, i) => {
      const footerTop = page.querySelector('.footer').getBoundingClientRect().top;
      const rows = page.querySelectorAll('.tx');
      const last = rows[rows.length - 1].getBoundingClientRect();
      if (last.bottom > footerTop - 6) out.push(`page ${i + 1}: rows reach the footer (${Math.round(last.bottom)} > ${Math.round(footerTop)})`);
      page.querySelectorAll('.date, .type, .amount, .name b').forEach((el) => {
        const text = document.createRange();
        text.selectNodeContents(el);
        if (text.getClientRects().length > 1) out.push(`page ${i + 1}: "${el.textContent}" wraps`);
      });
    });
    return out;
  });
  await edge.printMedia(false);
  assert.deepEqual(problems, [], htmlPath);
}

// A page with pdf.js embedded as inert text (like the build does) and the app's own util/store/import-pdf.
async function devPage() {
  const read = (p) => readFile(join(APP_ROOT, p), 'utf8');
  const scripts = await Promise.all(['src/js/util.js', 'src/js/store.js', 'src/js/import-pdf.js'].map(read));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>fixture extract</title></head><body>
<input type="file" id="file">
<script type="text/plain" id="pdfjs-lib">${await read('vendor/pdf.min.mjs')}</script>
<script type="text/plain" id="pdfjs-worker">${await read('vendor/pdf.worker.min.mjs')}</script>
${scripts.map((s) => `<script>\n${s}\n</script>`).join('\n')}
</body></html>`;
  await mkdir(join(APP_ROOT, '.tmp'), { recursive: true });
  const path = join(APP_ROOT, '.tmp', 'fixtures-extract.html');
  await writeFile(path, html, 'utf8');
  return path;
}

// Reads a PDF with Budget.importPdf.extract(): {state: 'done', pages} or {state: 'error', error}.
async function extract(edge, page, pdfPath) {
  await edge.open(pathToFileURL(page).href);
  await edge.setFiles('#file', [pdfPath]);
  return edge.eval(async () => {
    try {
      const file = document.getElementById('file').files[0];
      return { state: 'done', pages: await Budget.importPdf.extract(await file.arrayBuffer()) };
    } catch (err) {
      return { state: 'error', error: `${(err && err.name) || 'Error'}: ${(err && err.message) || err}` };
    }
  });
}

// The text layer must hold every value the parser needs, on the page where the row starts.
function checkStatementText(proof, expected, rowsPerPage, rows) {
  assert.equal(proof.state, 'done', proof.error);
  const { pages } = proof;
  assert.equal(pages.length, rowsPerPage.length);
  const near = (a, b) => Math.abs(a - b) < 3;
  const has = (page, str, pred = () => true) => pages[page].items.some((i) => i.str.trim() === str && pred(i));
  const s = expected.statement;
  for (const str of [`${s.periodFrom.split('-').reverse().join('-')} t/m ${s.periodTo.split('-').reverse().join('-')}`,
    euro(s.startBalance), euro(s.endBalance), euro(s.totalIn), euro(s.totalOut)]) {
    assert.ok(has(0, str), `page 1 has "${str}"`);
  }
  let page = 0;
  let left = rowsPerPage[0];
  rows.forEach((r) => {
    while (left === 0) left = rowsPerPage[++page];
    left--;
    assert.ok(has(page, r.date, (i) => near(i.x, 50)), `date ${r.date} on page ${page + 1}`);
    assert.ok(has(page, r.name, (i) => i.bold && near(i.x, 107)), `bold name ${r.name}`);
    assert.ok(has(page, r.type, (i) => near(i.x, 369)), `type ${r.type}`);
    assert.ok(has(page, euro(r.amount, { signed: true }), (i) => near(i.x + i.w, 560)), `amount ${r.amount}`);
    if (r.splitAt) {
      const carried = r.details.slice(r.splitAt);
      const firstDate = Math.min(...pages[page + 1].items.filter((i) => /^\d\d-\d\d-\d{4}$/.test(i.str) && near(i.x, 50)).map((i) => i.y));
      for (const line of carried) {
        assert.ok(has(page + 1, line, (i) => near(i.x, 107) && i.y < firstDate), `"${line}" continues at the top of page ${page + 2}`);
      }
    }
  });
}

// ---- main ------------------------------------------------------------------------------------------

await mkdir(SRC, { recursive: true });

const nov = statementHtml({
  title: 'Afschrift Betaalrekening',
  holder: ['T. Tester', 'Teststraat 1', '1234 AB Voorbeeldstad'],
  account: 'NL00 INGB 0000 0000 00',
  periodFrom: '01-11-2026',
  periodTo: '30-11-2026',
  startBalance: NOV_START,
  rows: NOV_ROWS,
  rowsPerPage: NOV_PAGES,
});
const paths = {
  novHtml: join(SRC, 'ing-fake-2.html'),
  novPdf: join(FIXTURES, 'ing-fake-2.pdf'),
  notIngHtml: join(SRC, 'not-ing.html'),
  notIngPdf: join(FIXTURES, 'not-ing.pdf'),
  corruptPdf: join(FIXTURES, 'corrupt.pdf'),
};
await writeFile(paths.novHtml, nov.html, 'utf8');
await writeFile(join(FIXTURES, 'ing-fake-2.expected.json'), JSON.stringify(nov.expected, null, 2) + '\n', 'utf8');
await writeFile(paths.notIngHtml, NOT_ING_HTML, 'utf8');

const dec = csv({ header: EN_HEADER, rows: DEC_ROWS, sep: ';', eol: '\r\n', startBalance: nov.expected.statement.endBalance,
  debitCredit: ['Debit', 'Credit'], withBalance: true });
await writeFile(join(FIXTURES, 'ing-fake-english.csv'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(dec.text, 'utf8')]));
const jan = csv({ header: NL_HEADER_9, rows: JAN_ROWS, sep: ',', eol: '\r\n', startBalance: dec.endBalance,
  debitCredit: ['Af', 'Bij'], withBalance: false });
await writeFile(join(FIXTURES, 'ing-fake-cp1252.csv'), cp1252(jan.text));
await writeFile(join(FIXTURES, 'garbage.csv'), GARBAGE);

await printPdf(paths.novHtml, paths.novPdf);
await printPdf(paths.notIngHtml, paths.notIngPdf);
const novBytes = await readFile(paths.novPdf);
await writeFile(paths.corruptPdf, novBytes.subarray(0, Math.floor(novBytes.length / 3)));

const page = await devPage();
const edge = await launchEdge({ width: 1100 });
try {
  await checkLayout(edge, paths.novHtml);
  checkStatementText(await extract(edge, page, paths.novPdf), nov.expected, NOV_PAGES, NOV_ROWS);
  const notIng = await extract(edge, page, paths.notIngPdf);
  assert.equal(notIng.state, 'done', notIng.error);
  const notIngText = notIng.pages.flatMap((p) => p.items.map((i) => i.str)).join(' ');
  assert.match(notIngText, /ledenvergadering/);
  assert.doesNotMatch(notIngText, /Afschrift|Geboekt op|Beginsaldo/);
  const corrupt = await extract(edge, page, paths.corruptPdf);
  assert.equal(corrupt.state, 'error', 'pdf.js must refuse corrupt.pdf');
  assert.deepEqual(edge.errors(), [], 'no console errors while reading the fixtures');
  console.log(JSON.stringify({
    'ing-fake-2.pdf': { pages: NOV_PAGES.length, rows: NOV_ROWS.length, ...nov.expected.statement },
    'not-ing.pdf': { pages: notIng.pages.length },
    'corrupt.pdf': { bytes: Math.floor(novBytes.length / 3), pdfjs: corrupt.error.split('\n')[0] },
    'ing-fake-english.csv': { rows: DEC_ROWS.length, startBalance: nov.expected.statement.endBalance, endBalance: dec.endBalance },
    'ing-fake-cp1252.csv': { rows: JAN_ROWS.length },
  }, null, 1));
} finally {
  await edge.close();
  await rm(page, { force: true });
}
