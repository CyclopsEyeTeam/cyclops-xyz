import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readlinkSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, xyz } from './helpers.mjs';

test('xyz new --single: one folder that is X, with Y and Z inside; save, promote, rollback, list and lanes all work', () => {
  const root = tmp('root-'), here = tmp('here-');
  let r = xyz(root, ['new', 'Solo', '--single'], { cwd: here });
  assert.equal(r.code, 0, r.out);
  const home = join(here, 'Solo');
  assert.match(r.out, /One folder: .*Solo is X \(live\), with Y and Z inside it/);
  assert.deepEqual(readdirSync(home).sort(), ['AGENTS.md', 'CLAUDE.md', 'Y', 'Z', 'xyz.json']);
  assert.equal(JSON.parse(readFileSync(join(home, 'xyz.json'), 'utf8')).layout, 'single');
  assert.ok(lstatSync(join(root, 'Solo')).isSymbolicLink(), 'the library keeps only a link');

  const y = join(home, 'Y');
  writeFileSync(join(y, 'app.txt'), 'one\n');
  assert.equal(xyz(root, ['save', 'first'], { cwd: y }).code, 0);
  r = xyz(root, ['promote'], { cwd: y });
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(home, 'current', 'app.txt'), 'utf8'), 'one\n', 'live sits in the folder itself');
  assert.ok(existsSync(join(home, 'versions')) && existsSync(join(home, 'history.jsonl')));

  writeFileSync(join(y, 'app.txt'), 'two\n');
  xyz(root, ['save', 'second'], { cwd: y });
  assert.equal(xyz(root, ['promote'], { cwd: y }).code, 0);
  assert.equal(readFileSync(join(home, 'current', 'app.txt'), 'utf8'), 'two\n');
  assert.equal(xyz(root, ['rollback'], { cwd: y }).code, 0);
  assert.equal(readFileSync(join(home, 'current', 'app.txt'), 'utf8'), 'one\n');

  // found by name and from the folder itself, and its status is not mistaken for a live copy
  assert.match(xyz(root, ['list']).out, /Solo .*· single: .*Solo/);
  assert.match(xyz(root, ['solo']).out, /Solo/);
  assert.match(xyz(root, ['status'], { cwd: home }).out, /Solo/);
  assert.doesNotMatch(xyz(root, ['status'], { cwd: y }).out, /copy/i);

  // an agent can start in the folder itself and stay there
  assert.match(xyz(root, ['arrive'], { cwd: home }).out, /Single project: this folder .* is X, the live app/);
  writeFileSync(join(y, 'more.txt'), 'm\n');
  r = xyz(root, ['save', 'from the folder'], { cwd: home });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /r-\d+/);
  // a lane, landed
  r = xyz(root, ['lane', 'tweak', '--who', 'tester'], { cwd: y });
  assert.equal(r.code, 0, r.out);
  const lane = r.out.match(/(\/\S+L1-\S+)/)[1];
  writeFileSync(join(lane, 'app.txt'), 'three\n');
  r = xyz(root, ['land', 'tweak done'], { cwd: lane });
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(y, 'app.txt'), 'utf8'), 'three\n');

  // an extract is a library-shaped home
  r = xyz(root, ['extract', '--to', join(here, 'solo.zip')], { cwd: y });
  assert.equal(r.code, 0, r.out);
});

test('the library stays the default', () => {
  const root = tmp('root-');
  const r = xyz(root, ['new', 'Lib']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(readdirSync(join(root, 'Lib')).sort(), ['X', 'Y', 'Z', 'xyz.json']);
  assert.equal(JSON.parse(readFileSync(join(root, 'Lib', 'xyz.json'), 'utf8')).layout, undefined);
});

test('a project by name in several words: xyz cyclops cli finds CyclopsCLI, and only it', () => {
  const root = tmp('root-');
  for (const n of ['CyclopsCLI', 'CyclopsChat']) xyz(root, ['new', n]);
  let r = xyz(root, ['cyclops', 'cli']);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /━━ CyclopsCLI ━━/); assert.doesNotMatch(r.out, /CyclopsChat/);
  assert.match(xyz(root, ['arrive', 'cyclops', 'cli']).out, /CyclopsCLI/);
  assert.match(xyz(root, ['status', 'cyclops', 'chat']).out, /━━ CyclopsChat ━━/);
  r = xyz(root, ['cyclops']);
  assert.equal(r.code, 1); assert.match(r.out, /could be CyclopsCLI, CyclopsChat/);
});
