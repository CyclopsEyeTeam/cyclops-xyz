// Sandboxed agents (e.g. Codex) can write Y but not Z: their save becomes a note in Y that the auto-saver keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, tree, xyz } from './helpers.mjs';

test('a save that cannot write Z leaves a note in Y, and the auto-saver turns it into a signed receipt', () => {
  const root = tmp('root-'), folder = tree(join(tmp('work-'), 'Boxed'), { 'a.txt': 'a' });
  xyz(root, ['adopt', folder]);
  const z = join(root, 'Boxed', 'Z');
  writeFileSync(join(folder, 'README.md'), 'hello');
  chmodSync(z, 0o555);
  const s = xyz(root, ['save', 'wrote the README', '--who', 'codex'], { cwd: folder });
  chmodSync(z, 0o755);
  assert.equal(s.code, 0, s.out);
  assert.match(s.out, /auto-saver/i);
  assert.ok(existsSync(join(folder, '.xyz-pending.jsonl')));
  xyz(root, ['watch']);
  const r = JSON.parse(xyz(root, ['receipts', '--json'], { cwd: folder }).out)[0];
  assert.equal(r.who, 'codex'); assert.equal(r.why, 'wrote the README'); assert.equal(r.kind, 'save');
  assert.deepEqual(r.added, ['README.md'], 'the note itself is never part of the project');
  assert.equal(existsSync(join(folder, '.xyz-pending.jsonl')), false);
});
