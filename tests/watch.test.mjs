import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, readFileSync, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, tree, xyz } from './helpers.mjs';

test('the auto-saver keeps only projects that changed, and one broken project does not stop the rest', () => {
  const root = tmp('root-'), work = tmp('work-');
  const a = tree(join(work, 'Alpha'), { 'a.txt': 'a' }), b = tree(join(work, 'Beta'), { 'b.txt': 'b' }), c = tree(join(work, 'Gone'), { 'c.txt': 'c' });
  for (const f of [a, b, c]) assert.equal(xyz(root, ['adopt', f]).code, 0);
  rmSync(c, { recursive: true });
  writeFileSync(join(a, 'a.txt'), 'changed');
  const r = JSON.parse(xyz(root, ['watch', '--json']).out);
  const by = Object.fromEntries(r.map(x => [x.project, x]));
  assert.equal(by.Alpha.receipt.kind, 'auto'); assert.deepEqual(by.Alpha.receipt.changed, ['a.txt']);
  assert.equal(by.Beta.receipt, null);
  assert.ok(by.Gone.error);
  const again = JSON.parse(xyz(root, ['watch', '--json']).out);
  assert.ok(again.every(x => !x.receipt));
});

test('new --at makes the project there and links it from the root', () => {
  const root = tmp('root-'), desk = tmp('desk-');
  const r = xyz(root, ['new', 'Doodle', '--at', desk]);
  assert.equal(r.code, 0, r.out);
  for (const d of ['X', 'Y', 'Z']) assert.ok(lstatSync(join(desk, 'Doodle', d)).isDirectory());
  assert.ok(existsSync(join(desk, 'Doodle', 'Z', 'NOTES.md')) && existsSync(join(desk, 'Doodle', 'xyz.json')));
  assert.equal(readlinkSync(join(root, 'Doodle')), join(desk, 'Doodle'));
  assert.match(xyz(root, ['doodle']).out, /Doodle/);
  const again = xyz(root, ['new', 'Doodle', '--at', desk]);
  assert.equal(again.code, 1); assert.match(again.out, /already exists/);
});
