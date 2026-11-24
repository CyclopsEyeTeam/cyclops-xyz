// One full check at a time per project: promote checks and whole-suite `xyz test` runs take turns, in the order they
// asked. Each waiter is a small file in Z/queue/ naming its process; a waiter whose process has gone is cleared, so a
// crash never blocks the line. A command already holding the turn (XYZ_IN_TURN) — such as the `xyz test` a promote's
// check runs — goes straight through.
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { gone, startOf } from './lock.mjs';

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ago = at => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'just now' : `${m} min ago`; };

/** Wait for this project's turn; returns a function that gives the turn back. `say` hears who we are waiting for. */
export function takeTurn(p, { label, who = null, say = m => console.error(m), pollMs = 2000 } = {}) {
  if (process.env.XYZ_IN_TURN === p.home) return () => {};
  const dir = join(p.z, 'queue');
  mkdirSync(dir, { recursive: true });
  const at = Date.now(), name = `${String(at).padStart(15, '0')}-${process.pid}.json`, mine = join(dir, name);
  writeAtomic(mine, JSON.stringify({ pid: process.pid, start: startOf(process.pid), at, who, label }) + '\n');
  const release = () => { try { unlinkSync(mine); } catch {} if (process.env.XYZ_IN_TURN === p.home) delete process.env.XYZ_IN_TURN; };
  const onExit = () => release();
  process.once('exit', onExit);
  let told = null;
  for (;;) {
    const line = readdirSync(dir).filter(n => n.endsWith('.json')).sort().map(n => {
      try { return { n, ...JSON.parse(readFileSync(join(dir, n), 'utf8')) }; } catch { return null; }
    }).filter(w => {
      if (!w) return false;
      if (w.n !== name && gone(w)) { try { unlinkSync(join(dir, w.n)); } catch {} return false; }
      return true;
    });
    const i = line.findIndex(w => w.n === name);
    if (i <= 0) break;
    const head = line[0], key = `${head.n}:${i}`;
    if (told !== key) {
      say(`xyz: waiting for my turn (${i} ahead): ${head.who ?? 'someone'}'s ${head.label ?? 'check'} started ${ago(head.at)}. One full check runs at a time; the test buffer makes the next one quick.`);
      told = key;
    }
    pause(pollMs);
  }
  if (told) say('xyz: my turn now.');
  process.env.XYZ_IN_TURN = p.home;
  return () => { process.removeListener('exit', onExit); release(); };
}

/** Who holds the turn and who is waiting, for status lines. */
export function queueNow(p) {
  try {
    return readdirSync(join(p.z, 'queue')).filter(n => n.endsWith('.json')).sort()
      .map(n => { try { return JSON.parse(readFileSync(join(p.z, 'queue', n), 'utf8')); } catch { return null; } })
      .filter(w => w && !gone(w));
  } catch { return []; }
}
