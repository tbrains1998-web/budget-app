// Generates seed/demo-seed.json: a FAKE backup with three months, April-June 2026.
// Every name, amount and balance is invented. Deterministic: same output on every run.
//   node seed/make-demo-seed.mjs
// What it shows off: salary + a benefit + an allowance; in June the benefit pays a one-time back payment on top
// (normalAmounts keeps the normal month at the usual amount); June's rent is paid early, on 29 May (moved to June);
// savings moves that don't count; one payment still to categorize; two user rules; a savings goal; daily spending
// in June more than 25 % above the earlier months ("Higher than normal"). Statements reconcile to the cent.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'demo-seed.json');
const START_BALANCE = 141235;

const CATEGORIES = [
  { id: 'inkomen', name: 'Income', kind: 'income', color: '#15803d', colorDark: '#4ade80' },
  { id: 'huur', name: 'Rent', kind: 'fixed', color: '#7c3aed', colorDark: '#a78bfa' },
  { id: 'zorg', name: 'Health & insurance', kind: 'fixed', color: '#0e7490', colorDark: '#22d3ee' },
  { id: 'vast', name: 'Fixed costs & subscriptions', kind: 'fixed', color: '#2563eb', colorDark: '#60a5fa' },
  { id: 'dagelijks', name: 'Daily spending', kind: 'daily', color: '#ea580c', colorDark: '#fb923c' },
  { id: 'eenmalig', name: 'One-off', kind: 'oneoff', color: '#db2777', colorDark: '#f472b6' },
  { id: 'sparen', name: 'Savings & own accounts', kind: 'transfer', color: '#98a2b3', colorDark: '#6b7585' },
  { id: 'onbekend', name: 'Not sorted yet (?)', kind: 'unknown', color: '#9ca3af', colorDark: '#6b7280' },
];
const DEFAULT_KIND = { inkomen: 'elke-maand', huur: 'elke-maand', zorg: 'elke-maand', vast: 'elke-maand',
  dagelijks: 'wisselend', eenmalig: 'eenmalig', sparen: 'telt-niet-mee', onbekend: 'wisselend' };

// Payees: display name, bank type, category, and whether the counterparty has an IBAN (bank code TEST); raw = the
// bank's own (fake) name when the display name differs from it (rename rule, masked account number). The payee id
// is made from that raw name, like the importer does.
const P = {
  salaris: { name: 'Example Employer Ltd', type: 'Overschrijving', cat: 'inkomen', iban: true },
  uitkering: { name: 'Benefits', raw: 'Benefits Agency Test', type: 'Overschrijving', cat: 'inkomen', iban: true }, // renamed by a user rule
  toeslag: { name: 'Tax office', type: 'Verzamelbetaling', cat: 'inkomen', iban: true },
  huur: { name: 'Landlord Ltd', type: 'Overschrijving', cat: 'huur', iban: true },
  zorg: { name: 'Test Health Insurance', type: 'Incasso', cat: 'zorg', iban: true },
  verzekering: { name: 'Test Insurance Co', type: 'Incasso', cat: 'zorg', iban: true },
  telecom: { name: 'Test Telecom Ltd', type: 'Incasso', cat: 'vast', iban: true },
  energie: { name: 'Test Energy Ltd', type: 'Incasso', cat: 'vast', iban: true },
  water: { name: 'Test Water Company', type: 'Incasso', cat: 'vast', iban: true },
  bank: { name: 'Bank account fees', type: 'Diversen', cat: 'vast', iban: false },
  supermarkt: { name: 'SUPERMARKET 1234 TESTVILLE', type: 'Betaalautomaat', cat: 'dagelijks', iban: false },
  drogist: { name: 'DRUGSTORE TEST 0042 TESTVILLE', type: 'Betaalautomaat', cat: 'dagelijks', iban: false },
  bakker: { name: 'Test Bakery', type: 'Betaalautomaat', cat: 'dagelijks', iban: false },
  tuin: { name: 'Test Garden Centre', type: 'Betaalautomaat', cat: 'dagelijks', iban: false },
  pinnen: { name: 'Cash machine TESTVILLE', type: 'Geldautomaat', cat: 'dagelijks', iban: false },
  garage: { name: 'Test Garage Ltd', type: 'Online bankieren', cat: 'eenmalig', iban: true },
  webwinkel: { name: 'Test Web Shop', type: 'iDEAL', cat: 'eenmalig', iban: true },
  naarSparen: { name: 'To savings account X…', raw: 'To savings account X00000001', type: 'Online bankieren', cat: 'sparen', iban: false },
  vanSparen: { name: 'From savings account X…', raw: 'From savings account X00000001', type: 'Online bankieren', cat: 'sparen', iban: false },
  onbekend: { name: 'A. Example', type: 'Online bankieren', cat: 'onbekend', iban: true },
};

// [date, payee, cents, description, month it counts for (default: the date's month)]
const MONTHLY = (m, label) => [
  [`${m}-02`, 'zorg', -14235, `Premium ${label} 2026`],
  [`${m}-02`, 'bank', -295, 'Account fees last month'],
  [`${m}-05`, 'verzekering', -1890, 'Home contents and liability insurance'],
  [`${m}-12`, 'telecom', -3250, `Subscription ${label}`],
  [`${m}-18`, 'energie', -11800, `Energy instalment ${label} 2026`],
  [`${m}-20`, 'water', -2180, `Water bill ${label}`],
  [`${m}-20`, 'toeslag', 9700, `Allowance ${label} 2026`],
  [`${m}-22`, 'uitkering', 61250, `Benefits ${label} 2026`],
  [`${m}-24`, 'salaris', 108460, `Salary ${label} 2026`],
  [`${m}-25`, 'naarSparen', -15000, `Savings ${label}`],
];
const ROWS = [
  ...MONTHLY('2026-04', 'April'),
  ['2026-04-01', 'huur', -86500, 'Rent April 2026'],
  ['2026-04-03', 'supermarkt', -6245, 'Groceries'],
  ['2026-04-08', 'drogist', -1390, ''],
  ['2026-04-09', 'garage', -24500, 'Invoice car inspection and service'],
  ['2026-04-10', 'pinnen', -5000, ''],
  ['2026-04-14', 'supermarkt', -5810, 'Groceries'],
  ['2026-04-17', 'bakker', -635, ''],
  ['2026-04-21', 'supermarkt', -4975, 'Groceries'],
  ['2026-04-28', 'supermarkt', -4145, 'Groceries'],

  ...MONTHLY('2026-05', 'May'),
  ['2026-05-01', 'huur', -86500, 'Rent May 2026'],
  ['2026-05-02', 'supermarkt', -5530, 'Groceries'],
  ['2026-05-06', 'bakker', -790, ''],
  ['2026-05-09', 'supermarkt', -6120, 'Groceries'],
  ['2026-05-11', 'webwinkel', -5999, 'Order Test Web Shop'],
  ['2026-05-13', 'drogist', -2245, ''],
  ['2026-05-16', 'pinnen', -5000, ''],
  ['2026-05-20', 'supermarkt', -5385, 'Groceries'],
  ['2026-05-26', 'vanSparen', 10000, 'Back from savings for the rent'],
  ['2026-05-27', 'supermarkt', -5030, 'Groceries'],
  ['2026-05-29', 'huur', -86500, 'Rent June 2026 (paid early)', '2026-06'],

  ...MONTHLY('2026-06', 'June'),
  ['2026-06-01', 'supermarkt', -6890, 'Groceries'],
  ['2026-06-05', 'bakker', -845, ''],
  ['2026-06-06', 'pinnen', -5000, ''],
  ['2026-06-09', 'supermarkt', -7215, 'Groceries'],
  ['2026-06-12', 'uitkering', 24500, 'Back payment May 2026 (one-time)'],
  ['2026-06-13', 'drogist', -3160, ''],
  ['2026-06-16', 'supermarkt', -6540, 'Groceries'],
  ['2026-06-17', 'webwinkel', -2499, 'Order Test Web Shop'],
  ['2026-06-19', 'tuin', -2950, 'Plants'],
  ['2026-06-21', 'onbekend', -850, 'Payment request lunch'],
  ['2026-06-23', 'supermarkt', -5370, 'Groceries'],
  ['2026-06-29', 'supermarkt', -1630, 'Groceries'],
];
const MONTHS = ['2026-04', '2026-05', '2026-06'];
const IMPORTED_AT = { '2026-04': '2026-05-02T18:30:00.000Z', '2026-05': '2026-06-01T19:05:00.000Z', '2026-06': '2026-07-01T17:45:00.000Z' };
const EXPORTED_AT = '2026-07-01T17:50:00.000Z';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const lastDay = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

// The app's own payee id: 'p_' + FNV-1a 64 of the lowercased, trimmed bank name (src/js/util.js payeeId).
function payeeId(name) {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(name.trim().toLowerCase())) h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return `p_${h.toString(16).padStart(16, '0')}`;
}
const payeeOf = (payee) => payeeId(payee.raw || payee.name);

const transactions = ROWS
  .map(([date, key, amount, description, month]) => ({ date, payee: P[key], amount, description, month: month || date.slice(0, 7) }))
  .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
  .map((r, i) => ({
    id: `t_demo${String(i + 1).padStart(3, '0')}`,
    payeeId: payeeOf(r.payee),
    date: r.date,
    month: r.month,
    name: r.payee.name,
    description: r.description,
    amount: r.amount,
    categoryId: r.payee.cat,
    kind: DEFAULT_KIND[r.payee.cat],
    type: r.payee.type,
    bankCode: r.payee.iban ? 'TEST' : '',
    source: 'seed',
    fingerprint: `fp_${sha256(`${r.date}|${r.amount}|${r.payee.name}|${r.description}|${r.payee.type}`)}`,
  }));

let balance = START_BALANCE;
const statements = MONTHS.map((month) => {
  const booked = transactions.filter((t) => t.date.startsWith(month));
  const totalIn = booked.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const totalOut = booked.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0); // positive, as printed
  const startBalance = balance;
  balance += totalIn - totalOut;
  return { month, periodFrom: `${month}-01`, periodTo: `${month}-${lastDay(month)}`, startBalance, endBalance: balance,
    totalIn, totalOut, source: 'pdf', importedAt: IMPORTED_AT[month] };
}).reverse();

const state = {
  version: 1,
  categories: CATEGORIES,
  transactions,
  statements,
  rules: [ // in the order they were made (oldest first)
    { id: 'r_demo1', match: { nameContains: 'landlord' }, set: { categoryId: 'huur', kind: 'elke-maand' },
      createdAt: '2026-05-02T18:34:00.000Z' },
    { id: 'r_demo2', match: { nameContains: 'benefits agency', sign: 'in' },
      set: { categoryId: 'inkomen', kind: 'elke-maand', rename: 'Benefits' }, createdAt: '2026-05-02T18:36:00.000Z' },
  ],
  normalAmounts: { [`in:${payeeOf(P.uitkering)}`]: 61250 }, // '<side>:<payeeId>' -> positive cents
  settings: { savingsGoal: 25000, hiddenWords: [], lastBackupAt: EXPORTED_AT, lastImportAt: IMPORTED_AT['2026-06'],
    privacySalt: null, privateTokenHashes: [] },
};

await writeFile(OUT, JSON.stringify({ app: 'budget-nl', version: 1, exportedAt: EXPORTED_AT, state }, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ out: OUT, transactions: transactions.length,
  statements: statements.map((s) => `${s.month}: ${s.startBalance} -> ${s.endBalance}`) }));
