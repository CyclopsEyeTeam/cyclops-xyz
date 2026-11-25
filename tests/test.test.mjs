import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, utimesSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, tree, xyz } from './helpers.mjs';

// Files written just now would read as "changed while it ran": age the whole tree first.
function age(dir) {
  const old = new Date(Date.now() - 3600_000);
  for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) age(p); utimesSync(p, old, old); }
  utimesSync(dir, old, old);
}
function project(extra = {}, config = null) {
  const root = tmp('root-'), work = tmp('work-');
  const y = tree(join(work, 'Suite'), {
    'src/a.js': 'export const a = 1;\n', 'src/b.txt': 'bee\n',
    'tests/a.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert'; import { a } from '../src/a.js';\ntest('a', () => assert.equal(a, 1));\n",
    'tests/b.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert'; import { readFileSync } from 'node:fs';\ntest('b', () => assert.equal(readFileSync(new URL('../src/b.txt', import.meta.url), 'utf8'), 'bee\\n'));\n",
    ...extra,
  });
  xyz(root, ['adopt', y]);
  const home = readFileSync(join(y, '.xyz'), 'utf8').trim();
  if (config) { const f = join(home, 'xyz.json'), c = JSON.parse(readFileSync(f, 'utf8')); writeFileSync(f, JSON.stringify({ ...c, tests: config })); }
  age(y);
  return { root, y, home };
}
// the machine's real load must not change these tests: they say what it is
const run = (root, cwd, args = []) => xyz(root, ['test', '--jobs', '2', ...args], { cwd, env: { XYZ_TEST_LOAD: '0' } });

test('xyz test runs every file, then counts unchanged passes from the buffer and reruns only what a change touched', () => {
  const { root, y, home } = project();
  let r = run(root, y);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2 files — 0 from the buffer, 2 to run/);
  assert.match(r.out, /suite: 2 tests, 2 pass, 0 fail .* passed/);
  r = run(root, y);
  assert.match(r.out, /2 files — 2 from the buffer, 0 to run/, r.out);
  writeFileSync(join(y, 'src', 'b.txt'), 'bee\n'); // same content, new mtime: still buffered
  age(y);
  assert.match(run(root, y).out, /2 from the buffer/);
  writeFileSync(join(y, 'src', 'a.js'), 'export const a = 1; // touched\n'); age(y);
  r = run(root, y);
  assert.match(r.out, /1 from the buffer, 1 to run/); assert.match(r.out, /run tests\/a\.test\.mjs: changed: src\/a\.js/);
  const last = JSON.parse(readFileSync(join(home, 'Z', 'tests', 'last.json'), 'utf8'));
  assert.equal(last.tree, 'Y'); assert.equal(last.passed, true); assert.equal(last.ran, 1); assert.equal(last.fromBuffer, 1);
  assert.match(xyz(root, ['arrive'], { cwd: y }).out, /Tests: passed 2 · 1 ran, 1 buffered/);
  assert.match(run(root, y, ['--full']).out, /0 from the buffer, 2 to run/);
});

test('a failure is never buffered, exits 1, and is named in last.json; a spot check does not write last.json', () => {
  const { root, y, home } = project({ 'tests/c.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert';\ntest('c', () => assert.equal(1, 2));\n" });
  let r = run(root, y);
  assert.equal(r.code, 1); assert.match(r.out, /FAIL tests\/c\.test\.mjs/); assert.match(r.out, /NOT PASSED/);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'Z', 'tests', 'last.json'), 'utf8')).failedFiles, ['tests/c.test.mjs']);
  r = run(root, y);
  assert.match(r.out, /2 from the buffer, 1 to run/);
  const before = statSync(join(home, 'Z', 'tests', 'last.json')).mtimeMs;
  assert.equal(run(root, y, ['tests/a.test.mjs']).code, 0);
  assert.equal(statSync(join(home, 'Z', 'tests', 'last.json')).mtimeMs, before);
});

test('a lane shares the buffer with Y and says where it ran', () => {
  const { root, y, home } = project();
  run(root, y);
  const l = JSON.parse(xyz(root, ['lane', 'tests', '--who', 'claude-a', '--json'], { cwd: y }).out);
  const r = run(root, l.path);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /2 from the buffer, 0 to run/);
  const last = JSON.parse(readFileSync(join(home, 'Z', 'tests', 'last.json'), 'utf8'));
  assert.equal(last.tree, 'lane L1'); assert.equal(last.who, 'claude-a');
});

test('recorder "none" runs side by side without buffering; "strace" sees any program', () => {
  const none = project({}, { recorder: 'none' });
  run(none.root, none.y);
  assert.match(run(none.root, none.y).out, /0 from the buffer, 2 to run/);
  const st = project({ 'tests/s.sh': 'grep -q bee src/b.txt\n' }, { files: 'tests/*.sh', run: ['sh', '{file}'], recorder: 'strace' });
  let r = run(st.root, st.y); assert.equal(r.code, 0, r.out);
  r = run(st.root, st.y); assert.match(r.out, /1 files — 1 from the buffer/, r.out);
  writeFileSync(join(st.y, 'src', 'b.txt'), 'bee two\n'); age(st.y);
  r = run(st.root, st.y); assert.match(r.out, /run tests\/s\.sh: changed: src\/b\.txt/, r.out);
});

test('a busy machine: fewer jobs at the start, a bounded wait for quiet before judging alone, the load named on failure', () => {
  const { root, y, home } = project({ 'tests/c.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert';\ntest('c', () => assert.equal(1, 2));\n" });
  const env = { XYZ_TEST_LOAD: '100', XYZ_TEST_QUIET_WAIT_S: '1' };
  let r = xyz(root, ['test'], { cwd: y, env });
  assert.match(r.out, /side by side on up to \d+ jobs? \(1 for now: the machine is busy, load 100\.0/);
  assert.match(r.out, /failed alone at load 100\.0 .*one more try once the machine is quiet/);
  r = xyz(root, ['test', '--jobs', '2'], { cwd: y, env });
  assert.match(r.out, /waiting for the machine to quieten/);
  assert.match(r.out, /FAIL tests\/c\.test\.mjs \(exit 1, 1 failing; load 100\.0 on \d+ cores; still busy after 1s/);
  const last = JSON.parse(readFileSync(join(home, 'Z', 'tests', 'last.json'), 'utf8'));
  assert.equal(last.failedLoad['tests/c.test.mjs'], 100);
  assert.match(xyz(root, ['arrive'], { cwd: y }).out, /Tests: FAILED 1 \(tests\/c\.test\.mjs\) under load 100 on \d+ cores/);
});

test('the tree root itself is kept as ".", so a pass that listed the root counts in another copy of the tree', async () => {
  const { keyer } = await import('../src/test.mjs');
  const y = keyer('/w/Y'), check = keyer('/w/X/versions/s-1.tmp');
  const key = check.toKey('d', '/w/X/versions/s-1.tmp');
  assert.equal(key, 'd.');
  assert.deepEqual(y.fromKey(key), ['d', '/w/Y']);
  assert.equal(check.toKey('f', '/w/X/versions/s-1.tmp/src/a.js'), 'fsrc/a.js');
  assert.equal(check.toKey('f', '/elsewhere/x'), 'f/elsewhere/x');
});
