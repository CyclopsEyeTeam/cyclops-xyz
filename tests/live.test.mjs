import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readlinkSync, readdirSync, mkdirSync, chmodSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmp, tree, xyz } from './helpers.mjs';

function adopted(files, config = {}) {
  const root = tmp('root-'), folder = tree(join(tmp('work-'), 'LiveApp'), files);
  assert.equal(xyz(root, ['adopt', folder]).code, 0);
  const cfg = join(root, 'LiveApp', 'xyz.json');
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), ...config }));
  return { root, folder, home: join(root, 'LiveApp') };
}

// ---- try in RAM ----
test('try runs a command on a RAM copy of Y and cleans up', () => {
  const { root, folder } = adopted({ 'src/a.js': 'a', 'node_modules/dep/i.js': 'd' }, { deps: ['node_modules'] });
  const r = xyz(root, ['try', `node -e "const f=require('fs');process.exit(f.existsSync('src/a.js')&&f.existsSync('node_modules/dep/i.js')?0:3)"`], { cwd: folder });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(existsSync(join(root, '.ram')) ? readdirSync(join(root, '.ram')) : [], []);
  assert.match(xyz(root, ['liveapp']).out, /Last RAM try: .* passed/);
});

test("a failing try passes its exit code through and is remembered", () => {
  const { root, folder, home } = adopted({ 'a.txt': 'a' });
  const r = xyz(root, ['try', 'exit 7'], { cwd: folder });
  assert.equal(r.code, 7);
  const last = readFileSync(join(home, 'Z', 'tries.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
  assert.equal(last.ok, false); assert.equal(last.code, 7);
});

test('a project too big for RAM is refused with its size', () => {
  const { root, folder } = adopted({ 'big.bin': Buffer.alloc(2 * 1024 * 1024) }, { tryMaxMB: 1 });
  const r = xyz(root, ['try', 'true'], { cwd: folder });
  assert.equal(r.code, 1); assert.match(r.out, /2(\.\d)? MB/);
});

// ---- promote and rollback ----
test('promote makes Y live in X, and rollback goes back', () => {
  const { root, folder, home } = adopted({ 'app.js': 'v1' });
  assert.equal(xyz(root, ['promote', '--yes'], { cwd: folder }).code, 0);
  const v1 = readlinkSync(join(home, 'X', 'current'));
  assert.equal(readFileSync(join(home, 'X', 'current', 'app.js'), 'utf8'), 'v1');
  writeFileSync(join(folder, 'app.js'), 'v2');
  assert.equal(xyz(root, ['promote', '--yes'], { cwd: folder }).code, 0);
  assert.equal(readFileSync(join(home, 'X', 'current', 'app.js'), 'utf8'), 'v2');
  const rb = xyz(root, ['rollback', '--yes'], { cwd: folder });
  assert.equal(rb.code, 0, rb.out);
  assert.equal(readlinkSync(join(home, 'X', 'current')), v1);
  assert.equal(readFileSync(join(home, 'X', 'current', 'app.js'), 'utf8'), 'v1');
  assert.match(xyz(root, ['liveapp']).out, /Live: v1 /);
});

test('a failing check leaves X as it was', () => {
  const { root, folder, home } = adopted({ 'app.js': 'v1' }, { check: 'exit 1' });
  const r = xyz(root, ['promote', '--yes'], { cwd: folder });
  assert.equal(r.code, 1); assert.match(r.out, /check failed/i);
  assert.equal(existsSync(join(home, 'X', 'current')), false);
});

test('services are only restarted once they run from X', () => {
  const bin = tmp('bin-'), calls = join(bin, 'calls');
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> ${calls}\n`); chmodSync(join(bin, 'systemctl'), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const a = adopted({ 'app.js': 'v1' }, { services: ['demo.service'] });
  xyz(a.root, ['promote', '--yes'], { cwd: a.folder, env });
  assert.equal(existsSync(calls), false, 'no restart while services still run from Y');
  assert.match(xyz(a.root, ['liveapp']).out, /live services still run from Y/);
  const b = adopted({ 'app.js': 'v1' }, { services: ['demo.service'], servicesFromX: true });
  xyz(b.root, ['promote', '--yes'], { cwd: b.folder, env });
  assert.match(readFileSync(calls, 'utf8'), /--user restart demo\.service/);
});

test('rollback with nothing before says so', () => {
  const { root, folder } = adopted({ 'app.js': 'v1' });
  xyz(root, ['promote', '--yes'], { cwd: folder });
  const r = xyz(root, ['rollback', '--yes'], { cwd: folder });
  assert.equal(r.code, 1); assert.match(r.out, /nothing to roll back to/);
});

test('live versions have plain numbers', () => {
  const { root, folder } = adopted({ 'app.js': 'v1' });
  assert.match(xyz(root, ['promote'], { cwd: folder }).out, /Live now: v1\b/);
  writeFileSync(join(folder, 'app.js'), 'v2');
  assert.match(xyz(root, ['promote'], { cwd: folder }).out, /Live now: v2\b/);
  assert.match(xyz(root, ['rollback'], { cwd: folder }).out, /Live now: v1\b/);
  assert.match(xyz(root, ['liveapp']).out, /Live: v1 /);
});
