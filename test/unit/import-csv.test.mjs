// Unit tests for src/js/import-csv.js (Budget.importCsv), loaded as classic scripts in a vm context.
// Fixtures: test/fixtures/ing-fake-comma.csv and ing-fake-semicolon.csv (the same 12 fake rows); the English
// header and Windows-1252 samples are made here from fake strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function load() {
  const context = vm.createContext({ TextEncoder, crypto: globalThis.crypto });
  for (const f of ['util.js', 'import-csv.js']) vm.runInContext(read(`src/js/${f}`), context, { filename: f });
  return context.Budget.importCsv;
}

const importCsv = load();
const parse = (text) => plain(importCsv.parse(text));
const COMMA = read('test/fixtures/ing-fake-comma.csv');
const SEMICOLON = read('test/fixtures/ing-fake-semicolon.csv');
const READ_ERROR = "I can't read this file. Is it an ING statement (PDF) or ING download (CSV)?";
const HEADER = '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen";"Saldo na mutatie";"Tag"';

// One semicolon row: [date, name, counterparty, code, afBij, amount, type, notes, saldo]
function csvRow([date, name, iban, code, dir, amount, type, notes, saldo]) {
  return [date, name, 'NL00INGB0000000000', iban, code, dir, amount, type, notes, saldo, '']
    .map((c) => `"${c.replace(/"/g, '""')}"`)
    .join(';');
}

const isError = (message) => (err) => err.name === 'ImportError' && err.message === message;

test('comma CSV (9 columns, CRLF): 12 raw rows newest first, no balances', () => {
  const result = parse(COMMA);
  assert.equal(result.rows.length, 12);
  assert.equal(result.english, false);
  assert.equal(result.statement, null);
  assert.equal(result.check, null);
  assert.deepEqual(result.monthStatements, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.rows[0], {
    date: '2026-10-28',
    rawName: 'Geldautomaat TESTDORP',
    rawDescription: 'Pasvolgnr: 003 28-10-2026 11:30 Transactie: E00090 Term: YY000001 Valutadatum: 28-10-2026',
    amount: -4000,
    type: 'Geldautomaat',
    iban: '',
  });
  const salary = result.rows.find((r) => r.rawName === 'Werkgever Voorbeeld BV');
  assert.equal(salary.amount, 131240, 'Bij = +, decimal comma, no thousands separator');
  assert.equal(salary.iban, 'NL00TEST0000000002');
  const garage = result.rows.find((r) => r.rawName === 'Garage Test BV');
  assert.match(garage.rawDescription, /Factuur 2026-0456; APK en onderhoud/, 'a ; inside a quoted field');
  assert.match(result.rows.find((r) => r.rawName === 'J. Jansen').rawDescription, /Bioscoop, popcorn en drinken/, 'a , inside a quoted field');
  assert.deepEqual(result.rows.map((r) => r.date), [...result.rows.map((r) => r.date)].sort().reverse());
});

test('semicolon CSV (11 columns, LF, no final newline): same rows, balance chain ok, statement derived', () => {
  const comma = parse(COMMA);
  const result = parse(SEMICOLON);
  assert.deepEqual(result.rows, comma.rows);
  assert.deepEqual(result.check, { kind: 'saldo', ok: true });
  const expected = {
    periodFrom: '2026-10-01',
    periodTo: '2026-10-28',
    startBalance: 86715,
    endBalance: 71358,
    totalIn: 162740,
    totalOut: 178097,
  };
  assert.deepEqual(result.statement, expected);
  assert.deepEqual(result.monthStatements, [{ month: '2026-10', ...expected }]);
  const sumIn = result.rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  const sumOut = result.rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0);
  assert.equal(sumIn, 162740);
  assert.equal(sumOut, 178097);
  assert.equal(expected.startBalance + sumIn - sumOut, expected.endBalance);
});

test('English header + values: same rows, Dutch types (from the code) and Dutch labels in the description', () => {
  const english = SEMICOLON
    .replace(HEADER, '"Date";"Name / Description";"Account";"Counterparty";"Code";"Debit/credit";"Amount (EUR)";"Transaction type";"Notifications";"Resulting balance";"Tag"')
    .replace(/"Af"/g, '"Debit"')
    .replace(/"Bij"/g, '"Credit"')
    .replace(/"Online bankieren"/g, '"Online Banking"')
    .replace(/"Incasso"/g, '"SEPA direct debit"')
    .replace(/"Betaalautomaat"/g, '"Payment terminal"')
    .replace(/"Geldautomaat"/g, '"Cash machine"')
    .replace(/"Overschrijving"/g, '"Transfer"')
    .replace(/"Diversen"/g, '"Various"')
    .replace(/Naam: /g, 'Name: ')
    .replace(/Omschrijving: /g, 'Description: ')
    .replace(/Kenmerk: /g, 'Reference: ')
    .replace(/Machtiging ID: /g, 'Mandate ID: ')
    .replace(/Incassant ID: /g, 'Creditor ID: ')
    .replace(/Doorlopende incasso/g, 'Recurrent SEPA direct debit')
    .replace(/Pasvolgnr: /g, 'Card sequence no.: ')
    .replace(/Datum\/Tijd: /g, 'Date/time: ')
    .replace(/Transactie: /g, 'Transaction: ')
    .replace(/Valutadatum: (\d\d)-(\d\d)-(\d{4})/g, 'Value date: $1/$2/$3');
  assert.notEqual(english, SEMICOLON);
  const dutch = parse(SEMICOLON);
  const result = parse(english);
  assert.equal(result.english, true);
  assert.deepEqual(result.check, dutch.check);
  assert.deepEqual(result.statement, dutch.statement);
  assert.deepEqual(result.rows.map((r) => r.type), dutch.rows.map((r) => r.type));
  assert.deepEqual(result.rows.map((r) => r.amount), dutch.rows.map((r) => r.amount));
  const energy = result.rows.find((r) => r.rawName === 'Energiebedrijf Test BV');
  assert.match(energy.rawDescription, /^Naam: Energiebedrijf Test BV Omschrijving: Termijnbedrag/);
  assert.match(energy.rawDescription, /Kenmerk: .* Machtiging ID: .* Incassant ID: .* Doorlopende incasso Valutadatum: 18\/10\/2026$/);
  assert.match(result.rows[0].rawDescription, /^Pasvolgnr: 003 .* Transactie: E00090 Term: YY000001 Valutadatum: /);
});

test('Windows-1252 text (decoded by the caller) with accents and €', () => {
  const text = `${HEADER}\n${csvRow(['20261003', 'Café Test', '', 'BA', 'Af', '4,50', 'Betaalautomaat', 'Pasvolgnr: 003', '10,00'])}\n`
    + `${csvRow(['20261002', 'Crèche Zonnetje', 'NL00TEST0000000009', 'IC', 'Af', '120,00', 'Incasso', 'Omschrijving: Opvang € oktober', '14,50'])}`;
  const bytes = Uint8Array.from(text, (ch) => (ch === '€' ? 0x80 : ch.charCodeAt(0)));
  assert.ok(bytes.every((b) => b < 256));
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'not valid UTF-8');
  const result = parse(new TextDecoder('windows-1252').decode(bytes));
  assert.deepEqual(result.rows.map((r) => r.rawName), ['Café Test', 'Crèche Zonnetje']);
  assert.equal(result.rows[1].rawDescription, 'Omschrijving: Opvang € oktober');
  assert.equal(result.check.ok, true);
  assert.equal(result.statement.startBalance, 13450);
});

test('BOM, CRLF/CR line endings, blank lines, "" escapes and newlines inside quotes', () => {
  const rows = [
    csvRow(['20261003', 'Test "Quote" BV', '', 'GT', 'Af', '1.024,45', 'Online bankieren', 'Omschrijving: regel een\nregel twee', '-24,45']),
    csvRow(['20261002', 'Test BV', '', 'GT', 'Bij', '1000,00', 'Online bankieren', '', '1000,00']),
  ];
  const text = `﻿${HEADER}\r\n${rows[0]}\r\n\r\n${rows[1]}\r`;
  const result = parse(text);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].rawName, 'Test "Quote" BV');
  assert.equal(result.rows[0].amount, -102445, 'thousands dot is accepted');
  assert.equal(result.rows[0].rawDescription, 'Omschrijving: regel een\nregel twee');
  assert.equal(result.check.ok, true);
  assert.equal(result.statement.startBalance, 0);
});

test('dates yyyymmdd, dd-mm-yyyy and yyyy-mm-dd; unreadable rows are skipped with a warning', () => {
  const text = [
    HEADER,
    csvRow(['2026-10-05', 'A', '', 'GT', 'Af', '1,00', 'Online bankieren', '', '7,00']),
    csvRow(['04-10-2026', 'B', '', 'GT', 'Af', '1,00', 'Online bankieren', '', '8,00']),
    csvRow(['20261003', 'C', '', 'GT', 'Af', '1,00', 'Online bankieren', '', '9,00']),
    csvRow(['20261332', 'D', '', 'GT', 'Af', '1,00', 'Online bankieren', '', '10,00']),
    csvRow(['20261001', 'E', '', 'GT', 'Opgenomen', '1,00', 'Online bankieren', '', '10,00']),
  ].join('\n');
  const result = parse(text);
  assert.deepEqual(result.rows.map((r) => r.date), ['2026-10-05', '2026-10-04', '2026-10-03']);
  assert.deepEqual(result.warnings, ["I couldn't read row 5, so it was skipped.", "I couldn't read row 6, so it was skipped."]);
  assert.equal(result.check.ok, false, 'skipped rows: the check can not be ok');
});

test('an oldest-first file is turned around; a broken balance chain is reported', () => {
  const lines = SEMICOLON.split('\n');
  const reversed = parse([lines[0], ...lines.slice(1).reverse()].join('\n'));
  assert.deepEqual(reversed.rows, parse(SEMICOLON).rows);
  assert.equal(reversed.check.ok, true);

  const missing = parse(lines.filter((l) => !l.includes('"Kosten ING Go"')).join('\n'));
  assert.equal(missing.rows.length, 11);
  assert.equal(missing.check.ok, false);
  assert.equal(missing.warnings.length, 1);
  assert.match(missing.warnings[0], /don't add up \(at 3 Oct 2026\)/);
});

test('rows over several months give one statement per month', () => {
  const text = [
    HEADER,
    csvRow(['20261102', 'Huisbaas BV', 'NL00TEST0123456789', 'OV', 'Af', '500,00', 'Overschrijving', '', '400,00']),
    csvRow(['20261101', 'Werkgever Voorbeeld BV', '', 'OV', 'Bij', '800,00', 'Overschrijving', '', '900,00']),
    csvRow(['20261031', 'SUPERMARKT 1234 TESTDORP', '', 'BA', 'Af', '50,00', 'Betaalautomaat', '', '100,00']),
    csvRow(['20261030', 'Webwinkel Test', '', 'ID', 'Af', '25,00', 'iDEAL', '', '150,00']),
  ].join('\n');
  const result = parse(text);
  assert.equal(result.check.ok, true);
  assert.deepEqual(result.monthStatements, [
    { month: '2026-10', periodFrom: '2026-10-30', periodTo: '2026-10-31', startBalance: 17500, endBalance: 10000, totalIn: 0, totalOut: 7500 },
    { month: '2026-11', periodFrom: '2026-11-01', periodTo: '2026-11-02', startBalance: 10000, endBalance: 40000, totalIn: 80000, totalOut: 50000 },
  ]);
  assert.deepEqual(result.statement, { periodFrom: '2026-10-30', periodTo: '2026-11-02', startBalance: 17500, endBalance: 40000, totalIn: 80000, totalOut: 57500 });
});

test('unknown codes and types never fail; an empty type falls back to the code', () => {
  const text = [
    HEADER,
    csvRow(['20261002', 'Test BV', '', 'ZZ', 'Af', '1,00', 'Nieuwe soort', '', '1,00']),
    csvRow(['20261001', 'Test BV', '', 'WERO', 'Af', '1,00', '', '', '2,00']),
  ].join('\n');
  assert.deepEqual(parse(text).rows.map((r) => r.type), ['Nieuwe soort', 'Wero']);
});

test('the holder fixture CSV (ing-fake-holder.csv, April 2027) parses with an unbroken balance chain', () => {
  const result = parse(read('test/fixtures/ing-fake-holder.csv'));
  assert.equal(result.rows.length, 7);
  assert.deepEqual(result.check, { kind: 'saldo', ok: true });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.statement.periodFrom, '2027-04-02');
  assert.equal(result.statement.startBalance, 299185, 'continues from the end balance of ing-fake-holder.pdf');
  assert.deepEqual(result.rows.map((r) => r.rawName), ['Tom Tester', 'Werkgever Voorbeeld BV', 'Belastingdienst',
    'Energiebedrijf Test BV', 'HR T TESTER', 'Gemeente Voorbeeldstad', 'Huisbaas BV']);
});

test('not an ING payment-account CSV -> ImportError with a friendly message', () => {
  assert.throws(() => importCsv.parse('naam,bedrag\nJ. Jansen,12'), isError(READ_ERROR));
  assert.throws(() => importCsv.parse(''), isError(READ_ERROR));
  assert.throws(() => importCsv.parse('%PDF-1.7 binary \u0000\u0001 garbage "'), isError(READ_ERROR));
  assert.throws(() => importCsv.parse(`${HEADER}\n"20261001";"unterminated`), isError(READ_ERROR));
  assert.throws(() => importCsv.parse(HEADER), isError('There are no payments in this file.'));
  assert.throws(
    () => importCsv.parse('"Datum","Omschrijving","Rekening","Rekening naam","Tegenrekening","Af Bij","Bedrag","Valuta","Mutatiesoort","Mededelingen","Saldo na mutatie"\n'),
    (err) => err.name === 'ImportError' && err.message.startsWith('This looks like a download of a savings account'),
  );
  const mostlyBad = [HEADER, csvRow(['20261001', 'A', '', 'GT', 'Af', '1,00', 'x', '', '1,00']), '"x";"y"', '"a";"b"'].join('\n');
  assert.throws(() => importCsv.parse(mostlyBad), isError(READ_ERROR));
});
