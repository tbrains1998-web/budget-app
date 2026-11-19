// Generates seed/demo-seed.json: a FAKE backup with three months, April-June 2026.
// Every name, amount and balance is invented. Deterministic: same output on every run.
//   node seed/make-demo-seed.mjs
// What it shows off: salary + a benefit + an allowance; in June the benefit pays a one-time "nabetaling" on top
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
  salaris: { name: 'Werkgever Voorbeeld BV', type: 'Overschrijving', cat: 'inkomen', iban: true },
  uitkering: { name: 'Uitkering', raw: 'Uitkeringsinstantie Test', type: 'Overschrijving', cat: 'inkomen', iban: true }, // renamed by a user rule
  toeslag: { name: 'Belastingdienst', type: 'Verzamelbetaling', cat: 'inkomen', iban: true },
  huur: { name: 'Huisbaas BV', type: 'Overschrijving', cat: 'huur', iban: true },
  zorg: { name: 'Zorgverzekeraar Test NV', type: 'Incasso', cat: 'zorg', iban: true },
  verzekering: { name: 'Verzekeraar Test NV', type: 'Incasso', cat: 'zorg', iban: true },
  telecom: { name: 'Telecom Test BV', type: 'Incasso', cat: 'vast', iban: true },
  energie: { name: 'Energiebedrijf Test BV', type: 'Incasso', cat: 'vast', iban: true },
  water: { name: 'Waterbedrijf Test', type: 'Incasso', cat: 'vast', iban: true },
  bank: { name: 'Kosten ING Go', type: 'Diversen', cat: 'vast', iban: false },
  supermarkt: { name: 'SUPERMARKT 1234 TESTDORP', type: 'Betaalautomaat', cat: 'dagelijks', iban: false },
  drogist: { name: 'DROGIST TEST 0042 TESTDORP', type: 'Betaalautomaat', cat: 'dagelijks', iban: false },
  bakker: { name: 'Bakkerij Test', type: 'Betaalautomaat', cat: 'dagelijks', iban: false },
  tuin: { name: 'Tuincentrum Test', type: 'Betaalautomaat', cat: 'dagelijks', iban: false },
  pinnen: { name: 'Geldautomaat TESTDORP', type: 'Geldautomaat', cat: 'dagelijks', iban: false },
  garage: { name: 'Garage Test BV', type: 'Online bankieren', cat: 'eenmalig', iban: true },
  webwinkel: { name: 'Webwinkel Test', type: 'iDEAL', cat: 'eenmalig', iban: true },
  naarSparen: { name: 'Naar Oranje spaarrekening X…', raw: 'Naar Oranje spaarrekening X00000001', type: 'Online bankieren', cat: 'sparen', iban: false },
  vanSparen: { name: 'Van Oranje spaarrekening X…', raw: 'Van Oranje spaarrekening X00000001', type: 'Online bankieren', cat: 'sparen', iban: false },
  onbekend: { name: 'A. de Vries', type: 'Online bankieren', cat: 'onbekend', iban: true },
};

// [date, payee, cents, description, month it counts for (default: the date's month)]
const MONTHLY = (m, label) => [
  [`${m}-02`, 'zorg', -14235, `Premie ${label} 2026`],
  [`${m}-02`, 'bank', -295, 'Kosten betaalrekening vorige maand'],
  [`${m}-05`, 'verzekering', -1890, 'Inboedel- en aansprakelijkheidsverzekering'],
  [`${m}-12`, 'telecom', -3250, `Abonnement ${label}`],
  [`${m}-18`, 'energie', -11800, `Termijnbedrag energie ${label} 2026`],
  [`${m}-20`, 'water', -2180, `Waterrekening ${label}`],
  [`${m}-20`, 'toeslag', 9700, `Toeslag ${label} 2026`],
  [`${m}-22`, 'uitkering', 61250, `Uitkering ${label} 2026`],
  [`${m}-24`, 'salaris', 108460, `Salaris ${label} 2026`],
  [`${m}-25`, 'naarSparen', -15000, `Sparen ${label}`],
];
const ROWS = [
  ...MONTHLY('2026-04', 'april'),
  ['2026-04-01', 'huur', -86500, 'Huur april 2026'],
  ['2026-04-03', 'supermarkt', -6245, 'Boodschappen'],
  ['2026-04-08', 'drogist', -1390, ''],
  ['2026-04-09', 'garage', -24500, 'Factuur APK en onderhoud'],
  ['2026-04-10', 'pinnen', -5000, ''],
  ['2026-04-14', 'supermarkt', -5810, 'Boodschappen'],
  ['2026-04-17', 'bakker', -635, ''],
  ['2026-04-21', 'supermarkt', -4975, 'Boodschappen'],
  ['2026-04-28', 'supermarkt', -4145, 'Boodschappen'],

  ...MONTHLY('2026-05', 'mei'),
  ['2026-05-01', 'huur', -86500, 'Huur mei 2026'],
  ['2026-05-02', 'supermarkt', -5530, 'Boodschappen'],
  ['2026-05-06', 'bakker', -790, ''],
  ['2026-05-09', 'supermarkt', -6120, 'Boodschappen'],
  ['2026-05-11', 'webwinkel', -5999, 'Bestelling Webwinkel Test'],
  ['2026-05-13', 'drogist', -2245, ''],
  ['2026-05-16', 'pinnen', -5000, ''],
  ['2026-05-20', 'supermarkt', -5385, 'Boodschappen'],
  ['2026-05-26', 'vanSparen', 10000, 'Terug van sparen voor de huur'],
  ['2026-05-27', 'supermarkt', -5030, 'Boodschappen'],
  ['2026-05-29', 'huur', -86500, 'Huur juni 2026 (vroeg betaald)', '2026-06'],

  ...MONTHLY('2026-06', 'juni'),
  ['2026-06-01', 'supermarkt', -6890, 'Boodschappen'],
  ['2026-06-05', 'bakker', -845, ''],
  ['2026-06-06', 'pinnen', -5000, ''],
  ['2026-06-09', 'supermarkt', -7215, 'Boodschappen'],
  ['2026-06-12', 'uitkering', 24500, 'Nabetaling mei 2026 (eenmalig)'],
  ['2026-06-13', 'drogist', -3160, ''],
  ['2026-06-16', 'supermarkt', -6540, 'Boodschappen'],
  ['2026-06-17', 'webwinkel', -2499, 'Bestelling Webwinkel Test'],
  ['2026-06-19', 'tuin', -2950, 'Plantjes'],
  ['2026-06-21', 'onbekend', -850, 'Betaalverzoek lunch'],
  ['2026-06-23', 'supermarkt', -5370, 'Boodschappen'],
  ['2026-06-29', 'supermarkt', -1630, 'Boodschappen'],
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
    { id: 'r_demo1', match: { nameContains: 'huisbaas' }, set: { categoryId: 'huur', kind: 'elke-maand' },
      createdAt: '2026-05-02T18:34:00.000Z' },
    { id: 'r_demo2', match: { nameContains: 'uitkeringsinstantie', sign: 'in' },
      set: { categoryId: 'inkomen', kind: 'elke-maand', rename: 'Uitkering' }, createdAt: '2026-05-02T18:36:00.000Z' },
  ],
  normalAmounts: { [`in:${payeeOf(P.uitkering)}`]: 61250 }, // '<side>:<payeeId>' -> positive cents
  settings: { savingsGoal: 25000, hiddenWords: [], lastBackupAt: EXPORTED_AT, lastImportAt: IMPORTED_AT['2026-06'],
    privacySalt: null, privateTokenHashes: [] },
};

await writeFile(OUT, JSON.stringify({ app: 'budget-nl', version: 1, exportedAt: EXPORTED_AT, state }, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ out: OUT, transactions: transactions.length,
  statements: statements.map((s) => `${s.month}: ${s.startBalance} -> ${s.endBalance}`) }));
