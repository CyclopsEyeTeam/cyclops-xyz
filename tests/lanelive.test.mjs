import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmp, tree, xyz } from './helpers.mjs';

const body = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
function project() {
  const root = tmp('root-'), work = tmp('work-');
  const y = tree(join(work, 'LiveApp'), { 'src/a.js': body(20), 'src/b.js': body(20) });
  xyz(root, ['adopt', y]);
  const home = readFileSync(join(y, '.xyz'), 'utf8').trim();
  assert.equal(xyz(root, ['promote', '--yes'], { cwd: y }).code, 0);
  return { root, y, home, live: rel => readFileSync(join(home, 'X', 'current', rel), 'utf8') };
}
const lane = (root, y, why, who) => JSON.parse(xyz(root, ['lane', why, '--who', who, '--json'], { cwd: y }).out);

test('xyz promote L1: live + only that lane\'s work goes live; Y\'s other landed work does not ride along', () => {
  const { root, y, live } = project();
  const a = lane(root, y, 'fix a', 'claude-a');
  writeFileSync(join(a.path, 'src', 'a.js'), body(20).replace('line 3\n', 'line 3 from L1\n'));
  writeFileSync(join(y, 'src', 'b.js'), body(20).replace('line 9\n', 'line 9 from Y\n'));
  assert.equal(xyz(root, ['save', 'other work in Y', '--who', 'codex'], { cwd: y }).code, 0);
  const r = xyz(root, ['promote', 'L1', '--who', 'claude-a'], { cwd: y });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Live now: v2/); assert.match(r.out, /lane L1 \(claude-a, "fix a": 1 file\) on top of v1/);
  assert.match(live('src/a.js'), /line 3 from L1/);
  assert.doesNotMatch(live('src/b.js'), /from Y/);
  assert.doesNotMatch(readFileSync(join(y, 'src', 'a.js'), 'utf8'), /from L1/, 'Y is untouched until the lane lands');
  assert.match(xyz(root, ['lanes'], { cwd: y }).out, /L1 .* live \(r-\d+\), not landed in Y yet/);
  // promoting Y now would take L1's work back out of X: refused unless --yes
  const y2 = xyz(root, ['promote'], { cwd: y });
  assert.equal(y2.code, 1); assert.match(y2.out, /L1 \(claude-a\) is live but not landed in Y yet/);
  // once it lands, Y has it and promoting Y is fine again
  assert.equal(xyz(root, ['land'], { cwd: a.path }).code, 0);
  const y3 = xyz(root, ['promote'], { cwd: y });
  assert.equal(y3.code, 0, y3.out);
  assert.match(live('src/a.js'), /from L1/); assert.match(live('src/b.js'), /from Y/);
});

test('inside a lane, xyz promote makes that lane live; lanes stack on what is live; a real clash refuses', () => {
  const { root, y, live } = project();
  const a = lane(root, y, 'one', 'claude-a'), b = lane(root, y, 'two', 'codex');
  writeFileSync(join(a.path, 'src', 'a.js'), body(20).replace('line 2\n', 'line 2 A\n'));
  writeFileSync(join(b.path, 'src', 'a.js'), body(20).replace('line 18\n', 'line 18 B\n'));
  let r = xyz(root, ['promote', '--who', 'claude-a'], { cwd: a.path });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /from L1|lane L1/);
  r = xyz(root, ['promote', '--who', 'codex'], { cwd: b.path });
  assert.equal(r.code, 0, r.out);
  assert.match(live('src/a.js'), /line 2 A[\s\S]*line 18 B/, 'L2 went live on top of L1 (merged line by line)');
  const c = lane(root, y, 'three', 'claude-c');
  writeFileSync(join(c.path, 'src', 'a.js'), body(20).replace('line 2\n', 'line 2 C\n'));
  r = xyz(root, ['promote'], { cwd: c.path });
  assert.equal(r.code, 1); assert.match(r.out, /nothing went live: L3 changes a file that also changed in what's live/);
  assert.match(live('src/a.js'), /line 2 A/);
});

test('one full check at a time: xyz test waits for the turn, says who it waits for, then runs', async () => {
  const { root, y, home } = project();
  tree(y, { 'tests/a.test.mjs': "import { test } from 'node:test'; test('a', () => {});\n" });
  const holder = spawn('sleep', ['3']);
  const start = readFileSync(`/proc/${holder.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
  mkdirSync(join(home, 'Z', 'queue'), { recursive: true });
  writeFileSync(join(home, 'Z', 'queue', `${String(Date.now() - 60000).padStart(15, '0')}-${holder.pid}.json`), JSON.stringify({ pid: holder.pid, start, at: Date.now() - 60000, who: 'codex', label: 'promote L4' }));
  const t0 = Date.now();
  const r = xyz(root, ['test', '--jobs', '1'], { cwd: y, env: { XYZ_TEST_LOAD: '0' } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /waiting for my turn \(1 ahead\): codex's promote L4 started 1 min ago/);
  assert.match(r.out, /my turn now/);
  assert.ok(Date.now() - t0 > 1500, 'it really waited');
  // a spot check never waits
  holder.kill();
});

test('a promote whose check runs xyz test does not wait behind itself (it holds the turn)', () => {
  const { root, y, home } = project();
  tree(y, { 'tests/a.test.mjs': "import { test } from 'node:test'; test('a', () => {});\n" });
  const BIN = new URL('../bin/xyz.mjs', import.meta.url).pathname;
  const cf = join(home, 'xyz.json'), c = JSON.parse(readFileSync(cf, 'utf8'));
  writeFileSync(cf, JSON.stringify({ ...c, check: `"${process.execPath}" "${BIN}" test --jobs 1` }));
  for (const args of [['promote', '--yes'], ['promote', '--saved']]) {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: y, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, XYZ_ROOT: root, XYZ_RAM: join(root, '.ram'), XYZ_WHO: '', XYZ_CHECK_COPY: '', XYZ_VERSION: '', XYZ_HOME: '', XYZ_Y: '', XYZ_IN_TURN: '', XYZ_TEST_LOAD: '0' } });
    assert.equal(r.status, 0, `${args.join(' ')} hung or failed: ${r.error?.code ?? ''} ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stderr, /waiting for my turn/);
  }
});
