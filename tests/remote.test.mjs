import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, utimesSync, readdirSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmp, tree, xyz } from './helpers.mjs';
import { startOf } from '../src/lock.mjs';

// A pretend Boat on this machine: `<shell> <boat> <command…>` runs the command in its own home, as `boat ssh` would.
function fakeBoat() {
  const home = tmp('boat-'), bin = tmp('boatbin-'), sh = join(bin, 'boat-ssh');
  writeFileSync(sh, '#!/bin/sh\n[ "$1" = -l ] && shift 2\nshift\ncd "$XYZ_FAKE_BOAT_HOME" || exit 255\nHOME="$XYZ_FAKE_BOAT_HOME" exec sh -c "$*"\n');
  chmodSync(sh, 0o755);
  return { home, env: { XYZ_REMOTE_SHELL: sh, XYZ_FAKE_BOAT_HOME: home, XYZ_TEST_LOAD: '0' } };
}
function age(dir) {
  const old = new Date(Date.now() - 3600_000);
  for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) age(p); utimesSync(p, old, old); }
  utimesSync(dir, old, old);
}
function project(tests = {}) {
  const root = tmp('root-'), work = tmp('work-');
  const y = tree(join(work, 'Suite'), {
    'src/a.js': 'export const a = 1;\n',
    'tests/a.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert'; import { a } from '../src/a.js';\ntest('a', () => assert.equal(a, 1));\n",
    'tests/b.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert';\ntest('b', () => assert.ok(true));\n",
  });
  xyz(root, ['adopt', y]);
  const home = readFileSync(join(y, '.xyz'), 'utf8').trim();
  const f = join(home, 'xyz.json'), c = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...c, tests }));
  age(y);
  return { root, y, home };
}
// someone else holding this project's full-suite turn: a live process named in Z/queue
function holdTurn(home) {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  mkdirSync(join(home, 'Z', 'queue'), { recursive: true });
  writeFileSync(join(home, 'Z', 'queue', `${String(Date.now() - 5000).padStart(15, '0')}-${child.pid}.json`),
    JSON.stringify({ pid: child.pid, start: startOf(child.pid), at: Date.now() - 5000, who: 'Codex', label: 'xyz test' }) + '\n');
  return () => child.kill();
}

test('--remote runs the suite on the Boat with its own buffer; the result lands here marked with where it ran', () => {
  const { root, y, home } = project();
  const boat = fakeBoat();
  let r = xyz(root, ['test', '--remote=bx_fake', '--who', 'tester'], { cwd: y, env: boat.env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /running on Boat bx_fake/);
  assert.match(r.out, /2 files — 0 from the buffer, 2 to run/);
  assert.ok(!existsSync(join(home, 'Z', 'tests', 'last.json')), 'a Boat run never stands in for the suite here');
  const last = JSON.parse(readFileSync(join(home, 'Z', 'tests', 'last-remote.json'), 'utf8'));
  assert.equal(last.where, 'Boat bx_fake'); assert.equal(last.tree, 'Y'); assert.equal(last.passed, true); assert.equal(last.who, 'tester');
  assert.match(xyz(root, ['arrive'], { cwd: y }).out, /Remote run: passed 2 .* on Boat bx_fake/);
  assert.ok(!existsSync(join(home, 'Z', 'test-buffer', 'buffer.json')), 'the local buffer is not touched');
  assert.ok(existsSync(join(boat.home, 'xyz-remote', 'bin', 'node')));
  // the Boat remembers: unchanged files come from its buffer, a change is sent and runs
  r = xyz(root, ['test', '--remote=bx_fake'], { cwd: y, env: boat.env });
  assert.match(r.out, /2 from the buffer, 0 to run/, r.out);
  writeFileSync(join(y, 'src', 'a.js'), 'export const a = 2;\n'); age(y);
  r = xyz(root, ['test', '--remote=bx_fake'], { cwd: y, env: boat.env });
  assert.equal(r.code, 1, r.out); assert.match(r.out, /FAIL tests\/a\.test\.mjs/);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'Z', 'tests', 'last-remote.json'), 'utf8')).failedFiles, ['tests/a.test.mjs']);
});

test('whenBusy: a full suite goes to the Boat instead of waiting; a Boat that cannot be reached is an honest failure', () => {
  const { root, y } = project({ remote: { boat: 'bx_fake', whenBusy: true } });
  const boat = fakeBoat();
  const release = holdTurn(join(readFileSync(join(y, '.xyz'), 'utf8').trim()));
  try {
    const r = xyz(root, ['test'], { cwd: y, env: boat.env });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /queue here is busy; going to Boat bx_fake/);
  } finally { release(); }
  const r = xyz(root, ['test', '--remote'], { cwd: y, env: { ...boat.env, XYZ_REMOTE_SHELL: '/bin/false' } });
  assert.equal(r.code, 1); assert.match(r.out, /sending to Boat bx_fake failed/);
  assert.match(xyz(root, ['test', '--local', '--jobs', '2'], { cwd: y, env: { XYZ_TEST_LOAD: '0' } }).out, /suite: 2 tests, 2 pass/);
});

test("whenBusy: a promote's check goes to the Boat while the queue here is busy", () => {
  const BIN = new URL('../bin/xyz.mjs', import.meta.url).pathname;
  const { root, y, home } = project({ remote: { boat: 'bx_fake', whenBusy: true } });
  const f = join(home, 'xyz.json'), c = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...c, check: `"${process.execPath}" "${BIN}" test --bail` }));
  const boat = fakeBoat();
  xyz(root, ['save', 'tests'], { cwd: y });
  const release = holdTurn(home);
  try {
    const r = xyz(root, ['promote', '--saved'], { cwd: y, env: boat.env });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /check goes to Boat bx_fake instead of waiting/);
  } finally { release(); }
  const check = JSON.parse(readFileSync(join(home, 'Z', 'tests', 'last-check.json'), 'utf8'));
  assert.equal(check.where, 'Boat bx_fake'); assert.equal(check.tree, 'check'); assert.equal(check.passed, true);
});

test('split: localOnly files run here while the rest run on an SSH host; together they are the suite', () => {
  const { root, y, home } = project({ remote: { host: 'me@server', localOnly: ['tests/b.test.mjs'] } });
  const boat = fakeBoat();
  let r = xyz(root, ['test', '--remote', '--jobs', '2'], { cwd: y, env: boat.env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /split run: 1 file here \(localOnly\), 1 on me@server/);
  assert.match(r.out, /\[me@server\] # xyz test: 1 files — 0 from the buffer, 1 to run/);
  const last = JSON.parse(readFileSync(join(home, 'Z', 'tests', 'last.json'), 'utf8'));
  assert.equal(last.passed, true); assert.equal(last.files, 2); assert.equal(last.tests, 2);
  assert.equal(last.where, 'split: 1 here, 1 on me@server');
  assert.match(xyz(root, ['arrive'], { cwd: y }).out, /Tests: passed 2 .* split: 1 here, 1 on me@server/);
  // a failure here fails the whole
  writeFileSync(join(y, 'tests', 'b.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert';\ntest('b', () => assert.ok(false));\n"); age(y);
  r = xyz(root, ['test', '--remote', '--jobs', '2'], { cwd: y, env: boat.env });
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'Z', 'tests', 'last.json'), 'utf8')).failedFiles, ['tests/b.test.mjs']);
  assert.match(xyz(root, ['test', '--remote=not a host'], { cwd: y, env: boat.env }).out, /not a server name/);
});
