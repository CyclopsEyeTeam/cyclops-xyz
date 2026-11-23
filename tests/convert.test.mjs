import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmp, tree, xyz } from './helpers.mjs';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
function repo(dir, files) {
  tree(dir, files); git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'first steps');
  return dir;
}
const count = d => { let n = 0; const w = p => { for (const e of readdirSync(p, { withFileTypes: true })) e.isDirectory() ? w(join(p, e.name)) : n++; }; w(d); return n; };

test('a git folder comes in with its story, its unsaved work kept, and .git left alone', () => {
  const root = tmp('root-'), r = repo(join(tmp('w-'), 'Gitty'), { 'a.txt': 'a', 'README.md': '# Gitty\n\nA git project.\n' });
  writeFileSync(join(r, 'b.txt'), 'b'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'second steps');
  writeFileSync(join(r, 'a.txt'), 'unsaved edit');
  const head = git(r, 'rev-parse', 'HEAD'), files = count(join(r, '.git'));
  const c = xyz(root, ['convert', r]);
  assert.equal(c.code, 0, c.out);
  const rc = JSON.parse(xyz(root, ['receipts', '--json'], { cwd: r }).out)[0];
  assert.equal(rc.kind, 'convert');
  const md = readFileSync(rc.file, 'utf8');
  assert.match(md, /first steps/); assert.match(md, /second steps/); assert.match(md, /1 unsaved/);
  assert.ok(!rc.added.some(f => f.startsWith('.git/')));
  assert.equal(git(r, 'rev-parse', 'HEAD'), head); assert.equal(count(join(r, '.git')), files);
  assert.match(readFileSync(join(root, 'Gitty', 'Z', 'NOTES.md'), 'utf8'), /A git project/);
  const snap = JSON.parse(readFileSync(join(root, 'Gitty', 'Z', 'snapshots', `${rc.snapshot}.json`), 'utf8'));
  assert.ok(snap.files['a.txt'], 'the unsaved edit is in the first snapshot');
  assert.match(xyz(root, ['convert', r]).out, /already in XYZ/);
});

test('a folder with an online copy is left alone unless asked', () => {
  const root = tmp('root-'), r = repo(join(tmp('w-'), 'Online'), { 'a.txt': 'a' });
  git(r, 'remote', 'add', 'origin', 'https://example.invalid/x.git');
  const skip = xyz(root, ['convert', r]);
  assert.equal(skip.code, 1); assert.match(skip.out, /online copy/);
  assert.equal(existsSync(join(r, '.xyz')), false);
  assert.equal(xyz(root, ['convert', r, '--include-online']).code, 0);
});

test('convert --all brings in top-level projects only; git folders inside them are counted and skipped by the parent', () => {
  const root = tmp('root-'), w = tmp('w-');
  const parent = repo(join(w, 'Parent'), { 'p.txt': 'p' });
  repo(join(parent, 'var', 'tmp', 'version-x1'), { 'c.txt': 'c' });
  const r = JSON.parse(xyz(root, ['convert', '--all', w, '--json']).out);
  assert.deepEqual(JSON.parse(xyz(root, ['list', '--json']).out).map(x => x.name), ['Parent']);
  assert.equal(r.inside.length, 1);
  const pr = JSON.parse(xyz(root, ['receipts', '--json'], { cwd: parent }).out)[0];
  assert.ok(!pr.added.some(f => f.startsWith('var/tmp/version-x1')), 'parent does not store the inner git folder');
});

test('a broken .git folder and the scanned folder itself are never converted', () => {
  const root = tmp('root-'), w = tmp('w-');
  mkdirSync(join(w, '.git')); repo(join(w, 'Real'), { 'a.txt': 'a' });
  mkdirSync(join(w, 'Broken', '.git'), { recursive: true });
  const dry = JSON.parse(xyz(root, ['convert', '--all', w, '--dry-run', '--json']).out);
  assert.deepEqual(dry.convert.map(c => c.name), ['Real']);
  assert.ok(dry.skipped.some(s => s.path.endsWith('Broken') && /not a working git/.test(s.reason)));
});

test('worktree links and release copies are reported, not converted; dry-run changes nothing', () => {
  const root = tmp('root-'), w = tmp('w-');
  repo(join(w, 'Main'), { 'a.txt': 'a' });
  tree(join(w, 'Linked'), { 'x.txt': 'x', '.git': 'gitdir: /elsewhere/.git/worktrees/Linked\n' });
  repo(join(w, 'Thing', 'outputs', 'Thing'), { 'o.txt': 'o' });
  const dry = JSON.parse(xyz(root, ['convert', '--all', w, '--dry-run', '--json']).out);
  assert.deepEqual(dry.convert.map(c => c.name), ['Main']);
  assert.deepEqual(dry.skipped.map(s => s.reason).sort(), ['release copy', 'worktree link']);
  assert.equal(existsSync(root) && readdirSync(root).length, 0, 'dry-run made nothing');
  assert.equal(existsSync(join(w, 'Main', '.xyz')), false);
});
