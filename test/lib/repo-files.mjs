// Git helpers for the repo checks: which files `git add -A` would publish. General rules only, no private data.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Runs git over the repo folder. Outside a clone (a zip download) a throwaway git folder is used, so .gitignore still
// decides what counts. Returns null when git is not installed.
export function git(args, input) {
  const own = existsSync(join(ROOT, '.git'));
  const gitDir = own ? null : mkdtempSync(join(tmpdir(), 'budget-scan-'));
  try {
    if (gitDir && spawnSync('git', ['init', '-q', gitDir]).status !== 0) return null;
    const pre = own ? ['-C', ROOT] : ['-C', ROOT, `--git-dir=${join(gitDir, '.git')}`, `--work-tree=${ROOT}`];
    const r = spawnSync('git', [...pre, ...args], { encoding: 'utf8', input });
    return r.error ? null : r;
  } finally {
    if (gitDir) rmSync(gitDir, { recursive: true, force: true });
  }
}

// Only the files `git add -A` would publish: real bank files kept in ignored places are neither read nor printed.
export function files() {
  const r = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (!r) return null;
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\0').filter((name) => name && existsSync(join(ROOT, name)));
}
