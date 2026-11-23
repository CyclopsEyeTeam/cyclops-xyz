import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmp, tree } from './helpers.mjs';
import { save } from '../src/save.mjs';
import { listReceipts, getReceipt } from '../src/receipts.mjs';
import { withLock } from '../src/lock.mjs';

const proj = (files = { 'a.txt': 'one', 'b.txt': 'bee' }) => {
  const home = tmp('p-'), y = join(home, 'Y'), z = join(home, 'Z'), x = join(home, 'X');
  mkdirSync(y); mkdirSync(z); mkdirSync(x); tree(y, files);
  return { name: 'Fixture', home, x, y, z, config: { skip: ['.git'] } };
};

test('the first save writes r-0001 with a readable receipt', () => {
  const p = proj();
  const r = save(p, { why: 'first look', who: 'claude' });
  assert.equal(r.id, 'r-0001');
  const md = readFileSync(r.file, 'utf8');
  assert.match(md, /why: first look/);
  assert.doesNotMatch(md, /undo: xyz undo r-0001/, 'the first receipt has nothing to undo to');
  assert.match(md, /who: claude/);
  assert.deepEqual(r.added, ['a.txt', 'b.txt']);
});

test('a later save lists only what changed', () => {
  const p = proj(); save(p, { why: 'one', who: 'claude' });
  writeFileSync(join(p.y, 'a.txt'), 'two');
  const r = save(p, { why: 'edited a', who: 'claude' });
  assert.deepEqual([r.added, r.removed, r.changed], [[], [], ['a.txt']]);
  assert.equal(getReceipt(p.z, r.id).why, 'edited a');
  assert.equal(listReceipts(p.z)[0].id, 'r-0002');
});

test('nothing changed: no receipt, nothing written', () => {
  const p = proj(); save(p, { why: 'one', who: 'claude' });
  assert.equal(save(p, { kind: 'auto', who: 'xyz-watch' }), null);
  assert.equal(save(p, { why: 'again', who: 'claude' }), null);
  assert.equal(listReceipts(p.z).length, 1);
});

test('two agents saving at the same moment both get their receipts, in order', async () => {
  const p = proj(); save(p, { why: 'one', who: 'claude' });
  const child = (file, who) => new Promise((res, rej) => {
    const code = `import('${new URL('../src/save.mjs', import.meta.url).href}').then(m => { require('fs').writeFileSync(${JSON.stringify(join(p.y, file))}, '${who}'); const r = m.save(${JSON.stringify(p)}, { why: '${who} edit', who: '${who}' }); console.log(r && r.id); })`;
    const c = spawn(process.execPath, ['-e', code]); let out = '';
    c.stdout.on('data', d => out += d); c.stderr.on('data', d => out += d);
    c.on('close', code => code === 0 ? res(out.trim()) : rej(new Error(out)));
  });
  await Promise.all([child('c1.txt', 'agentA'), child('c2.txt', 'agentB')]);
  const rs = listReceipts(p.z), all = rs.map(r => r.id).sort();
  assert.equal(new Set(all).size, all.length, 'no duplicate ids');
  assert.deepEqual(all, ['r-0001', 'r-0002', 'r-0003'].slice(0, all.length), `ids run on with no gaps: ${all}`);
  assert.deepEqual(rs.flatMap(r => r.added).filter(f => f.startsWith('c')).sort(), ['c1.txt', 'c2.txt'], 'both edits are in a receipt');
});

test('a lock left by a dead process is taken over', () => {
  const p = proj();
  writeFileSync(join(p.z, 'lock'), JSON.stringify({ pid: 999999, at: Date.now() }));
  assert.equal(withLock(p.z, () => 'got it', { waitMs: 2000 }), 'got it');
  assert.equal(existsSync(join(p.z, 'lock')), false);
});

test('a receipt title keeps file names with dots', () => {
  const p = proj(); save(p, { why: 'one', who: 't' });
  writeFileSync(join(p.y, 'a.txt'), 'x');
  assert.equal(save(p, { why: 'edit to app.mjs. Then more words', who: 't' }).title, 'edit to app.mjs');
});
