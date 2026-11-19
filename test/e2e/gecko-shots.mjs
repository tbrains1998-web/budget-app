// Screenshots for the UX review: LibreWolf (light: resistFingerprinting forces it) and Firefox (dark), 1100 and 400 px.
//
//   node test/e2e/gecko-shots.mjs [--only librewolf|firefox]
//
// Builds .tmp/e2e-gecko/shots-build/Budget.html (no seed) and Budget-demo.html (seed/demo-seed.json), drives the real UI and
// writes PNGs to .tmp/e2e-gecko/shots/<browser>-<scheme>-<width>-<nn>-<screen>.png. Fresh temp profile per width.
import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileUrl } from '../lib/bidi.mjs';
import { APP_ROOT, Ui, delay, expectSoon, launch, quit } from './gecko-lib.mjs';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const BUILD = '.tmp/e2e-gecko/shots-build';
const SHOTS = '.tmp/e2e-gecko/shots';
const RUNS = [
  { browser: 'librewolf', scheme: 'light', colorScheme: 'dark' }, // asks for dark like a user.js can; RFP gives light
  { browser: 'firefox', scheme: 'dark', colorScheme: 'dark' },
].filter((r) => !only || r.browser === only);
const WIDTHS = [[1100, 900], [400, 860]];
const written = [];
const problems = [];

function build(out, seed) {
  const argv = ['build/build.mjs', '--out', out, ...(seed ? ['--seed', seed] : [])];
  const r = spawnSync(process.execPath, argv, { cwd: APP_ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`build failed: ${r.stderr || r.stdout}`);
}

async function shot(b, run, w, name, { fullPage = false } = {}) {
  await delay(250);
  const file = `${SHOTS}/${run.browser}-${run.scheme}-${w}-${name}.png`;
  await b.screenshot(file, { fullPage });
  written.push(file);
}

async function pick(b, ui, finder, files) {
  const before = b.fileDialogs.length;
  await ui.click(finder);
  const end = Date.now() + 5000;
  while (b.fileDialogs.length === before && Date.now() < end) await delay(50);
  const ev = b.fileDialogs[b.fileDialogs.length - 1];
  if (b.fileDialogs.length === before) throw new Error('no file picker opened');
  await b.send('input.setFiles', { context: b.context, element: { sharedId: ev.element.sharedId }, files: files.map((f) => resolve(APP_ROOT, f)) });
}

async function demoRun(run, w, h) {
  const b = await launch({ browser: run.browser, profileDir: `.tmp/e2e-gecko/profiles/shots-${run.browser}-${w}`, wipe: true, colorScheme: run.colorScheme,
    width: w, height: h, prefs: { 'privacy.sanitize.sanitizeOnShutdown': false } });
  const ui = new Ui(b);
  try {
    await b.open(fileUrl(`${BUILD}/Budget-demo.html`));
    await expectSoon(b, () => window.Budget && document.querySelector('#view-month .tx'), 'demo month did not render');
    const env = await b.eval(() => ({ dark: matchMedia('(prefers-color-scheme: dark)').matches, label: document.getElementById('month-label').textContent }));
    if ((run.scheme === 'dark') !== env.dark) problems.push(`${run.browser} ${w}: expected ${run.scheme}, page reports dark=${env.dark}`);
    await shot(b, run, w, '01-month-top');
    await shot(b, run, w, '01-month-full', { fullPage: true });
    await ui.mark('.cards-2');
    await shot(b, run, w, '01b-month-cards');
    // Not sorted yet group (scrolled to the top of the viewport)
    await b.eval(() => {
      const g = document.querySelector('#view-month .group.unknown');
      if (g) g.scrollIntoView({ block: 'start' });
      return Boolean(g);
    });
    await shot(b, run, w, '02-not-sorted-yet');
    // category popover on the first unknown payment
    await ui.click(() => document.querySelector('#view-month .group.unknown .tx .pill'));
    await expectSoon(b, () => document.querySelector('#popover-root .popover'), 'popover did not open');
    await shot(b, run, w, '03-popover');
    await ui.click(() => [...document.querySelectorAll('#popover-root .choice')].find((c) => c.textContent.trim() === 'Daily spending'));
    await delay(200);
    await shot(b, run, w, '04-rule-question'); // asked inline under the moved row
    await ui.press('Escape');
    await b.eval(() => window.scrollTo(0, 0));
    // My normal month
    await ui.click(() => [...document.querySelectorAll('.save-card button')].find((x) => /Change normal month/.test(x.textContent)));
    await expectSoon(b, () => document.querySelector('#dialog-root .dialog'), 'normal month did not open');
    await shot(b, run, w, '05-normal-month');
    await ui.press('Escape');
    // Settings
    await ui.click('#btn-menu');
    await shot(b, run, w, '06a-menu');
    await ui.click(() => [...document.querySelectorAll('#menu-root button')].find((x) => x.textContent.trim() === 'Settings'));
    await expectSoon(b, () => document.querySelector('#dialog-root .dialog'), 'settings did not open');
    await shot(b, run, w, '06-settings');
    await ui.press('Escape');
    // All months
    await ui.click('#btn-all');
    await expectSoon(b, () => document.querySelector('#all-months svg'), 'all months did not open');
    await shot(b, run, w, '07-all-months', { fullPage: true });
    await ui.click(() => document.querySelector('#all-months .x-group:last-of-type .x-hit'));
    await delay(150);
    const back = await b.eval(() => document.getElementById('month-label').textContent);
    if (back === 'All months') {
      await ui.click('#btn-all');
    }
    await b.eval(() => window.scrollTo(0, 0));
    // + Add
    await ui.click(() => [...document.querySelectorAll('#view-month .list-head button')].find((x) => /^\+ Add$/.test(x.textContent.trim())));
    await expectSoon(b, () => document.querySelector('#dialog-root .dialog'), 'add payment did not open');
    await shot(b, run, w, '08-add-payment');
    await ui.press('Escape');
    // import review dialog, then the backup banner
    await pick(b, ui, '#btn-import', ['test/fixtures/ing-fake-1.pdf']);
    await expectSoon(b, () => document.querySelector('#dialog-root .dialog'), 'review did not open');
    await shot(b, run, w, '09-review');
    await ui.click(() => [...document.querySelectorAll('#dialog-root .dialog button')].find((x) => x.textContent.trim() === 'Add'));
    await expectSoon(b, () => document.querySelector('#banners .banner'), 'no banner after import');
    await b.eval(() => window.scrollTo(0, 0));
    await shot(b, run, w, '10-backup-banner');
    await shot(b, run, w, '10b-after-import-full', { fullPage: true });
    // two files at once, one of them unreadable
    await pick(b, ui, '#btn-import', ['test/fixtures/ing-fake-semicolon.csv', 'test/fixtures/not-ing.pdf']);
    await expectSoon(b, () => document.querySelector('#dialog-root .dialog'), 'review (2 files) did not open');
    await shot(b, run, w, '11-review-two-files');
    await ui.press('Escape');
    const errs = b.errors();
    if (errs.length) problems.push(`${run.browser} ${w}: console errors ${JSON.stringify(errs.slice(0, 3))}`);
  } finally {
    await quit(b);
  }
}

async function emptyRun(run, w, h) {
  const b = await launch({ browser: run.browser, profileDir: `.tmp/e2e-gecko/profiles/shots-empty-${run.browser}-${w}`, wipe: true, colorScheme: run.colorScheme, width: w, height: h });
  try {
    await b.open(fileUrl(`${BUILD}/Budget.html`));
    await expectSoon(b, () => window.Budget && document.querySelector('#view-month .dropzone'), 'empty state did not render');
    await shot(b, run, w, '12-empty');
    await b.eval(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'x.csv', { type: 'text/csv' }));
      document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    });
    await shot(b, run, w, '13-drop-overlay');
  } finally {
    await quit(b);
  }
}

await rm(join(APP_ROOT, SHOTS), { recursive: true, force: true });
await mkdir(join(APP_ROOT, SHOTS), { recursive: true });
build(`${BUILD}/Budget.html`, null);
build(`${BUILD}/Budget-demo.html`, 'seed/demo-seed.json');
for (const run of RUNS) {
  for (const [w, h] of WIDTHS) {
    try {
      await demoRun(run, w, h);
    } catch (err) {
      problems.push(`${run.browser} ${w} demo: ${err.message}`);
    }
    try {
      await emptyRun(run, w, h);
    } catch (err) {
      problems.push(`${run.browser} ${w} empty: ${err.message}`);
    }
  }
}
console.log(written.join('\n'));
console.log(`${written.length} screenshots in ${SHOTS}`);
if (problems.length) console.log(`Problems:\n  ${problems.join('\n  ')}`);
process.exitCode = problems.length ? 1 : 0;
