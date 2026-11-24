import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp, tree, xyz } from './helpers.mjs';

function project(extra = {}) {
  const root = tmp('root-'), work = tmp('work-');
  const y = tree(join(work, 'Crew'), { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  xyz(root, ['adopt', y]);
  if (Object.keys(extra).length) { const f = join(root, 'Crew', 'xyz.json'); writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...extra })); }
  return { root, y, z: join(root, 'Crew', 'Z') };
}
const BIN = new URL('../bin/xyz.mjs', import.meta.url).pathname;
const hook = (root, ev, env = {}) => spawnSync(process.execPath, [BIN, 'touch', '--hook'], { input: JSON.stringify(ev), encoding: 'utf8', env: { ...process.env, XYZ_ROOT: root, XYZ_WHO: '', ...env } });

test('the edit hook signs files, and the auto-saver keeps one receipt per agent', () => {
  const { root, y } = project();
  writeFileSync(join(y, 'a.txt'), 'A\n'); hook(root, { session_id: 'aaaa1111', cwd: y, tool_input: { file_path: join(y, 'a.txt') } });
  writeFileSync(join(y, 'b.txt'), 'B\n'); hook(root, { session_id: 'bbbb2222', cwd: '/', tool_input: { file_path: join(y, 'b.txt') } });
  writeFileSync(join(y, 'c.txt'), 'C\n'); // nobody known
  const ch = xyz(root, ['changed'], { cwd: y }).out;
  assert.match(ch, /a\.txt\s+— claude-aaaa/); assert.match(ch, /b\.txt\s+— claude-bbbb/); assert.match(ch, /c\.txt\s+— \(not known\)/);
  assert.equal(xyz(root, ['watch']).code, 0);
  const rs = JSON.parse(xyz(root, ['receipts', '--json'], { cwd: y }).out).filter(r => r.kind === 'auto');
  const by = Object.fromEntries(rs.map(r => [r.who, [...r.changed]]));
  assert.deepEqual(by['claude-aaaa'], ['a.txt']); assert.deepEqual(by['claude-bbbb'], ['b.txt']); assert.deepEqual(by['xyz-watch'], ['c.txt']);
  const aId = rs.find(r => r.who === 'claude-aaaa').id;
  assert.equal(xyz(root, ['undo', aId, '--yes'], { cwd: y }).code, 0);
  assert.equal(readFileSync(join(y, 'a.txt'), 'utf8'), 'a\n'); assert.equal(readFileSync(join(y, 'b.txt'), 'utf8'), 'B\n');
  assert.equal(hook(root, { tool_input: {} }).status, 0, 'the hook never fails a session');
});

test('promote --saved ships only what is kept, checked on that copy; promote r-NNNN ships that state', () => {
  const { root, y } = project({ check: 'test "$(cat a.txt)" != broken' });
  writeFileSync(join(y, 'a.txt'), 'good\n'); xyz(root, ['save', 'good a'], { cwd: y });
  writeFileSync(join(y, 'a.txt'), 'broken'); // another agent's half-done work
  const r = xyz(root, ['promote', '--saved'], { cwd: y });
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(root, 'Crew', 'X', 'current', 'a.txt'), 'utf8'), 'good\n');
  assert.equal(readFileSync(join(y, 'a.txt'), 'utf8'), 'broken', 'Y untouched, still unsaved');
  const first = JSON.parse(xyz(root, ['receipts', '--json'], { cwd: y }).out).at(-1).id;
  assert.equal(xyz(root, ['promote', first], { cwd: y }).code, 0);
  assert.equal(readFileSync(join(root, 'Crew', 'X', 'current', 'a.txt'), 'utf8'), 'a\n');
});

test('a busy project says who holds it; save --learned with nothing changed still keeps the note', () => {
  const { root, y, z } = project();
  const start = readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
  writeFileSync(join(z, 'lock'), JSON.stringify({ pid: process.pid, start, token: 'x', at: Date.now() - 4000, who: 'claude-b', cmd: 'land' }));
  const r = xyz(root, ['save', 'x'], { cwd: y, env: { XYZ_LOCK_WAIT_MS: '200' } });
  assert.equal(r.code, 1); assert.match(r.out, /claude-b is running "xyz land" \(pid \d+, for \d+ s\)[\s\S]*--wait/);
  writeFileSync(join(z, 'lock'), '');
  const s = xyz(root, ['save', 'nothing', '--learned', 'the c file is generated'], { cwd: y });
  assert.match(s.out, /Nothing changed[\s\S]*Learned note added/);
  assert.match(readFileSync(join(z, 'MAP.md'), 'utf8'), /the c file is generated/);
});
