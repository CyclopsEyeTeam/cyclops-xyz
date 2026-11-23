// Snapshots of Y and the receipt that comes with each one.
import { readFileSync, existsSync, renameSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeAtomic } from './atomic.mjs';
import { scan, diff } from './scan.mjs';
import { withLock } from './lock.mjs';
import { nextId, writeReceipt } from './receipts.mjs';

export function loadSnapshot(z, id) {
  if (!id) return { id: null, files: {} };
  return JSON.parse(readFileSync(join(z, 'snapshots', `${id}.json`), 'utf8'));
}

export function latestSnapshot(z) {
  const h = join(z, 'head');
  return existsSync(h) ? loadSnapshot(z, readFileSync(h, 'utf8').trim()) : null;
}

export function writeSnapshot(z, files, at = Date.now()) {
  const id = `s-${at}-${createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 8)}`;
  writeAtomic(join(z, 'snapshots', `${id}.json`), JSON.stringify({ id, at, files }));
  writeAtomic(join(z, 'head'), id);
  return id;
}

/** What Y looks like now compared with the last snapshot (stores new content as a side effect). */
export function changesNow(p) {
  const last = latestSnapshot(p.z);
  const { files, unreadable } = scan(p.y, p.z, { skip: p.config?.skip ?? [], prev: last?.files ?? {} });
  return { last, files, unreadable, ...diff(last?.files ?? {}, files) };
}

const titleFor = (kind, why, n) => kind === 'auto' ? `Saved by itself: ${n} file${n === 1 ? '' : 's'}` :
  (String(why || '').split(/\.(?:\s|$)|\n/)[0].trim().slice(0, 70) || 'Saved');

const PENDING = '.xyz-pending.jsonl';

/** For agents whose sandbox can write Y but not Z: leave the save as a note in Y for the auto-saver. */
export function leavePending(p, { why, who }) {
  appendFileSync(join(p.y, PENDING), JSON.stringify({ at: Date.now(), who, why }) + '\n');
}

/** Take the notes left in Y (claimed by rename so a note written meanwhile is never lost). */
function claimPending(p) {
  const f = join(p.y, PENDING); if (!existsSync(f)) return null;
  const claimed = join(p.y, `.xyz-pending.${process.pid}.${Date.now()}`);
  try { renameSync(f, claimed); } catch { return null; }
  const notes = readFileSync(claimed, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { notes, done: () => { try { unlinkSync(claimed); } catch {} }, giveBack: () => { try { appendFileSync(f, notes.map(n => JSON.stringify(n)).join('\n') + '\n'); unlinkSync(claimed); } catch {} } };
}

/** Snapshot Y with a receipt. Returns null when nothing changed (unless force, e.g. adopt/convert). */
export function save(p, { why = '', who = 'agent', kind = 'save', title = null, force = false, note = null, extra = {} } = {}) {
  return withLock(p.z, () => {
    const pending = kind === 'auto' ? claimPending(p) : null;
    if (pending?.notes.length) {
      const whos = [...new Set(pending.notes.map(x => x.who || 'agent'))];
      try {
        const r = save(p, { why: pending.notes.map(x => x.why).filter(Boolean).join('; '), who: whos.join(' + '), kind: 'save', force: true, note: 'Kept by the auto-saver from a note the agent left in Y (its sandbox could not write Z).' });
        pending.done(); return r;
      } catch (e) { pending.giveBack(); throw e; }
    }
    pending?.done();
    const c = changesNow(p), n = c.added.length + c.removed.length + c.changed.length;
    if (!n && !force) return null;
    const at = Date.now();
    const snapshot = writeSnapshot(p.z, c.files, at);
    return writeReceipt(p.z, {
      id: nextId(p.z), kind, who, at, title: title ?? titleFor(kind, why, n), why: why || null,
      snapshot, before: c.last?.id ?? null, added: c.added, removed: c.removed, changed: c.changed,
      unreadable: c.unreadable.length ? c.unreadable : undefined, note: note ?? undefined, ...extra,
    });
  });
}
