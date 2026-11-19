// The README's build and install commands do what the README says. All files are fake and live in a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../../build/build.mjs';

test('npm run build:demo writes its own file and never replaces dist/Budget.html', () => {
  const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(scripts.build, 'node build/build.mjs');
  assert.equal(scripts['build:demo'], 'node build/build.mjs --seed seed/demo-seed.json --out dist/Budget-demo.html');
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(scripts['build:demo']), 'the README shows the same demo command');
});

test('install.ps1 with the README command installs dist/Budget.html into the user profile',
  { skip: process.platform !== 'win32' && 'Windows only' }, (t) => {
    // Copy of the script next to a fake dist/, so $PSScriptRoot\..\dist is the temp folder; USERPROFILE points there too.
    const dir = mkdtempSync(join(tmpdir(), 'budget-install-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'tools'));
    mkdirSync(join(dir, 'dist'));
    mkdirSync(join(dir, 'home'));
    copyFileSync(join(ROOT, 'tools', 'install.ps1'), join(dir, 'tools', 'install.ps1'));
    writeFileSync(join(dir, 'dist', 'Budget.html'), '<!doctype html><title>fake build</title>');
    const run = () => spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'tools', 'install.ps1'), '-NoShortcut'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, USERPROFILE: join(dir, 'home') } });
    const first = run();
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const dest = join(dir, 'home', 'Budget', 'Budget.html');
    assert.ok(existsSync(dest), 'installed into %USERPROFILE%\\Budget');
    assert.equal(readFileSync(dest, 'utf8'), '<!doctype html><title>fake build</title>');
    const second = run();
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /Unchanged/);
  });
