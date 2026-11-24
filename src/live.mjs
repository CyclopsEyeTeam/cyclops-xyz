// X, the live app: promote a checked snapshot of Y into X/versions/<id>, switch X/current in one step, roll back.
import { mkdirSync, existsSync, readlinkSync, symlinkSync, renameSync, readFileSync, appendFileSync, cpSync, rmSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { withLock } from './lock.mjs';
import { save, latestSnapshot, loadSnapshot } from './save.mjs';
import { getReceipt } from './receipts.mjs';
import { getBlob } from './store.mjs';
import { writeAtomic } from './atomic.mjs';
import { nextId, writeReceipt } from './receipts.mjs';

const current = p => { try { return basename(readlinkSync(join(p.x, 'current'))); } catch { return null; } };
/** Plain number of a version: v1 is the first one ever promoted. */
export const versionNumber = (p, version) => { const seen = [...new Set(history(p).filter(h => h.kind === 'promote').map(h => h.version))]; const i = seen.indexOf(version); return i < 0 ? seen.length + 1 : i + 1; };
const history = p => { try { return readFileSync(join(p.x, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

function switchTo(p, version) {
  const tmp = join(p.x, `current.${process.pid}.tmp`);
  try { rmSync(tmp, { force: true }); } catch {}
  symlinkSync(join('versions', version), tmp);
  renameSync(tmp, join(p.x, 'current'));
}

/** Restart the services that run from X. Never throws: the result goes into the receipt. */
function restart(p) {
  if (!p.config.servicesFromX || !p.config.services?.length) return { ok: true, text: 'no services restarted (they still run from Y)' };
  try { execFileSync('systemctl', ['--user', 'restart', ...p.config.services], { stdio: 'ignore', timeout: 120000 }); return { ok: true, text: `restarted ${p.config.services.join(', ')}` }; }
  catch (e) { return { ok: false, text: `RESTART FAILED for ${p.config.services.join(', ')} (${e.status != null ? `exit ${e.status}` : e.message}); X did switch` }; }
}

function receipt(p, who, kind, title, why, snapshot, before) {
  return writeReceipt(p.z, { id: nextId(p.z), kind, who, at: Date.now(), title, why, snapshot, before, added: [], removed: [], changed: [] });
}

/** saved: promote what is already kept (no sweep of Y, so other agents' unsaved work never ships),
 *  and run the check on that exact copy instead of on Y. from: a receipt id whose snapshot to promote.
 *  The project lock is held only to pick what to promote and to switch X — never during the check, which
 *  can take a long time — so other agents can keep saving and landing meanwhile. */
export function promote(p, { who = 'agent', saved = false, from = null } = {}) {
  const exact = saved || from;
  const snap = withLock(p.z, () => {
    if (!exact) save(p, { kind: 'auto', who, why: 'before promote' });
    let s = latestSnapshot(p.z);
    if (from) { const r = getReceipt(p.z, from); if (!r.snapshot) throw new Error(`${r.id} has no saved state to promote`); s = loadSnapshot(p.z, r.snapshot); }
    if (!s) throw new Error('nothing saved yet to promote');
    return s;
  });
  const version = snap.id, dir = join(p.x, 'versions', version);
  const fail = (c, where) => new Error(`check failed${where} ("${p.config.check}", exit ${c.status}); nothing went live.\n${String(c.stdout + c.stderr).trim().split('\n').slice(-15).join('\n')}`);
  if (p.config.check && !exact) {
    const c = spawnSync('sh', ['-c', p.config.check], { cwd: p.y, encoding: 'utf8', maxBuffer: 64 << 20 });
    if (c.status !== 0) throw fail(c, '');
  }
  // build the version outside the lock (snapshots and blobs never change); its own tmp folder per process
  let tmp = null;
  if (!existsSync(dir)) {
    tmp = `${dir}.${process.pid}.tmp`; rmSync(tmp, { recursive: true, force: true });
    for (const [rel, f] of Object.entries(snap.files)) {
      const to = join(tmp, rel); mkdirSync(dirname(to), { recursive: true });
      if (f.link !== undefined) symlinkSync(f.link, to); else writeAtomic(to, getBlob(p.z, f.hash), f.mode ?? 0o644);
    }
    mkdirSync(tmp, { recursive: true });
    for (const d of p.config.deps ?? []) if (existsSync(join(p.y, d))) cpSync(join(p.y, d), join(tmp, d), { recursive: true, verbatimSymlinks: true });
    writeAtomic(join(tmp, '.xyz-version'), JSON.stringify({ version, at: Date.now(), from: p.y }) + '\n');
    if (p.config.check && exact) {
      const c = spawnSync('sh', ['-c', p.config.check], { cwd: tmp, encoding: 'utf8', maxBuffer: 64 << 20 });
      if (c.status !== 0) { rmSync(tmp, { recursive: true, force: true }); throw fail(c, ' on the saved copy'); }
    }
  }
  return withLock(p.z, () => {
    if (tmp) { if (existsSync(dir)) rmSync(tmp, { recursive: true, force: true }); else renameSync(tmp, dir); }
    const before = current(p);
    const n = versionNumber(p, version), was = before ? ` (was v${versionNumber(p, before)})` : '';
    switchTo(p, version);
    const rs = restart(p);
    const r = receipt(p, who, 'promote', `Made v${n} live`, `Promoted ${from ? `${from}'s state` : exact ? 'what was kept' : 'Y'} to X as v${n}${was}; ${rs.text}`, version, before);
    appendFileSync(join(p.x, 'history.jsonl'), JSON.stringify({ at: r.at, kind: 'promote', version, before, receipt: r.id }) + '\n');
    return { ...r, label: `v${n}`, restartFailed: !rs.ok };
  });
}

/** Go back to what was live before the current version was promoted. */
export function rollback(p, { who = 'agent' } = {}) {
  return withLock(p.z, () => {
    const cur = current(p);
    const made = [...history(p)].reverse().find(h => h.kind === 'promote' && h.version === cur);
    const target = made?.before ?? null;
    if (!target) throw new Error(`nothing to roll back to; ${cur ? `v${versionNumber(p, cur)} was the first thing live here` : 'nothing has been promoted yet'}`);
    const tn = versionNumber(p, target), cn = versionNumber(p, cur);
    switchTo(p, target);
    const rs = restart(p);
    const r = receipt(p, who, 'rollback', `Went back to v${tn}`, `Rolled X back from v${cn} to v${tn}; ${rs.text}`, target, cur);
    appendFileSync(join(p.x, 'history.jsonl'), JSON.stringify({ at: r.at, kind: 'rollback', version: target, before: cur, receipt: r.id }) + '\n');
    return { ...r, label: `v${tn}`, restartFailed: !rs.ok };
  });
}

export function promoteCli({ p, who, out, rest = [], flags = {} }) { const r = promote(p, { who, saved: !!flags.saved, from: rest[0] ?? null }); out(r, `Live now: ${r.label}\n  ${r.why}\n  Go back with: xyz rollback`); if (r.restartFailed) { console.error('xyz: the restart failed; see the receipt above'); process.exitCode = 1; } }
export function rollbackCli({ p, who, out }) { const r = rollback(p, { who }); out(r, `Live now: ${r.label}\n  ${r.why}`); if (r.restartFailed) { console.error('xyz: the restart failed; see the receipt above'); process.exitCode = 1; } }
