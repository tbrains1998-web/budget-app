// Imports bank files with the REAL app (headless Edge) exactly as a user would: the files go into the app's own file
// input, the review dialog opens and its [Add] button is clicked. Then store.exportBackup() is written to --out
// and a JSON summary of every month is printed on stdout. The temporary browser profile (it holds the imported
// payments) is deleted at the end, also on errors / Ctrl+C. Nothing else is written. Progress goes to stderr.
//
//   node test/tools/import-to-backup.mjs --out <backup.json> [--pre <backup.json>] [--app <built html>] <file>...
//   node test/tools/import-to-backup.mjs --check <backup.json> [--app <built html>]
//
//   --out    where to write the backup (budget-backup format, like "Make backup"); must not be one of the inputs
//   --pre    restore this backup first (store.importBackup), so its payments, rules, normal amounts and settings apply
//   --app    a built Budget.html (default: a fresh no-seed build in .tmp/tools/Budget.html)
//   --check  only load this backup and print the summary (no import, no --out)
//
// stdout: {months:[{month, count, statementCheck, tiles:{income, fixed, daily, left}, recap:{startBalance,
//          normalIncome, extraIncome, fixed, daily, oneoff, unknown, paidForOtherMonth, paidInEarlierMonth,
//          paidInLaterMonth, transfersNet, notViaBank, change, endBalance}}], normalMonth:{items, income, fixed, dailyAvg,
//          save, saveRounded}}
//   all amounts in cents. count = payments booked in that month (bank date). tiles = the 4 tiles as shown (income
//   and left signed, fixed and daily as positive costs). recap = calc.monthRecap rows (signed), statementCheck =
//   {ok, diff} or null when the month has no statement. normalMonth = calc.normalMonth (the savings card).
// Exit codes: 0 ok, 1 failure, 2 usage error, 3 done but a file could not be read (see stderr).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  UsageError, appFile, checkInputs, log, main, parseArgs, printJson, restoreBackup, safeLabel, summaryInPage, withApp,
} from './session.mjs';

const USAGE = [
  'usage: node test/tools/import-to-backup.mjs --out <backup.json> [--pre <backup.json>] [--app <built html>] <file>...',
  '       node test/tools/import-to-backup.mjs --check <backup.json> [--app <built html>]',
].join('\n');

// Runs in the page: wraps Budget.importer.readFiles (which app.js calls on a file pick) to see its preview.
function hookImporter() {
  window.__tool = { preview: null, error: null };
  const original = Budget.importer.readFiles;
  Budget.importer.readFiles = async (files) => {
    try {
      const p = await original(files);
      window.__tool.preview = p;
      return p;
    } catch (e) {
      window.__tool.error = String((e && e.message) || e);
      throw e;
    }
  };
  return true;
}

// Runs in the page: clicks [Add] in the review dialog when it is offered, else [Close].
function answerDialog() {
  const p = window.__tool.preview;
  const dialogs = [...document.querySelectorAll('#dialog-root .dialog')];
  const dialog = dialogs[dialogs.length - 1];
  const buttons = dialog ? [...dialog.querySelectorAll('.dialog-actions button')] : [];
  const add = buttons.find((b) => b.textContent.trim() === 'Add');
  const before = Budget.store.get().transactions.length;
  const statementsBefore = Budget.store.get().statements.length;
  if (add) add.click();
  else if (buttons[0]) buttons[0].click();
  return {
    clicked: add ? 'Add' : buttons[0] ? buttons[0].textContent.trim() : null,
    files: p.files.map((f) => ({ ok: f.ok, kind: f.kind || null, error: f.ok ? null : f.error, found: f.found || 0, duplicates: f.duplicates || 0, check: f.check ? f.check.ok : null })),
    found: p.found,
    duplicates: p.duplicates,
    nogKiezen: p.unknown,
    added: Budget.store.get().transactions.length - before,
    statementsAdded: Budget.store.get().statements.length - statementsBefore,
  };
}

main(async () => {
  const args = parseArgs(process.argv.slice(2), ['--out', '--pre', '--app', '--check']);
  if (args.help) {
    log(USAGE);
    return 0;
  }
  if (args.check) {
    if (args.files.length || args.out || args.pre) throw new UsageError('--check takes only a backup (and optionally --app)');
  } else {
    if (!args.out) throw new UsageError('--out <backup.json> is required');
    if (!args.files.length) throw new UsageError('give at least one bank file');
  }
  const files = await checkInputs(args.files);
  const pre = args.pre ? await readFile((await checkInputs([args.pre]))[0], 'utf8') : null;
  const check = args.check ? await readFile((await checkInputs([args.check]))[0], 'utf8') : null;
  const out = args.out ? resolve(process.cwd(), args.out) : null;
  if (out && files.some((f) => f.toLowerCase() === out.toLowerCase())) throw new UsageError('--out must not be one of the bank files');
  if (out && args.pre && resolve(process.cwd(), args.pre).toLowerCase() === out.toLowerCase()) throw new UsageError('--out must differ from --pre');
  const app = await appFile(args.app);

  let unread = 0;
  const result = await withApp(app, async (edge) => {
    if (check !== null) {
      const r = await restoreBackup(edge, check);
      log(`loaded the backup (${r.transactions} payments)`);
      return { summary: await edge.eval(summaryInPage) };
    }
    if (pre !== null) {
      const r = await restoreBackup(edge, pre);
      log(`restored --pre backup (${r.transactions} payments; its rules, normal amounts and settings apply)`);
    }
    await edge.eval(hookImporter);
    log(`importing ${files.length} file(s) through the app's file input …`);
    await edge.setFiles('#file-input', files);
    await edge.waitFor(() => Boolean(window.__tool.preview || window.__tool.error), { timeoutMs: 180000 });
    const failed = await edge.eval(() => window.__tool.error);
    if (failed) throw new Error('the app could not read the files (no review dialog)');
    await edge.waitFor(() => Boolean(document.querySelector('#dialog-root .dialog')), { timeoutMs: 10000 });
    const done = await edge.eval(answerDialog);
    done.files.forEach((f, i) => {
      if (!f.ok) {
        unread++;
        log(`file ${i + 1} (${safeLabel(files[i])}): NOT read — ${f.error}`);
      } else {
        const chk = f.check === null ? 'no balances to check' : f.check ? 'check ok' : 'CHECK FAILED (see parse-file for the warnings)';
        log(`file ${i + 1} (${safeLabel(files[i])}): ${f.kind}, ${f.found} payments, ${f.duplicates} duplicates, ${chk}`);
      }
    });
    log(`clicked [${done.clicked}]: ${done.added} payments and ${done.statementsAdded} statement(s) added, ${done.nogKiezen} not sorted yet`);
    const backup = await edge.eval(() => Budget.store.exportBackup());
    return { backup, summary: await edge.eval(summaryInPage) };
  });

  if (out) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(result.backup, null, 2)}\n`, 'utf8');
    log(`backup written: ${args.out}`);
  }
  printJson(result.summary);
  return unread ? 3 : 0;
}, USAGE);
