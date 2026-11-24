import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, unlinkSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, tree, xyz } from './helpers.mjs';

const body = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

function project() {
  const root = tmp('root-'), work = tmp('work-');
  const y = tree(join(work, 'TeamApp'), { 'README.md': '# Team\n\nShared.\n', 'src/a.js': body(30), 'src/b.js': 'b\n', 'src/shared.js': body(30), 'node_modules/dep/i.js': 'd' });
  xyz(root, ['adopt', y]);
  return { root, y };
}
const lane = (root, y, why, who) => {
  const r = xyz(root, ['lane', why, '--who', who, '--json'], { cwd: y });
  assert.equal(r.code, 0, r.out); return JSON.parse(r.out);
};
const receipts = (root, y) => JSON.parse(xyz(root, ['receipts', '--json'], { cwd: y }).out);

test('two agents get two numbered lanes, each a full copy of Y with deps linked', () => {
  const { root, y } = project();
  const a = lane(root, y, 'team sharing', 'claude-a'), b = lane(root, y, 'pixel work', 'claude-b');
  assert.equal(a.id, 'L1'); assert.equal(b.id, 'L2');
  assert.equal(readFileSync(join(a.path, 'src', 'a.js'), 'utf8'), body(30));
  assert.ok(lstatSync(join(b.path, 'node_modules')).isSymbolicLink());
  const ls = xyz(root, ['lanes'], { cwd: y }).out;
  assert.match(ls, /L1\s+claude-a\s+"team sharing"/); assert.match(ls, /L2\s+claude-b\s+"pixel work"/);
  assert.match(xyz(root, ['arrive'], { cwd: y }).out, /Open lanes[\s\S]*L1[\s\S]*L2/);
  assert.match(xyz(root, ['arrive'], { cwd: a.path }).out, /You are in lane L1/);
});

test('lanes land in order, merge on top of each other, and each receipt has only that lane\'s files', () => {
  const { root, y } = project();
  const a = lane(root, y, 'team sharing', 'claude-a'), b = lane(root, y, 'pixel work', 'claude-b');
  writeFileSync(join(a.path, 'src', 'b.js'), 'b by A\n');
  writeFileSync(join(a.path, 'src', 'shared.js'), body(30).replace('line 2\n', 'line 2 by A\n'));
  writeFileSync(join(b.path, 'src', 'shared.js'), body(30).replace('line 28\n', 'line 28 by B\n'));
  writeFileSync(join(b.path, 'src', 'new.js'), 'new by B\n');
  writeFileSync(join(y, 'README.md'), '# Team\n\nsomeone else, unsaved\n'); // a third agent working straight in Y
  let r = xyz(root, ['land', '--json'], { cwd: a.path }); assert.equal(r.code, 0, r.out);
  r = xyz(root, ['land', 'pixel bits', '--json'], { cwd: b.path }); assert.equal(r.code, 0, r.out);
  const shared = readFileSync(join(y, 'src', 'shared.js'), 'utf8');
  assert.match(shared, /line 2 by A/); assert.match(shared, /line 28 by B/);
  assert.equal(readFileSync(join(y, 'src', 'b.js'), 'utf8'), 'b by A\n');
  assert.equal(readFileSync(join(y, 'src', 'new.js'), 'utf8'), 'new by B\n');
  const [rb, ra] = receipts(root, y);
  assert.equal(ra.who, 'claude-a'); assert.equal(ra.kind, 'land'); assert.deepEqual(ra.changed.sort(), ['src/b.js', 'src/shared.js']);
  assert.equal(rb.who, 'claude-b'); assert.deepEqual(rb.changed, ['src/shared.js']); assert.deepEqual(rb.added, ['src/new.js']);
  assert.match(rb.title, /L2 landed: pixel bits/);
  // the third agent's unsaved README is still theirs: still unsaved, still in Y
  assert.match(xyz(root, ['TeamApp'], { cwd: y }).out, /~ README\.md/);
  assert.ok(existsSync(a.path), 'landed from inside: the folder stays while a shell stands in it');
  assert.match(xyz(root, ['save', 'more'], { cwd: a.path }).out, /already landed[\s\S]*cd /);
  assert.equal(xyz(root, ['watch']).code, 0);
  assert.ok(!existsSync(a.path) && !existsSync(b.path), 'the auto-saver tidies landed lanes once nobody is in them');
  assert.match(xyz(root, ['lanes', '--all'], { cwd: y }).out, /L1\s+landed[\s\S]*L2\s+landed/);
});

test('same lines changed in two lanes: nothing is forced, the clash goes back to the later lane marked', () => {
  const { root, y } = project();
  const a = lane(root, y, 'one', 'claude-a'), b = lane(root, y, 'two', 'claude-b');
  writeFileSync(join(a.path, 'src', 'a.js'), body(30).replace('line 5\n', 'line 5 A\n'));
  writeFileSync(join(b.path, 'src', 'a.js'), body(30).replace('line 5\n', 'line 5 B\n'));
  writeFileSync(join(b.path, 'src', 'b.js'), 'b by B\n');
  assert.equal(xyz(root, ['land'], { cwd: a.path }).code, 0);
  const r = xyz(root, ['land'], { cwd: b.path });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /Nothing landed yet: 1 file/);
  assert.match(readFileSync(join(y, 'src', 'a.js'), 'utf8'), /line 5 A/);
  assert.equal(readFileSync(join(y, 'src', 'b.js'), 'utf8'), 'b\n', 'a clash means nothing from that lane lands');
  const marked = readFileSync(join(b.path, 'src', 'a.js'), 'utf8');
  assert.match(marked, /<<<<<<< Y \(landed before L2\)[\s\S]*line 5 A[\s\S]*line 5 B[\s\S]*>>>>>>> L2/);
  writeFileSync(join(b.path, 'src', 'a.js'), body(30).replace('line 5\n', 'line 5 A and B\n'));
  const again = xyz(root, ['land'], { cwd: b.path });
  assert.equal(again.code, 0, again.out); assert.match(again.out, /L2 landed in Y: 2 files/);
  assert.match(readFileSync(join(y, 'src', 'a.js'), 'utf8'), /line 5 A and B/);
  assert.equal(readFileSync(join(y, 'src', 'b.js'), 'utf8'), 'b by B\n');
});

test('a landed lane can be undone like any receipt, and removals land too', () => {
  const { root, y } = project();
  const a = lane(root, y, 'tidy', 'claude-a');
  unlinkSync(join(a.path, 'src', 'b.js'));
  writeFileSync(join(a.path, 'src', 'a.js'), 'short\n');
  assert.equal(xyz(root, ['land'], { cwd: a.path }).code, 0);
  assert.ok(!existsSync(join(y, 'src', 'b.js')));
  const id = receipts(root, y)[0].id;
  const u = xyz(root, ['undo', id, '--yes'], { cwd: y });
  assert.equal(u.code, 0, u.out);
  assert.equal(readFileSync(join(y, 'src', 'b.js'), 'utf8'), 'b\n');
  assert.equal(readFileSync(join(y, 'src', 'a.js'), 'utf8'), body(30));
});

test('inside a lane: save keeps it in Z, Y-only commands are refused, drop needs --yes', () => {
  const { root, y } = project();
  const a = lane(root, y, 'try things', 'claude-a');
  writeFileSync(join(a.path, 'src', 'b.js'), 'wip\n');
  const s = xyz(root, ['save', 'halfway'], { cwd: a.path });
  assert.equal(s.code, 0, s.out); assert.match(s.out, /Kept lane L1 in Z: 1 file/);
  assert.equal(receipts(root, y).length, 1, 'a lane save makes no receipt in Y');
  assert.match(xyz(root, ['promote'], { cwd: a.path }).out, /land it first/);
  assert.match(xyz(root, ['lane', 'again'], { cwd: a.path }).out, /already in lane L1/);
  assert.match(xyz(root, ['drop'], { cwd: a.path }).out, /--yes/);
  assert.equal(xyz(root, ['drop', '--yes'], { cwd: a.path }).code, 0);
  assert.match(xyz(root, ['lane', 'fresh start', '--who', 'claude-a'], { cwd: a.path }).out, /Lane L2 is yours/, 'a closed lane\'s folder doesn\'t block a new lane');
  writeFileSync(join(a.path, 'src', 'b.js'), 'typed after it closed\n');
  xyz(root, ['watch']);
  assert.ok(existsSync(a.path), 'changes made after closing are never tidied away');
  const kept = JSON.parse(readFileSync(join(root, 'TeamApp', 'Z', 'lanes', 'L1', 'checkpoint.json'), 'utf8'));
  assert.ok(kept['src/b.js'], 'the dropped lane\'s last state stays in Z');
  assert.equal(readFileSync(join(y, 'src', 'b.js'), 'utf8'), 'b\n');
});

test('the auto-saver keeps open lanes safe', () => {
  const { root, y } = project();
  const a = lane(root, y, 'long job', 'claude-a');
  writeFileSync(join(a.path, 'src', 'b.js'), 'precious\n');
  assert.equal(xyz(root, ['watch']).code, 0);
  const kept = JSON.parse(readFileSync(join(root, 'TeamApp', 'Z', 'lanes', 'L1', 'checkpoint.json'), 'utf8'));
  const base = JSON.parse(readFileSync(join(root, 'TeamApp', 'Z', 'lanes', 'L1', 'base.json'), 'utf8'));
  assert.notEqual(kept['src/b.js'].hash, base['src/b.js'].hash);
  assert.equal(receipts(root, y).length, 1, 'lane work never sneaks into Y receipts');
});

// ---- review fixes
test('land --keep never puts an older copy back over work another lane landed', () => {
  const { root, y } = project();
  const a = lane(root, y, 'long', 'claude-a'), b = lane(root, y, 'quick', 'claude-b');
  writeFileSync(join(b.path, 'src', 'b.js'), 'b by B\n');
  assert.equal(xyz(root, ['land'], { cwd: b.path }).code, 0);
  writeFileSync(join(a.path, 'src', 'a.js'), 'a by A\n');
  assert.equal(xyz(root, ['land', '--keep'], { cwd: a.path }).code, 0);
  assert.equal(readFileSync(join(a.path, 'src', 'b.js'), 'utf8'), 'b by B\n', 'the kept lane now matches Y');
  writeFileSync(join(a.path, 'src', 'new.js'), 'more A\n');
  assert.equal(xyz(root, ['land'], { cwd: a.path }).code, 0);
  assert.equal(readFileSync(join(y, 'src', 'b.js'), 'utf8'), 'b by B\n');
  assert.deepEqual(receipts(root, y)[0].added, ['src/new.js']);
});

test('a clash must really be settled: markers left or Y-side files undecided stop the next land', () => {
  const { root, y } = project();
  const a = lane(root, y, 'one', 'claude-a'), b = lane(root, y, 'two', 'claude-b');
  writeFileSync(join(a.path, 'src', 'a.js'), body(30).replace('line 5\n', 'line 5 A\n'));
  writeFileSync(join(b.path, 'src', 'a.js'), body(30).replace('line 5\n', 'line 5 B\n'));
  writeFileSync(join(a.path, 'src', 'b.js'), Buffer.from([0, 1, 2, 65]));
  writeFileSync(join(b.path, 'src', 'b.js'), Buffer.from([0, 9, 9, 66]));
  assert.equal(xyz(root, ['land'], { cwd: a.path }).code, 0);
  const r = xyz(root, ['land'], { cwd: b.path }); assert.match(r.out, /2 files clash/); assert.match(r.out, /src\/b\.js\.Y-L2/);
  assert.deepEqual([...readFileSync(join(b.path, 'src', 'b.js.Y-L2'))], [0, 1, 2, 65], "Y's side sits next to the lane's");
  const again = xyz(root, ['land'], { cwd: b.path });
  assert.equal(again.code, 1); assert.match(again.out, /isn't settled[\s\S]*markers[\s\S]*b\.js\.Y-L2/);
  assert.match(readFileSync(join(y, 'src', 'a.js'), 'utf8'), /line 5 A\n/); assert.doesNotMatch(readFileSync(join(y, 'src', 'a.js'), 'utf8'), /<<<<<<</);
  writeFileSync(join(b.path, 'src', 'a.js'), body(30).replace('line 5\n', 'line 5 AB\n'));
  unlinkSync(join(b.path, 'src', 'b.js.Y-L2')); // keep B's binary
  const done = xyz(root, ['land'], { cwd: b.path }); assert.equal(done.code, 0, done.out);
  assert.deepEqual([...readFileSync(join(y, 'src', 'b.js'))], [0, 9, 9, 66]);
  assert.ok(!existsSync(join(y, 'src', 'b.js.Y-L2')));
});

test('a file that becomes a folder lands whole', () => {
  const { root, y } = project();
  const a = lane(root, y, 'reshape', 'claude-a');
  unlinkSync(join(a.path, 'src', 'b.js')); mkdirSync(join(a.path, 'src', 'b.js')); writeFileSync(join(a.path, 'src', 'b.js', 'index.js'), 'inside\n');
  const r = xyz(root, ['land'], { cwd: a.path }); assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(y, 'src', 'b.js', 'index.js'), 'utf8'), 'inside\n');
});

test('drop L2 from inside L1 closes L2, and a closed lane can\'t be dropped again', () => {
  const { root, y } = project();
  const a = lane(root, y, 'one', 'claude-a'), b = lane(root, y, 'two', 'claude-b');
  assert.equal(xyz(root, ['drop', 'L2', '--yes'], { cwd: a.path }).code, 0);
  assert.ok(existsSync(a.path) && !existsSync(b.path));
  assert.match(xyz(root, ['drop', 'L2', '--yes'], { cwd: y }).out, /already dropped/);
});

test('unsaved edits in Y to a file the lane changes are kept under their own receipt first', () => {
  const { root, y } = project();
  const a = lane(root, y, 'one', 'claude-a');
  writeFileSync(join(a.path, 'src', 'shared.js'), body(30).replace('line 2\n', 'line 2 A\n'));
  writeFileSync(join(y, 'src', 'shared.js'), body(30).replace('line 29\n', 'line 29 by someone in Y\n'));
  assert.equal(xyz(root, ['land'], { cwd: a.path }).code, 0);
  const [mine, before] = receipts(root, y);
  assert.match(before.title, /Kept before L1 landed/); assert.deepEqual(before.changed, ['src/shared.js']);
  assert.equal(mine.who, 'claude-a');
  const u = xyz(root, ['undo', mine.id, '--yes'], { cwd: y }); assert.equal(u.code, 0, u.out);
  assert.match(readFileSync(join(y, 'src', 'shared.js'), 'utf8'), /line 29 by someone in Y/); assert.doesNotMatch(readFileSync(join(y, 'src', 'shared.js'), 'utf8'), /line 2 A/);
});

test('dependency folders in Y are never deleted by a landing after a clash', () => {
  const { root, y } = project();
  const cfg = join(root, 'TeamApp', 'xyz.json'); writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), deps: ['dist'] }));
  tree(y, { 'dist/out.js': 'built' });
  const a = lane(root, y, 'one', 'claude-a'), b = lane(root, y, 'two', 'claude-b');
  writeFileSync(join(a.path, 'src', 'a.js'), 'A\n'); writeFileSync(join(b.path, 'src', 'a.js'), 'B\n');
  xyz(root, ['land'], { cwd: a.path }); xyz(root, ['land'], { cwd: b.path });
  writeFileSync(join(b.path, 'src', 'a.js'), 'A and B\n');
  assert.equal(xyz(root, ['land'], { cwd: b.path }).code, 0);
  assert.equal(readFileSync(join(y, 'dist', 'out.js'), 'utf8'), 'built');
});

test('landing from inside a lane leaves the folder (so the shell keeps working) and says where Y is', () => {
  const { root, y } = project();
  const a = lane(root, y, 'one', 'claude-a');
  writeFileSync(join(a.path, 'src', 'b.js'), 'A\n');
  const r = xyz(root, ['land'], { cwd: a.path });
  assert.equal(r.code, 0, r.out); assert.match(r.out, new RegExp(`cd ${y}`));
  assert.ok(existsSync(a.path));
  assert.match(xyz(root, ['arrive'], { cwd: a.path }).out, /lane L1's old folder/);
  const fromY = lane(root, y, 'two', 'claude-a'); writeFileSync(join(fromY.path, 'src', 'b.js'), 'A2\n');
  assert.equal(xyz(root, ['land'], { cwd: fromY.path }).code, 0);
});

test('folders a landing empties are removed from Y; folders with other files stay', () => {
  const { root, y } = project();
  tree(y, { 'src/old/a.js': 'a', 'src/old/deep/b.js': 'b', 'src/keep/c.js': 'c', 'src/keep/d.js': 'd' });
  xyz(root, ['save', 'more files'], { cwd: y });
  const l = lane(root, y, 'remove old', 'claude-a');
  for (const f of ['src/old/a.js', 'src/old/deep/b.js', 'src/keep/c.js']) unlinkSync(join(l.path, f));
  const r = xyz(root, ['land'], { cwd: l.path }); assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(join(y, 'src', 'old')), 'the emptied folder tree is gone');
  assert.ok(existsSync(join(y, 'src', 'keep', 'd.js')) && !existsSync(join(y, 'src', 'keep', 'c.js')));
  assert.ok(existsSync(join(y, 'src')));
});

test('the last test-suite run in Z/tests shows in arrive and in xyz lanes; a broken file shows nothing', () => {
  const { root, y } = project();
  const a = lane(root, y, 'suite', 'claude-a');
  const home = join(a.path, '..', '..');
  assert.doesNotMatch(xyz(root, ['arrive'], { cwd: y }).out, /Tests:/);
  mkdirSync(join(home, 'Z', 'tests'), { recursive: true });
  writeFileSync(join(home, 'Z', 'tests', 'last.json'), JSON.stringify({ at: new Date(Date.now() - 3 * 60000).toISOString(), who: 'Claude', tree: 'lane L1', pass: 7657, fail: 0, ran: 40, fromBuffer: 686, passed: true }));
  writeFileSync(join(home, 'Z', 'tests', 'last-check.json'), JSON.stringify({ at: Date.now() - 3600000, tree: 'check', version: 6, fail: 2, failedFiles: ['x.test.mjs'], passed: false }));
  const ar = xyz(root, ['arrive'], { cwd: y }).out;
  assert.match(ar, /Tests: passed 7,657 · 40 ran, 686 buffered · 3 min ago · Claude, lane L1/);
  assert.match(ar, /Promote check: FAILED 2 \(x\.test\.mjs\) · 60 min ago · check, on v6/);
  assert.match(xyz(root, ['lanes'], { cwd: y }).out, /L1[\s\S]*Tests: passed 7,657/);
  writeFileSync(join(home, 'Z', 'tests', 'last.json'), '{broken');
  const r = xyz(root, ['arrive'], { cwd: a.path });
  assert.equal(r.code, 0); assert.doesNotMatch(r.out, /Tests:/); assert.match(r.out, /Promote check/);
});
