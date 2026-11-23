// Undo just that change: reverse one receipt's own edits, keep everything that came after it.
import { unlinkSync, symlinkSync, renameSync, mkdirSync, lstatSync, readdirSync, rmdirSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { getReceipt, listReceipts } from './receipts.mjs';
import { getBlob } from './store.mjs';
import { save, loadSnapshot, changesNow } from './save.mjs';
import { withLock } from './lock.mjs';
import { writeAtomic } from './atomic.mjs';

const same = (a, b) => (!a || !b) ? !a && !b : (a.link !== undefined || b.link !== undefined) ? a.link === b.link : a.hash === b.hash && (a.mode ?? 0) === (b.mode ?? 0);
const num = id => Number(String(id).slice(2));
const lst = p => { try { return lstatSync(p); } catch { return null; } };

/** Why this path can't be written safely inside Y, or null. Guards against links on the way and paths leaving Y. */
function unsafe(y, path) {
  const abs = resolve(y, path);
  if (!abs.startsWith(resolve(y) + sep)) return 'it would land outside the project';
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const st = lst(join(y, ...parts.slice(0, i)));
    if (!st) break;
    if (st.isSymbolicLink()) return `a folder on the way (${parts.slice(0, i).join('/')}) is now a link`;
    if (!st.isDirectory()) return `${parts.slice(0, i).join('/')} is a file, not a folder`;
  }
  return null;
}

/** A folder standing where a file goes back is fine only if everything in it is removed by this same undo. */
function folderGoesAway(y, dir, r, now, after) {
  const added = new Set(r.added); let ok = true;
  const walk = rel => { for (const e of readdirSync(join(y, rel), { withFileTypes: true })) { const k = `${rel}/${e.name}`; if (e.isDirectory()) walk(k); else if (!added.has(k) || !now[k] || !same(now[k], after[k])) ok = false; } };
  try { walk(dir); } catch { return false; }
  return ok;
}

export function planUndo(p, id) {
  const r = getReceipt(p.z, id);
  if (['promote', 'rollback'].includes(r.kind)) throw new Error(`${r.id} changed what is live, not Y; use: xyz rollback`);
  if (!r.before) throw new Error(`${r.id} is the first receipt of ${p.name}; undoing it would empty the folder, so it can't be undone`);
  const before = loadSnapshot(p.z, r.before).files, after = loadSnapshot(p.z, r.snapshot).files;
  const now = changesNow(p).files, later = listReceipts(p.z).filter(x => num(x.id) > num(r.id));
  const clear = [], blocked = [], done = [];
  for (const path of [...new Set([...r.changed, ...r.added, ...r.removed])].sort()) {
    const target = before[path] ?? null, cur = now[path] ?? null;
    const why = unsafe(p.y, path);
    if (why) { blocked.push({ path, by: 'unsafe', why }); continue; }
    // the scan says "not there" but something is on disk (now ignored, unreadable, or inside its own checkout)
    const onDisk = !cur && lst(join(p.y, path));
    if (onDisk && !(onDisk.isDirectory() && !onDisk.isSymbolicLink() && folderGoesAway(p.y, path, r, now, after))) {
      blocked.push({ path, by: 'untracked', why: onDisk.isDirectory() ? 'a folder with other files in it is in the way' : 'on disk but not tracked by XYZ any more' }); continue;
    }
    if (same(cur, target)) { done.push(path); continue; }
    if (same(cur, after[path] ?? null)) { clear.push({ path, target, action: !target ? 'remove' : !cur ? 'bring back' : 'restore' }); continue; }
    blocked.push({ path, by: later.find(x => [...x.changed, ...x.added, ...x.removed].includes(path)) ?? 'unsaved' });
  }
  return { receipt: r, clear, blocked, done };
}

const describe = b => b.by === 'unsaved' ? 'unsaved edits' : b.why ? b.why : `${b.by.id} by ${b.by.who} (${b.by.title})`;

function removeEmptyParents(y, path) {
  for (let d = dirname(path); d && d !== '.'; d = dirname(d)) {
    try { if (readdirSync(join(y, d)).length) break; rmdirSync(join(y, d)); } catch { break; }
  }
}

function put(p, { path, target }, data) {
  const abs = join(p.y, path);
  const here = lst(abs);
  if (here?.isDirectory() && !here.isSymbolicLink()) { if (readdirSync(abs).length) throw new Error(`${path} is a folder with files in it; not replacing it`); rmdirSync(abs); }
  mkdirSync(dirname(abs), { recursive: true });
  if (target.link !== undefined) { const t = `${abs}.xyz-${process.pid}.tmp`; try { symlinkSync(target.link, t); renameSync(t, abs); } catch (e) { try { unlinkSync(t); } catch {} throw e; } return; }
  writeAtomic(abs, data, target.mode ?? 0o644);
}

export function applyUndo(p, id, { skipChanged = false, who = 'agent' } = {}) {
  return withLock(p.z, () => {
    planUndo(p, id); // refuse early (first receipt, promote) before saving anything
    save(p, { kind: 'auto', who, why: `before undo ${id}` });
    const plan = planUndo(p, id);
    const hard = plan.blocked.filter(b => b.by === 'unsafe' || b.by === 'untracked');
    if ((plan.blocked.length && !skipChanged) || hard.length) {
      throw new Error(`can't undo ${plan.receipt.id} cleanly:\n` + plan.blocked.map(b => `  ${b.path} — ${describe(b)}`).join('\n') +
        `\nNothing was changed.${hard.length ? '' : ' Undo the later receipt first, or add --skip-changed to reverse only the other files.'}`);
    }
    if (!plan.clear.length) throw new Error(`nothing left to undo in ${plan.receipt.id}; it's already reversed`);
    // check every saved copy loads before touching anything
    const data = new Map(plan.clear.filter(s => s.target && s.target.link === undefined).map(s => [s.path, getBlob(p.z, s.target.hash)]));
    // removals first (deepest first), then restores (shallowest first)
    const removes = plan.clear.filter(s => !s.target).sort((a, b) => b.path.split('/').length - a.path.split('/').length);
    const restores = plan.clear.filter(s => s.target).sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    const applied = [];
    try {
      for (const s of removes) { try { unlinkSync(join(p.y, s.path)); } catch (e) { if (e.code !== 'ENOENT') throw e; } removeEmptyParents(p.y, s.path); applied.push(s.path); }
      for (const s of restores) { put(p, s, data.get(s.path)); applied.push(s.path); }
    } catch (e) {
      save(p, { kind: 'undo', who, title: `Half-undid ${plan.receipt.id}`, why: `Undo of ${plan.receipt.id} stopped partway: ${e.message}. Done: ${applied.join(', ') || 'nothing'}`, force: true });
      throw new Error(`undo of ${plan.receipt.id} stopped partway (${e.message}); what was done is in a receipt — see: xyz receipts`);
    }
    return save(p, {
      kind: 'undo', who, title: `Undid ${plan.receipt.id}: ${plan.receipt.title}`.slice(0, 90),
      why: `Undo ${plan.receipt.id} (${plan.receipt.title})${plan.blocked.length ? `; left alone because they changed again: ${plan.blocked.map(b => b.path).join(', ')}` : ''}`,
      force: true,
    });
  });
}

export async function undoCli({ p, rest, flags, who, out, fail }) {
  if (!rest[0]) fail('which receipt? xyz undo r-0042 (see them with: xyz receipts)');
  const plan = planUndo(p, rest[0]);
  const lines = [`Undo ${plan.receipt.id} — ${plan.receipt.title} (${plan.receipt.who})`,
    ...plan.clear.map(s => `  ${s.action.padEnd(10)} ${s.path}`),
    ...plan.blocked.map(b => `  blocked    ${b.path} — ${describe(b)}`),
    ...plan.done.map(d => `  already    ${d}`)];
  if (!flags.yes) {
    if (flags.json || !process.stdin.isTTY) fail(`${lines.join('\n')}\nAdd --yes to go ahead.`);
    console.log(lines.join('\n'));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question('Go ahead? (y/N) ')).trim().toLowerCase(); rl.close();
    if (a !== 'y' && a !== 'yes') return console.log('Left as it is.');
  }
  const r = applyUndo(p, rest[0], { skipChanged: !!flags['skip-changed'], who });
  out(r, `Done: ${r.id} — ${r.title}\n  (changed your mind? xyz undo ${r.id})`);
}
