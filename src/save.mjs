// Snapshots of Y and the receipt that comes with each one.
import { readFileSync, existsSync, renameSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeAtomic } from './atomic.mjs';
import { scan, diff } from './scan.mjs';
import { withLock } from './lock.mjs';
import { nextId, writeReceipt } from './receipts.mjs';
import { learn } from './map.mjs';

const TOUCHES = 'touches.jsonl';
/** Who last edited each file since `since` (from the edit hook's log in Z/touches.jsonl). */
export function lastWriters(z, since = 0) {
  const who = new Map();
  try { for (const l of readFileSync(join(z, TOUCHES), 'utf8').split('\n')) { if (!l) continue; try { const t = JSON.parse(l); if (t.at > since) who.set(t.rel, t.who); } catch {} } } catch {}
  return who;
}
export function recordTouch(z, rel, who) { appendFileSync(join(z, TOUCHES), JSON.stringify({ at: Date.now(), rel, who }) + '\n'); }

export function loadSnapshot(z, id) {
  if (!id) return { id: null, files: {} };
  return JSON.parse(readFileSync(join(z, 'snapshots', `${id}.json`), 'utf8'));
}

export function latestSnapshot(z) {
  const h = join(z, 'head');
  return existsSync(h) ? loadSnapshot(z, readFileSync(h, 'utf8').trim()) : null;
}

export function writeSnapshot(z, files, at = Date.now(), { head = true, note = null } = {}) {
  const id = `s-${at}-${createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 8)}`;
  writeAtomic(join(z, 'snapshots', `${id}.json`), JSON.stringify({ id, at, files, ...(note ? { note } : {}) }));
  if (head) writeAtomic(join(z, 'head'), id); // a lane's live version is not Y's state: it leaves Y's head alone
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
export function leavePending(p, { why, who, learned = null }) {
  appendFileSync(join(p.y, PENDING), JSON.stringify({ at: Date.now(), who, why, ...(learned ? { learned } : {}) }) + '\n');
}

/** Take the notes left in Y (claimed by rename so a note written meanwhile is never lost). */
function claimPending(p) {
  const f = join(p.y, PENDING); if (!existsSync(f)) return null;
  const claimed = join(p.y, `.xyz-pending.${process.pid}.${Date.now()}`);
  try { renameSync(f, claimed); } catch { return null; }
  const notes = readFileSync(claimed, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { notes, done: () => { try { unlinkSync(claimed); } catch {} }, giveBack: () => { try { appendFileSync(f, notes.map(n => JSON.stringify(n)).join('\n') + '\n'); unlinkSync(claimed); } catch {} } };
}

/** Snapshot Y with a receipt. Returns null when nothing changed (unless force, e.g. adopt/convert).
 *  only: keep just these paths (everything else stays as the last snapshot had it, still unsaved). */
export function save(p, { why = '', who = 'agent', kind = 'save', title = null, force = false, note = null, extra = {}, only = null } = {}) {
  return withLock(p.z, () => {
    const pending = kind === 'auto' ? claimPending(p) : null;
    if (pending) {
      for (const x of pending.notes) if (x.learned) { try { learn(p, x.learned, x.who || 'agent'); } catch {} }
      const saves = pending.notes.filter(x => x.why);
      if (saves.length) {
        const whos = [...new Set(saves.map(x => x.who || 'agent'))];
        try {
          const r = save(p, { why: saves.map(x => x.why).join('; '), who: whos.join(' + '), kind: 'save', force: true, note: 'Kept by the auto-saver from a note the agent left in Y (its sandbox could not write Z).' });
          pending.done(); return r;
        } catch (e) { pending.giveBack(); throw e; }
      }
      pending.done();
    }
    const c = changesNow(p);
    if (kind === 'auto' && !only && !force) {
      // one receipt per agent, by who last edited each file, so one agent's work can be undone alone
      const writers = lastWriters(p.z, c.last?.at ?? 0), groups = new Map();
      for (const rel of [...c.added, ...c.changed, ...c.removed]) { const w = writers.get(rel); if (w) groups.set(w, [...(groups.get(w) ?? []), rel]); }
      if (groups.size) {
        let last = null;
        for (const [w, rels] of groups) last = save(p, { kind: 'auto', who: w, only: rels, title: `Saved by itself: ${w}'s ${rels.length} file${rels.length === 1 ? '' : 's'}` }) ?? last;
        return save(p, { kind: 'auto', who, only: [...c.added, ...c.changed, ...c.removed].filter(r => !writers.has(r)) }) ?? last;
      }
    }
    let files = c.files, d = c;
    if (only) {
      const want = new Set(only); files = { ...(c.last?.files ?? {}) };
      for (const rel of want) { if (rel in c.files) files[rel] = c.files[rel]; else delete files[rel]; }
      d = diff(c.last?.files ?? {}, files);
    }
    const n = d.added.length + d.removed.length + d.changed.length;
    if (!n && !force) return null;
    const at = Date.now();
    const snapshot = writeSnapshot(p.z, files, at);
    return writeReceipt(p.z, {
      id: nextId(p.z), kind, who, at, title: title ?? titleFor(kind, why, n), why: why || null,
      snapshot, before: c.last?.id ?? null, added: d.added, removed: d.removed, changed: d.changed,
      unreadable: c.unreadable.length ? c.unreadable : undefined, note: note ?? undefined, ...extra,
    });
  });
}
