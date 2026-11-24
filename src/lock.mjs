// Z/lock: one writer at a time per project. Re-entrant inside one process.
// A lock whose holder is gone (dead pid, or a pid reused by another program, or an empty file from a crash)
// is moved aside with a rename (only one process can win that rename), then taken fresh.
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, renameSync, statSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const held = new Map(); // zDir -> { depth, token }
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const startOf = pid => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]; } catch { return null; } };
const MY_START = startOf(process.pid);

function gone(holder) {
  if (!holder?.pid) return false;
  try { process.kill(holder.pid, 0); } catch (e) { if (e.code !== 'EPERM') return true; }
  return holder.start != null && startOf(holder.pid) !== holder.start; // same pid, different program
}

function acquire(z, waitMs) {
  const f = join(z, 'lock'), until = Date.now() + waitMs, token = randomBytes(8).toString('hex');
  for (;;) {
    try {
      const fd = openSync(f, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, start: MY_START, token, at: Date.now(), who: process.env.XYZ_LOCK_WHO || null, cmd: process.env.XYZ_LOCK_CMD || null })); fsyncSync(fd); closeSync(fd);
      return token;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let raw = null, age = 0;
      try { raw = readFileSync(f, 'utf8'); age = Date.now() - statSync(f).mtimeMs; } catch { continue; }
      let holder = null; try { holder = JSON.parse(raw); } catch {}
      if ((holder && gone(holder)) || (!holder && age > 5000)) {
        // Only one process clears a dead lock at a time, and only if the lock is still that same dead one
        // (otherwise a slow process could remove the fresh lock another one has just taken).
        const tk = `${f}.takeover`;
        try {
          closeSync(openSync(tk, 'wx', 0o600));
          try { if (readFileSync(f, 'utf8') === raw) unlinkSync(f); } catch {}
          finally { try { unlinkSync(tk); } catch {} }
        } catch (e2) {
          if (e2.code !== 'EEXIST') throw e2;
          try { if (Date.now() - statSync(tk).mtimeMs > 5000) unlinkSync(tk); } catch {}
          pause(10);
        }
        continue;
      }
      if (Date.now() > until) {
        const since = holder?.at ? `${Math.round((Date.now() - holder.at) / 1000)} s` : 'a moment';
        const what = holder ? `${holder.who ? `${holder.who} is` : 'another xyz is'} running "xyz ${holder.cmd ?? '…'}" (pid ${holder.pid}, for ${since})` : 'another xyz is working on this project';
        throw new Error(`${what}; waited ${Math.round(waitMs / 1000)} s. Try again, or add --wait (waits while it is still running) or --wait=45m`);
      }
      pause(25 + Math.floor(Math.random() * 50));
    }
  }
}

function release(z, token) {
  const f = join(z, 'lock');
  try { const h = JSON.parse(readFileSync(f, 'utf8')); if (h.token !== token) return; } catch { return; }
  try { const aside = `${f}.release.${process.pid}.${token}`; renameSync(f, aside); unlinkSync(aside); } catch {}
}

export function withLock(z, fn, { waitMs = Number(process.env.XYZ_LOCK_WAIT_MS) || 30000 } = {}) {
  let h = held.get(z);
  if (!h) { h = { depth: 0, token: acquire(z, waitMs) }; held.set(z, h); }
  h.depth++;
  const done = () => { if (--h.depth === 0) { held.delete(z); release(z, h.token); } };
  let out;
  try { out = fn(); } catch (e) { done(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(done);
  done(); return out;
}
