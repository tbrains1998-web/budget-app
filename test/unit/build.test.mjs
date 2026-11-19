// Unit tests for build/build.mjs: the pure assemble() step with tiny inputs, build() on a temporary tree, and
// (once every src file exists) a build of the real sources with the demo seed. All data is fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import { ALLOWED_URLS, CSP, ROOT, SCRIPTS, STYLES, assemble, build, validateSeed } from '../../build/build.mjs';

const TMP = join(ROOT, '.tmp');

const INDEX = `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <title>Budget</title>
  ${STYLES.map((s) => `<link rel="stylesheet" href="${s}">`).join('\n  ')}
</head>
<body>
  <div id="app"></div>
  ${SCRIPTS.map((s) => `<script src="${s}"></script>`).join('\n  ')}
</body>
</html>
`;
// The real worker contains these replacement patterns; they must survive unchanged.
const TRICKY = "const a='$&', b='$`', c=\"$'\", d='$1$8';";

function inputs(overrides = {}) {
  return {
    indexHtml: INDEX,
    styles: STYLES.map((name) => ({ name, text: `.${name.replace('.css', '')} { color: red; }` })),
    scripts: SCRIPTS.map((name) => ({ name, text: `globalThis.loaded = (globalThis.loaded || []).concat(${JSON.stringify(name)});` })),
    pdfjs: { lib: `export const lib = 1; ${TRICKY}`, worker: `globalThis.pdfjsWorker = {}; ${TRICKY}` },
    seed: null,
    ...overrides,
  };
}

const backup = (state) => ({ app: 'budget-nl', version: 1, exportedAt: '2026-07-02T19:00:00.000Z', state });

function inlineScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

test('assemble puts the CSP right after the charset and inlines css + js in place of the tags', () => {
  const { html } = assemble(inputs());
  assert.match(html, new RegExp(`<meta charset="utf-8">\\n<meta http-equiv="Content-Security-Policy" content="${CSP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`));
  assert.doesNotMatch(html, /<link\b/);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/);
  assert.equal(html.match(/<style>/g).length, 1);
  assert.ok(html.indexOf('.styles {') < html.indexOf('.extras {'), 'styles.css before extras.css');
  assert.ok(html.indexOf('<style>') < html.indexOf('</head>'));
  assert.ok(html.indexOf('<div id="app">') < html.indexOf('id="pdfjs-lib"'), 'scripts stay after the markup');
});

test('assemble runs the app scripts in the load order after pdf.js and the seed', () => {
  const { html } = assemble(inputs());
  const context = vm.createContext({ window: {} });
  for (const code of inlineScripts(html)) vm.runInContext(code, context);
  assert.deepEqual([...context.loaded], SCRIPTS);
  assert.equal(context.window.BUDGET_SEED, null);
  const order = ['id="pdfjs-lib"', 'id="pdfjs-worker"', 'window.BUDGET_SEED', '//# sourceURL=js/util.js', '//# sourceURL=js/app.js'];
  const positions = order.map((s) => html.indexOf(s));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test('assemble embeds pdf.js verbatim, $-patterns included', () => {
  const pdfjs = inputs().pdfjs;
  const { html } = assemble(inputs());
  assert.ok(html.includes(`<script type="text/plain" id="pdfjs-lib">${pdfjs.lib}</script>`));
  assert.ok(html.includes(`<script type="text/plain" id="pdfjs-worker">${pdfjs.worker}</script>`));
});

test('assemble injects the seed as an ASCII-only literal that cannot close the script element', () => {
  const state = { transactions: [{ name: 'Café </script><script>alert(1)</script> <!-- J. Jansen', note: 'a\u2028b\u2029c €' }] };
  const { html } = assemble(inputs({ seed: backup(state) }));
  const seedScript = inlineScripts(html).find((s) => s.startsWith('window.BUDGET_SEED'));
  assert.ok(seedScript, 'seed script present');
  assert.doesNotMatch(seedScript, /</);
  assert.match(seedScript, /^[\x20-\x7e]*$/);
  const context = vm.createContext({ window: {} });
  vm.runInContext(seedScript, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.BUDGET_SEED)), backup(state));
});

test('assemble refuses input that would give a broken or unsafe file', () => {
  const scripts = inputs().scripts;
  const cases = [
    [{ indexHtml: INDEX.replace('js/calc.js', 'js/CALC.js') }, /expected the load order/],
    [{ indexHtml: INDEX.replace('<script src="js/app.js"></script>', '') }, /expected the load order/],
    [{ indexHtml: INDEX.replace('<link rel="stylesheet" href="extras.css">', '') }, /<link> tags/],
    [{ indexHtml: INDEX.replace('<meta charset="utf-8">', '') }, /charset/],
    [{ indexHtml: INDEX.replace('<title>', `<meta http-equiv="Content-Security-Policy" content="default-src *"><title>`) }, /already has a Content-Security-Policy/],
    [{ scripts: scripts.map((s, i) => (i === 3 ? { ...s, text: 'const x = 1;\nconst y = "</script>";' } : s)) }, /js\/categorize\.js line 2/],
    [{ scripts: scripts.map((s, i) => (i === 0 ? { ...s, text: 'x = "<!--";' } : s)) }, /js\/util\.js line 1/],
    [{ styles: [{ name: 'styles.css', text: 'a{}</style>' }, inputs().styles[1]] }, /styles\.css line 1/],
    [{ pdfjs: { lib: 'x', worker: 'y = "<script>"' } }, /pdf\.worker\.min\.mjs/],
    [{ seed: { state: { transactions: [] } } }, /not a budget-nl backup/],
  ];
  for (const [override, message] of cases) assert.throws(() => assemble(inputs(override)), message);
});

test('assemble lists http(s) URLs outside pdf.js with their place; only the SVG namespace is allowed', () => {
  const scripts = inputs().scripts.map((s) => (s.name === 'js/ui-month.js'
    ? { ...s, text: "const NS = 'http://www.w3.org/2000/svg';\nfetch('https://example.invalid/x?y=1');\nconst X = 'http://www.w3.org/1999/xlink';\nconst S = 'http://www.w3.org/2000/svg2';" } : s));
  const pdfjs = { lib: 'const u = "http://www.apache.org/licenses/LICENSE-2.0";', worker: 'const v = "https://foo.bar";' };
  const { urls } = assemble(inputs({ scripts, pdfjs }));
  assert.deepEqual(urls, [
    { where: 'src/js/ui-month.js:2', url: 'https://example.invalid/x?y=1' },
    { where: 'src/js/ui-month.js:3', url: 'http://www.w3.org/1999/xlink' },
    { where: 'src/js/ui-month.js:4', url: 'http://www.w3.org/2000/svg2' },
  ], 'the SVG namespace is silent; other namespaces and look-alikes still warn');
  assert.deepEqual([...ALLOWED_URLS], ['http://www.w3.org/2000/svg']);
});

test('assemble notes when import-pdf.js does not use the embedded pdf.js elements', () => {
  assert.equal(assemble(inputs()).notes.length, 2);
  const scripts = inputs().scripts.map((s) => (s.name === 'js/import-pdf.js'
    ? { ...s, text: "document.getElementById('pdfjs-lib'); document.getElementById('pdfjs-worker');" } : s));
  assert.deepEqual(assemble(inputs({ scripts })).notes, []);
});

// A throw-away project tree: tiny src files, except the real util.js and store.js (the build checks a seed with
// them), and the real vendor files.
async function tempTree() {
  await mkdir(TMP, { recursive: true });
  const root = await mkdtemp(join(TMP, 'unit-build-'));
  const input = inputs();
  await mkdir(join(root, 'src', 'js'), { recursive: true });
  await mkdir(join(root, 'vendor'));
  await writeFile(join(root, 'src', 'index.html'), input.indexHtml);
  for (const s of input.styles) await writeFile(join(root, 'src', s.name), s.text);
  for (const s of input.scripts) await writeFile(join(root, 'src', s.name), s.text);
  for (const f of ['util.js', 'store.js']) await copyFile(join(ROOT, 'src', 'js', f), join(root, 'src', 'js', f));
  for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs', 'VERSION.txt']) await copyFile(join(ROOT, 'vendor', f), join(root, 'vendor', f));
  return root;
}

// One valid FAKE payment (the app accepts it as is).
const VALID_TX = { id: 't_1', payeeId: 'p_0123456789abcdef', date: '2026-09-01', month: '2026-09', name: 'Test BV', description: '',
  amount: -100, categoryId: 'onbekend', kind: 'wisselend', type: '', bankCode: '', source: 'seed', fingerprint: '' };

test('build writes one file with the real pdf.js copies and the seed', async (t) => {
  const root = await tempTree();
  t.after(() => rm(root, { recursive: true, force: true }));
  const seedPath = join(root, 'seed.json');
  // (Before, this test used {transactions: [{id: 't_1'}]}, a seed the app itself refuses.)
  await writeFile(seedPath, JSON.stringify(backup({ transactions: [VALID_TX] })));
  const result = await build({ root, seedPath });
  assert.equal(result.outPath, join(root, 'dist', 'Budget.html'));
  const html = await readFile(result.outPath, 'utf8');
  assert.equal(result.bytes, Buffer.byteLength(html));
  assert.equal(result.pdfjsVersion, '6.4.299');
  assert.deepEqual(result.seed, { path: seedPath, transactions: 1 });
  const lib = await readFile(join(ROOT, 'vendor', 'pdf.min.mjs'), 'utf8');
  const worker = await readFile(join(ROOT, 'vendor', 'pdf.worker.min.mjs'), 'utf8');
  assert.ok(worker.includes('$&'), 'the real worker has $& (the reason for split/join)');
  assert.ok(html.includes(`<script type="text/plain" id="pdfjs-lib">${lib}</script>`));
  assert.ok(html.includes(`<script type="text/plain" id="pdfjs-worker">${worker}</script>`));
});

test('build fails loudly on missing sources, a changed vendor file or a bad seed', async (t) => {
  const root = await tempTree();
  t.after(() => rm(root, { recursive: true, force: true }));
  await rm(join(root, 'src', 'js', 'import-pdf.js'));
  await rm(join(root, 'src', 'extras.css'));
  await assert.rejects(build({ root }), /missing source file\(s\):\n {2}src\/extras\.css\n {2}src\/js\/import-pdf\.js$/);

  const fresh = await tempTree();
  t.after(() => rm(fresh, { recursive: true, force: true }));
  await assert.rejects(build({ root: fresh, seedPath: join(fresh, 'nope.json') }), /seed file not found/);
  await writeFile(join(fresh, 'bad.json'), '{"app":"budget-nl", oops');
  await assert.rejects(build({ root: fresh, seedPath: join(fresh, 'bad.json') }), /seed .*bad\.json: /);
  await writeFile(join(fresh, 'vendor', 'pdf.min.mjs'), '// changed');
  await assert.rejects(build({ root: fresh }), /pdf\.min\.mjs does not match the sha256/);
});

test('build refuses a seed the app would refuse, with the app\'s own message', async (t) => {
  const root = await tempTree();
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'dist', 'Budget.html');
  const cases = [
    [backup({ transactions: [{ ...VALID_TX, date: '2026-02-30' }] }), /This backup can't be restored\. Payment 1 is damaged \(the date or amount is wrong\)\./],
    [{ ...backup({ transactions: [VALID_TX] }), version: 2 }, /This backup comes from a newer version of the app\./],
    [backup({ version: 2, transactions: [VALID_TX] }), /newer version of the app/],
    [backup({ transactions: [VALID_TX], statements: [{ month: 'sep' }] }), /Statement 1 is damaged/],
    [backup({ transactions: [VALID_TX], rules: [{ match: {} }] }), /Rule 1 is damaged/],
    [backup({ transactions: [{ ...VALID_TX, amount: '12' }] }), /Payment 1 is damaged/],
  ];
  for (const [seed, message] of cases) {
    const seedPath = join(root, 'bad-seed.json');
    await writeFile(seedPath, JSON.stringify(seed));
    await assert.rejects(build({ root, seedPath, outPath: out }), (err) => /^seed .*bad-seed\.json: /.test(err.message) && message.test(err.message), JSON.stringify(seed).slice(0, 80));
    await assert.rejects(access(out), 'nothing is written');
  }
});

test('validateSeed: runs the real store.importBackup in a vm; says when loading would change the seed', async () => {
  const [util, store] = await Promise.all(['util.js', 'store.js'].map((f) => readFile(join(ROOT, 'src', 'js', f), 'utf8')));
  const demo = JSON.parse(await readFile(join(ROOT, 'seed', 'demo-seed.json'), 'utf8'));
  assert.deepEqual(validateSeed(demo, { util, store }), { changed: false }, 'the demo seed is stored exactly as the app keeps it');
  assert.deepEqual(validateSeed(backup({ transactions: [{ ...VALID_TX, payeeId: undefined }] }), { util, store }), { changed: true });
  assert.throws(() => validateSeed(backup({ transactions: {} }), { util, store }), /list of payments is damaged/);
  assert.throws(() => validateSeed(backup({}), { util: 'x = 1', store: 'y = 2' }), /does not define Budget\.store\.importBackup/);
});

const realSources = ['src/index.html', ...STYLES.map((f) => `src/${f}`), ...SCRIPTS.map((f) => `src/${f}`)];
const missing = [];
for (const f of realSources) {
  try {
    await access(join(ROOT, f));
  } catch {
    missing.push(f);
  }
}

test('the real sources build with the demo seed', { skip: missing.length ? `missing: ${missing.join(', ')}` : false }, async (t) => {
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(join(TMP, 'unit-build-real-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await build({ seedPath: join(ROOT, 'seed', 'demo-seed.json'), outPath: join(dir, 'Budget.html') });
  const html = await readFile(result.outPath, 'utf8');
  for (const name of SCRIPTS) assert.ok(html.includes(`//# sourceURL=${name}\n</script>`), name);
  assert.deepEqual(result.notes, [], 'no notes: also, the app loads the demo seed without changing it');
  assert.deepEqual(result.urls, [], 'no http(s) URLs to report (the SVG namespace name is allowed)');
});
