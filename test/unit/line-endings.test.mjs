// A git clone on Windows (where Git turns on core.autocrlf by default) must give the same files the repo has:
// the build checks the PDF.js files byte for byte, and the test fixtures are compared exactly. Temp folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build } from '../../build/build.mjs';
import { ROOT, files } from '../lib/repo-files.mjs';

const EXACT = /^(?:vendor|test\/fixtures)\//; // hashed or compared byte for byte
const CRLF = /\.(?:bat|cmd|ps1|vbs)$/i; // Windows scripts keep CRLF
const BARE_LF = /(?:^|[^\r])\n/;

test('a clone with core.autocrlf=true has the exact files and builds', (t) => {
  const list = files();
  if (!list) return t.skip('git is not installed');
  const dir = mkdtempSync(join(tmpdir(), 'budget-clone-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, 'src');
  const dst = join(dir, 'clone');
  for (const name of list) {
    mkdirSync(dirname(join(src, name)), { recursive: true });
    copyFileSync(join(ROOT, name), join(src, name));
  }
  // A global hook that always fails: the developer's own hooks (core.hooksPath) must not run on this temp repo.
  const hooks = join(dir, 'hooks');
  mkdirSync(hooks);
  for (const h of ['pre-commit', 'commit-msg', 'post-commit', 'post-checkout']) writeFileSync(join(hooks, h), '#!/bin/sh\nexit 1\n');
  const globalCfg = join(dir, 'gitconfig');
  writeFileSync(globalCfg, `[core]\n\thooksPath = ${hooks.replace(/\\/g, '/')}\n`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalCfg };
  const cfg = ['-c', 'core.autocrlf=true', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(dir, 'no-hooks')}`, '-c', 'user.name=test', '-c', 'user.email=test@example.com'];
  for (const args of [['init', '-q', src], ['-C', src, 'add', '-A'], ['-C', src, 'commit', '-q', '-m', 'test'], ['clone', '-q', src, dst]]) {
    const r = spawnSync('git', [...cfg, ...args], { encoding: 'utf8', env });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  }
  const lf = (buf) => buf.toString('latin1').replace(/\r\n/g, '\n');
  const wrong = [];
  for (const name of list) {
    const want = readFileSync(join(ROOT, name));
    const got = readFileSync(join(dst, name));
    if (EXACT.test(name) || want.includes(0)) {
      if (!got.equals(want)) wrong.push(`${name}: not byte-identical`);
    } else if (lf(got) !== lf(want)) {
      wrong.push(`${name}: content changed`);
    } else if (CRLF.test(name) ? BARE_LF.test(got.toString('latin1')) : got.includes('\r\n')) {
      wrong.push(`${name}: wrong line endings`);
    }
  }
  assert.deepEqual(wrong, []);
  return build({ root: dst, outPath: join(dir, 'out', 'Budget.html') });
});
