// Lanes: one agent, one copy of Y. `xyz lane "why"` makes L1, L2, … under the project home; the agent works
// there; `xyz land` merges its changes into Y in the order lanes land (each later lane is merged on top of
// what landed before it) and keeps one receipt signed by that agent with only its files. Clashing lines are
// never forced: they go back into the lane, marked, for the agent to fix and land again.
import { suiteLines } from './suite.mjs';
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, symlinkSync, unlinkSync, rmSync, rmdirSync, writeFileSync, mkdtempSync, readlinkSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { writeAtomic } from './atomic.mjs';
import { scan, diff } from './scan.mjs';
import { putBlob, getBlob } from './store.mjs';
import { withLock } from './lock.mjs';
import * as SAVE from './save.mjs';
const { latestSnapshot, writeSnapshot } = { latestSnapshot: (...a) => SAVE.latestSnapshot(...a), writeSnapshot: (...a) => SAVE.writeSnapshot(...a) };
import { nextId, writeReceipt } from './receipts.mjs';
import { openProject } from './project.mjs';

const LINKED = ['node_modules', '.venv', 'venv'];
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'lane';
const lanesZ = p => join(p.z, 'lanes');
const metaFile = (p, id) => join(lanesZ(p), id, 'lane.json');
const readJson = f => JSON.parse(readFileSync(f, 'utf8'));
const eq = (a, b) => !a || !b ? !a && !b : (a.link !== undefined || b.link !== undefined) ? a.link === b.link : a.hash === b.hash && (a.mode ?? 0) === (b.mode ?? 0);
const skipFor = p => [...(p.config.skip ?? []), '.xyz-lane', ...(p.config.deps ?? []), ...LINKED];

/** Which lane (if any) a folder is inside: { p, lane } or null. */
export function laneHere(cwd = process.cwd()) {
  for (let d = resolve(cwd); ; d = dirname(d)) {
    const f = join(d, '.xyz-lane');
    if (existsSync(f)) { try { const { home, id } = readJson(f); const p = openProject(home); return { p, lane: getLane(p, id) }; } catch { return null; } }
    if (existsSync(join(d, '.xyz')) || d === dirname(d)) return null;
  }
}

export function getLane(p, id) {
  id = /^\d+$/.test(id) ? `L${id}` : String(id).toUpperCase();
  if (!existsSync(metaFile(p, id))) throw new Error(`no lane ${id} here; see them with: xyz lanes`);
  return readJson(metaFile(p, id));
}

export function listLanes(p, { all = false } = {}) {
  if (!existsSync(lanesZ(p))) return [];
  return readdirSync(lanesZ(p)).filter(n => /^L\d+$/.test(n) && existsSync(metaFile(p, n))).map(n => readJson(metaFile(p, n)))
    .filter(l => all || l.status === 'open').sort((a, b) => a.n - b.n);
}

const putMeta = (p, l) => writeAtomic(metaFile(p, l.id), JSON.stringify(l, null, 2) + '\n');
const filesOf = (p, l, name) => readJson(join(lanesZ(p), l.id, `${name}.json`));
const putFiles = (p, l, name, files) => writeAtomic(join(lanesZ(p), l.id, `${name}.json`), JSON.stringify(files));

function writeEntry(root, rel, f, z) {
  const to = join(root, rel); mkdirSync(dirname(to), { recursive: true });
  try { if (lstatSync(to).isSymbolicLink()) unlinkSync(to); } catch {}
  if (f.link !== undefined) { rmSync(to, { force: true }); symlinkSync(f.link, to); }
  else writeAtomic(to, getBlob(z, f.hash), f.mode ?? 0o644);
}

function removeEntry(root, rel) {
  rmSync(join(root, rel), { force: true });
  // tidy folders the removal left empty, up to (never including) the root; rmdir only ever removes an empty folder
  for (let d = dirname(join(root, rel)); d.startsWith(root + '/'); d = dirname(d)) { try { if (readdirSync(d).length) break; rmdirSync(d); } catch { break; } }
}

/** Start a lane: a copy of Y as it is right now, numbered in order. */
export function startLane(p, { why, who }) {
  return withLock(p.z, () => {
    mkdirSync(lanesZ(p), { recursive: true });
    const cf = join(lanesZ(p), 'counter');
    let n = 0; try { n = Number(readFileSync(cf, 'utf8')) || 0; } catch {}
    n = Math.max(n, ...listLanes(p, { all: true }).map(l => l.n), 0) + 1;
    writeAtomic(cf, String(n));
    const id = `L${n}`, path = join(p.home, 'lanes', `${id}-${slug(why)}`);
    const { files } = scan(p.y, p.z, { skip: skipFor(p), prev: latestSnapshot(p.z)?.files ?? {} });
    const lane = { id, n, who, why, at: Date.now(), path, status: 'open', home: p.home };
    putFiles(p, lane, 'base', files); putMeta(p, lane);
    mkdirSync(path, { recursive: true });
    for (const [rel, f] of Object.entries(files)) writeEntry(path, rel, f, p.z);
    for (const d of new Set([...(p.config.deps ?? []), ...LINKED])) if (existsSync(join(p.y, d)) && !existsSync(join(path, d))) symlinkSync(join(p.y, d), join(path, d));
    writeAtomic(join(path, '.xyz'), p.home + '\n');
    writeAtomic(join(path, '.xyz-lane'), JSON.stringify({ home: p.home, id }) + '\n');
    return { ...lane, files: Object.keys(files).length };
  });
}

const laneNow = (p, l) => scan(l.path, p.z, { skip: skipFor(p), prev: (() => { try { return filesOf(p, l, 'checkpoint'); } catch { return filesOf(p, l, 'base'); } })() }).files;
const yNow = (p, head) => scan(p.y, p.z, { skip: skipFor(p), prev: head?.files ?? {} }).files; // same rules as the lane sees
const laneAlive = l => existsSync(join(l.path, '.xyz-lane'));
const SIDE = l => `.Y-${l.id}`; // Y's version of a file that clashed and can't be merged line by line

/** Keep the lane's work in Z (the auto-saver does this for every open lane). Returns the changed count. */
export function checkpoint(p, l, note = null) {
  return withLock(p.z, () => {
    const cur = getLane(p, l.id);
    if (cur.status !== 'open' || !laneAlive(cur)) return null;
    const files = laneNow(p, cur), d = diff(filesOf(p, cur, 'base'), files);
    putFiles(p, cur, 'checkpoint', files);
    putMeta(p, { ...cur, checkpointAt: Date.now(), ...(note ? { notes: [...(cur.notes ?? []), { at: Date.now(), why: note }] } : {}) });
    return d.added.length + d.removed.length + d.changed.length;
  });
}

const isText = buf => !buf.subarray(0, 8000).includes(0);
const MARKERS = /^(<{7} |>{7} )/m;

/** Three-way merge of one text file with git merge-file. Returns { buf, clean } or null if it can't merge. */
function merge3(z, base, mine, theirs, labels) {
  const ram = process.env.XYZ_RAM || (existsSync('/dev/shm') ? '/dev/shm' : tmpdir()); mkdirSync(ram, { recursive: true });
  const t = mkdtempSync(join(ram, 'xyz-merge-'));
  try {
    const f = (n, e) => { const p = join(t, n); writeFileSync(p, getBlob(z, e.hash)); return p; };
    const a = f('theirs', theirs), o = f('base', base), b = f('mine', mine);
    const r = spawnSync('git', ['merge-file', '-p', '-L', labels[0], '-L', 'where both started', '-L', labels[1], a, o, b], { maxBuffer: 256 << 20 });
    if (r.error || r.status === null || r.status < 0 || r.status > 127) return null; // an error, not a clash
    if (r.status > 0 && !MARKERS.test(r.stdout.toString('utf8'))) return null;
    return { buf: r.stdout, clean: r.status === 0 };
  } finally { rmSync(t, { recursive: true, force: true }); }
}

/** A folder on the way to rel (inside root) that is a link: writing there could land outside the project. */
function linkOnTheWay(root, rel) {
  const parts = rel.split('/');
  if (parts.includes('..')) return rel;
  for (let i = 1; i < parts.length; i++) { try { if (lstatSync(join(root, ...parts.slice(0, i))).isSymbolicLink()) return parts.slice(0, i).join('/'); } catch { break; } }
  return null;
}

/** What still needs fixing from the last clash: files with markers left, and Y-version side files not yet decided. */
function unresolved(l) {
  const left = [];
  for (const c of l.clashes ?? []) {
    const rel = typeof c === 'string' ? c : c.rel, kind = typeof c === 'string' ? 'text' : c.kind;
    if (kind === 'text') { try { if (MARKERS.test(readFileSync(join(l.path, rel), 'utf8'))) left.push(`${rel} still has <<<<<<< / >>>>>>> markers`); } catch {} }
    else if (existsSync(join(l.path, rel + SIDE(l))) || lstatOk(join(l.path, rel + SIDE(l)))) left.push(`${rel}: decide between your version and Y's (${rel}${SIDE(l)}), then delete ${rel}${SIDE(l)}`);
  }
  return left;
}
const lstatOk = f => { try { lstatSync(f); return true; } catch { return false; } };

/** Make the lane folder match `target` where the lane didn't change things itself (`keepMine`: paths to leave alone). */
function syncLane(p, l, target, mine, keepMine) {
  for (const rel of Object.keys(mine)) if (!(rel in target) && !keepMine.has(rel)) removeEntry(l.path, rel);
  for (const [rel, f] of Object.entries(target)) if (!keepMine.has(rel) && !eq(mine[rel], f)) writeEntry(l.path, rel, f, p.z);
}

/** What X would be with only this lane's work added: what is live now (or Y where the lane started, if nothing is
 *  live yet) plus the lane's own changes, merged line by line where live has moved on since the lane started.
 *  Nothing is written to Y or the lane. Throws, naming the files, when it can't be made cleanly. */
export function laneOnLive(p, l, live) {
  l = getLane(p, l.id);
  if (l.status !== 'open') throw new Error(`lane ${l.id} is ${l.status}${l.receipt ? ` (${l.receipt})` : ''}; promote Y instead`);
  if (!laneAlive(l)) throw new Error(`lane ${l.id}'s folder is missing (${l.path}); nothing went live`);
  const left = unresolved(l);
  if (left.length) throw new Error(`lane ${l.id} still has clashes to settle first:\n  ${left.join('\n  ')}`);
  const base = filesOf(p, l, 'base'), mine = laneNow(p, l);
  if (!Object.keys(mine).length && Object.keys(base).length) throw new Error(`lane ${l.id} looks empty; refusing to make live a lane that would remove everything`);
  const d = diff(base, mine), touched = [...d.added, ...d.changed, ...d.removed];
  if (!touched.length) throw new Error(`lane ${l.id} has no changes yet; nothing to make live`);
  const from = live ?? base, files = { ...from }, clashes = [];
  for (const rel of touched) {
    const b = base[rel], m = mine[rel], t = from[rel];
    if (eq(t, m)) continue;
    if (eq(t, b)) { if (m) files[rel] = m; else delete files[rel]; continue; }
    if (b?.hash && m?.hash && t?.hash && [b, m, t].every(e => isText(getBlob(p.z, e.hash)))) {
      const r = merge3(p.z, b, m, t, ['live', `${l.id} (${l.who})`]);
      if (r?.clean) { files[rel] = { hash: putBlob(p.z, r.buf), mode: m.mode }; continue; }
    }
    clashes.push(rel);
  }
  if (clashes.length) throw new Error(`nothing went live: ${l.id} changes ${clashes.length === 1 ? 'a file' : `${clashes.length} files`} that also changed in what's live since the lane started (${clashes.slice(0, 5).join(', ')}${clashes.length > 5 ? ', …' : ''}). Land it into Y (xyz land), then promote Y.`);
  return { files, touched, lane: l };
}

/** Note on the lane that its work is live (so a promote of Y, which doesn't have it yet, can warn). */
export function markLaneLive(p, id, live) {
  const l = getLane(p, id);
  putMeta(p, { ...l, live: [...(l.live ?? []), live] });
}

/** Open lanes whose work is live in X but not yet landed in Y. */
export const liveNotLanded = p => listLanes(p).filter(l => l.live?.length);

/** Land a lane into Y. Lanes land one at a time (Z lock), in the order they ask. */
export function land(p, l, { why = '', who = l.who, keep = false } = {}) {
  return withLock(p.z, () => {
    l = getLane(p, l.id);
    if (l.status !== 'open') throw new Error(`lane ${l.id} is ${l.status}`);
    if (!laneAlive(l)) throw new Error(`lane ${l.id}'s folder is missing (${l.path}); nothing landed. Its last state is in Z/lanes/${l.id}`);
    const left = unresolved(l);
    if (left.length) return { landed: [], clashes: [], unresolved: left };
    const base = filesOf(p, l, 'base'), mine = laneNow(p, l);
    if (!Object.keys(mine).length && Object.keys(base).length) throw new Error(`lane ${l.id} looks empty; refusing to land a lane that would remove everything`);
    let head = latestSnapshot(p.z), theirs = yNow(p, head);
    const d = diff(base, mine), touched = [...d.added, ...d.changed, ...d.removed];
    if (!touched.length) return { landed: [], clashes: [], nothing: true };
    // files this lane touches that someone has unsaved edits to in Y: keep those edits under their own receipt first,
    // so this lane's receipt (and its undo) holds only this lane's change
    const dirty = touched.filter(rel => !eq(theirs[rel], head?.files?.[rel]) && !eq(theirs[rel], base[rel]));
    if (dirty.length) {
      const { save, lastWriters } = SAVE;
      const w = lastWriters(p.z, head?.at ?? 0);
      const whos = [...new Set(dirty.map(r => w.get(r) ?? 'someone in Y'))].join(' + ');
      save(p, { kind: 'auto', who: whos, only: dirty, title: `Kept before ${l.id} landed: ${dirty.length} unsaved file${dirty.length === 1 ? '' : 's'} in Y`, why: `unsaved work in files ${l.id} also changed` });
      head = latestSnapshot(p.z);
    }
    const plan = [], clashes = [];
    for (const rel of touched) {
      const b = base[rel], m = mine[rel], t = theirs[rel];
      if (eq(t, m)) continue;                                  // Y already has it
      if (eq(t, b)) { plan.push([rel, m]); continue; }         // only this lane changed it
      if (b?.hash && m?.hash && t?.hash) {
        const bufs = [b, m, t].map(e => getBlob(p.z, e.hash));
        if (bufs.every(isText)) {
          const r = merge3(p.z, b, m, t, [`Y (landed before ${l.id})`, `${l.id} (${l.who})`]);
          if (r?.clean) { plan.push([rel, { hash: putBlob(p.z, r.buf), mode: m.mode }]); continue; }
          if (r) { clashes.push({ rel, kind: 'text', marked: r.buf }); continue; }
        }
      }
      clashes.push({ rel, kind: 'side', theirs: t ?? null, why: !m ? 'removed in your lane, changed in Y' : !t ? 'changed in your lane, removed in Y' : !b ? 'added in both your lane and Y, differently' : 'changed on both sides and can\'t be merged line by line' });
    }
    const unsafeRel = plan.map(([rel]) => [rel, linkOnTheWay(p.y, rel)]).find(([, w]) => w);
    if (unsafeRel) throw new Error(`nothing landed: in Y, ${unsafeRel[1]} is a link, so writing ${unsafeRel[0]} could land outside the project`);
    if (clashes.length) {
      // nothing lands; the lane moves onto Y as it is now, keeping its own changes, with every clash left to decide
      const keepMine = new Set(touched);
      syncLane(p, l, theirs, mine, keepMine);
      for (const [rel, f] of plan) if (f?.hash && f.hash !== mine[rel]?.hash) writeEntry(l.path, rel, f, p.z); // clean merges
      for (const c of clashes) {
        if (c.kind === 'text') writeAtomic(join(l.path, c.rel), c.marked, mine[c.rel]?.mode ?? 0o644);
        else if (c.theirs) writeEntry(l.path, c.rel + SIDE(l), c.theirs, p.z);
        else writeAtomic(join(l.path, c.rel + SIDE(l)), `Y removed ${c.rel} after ${l.id} started.\nKeep your ${c.rel} to bring it back, or delete it to agree; then delete this file.\n`);
      }
      putFiles(p, l, 'base', theirs);
      putMeta(p, { ...l, rebasedAt: Date.now(), clashes: clashes.map(c => ({ rel: c.rel, kind: c.kind })) });
      return { landed: [], clashes: clashes.map(c => ({ rel: c.rel, kind: c.kind, why: c.why ?? null, side: c.kind === 'side' ? c.rel + SIDE(l) : null })) };
    }
    // every blob must load before Y is touched
    for (const [, f] of plan) if (f?.hash) getBlob(p.z, f.hash);
    const removals = plan.filter(([, f]) => !f).sort((a, b) => b[0].split('/').length - a[0].split('/').length);
    const writes = plan.filter(([, f]) => f).sort((a, b) => a[0].split('/').length - b[0].split('/').length);
    const files = { ...(head?.files ?? {}) }, added = [], changed = [], removed = [];
    const record = () => {
      const at = Date.now(), snapshot = writeSnapshot(p.z, files, at), reason = why || l.why;
      return { at, snapshot, reason };
    };
    try {
      for (const [rel] of removals) { removeEntry(p.y, rel); delete files[rel]; removed.push(rel); }
      for (const [rel, f] of writes) {
        writeEntry(p.y, rel, f, p.z);
        const st = lstatSync(join(p.y, rel));
        (head?.files?.[rel] ? changed : added).push(rel);
        files[rel] = f.link !== undefined ? { link: f.link, mode: 0o777, size: 0, mtimeMs: st.mtimeMs } : { hash: f.hash, size: st.size, mode: st.mode & 0o7777, mtimeMs: st.mtimeMs };
      }
    } catch (e) {
      if (added.length + changed.length + removed.length) {
        const { at, snapshot } = record();
        const r = writeReceipt(p.z, { id: nextId(p.z), kind: 'land', who, at, title: `${l.id} half-landed (stopped: ${e.code ?? 'error'})`, why: why || l.why, snapshot, before: head?.id ?? null, added, removed, changed, lane: l.id,
          note: `Landing stopped part-way: ${e.message}. These files did land; the rest did not. Undo this receipt to go back, or fix the cause and land again.` });
        throw new Error(`landing stopped part-way (${e.message}). ${added.length + changed.length + removed.length} files landed and are in receipt ${r.id} (undo with: xyz undo ${r.id}); the lane is still open`);
      }
      throw new Error(`nothing landed: ${e.message}`);
    }
    const { at, snapshot, reason } = record();
    const r = writeReceipt(p.z, { id: nextId(p.z), kind: 'land', who, at, title: `${l.id} landed: ${String(reason).split(/\.(?:\s|$)|\n/)[0].slice(0, 60)}`, why: reason,
      snapshot, before: head?.id ?? null, added, removed, changed, lane: l.id, note: `Lane ${l.id} (${l.who}) started ${new Date(l.at).toISOString().slice(0, 16).replace('T', ' ')} — "${l.why}". Only this lane's files are in this receipt.` });
    if (keep) {
      // the lane carries on from Y as it is now: everything it had is in Y, so it can simply become Y again
      const now = yNow(p, latestSnapshot(p.z));
      syncLane(p, l, now, laneNow(p, l), new Set());
      putFiles(p, l, 'base', now); putFiles(p, l, 'checkpoint', laneNow(p, l));
      putMeta(p, { ...l, landedAt: Date.now(), clashes: [], receipts: [...(l.receipts ?? []), r.id] });
    }
    const closed = keep ? null : closeLane(p, l, 'landed', r.id);
    return { landed: plan.map(([rel]) => rel), clashes: [], receipt: r, kept: keep, folderLeft: !!closed?.folderLeft };
  });
}

/** Is any process (a shell, an agent, this command) standing inside this folder? */
export function inUse(dir) {
  let ids = []; try { ids = readdirSync('/proc').filter(n => /^\d+$/.test(n)); } catch { return false; }
  for (const id of ids) { try { const c = readlinkSync(`/proc/${id}/cwd`); if (c === dir || c.startsWith(dir + '/')) return true; } catch {} }
  return false;
}

/** Close a lane: its last state stays in Z (checkpoint) and its folder goes — unless someone is standing in it,
 *  then the folder is left (marked closed) for the auto-saver to tidy once nobody is. Never removes the folder
 *  if its state can't be kept. */
export function closeLane(p, l, status = 'dropped', receipt = null) {
  return withLock(p.z, () => {
    const cur = getLane(p, l.id);
    if (cur.status !== 'open') throw new Error(`lane ${cur.id} is already ${cur.status}`);
    if (laneAlive(cur)) putFiles(p, cur, 'checkpoint', laneNow(p, cur)); // throws (and keeps the folder) if it can't be read
    const leave = laneAlive(cur) && inUse(cur.path);
    putMeta(p, { ...cur, status, closedAt: Date.now(), receipt, folderLeft: leave });
    if (laneAlive(cur) && !leave) rmSync(cur.path, { recursive: true, force: true });
    return { folderLeft: leave };
  });
}

/** Remove folders of closed lanes that were left because someone stood in them — once nobody does, and only
 *  if nothing in them changed after the lane closed (otherwise they stay, flagged). */
export function tidyLanes(p) {
  return withLock(p.z, () => listLanes(p, { all: true }).filter(l => l.status !== 'open' && l.folderLeft).map(l => {
    if (!laneAlive(l)) { putMeta(p, { ...l, folderLeft: false }); return { id: l.id, removed: false }; }
    if (inUse(l.path)) return { id: l.id, removed: false, inUse: true };
    const d = diff(filesOf(p, l, 'checkpoint'), laneNow(p, l));
    if (d.added.length + d.changed.length + d.removed.length) {
      if (!l.changedAfterClose) putMeta(p, { ...l, changedAfterClose: true });
      return { id: l.id, removed: false, changedAfterClose: true };
    }
    rmSync(l.path, { recursive: true, force: true }); putMeta(p, { ...l, folderLeft: false });
    return { id: l.id, removed: true };
  }));
}

/** One line per open lane, for the project view and the arrival brief. */
export function laneLines(p) {
  return listLanes(p).map(l => {
    let n = '?'; try { n = diff(filesOf(p, l, 'base'), laneNow(p, l)); n = n.added.length + n.changed.length + n.removed.length; } catch {}
    const age = Math.round((Date.now() - l.at) / 60000);
    return `${l.id}  ${l.who}  "${l.why}"  · ${n} file${n === 1 ? '' : 's'} changed · started ${age < 90 ? `${age} min` : `${Math.round(age / 60)} h`} ago${l.clashes?.length ? ` · ⚠ ${l.clashes.length} clash${l.clashes.length === 1 ? '' : 'es'} to fix` : ''}${l.live?.length ? ` · live (${l.live.at(-1).receipt}), not landed in Y yet` : ''}\n      ${l.path}`;
  });
}

export function laneCli({ cmd, rest, flags, who, out, fail, here }) {
  const inLane = laneHere();
  const closedNote = L => `lane ${L.lane.id} is already ${L.lane.status}${L.lane.receipt ? ` (${L.lane.receipt})` : ''}; this folder was only left because a shell was in it. Work in Y: cd ${L.p.y}  — or start a new lane`;
  switch (cmd) {
    case 'lane': {
      if (inLane && inLane.lane.status === 'open') fail(`you're already in lane ${inLane.lane.id}; land it first (xyz land) or work in it`);
      const why = rest.join(' ').trim(); if (!why) fail('say what the lane is for: xyz lane "team sharing"');
      const p = here(null), l = startLane(p, { why, who });
      return out(l, `Lane ${l.id} is yours: ${l.files} files, copied from Y as it is right now.\n  Work here: ${l.path}\n  Keep it safe as you go: xyz save "why"  (the auto-saver also keeps it)\n  When done:  xyz land   (merges into Y in order; clashes come back to you marked)`);
    }
    case 'lanes': {
      const p = inLane?.p ?? here(rest[0] ?? null), ls = listLanes(p, { all: !!flags.all });
      let suite = []; try { suite = suiteLines(p); } catch {}
      const text = ls.length ? (flags.all ? ls.map(l => `${l.id}  ${l.status.padEnd(7)} ${l.who}  "${l.why}"${l.receipt ? `  → ${l.receipt}` : ''}`).join('\n') : laneLines(p).join('\n')) : 'No open lanes. Start one with: xyz lane "what for"';
      return out(ls, suite.length ? `${text}\n\n${suite.join('\n')}` : text);
    }
    case 'land': {
      if (!inLane) fail('land works inside a lane (cd into it); see lanes with: xyz lanes');
      const { p, lane } = inLane;
      if (lane.status !== 'open') fail(closedNote(inLane));
      const r = land(p, lane, { why: rest.join(' ').trim(), who: flags.who || process.env.XYZ_WHO || lane.who, keep: !!flags.keep });
      if (r.nothing) return out(r, `Nothing to land: lane ${lane.id} has no changes.`);
      if (r.unresolved) { out(r, `Nothing landed: the last clash isn't settled yet.\n${r.unresolved.map(x => `  ${x}`).join('\n')}\nThen run xyz land again.`); process.exitCode = 1; return; }
      if (r.clashes.length) return out({ ...r, clashes: r.clashes.map(c => ({ file: c.rel, why: c.why ?? 'same lines changed on both sides' })) },
        `Nothing landed yet: ${r.clashes.length} file${r.clashes.length === 1 ? ' clashes' : 's clash'} with work that landed in Y first.\nYour lane now sits on top of Y as it is. To settle:\n${r.clashes.map(c => c.kind === 'text' ? `  ${c.rel} — same lines changed on both sides: fix the <<<<<<< / >>>>>>> parts` : `  ${c.rel} — ${c.why}: Y's side is in ${c.side}; keep what you want in ${c.rel}, then delete ${c.side}`).join('\n')}\nThen run xyz land again.`);
      return out(r, `${lane.id} landed in Y: ${r.landed.length} file${r.landed.length === 1 ? '' : 's'}${r.receipt ? ` · receipt ${r.receipt.id}` : ' (Y already had them)'}.\n${r.kept ? '  The lane stays open on top of Y.' : r.folderLeft ? `  The lane is closed (its last state is kept in Z). Your shell is standing in it, so the folder stays until you leave;\n  the auto-saver tidies it away after. Carry on in Y: cd ${p.y}` : `  The lane is closed (its last state is kept in Z). Carry on in Y (${p.y}), or start a new lane.`}${r.receipt ? `\n  Undo with: xyz undo ${r.receipt.id}` : ''}`);
    }
    case 'drop': {
      if (!inLane && !rest[0]) fail('drop works inside a lane, or name it: xyz drop L2 --yes');
      const p = inLane?.p ?? here(null);
      const l = rest[0] ? getLane(p, rest[0]) : inLane.lane;
      if (l.status !== 'open') fail(inLane && !rest[0] ? closedNote(inLane) : `lane ${l.id} is already ${l.status}`);
      if (!flags.yes) fail(`this closes lane ${l.id} without landing it (its last state stays in Z). Add --yes to do it.`);
      const c = closeLane(p, l, 'dropped');
      return out({ dropped: l.id, folderLeft: c.folderLeft }, `Lane ${l.id} closed without landing. Its last state is kept in Z/lanes/${l.id}.${c.folderLeft ? `\n  Someone is standing in its folder, so it stays until they leave (the auto-saver tidies it). Y: ${p.y}` : ''}`);
    }
  }
}
