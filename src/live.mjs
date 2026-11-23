// X, the live app: promote a checked snapshot of Y into X/versions/<id>, switch X/current in one step, roll back.
import { mkdirSync, existsSync, readlinkSync, symlinkSync, renameSync, readFileSync, appendFileSync, cpSync, rmSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { withLock } from './lock.mjs';
import { save, latestSnapshot } from './save.mjs';
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

export function promote(p, { who = 'agent' } = {}) {
  return withLock(p.z, () => {
    save(p, { kind: 'auto', who, why: 'before promote' });
    if (p.config.check) {
      const c = spawnSync('sh', ['-c', p.config.check], { cwd: p.y, encoding: 'utf8', maxBuffer: 64 << 20 });
      if (c.status !== 0) throw new Error(`check failed ("${p.config.check}", exit ${c.status}); nothing went live.\n${String(c.stdout + c.stderr).trim().split('\n').slice(-15).join('\n')}`);
    }
    const snap = latestSnapshot(p.z), version = snap.id, dir = join(p.x, 'versions', version);
    if (!existsSync(dir)) {
      const tmp = `${dir}.${process.pid}.tmp`; rmSync(tmp, { recursive: true, force: true });
      for (const [rel, f] of Object.entries(snap.files)) {
        const to = join(tmp, rel); mkdirSync(dirname(to), { recursive: true });
        if (f.link !== undefined) symlinkSync(f.link, to); else writeAtomic(to, getBlob(p.z, f.hash), f.mode ?? 0o644);
      }
      mkdirSync(tmp, { recursive: true });
      for (const d of p.config.deps ?? []) if (existsSync(join(p.y, d))) cpSync(join(p.y, d), join(tmp, d), { recursive: true, verbatimSymlinks: true });
      writeAtomic(join(tmp, '.xyz-version'), JSON.stringify({ version, at: Date.now(), from: p.y }) + '\n');
      renameSync(tmp, dir);
    }
    const before = current(p);
    const n = versionNumber(p, version), was = before ? ` (was v${versionNumber(p, before)})` : '';
    switchTo(p, version);
    const rs = restart(p);
    const r = receipt(p, who, 'promote', `Made v${n} live`, `Promoted Y to X as v${n}${was}; ${rs.text}`, version, before);
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

export function promoteCli({ p, who, out }) { const r = promote(p, { who }); out(r, `Live now: ${r.label}\n  ${r.why}\n  Go back with: xyz rollback`); if (r.restartFailed) { console.error('xyz: the restart failed; see the receipt above'); process.exitCode = 1; } }
export function rollbackCli({ p, who, out }) { const r = rollback(p, { who }); out(r, `Live now: ${r.label}\n  ${r.why}`); if (r.restartFailed) { console.error('xyz: the restart failed; see the receipt above'); process.exitCode = 1; } }
