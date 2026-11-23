import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, symlinkSync, chmodSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, tree } from './helpers.mjs';
import { putBlob, getBlob } from '../src/store.mjs';
import { loadSkip, scan, diff } from '../src/scan.mjs';

const countStore = z => readdirSync(join(z, 'store')).flatMap(d => readdirSync(join(z, 'store', d))).length;

test('a blob goes in and comes back, and the same content is stored once', () => {
  const z = tmp('z-');
  const h1 = putBlob(z, Buffer.from('hello')), h2 = putBlob(z, Buffer.from('hello'));
  assert.equal(h1, h2);
  assert.equal(getBlob(z, h1).toString(), 'hello');
  assert.equal(countStore(z), 1);
});

test('a damaged blob is refused', () => {
  const z = tmp('z-');
  const h = putBlob(z, Buffer.from('hello'));
  const p = join(z, 'store', h.slice(0, 2), h.slice(2));
  const { gzipSync } = require_zlib();
  writeFileSync(p, gzipSync(Buffer.from('not hello')));
  assert.throws(() => getBlob(z, h), /store damaged/);
});

test('scan skips junk, runtime state, git and .gitignore entries', () => {
  const y = tree(tmp('y-'), {
    'src/a.js': 'a', 'node_modules/x.js': 'x', 'a.sqlite-wal': 'w', '.git/HEAD': 'h',
    'out/build.js': 'b', '.gitignore': 'out/\n# comment\n', 'logs/run.log': 'l',
  });
  const z = tmp('z-');
  const { files } = scan(y, z, { skip: ['node_modules', '.git', '*.sqlite*', '*.log'] });
  assert.deepEqual(Object.keys(files).sort(), ['.gitignore', 'src/a.js']);
});

test('a symlink is kept as a link, not followed', () => {
  const y = tree(tmp('y-'), { 'real.txt': 'r' }); const z = tmp('z-');
  symlinkSync('real.txt', join(y, 'link.txt'));
  const { files } = scan(y, z, { skip: [] });
  assert.equal(files['link.txt'].link, 'real.txt');
  assert.equal(files['link.txt'].hash, undefined);
});

test('an unreadable file is reported and the scan carries on', () => {
  const y = tree(tmp('y-'), { 'ok.txt': 'ok', 'secret.txt': 's' }); const z = tmp('z-');
  chmodSync(join(y, 'secret.txt'), 0o000);
  const { files, unreadable } = scan(y, z, { skip: [] });
  chmodSync(join(y, 'secret.txt'), 0o600);
  assert.ok(files['ok.txt']);
  assert.deepEqual(unreadable, ['secret.txt']);
});

test('names with spaces, unicode and leading dots survive', () => {
  const y = tree(tmp('y-'), { 'my file ü.txt': 'u', '.hidden': 'h' }); const z = tmp('z-');
  const { files } = scan(y, z, { skip: [] });
  assert.equal(getBlob(z, files['my file ü.txt'].hash).toString(), 'u');
  assert.ok(files['.hidden']);
});

test('an unchanged file is not re-read when size and time match', () => {
  const y = tree(tmp('y-'), { 'a.txt': 'a' }); const z = tmp('z-');
  const first = scan(y, z, { skip: [] }).files;
  const fake = { ...first, 'a.txt': { ...first['a.txt'], hash: 'remembered' } };
  assert.equal(scan(y, z, { skip: [], prev: fake }).files['a.txt'].hash, 'remembered');
});

test('diff names what was added, removed and changed', () => {
  const a = { 'x': { hash: '1' }, 'y': { hash: '2' }, 'l': { link: 't' } };
  const b = { 'y': { hash: '3' }, 'z': { hash: '4' }, 'l': { link: 'u' } };
  assert.deepEqual(diff(a, b), { added: ['z'], removed: ['x'], changed: ['l', 'y'] });
});

test('loadSkip matches plain names at any depth and simple globs', () => {
  const y = tmp('y-');
  const s = loadSkip(y, ['node_modules', '*.pyc']);
  assert.equal(s('a/node_modules', true), true);
  assert.equal(s('a/b.pyc', false), true);
  assert.equal(s('a/b.py', false), false);
});

function require_zlib() { return process.getBuiltinModule('node:zlib'); }

test('a folder inside Y that is its own git checkout or XYZ project is left out', () => {
  const y = tree(tmp('y-'), { 'a.txt': 'a', '.claude/worktrees/agent-1/.git': 'gitdir: /x', '.claude/worktrees/agent-1/a.txt': 'copy', 'sub/.xyz': '/home', 'sub/b.txt': 'b', 'lib/c.txt': 'c' });
  const { files } = scan(y, tmp('z-'), { skip: [] });
  assert.deepEqual(Object.keys(files).sort(), ['a.txt', 'lib/c.txt']);
});
