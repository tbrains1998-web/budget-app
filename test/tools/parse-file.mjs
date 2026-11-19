// Reads bank files with the REAL app (headless Edge, file input -> Budget.importer) and prints what it found as ONE
// JSON object on stdout. Nothing is imported, nothing is written: no copies, logs or screenshots; the temporary
// browser profile is deleted at the end (also on errors / Ctrl+C). Progress goes to stderr.
//
//   node test/tools/parse-file.mjs [--app <built html>] [--pre <backup.json>] <file> [<file>...]
//
//   --app   a built Budget.html to use (default: a fresh no-seed build in .tmp/tools/Budget.html)
//   --pre   optional: restore this backup first, so its rules / hidden words decide categories and names
//
// Output: {app, files:[{index, file, kind, ok, error, found, duplicates, months, statement, monthStatements, statementsToStore,
//          check, warnings, nogKiezen, rows:[{date, month, name, description, amount, categoryId, kind, type,
//          bankCode}]}], combined:{found, new, duplicates, nogKiezen, months, existingMonths, perFileDuplicates}}
//   per file: read on its own against the starting state (empty, or --pre): rows = the payments it would add (all of
//   them unless --pre already holds some = duplicates); statement = as printed in the file (PDF)
//   or derived from "Saldo na mutatie" (CSV, whole file + per month); statementsToStore = what [Add] would store;
//   check = the totals (PDF) / saldo chain (CSV) result; amounts in cents (+ in, − out).
//   combined: all files read together in the given order, as one import -> duplicates and "not sorted yet" counts.
// Exit codes: 0 ok, 1 failure, 2 usage error.
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { UsageError, appFile, checkInputs, log, main, parseArgs, printJson, restoreBackup, safeLabel, toolInput, withApp } from './session.mjs';

const USAGE = 'usage: node test/tools/parse-file.mjs [--app <built html>] [--pre <backup.json>] <file> [<file>...]';

// Runs in the page. Per-file previews (each file alone), the raw statement from the app's own parsers, and one
// combined preview of all files (what the review dialog would say for a multi-file import).
async function readInPage(inputId) {
  const files = [...document.getElementById(inputId).files];
  const { importer, importPdf, importCsv } = Budget;
  const rowOf = (t) => ({ date: t.date, month: t.month, name: t.name, description: t.description, amount: t.amount, categoryId: t.categoryId, kind: t.kind, type: t.type, bankCode: t.bankCode });
  const decode = (bytes) => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  };
  const perFile = [];
  for (const file of files) {
    const p = await importer.preview([file]);
    const f = p.files[0];
    const entry = {
      kind: f.kind || null,
      ok: f.ok,
      error: f.ok ? null : f.error,
      found: f.found || 0,
      duplicates: f.duplicates || 0,
      months: f.months || [],
      statement: null,
      monthStatements: null,
      statementsToStore: p.statements.map(({ importedAt, ...s }) => s),
      check: f.check || null,
      warnings: f.warnings || [],
      nogKiezen: p.unknown,
      rows: p.transactions.map(rowOf),
    };
    if (f.ok) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (f.kind === 'pdf') {
          entry.statement = importPdf.parse(await importPdf.extract(bytes.buffer)).statement;
        } else {
          const parsed = importCsv.parse(decode(bytes));
          entry.statement = parsed.statement;
          entry.monthStatements = parsed.monthStatements;
        }
      } catch (e) {
        entry.statement = null;
      }
    }
    perFile.push(entry);
  }
  const all = await importer.preview(files);
  return {
    perFile,
    combined: {
      found: all.found,
      new: all.transactions.length,
      duplicates: all.duplicates,
      nogKiezen: all.unknown,
      months: all.months,
      existingMonths: all.existingMonths,
      perFileDuplicates: all.files.map((f) => f.duplicates || 0),
    },
  };
}

main(async () => {
  const args = parseArgs(process.argv.slice(2), ['--app', '--pre']);
  if (args.help) {
    log(USAGE);
    return 0;
  }
  if (!args.files.length) throw new UsageError('give at least one file');
  const files = await checkInputs(args.files);
  const pre = args.pre ? await readFile((await checkInputs([args.pre]))[0], 'utf8') : null;
  const app = await appFile(args.app);
  log(`reading ${files.length} file(s) with the app in headless Edge …`);
  const result = await withApp(app, async (edge) => {
    if (pre !== null) {
      const r = await restoreBackup(edge, pre);
      log(`restored --pre backup (${r.transactions} payments; its rules and settings apply)`);
    }
    const id = await toolInput(edge, files);
    return edge.eval(readInPage, id);
  });
  printJson({
    app: relative(process.cwd(), app) || app,
    files: result.perFile.map((f, i) => ({ index: i + 1, file: safeLabel(files[i]), ...f })),
    combined: result.combined,
  });
  log(`done: ${result.perFile.length} file(s), ${result.combined.found} payments, ${result.combined.duplicates} duplicates, ${result.combined.nogKiezen} not sorted yet.`);
  return 0;
}, USAGE);
