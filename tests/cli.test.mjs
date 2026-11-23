import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, writeFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, tree, xyz } from './helpers.mjs';

function fixture() {
  const root = tmp('root-'), work = tmp('work-');
  const folder = tree(join(work, 'FixtureApp'), { 'README.md': '# Fixture App\n\nA tiny app for tests.\n', 'src/a.js': 'a', 'node_modules/dep/index.js': 'd' });
  return { root, folder };
}

test('adopt brings a folder in where it is', () => {
  const { root, folder } = fixture();
  const r = xyz(root, ['adopt', folder, '--who', 'claude']);
  assert.equal(r.code, 0, r.out);
  const home = join(root, 'FixtureApp');
  assert.equal(readlinkSync(join(home, 'Y')), folder);
  assert.ok(existsSync(join(home, 'X')) && existsSync(join(home, 'Z', 'NOTES.md')) && existsSync(join(home, 'xyz.json')));
  assert.equal(readFileSync(join(folder, '.xyz'), 'utf8').trim(), home);
  const rs = JSON.parse(xyz(root, ['receipts', '--json'], { cwd: folder }).out);
  assert.equal(rs[0].id, 'r-0001'); assert.equal(rs[0].kind, 'adopt');
  assert.ok(!rs[0].added.some(f => f.startsWith('node_modules')));
  assert.match(xyz(root, ['adopt', folder]).out, /already in XYZ/);
});

test('the project view answers to loose names and from inside the folder', () => {
  const { root, folder } = fixture(); xyz(root, ['adopt', folder]);
  const views = [['--fixture-app'], ['fixture-app'], ['FixtureApp'], ['app']].map(a => xyz(root, a));
  for (const v of views) { assert.equal(v.code, 0, v.out); assert.match(v.out, /Y: /); assert.match(v.out, /Z: /); assert.match(v.out, /nothing promoted yet/); assert.match(v.out, /A tiny app for tests/); }
  assert.match(xyz(root, [], { cwd: join(folder, 'src') }).out, /FixtureApp/);
});

test('unsaved changes show, and save records who and why', () => {
  const { root, folder } = fixture(); xyz(root, ['adopt', folder]);
  writeFileSync(join(folder, 'src', 'a.js'), 'changed');
  assert.match(xyz(root, ['fixtureapp']).out, /src\/a\.js/);
  const s = xyz(root, ['save', 'fixed it', '--who', 'claude'], { cwd: folder });
  assert.equal(s.code, 0, s.out);
  const r = JSON.parse(xyz(root, ['receipts', '--json'], { cwd: folder }).out)[0];
  assert.equal(r.who, 'claude'); assert.equal(r.why, 'fixed it');
  assert.match(xyz(root, ['show', 'r-0002'], { cwd: folder }).out, /why: fixed it/);
});

test('a mistyped command says did you mean, and exits 1', () => {
  const { root } = fixture();
  const r = xyz(root, ['recipts']);
  assert.equal(r.code, 1); assert.match(r.out, /did you mean.*receipts/i);
});

test('new makes X, Y and Z with a notes file', () => {
  const { root } = fixture();
  const r = xyz(root, ['new', 'Demo']);
  assert.equal(r.code, 0, r.out);
  for (const d of ['X', 'Y', 'Z']) assert.ok(lstatSync(join(root, 'Demo', d)).isDirectory());
  assert.ok(existsSync(join(root, 'Demo', 'Z', 'NOTES.md')));
  assert.match(xyz(root, ['list']).out, /Demo/);
});

test('help lists every command in plain words', () => {
  const r = xyz(tmp('root-'), ['help']);
  for (const c of ['new', 'adopt', 'convert', 'save', 'undo', 'try', 'promote', 'rollback', 'receipts', 'list']) assert.match(r.out, new RegExp(`xyz ${c}`));
});
