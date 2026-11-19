// Repo safety scan: no private paths, e-mail addresses, keys/tokens, real-looking IP addresses or leftover
// work-process notes in any file that would be published. General patterns only; some words are put together at
// run time so this file does not trip its own scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, files, git } from '../lib/repo-files.mjs';

// Unchanged third-party code (its sha256 is checked by the build): scanned for paths and keys only (minified code
// is full of things that look like e-mail or IP addresses).
const VENDOR = new Set(['vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs']);

const w = (...parts) => parts.join('');
const BS = '\\\\{1,2}'; // one backslash, or two inside a JS/JSON string

const SECRET_RULES = [
  ['Windows user folder', new RegExp(`[A-Za-z]:(?:${BS}|/)+Users(?:${BS}|/)`, 'i')],
  ['absolute Windows path', new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:${BS}(?!Program Files|Windows${BS}|Users)[A-Za-z0-9_.$%-]`)],
  ['API key or token', /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
];

const MAIL_RULES = [
  ['e-mail address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, (m) => !/noreply|@example\.(com|org|net)$/i.test(m)],
];

const OK_IPS = [/^127\.0\.0\.1$/, /^0\.0\.0\.0$/, /^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./];
const NOTE_RULES = [
  ['IPv4 address', /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g,
    (m) => m.split('.').every((n) => Number(n) <= 255) && !OK_IPS.some((re) => re.test(m))],
  ['work-process file name', new RegExp(`\\b(?:${w('PL', 'AN')}\\d*|${w('HAND', 'OFF')}|${w('ACTIVE', '_JOB')}|${w('LES', 'SONS')}|${w('BU', 'GS')})\\.md\\b`)],
  ['work-process word', new RegExp(`\\b${w('re', 'con')}\\b`, 'i')],
  ['work-process word', new RegExp(`\\b${w('SP', 'EC')}\\b`)],
  ['work-process round', new RegExp(`\\b(?:fix\\s+)?${w('rou', 'nd')}\\s+\\d+\\b|\\bfix\\s+${w('rou', 'nd')}\\b`, 'i')],
  ['work-process part', new RegExp(`\\b${w('pa', 'rt')} [A-Z]\\b`)],
  ['bug or work-item id', new RegExp(`\\b[${w('B', 'U', 'C', 'D', 'R')}]\\d{1,3}\\b`)],
  ['dated note', new RegExp(`\\b${w('us', 'er')},\\s*20\\d\\d-\\d\\d-\\d\\d`)],
  ['work-process id as a temp folder', /\.tmp[\\/]+[a-z]\d{1,2}\b/],
];

function findings(name, text, rules) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    for (const [what, re, keep] of rules) {
      const hits = re.global ? [...line.matchAll(re)].map((m) => m[0]) : [(re.exec(line) || [])[0]].filter(Boolean);
      for (const hit of hits) if (!keep || keep(hit)) out.push(`${name}:${i + 1} ${what}: ${hit.slice(0, 60)}`);
    }
  });
  return out;
}

test('privacy: no private paths, e-mails, keys, IPs or work-process notes in the repo', (t) => {
  const all = files();
  if (!all) return t.skip('git is not installed');
  assert.ok(all.includes('package.json'), 'scan starts at the repo root');
  const problems = [];
  for (const name of all) {
    const text = readFileSync(join(ROOT, name), 'latin1');
    problems.push(...findings(name, text, SECRET_RULES));
    if (VENDOR.has(name)) continue;
    problems.push(...findings(name, text, MAIL_RULES));
    // Binary files (the PDF fixtures): random bytes look like ids and version numbers, so only the rules above.
    if (!text.includes('\0')) problems.push(...findings(name, text, NOTE_RULES));
  }
  assert.equal(problems.length, 0, `\n${problems.join('\n')}`);
});

test('privacy: the scan rules catch what they should', () => {
  const sample = [
    w('D:', '\\', 'stuff\\a.txt'),
    w('C:', '\\\\', 'Users\\\\someone'),
    w('someone', '@', 'mail.com'),
    w('10.1', '.2.3'),
    w('see ', 'PL', 'AN.md'),
    w('fix ', 'rou', 'nd 2'),
    w('B', '12'),
    w('sk-', 'abcdefghijklmnopqrstuvwxyz'),
    w('(D', '5)'),
    w('.tmp/', 'b2/x.html'),
  ].join('\n');
  const rules = [...SECRET_RULES, ...MAIL_RULES, ...NOTE_RULES];
  const hits = findings('x', sample, rules);
  for (let line = 1; line <= 10; line++) assert.ok(hits.some((h) => h.startsWith(`x:${line} `)), `line ${line} is caught`);
  const fine = ['noreply@example.com', '127.0.0.1', 'C:\\Program Files\\Microsoft', 'reconcile', 'roundDown(2)', '1.234,56',
    '.tmp/e2e-edge/x.html'].join('\n');
  assert.deepEqual(findings('y', fine, rules), []);
});

test('privacy: .gitignore keeps bank files and backups out of git under any name', (t) => {
  const real = ['NL00INGB0000000000_01-01-2026_31-01-2026.csv', 'Afschrift-januari.pdf', 'my-backup.json',
    'budget-backup-2026-01-01.json', 'sub/folder/export.csv', 'seed/mine.json', 'private/notes.txt'];
  const shipped = ['package.json', 'seed/demo-seed.json', 'test/fixtures/ing-fake-1.pdf',
    'test/fixtures/ing-fake-semicolon.csv', 'test/fixtures/ing-fake-1.expected.json'];
  const r = git(['check-ignore', '--no-index', '--stdin'], [...real, ...shipped].join('\n') + '\n');
  if (!r) return t.skip('git is not installed');
  assert.deepEqual(r.stdout.split(/\r?\n/).filter(Boolean).sort(), [...real].sort());
});

test('privacy: the scan only reads files git would publish', (t) => {
  // A made-up backup with the name the app gives backups, which .gitignore keeps out of git.
  const name = `budget-backup-scan-check-${process.pid}.json`;
  writeFileSync(join(ROOT, name), w('{"note": "someone', '@', 'mail.com"}'));
  t.after(() => rmSync(join(ROOT, name), { force: true }));
  const all = files();
  if (!all) return t.skip('git is not installed');
  assert.ok(all.includes('README.md') && all.includes('test/fixtures/ing-fake-1.pdf'));
  assert.ok(!all.includes(name), 'ignored files are not read');
  assert.ok(!all.some((n) => n.startsWith('.tmp/') || n.startsWith('dist/')), 'build output and scratch files are not read');
});
