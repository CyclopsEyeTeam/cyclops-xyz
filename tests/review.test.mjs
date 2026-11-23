// Tests written from the final review's findings (C = critical, I = important). Each failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync, mkdirSync, symlinkSync, rmSync, appendFileSync, truncateSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmp, tree, xyz } from './helpers.mjs';
import { save } from '../src/save.mjs';
import { applyUndo, planUndo } from '../src/undo.mjs';
import { scan } from '../src/scan.mjs';
import { listReceipts, nextId } from '../src/receipts.mjs';
import { putBlob, getBlob } from '../src/store.mjs';
import { DEFAULT_SKIP } from '../src/project.mjs';
import { withLock } from '../src/lock.mjs';

const proj = (files, skip = []) => {
  const home = tmp('rv-'), y = join(home, 'Y'), z = join(home, 'Z');
  mkdirSync(y); mkdirSync(z); tree(y, files);
  const p = { name: 'R', home, x: join(home, 'X'), y, z, config: { skip, deps: [], services: [] } };
  save(p, { kind: 'adopt', why: 'start', who: 't', force: true });
  return p;
};

test('C1: undo never writes through a folder that has become a link', () => {
  const p = proj({ 'out/a.txt': 'a', 'k.txt': 'k' }), elsewhere = tmp('else-');
  unlinkSync(join(p.y, 'out/a.txt')); const r = save(p, { why: 'del', who: 't' });
  rmSync(join(p.y, 'out'), { recursive: true }); symlinkSync(elsewhere, join(p.y, 'out'));
  writeFileSync(join(elsewhere, 'a.txt'), 'precious');
  assert.throws(() => applyUndo(p, r.id, { who: 't' }), /link/);
  assert.equal(readFileSync(join(elsewhere, 'a.txt'), 'utf8'), 'precious');
});

test('C2a: a file that is now ignored but still on disk is not overwritten by undo', () => {
  const p = proj({ 'config.local.json': 'v1', 'k.txt': 'k' });
  writeFileSync(join(p.y, '.gitignore'), 'config.local.json\n'); const r = save(p, { why: 'ignore it', who: 't' });
  writeFileSync(join(p.y, 'config.local.json'), 'v2 precious');
  assert.throws(() => applyUndo(p, r.id, { who: 't' }), /not tracked/);
  assert.equal(readFileSync(join(p.y, 'config.local.json'), 'utf8'), 'v2 precious');
});

test('C2b: a file that cannot be read is not counted as removed', () => {
  const p = proj({ 'secret.txt': 'v1', 'k.txt': 'k' });
  chmodSync(join(p.y, 'secret.txt'), 0o000);
  writeFileSync(join(p.y, 'k.txt'), 'k2'); const r = save(p, { why: 'k', who: 't' });
  chmodSync(join(p.y, 'secret.txt'), 0o600);
  assert.ok(!r.removed.includes('secret.txt'));
});

test('C2c: a sub-folder that became its own checkout is not overwritten by undo', () => {
  const p = proj({ 'lib/util.js': 'v1', 'k.txt': 'k' });
  mkdirSync(join(p.y, 'lib/.git')); const r = save(p, { why: 'lib is its own now', who: 't' });
  writeFileSync(join(p.y, 'lib/util.js'), 'v2 precious');
  assert.throws(() => applyUndo(p, r.id, { who: 't' }), /not tracked/);
  assert.equal(readFileSync(join(p.y, 'lib/util.js'), 'utf8'), 'v2 precious');
});

test('I1: .gitignore negation works, last matching rule wins', () => {
  const y = tree(tmp('y-'), { '.gitignore': '/*\n!/src\n!.gitignore\n', 'src/a.js': 'a', 'junk.txt': 'j', '.env': 'e', '.env.example': 'x' });
  assert.deepEqual(Object.keys(scan(y, tmp('z-'), { skip: [] }).files).sort(), ['.gitignore', 'src/a.js']);
  const y2 = tree(tmp('y-'), { '.gitignore': '.env*\n!.env.example\n', '.env': 'e', '.env.example': 'x' });
  assert.deepEqual(Object.keys(scan(y2, tmp('z-'), { skip: [] }).files).sort(), ['.env.example', '.gitignore']);
});

test('I2: lock files of package managers are kept; sqlite3 and duckdb databases are not', () => {
  const y = tree(tmp('y-'), { 'yarn.lock': 'y', 'Cargo.lock': 'c', 'db.sqlite3': 'd', 'db.sqlite3-wal': 'w', 'a.duckdb': 'd', 'x.db-journal': 'j', 'run.pid': '1' });
  assert.deepEqual(Object.keys(scan(y, tmp('z-'), { skip: DEFAULT_SKIP }).files).sort(), ['Cargo.lock', 'yarn.lock']);
});

test('I3: .gitignore files in sub-folders count, and ** spans levels', () => {
  const y = tree(tmp('y-'), { 'web/.gitignore': 'dist/\n', 'web/dist/big.js': 'b', 'web/app.js': 'a', '.gitignore': 'a/**/*.out\n', 'a/b/c/gen.out': 'g', 'a/keep.js': 'k' });
  assert.deepEqual(Object.keys(scan(y, tmp('z-'), { skip: [] }).files).sort(), ['.gitignore', 'a/keep.js', 'web/.gitignore', 'web/app.js']);
});

function adoptedLive(files, config) {
  const root = tmp('root-'), folder = tree(join(tmp('work-'), 'LiveApp'), files);
  xyz(root, ['adopt', folder]);
  const cfg = join(root, 'LiveApp', 'xyz.json');
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), ...config }));
  return { root, folder, home: join(root, 'LiveApp') };
}

test('I4: a failed service restart still leaves a receipt, history, and a working rollback', () => {
  const bin = tmp('bin-'); writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n'); chmodSync(join(bin, 'systemctl'), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const a = adoptedLive({ 'app.js': 'v1' }, {});
  xyz(a.root, ['promote'], { cwd: a.folder });
  const cfg = join(a.home, 'xyz.json'); writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), services: ['bad.service'], servicesFromX: true }));
  writeFileSync(join(a.folder, 'app.js'), 'v2');
  const r = xyz(a.root, ['promote'], { cwd: a.folder, env });
  assert.equal(r.code, 1); assert.match(r.out, /restart failed/i);
  assert.match(xyz(a.root, ['liveapp']).out, /Live: v2 /);
  assert.equal(xyz(a.root, ['rollback'], { cwd: a.folder, env }).code, 1); // restart fails again, but X still switched
  assert.equal(readFileSync(join(a.home, 'X', 'current', 'app.js'), 'utf8'), 'v1');
});

test('I5: rollback returns to what was live before, not a version already rolled away from', () => {
  const a = adoptedLive({ 'app.js': 'A' }, {});
  const promote = body => { writeFileSync(join(a.folder, 'app.js'), body); return xyz(a.root, ['promote'], { cwd: a.folder }); };
  promote('A'); promote('B'); xyz(a.root, ['rollback'], { cwd: a.folder });
  promote('C'); xyz(a.root, ['rollback'], { cwd: a.folder });
  assert.equal(readFileSync(join(a.home, 'X', 'current', 'app.js'), 'utf8'), 'A');
});

test('I6: a stale lock taken over by many processes at once is held by only one at a time', async () => {
  const z = tmp('lock-'), log = join(z, 'inside.log');
  for (let round = 0; round < 8; round++) {
    writeFileSync(join(z, 'lock'), JSON.stringify({ pid: 999999, at: Date.now() }));
    const code = `import('${new URL('../src/lock.mjs', import.meta.url).href}').then(({ withLock }) => withLock(${JSON.stringify(z)}, () => { const fs = require('fs'); fs.appendFileSync(${JSON.stringify(log)}, 'in\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30); fs.appendFileSync(${JSON.stringify(log)}, 'out\\n'); }))`;
    await Promise.all(Array.from({ length: 5 }, () => new Promise(res => spawn(process.execPath, ['-e', code]).on('close', res))));
  }
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  for (let i = 0; i < lines.length; i += 2) assert.deepEqual(lines.slice(i, i + 2), ['in', 'out'], `overlap at ${i}`);
  assert.equal(lines.length, 80);
});

test('I6: an empty lock file left by a crash is taken over', () => {
  const z = tmp('lock-'); writeFileSync(join(z, 'lock'), '');
  const past = (Date.now() - 60000) / 1000; process.getBuiltinModule('node:fs').utimesSync(join(z, 'lock'), past, past);
  assert.equal(withLock(z, () => 'ok', { waitMs: 3000 }), 'ok');
});

test('I7: undo that turns a folder back into a file works, and leaves no temp files', () => {
  const p = proj({ 'notes': 'a file', 'k.txt': 'k' });
  unlinkSync(join(p.y, 'notes')); tree(p.y, { 'notes/a.md': 'now a folder' }); const r = save(p, { why: 'file to folder', who: 't' });
  applyUndo(p, r.id, { who: 't' });
  assert.equal(readFileSync(join(p.y, 'notes'), 'utf8'), 'a file');
  assert.deepEqual(readdirSync(p.y).filter(f => f.endsWith('.tmp')), []);
});

test('I7: a damaged blob stops the undo before anything changes', () => {
  const p = proj({ 'a.txt': 'a1', 'b.txt': 'b1' });
  writeFileSync(join(p.y, 'a.txt'), 'a2'); writeFileSync(join(p.y, 'b.txt'), 'b2'); const r = save(p, { why: 'both', who: 't' });
  const snap = JSON.parse(readFileSync(join(p.z, 'snapshots', `${r.before}.json`), 'utf8'));
  const h = snap.files['b.txt'].hash; writeFileSync(join(p.z, 'store', h.slice(0, 2), h.slice(2)), 'junk');
  assert.throws(() => applyUndo(p, r.id, { who: 't' }), /damaged/);
  assert.equal(readFileSync(join(p.y, 'a.txt'), 'utf8'), 'a2');
});

test('I8: a torn last line in receipts.jsonl does not swallow the next receipt', () => {
  const p = proj({ 'a.txt': 'a' });
  appendFileSync(join(p.z, 'receipts.jsonl'), '{"id":"r-00');
  writeFileSync(join(p.y, 'a.txt'), 'b'); const r = save(p, { why: 'after crash', who: 't' });
  assert.ok(listReceipts(p.z).some(x => x.id === r.id));
});

test('I9: a damaged blob is repaired when the same content is saved again', () => {
  const z = tmp('z-'), h = putBlob(z, Buffer.from('hello'));
  truncateSync(join(z, 'store', h.slice(0, 2), h.slice(2)), 0);
  putBlob(z, Buffer.from('hello'));
  assert.equal(getBlob(z, h).toString(), 'hello');
});

test('I10: receipt ids never repeat even if the counter is lost', () => {
  const p = proj({ 'a.txt': 'a' });
  writeFileSync(join(p.y, 'a.txt'), 'b'); save(p, { why: 'two', who: 't' });
  unlinkSync(join(p.z, 'counter'));
  assert.equal(nextId(p.z), 'r-0003');
  writeFileSync(join(p.z, 'counter'), 'garbage');
  assert.match(nextId(p.z), /^r-000\d$/);
});

test('M4: the first receipt does not offer an undo it would refuse', () => {
  const p = proj({ 'a.txt': 'a' });
  assert.doesNotMatch(readFileSync(listReceipts(p.z)[0].file, 'utf8'), /undo: xyz undo r-0001/);
});
