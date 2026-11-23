import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, tree } from './helpers.mjs';
import { save } from '../src/save.mjs';
import { planUndo, applyUndo } from '../src/undo.mjs';

const proj = files => {
  const home = tmp('u-'), y = join(home, 'Y'), z = join(home, 'Z');
  mkdirSync(y); mkdirSync(z); tree(y, files);
  const p = { name: 'U', home, x: join(home, 'X'), y, z, config: { skip: [] } };
  save(p, { kind: 'adopt', why: 'start', who: 't', force: true });
  return p;
};
const read = (p, f) => readFileSync(join(p.y, f), 'utf8');

test('undo reverses just that change and keeps later work on other files', () => {
  const p = proj({ 'a.txt': 'a1', 'b.txt': 'b1' });
  writeFileSync(join(p.y, 'a.txt'), 'a2'); const r = save(p, { why: 'edit a', who: 't' });
  writeFileSync(join(p.y, 'b.txt'), 'b2'); save(p, { why: 'edit b', who: 't' });
  const u = applyUndo(p, r.id, { who: 't' });
  assert.equal(read(p, 'a.txt'), 'a1');
  assert.equal(read(p, 'b.txt'), 'b2');
  assert.equal(u.kind, 'undo'); assert.match(u.why, new RegExp(r.id));
});

test('a deleted file comes back with its mode', () => {
  const p = proj({ 'notes/a b.txt': 'keep me', 'x.txt': 'x' });
  chmodSync(join(p.y, 'notes/a b.txt'), 0o755); save(p, { why: 'mode', who: 't' });
  unlinkSync(join(p.y, 'notes/a b.txt')); const r = save(p, { why: 'deleted it', who: 't' });
  applyUndo(p, r.id, { who: 't' });
  assert.equal(read(p, 'notes/a b.txt'), 'keep me');
  assert.equal(statSync(join(p.y, 'notes/a b.txt')).mode & 0o777, 0o755);
});

test('an added file is removed again', () => {
  const p = proj({ 'x.txt': 'x' });
  writeFileSync(join(p.y, 'new.txt'), 'n'); const r = save(p, { why: 'added', who: 't' });
  applyUndo(p, r.id, { who: 't' });
  assert.equal(existsSync(join(p.y, 'new.txt')), false);
});

test('when a later change touched the same file, undo stops and names it', () => {
  const p = proj({ 'a.txt': 'a1', 'c.txt': 'c1' });
  writeFileSync(join(p.y, 'a.txt'), 'a2'); writeFileSync(join(p.y, 'c.txt'), 'c2'); const r = save(p, { why: 'both', who: 't' });
  writeFileSync(join(p.y, 'a.txt'), 'a3'); const later = save(p, { why: 'again', who: 'gemini' });
  const plan = planUndo(p, r.id);
  assert.deepEqual(plan.blocked.map(b => [b.path, b.by.id]), [['a.txt', later.id]]);
  assert.throws(() => applyUndo(p, r.id, { who: 't' }), /a\.txt.*r-0003/s);
  assert.equal(read(p, 'c.txt'), 'c2', 'nothing changed when refused');
  applyUndo(p, r.id, { who: 't', skipChanged: true });
  assert.equal(read(p, 'c.txt'), 'c1'); assert.equal(read(p, 'a.txt'), 'a3');
});

test('an undo can itself be undone', () => {
  const p = proj({ 'a.txt': 'a1' });
  writeFileSync(join(p.y, 'a.txt'), 'a2'); const r = save(p, { why: 'edit', who: 't' });
  const u = applyUndo(p, r.id, { who: 't' });
  applyUndo(p, u.id, { who: 't' });
  assert.equal(read(p, 'a.txt'), 'a2');
});

test('unsaved edits are kept safe before an undo runs', () => {
  const p = proj({ 'a.txt': 'a1', 'b.txt': 'b1' });
  writeFileSync(join(p.y, 'a.txt'), 'a2'); const r = save(p, { why: 'edit', who: 't' });
  writeFileSync(join(p.y, 'b.txt'), 'unsaved work');
  applyUndo(p, r.id, { who: 't' });
  assert.equal(read(p, 'b.txt'), 'unsaved work');
  const rs = JSON.parse('[' + readFileSync(join(p.z, 'receipts.jsonl'), 'utf8').trim().split('\n').join(',') + ']');
  assert.ok(rs.some(x => x.kind === 'auto' && x.changed.includes('b.txt') && /before undo/.test(x.why)), 'the unsaved edit got its own receipt first');
});

test('the very first receipt can not be undone (it would empty the folder)', () => {
  const p = proj({ 'a.txt': 'a1' });
  assert.throws(() => applyUndo(p, 'r-0001', { who: 't' }), /first/);
  assert.equal(read(p, 'a.txt'), 'a1');
});
