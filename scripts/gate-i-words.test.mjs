import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./gate-i-words.mjs', import.meta.url));
const forbidden = (left, right) => `${left}${right}`;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function write(cwd, relativePath, contents) {
  const target = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function commit(cwd, message) {
  git(cwd, ['add', '.']);
  git(cwd, ['-c', 'user.name=GATE-I test', '-c', 'user.email=gate-i@example.test', 'commit', '-m', message]);
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-i-'));
  git(cwd, ['init', '--initial-branch=base']);
  write(cwd, 'clean.txt', 'clean fixture\n');
  commit(cwd, 'clean base');
  return cwd;
}

function scan(cwd, ...argumentsList) {
  const result = spawnSync(process.execPath, [checker, '--json', ...argumentsList], {
    cwd,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    report: JSON.parse(result.stdout),
    stderr: result.stderr,
  };
}

test('full scan reports one forbidden hit and ignores a non-word substring', () => {
  const cwd = fixture();
  try {
    write(cwd, 'src/vendor.txt', `${forbidden('Eleven', 'Labs')}\ncompetitor\n`);
    git(cwd, ['add', 'src/vendor.txt']);

    const result = scan(cwd);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.report.summary.failures, 1);
    assert.equal(result.report.patterns[forbidden('eleven', 'labs')].failures, 1);
    assert.equal(result.report.findings[0].pattern, forbidden('eleven', 'labs'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('diff scan finds added hits and ignores a pre-existing hit', () => {
  const cwd = fixture();
  try {
    write(cwd, 'old.txt', `${forbidden('Eleven', 'Labs')}\n`);
    commit(cwd, 'pre-existing hit');
    git(cwd, ['checkout', '-b', 'feature']);
    write(cwd, 'new.txt', `${forbidden('fal-', 'ai')}\n`);
    commit(cwd, 'new hit');

    const result = scan(cwd, '--diff', 'base');
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.report.summary.failures, 1);
    assert.equal(result.report.findings[0].pattern, forbidden('fal-', 'ai'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('documentation wording allows a matching line', () => {
  const cwd = fixture();
  try {
    write(cwd, 'docs/status.txt', `${forbidden('Eleven', 'Labs')} not used\n`);
    git(cwd, ['add', 'docs/status.txt']);

    const result = scan(cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.report.summary.failures, 0);
    assert.equal(result.report.summary.allowed, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('allowlist glob suppresses a matching line', () => {
  const cwd = fixture();
  try {
    write(cwd, '.gate-i-allow', `docs/**/*.md\t${forbidden('eleven', 'labs')}\thistorical note\n`);
    write(cwd, 'docs/history.md', `${forbidden('Eleven', 'Labs')}\n`);
    git(cwd, ['add', '.gate-i-allow', 'docs/history.md']);

    const result = scan(cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.report.summary.failures, 0);
    assert.equal(result.report.summary.allowed, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
