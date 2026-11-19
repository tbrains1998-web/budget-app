// Assembles the whole app into ONE self-contained file, dist/Budget.html. Node 24, no dependencies.
//
//   node build/build.mjs [--seed <backup.json>] [--out <file>]
//
// What ends up in the file:
//   <head>  the charset meta, then the CSP meta below (it must come before anything it should cover), the rest of
//           src/index.html's head, and ONE <style> holding src/styles.css + src/extras.css in place of their <link>s.
//   <body>  src/index.html's markup; in place of its <script src> tags:
//             <script type="text/plain" id="pdfjs-lib">     vendor/pdf.min.mjs, verbatim
//             <script type="text/plain" id="pdfjs-worker">  vendor/pdf.worker.min.mjs, verbatim
//             <script>window.BUDGET_SEED = {…backup…};</script>   (null without --seed)
//             one classic <script> per app file, in the load order below (SCRIPTS)
//
// pdf.js hand-off (the contract src/js/import-pdf.js codes against):
//   the two text/plain elements hold the unmodified pdfjs-dist module sources. import-pdf.js reads their textContent
//   and import()s each one from a blob: URL; importing the worker module sets globalThis.pdfjsWorker, so pdf.js runs
//   its worker code on the main thread. No workerSrc, no workerPort, no files next to the page. The only CSP need is
//   blob: in script-src. All text is spliced in by slicing index.html, never through a String.replace() pattern,
//   which would corrupt the worker: it contains "$&", "$`", "$1" and "$8".
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A strict policy (pdf.js works under it unchanged), plus base-uri/form-action, which
// default-src does not cover.
export const CSP = "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'; "
  + "img-src data: blob:; font-src data:; connect-src blob: data:; base-uri 'none'; form-action 'none'";

export const STYLES = ['styles.css', 'extras.css'];
export const SCRIPTS = ['util', 'store', 'calc', 'categorize', 'import-csv', 'import-pdf', 'ui-kit', 'import',
  'ui-month', 'ui-extras', 'app'].map((name) => `js/${name}.js`);
const VENDOR = { lib: 'pdf.min.mjs', worker: 'pdf.worker.min.mjs' };

// The one http URL the app may contain: the SVG namespace name (an identifier for createElementNS, never fetched).
// It is not reported; every other http(s) URL outside pdf.js is.
export const ALLOWED_URLS = new Set(['http://www.w3.org/2000/svg']);

const LINK_RE = /<link\b[^>]*>/gi;
const SCRIPT_SRC_RE = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script\s*>/gi;
const HREF_RE = /\bhref\s*=\s*["']([^"']+)["']/i;
const URL_RE = /\bhttps?:\/\/[^\s"'`<>)\\]+/gi;

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

// Raw text inside <script> must not end the element early or switch the HTML tokenizer into its escaped states.
function assertScriptSafe(name, text) {
  const m = /<\/script|<!--|<script/i.exec(text);
  if (m) throw new Error(`${name} line ${lineOf(text, m.index)}: "${m[0]}" cannot be inlined in a <script> element`);
  return text;
}

function assertStyleSafe(name, text) {
  const m = /<\/style/i.exec(text);
  if (m) throw new Error(`${name} line ${lineOf(text, m.index)}: "${m[0]}" cannot be inlined in a <style> element`);
  return text;
}

// JSON as an ASCII-only JS literal that is safe inside <script>: "<" and every non-ASCII character (U+2028 and
// U+2029 included) become \uXXXX escapes.
function scriptJson(value) {
  return JSON.stringify(value).replace(/[^\x20-\x3b\x3d-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Throws unless the backup object looks like the app's backup format.
export function checkSeed(seed) {
  const ok = seed !== null && typeof seed === 'object' && seed.app === 'budget-nl'
    && seed.state !== null && typeof seed.state === 'object' && Array.isArray(seed.state.transactions);
  if (!ok) throw new Error('the seed is not a budget-nl backup ({app: "budget-nl", version, exportedAt, state})');
  return seed;
}

function findUrls(where, text) {
  return [...text.matchAll(URL_RE)]
    .filter((m) => !ALLOWED_URLS.has(m[0]))
    .map((m) => ({ where: `${where}:${lineOf(text, m.index)}`, url: m[0] }));
}

/**
 * Loads the seed exactly as the app would: the real util.js and store.js (their source text) run in a vm and
 * Budget.store.importBackup(seed) is called on an empty state. Throws an Error with the app's own message when the
 * app would refuse the seed (a bad date, a newer version, ...). Returns {changed}: true when the app's normalizing
 * would change the seed's state (fields filled in, old keys converted), which is allowed but worth knowing.
 */
export function validateSeed(seed, { util, store }) {
  const quiet = { error() {}, warn() {}, log() {} };
  const context = vm.createContext({ TextEncoder, TextDecoder, crypto: globalThis.crypto, console: quiet,
    setTimeout: () => 0, clearTimeout: () => {} });
  vm.runInContext(util, context, { filename: 'js/util.js' });
  vm.runInContext(store, context, { filename: 'js/store.js' });
  const api = context.Budget && context.Budget.store;
  if (!api || typeof api.importBackup !== 'function') throw new Error('src/js/store.js does not define Budget.store.importBackup');
  let state;
  try {
    state = api.importBackup(JSON.parse(JSON.stringify(seed)));
  } catch (err) {
    throw new Error(String((err && err.message) || err));
  }
  return { changed: JSON.stringify(state) !== JSON.stringify(seed.state) };
}

/**
 * Pure assembly. indexHtml: src/index.html; styles: [{name, text}] in STYLES order; scripts: [{name, text}] in
 * SCRIPTS order; pdfjs: {lib, worker} sources; seed: backup object or null.
 * Returns {html, urls: [{where, url, namespace}], notes: [string]}; throws on anything that would give a broken file.
 */
export function assemble({ indexHtml, styles, scripts, pdfjs, seed }) {
  if (/http-equiv\s*=\s*["']?content-security-policy/i.test(indexHtml)) {
    throw new Error('src/index.html already has a Content-Security-Policy meta; the build adds the only one');
  }
  const charset = /<meta\s+charset\s*=\s*["']?utf-8["']?\s*\/?>/i.exec(indexHtml);
  if (!charset) throw new Error('src/index.html needs <meta charset="utf-8"> (the file holds UTF-8 text)');

  const links = [...indexHtml.matchAll(LINK_RE)];
  const hrefs = links.map((m) => (HREF_RE.exec(m[0]) || [])[1]);
  if (!sameList(hrefs, styles.map((s) => s.name))) {
    throw new Error(`src/index.html <link> tags are [${hrefs.join(', ')}], expected [${styles.map((s) => s.name).join(', ')}]`);
  }
  const scriptTags = [...indexHtml.matchAll(SCRIPT_SRC_RE)];
  const srcs = scriptTags.map((m) => m[1]);
  if (!scriptTags.length || !sameList(srcs, scripts.map((s) => s.name))) {
    throw new Error(`src/index.html <script src> tags are [${srcs.join(', ')}], expected the load order `
      + `[${scripts.map((s) => s.name).join(', ')}]`);
  }

  const styleBlock = `<style>\n${styles.map((s) => `/* ${s.name} */\n${assertStyleSafe(s.name, s.text)}`).join('\n')}\n</style>`;
  const appBlock = [
    `<script type="text/plain" id="pdfjs-lib">${assertScriptSafe(VENDOR.lib, pdfjs.lib)}</script>`,
    `<script type="text/plain" id="pdfjs-worker">${assertScriptSafe(VENDOR.worker, pdfjs.worker)}</script>`,
    `<script>window.BUDGET_SEED = ${seed ? scriptJson(checkSeed(seed)) : 'null'};</script>`,
    ...scripts.map((s) => `<script>\n${assertScriptSafe(s.name, s.text)}\n//# sourceURL=${s.name}\n</script>`),
  ].join('\n');

  // Cut index.html into pieces at the tags being replaced, so no inlined text ever passes through a replace pattern.
  const cuts = [
    { at: charset.index + charset[0].length, len: 0, text: `\n<meta http-equiv="Content-Security-Policy" content="${CSP}">` },
    ...links.map((m, i) => ({ at: m.index, len: m[0].length, text: i === 0 ? styleBlock : '' })),
    ...scriptTags.map((m, i) => ({ at: m.index, len: m[0].length, text: i === 0 ? appBlock : '' })),
  ].sort((a, b) => a.at - b.at);
  const parts = [];
  let from = 0;
  for (const cut of cuts) {
    parts.push(indexHtml.slice(from, cut.at), cut.text);
    from = cut.at + cut.len;
  }
  parts.push(indexHtml.slice(from));
  const html = parts.join('');

  const urls = [
    ...findUrls('src/index.html', indexHtml),
    ...styles.flatMap((s) => findUrls(`src/${s.name}`, s.text)),
    ...scripts.flatMap((s) => findUrls(`src/${s.name}`, s.text)),
    ...(seed ? findUrls('seed', JSON.stringify(seed)) : []),
  ];
  const notes = [];
  const importPdf = scripts.find((s) => s.name === 'js/import-pdf.js');
  for (const id of ['pdfjs-lib', 'pdfjs-worker']) {
    if (importPdf && !importPdf.text.includes(id)) notes.push(`src/js/import-pdf.js never mentions #${id}`);
  }
  return { html, urls, notes };
}

// vendor/VERSION.txt lists "<file> sha256 <hex>"; the embedded copies must be exactly those files.
function checkVendor(versionTxt, name, text) {
  const m = new RegExp(`^\\s*${name.replace(/\./g, '\\.')}\\s+sha256\\s+([0-9a-f]{64})`, 'm').exec(versionTxt);
  if (!m) throw new Error(`vendor/VERSION.txt has no sha256 for ${name}`);
  const actual = createHash('sha256').update(text, 'utf8').digest('hex');
  if (actual !== m[1]) throw new Error(`vendor/${name} does not match the sha256 in vendor/VERSION.txt`);
}

async function readSources(root, files) {
  const results = await Promise.allSettled(files.map((f) => readFile(join(root, f), 'utf8')));
  const missing = files.filter((f, i) => results[i].status === 'rejected');
  if (missing.length) throw new Error(`missing source file(s):\n  ${missing.join('\n  ')}`);
  return results.map((r) => r.value);
}

/** Reads everything under root, assembles, writes outPath. Returns a summary; throws on any problem. */
export async function build({ root = ROOT, seedPath = null, outPath = join(root, 'dist', 'Budget.html') } = {}) {
  const files = ['src/index.html', ...STYLES.map((f) => `src/${f}`), ...SCRIPTS.map((f) => `src/${f}`),
    `vendor/${VENDOR.lib}`, `vendor/${VENDOR.worker}`, 'vendor/VERSION.txt'];
  const texts = await readSources(root, files);
  const [indexHtml, ...rest] = texts;
  const styles = STYLES.map((name, i) => ({ name, text: rest[i] }));
  const scripts = SCRIPTS.map((name, i) => ({ name, text: rest[STYLES.length + i] }));
  const [lib, worker, versionTxt] = rest.slice(STYLES.length + SCRIPTS.length);
  checkVendor(versionTxt, VENDOR.lib, lib);
  checkVendor(versionTxt, VENDOR.worker, worker);

  let seed = null;
  let seedChanged = false;
  if (seedPath) {
    let text;
    try {
      text = await readFile(seedPath, 'utf8');
    } catch {
      throw new Error(`seed file not found: ${seedPath}`);
    }
    try {
      seed = checkSeed(JSON.parse(text));
      const source = (name) => scripts.find((s) => s.name === name).text;
      seedChanged = validateSeed(seed, { util: source('js/util.js'), store: source('js/store.js') }).changed;
    } catch (err) {
      throw new Error(`seed ${seedPath}: ${err.message}`);
    }
  }

  const { html, urls, notes } = assemble({ indexHtml, styles, scripts, pdfjs: { lib, worker }, seed });
  if (seedChanged) notes.push('the app fills in or converts parts of the seed when it loads it (regenerate it to store them)');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, html, 'utf8');
  const pdfjsVersion = (/pdfjs-dist\s+(\S+)/.exec(versionTxt) || [])[1] || '?';
  return {
    outPath,
    bytes: Buffer.byteLength(html, 'utf8'),
    pdfjsVersion,
    scripts: SCRIPTS.length,
    seed: seed && { path: seedPath, transactions: seed.state.transactions.length },
    urls,
    notes,
  };
}

function parseArgs(argv) {
  const args = { seedPath: null, outPath: undefined };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    const value = argv[i + 1];
    if ((name !== '--seed' && name !== '--out') || value === undefined || value.startsWith('--')) {
      throw new Error(`unknown or incomplete argument "${name}". Usage: node build/build.mjs [--seed <backup.json>] [--out <file>]`);
    }
    args[name === '--seed' ? 'seedPath' : 'outPath'] = resolve(value);
    i++;
  }
  return args;
}

async function main() {
  const result = await build(parseArgs(process.argv.slice(2)));
  const mb = (result.bytes / 1024 / 1024).toFixed(2);
  console.log(`Built ${relative(process.cwd(), result.outPath) || result.outPath}: ${mb} MB (${result.bytes} bytes)`);
  console.log(`  pdf.js ${result.pdfjsVersion} embedded (vendor sha256 verified), ${result.scripts} app scripts inlined`);
  console.log(result.seed ? `  seed: ${relative(process.cwd(), result.seed.path)} (${result.seed.transactions} payments)` : '  seed: none (BUDGET_SEED = null)');
  console.log(`  CSP: ${CSP}`);
  if (result.urls.length) {
    console.warn(`WARNING: ${result.urls.length} http(s) URL(s) outside pdf.js's own source:`);
    for (const u of result.urls) console.warn(`  ${u.where}  ${u.url}`);
  } else {
    console.log(`  no http(s) URLs outside pdf.js (allowed: ${[...ALLOWED_URLS].join(', ')})`);
  }
  for (const note of result.notes) console.warn(`WARNING: ${note}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`BUILD FAILED: ${err.message}`);
    process.exitCode = 1;
  });
}
