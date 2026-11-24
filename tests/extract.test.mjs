import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, symlinkSync, readlinkSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp, tree, xyz } from './helpers.mjs';

test('extract zips X, Y and Z as a project home, and unzipping it into another root brings the project back', () => {
  const root = tmp('root-'), work = tmp('work-');
  const y = tree(join(work, 'Boxed'), { 'README.md': '# Boxed\n\nA boxed app.\n', 'src/a.js': 'a\n', 'node_modules/dep/i.js': 'skip me' });
  symlinkSync('src/a.js', join(y, 'link-to-a'));
  xyz(root, ['adopt', y]);
  writeFileSync(join(y, 'src', 'a.js'), 'a2\n'); xyz(root, ['save', 'second', '--who', 'claude'], { cwd: y });
  xyz(root, ['promote'], { cwd: y });
  writeFileSync(join(y, 'src', 'b.js'), 'unsaved\n');
  const dest = tmp('out-');
  const r = xyz(root, ['extract', '--to', dest, '--with-live', '--json'], { cwd: y });
  assert.equal(r.code, 0, r.out);
  const info = JSON.parse(r.out);
  assert.ok(info.file.startsWith(dest) && existsSync(info.file)); assert.equal(info.unsaved, 1); assert.ok(info.live);
  const list = spawnSync('unzip', ['-Z1', info.file], { encoding: 'utf8' }).stdout.split('\n');
  assert.ok(list.includes('Boxed/Y/src/a.js') && list.includes('Boxed/Z/NOTES.md') && list.includes('Boxed/xyz.json') && list.includes('Boxed/README-XYZ.txt') && list.includes('Boxed/X/live/src/a.js'));
  assert.ok(!list.some(f => f.includes('node_modules')), 'skipped like a save');
  // bring it back in a fresh root
  const root2 = tmp('root2-');
  assert.equal(spawnSync('unzip', ['-q', info.file, '-d', root2]).status, 0);
  assert.ok(lstatSync(join(root2, 'Boxed', 'Y', 'link-to-a')).isSymbolicLink(), 'links in Y stay links');
  assert.equal(readFileSync(join(root2, 'Boxed', 'Y', 'src', 'b.js'), 'utf8'), 'unsaved\n');
  const v = xyz(root2, ['Boxed'], { cwd: root2 });
  assert.equal(v.code, 0, v.out); assert.match(v.out, /second/); assert.match(v.out, /~?\+? ?src\/b\.js|Unsaved in Y: 1/);
  const rs = JSON.parse(xyz(root2, ['receipts', '--json'], { cwd: join(root2, 'Boxed', 'Y') }).out);
  assert.equal(rs.find(x => x.why === 'second').who, 'claude');
  const u = xyz(root2, ['undo', rs.find(x => x.why === 'second').id, '--yes'], { cwd: join(root2, 'Boxed', 'Y') });
  assert.equal(u.code, 0, u.out); assert.equal(readFileSync(join(root2, 'Boxed', 'Y', 'src', 'a.js'), 'utf8'), 'a\n', 'undo history came along');
});

test('extract refuses to write into Y or over a file, and defaults to <root>/exports', () => {
  const root = tmp('root-'), work = tmp('work-');
  const y = tree(join(work, 'Plain'), { 'a.txt': 'a' });
  xyz(root, ['adopt', y]);
  assert.match(xyz(root, ['extract', '--to', join(y, 'x.zip')], { cwd: y }).out, /can't go inside Y/);
  const r = JSON.parse(xyz(root, ['extract', '--json'], { cwd: y }).out);
  assert.ok(r.file.startsWith(join(root, 'exports') + '/'));
  assert.match(xyz(root, ['extract', '--to', r.file], { cwd: y }).out, /already exists/);
  assert.match(xyz(root, ['list']).out, /Plain/); assert.doesNotMatch(xyz(root, ['list']).out, /exports/);
});
