// The screens are in English: money as "€1,234.56", English month and day names, the PC's own time zone, and
// month labels that do not depend on how a date is written. Loads the real scripts in a vm context (no DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

function load(files) {
  const context = vm.createContext({ TextEncoder });
  for (const f of files) vm.runInContext(read(`src/js/${f}`), context, { filename: f });
  return context.Budget;
}

const { util } = load(['util.js']);
const MINUS = '−';
const WJ = '⁠'; // word joiner after a sign

test('formatEuro: "€1,234.56" with a comma for thousands and a point for cents', () => {
  assert.equal(util.formatEuro(123456), '€1,234.56');
  assert.equal(util.formatEuro(0), '€0.00');
  assert.equal(util.formatEuro(-1250), `${MINUS}${WJ}€12.50`);
  assert.equal(util.formatEuro(120000, { sign: true }), `+${WJ}€1,200.00`);
  assert.equal(util.formatEuro(34512, { whole: true }), '€345');
  assert.equal(util.formatEuro(123456789), '€1,234,567.89');
});

test('parseEuro still reads both ways of writing an amount', () => {
  assert.equal(util.parseEuro('1,234.56'), 123456);
  assert.equal(util.parseEuro('1.234,56'), 123456);
  assert.equal(util.parseEuro('12.50'), 1250);
  assert.equal(util.parseEuro('12,50'), 1250);
  assert.equal(util.parseEuro(util.formatEuro(-98765)), -98765);
});

test('dates and months use English names', () => {
  assert.equal(util.monthLabel('2026-09'), 'September 2026');
  assert.equal(util.shortDate('2026-09-29'), '29 Sep');
  assert.equal(util.longDate('2026-10-01'), 'Thursday 1 October 2026');
  assert.equal(util.shortMonthName('2026-03'), 'Mar');
  assert.equal(util.shortMonthName('nonsense'), '');
});

test('todayIso uses the PC\'s own date (no fixed time zone)', () => {
  const now = new Date(2026, 0, 31, 23, 59); // local time, just before midnight
  assert.equal(util.todayIso(now), '2026-01-31');
  assert.doesNotMatch(read('src/js/util.js'), /timeZone\s*:/);
});

test('the page says lang="en" and nothing pins a Dutch locale for sorting', () => {
  assert.match(read('src/index.html'), /<html lang="en">/);
  for (const f of ['calc.js', 'ui-month.js']) assert.doesNotMatch(read(`src/js/${f}`), /localeCompare\([^)]*'nl'\)/, f);
});

test('chart month labels come from the month itself, not from how shortDate writes a date', () => {
  const Budget = load(['util.js', 'calc.js', 'ui-kit.js', 'ui-extras.js']);
  Budget.util.shortDate = () => 'a-date-in-any-format'; // must not matter
  const { chartLayout, chartSvg } = Budget.uiExtras.pure;
  const series = [{ month: '2026-09', income: 100000, spend: 50000, left: 50000, stack: [], booked: true }];
  const svg = chartSvg(chartLayout(series, { width: 500 }), series);
  assert.match(svg, />Sep</);
  assert.match(svg, /September 2026: in €1,000.00, out €500.00, left €500.00\./);
});
